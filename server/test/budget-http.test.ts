import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 人类世代与回应预算（#16）的进程级 HTTP seam：每条测试用临时数据目录、
 * 临时端口与注入的脚本化 provider，断言只读 HTTP 响应、库文件与 sqlite3 读数。
 *
 * 跳的语义（D1.13）：一条 Agent 消息投递至少一个唤醒 = 1 跳；唤醒多个成员
 * 仍只算 1；被合并的重复唤醒不额外计数；全部 in-flight（零投递）不算跳。
 * 预算耗尽时 Agent 消息照常落库、零唤醒、每个被压制成员一条 budget-exhausted
 * 轮次结果；下一次开世代动作重置用量。
 *
 * 预算的观察口径是「开世代后的静止态」：reply 替身会把 Agent 回复继续转发，
 * 请求返回时本轮已把当世代额度用完，所以重置与上界生效用 ignore 替身观察，
 * 转发的链式结果单独断言。
 */

interface BudgetFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface BudgetRow {
  epoch_seq: number;
  used: number;
  limit_value: number;
}

interface RoundOutcomeRow {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
  finished_reason: string | null;
  budget_consumed: number;
  merged: number;
}

const CHANNEL_BODY = {
  name: '预算频道',
  description: '人类世代与回应预算',
  mode: 'autonomous',
  response_budget_limit: 3,
};

/** 预算耗尽的可读 reason（zh-CN 词条 `round.budgetExhausted` 的已知取值）。 */
const BUDGET_EXHAUSTED_REASON =
  '预算耗尽：本世代已用 3/3 跳，本条消息的唤醒被压制（消息照常落库）';

