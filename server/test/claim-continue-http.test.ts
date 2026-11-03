import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ZH_CN } from '@allibot/shared';
import Database from 'better-sqlite3';
import {
  REPO_ROOT,
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 认领 (Claim) and 自动续跑 (Auto-continue) at the one seam: a real backend
 * process, a temporary data directory and the scripted double injected through
 * startup arguments. The claim is decided by the orchestrator when the task is
 * created; the double's `continue-task` behaviour is what makes "I will
 * continue" an executable structured action rather than prose.
 *
 * The second-claim attempt is not reachable from the human face (the owner can
 * never claim: claim is an orchestration act). Its fixture is another caller of
 * the same production entry point, exactly like the member-face fixture #14
 * uses for the review rule.
 */

const CLAIM_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'claim-task.mjs');

type ProviderBehavior = 'reply' | 'continue-task';

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface RoundOutcomeRow {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
  budget_consumed: number;
  merged: number;
}

interface BudgetRow {
  epoch_seq: number;
  used: number;
  limit_value: number;
}

async function startFixture(
  prefix: string,
  provider: ProviderBehavior,
  options: { env?: NodeJS.ProcessEnv; args?: readonly string[] } = {},
): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: options.env,
    args: ['--scripted-provider', provider, '--scripted-report-context', ...(options.args ?? [])],
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
  fixture: Fixture,
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
  fixture: Fixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: Fixture, name = '认领频道'): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(
  fixture: Fixture,
  displayName: string,
  options: { autoClaim?: number } = {},
): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
    ...(options.autoClaim === undefined ? {} : { auto_claim: options.autoClaim }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

/** The remote-data-flow consent that makes an Agent available (D1.12). */
async function confirmConsent(fixture: Fixture, provider = 'openai'): Promise<void> {
  const confirmed = await postJson(fixture, `/api/remote-data-flow/${provider}/consent`, {});
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
}

async function joinChannel(
  fixture: Fixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function createTask(
  fixture: Fixture,
  channelId: string,
  title: string,
): Promise<Record<string, unknown>> {
  const created = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(created.status, 201, await created.clone().text());
  return await readJson(created);
}

async function getTask(fixture: Fixture, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/tasks/${id}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function listMessages(
  fixture: Fixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages?limit=200`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

async function postMessage(
  fixture: Fixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

function queryRows<T>(fixture: Fixture, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

function queryOne<T>(fixture: Fixture, sql: string, params: unknown[] = []): T | undefined {
  return queryRows<T>(fixture, sql, params)[0];
}

function roundOutcomes(fixture: Fixture): RoundOutcomeRow[] {
  return queryRows<RoundOutcomeRow>(
    fixture,
    `SELECT member_id, target_id, base_seq, status, reason, budget_consumed, merged
       FROM round_outcome ORDER BY rowid`,
  );
}

function budgetRow(fixture: Fixture, targetId: string): BudgetRow | undefined {
  return queryOne<BudgetRow>(
    fixture,
    'SELECT epoch_seq, used, limit_value FROM target_budget WHERE target_id = ?',
    [targetId],
  );
}

function runClaimFixture(
  fixture: Fixture,
  taskId: string,
): Record<string, unknown> {
  const result = spawnSync(
    process.execPath,
    [CLAIM_FIXTURE, JSON.stringify({ dataDir: fixture.dataDir, taskId })],
    { cwd: REPO_ROOT, encoding: 'utf8', env: { ...process.env, OPENAI_API_KEY: 'sk-fixture' } },
  );
  assert.equal(result.status, 0, `claim fixture should exit 0; ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(typeof parsed === 'object' && parsed !== null, 'the fixture answers JSON');
  return parsed as Record<string, unknown>;
}

function systemMessageBodies(messages: readonly Record<string, unknown>[]): string[] {
  return messages
    .filter((message) => message['kind'] === 'system')
    .map((message) => String(message['body']));
}

/** The scripted double's context report, read off an Agent reply body. */
interface ContextReport {
  ctx: number;
  ctxfirst: number;
  ctxlast: number;
  thread: string;
}

function contextReport(body: string): ContextReport {
  const read = (name: string): number => {
    const match = new RegExp(`${name}:(\\d+)`).exec(body);
    assert.ok(match !== null, `the reply should report ${name}: ${body}`);
    return Number(match[1]);
  };
  const thread = /thread:(window|full)/.exec(body);
  assert.ok(thread !== null, `the reply should report thread: ${body}`);
  return {
    ctx: read('ctx'),
    ctxfirst: read('ctxfirst'),
    ctxlast: read('ctxlast'),
    thread: thread[1]!,
  };
}

function agentReplies(messages: readonly Record<string, unknown>[]): Record<string, unknown>[] {
  return messages.filter((message) => message['kind'] === 'agent');
}

test('an available auto-claim Agent picks up a new task in one transaction and is woken with the claim signal', async () => {
  const fixture = await startFixture('allibot-claim-success-', 'reply', {
    env: { OPENAI_API_KEY: 'sk-claim-test' },
  });
  try {
    const agent = await createAgent(fixture, '认领者');
    await confirmConsent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const task = await createTask(fixture, channelId, '整理认领流程');
    const taskId = task['id'] as string;
    const targetId = task['target_id'] as string;

    assert.equal(task['status'], 'in_progress', 'the claim moves the task to in_progress');
    assert.equal(task['assignee_member_id'], agent, 'the claim assigns the claimer');
    assert.equal(typeof task['claimed_at'], 'string', 'claimed_at is the at-most-once lock');
    assert.deepEqual(task['allowed_transitions'], ['in_review']);
    assert.equal(task['message_count'], 4, 'creation, two claim records and one reply');

    const detail = await getTask(fixture, taskId);
    assert.equal(detail['status'], 'in_progress');
    assert.equal(detail['assignee_member_id'], agent);
    assert.equal(detail['claimed_at'], task['claimed_at']);

    const thread = await listMessages(fixture, targetId);
    assert.deepEqual(
      thread.map((message) => message['seq']),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      thread.map((message) => message['kind']),
      ['system', 'system', 'system', 'agent'],
    );

    const owner = queryOne<{ id: string }>(
      fixture,
      "SELECT id FROM member WHERE kind = 'owner'",
    );
    assert.ok(owner !== undefined);
    for (const message of thread.slice(0, 3)) {
      assert.equal(
        message['author_member_id'],
        owner!.id,
        'every system record is authored by the owner',
      );
    }

    const bodies = systemMessageBodies(thread);
    assert.match(bodies[0]!, /整理认领流程/, 'the creation record names the task');
    assert.match(bodies[1]!, /认领者/, 'the「已认领」record names the claimer');
    assert.match(bodies[1]!, /整理认领流程/);
    assert.match(bodies[2]!, /认领后自动开工/, 'the second record is the explicit start-of-work fact');
    assert.match(bodies[2]!, /认领者/);

    const members = queryRows<{ member_id: string }>(
      fixture,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [targetId],
    );
    assert.deepEqual(
      members.map((row) => row.member_id),
      [owner!.id, agent],
      'the claimer joins the task thread target',
    );

    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1, 'the claim wake runs exactly one round');
    assert.equal(outcomes[0]?.member_id, agent);
    assert.equal(outcomes[0]?.target_id, targetId);
    assert.equal(outcomes[0]?.base_seq, 3, 'the wake points at「认领后自动开工」');
    assert.equal(outcomes[0]?.status, 'replied', 'the claim is a definite signal and must be answered');
    assert.equal(outcomes[0]?.budget_consumed, 0, 'the claim is not a jump');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['wake.claim'].text), outcomes[0]?.reason);
    assert.ok(
      outcomes[0]?.reason.includes(ZH_CN['round.mandatory.claim'].text),
      outcomes[0]?.reason,
    );

    assert.deepEqual(
      budgetRow(fixture, targetId),
      { epoch_seq: 2, used: 0, limit_value: 3 },
      'the generation identity is the「已认领」seq (not the「认领后自动开工」seq) and used resets to 0',
    );

    const report = contextReport(String(agentReplies(thread)[0]?.['body']));
    assert.equal(report.thread, 'window', 'the claim round is a normal round, not an auto-continue');

    // The next human message opens a new epoch: its own seq is the identity and
    // the jump count starts over.
    const human = await postMessage(fixture, targetId, { body: '下一世代的一句' });
    assert.deepEqual(
      budgetRow(fixture, targetId),
      { epoch_seq: human['seq'], used: 0, limit_value: 3 },
      'the next human message opens the next human epoch',
    );
  } finally {
    await fixture.stop();
  }
});

