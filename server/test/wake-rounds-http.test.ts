import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ZH_CN } from '@allibot/shared';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

interface WakeFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface RoundOutcomeRow {
  id: string;
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
  finished_reason: string | null;
  started_at: string;
  finished_at: string;
  budget_consumed: number;
  merged: number;
}

async function startWakeFixture(
  prefix: string,
  provider: 'reply' | 'ignore' | 'fail' | 'delay',
  extraArgs: readonly string[] = [],
): Promise<WakeFixture> {
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
  fixture: WakeFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: WakeFixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '唤醒频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: WakeFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: WakeFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: WakeFixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function listMessages(
  fixture: WakeFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

async function listMembers(
  fixture: WakeFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/members`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['members'] as Record<string, unknown>[];
}

/** The round outcomes in write order; `id` is opaque, so the test reads rowid order. */
function roundOutcomes(fixture: WakeFixture): RoundOutcomeRow[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT id, member_id, target_id, base_seq, status, reason, finished_reason,
                started_at, finished_at, budget_consumed, merged
           FROM round_outcome ORDER BY rowid`,
      )
      .all() as RoundOutcomeRow[];
  } finally {
    db.close();
  }
}

function ownerId(fixture: WakeFixture): string {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as {
      id: string;
    };
    return row.id;
  } finally {
    db.close();
  }
}

