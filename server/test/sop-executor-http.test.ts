import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * SOP execution, verification and awaiting (#45 / D4.3 / D5.6), observed through
 * the one process seam: a real backend, the scripted double driving the
 * internal executor / verifier member rounds, the human REST endpoints, the
 * approval HITL face and the one global SSE stream.
 *
 * The suite never calls a private function. The scripted behaviours only choose
 * which production face a round calls, exactly like a model would.
 */

const FIXED_NOW = '2026-11-04T12:00:00.000Z';
const AGENT_MODEL = 'openai:gpt-5';

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  root: string;
  running: RunningServer;
  base: string;
  channelId: string;
  agentA: string;
  agentB: string;
  agentC: string;
  stop: () => Promise<void>;
}

interface StartOptions {
  behavior: string;
  args?: readonly string[];
  workspaceRoot?: boolean;
  team?: boolean;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  return {
    status: response.status,
    body:
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed },
  };
}

function openDatabase(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  return db;
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
}

const SIDE_EFFECT_TABLES = [
  'message',
  'message_mention',
  'target',
  'task',
  'team_run',
  'team_assignment',
  'round_outcome',
  'target_budget',
  'read_position',
  'agent_memory',
] as const;

function sideEffectCounts(dataDir: string): Record<string, number> {
  const db = openDatabase(dataDir);
  try {
    return Object.fromEntries(
      SIDE_EFFECT_TABLES.map((table) => [table, count(db, table)]),
    );
  } finally {
    db.close();
  }
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
  raw: string;
}

interface SseStream {
  next(predicate: (frame: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame | null>;
  frames(): SseFrame[];
  close(): void;
}

async function connectEvents(base: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body !== null);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  let closed = false;
  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const event = /^event:\s*(.+)$/m.exec(block)?.[1];
          const data = /^data:\s*(.+)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) {
            frames.push({ event, data: JSON.parse(data) as Record<string, unknown>, raw: block });
          }
        }
      }
    } catch {
      // The test closes the connection; that abort is not a failure.
    } finally {
      closed = true;
    }
  })();
  return {
    async next(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = frames.findIndex(predicate);
        if (index !== -1) {
          return frames.splice(index, 1)[0] ?? null;
        }
        if (closed || Date.now() >= deadline) {
          return null;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    frames: () => [...frames],
    close() {
      controller.abort();
      void pump;
    },
  };
}

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '步骤',
    description: '',
    executor_member_id: '',
    verifier_member_id: '',
    max_attempts: 2,
    ...overrides,
  };
}