test('a second claim attempt on an already claimed task writes nothing', async () => {
  const fixture = await startFixture('allibot-claim-at-most-once-', 'reply', {
    env: { OPENAI_API_KEY: 'sk-claim-test' },
  });
  try {
    const agent = await createAgent(fixture, '认领者');
    await confirmConsent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const task = await createTask(fixture, channelId, '至多一次');
    const taskId = task['id'] as string;
    const targetId = task['target_id'] as string;
    const claimedAt = task['claimed_at'];
    const threadBefore = await listMessages(fixture, targetId);
    const budgetBefore = budgetRow(fixture, targetId);
    const outcomesBefore = roundOutcomes(fixture).length;

    assert.deepEqual(runClaimFixture(fixture, taskId), { ok: true, claimed: false });
    assert.equal((await getTask(fixture, taskId))['claimed_at'], claimedAt);
    assert.deepEqual(
      (await listMessages(fixture, targetId)).map((message) => message['seq']),
      threadBefore.map((message) => message['seq']),
      'a repeated claim appends no system record',
    );
    assert.deepEqual(budgetRow(fixture, targetId), budgetBefore);
    assert.equal(roundOutcomes(fixture).length, outcomesBefore, 'a repeated claim wakes nobody');

    // The lock is claimed_at, not the assignee: even after the owner takes the
    // assignment back, the task has already been claimed and cannot be claimed again.
    const unassigned = await patchJson(fixture, `/api/tasks/${taskId}`, {
      assignee_member_id: null,
    });
    assert.equal(unassigned.status, 200, await unassigned.clone().text());
    const afterUnassign = await listMessages(fixture, targetId);
    assert.equal(
      afterUnassign.length,
      threadBefore.length + 1,
      'taking the assignment back lands its own system record',
    );

    assert.deepEqual(runClaimFixture(fixture, taskId), { ok: true, claimed: false });
    const afterSecondAttempt = await listMessages(fixture, targetId);
    assert.deepEqual(
      afterSecondAttempt.map((message) => message['seq']),
      afterUnassign.map((message) => message['seq']),
    );
    assert.equal(
      systemMessageBodies(afterSecondAttempt).filter((body) => body.includes('已由')).length,
      1,
      'exactly one 「已认领」 record exists for the task',
    );
    assert.equal((await getTask(fixture, taskId))['claimed_at'], claimedAt);
    assert.equal(roundOutcomes(fixture).length, outcomesBefore);
  } finally {
    await fixture.stop();
  }
});