async function startBudgetFixture(
  prefix: string,
  provider: 'reply' | 'ignore' | 'fail' | 'delay',
  extraArgs: readonly string[] = [],
): Promise<BudgetFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', provider, ...extraArgs],
  });
  return {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: BudgetFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(
  fixture: BudgetFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(
  fixture: BudgetFixture,
  body: Record<string, unknown> = CHANNEL_BODY,
): Promise<string> {
  const created = await postJson(fixture, '/api/channels', body);
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: BudgetFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: BudgetFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: BudgetFixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function listMessages(
  fixture: BudgetFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function queryRows<T>(fixture: BudgetFixture, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

/** 预算表按 target 读取；每 target 一行是表本身的约束。 */
function budgetRows(fixture: BudgetFixture, targetId: string): BudgetRow[] {
  return queryRows<BudgetRow>(
    fixture,
    'SELECT epoch_seq, used, limit_value FROM target_budget WHERE target_id = ?',
    [targetId],
  );
}

function budgetRow(fixture: BudgetFixture, targetId: string): BudgetRow {
  const rows = budgetRows(fixture, targetId);
  assert.equal(rows.length, 1, 'the budget ledger keeps exactly one row per target');
  return rows[0]!;
}

function roundOutcomes(fixture: BudgetFixture): RoundOutcomeRow[] {
  return queryRows<RoundOutcomeRow>(
    fixture,
    `SELECT member_id, target_id, base_seq, status, reason, finished_reason,
            budget_consumed, merged
       FROM round_outcome ORDER BY rowid`,
  );
}

async function waitFor(
  predicate: () => boolean,
  describe: string,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`${describe} did not settle in ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('the first human message opens a human epoch whose epoch_seq is that message seq', async () => {
  const fixture = await startBudgetFixture('allibot-budget-epoch-', 'ignore');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const first = await postMessage(fixture, channelId, { body: '第一句' });
    assert.equal(first['seq'], 1);
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 0, limit_value: 3 },
      'the first human message opens the epoch at its own seq with the channel ceiling',
    );

    const second = await postMessage(fixture, channelId, { body: '第二句' });
    assert.equal(second['seq'], 2);
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 2, used: 0, limit_value: 3 },
      'the next human message opens the next epoch',
    );

    assert.equal(
      roundOutcomes(fixture).filter((row) => row.budget_consumed === 1).length,
      0,
      'a human message is not a jump',
    );
  } finally {
    await fixture.stop();
  }
});

test('an Agent reply relayed to one other member counts one jump per Agent message', async () => {
  const fixture = await startBudgetFixture('allibot-budget-relay-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    await postMessage(fixture, channelId, { body: '大家好' });

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['seq'], message['kind'], message['author_member_id']]),
      [
        [1, 'human', messages[0]?.['author_member_id']],
        [2, 'agent', first],
        [3, 'agent', second],
        [4, 'agent', first],
        [5, 'agent', second],
        [6, 'agent', second],
      ],
      'each Agent reply relays to the other member until the epoch ceiling stops the chain',
    );

    assert.deepEqual(
      roundOutcomes(fixture).map((row) => [
        row.member_id === first ? '甲' : '乙',
        row.status,
        row.base_seq,
        row.budget_consumed,
      ]),
      [
        ['甲', 'replied', 1, 0],
        ['乙', 'replied', 2, 1],
        ['甲', 'replied', 3, 1],
        ['乙', 'replied', 4, 1],
        ['甲', 'budget-exhausted', 5, 0],
        ['乙', 'replied', 1, 0],
        ['甲', 'budget-exhausted', 6, 0],
      ],
      'one jump per delivered Agent message; the fourth hop is suppressed',
    );

    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'the used count stops exactly at the epoch ceiling',
    );

    const jumped = roundOutcomes(fixture)
      .filter((row) => row.budget_consumed === 1)
      .map((row) => row.base_seq);
    assert.equal(new Set(jumped).size, 3, 'one jump per delivered Agent message, not per member');
  } finally {
    await fixture.stop();
  }
});

test('one Agent message that wakes two members still counts a single jump', async () => {
  const fixture = await startBudgetFixture('allibot-budget-fanout-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const third = await createAgent(fixture, '丙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);
    await joinChannel(fixture, channelId, third);

    await postMessage(fixture, channelId, { body: '大家好' });

    const rows = roundOutcomes(fixture);
    const wokenByFirstReply = rows.filter((row) => row.base_seq === 2);
    assert.deepEqual(
      wokenByFirstReply.map((row) => [row.member_id === second ? '乙' : '丙', row.budget_consumed]),
      [
        ['乙', 1],
        ['丙', 1],
      ],
      'both members are marked as delivered by the same counted jump',
    );

    const jumpedSeqs = new Set(
      rows.filter((row) => row.budget_consumed === 1).map((row) => row.base_seq),
    );
    assert.equal(jumpedSeqs.size, 3, 'three distinct Agent messages consumed the three jumps');
    assert.equal(
      rows.filter((row) => row.status === 'budget-exhausted' && row.budget_consumed === 1).length,
      0,
      'a suppressed wake is never marked as delivered',
    );
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'fan-out to two members did not multiply the used count',
    );
  } finally {
    await fixture.stop();
  }
});

test('an Agent message whose wakes all fold into in-flight rounds is not a jump', async () => {
  const fixture = await startBudgetFixture('allibot-budget-in-flight-', 'delay', [
    '--scripted-delay-ms',
    '300',
  ]);
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    // The human message starts both delayed rounds at once; the first one to
    // settle (甲) relays its reply while 乙 is still in flight, so that wake
    // folds into 乙's running round and delivers nothing.
    await postMessage(fixture, channelId, { body: '大家好' });

    await waitFor(
      () => budgetRow(fixture, channelId).used === 3,
      'the delayed chain reaching the epoch ceiling',
    );
    const rows = roundOutcomes(fixture);

    const folded = rows.filter((row) => row.base_seq === 2 && row.merged === 1);
    assert.equal(folded.length, 1, 'the relayed wake folded into the in-flight round');
    assert.equal(folded[0]?.member_id, second);
    assert.equal(folded[0]?.budget_consumed, 0, 'a merged wake is not a delivery');

    assert.equal(
      rows.filter((row) => row.base_seq === 2 && row.budget_consumed === 1).length,
      0,
      'a message whose wakes all fold delivers nothing and is not a jump',
    );
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'the chain is bounded at the epoch ceiling',
    );
  } finally {
    await fixture.stop();
  }
});

test('an exhausted epoch persists the Agent message with zero wakes and one budget-exhausted outcome per member', async () => {
  const fixture = await startBudgetFixture('allibot-budget-exhausted-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    const response = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '大家好',
    });
    assert.equal(response.status, 201, 'budget exhaustion is not a client error');

    const messages = await listMessages(fixture, channelId);
    // The fourth Agent message is the first one at the exhausted ceiling: it
    // lands as a permanent row and its wake to the other member is suppressed.
    const suppressedMessage = messages.filter((message) => message['kind'] === 'agent')[3];
    assert.ok(suppressedMessage !== undefined, 'the over-limit Agent message is still a row');
    const suppressedSeq = Number(suppressedMessage['seq']);
    assert.deepEqual(
      messages.filter((message) => Number(message['seq']) > suppressedSeq).map((message) => message['seq']),
      [6],
      'the suppressed Agent message wakes nobody; the only later row comes from the human wake',
    );

    const suppressedRows = roundOutcomes(fixture).filter((row) => row.base_seq === suppressedSeq);
    assert.deepEqual(
      suppressedRows.map((row) => [row.status, row.budget_consumed, row.finished_reason]),
      [['budget-exhausted', 0, null]],
      'one budget-exhausted row for the suppressed member and no round of its own',
    );
    assert.equal(
      suppressedRows[0]?.reason,
      BUDGET_EXHAUSTED_REASON,
      'the reason is the readable zh-CN budget-exhausted copy',
    );
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'the used count never exceeds the ceiling',
    );
  } finally {
    await fixture.stop();
  }
});

test('the next human message moves the epoch seq and the used count starts over', async () => {
  // The ignore adapter lands no Agent reply, so the epoch is observable at rest:
  // the human message is the only writer of the ledger inside the request.
  const fixture = await startBudgetFixture('allibot-budget-reset-', 'ignore');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    const one = await postMessage(fixture, channelId, { body: '第一句' });
    assert.deepEqual(budgetRow(fixture, channelId), {
      epoch_seq: one['seq'],
      used: 0,
      limit_value: 3,
    });

    const two = await postMessage(fixture, channelId, { body: '第二句' });
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: two['seq'], used: 0, limit_value: 3 },
      'the next human message moves the epoch seq and the used count starts over at 0',
    );
  } finally {
    await fixture.stop();
  }
});

test('the budget is restored in the new epoch: a fresh human turn spends its own three jumps', async () => {
  const fixture = await startBudgetFixture('allibot-budget-restored-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    await postMessage(fixture, channelId, { body: '第一句' });
    assert.equal(budgetRow(fixture, channelId).used, 3, 'the first epoch burns out');

    const human = await postMessage(fixture, channelId, { body: '第二句' });
    const humanSeq = Number(human['seq']);
    const after = budgetRow(fixture, channelId);
    assert.equal(after.epoch_seq, humanSeq, 'the new epoch is identified by the new human seq');
    assert.equal(after.used, 3, 'the new epoch spends its own jumps instead of staying exhausted');
    assert.equal(
      roundOutcomes(fixture).filter(
        (row) => row.budget_consumed === 1 && row.base_seq >= humanSeq,
      ).length > 0,
      true,
      'the restored budget is delivered as jumps in the new epoch',
    );
  } finally {
    await fixture.stop();
  }
});

test('a channel upper-bound change takes effect at the next human epoch, not the running one', async () => {
  const fixture = await startBudgetFixture('allibot-budget-limit-change-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    await postMessage(fixture, channelId, { body: '第一句' });
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'the first epoch is bounded at 3',
    );

    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      response_budget_limit: 10,
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    assert.equal((await readJson(patched))['response_budget_limit'], 10);
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'the running epoch keeps the ceiling it opened with',
    );

    await postMessage(fixture, channelId, { body: '第二句' });
    const opened = budgetRow(fixture, channelId);
    assert.equal(opened.limit_value, 10, 'the next human epoch opens with the new ceiling');
    await waitFor(
      () => budgetRow(fixture, channelId).used === 10,
      'the new epoch spending its 10 jumps',
    );
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: opened.epoch_seq, used: 10, limit_value: 10 },
      'the chain stops at the new ceiling, not at the old one',
    );
    assert.equal(
      roundOutcomes(fixture)
        .filter((row) => row.status === 'budget-exhausted')
        .every((row) => row.reason.startsWith('预算耗尽')),
      true,
      'every suppression carries the readable reason',
    );
  } finally {
    await fixture.stop();
  }
});

test('the owner reassigning a task opens a human epoch at the reassignment system message seq', async () => {
  const fixture = await startBudgetFixture('allibot-budget-reassign-', 'ignore');
  try {
    const agent = await createAgent(fixture, '受派 Agent');
    const channelId = await createChannel(fixture);
    const created = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '改派开世代',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const task = await readJson(created);
    const taskTargetId = task['target_id'] as string;

    const assigned = await patchJson(fixture, `/api/tasks/${task['id'] as string}`, {
      assignee_member_id: agent,
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());

    const thread = await listMessages(fixture, taskTargetId);
    const assignment = thread.find((message) => message['kind'] === 'system' && message['seq'] === 2);
    assert.ok(assignment !== undefined, 'the reassignment lands one system message at seq 2');

    assert.deepEqual(
      budgetRow(fixture, taskTargetId),
      { epoch_seq: 2, used: 0, limit_value: 3 },
      'the system message seq is the epoch seq, and a task target runs on the built-in default',
    );
    assert.equal(
      roundOutcomes(fixture).length,
      0,
      'a reassignment is an epoch opener, not a wake and not a jump',
    );
  } finally {
    await fixture.stop();
  }
});

test('one exhausted Agent message that would wake two members lands one budget-exhausted row each', async () => {
  const fixture = await startBudgetFixture('allibot-budget-suppress-fanout-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const third = await createAgent(fixture, '丙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);
    await joinChannel(fixture, channelId, third);

    await postMessage(fixture, channelId, { body: '大家好' });

    const rows = roundOutcomes(fixture);
    const bySeq = new Map<number, RoundOutcomeRow[]>();
    for (const row of rows) {
      bySeq.set(row.base_seq, [...(bySeq.get(row.base_seq) ?? []), row]);
    }
    const suppressed = [...bySeq.values()].filter((bucket) =>
      bucket.some((row) => row.status === 'budget-exhausted'),
    );
    assert.equal(suppressed.length >= 1, true, 'the chain hits the ceiling at least once');
    for (const bucket of suppressed) {
      assert.equal(
        bucket.length,
        2,
        'the exhausted message suppresses both members it would have woken',
      );
      assert.equal(
        bucket.every(
          (row) => row.status === 'budget-exhausted' && row.reason === BUDGET_EXHAUSTED_REASON,
        ),
        true,
        'each suppressed member gets its own readable outcome row',
      );
    }
    assert.equal(
      rows
        .filter((row) => row.base_seq > 1 && row.status === 'replied')
        .every((row) => row.budget_consumed === 1),
      true,
      'every relayed Agent round (base_seq > 1) was delivered by a counted jump',
    );
    assert.deepEqual(
      budgetRow(fixture, channelId),
      { epoch_seq: 1, used: 3, limit_value: 3 },
      'the ledger stops at the ceiling no matter how many members a message wakes',
    );
  } finally {
    await fixture.stop();
  }
});

test('the sqlite3 CLI reads one budget row per target with its epoch seq and used count', async () => {
  const fixture = await startBudgetFixture('allibot-budget-sqlite-', 'ignore');
  try {
    const channelA = await createChannel(fixture, { ...CHANNEL_BODY, name: '频道甲' });
    const channelB = await createChannel(fixture, { ...CHANNEL_BODY, name: '频道乙' });
    await postMessage(fixture, channelA, { body: '甲频道第一条' });
    await postMessage(fixture, channelB, { body: '乙频道第一条' });
    await postMessage(fixture, channelB, { body: '乙频道第二条' });

    const run = (sql: string): string => {
      const result = spawnSync('sqlite3', [path.join(fixture.dataDir, 'allibot.db'), sql], {
        encoding: 'utf8',
      });
      assert.equal(result.status, 0, `sqlite3 should exit 0; stderr: ${result.stderr}`);
      return result.stdout.trim();
    };

    assert.equal(
      run(
        `select count(*), min(epoch_seq), max(used) from target_budget where target_id = '${channelA}'`,
      ),
      '1|1|0',
    );
    assert.equal(
      run(
        `select count(*), min(epoch_seq), max(used) from target_budget where target_id = '${channelB}'`,
      ),
      '1|2|0',
      'the second message moves the epoch seq and the used count resets',
    );
    assert.equal(
      run('select count(*) from (select target_id from target_budget group by target_id)'),
      '2',
      'one row per target, never per message',
    );
  } finally {
    await fixture.stop();
  }
});