async function startFixture(options: StartOptions): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), 'allibot-sop-executor-'));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const root = path.join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  writeFileSync(path.join(root, 'notes.txt'), 'SOP-ROOT-FILE\n', 'utf8');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const running = await startServer(dataDir, {
    env: { HOME: home, OPENAI_API_KEY: 'sk-sop-executor-test' },
    args: [
      '--scripted-provider',
      options.behavior,
      '--fixed-clock',
      FIXED_NOW,
      ...(options.args ?? []),
    ],
  });
  const base = `http://127.0.0.1:${running.port}`;
  const channelId = (await request(base, 'POST', '/api/channels', { name: 'SOP 执行频道' })).body[
    'id'
  ] as string;
  const agentA = (await request(base, 'POST', '/api/agents', {
    display_name: '执行者甲',
    model: AGENT_MODEL,
  })).body['id'] as string;
  const agentB = (await request(base, 'POST', '/api/agents', {
    display_name: '校验者乙',
    model: AGENT_MODEL,
  })).body['id'] as string;
  const agentC = (await request(base, 'POST', '/api/agents', {
    display_name: '队长丙',
    model: AGENT_MODEL,
  })).body['id'] as string;
  for (const memberId of [agentA, agentB, agentC]) {
    await request(base, 'POST', `/api/channels/${channelId}/members`, { member_id: memberId });
  }
  if (options.team === true) {
    const patched = await request(base, 'PATCH', `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: agentC,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }
  if (options.workspaceRoot !== false) {
    const patched = await request(base, 'PATCH', `/api/channels/${channelId}`, {
      workspace_root: root,
    });
    assert.equal(patched.status, 200, JSON.stringify(patched.body));
  }

  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    root,
    running,
    base,
    channelId,
    agentA,
    agentB,
    agentC,
    stop: async (): Promise<void> => {
      await fixture.running.stop();
      await removeTempDir(tmp);
    },
  };
  return fixture;
}

async function createDefinition(
  fixture: Fixture,
  options: { steps?: number; maxAttempts?: number; name?: string } = {},
): Promise<string> {
  const stepCount = options.steps ?? 2;
  const roles = [
    [fixture.agentA, fixture.agentB],
    [fixture.agentB, fixture.agentA],
  ];
  const steps = Array.from({ length: stepCount }, (_value, index) => {
    const [executor, verifier] = roles[index % roles.length]!;
    return step({
      title: `步骤${index + 1}`,
      description: `说明${index + 1}`,
      executor_member_id: executor,
      verifier_member_id: verifier,
      max_attempts: options.maxAttempts ?? 2,
    });
  });
  const created = await request(fixture.base, 'POST', '/api/sops', {
    channel_id: fixture.channelId,
    name: options.name ?? '执行流程',
    steps,
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['id'] as string;
}

async function startRun(fixture: Fixture, definitionId: string): Promise<Record<string, unknown>> {
  const started = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
  assert.equal(started.status, 202, JSON.stringify(started.body));
  return started.body;
}

async function readRun(fixture: Fixture, runId: string): Promise<Record<string, unknown>> {
  const response = await request(fixture.base, 'GET', `/api/sop-runs/${runId}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body;
}

async function listApprovals(
  fixture: Fixture,
  query = 'status=all',
): Promise<Record<string, unknown>[]> {
  const response = await request(fixture.base, 'GET', `/api/approvals?${query}`);
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body['approvals'] as Record<string, unknown>[];
}

async function waitForApproval(fixture: Fixture): Promise<Record<string, unknown>> {
  return await waitFor(
    () => listApprovals(fixture, 'status=pending'),
    (rows) => rows.length === 1,
    'the SOP approval to be pending',
  ).then((rows) => rows[0]!);
}

async function decide(
  fixture: Fixture,
  replyId: string,
  toolCallId: string,
  confirmed: boolean,
  rules?: Record<string, unknown>[],
): Promise<HttpResult> {
  return await request(fixture.base, 'POST', `/api/approvals/${replyId}`, {
    tool_call_id: toolCallId,
    confirmed,
    ...(rules === undefined ? {} : { rules }),
  });
}

async function restart(
  fixture: Fixture,
  args: readonly string[],
  behavior: string,
): Promise<void> {
  await fixture.running.crash();
  fixture.running = await startServer(fixture.dataDir, {
    env: { HOME: fixture.home, OPENAI_API_KEY: 'sk-sop-executor-test' },
    args: ['--scripted-provider', behavior, '--fixed-clock', FIXED_NOW, ...args],
  });
  fixture.base = `http://127.0.0.1:${fixture.running.port}`;
}

function stateOf(run: Record<string, unknown>): Record<string, unknown> {
  return run['state'] as Record<string, unknown>;
}

test('a two-step SOP runs executor then verifier per step and completes', async () => {
  const fixture = await startFixture({ behavior: 'sop-executor', team: true });
  const events = await connectEvents(fixture.base);
  try {
    const definitionId = await createDefinition(fixture);
    const before = sideEffectCounts(fixture.dataDir);
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    assert.equal(started['definition_id'], definitionId);
    assert.equal(started['phase'], 'pending');
    assert.equal(started['current_step'], 0);
    assert.equal(started['attempt'], 0);
    assert.equal(started['waiting_on'], null);
    assert.equal(started['finished_at'], null);
    assert.equal(started['started_at'], FIXED_NOW);
    const initialState = stateOf(started);
    assert.equal(initialState['current_step'], 0);
    assert.equal(initialState['attempt'], 0);
    assert.deepEqual(initialState['steps'], []);
    assert.equal(initialState['waiting_on'], null);
    assert.equal(initialState['error'], null);
    assert.equal(initialState['started_at'], FIXED_NOW);
    assert.equal(initialState['updated_at'], FIXED_NOW);
    assert.equal(initialState['finished_at'], null);

    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'completed' || run['phase'] === 'failed',
      'the SOP run to close',
    );
    assert.equal(finished['phase'], 'completed', JSON.stringify(finished));
    assert.equal(finished['current_step'], 2);
    assert.equal(finished['attempt'], 1);
    assert.equal(finished['waiting_on'], null);
    assert.equal(finished['finished_at'], FIXED_NOW);

    const state = stateOf(finished);
    assert.equal(state['current_step'], 2);
    assert.equal(state['attempt'], 1);
    assert.equal(state['waiting_on'], null);
    assert.equal(state['error'], null);
    assert.equal(state['started_at'], FIXED_NOW);
    assert.equal(state['updated_at'], FIXED_NOW);
    assert.equal(state['finished_at'], FIXED_NOW);
    const steps = state['steps'] as Record<string, unknown>[];
    assert.equal(steps.length, 2, 'one snapshot entry per definition step');
    assert.equal(steps[0]?.['index'], 0);
    assert.equal(steps[0]?.['title'], '步骤1');
    assert.match(String(steps[0]?.['executor_excerpt']), /SOP-EXEC:0:1/);
    assert.match(String(steps[0]?.['verifier_excerpt']), /SOP-VERIFY:PASS:0:1/);
    assert.match(
      String(steps[0]?.['verifier_excerpt']),
      /SAW:SOP-EXEC:0:1/,
      'the executor text is the verifier round input',
    );
    assert.equal(steps[0]?.['verifier_verdict'], 'pass');
    assert.equal(steps[1]?.['index'], 1);
    assert.match(String(steps[1]?.['executor_excerpt']), /SOP-EXEC:1:1/);
    assert.match(String(steps[1]?.['verifier_excerpt']), /SOP-VERIFY:PASS:1:1/);

    // The one global stream carries pending -> running -> awaiting -> running ->
    // awaiting -> completed, with every required field; no second connection.
    const completedFrame = await events.next(
      (frame) => frame.event === 'sop_update' && frame.data['phase'] === 'completed',
      3_000,
    );
    assert.ok(completedFrame !== null, 'the stream carries the completed sop_update');
    const frames = [
      ...events.frames().filter(
        (frame) => frame.event === 'sop_update' && frame.data['sop_run_id'] === runId,
      ),
    ];
    // The next() call above removed the completed frame; collect it back.
    frames.push(completedFrame);
    const phases = frames.map((frame) => frame.data['phase']);
    assert.deepEqual(phases, ['pending', 'running', 'awaiting', 'running', 'awaiting', 'completed']);
    assert.deepEqual(
      frames.map((frame) => frame.data['current_step']),
      [0, 0, 0, 1, 1, 2],
    );
    assert.deepEqual(
      frames.map((frame) => frame.data['attempt']),
      [0, 1, 1, 1, 1, 1],
    );
    for (const frame of frames) {
      assert.equal(frame.data['sop_run_id'], runId);
      assert.equal(frame.data['definition_id'], definitionId);
      assert.equal(typeof frame.data['phase'], 'string');
      assert.equal(typeof frame.data['current_step'], 'number');
      assert.equal(typeof frame.data['attempt'], 'number');
      assert.equal(frame.data['occurred_at'], FIXED_NOW);
      assert.equal('target_id' in frame.data, false, 'sop_update is not a target frame');
    }

    // SOP internal rounds are not target rounds: no message, target, task,
    // team run / assignment, round outcome, unread, memory or budget fact.
    assert.deepEqual(sideEffectCounts(fixture.dataDir), before);
    const channelMessages = await request(
      fixture.base,
      'GET',
      `/api/targets/${fixture.channelId}/messages`,
    );
    assert.equal(channelMessages.status, 200);
    assert.deepEqual(channelMessages.body['messages'], []);

    const listed = await request(fixture.base, 'GET', `/api/sops/${definitionId}/runs`);
    assert.equal(listed.status, 200);
    assert.equal((listed.body['runs'] as Record<string, unknown>[]).length, 1);
    assert.equal(
      (await request(fixture.base, 'GET', '/api/sop-runs/does-not-exist')).status,
      404,
    );

    const db = openDatabase(fixture.dataDir);
    try {
      assert.equal(count(db, 'team_run'), 0, 'SOP is not a team pipeline');
      assert.equal(count(db, 'team_assignment'), 0);
      assert.equal(count(db, 'approval_request'), 0);
    } finally {
      db.close();
    }
  } finally {
    events.close();
    await fixture.stop();
  }
});