test('auto_claim=0 or an unavailable Agent leaves the task in todo with no records and no wake', async () => {
  const disabled = await startFixture('allibot-claim-disabled-', 'reply', {
    env: { OPENAI_API_KEY: 'sk-claim-test' },
  });
  try {
    const agent = await createAgent(disabled, '不认领', { autoClaim: 0 });
    await confirmConsent(disabled);
    const channelId = await createChannel(disabled);
    await joinChannel(disabled, channelId, agent);

    const task = await createTask(disabled, channelId, '关闭认领');
    assert.equal(task['status'], 'todo');
    assert.equal(task['assignee_member_id'], null);
    assert.equal(task['claimed_at'], null);
    assert.equal(task['message_count'], 1, 'only the creation record exists');
    assert.deepEqual(roundOutcomes(disabled), [], 'no wake runs a round');
    assert.equal(budgetRow(disabled, task['target_id'] as string), undefined, 'no epoch opens');
  } finally {
    await disabled.stop();
  }

  // The availability half: the Agent is configured to claim but the provider's
  // remote-data-flow consent has never been confirmed, so it is offline (D1.12).
  const unavailable = await startFixture('allibot-claim-unavailable-', 'reply', {
    env: { OPENAI_API_KEY: 'sk-claim-test' },
  });
  try {
    const agent = await createAgent(unavailable, '未告知');
    const channelId = await createChannel(unavailable);
    await joinChannel(unavailable, channelId, agent);

    const task = await createTask(unavailable, channelId, '不可用');
    assert.equal(task['status'], 'todo');
    assert.equal(task['assignee_member_id'], null);
    assert.equal(task['claimed_at'], null);
    assert.equal(task['message_count'], 1);
    assert.deepEqual(roundOutcomes(unavailable), []);
    assert.equal(budgetRow(unavailable, task['target_id'] as string), undefined);
  } finally {
    await unavailable.stop();
  }
});