async function waitForOutcomes(
  fixture: WakeFixture,
  predicate: (rows: RoundOutcomeRow[]) => boolean,
  timeoutMs = 10_000,
): Promise<RoundOutcomeRow[]> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const rows = roundOutcomes(fixture);
    if (predicate(rows)) {
      return rows;
    }
    if (Date.now() >= deadline) {
      assert.fail(`round outcomes did not settle in ${timeoutMs}ms; saw: ${JSON.stringify(rows)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('one owner message wakes both Agent members and each lands exactly one reply', async () => {
  const fixture = await startWakeFixture('allibot-wake-reply-', 'reply');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    const human = await postMessage(fixture, channelId, { body: '大家好' });
    assert.equal(human['seq'], 1);

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['seq'], message['kind'], message['author_member_id']]),
      [
        [1, 'human', ownerId(fixture)],
        [2, 'agent', first],
        [3, 'agent', second],
      ],
      'the human message is followed by exactly one reply per woken member',
    );
    assert.equal(
      new Set(messages.map((message) => message['id'])).size,
      messages.length,
      'no message is written twice',
    );

    const outcomes = roundOutcomes(fixture);
    assert.deepEqual(
      outcomes.map((row) => [row.member_id, row.status]),
      [
        [first, 'replied'],
        [second, 'replied'],
      ],
      'one round outcome row per member',
    );
    for (const row of outcomes) {
      assert.equal(row.target_id, channelId);
      assert.equal(row.base_seq, 1, 'the wake signal carries the triggering seq');
      assert.equal(row.merged, 0);
      assert.equal(row.budget_consumed, 0, 'budget accounting lands with its own ticket');
      assert.equal(row.finished_reason, '正常完成');
      assert.ok(row.reason.length > 0, 'the reason is readable');
      assert.ok(!row.reason.includes('大家好'), 'the wake signal carries no message body');
    }
  } finally {
    await fixture.stop();
  }
});

test('the scripted ignore and fail behaviours close rounds without a reply', async () => {
  const ignoring = await startWakeFixture('allibot-wake-ignore-', 'ignore');
  try {
    const agent = await createAgent(ignoring, '沉默者');
    const channelId = await createChannel(ignoring);
    await joinChannel(ignoring, channelId, agent);

    await postMessage(ignoring, channelId, { body: '无关的一句' });

    const messages = await listMessages(ignoring, channelId);
    assert.deepEqual(messages.map((message) => message['kind']), ['human']);
    const outcomes = roundOutcomes(ignoring);
    assert.equal(outcomes.length, 1);
    // A human message is a definite signal (#15): the double's self-judged
    // ignore closes as failed. The non-definite ignored round is covered in
    // response-judgment-http.test.ts.
    assert.equal(outcomes[0]?.status, 'failed');
    assert.equal(outcomes[0]?.finished_reason, '正常完成');
  } finally {
    await ignoring.stop();
  }

  const failing = await startWakeFixture('allibot-wake-fail-', 'fail');
  try {
    const agent = await createAgent(failing, '故障者');
    const channelId = await createChannel(failing);
    await joinChannel(failing, channelId, agent);

    await postMessage(failing, channelId, { body: '请回应' });

    assert.deepEqual(
      (await listMessages(failing, channelId)).map((message) => message['kind']),
      ['human'],
      'a failed round writes no reply',
    );
    const outcomes = roundOutcomes(failing);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'failed');
    assert.equal(outcomes[0]?.finished_reason, '错误');
    assert.ok((outcomes[0]?.reason ?? '').length > 0);
  } finally {
    await failing.stop();
  }
});

test('a repeated wake inside the delay window merges instead of starting a second round', async () => {
  const fixture = await startWakeFixture('allibot-wake-delay-', 'delay', [
    '--scripted-delay-ms',
    '1500',
  ]);
  try {
    const agent = await createAgent(fixture, '慢工');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const first = await postMessage(fixture, channelId, { body: '第一句' });
    assert.equal(first['seq'], 1);
    const second = await postMessage(fixture, channelId, { body: '第二句' });
    assert.equal(second['seq'], 2, 'the write path does not wait for the delayed round');

    const settled = await waitForOutcomes(
      fixture,
      (rows) => rows.some((row) => row.status === 'replied'),
    );
    assert.deepEqual(
      settled.map((row) => [row.status, row.base_seq, row.merged]),
      [
        ['merged', 2, 1],
        ['replied', 1, 0],
      ],
      'the repeated wake folds into one merged row keyed by the largest seq; the delayed round still closes once',
    );
    const mergedRow = settled[0];
    assert.equal(mergedRow?.finished_reason, null, 'a merged row has no round of its own to finish');
    assert.ok(
      (mergedRow?.reason ?? '').includes('#2'),
      `the merged reason names the largest seq: ${mergedRow?.reason ?? ''}`,
    );

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['seq'], message['kind']]),
      [
        [1, 'human'],
        [2, 'human'],
        [3, 'agent'],
      ],
      'one round writes at most one target message',
    );
    assert.equal(
      roundOutcomes(fixture).filter((row) => row.status === 'replied').length,
      1,
      'no second in-flight round was started',
    );
  } finally {
    await fixture.stop();
  }
});

test('a mentioned outsider replies through a system join message and becomes a member', async () => {
  const fixture = await startWakeFixture('allibot-wake-pierce-reply-', 'reply');
  try {
    const insider = await createAgent(fixture, '甲');
    const outsider = await createAgent(fixture, '局外人');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, insider);

    await postMessage(fixture, channelId, { body: '@局外人 你来一句' });

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['agent', insider],
        ['system', ownerId(fixture)],
        ['agent', outsider],
      ],
      'the join event lands before the pierced reply and is authored by the owner',
    );
    const join = messages[2];
    assert.ok((join?.['body'] as string).includes('局外人'), 'the join event names the member');
    assert.ok((join?.['body'] as string).includes('加入'));

    const memberIds = (await listMembers(fixture, channelId)).map((member) => member['id']);
    assert.deepEqual(memberIds.sort(), [insider, outsider, ownerId(fixture)].sort());

    const outsiderRow = roundOutcomes(fixture).find((row) => row.member_id === outsider);
    assert.ok(outsiderRow !== undefined);
    assert.equal(outsiderRow.status, 'replied');
    assert.ok(outsiderRow.reason.includes('穿透'), `the reason names the penetration: ${outsiderRow.reason}`);
    assert.ok(
      !outsiderRow.reason.includes('；；'),
      `the reason joins its clauses once: ${outsiderRow.reason}`,
    );
    assert.ok(
      outsiderRow.reason.includes(String(join?.['seq'])),
      'the reason points at the join event seq',
    );
  } finally {
    await fixture.stop();
  }
});

test('a mentioned outsider that ignores joins nothing and leaves no system message', async () => {
  const fixture = await startWakeFixture('allibot-wake-pierce-ignore-', 'ignore');
  try {
    const insider = await createAgent(fixture, '甲');
    const outsider = await createAgent(fixture, '局外人');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, insider);
    const membersBefore = (await listMembers(fixture, channelId)).map((member) => member['id']);

    await postMessage(fixture, channelId, { body: '@局外人 你来一句' });

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(messages.map((message) => message['kind']), ['human']);
    assert.deepEqual(
      (await listMembers(fixture, channelId)).map((member) => member['id']).sort(),
      membersBefore.sort(),
      'membership only follows a real reply',
    );
    assert.deepEqual(
      roundOutcomes(fixture).map((row) => [row.member_id, row.status]),
      [
        [insider, 'failed'],
        [outsider, 'failed'],
      ],
      // The human message that pierced the mention is a definite signal (#15),
      // so both rounds close as failed; the pierced member still gets one.
    );
  } finally {
    await fixture.stop();
  }
});

test('a replayed client message id wakes nobody a second time and an archived channel wakes nobody', async () => {
  const fixture = await startWakeFixture('allibot-wake-guards-', 'reply');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    await postMessage(fixture, channelId, { body: '幂等', client_message_id: 'client-1' });
    await postMessage(fixture, channelId, { body: '重发', client_message_id: 'client-1' });
    assert.equal(roundOutcomes(fixture).length, 1, 'a replay is not a new wake');
    assert.equal(
      (await listMessages(fixture, channelId)).filter((message) => message['kind'] === 'agent')
        .length,
      1,
    );

    const archived = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());
    const refused = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '归档后不该落库',
    });
    assert.equal(refused.status, 400);
    assert.equal(roundOutcomes(fixture).length, 1, 'a refused write triggers no wake');
  } finally {
    await fixture.stop();
  }
});

test('the round_outcome row reads back through the sqlite3 CLI with readable reason and finish reason', async () => {
  const fixture = await startWakeFixture('allibot-wake-sqlite-', 'reply');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    await postMessage(fixture, channelId, { body: '请回应' });

    const result = spawnSync(
      'sqlite3',
      [
        path.join(fixture.dataDir, 'allibot.db'),
        'select member_id, target_id, base_seq, status, reason, finished_reason from round_outcome order by id',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, `sqlite3 should exit 0; stderr: ${result.stderr}`);
    const columns = result.stdout.trim().split('|');
    assert.deepEqual(columns.slice(0, 4), [agent, channelId, '1', 'replied']);
    assert.match(columns[4] ?? '', /[一-鿿]/, 'the reason is readable zh-CN text');
    assert.equal(columns[5], '正常完成');
  } finally {
    await fixture.stop();
  }
});

test('round replies and the join system event wake nobody in this ticket', async () => {
  const fixture = await startWakeFixture('allibot-wake-no-chain-', 'reply');
  try {
    const insider = await createAgent(fixture, '甲');
    const outsider = await createAgent(fixture, '局外人');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, insider);

    await postMessage(fixture, channelId, { body: '@局外人 你来一句' });

    // Two wakes came from the human message (insider + pierced outsider). The
    // insider's reply and the join system event are both messages, and neither
    // produces a wake here: relay delivery of Agent messages is the jump /
    // budget ticket's (#16), where a hop is counted and bounded.
    const outcomes = roundOutcomes(fixture);
    assert.deepEqual(
      outcomes.map((row) => [row.member_id, row.status, row.base_seq]),
      [
        [insider, 'replied', 1],
        [outsider, 'replied', 1],
      ],
      'exactly one round outcome per wake of the one human message',
    );
    const systemMessages = (await listMessages(fixture, channelId)).filter(
      (message) => message['kind'] === 'system',
    );
    assert.equal(systemMessages.length, 1, 'the join event is the only system message');
    assert.equal(
      systemMessages[0]?.['author_member_id'],
      ownerId(fixture),
      'the join event is authored by the owner, not by the agent',
    );
  } finally {
    await fixture.stop();
  }
});

test('a round offering several pending replies still lands exactly one target message', async () => {
  const fixture = await startWakeFixture('allibot-wake-one-message-', 'reply', [
    '--scripted-reply',
    '第一条待落库回复',
    '--scripted-reply',
    '第二条待落库回复',
  ]);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    await postMessage(fixture, channelId, { body: '请回应' });

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['seq'], message['kind'], message['body']]),
      [
        [1, 'human', '请回应'],
        [2, 'agent', '第一条待落库回复'],
      ],
      '一轮 ↔ 至多一条 target 消息: the first pending reply is the round\'s message',
    );
    assert.equal(roundOutcomes(fixture).length, 1, 'one round outcome for the one round');
  } finally {
    await fixture.stop();
  }
});

test('the readable round copy comes from the zh-CN catalog through the stored locale', async () => {
  const fixture = await startWakeFixture('allibot-wake-copy-', 'reply');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    await postMessage(fixture, channelId, { body: '请回应' });

    const row = roundOutcomes(fixture)[0];
    assert.ok(row !== undefined);
    assert.equal(
      row.reason,
      [
        ZH_CN['wake.channelMessage'].text,
        ZH_CN['round.replied'].text,
        ZH_CN['round.mandatory.humanMessage'].text,
      ].join('；'),
      'the reason is composed from catalog entries, not a second copy of the text',
    );
    assert.equal(row.finished_reason, ZH_CN['round.finished.completed'].text);
  } finally {
    await fixture.stop();
  }
});