test('a verifier fail retries the same step and exhausts max_attempts into a failed run', async () => {
  const fixture = await startFixture({ behavior: 'sop-verifier' });
  try {
    const definitionId = await createDefinition(fixture, { steps: 2, maxAttempts: 2 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'failed',
      'the retried SOP run to fail',
    );
    assert.equal(finished['current_step'], 0, 'the failing step does not advance');
    assert.equal(finished['attempt'], 2);
    assert.equal(finished['waiting_on'], null);
    const state = stateOf(finished);
    assert.equal(state['current_step'], 0);
    assert.equal(state['attempt'], 2);
    const steps = state['steps'] as Record<string, unknown>[];
    assert.equal(steps.length, 1, 'the next step never starts');
    assert.equal(steps[0]?.['attempts'], 2);
    assert.equal(steps[0]?.['verifier_verdict'], 'fail');
    assert.match(String(steps[0]?.['executor_excerpt']), /SOP-EXEC:0:2/);
    assert.match(String(steps[0]?.['verifier_excerpt']), /SOP-VERIFY:FAIL:0:2/);
    const error = String(state['error']);
    assert.match(error, /SOP-VERIFY:FAIL:0:2/, 'reason is the last verifier readable text');
  } finally {
    await fixture.stop();
  }
});

test('an SOP tool ask pauses awaiting approval, approve resumes and lands the write', async () => {
  const fixture = await startFixture({ behavior: 'sop-approval' });
  const events = await connectEvents(fixture.base);
  try {
    const definitionId = await createDefinition(fixture, { steps: 1 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const approval = await waitForApproval(fixture);
    assert.equal(approval['context_kind'], 'sop');
    assert.equal(approval['context_id'], runId);
    assert.equal(approval['target_id'], null, 'a SOP approval has no target');
    assert.equal(approval['status'], 'pending');
    const replyId = String(approval['reply_id']);
    assert.ok(replyId.length > 0);
    const calls = approval['tool_calls'] as Record<string, unknown>[];
    assert.equal(calls.length, 1);
    const toolCallId = String(calls[0]?.['tool_call_id']);
    assert.equal(calls[0]?.['tool_name'], 'Write');
    assert.equal(calls[0]?.['pattern'], 'sop-approval.txt');
    assert.equal(JSON.stringify(approval).includes('written-by-sop-approval'), true);

    const waiting = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'awaiting',
      'the run to await the approval',
    );
    assert.equal(waiting['waiting_on'], 'approval');
    assert.equal(waiting['attempt'], 1);
    await waitFor(
      async () => events.frames(),
      (frames) =>
        frames.some(
          (frame) =>
            frame.event === 'sop_update' &&
            frame.data['sop_run_id'] === runId &&
            frame.data['phase'] === 'awaiting',
        ),
      'the stream to announce awaiting',
    );

    const decided = await decide(fixture, replyId, toolCallId, true, [
      { tool_name: 'Write', pattern: 'sop-approval.txt', behavior: 'allow' },
    ]);
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body['status'], 'confirmed');

    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'completed',
      'the approved run to complete',
    );
    assert.equal(finished['waiting_on'], null);
    const state = stateOf(finished);
    const steps = state['steps'] as Record<string, unknown>[];
    assert.match(String(steps[0]?.['executor_excerpt']), /\[sop-approval\] write:ok/);
    assert.match(String(steps[0]?.['verifier_excerpt']), /verifier:pass/);
    assert.equal(
      readFileSync(path.join(fixture.root, 'sop-approval.txt'), 'utf8'),
      'written-by-sop-approval',
    );

    // `rules?` on a SOP approval replaces the definition channel's rule set:
    // the #44 note's "SOP has no rule scope" 400 is wired to the channel.
    const rules = await request(
      fixture.base,
      'GET',
      `/api/channels/${fixture.channelId}/permission-rules`,
    );
    assert.equal(rules.status, 200);
    const storedRules = rules.body['rules'] as Record<string, unknown>[];
    assert.deepEqual(
      storedRules.map((rule) => [rule['tool_name'], rule['pattern'], rule['behavior']]),
      [['Write', 'sop-approval.txt', 'allow']],
    );

    const frames = events.frames().filter(
      (frame) => frame.event === 'sop_update' && frame.data['sop_run_id'] === runId,
    );
    const phases = frames.map((frame) => frame.data['phase']);
    assert.deepEqual(phases.slice(0, 3), ['pending', 'running', 'awaiting']);
    assert.ok(
      phases.indexOf('running', 3) !== -1,
      'approval settling returns the run to running',
    );
  } finally {
    events.close();
    await fixture.stop();
  }
});