test('each continue_task grants a full-thread round; the fourth request pauses at four rounds per epoch', async () => {
  const fixture = await startFixture('allibot-continue-chain-', 'continue-task', {
    env: { OPENAI_API_KEY: 'sk-claim-test' },
  });
  try {
    const agent = await createAgent(fixture, '续跑者');
    await confirmConsent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const task = await createTask(fixture, channelId, '连续续跑');
    const taskId = task['id'] as string;
    const targetId = task['target_id'] as string;

    assert.equal(task['status'], 'in_progress');
    assert.equal(task['assignee_member_id'], agent);

    const thread = await listMessages(fixture, targetId);
    assert.deepEqual(
      thread.map((message) => message['kind']),
      [
        'system', // creation
        'system', // 已认领
        'system', // 认领后自动开工
        'agent', // round 1 (claim)
        'system', // continue 1
        'agent', // round 2
        'system', // continue 2
        'agent', // round 3
        'system', // continue 3
        'agent', // round 4
        'system', // continue_paused
      ],
      'four work rounds: the first plus three auto-continues, then the paused record',
    );

    const bodies = systemMessageBodies(thread);
    assert.equal(
      bodies.filter((body) => body.includes('自动续跑') && !body.includes('上限')).length,
      3,
      'three continue records were landed',
    );
    assert.equal(
      bodies.filter((body) => body.includes('上限')).length,
      1,
      'the fourth request lands exactly one paused record',
    );
    assert.match(bodies[bodies.length - 1]!, /续跑者/, 'the paused record names the assignee');

    const replies = agentReplies(thread);
    assert.equal(replies.length, 4, 'no fifth round runs after the pause');
    const reports = replies.map((message) => contextReport(String(message['body'])));
    assert.equal(reports[0]?.thread, 'window', 'the claim round reads the ordinary window');
    assert.equal(reports[0]?.ctx, 3);
    for (const [index, report] of reports.slice(1).entries()) {
      assert.equal(report.thread, 'full', 'every auto-continue round reads the whole task thread');
      // Round 2 reads messages 1..5, round 3 reads 1..7, round 4 reads 1..9.
      assert.equal(report.ctx, 5 + index * 2);
      assert.equal(report.ctxfirst, 1);
    }

    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 4, 'one round outcome per work round');
    assert.ok(outcomes.every((row) => row.status === 'replied'));
    assert.ok(outcomes.every((row) => row.member_id === agent));
    assert.ok(outcomes.every((row) => row.budget_consumed === 0), 'neither claim nor continue is a jump');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['wake.claim'].text));
    for (const row of outcomes.slice(1)) {
      assert.ok(row.reason.includes(ZH_CN['wake.continue'].text), row.reason);
      assert.ok(row.reason.includes(ZH_CN['round.mandatory.continue'].text), row.reason);
    }
    assert.ok(
      outcomes[3]?.reason.includes('到达本世代上限（4 轮）'),
      'the last round states that its continuation request hit the cap',
    );

    assert.deepEqual(
      budgetRow(fixture, targetId),
      { epoch_seq: 2, used: 0, limit_value: 3 },
      'claim and auto-continue never touch the jump count',
    );
    assert.equal((await getTask(fixture, taskId))['status'], 'in_progress');
  } finally {
    await fixture.stop();
  }
});

test('a normal task-thread round still reads the most recent 40 messages', async () => {
  const fixture = await startFixture('allibot-task-window-', 'reply', {
    env: { OPENAI_API_KEY: 'sk-claim-test' },
  });
  try {
    // auto_claim=0 keeps the seeding quiet: the 45 thread messages land before
    // the Agent is a member, and no claim turns the task into a work round.
    const agent = await createAgent(fixture, '窗口读者', { autoClaim: 0 });
    await confirmConsent(fixture);
    const channelId = await createChannel(fixture, '窗口频道');
    await joinChannel(fixture, channelId, agent);

    const task = await createTask(fixture, channelId, '窗口任务');
    const targetId = task['target_id'] as string;
    for (let index = 1; index <= 45; index += 1) {
      await postMessage(fixture, targetId, { body: `准备第 ${index} 条` });
    }

    const assigned = await patchJson(fixture, `/api/tasks/${task['id'] as string}`, {
      assignee_member_id: agent,
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());

    const trigger = await postMessage(fixture, targetId, { body: '请继续处理' });
    const triggerSeq = Number(trigger['seq']);
    const latest = agentReplies(await listMessages(fixture, targetId)).at(-1);
    assert.ok(latest !== undefined);
    const report = contextReport(String(latest['body']));
    assert.equal(report.thread, 'window');
    assert.equal(report.ctx, 40, 'a normal round keeps the 40-message window');
    assert.equal(report.ctxlast, triggerSeq);
    assert.equal(report.ctxfirst, triggerSeq - 39);
    assert.ok(report.ctxfirst > 1, 'the earliest messages are outside the window');
  } finally {
    await fixture.stop();
  }
});