test('a denied SOP tool ask returns DENIED and the run continues to completion', async () => {
  const fixture = await startFixture({ behavior: 'sop-approval' });
  try {
    const definitionId = await createDefinition(fixture, { steps: 1 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const approval = await waitForApproval(fixture);
    const calls = approval['tool_calls'] as Record<string, unknown>[];
    const decided = await decide(
      fixture,
      String(approval['reply_id']),
      String(calls[0]?.['tool_call_id']),
      false,
    );
    assert.equal(decided.status, 200, JSON.stringify(decided.body));
    assert.equal(decided.body['status'], 'denied');

    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'completed' || run['phase'] === 'failed',
      'the denied run to settle',
    );
    assert.equal(finished['phase'], 'completed', 'DENIED does not fail the run');
    const steps = stateOf(finished)['steps'] as Record<string, unknown>[];
    assert.match(String(steps[0]?.['executor_excerpt']), /\[sop-approval\] write:error:denied/);
    assert.equal(steps[0]?.['verifier_verdict'], 'pass');
    assert.equal(existsSync(path.join(fixture.root, 'sop-approval.txt')), false);
    const stored = await listApprovals(fixture);
    assert.equal(stored[0]?.['status'], 'denied');
  } finally {
    await fixture.stop();
  }
});

test('an approval timeout closes the SOP run failed with the readable timeout reason', async () => {
  const fixture = await startFixture({
    behavior: 'sop-approval',
    args: ['--approval-timeout-ms', '200'],
  });
  try {
    const definitionId = await createDefinition(fixture, { steps: 1 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'failed',
      'the timed-out SOP run to fail',
    );
    assert.match(String(stateOf(finished)['error']), /审批等待超时/);
    const stored = await listApprovals(fixture);
    assert.equal(stored.length, 1);
    assert.equal(stored[0]?.['status'], 'failed');
    assert.equal(existsSync(path.join(fixture.root, 'sop-approval.txt')), false);
  } finally {
    await fixture.stop();
  }
});

test('a restart closes an awaiting SOP run failed/interrupted and expires its approval', async () => {
  const fixture = await startFixture({ behavior: 'sop-approval' });
  try {
    const definitionId = await createDefinition(fixture, { steps: 1 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const approval = await waitForApproval(fixture);
    await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'awaiting',
      'the run to await approval before the crash',
    );

    await restart(fixture, [], 'sop-approval');

    const failed = await readRun(fixture, runId);
    assert.equal(failed['phase'], 'failed');
    assert.match(String(stateOf(failed)['error']), /interrupted/);
    assert.equal(failed['waiting_on'], null);
    assert.equal(failed['finished_at'], FIXED_NOW);
    const expired = await request(
      fixture.base,
      'GET',
      `/api/approvals/${String(approval['reply_id'])}`,
    );
    assert.equal(expired.status, 200);
    assert.equal(expired.body['status'], 'expired');
    assert.equal((await listApprovals(fixture, 'status=pending')).length, 0);

    // No replay across the restart: the run stays failed and no step runs again.
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    const stillFailed = await readRun(fixture, runId);
    assert.equal(stillFailed['phase'], 'failed');
    assert.equal((stillFailed['state'] as Record<string, unknown>)['attempt'], 1);
    assert.equal(existsSync(path.join(fixture.root, 'sop-approval.txt')), false);
  } finally {
    await fixture.stop();
  }
});

test('a restart closes a running SOP run failed/interrupted without replaying steps', async () => {
  const fixture = await startFixture({
    behavior: 'delay',
    args: ['--scripted-delay-ms', '5000'],
  });
  try {
    const definitionId = await createDefinition(fixture, { steps: 2 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'running',
      'the run to be running before the crash',
    );
    await restart(fixture, ['--scripted-delay-ms', '5000'], 'delay');
    const failed = await readRun(fixture, runId);
    assert.equal(failed['phase'], 'failed');
    assert.match(String(stateOf(failed)['error']), /interrupted/);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal((await readRun(fixture, runId))['phase'], 'failed');
  } finally {
    await fixture.stop();
  }
});

test('new run creation keeps the latest 50 runs and 90 days of retention; definitions stay', async () => {
  const fixture = await startFixture({ behavior: 'sop-verifier' });
  try {
    // 90-day rule: one recent + one old run, then a new start prunes the old one.
    const agedDefinition = await createDefinition(fixture, {
      steps: 1,
      maxAttempts: 1,
      name: '旧运行流程',
    });
    const first = await startRun(fixture, agedDefinition);
    await waitFor(
      () => readRun(fixture, String(first['id'])),
      (run) => run['phase'] === 'failed',
      'the recent run to close',
    );
    const db = openDatabase(fixture.dataDir);
    try {
      db.prepare(
        `INSERT INTO sop_run
           (id, definition_id, channel_id, phase, state, current_step, started_at, updated_at,
            finished_at)
         VALUES ('old-sop-run', ?, ?, 'failed', ?, 0, ?, ?, ?)`,
      ).run(
        agedDefinition,
        fixture.channelId,
        JSON.stringify({
          current_step: 0,
          attempt: 1,
          steps: [],
          waiting_on: null,
          error: 'old',
          started_at: '2026-06-01T00:00:00.000Z',
          updated_at: '2026-06-01T00:00:00.000Z',
          finished_at: '2026-06-01T00:00:00.000Z',
        }),
        '2026-06-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
        '2026-06-01T00:00:00.000Z',
      );
    } finally {
      db.close();
    }
    const second = await startRun(fixture, agedDefinition);
    await waitFor(
      () => readRun(fixture, String(second['id'])),
      (run) => run['phase'] === 'failed',
      'the second recent run to close',
    );
    const agedRuns = await request(
      fixture.base,
      'GET',
      `/api/sops/${agedDefinition}/runs?limit=50`,
    );
    const agedIds = (agedRuns.body['runs'] as Record<string, unknown>[]).map((run) => run['id']);
    assert.equal(agedIds.includes('old-sop-run'), false, 'a run older than 90 days is pruned');
    assert.equal(agedIds.length, 2);

    // 50-run rule: the 51st start prunes the oldest of the newest 50.
    const countedDefinition = await createDefinition(fixture, {
      steps: 1,
      maxAttempts: 1,
      name: '计数流程',
    });
    for (let index = 0; index < 50; index += 1) {
      const run = await startRun(fixture, countedDefinition);
      await waitFor(
        () => readRun(fixture, String(run['id'])),
        (value) => value['phase'] === 'failed',
        `run ${index + 1} to close`,
      );
    }
    const latest = await startRun(fixture, countedDefinition);
    await waitFor(
      () => readRun(fixture, String(latest['id'])),
      (run) => run['phase'] === 'failed',
      'the 51st run to close',
    );
    const retained = openDatabase(fixture.dataDir);
    try {
      assert.equal(
        (retained
          .prepare('SELECT count(*) AS total FROM sop_run WHERE definition_id = ?')
          .get(countedDefinition) as { total: number }).total,
        50,
      );
      assert.equal(
        (retained
          .prepare('SELECT count(*) AS total FROM sop_definition WHERE id = ?')
          .get(countedDefinition) as { total: number }).total,
        1,
        'retention never deletes the definition',
      );
    } finally {
      retained.close();
    }
    assert.equal(
      (await request(fixture.base, 'DELETE', `/api/sops/${countedDefinition}`)).status,
      404,
      'M2 has no definition delete endpoint',
    );
    assert.equal(
      (await request(fixture.base, 'DELETE', `/api/sop-runs/${String(latest['id'])}`)).status,
      404,
      'M2 has no run delete endpoint',
    );
  } finally {
    await fixture.stop();
  }
});

test('a verifier prose that says pass without sopVerdict never advances the step', async () => {
  const fixture = await startFixture({
    behavior: 'reply',
    args: ['--scripted-reply', 'PASS 看起来通过了，但这不是结构化判定'],
  });
  try {
    const definitionId = await createDefinition(fixture, { steps: 1, maxAttempts: 1 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'failed',
      'the prose-only verifier run to fail',
    );
    const error = String(stateOf(finished)['error']);
    assert.match(error, /未返回结构化 sopVerdict/);
    assert.equal(finished['current_step'], 0, 'prose never advances the step');
    assert.equal(finished['attempt'], 1);
  } finally {
    await fixture.stop();
  }
});

test('awaiting exposes waiting_on=verifier while the verifier round is delayed', async () => {
  const fixture = await startFixture({
    behavior: 'delay',
    args: ['--scripted-delay-ms', '400'],
  });
  try {
    const definitionId = await createDefinition(fixture, { steps: 1, maxAttempts: 1 });
    const started = await startRun(fixture, definitionId);
    const runId = String(started['id']);
    const awaiting = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'awaiting',
      'the run to await the verifier verdict',
    );
    assert.equal(awaiting['waiting_on'], 'verifier');
    assert.equal(awaiting['attempt'], 1);
    const finished = await waitFor(
      () => readRun(fixture, runId),
      (run) => run['phase'] === 'failed',
      'the delayed prose-only verifier to fail',
    );
    assert.match(String(stateOf(finished)['error']), /未返回结构化 sopVerdict/);
  } finally {
    await fixture.stop();
  }
});
