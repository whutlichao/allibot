import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '../../shared/dist/index.js';
import {
  removeTempDir,
  REPO_ROOT,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * M2 端到端集成 (#50 / T20): every scenario runs against one real backend
 * process through its HTTP face only — the human REST routes, the CopilotKit
 * handler and the one global SSE stream. The provider, clock, Docker CLI and
 * HOME are startup injections; the data directory, HOME and project root are
 * temp directories removed at the end of every test. No scenario reads a
 * private module or opens a second seam.
 */

const FIXED_NOW = '2026-11-04T00:00:00.000Z';
const RUN_PATH = '/api/copilotkit/agent/allibot/run';
const AGENT_MODEL = 'openai:gpt-5';
const MCP_SERVER = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'mcp-server.mjs');

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  projectRoot: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface FixtureOptions {
  behavior: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Create the project-root fixture (notes / sub / escape symlink / outside). */
  projectRoot?: boolean;
  /** Create HOME and the data dir but leave migration to the caller. */
  skipMigrate?: boolean;
}

async function startFixture(prefix: string, options: FixtureOptions): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const projectRoot = path.join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  if (options.projectRoot === true) {
    mkdirSync(path.join(projectRoot, 'sub'), { recursive: true });
    writeFileSync(path.join(projectRoot, 'notes.txt'), 'ROOT-NOTE\nNEEDLE inside\n', 'utf8');
    mkdirSync(path.join(tmp, 'outside'), { recursive: true });
    writeFileSync(path.join(tmp, 'outside', 'outside.txt'), 'OUTSIDE\n', 'utf8');
    writeFileSync(path.join(tmp, 'outside.txt'), 'OUTSIDE-ROOT\n', 'utf8');
    symlinkSync(path.join(tmp, 'outside'), path.join(projectRoot, 'escape'));
  } else {
    mkdirSync(projectRoot, { recursive: true });
  }
  if (options.skipMigrate !== true) {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  }
  const running = await startServer(dataDir, {
    env: { HOME: home, OPENAI_API_KEY: 'sk-m2-e2e', ...options.env },
    args: [
      '--scripted-provider',
      options.behavior,
      '--fixed-clock',
      FIXED_NOW,
      ...(options.args ?? []),
    ],
  });
  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    projectRoot,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async (): Promise<void> => {
      await fixture.running.stop();
      await removeTempDir(tmp);
      assert.equal(existsSync(tmp), false, 'the temporary data dir / HOME root is gone');
    },
  };
  return fixture;
}

async function restartFixture(
  fixture: Fixture,
  options: { behavior: string; args?: readonly string[]; env?: NodeJS.ProcessEnv },
): Promise<void> {
  await fixture.running.stop();
  fixture.running = await startServer(fixture.dataDir, {
    env: { HOME: fixture.home, OPENAI_API_KEY: 'sk-m2-e2e', ...options.env },
    args: [
      '--scripted-provider',
      options.behavior,
      '--fixed-clock',
      FIXED_NOW,
      ...(options.args ?? []),
    ],
  });
  fixture.base = `http://127.0.0.1:${fixture.running.port}`;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  text: string;
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
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return { status: response.status, body: parsed as Record<string, unknown>, text };
}

async function ok(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const result = await request(base, method, route, body);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${method} ${route} -> ${result.status}: ${result.text}`,
  );
  return result.body;
}

async function getJson(base: string, route: string): Promise<Record<string, unknown>> {
  return await ok(base, 'GET', route);
}

async function createChannel(base: string, name: string): Promise<string> {
  const created = await ok(base, 'POST', '/api/channels', {
    name,
    description: '',
    response_budget_limit: 10,
  });
  return created['id'] as string;
}

async function createAgent(
  base: string,
  displayName: string,
  extra: Record<string, unknown> = {},
): Promise<string> {
  const created = await ok(base, 'POST', '/api/agents', {
    display_name: displayName,
    model: AGENT_MODEL,
    auto_claim: 0,
    ...extra,
  });
  return created['id'] as string;
}

async function joinChannel(base: string, channelId: string, memberId: string): Promise<void> {
  await ok(base, 'POST', `/api/channels/${channelId}/members`, { member_id: memberId });
}

async function consentModel(base: string): Promise<void> {
  await ok(base, 'POST', '/api/remote-data-flow/openai/consent', {});
}

async function makeTeam(base: string, channelId: string, leaderId: string): Promise<void> {
  await ok(base, 'PATCH', `/api/channels/${channelId}`, {
    mode: 'team',
    team_leader_member_id: leaderId,
  });
}

async function listMessages(
  base: string,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const body = await getJson(base, `/api/targets/${targetId}/messages`);
  return body['messages'] as Record<string, unknown>[];
}

function openDatabase(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true, timeout: 2_000 });
}

function queryAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function queryOne<T>(db: Database.Database, sql: string, params: unknown[] = []): T | undefined {
  return queryAll<T>(db, sql, params)[0];
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (done(last)) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

// --- the one global SSE stream -------------------------------------------------

interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly lines: readonly string[];
  readonly raw: string;
}

function parseFrame(raw: string): SseFrame {
  const lines = raw.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event: '));
  const dataLines = lines.filter((line) => line.startsWith('data: '));
  return {
    event: eventLine === undefined ? '' : eventLine.slice('event: '.length),
    data: dataLines.map((line) => line.slice('data: '.length)).join('\n'),
    lines,
    raw,
  };
}

/** A real fetch subscription; reads frames and exposes the server close. */
class SseConnection {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly frames: SseFrame[] = [];
  private readonly waiting: Array<{
    resolve: (frame: SseFrame | null) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closed = false;
  private failure: Error | null = null;
  private readonly abort: AbortController;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly response: Response;

  private constructor(
    abort: AbortController,
    reader: ReadableStreamDefaultReader<Uint8Array>,
    response: Response,
  ) {
    this.abort = abort;
    this.reader = reader;
    this.response = response;
    void this.pump();
  }

  static async open(url: string): Promise<SseConnection> {
    const abort = new AbortController();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    assert.ok(response.body !== null, 'the subscription should carry a body stream');
    return new SseConnection(abort, response.body.getReader(), response);
  }

  async next(timeoutMs = 5_000): Promise<SseFrame | null> {
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    if (this.closed) {
      return this.failure === null ? null : await Promise.reject(this.failure);
    }
    return await new Promise<SseFrame | null>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.findIndex((waiter) => waiter.timer === timer);
        if (index !== -1) {
          this.waiting.splice(index, 1);
        }
        reject(new Error(`no SSE frame within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiting.push({ resolve, reject, timer });
    });
  }

  async close(): Promise<void> {
    this.abort.abort();
    try {
      await this.reader.cancel();
    } catch {
      // already gone
    }
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader.read();
        if (done) {
          break;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        let boundary = this.buffer.indexOf('\n\n');
        while (boundary !== -1) {
          this.frames.push(parseFrame(this.buffer.slice(0, boundary)));
          this.buffer = this.buffer.slice(boundary + 2);
          boundary = this.buffer.indexOf('\n\n');
        }
        this.settle();
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.closed = true;
    this.settle();
  }

  private settle(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting[0]!;
      const frame = this.frames.shift();
      if (frame !== undefined) {
        this.waiting.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        continue;
      }
      if (this.closed) {
        this.waiting.shift();
        clearTimeout(waiter.timer);
        if (this.failure === null) {
          waiter.resolve(null);
        } else {
          waiter.reject(this.failure);
        }
        continue;
      }
      return;
    }
  }
}

async function nextOfType(
  stream: SseConnection,
  type: string,
  timeoutMs = 5_000,
): Promise<SseFrame> {
  for (;;) {
    const frame = await stream.next(timeoutMs);
    assert.ok(frame !== null, `the connection closed while waiting for ${type}`);
    if (frame.event === type) {
      return frame;
    }
  }
}

function assertNoEventId(frame: SseFrame): void {
  assert.equal(
    frame.lines.some((line) => line.startsWith('id:')),
    false,
    `the stream must not carry an id: line; got:\n${frame.raw}`,
  );
}

async function drain(stream: SseConnection, timeoutMs = 250): Promise<SseFrame[]> {
  const frames: SseFrame[] = [];
  for (;;) {
    try {
      const frame = await stream.next(timeoutMs);
      if (frame === null) {
        return frames;
      }
      frames.push(frame);
    } catch {
      return frames;
    }
  }
}

// --- the CopilotKit handler's AG-UI stream ------------------------------------

interface AguiEvent {
  type: string;
  [key: string]: unknown;
}

interface AguiStream {
  rest(): Promise<AguiEvent[]>;
  close(): Promise<void>;
}

function openAguiStream(response: Response): AguiStream {
  assert.ok(response.body !== null, 'the run response should carry a body stream');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const queue: AguiEvent[] = [];
  let buffer = '';
  let ended = false;

  const fill = async (): Promise<void> => {
    while (queue.length === 0 && !ended) {
      const chunk = await reader.read();
      if (chunk.done) {
        ended = true;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        for (const line of frame.split('\n')) {
          if (line.startsWith('data: ')) {
            queue.push(JSON.parse(line.slice('data: '.length)) as AguiEvent);
          }
        }
        boundary = buffer.indexOf('\n\n');
      }
    }
  };

  return {
    async rest(): Promise<AguiEvent[]> {
      const collected: AguiEvent[] = [];
      for (;;) {
        while (queue.length > 0) {
          collected.push(queue.shift()!);
        }
        if (ended) {
          return collected;
        }
        await fill();
      }
    },
    async close(): Promise<void> {
      await reader.cancel().catch(() => undefined);
    },
  };
}

async function runAgent(
  base: string,
  threadId: string,
  runId: string,
  content: string,
): Promise<AguiEvent[]> {
  const response = await fetch(`${base}${RUN_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
    body: JSON.stringify({
      threadId,
      runId,
      messages: [{ id: `client-${runId}`, role: 'user', content }],
    }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);
  const stream = openAguiStream(response);
  try {
    return await stream.rest();
  } finally {
    await stream.close();
  }
}

function eventTypes(events: readonly AguiEvent[]): string[] {
  return events.map((event) => event.type);
}

function textGroups(events: readonly AguiEvent[]): { messageId: string; contents: string[] }[] {
  const groups: { messageId: string; contents: string[] }[] = [];
  for (const event of events) {
    if (event.type === 'TEXT_MESSAGE_START') {
      groups.push({ messageId: event['messageId'] as string, contents: [] });
    } else if (event.type === 'TEXT_MESSAGE_CONTENT') {
      groups[groups.length - 1]?.contents.push(event['delta'] as string);
    }
  }
  return groups;
}

test('team opt-in: an owner message wakes only the leader, the final reply lands, and the M1 workspace readings stay', async () => {
  const fixture = await startFixture('allibot-m2-e2e-team-channel-', {
    behavior: 'reply',
    args: ['--scripted-reply', '队长收到'],
  });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 集成频道');
    const leaderId = await createAgent(fixture.base, '队长');
    const memberId = await createAgent(fixture.base, '成员');
    await joinChannel(fixture.base, channelId, leaderId);
    await joinChannel(fixture.base, channelId, memberId);
    await consentModel(fixture.base);
    await drain(events);

    const patched = await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leaderId,
    });
    assert.equal(patched['mode'], 'team');
    const team = patched['team'] as Record<string, unknown>;
    assert.equal(team['leader_member_id'], leaderId);
    assert.equal(team['status'], 'valid');

    // 团队配置变化复用 workspace.changed (D2.5): source='team', not a new frame.
    const changed = await nextOfType(events, 'workspace.changed');
    assert.deepEqual(JSON.parse(changed.data), { source: 'team' });
    assertNoEventId(changed);

    const agui = await runAgent(fixture.base, channelId, 'run-m2-team-1', '队长在吗');
    const kinds = eventTypes(agui);
    assert.equal(kinds[0], 'RUN_STARTED');
    assert.equal(kinds[1], 'STATE_SNAPSHOT');
    assert.equal(kinds[kinds.length - 1], 'RUN_FINISHED');
    assert.equal(kinds.includes('RUN_ERROR'), false, `unexpected RUN_ERROR: ${kinds.join(',')}`);
    const snapshot = agui[1]?.['snapshot'] as {
      target_id?: string;
      members?: { member_id: string }[];
    };
    assert.equal(snapshot.target_id, channelId);
    assert.ok((snapshot.members ?? []).some((member) => member.member_id === leaderId));

    // One text group, authored by the leader; the member never speaks.
    const groups = textGroups(agui);
    assert.equal(groups.length, 1, `one leader reply group; got ${groups.length}`);
    assert.deepEqual(groups[0]?.contents, ['队长收到']);
    const rows = await listMessages(fixture.base, channelId);
    assert.equal(rows.length, 2, `human + one leader reply; got ${rows.length}`);
    const reply = rows.find((row) => row['kind'] === 'agent');
    assert.equal(reply?.['author_member_id'], leaderId);
    assert.equal(rows.some((row) => row['author_member_id'] === memberId), false);
    assert.equal(groups[0]?.messageId, reply?.['id']);

    // The leader's team round is a run record; the channel-target run has no task.
    const runs = (await getJson(fixture.base, `/api/targets/${channelId}/team-runs`))[
      'team_runs'
    ] as Record<string, unknown>[];
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.['status'], 'completed');
    assert.equal(runs[0]?.['task_id'], null);
    assert.equal(runs[0]?.['leader_member_id'], leaderId);
    assert.equal(runs[0]?.['target_id'], channelId);

    // M1 regression: GET /api/workspace keeps its old fields and gains the M2 facts.
    const workspace = await getJson(fixture.base, '/api/workspace');
    for (const key of [
      'owner',
      'agents',
      'channels',
      'dms',
      'tasks',
      'unread_total',
      'settings',
      'status_points',
      'pending_approvals',
      'workspace_runtime',
    ]) {
      assert.ok(Object.hasOwn(workspace, key), `GET /api/workspace is missing ${key}`);
    }
    const channel = (workspace['channels'] as Record<string, unknown>[]).find(
      (row) => row['id'] === channelId,
    );
    assert.ok(channel !== undefined);
    for (const key of [
      'id',
      'name',
      'description',
      'mode',
      'team',
      'workspace',
      'permission_mode',
      'response_budget_limit',
      'archived_at',
      'deleted_at',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(Object.hasOwn(channel, key), `channel reading is missing ${key}`);
    }
    assert.equal(channel['mode'], 'team');
    assert.equal((channel['workspace'] as Record<string, unknown>)['backend'], 'local');
    const runtime = workspace['workspace_runtime'] as Record<string, unknown>;
    const docker = runtime['docker'] as Record<string, unknown>;
    assert.equal(docker['available'], false, 'the injected fake runtime reports no real daemon');
    assert.equal(typeof docker['image'], 'string');
    assert.equal(workspace['pending_approvals'], 0);

    // The stream is live-only: a connection opened after the facts receives no backlog.
    await events.close();
    const late = await SseConnection.open(`${fixture.base}/api/events`);
    try {
      assert.deepEqual(await drain(late, 250), [], 'a new subscription gets no replayed frames');
    } finally {
      await late.close();
    }
  } finally {
    await events.close().catch(() => undefined);
    await fixture.stop();
  }
});

test('team tasks: create, owner reassignment and an Agent transfer wake the leader, who TeamAssigns; runs and frames agree', async () => {
  const fixture = await startFixture('allibot-m2-e2e-team-tasks-', { behavior: 'reply' });
  try {
    const channelId = await createChannel(fixture.base, 'M2 任务频道');
    const leaderId = await createAgent(fixture.base, '队长');
    const memberA = await createAgent(fixture.base, '成员甲');
    const memberB = await createAgent(fixture.base, '成员乙');
    await joinChannel(fixture.base, channelId, leaderId);
    await joinChannel(fixture.base, channelId, memberA);
    await joinChannel(fixture.base, channelId, memberB);
    await consentModel(fixture.base);
    await makeTeam(fixture.base, channelId, leaderId);

    await restartFixture(fixture, {
      behavior: 'team-assign',
      args: [
        '--scripted-team-assign-member',
        memberA,
        '--scripted-team-assign-instruction',
        '请处理任务线程。',
        '--scripted-team-member-transfer',
        memberB,
      ],
    });
    const events = await SseConnection.open(`${fixture.base}/api/events`);
    try {
      const created = await ok(fixture.base, 'POST', '/api/tasks', {
        channel_id: channelId,
        title: 'M2 集成任务',
      });
      const taskId = created['id'] as string;
      const taskTargetId = created['target_id'] as string;

      // 建任务: one leader round, one TeamAssign, one final team_assignment frame.
      const firstFrame = JSON.parse(
        (await nextOfType(events, 'team_assignment')).data,
      ) as Record<string, unknown>;
      assert.equal(firstFrame['target_id'], taskTargetId);
      assert.equal(firstFrame['task_id'], taskId);
      assert.equal(firstFrame['member_id'], memberA);
      assert.equal(firstFrame['state'], 'completed');
      assert.equal(firstFrame['jump_consumed'], 1);
      assert.equal(typeof firstFrame['team_run_id'], 'string');
      assert.equal(typeof firstFrame['assignment_id'], 'string');
      assert.equal(typeof firstFrame['reply_excerpt'], 'string');
      assert.match(String(firstFrame['occurred_at']), /^\d{4}-\d{2}-\d{2}T/);

      let runs = (await getJson(fixture.base, `/api/targets/${taskTargetId}/team-runs`))[
        'team_runs'
      ] as Record<string, unknown>[];
      assert.equal(runs.length, 1, 'the create trigger opened exactly one leader run');
      assert.equal(runs[0]?.['status'], 'completed');
      assert.equal(runs[0]?.['task_id'], taskId);
      assert.equal(runs[0]?.['leader_member_id'], leaderId);
      const firstAssignment = (runs[0]?.['assignments'] as Record<string, unknown>[])[0];
      assert.equal(firstAssignment?.['id'], firstFrame['assignment_id']);
      assert.equal(firstAssignment?.['state'], 'completed');

      // 改派: the owner write lands a system record, wakes the leader with
      // team-change, and the leader's assignment sub-round transfers the task.
      const reassign = await ok(fixture.base, 'PATCH', `/api/tasks/${taskId}`, {
        assignee_member_id: memberA,
      });
      assert.equal(reassign['assignee_member_id'], memberA);

      const reassignFrame = JSON.parse(
        (await nextOfType(events, 'team_assignment')).data,
      ) as Record<string, unknown>;
      const transferFrame = JSON.parse(
        (await nextOfType(events, 'team_assignment')).data,
      ) as Record<string, unknown>;

      // The sub-round's transfer is a task change, so the leader gets the
      // team-change wake and the task now belongs to the new assignee.
      const task = await getJson(fixture.base, `/api/tasks/${taskId}`);
      assert.equal(task['assignee_member_id'], memberB, 'the Agent transfer moved the assignee');

      const thread = await listMessages(fixture.base, taskTargetId);
      const transferEvent = thread.find((row) => {
        const body = String(row['body']);
        return row['kind'] === 'system' && body.includes('成员乙') && body.includes('成员甲');
      });
      assert.ok(transferEvent !== undefined, 'the transfer appends one system change record');

      await waitFor(
        async () =>
          (await getJson(fixture.base, `/api/targets/${taskTargetId}/team-runs`))[
            'team_runs'
          ] as Record<string, unknown>[],
        (rows) => rows.length === 3,
        'the reassignment + transfer rounds to close',
      );
      runs = (await getJson(fixture.base, `/api/targets/${taskTargetId}/team-runs`))[
        'team_runs'
      ] as Record<string, unknown>[];
      assert.equal(runs.length, 3, 'create + reassignment + transfer each open one leader run');
      assert.deepEqual(
        runs.map((run) => run['status']),
        ['completed', 'completed', 'completed'],
      );
      assert.equal(reassignFrame['state'], 'completed');
      assert.equal(transferFrame['state'], 'completed');

      const db = openDatabase(fixture.dataDir);
      try {
        const changeSeqs = queryAll<{ id: string; base_seq: number; reason: string }>(
          db,
          `SELECT id, base_seq, reason FROM round_outcome
            WHERE target_id = ? AND member_id = ? ORDER BY base_seq`,
          [taskTargetId, leaderId],
        );
        assert.equal(changeSeqs.length, 3, 'one leader outcome per delivered wake');
        const wakeCopy = ZH_CN['wake.teamChange'].text;
        const transferRound = changeSeqs.find(
          (row) => row.base_seq === transferEvent?.['seq'],
        );
        assert.ok(transferRound !== undefined, 'the transfer record is the transfer round from_seq');
        assert.ok(
          transferRound.reason.includes(wakeCopy),
          `the transfer round names team-change: ${transferRound.reason}`,
        );
        assert.equal(
          queryOne<{ total: number }>(db, 'SELECT count(*) AS total FROM team_assignment')?.total,
          3,
          'every TeamAssign wrote one assignment row',
        );
      } finally {
        db.close();
      }

      // The run snapshot nests the assignments; the panel and the frames agree.
      const snapshot = (await getJson(fixture.base, `/api/targets/${taskTargetId}/team-runs`))[
        'team_runs'
      ] as Record<string, unknown>[];
      const assignments = snapshot.flatMap(
        (run) => run['assignments'] as Record<string, unknown>[],
      );
      assert.equal(assignments.length, 3);
      assert.equal(assignments.every((row) => row['state'] === 'completed'), true);
      assert.equal(
        assignments.every((row) => row['jump_consumed'] === 1),
        true,
      );
    } finally {
      await events.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('Plan tools in a task and a team round publish plan_update and persist one run per target+member', async () => {
  const fixture = await startFixture('allibot-m2-e2e-plan-', { behavior: 'plan' });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 Plan 频道');
    const memberId = await createAgent(fixture.base, '计划成员');
    await joinChannel(fixture.base, channelId, memberId);
    await consentModel(fixture.base);

    const task = await ok(fixture.base, 'POST', '/api/tasks', {
      channel_id: channelId,
      title: '计划任务',
    });
    const taskId = task['id'] as string;
    const taskTargetId = task['target_id'] as string;
    await ok(fixture.base, 'PATCH', `/api/tasks/${taskId}`, {
      assignee_member_id: memberId,
    });

    // A task round carries the four Plan tools; the frame is the full list.
    const posted = await ok(fixture.base, 'POST', `/api/targets/${taskTargetId}/messages`, {
      body: '请列一个计划',
    });
    assert.ok(typeof posted['id'] === 'string');
    const finalPlanFrame = await waitFor(
      async () => {
        const frame = await events.next(5_000);
        assert.ok(frame !== null, 'the stream closed before plan_update');
        if (frame.event !== 'plan_update') {
          return null;
        }
        assertNoEventId(frame);
        return JSON.parse(frame.data) as Record<string, unknown>;
      },
      (frame) => {
        if (frame === null) {
          return false;
        }
        const tasks = frame['tasks'] as Record<string, unknown>[];
        return tasks.some((row) => row['status'] === 'in_progress');
      },
      'the Plan mutation frame',
    );
    assert.ok(finalPlanFrame !== null);
    assert.equal(finalPlanFrame['target_id'], taskTargetId);
    assert.equal(finalPlanFrame['member_id'], memberId);
    assert.match(String(finalPlanFrame['plan_run_id']), /^[0-9a-f-]{36}$/);
    assert.match(String(finalPlanFrame['occurred_at']), /^2026-11-04T00:00:00/);
    assert.deepEqual(
      (finalPlanFrame['tasks'] as Record<string, unknown>[]).map((row) => [
        row['title'],
        row['status'],
        row['position'],
      ]),
      [
        ['PLAN-ITEM-ONE-UPDATED', 'in_progress', 0],
        ['PLAN-ITEM-TWO', 'pending', 1],
      ],
    );

    const plans = (await getJson(fixture.base, `/api/targets/${taskTargetId}/plans`))[
      'plans'
    ] as Record<string, unknown>[];
    assert.equal(plans.length, 1);
    assert.equal(plans[0]?.['id'], finalPlanFrame['plan_run_id']);
    assert.equal(plans[0]?.['target_id'], taskTargetId);
    assert.equal(plans[0]?.['member_id'], memberId);
    assert.equal((plans[0]?.['tasks'] as unknown[]).length, 2);

    const reply = (await listMessages(fixture.base, taskTargetId)).find(
      (row) => row['kind'] === 'agent',
    );
    assert.match(String(reply?.['body']), /\[plan\] available:true run:/);
    assert.match(String(reply?.['body']), /\[plan-tools\] .*TaskCreate.*TaskGet.*TaskList.*TaskUpdate/);
    // Plan is a work list, never a task-board row.
    const tasks = (await getJson(fixture.base, `/api/tasks?channel_id=${channelId}`))[
      'tasks'
    ] as Record<string, unknown>[];
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0]?.['status'], 'todo');

    // A team channel's ordinary leader round also has the Plan face.
    const teamChannel = await createChannel(fixture.base, 'M2 Plan 团队频道');
    const leaderId = await createAgent(fixture.base, '计划队长');
    await joinChannel(fixture.base, teamChannel, leaderId);
    await makeTeam(fixture.base, teamChannel, leaderId);
    await ok(fixture.base, 'POST', `/api/targets/${teamChannel}/messages`, {
      body: '队长也列一个计划',
    });
    const teamFrame = await waitFor(
      async () => {
        const frame = await events.next(5_000);
        assert.ok(frame !== null, 'the stream closed before the team plan_update');
        if (frame.event !== 'plan_update') {
          return null;
        }
        const data = JSON.parse(frame.data) as Record<string, unknown>;
        return data['target_id'] === teamChannel ? data : null;
      },
      (frame) => frame !== null,
      'the team Plan frame',
    );
    assert.ok(teamFrame !== null);
    assert.equal(teamFrame['member_id'], leaderId);
    const teamPlans = (await getJson(fixture.base, `/api/targets/${teamChannel}/plans`))[
      'plans'
    ] as Record<string, unknown>[];
    assert.equal(teamPlans.length, 1, 'the team target keeps its own plan run');
    assert.equal(teamPlans[0]?.['member_id'], leaderId);
  } finally {
    await events.close();
    await fixture.stop();
  }
});

async function createSopDefinition(
  base: string,
  channelId: string,
  executorMemberId: string,
  verifierMemberId: string,
  options: { name?: string; steps?: number; maxAttempts?: number } = {},
): Promise<string> {
  const stepCount = options.steps ?? 2;
  const steps = Array.from({ length: stepCount }, (_value, index) => ({
    title: `步骤${index + 1}`,
    description: `说明${index + 1}`,
    executor_member_id: executorMemberId,
    verifier_member_id: verifierMemberId,
    max_attempts: options.maxAttempts ?? 2,
  }));
  const created = await ok(base, 'POST', '/api/sops', {
    channel_id: channelId,
    name: options.name ?? 'M2 集成流程',
    steps,
  });
  return created['id'] as string;
}

async function readSopRun(base: string, runId: string): Promise<Record<string, unknown>> {
  return await getJson(base, `/api/sop-runs/${runId}`);
}

async function collectSopFrames(
  events: SseConnection,
  runId: string,
  done: (run: Record<string, unknown>) => boolean,
  base: string,
): Promise<{ frames: Record<string, unknown>[]; run: Record<string, unknown> }> {
  const frames: Record<string, unknown>[] = [];
  const deadline = Date.now() + 10_000;
  let run = await readSopRun(base, runId);
  while (!done(run)) {
    if (Date.now() > deadline) {
      throw new Error(`SOP run did not settle; last: ${JSON.stringify(run)}`);
    }
    let frame: SseFrame | null = null;
    try {
      frame = await events.next(200);
    } catch {
      frame = null;
    }
    if (frame !== null && frame.event === 'sop_update') {
      assertNoEventId(frame);
      const data = JSON.parse(frame.data) as Record<string, unknown>;
      assert.equal(data['sop_run_id'], runId);
      frames.push(data);
    }
    run = await readSopRun(base, runId);
  }
  // The run can settle before the test has consumed the buffered frames; the
  // stream is live-only, so everything already delivered stays in the client
  // buffer and is drained here before the assertion.
  for (const frame of await drain(events, 250)) {
    if (frame.event === 'sop_update') {
      assertNoEventId(frame);
      const data = JSON.parse(frame.data) as Record<string, unknown>;
      if (data['sop_run_id'] === runId) {
        frames.push(data);
      }
    }
  }
  return { frames, run };
}

test('a SOP definition starts explicitly, runs executor then verifier, and completes', async () => {
  const fixture = await startFixture('allibot-m2-e2e-sop-complete-', {
    behavior: 'sop-executor',
  });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 SOP 频道');
    const executorId = await createAgent(fixture.base, '执行者');
    const verifierId = await createAgent(fixture.base, '校验者');
    await joinChannel(fixture.base, channelId, executorId);
    await joinChannel(fixture.base, channelId, verifierId);
    await consentModel(fixture.base);

    const definitionId = await createSopDefinition(
      fixture.base,
      channelId,
      executorId,
      verifierId,
    );
    const started = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(started.status, 202, started.text);
    const pending = started.body;
    assert.equal(pending['phase'], 'pending');
    const runId = pending['id'] as string;

    const { frames, run } = await collectSopFrames(
      events,
      runId,
      (row) => row['phase'] === 'completed' || row['phase'] === 'failed',
      fixture.base,
    );
    assert.equal(run['phase'], 'completed');
    assert.equal(run['current_step'], 2);
    assert.equal(run['finished_at'] !== null, true);
    const state = run['state'] as Record<string, unknown>;
    assert.equal(state['current_step'], 2);
    assert.equal(state['attempt'], 1);
    const steps = state['steps'] as Record<string, unknown>[];
    assert.equal(steps.length, 2);
    for (const [index, step] of steps.entries()) {
      assert.match(String(step['executor_excerpt']), new RegExp(`SOP-EXEC:${index}:1:步骤${index + 1}`));
      assert.match(String(step['verifier_excerpt']), /SOP-VERIFY:PASS:/);
      assert.match(String(step['verifier_excerpt']), new RegExp(`SAW:SOP-EXEC:${index}:1`));
      assert.equal(step['verifier_verdict'], 'pass');
      assert.equal(step['attempts'], 1);
    }
    assert.deepEqual(
      new Set(frames.map((frame) => frame['phase'])),
      new Set(['pending', 'running', 'awaiting', 'completed']),
    );
    for (const frame of frames) {
      assert.equal(frame['definition_id'], definitionId);
      assert.equal(typeof frame['current_step'], 'number');
      assert.equal(typeof frame['attempt'], 'number');
      assert.match(String(frame['occurred_at']), /^2026-11-04T00:00:00/);
    }

    // A SOP is not a conversation: no message, outcome, task or team run.
    const db = openDatabase(fixture.dataDir);
    try {
      for (const table of ['message', 'round_outcome', 'team_run', 'team_assignment']) {
        assert.equal(
          queryOne<{ total: number }>(db, `SELECT count(*) AS total FROM ${table}`)?.total,
          0,
          `${table} must stay empty for a SOP run`,
        );
      }
      assert.equal(
        queryOne<{ total: number }>(db, 'SELECT count(*) AS total FROM sop_run')?.total,
        1,
      );
      assert.equal(
        queryOne<{ total: number }>(db, 'SELECT count(*) AS total FROM sop_definition')?.total,
        1,
      );
    } finally {
      db.close();
    }

    const listed = (await getJson(fixture.base, `/api/sops/${definitionId}/runs`))[
      'runs'
    ] as Record<string, unknown>[];
    assert.equal(listed[0]?.['id'], runId);
  } finally {
    await events.close();
    await fixture.stop();
  }
});

test('a failing SOP verifier retries the step to max_attempts and closes the run failed', async () => {
  const fixture = await startFixture('allibot-m2-e2e-sop-failed-', {
    behavior: 'sop-verifier',
  });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 SOP 失败频道');
    const executorId = await createAgent(fixture.base, '执行者');
    const verifierId = await createAgent(fixture.base, '校验者');
    await joinChannel(fixture.base, channelId, executorId);
    await joinChannel(fixture.base, channelId, verifierId);
    await consentModel(fixture.base);

    const definitionId = await createSopDefinition(
      fixture.base,
      channelId,
      executorId,
      verifierId,
      { steps: 1, maxAttempts: 2 },
    );
    const started = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(started.status, 202, started.text);
    const runId = started.body['id'] as string;

    const { frames, run } = await collectSopFrames(
      events,
      runId,
      (row) => row['phase'] === 'completed' || row['phase'] === 'failed',
      fixture.base,
    );
    assert.equal(run['phase'], 'failed');
    assert.equal(run['current_step'], 0);
    const state = run['state'] as Record<string, unknown>;
    assert.equal(state['attempt'], 2);
    assert.match(String(state['error']), /SOP-VERIFY:FAIL/);
    const step = (state['steps'] as Record<string, unknown>[])[0]!;
    assert.equal(step['attempts'], 2);
    assert.equal(step['verifier_verdict'], 'fail');
    assert.match(String(step['executor_excerpt']), /SOP-EXEC:0:2:/);
    assert.equal(
      frames.some((frame) => frame['phase'] === 'running' && frame['attempt'] === 2),
      true,
      'the retry is a live progress point',
    );
  } finally {
    await events.close();
    await fixture.stop();
  }
});

async function listApprovals(
  base: string,
  query = 'status=all',
): Promise<Record<string, unknown>[]> {
  const body = await getJson(base, `/api/approvals?${query}`);
  return body['approvals'] as Record<string, unknown>[];
}

async function waitForApprovalCount(
  base: string,
  count: number,
): Promise<Record<string, unknown>> {
  const rows = await waitFor(
    () => listApprovals(base, 'status=pending'),
    (value) => value.length === count,
    `${count} pending approval(s)`,
  );
  return rows[0]!;
}

async function nextApprovalFrame(
  events: SseConnection,
  type: 'approval.requested' | 'approval.resolved',
  replyId: string,
): Promise<Record<string, unknown>> {
  for (;;) {
    const frame = await nextOfType(events, type, 5_000);
    assertNoEventId(frame);
    const data = JSON.parse(frame.data) as Record<string, unknown>;
    if (data['reply_id'] === replyId) {
      return data;
    }
  }
}

async function decideApproval(
  base: string,
  replyId: string,
  toolCallId: string,
  confirmed: boolean,
): Promise<void> {
  await ok(base, 'POST', `/api/approvals/${replyId}`, {
    tool_call_id: toolCallId,
    confirmed,
  });
}

test('approval batches reopen in one reply, confirm each call, and a denial stays in the history', async () => {
  const fixture = await startFixture('allibot-m2-e2e-approvals-', {
    behavior: 'permission',
    projectRoot: true,
  });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 审批频道');
    const agentId = await createAgent(fixture.base, '审批成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);
    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      workspace_root: fixture.projectRoot,
      allow_local_shell: 1,
    });

    // The message write drives the round synchronously and the round waits for
    // the human decision, so the POST is completed only after the approvals.
    const postedReply = ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '请写两个文件再跑一条命令',
    });

    const first = await waitForApprovalCount(fixture.base, 1);
    const replyId = first['reply_id'] as string;
    assert.equal(first['context_kind'], 'round');
    assert.equal(first['context_id'], null);
    assert.equal(first['target_id'], channelId);
    const firstCalls = first['tool_calls'] as Record<string, unknown>[];
    assert.equal(firstCalls.length, 1);
    assert.equal(firstCalls[0]?.['tool_name'], 'Write');
    assert.equal((firstCalls[0]?.['arguments'] as Record<string, unknown>)['path'], 'approval-one.txt');

    const requested = await nextApprovalFrame(events, 'approval.requested', replyId);
    assert.deepEqual(Object.keys(requested).sort(), [
      'context_id',
      'context_kind',
      'reply_id',
      'status',
      'target_id',
      'tool_call_ids',
    ]);
    assert.equal(requested['status'], 'pending');
    assert.deepEqual(requested['tool_call_ids'], [firstCalls[0]?.['tool_call_id']]);
    assert.equal(JSON.stringify(requested).includes('approval-one.txt'), false);

    await decideApproval(
      fixture.base,
      replyId,
      firstCalls[0]?.['tool_call_id'] as string,
      true,
    );
    const resolved1 = await nextApprovalFrame(events, 'approval.resolved', replyId);
    assert.equal(resolved1['status'], 'confirmed');

    // The second gated call reopens the same reply as batch 2.
    let reopened = await waitFor(
      () => getJson(fixture.base, `/api/approvals/${replyId}`),
      (row) => (row['tool_calls'] as unknown[]).length === 2 && row['status'] === 'pending',
      'the second approval batch',
    );
    let calls = reopened['tool_calls'] as Record<string, unknown>[];
    assert.equal(calls.length, 2);
    assert.equal((calls[1]?.['arguments'] as Record<string, unknown>)['path'], 'approval-two.txt');
    const requested2 = await nextApprovalFrame(events, 'approval.requested', replyId);
    assert.deepEqual(requested2['tool_call_ids'], [calls[1]?.['tool_call_id']]);
    await decideApproval(
      fixture.base,
      replyId,
      calls[1]?.['tool_call_id'] as string,
      true,
    );
    await nextApprovalFrame(events, 'approval.resolved', replyId);

    // The local shell is a hard ask: batch 3 even though the mode would allow
    // trusted writes; its summary carries the command, never an env value.
    reopened = await waitFor(
      () => getJson(fixture.base, `/api/approvals/${replyId}`),
      (row) => (row['tool_calls'] as unknown[]).length === 3 && row['status'] === 'pending',
      'the shell approval batch',
    );
    calls = reopened['tool_calls'] as Record<string, unknown>[];
    assert.equal(calls[2]?.['tool_name'], 'Bash');
    assert.match(JSON.stringify(calls[2]?.['arguments']), /ls -la/);
    assert.doesNotMatch(JSON.stringify(reopened), /OPENAI|sk-m2-e2e|PATH=/);
    await decideApproval(
      fixture.base,
      replyId,
      calls[2]?.['tool_call_id'] as string,
      true,
    );
    await nextApprovalFrame(events, 'approval.resolved', replyId);

    const posted = await postedReply;
    assert.ok(typeof posted['id'] === 'string');
    await waitFor(
      async () => (await listMessages(fixture.base, channelId)).filter((row) => row['kind'] === 'agent'),
      (rows) => rows.length === 1,
      'the approved round reply',
    );
    const approved = await getJson(fixture.base, `/api/approvals/${replyId}`);
    assert.equal(approved['status'], 'confirmed');
    assert.equal((approved['decisions'] as unknown[]).length, 3);
    assert.equal((approved['batches'] as unknown[]).length, 3);
    assert.equal(readFileSync(path.join(fixture.projectRoot, 'approval-one.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(path.join(fixture.projectRoot, 'approval-two.txt'), 'utf8'), 'two');
    const approvedReply = (await listMessages(fixture.base, channelId)).find(
      (row) => row['kind'] === 'agent',
    );
    assert.equal(approvedReply?.['id'], replyId, 'the reply identity is the landed message id');
    assert.match(String(approvedReply?.['body']), /\[approval-one\] ok/);
    assert.match(String(approvedReply?.['body']), /\[approval-two\] ok/);
    assert.match(String(approvedReply?.['body']), /\[permission\] mode:ask-writes shell:1/);

    // A second round: deny the first write, confirm the second, confirm shell.
    const deniedPosted = ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '这次拒绝第一个写入',
    });
    const deniedRow = await waitFor(
      () => listApprovals(fixture.base, 'status=pending'),
      (rows) => rows.length === 1,
      'the denied round approval',
    );
    const deniedReplyId = deniedRow[0]!['reply_id'] as string;
    const deniedCall = (deniedRow[0]!['tool_calls'] as Record<string, unknown>[])[0]!;
    await nextApprovalFrame(events, 'approval.requested', deniedReplyId);
    await decideApproval(fixture.base, deniedReplyId, deniedCall['tool_call_id'] as string, false);
    assert.equal(
      (await nextApprovalFrame(events, 'approval.resolved', deniedReplyId))['status'],
      'denied',
    );
    let deniedReading = await waitFor(
      () => getJson(fixture.base, `/api/approvals/${deniedReplyId}`),
      (row) => (row['tool_calls'] as unknown[]).length === 2 && row['status'] === 'pending',
      'the denied round second batch',
    );
    calls = deniedReading['tool_calls'] as Record<string, unknown>[];
    await decideApproval(
      fixture.base,
      deniedReplyId,
      calls[1]?.['tool_call_id'] as string,
      true,
    );
    deniedReading = await waitFor(
      () => getJson(fixture.base, `/api/approvals/${deniedReplyId}`),
      (row) => (row['tool_calls'] as unknown[]).length === 3 && row['status'] === 'pending',
      'the denied round shell batch',
    );
    calls = deniedReading['tool_calls'] as Record<string, unknown>[];
    await decideApproval(
      fixture.base,
      deniedReplyId,
      calls[2]?.['tool_call_id'] as string,
      true,
    );
    await waitFor(
      () => getJson(fixture.base, `/api/approvals/${deniedReplyId}`),
      (row) => row['status'] === 'denied',
      'the historical denial to keep the final status denied',
    );
    await deniedPosted;
    const deniedReply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    assert.match(String(deniedReply?.['body']), /\[approval-one\] error:denied/);
    assert.match(String(deniedReply?.['body']), /\[approval-two\] ok/);
    assert.equal(
      readFileSync(path.join(fixture.projectRoot, 'approval-one.txt'), 'utf8'),
      'one',
      'a denied write never runs',
    );
  } finally {
    await events.close();
    await fixture.stop();
  }
});

test('an approval batch that waits past the injected timeout closes failed and fails the round', async () => {
  const fixture = await startFixture('allibot-m2-e2e-approval-timeout-', {
    behavior: 'permission',
    projectRoot: true,
    args: ['--approval-timeout-ms', '250'],
  });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 审批超时频道');
    const agentId = await createAgent(fixture.base, '超时成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);
    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      workspace_root: fixture.projectRoot,
    });

    const timedOutReply = ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '超时审批',
    });
    const pending = await waitForApprovalCount(fixture.base, 1);
    const replyId = pending['reply_id'] as string;
    const requested = await nextApprovalFrame(events, 'approval.requested', replyId);
    assert.equal(requested['status'], 'pending');
    const resolved = await nextApprovalFrame(events, 'approval.resolved', replyId);
    assert.equal(resolved['status'], 'failed');
    const failed = await getJson(fixture.base, `/api/approvals/${replyId}`);
    assert.equal(failed['status'], 'failed');
    assert.equal(failed['resolved_at'], FIXED_NOW);
    assert.equal((failed['decisions'] as unknown[]).length, 0);

    const outcome = await waitFor(
      async () => {
        const db = openDatabase(fixture.dataDir);
        try {
          return queryOne<{ status: string; reason: string }>(
            db,
            'SELECT status, reason FROM round_outcome WHERE target_id = ? ORDER BY rowid DESC',
            [channelId],
          );
        } finally {
          db.close();
        }
      },
      (row) => row !== undefined,
      'the timed-out round outcome',
    );
    assert.equal(outcome?.status, 'failed');
    assert.match(String(outcome?.reason), /审批等待超时/);
    await timedOutReply;
    assert.equal(
      (await listMessages(fixture.base, channelId)).some((row) => row['kind'] === 'agent'),
      false,
      'a timed-out round lands no reply',
    );
  } finally {
    await events.close();
    await fixture.stop();
  }
});

test('a workspace root gates file tools to the root and reports the target workspace status', async () => {
  const fixture = await startFixture('allibot-m2-e2e-workspace-', {
    behavior: 'workspace',
    projectRoot: true,
  });
  try {
    const channelId = await createChannel(fixture.base, 'M2 工作区频道');
    const agentId = await createAgent(fixture.base, '工作区成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);
    const agent = await getJson(fixture.base, `/api/agents/${agentId}`);
    const homePath = agent['home_path'] as string;
    const skills = path.join(homePath, 'skills', 'demo');
    mkdirSync(skills, { recursive: true });
    writeFileSync(path.join(skills, 'SKILL.md'), 'SKILL-NEEDLE\nskill body\n', 'utf8');

    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      workspace_root: fixture.projectRoot,
      permission_mode: 'trusted-writes',
    });
    const members = (await getJson(fixture.base, `/api/targets/${channelId}/members`))[
      'members'
    ] as Record<string, unknown>[];
    const reading = members.find((row) => row['id'] === agentId);
    assert.equal(
      (reading?.['workspace_status'] as Record<string, unknown>)['available'],
      true,
    );
    assert.equal(
      (reading?.['workspace_status'] as Record<string, unknown>)['backend'],
      'local',
    );

    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '请检查工作区',
    });
    const reply = (await listMessages(fixture.base, channelId)).find(
      (row) => row['kind'] === 'agent',
    );
    const body = String(reply?.['body']);
    const canonicalRoot = realpathSync(fixture.projectRoot);
    assert.match(body, new RegExp(`\\[workspace\\] root:${canonicalRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} backend:local shell:0`));
    assert.match(body, /\[workspace-tools\] Read,Glob,Grep,Write,Edit/);
    assert.match(body, /\[workspace-read\] ok path:notes\.txt content:ROOT-NOTE/);
    assert.match(body, /\[workspace-write\] ok path:written\.txt/);
    assert.match(body, /\[workspace-reread\] ok path:written\.txt content:edited-by-tool/);
    assert.match(body, /\[workspace-dotdot\] error:outside-root/);
    assert.match(body, /\[workspace-absolute\] error:outside-root/);
    assert.match(body, /\[workspace-symlink\] error:outside-root/);
    assert.match(body, /\[workspace-skills-read\] ok path:demo\/SKILL\.md content:SKILL-NEEDLE/);
    assert.match(body, /\[workspace-skills-write\] error:read-only/);
    assert.match(body, /\[workspace-home-write\] error:outside-root/);
    assert.equal(readFileSync(path.join(fixture.projectRoot, 'written.txt'), 'utf8'), 'edited-by-tool');
    assert.equal(readFileSync(path.join(skills, 'SKILL.md'), 'utf8'), 'SKILL-NEEDLE\nskill body\n');

    const db = openDatabase(fixture.dataDir);
    try {
      assert.equal(
        queryOne<{ total: number }>(db, 'SELECT count(*) AS total FROM approval_request')?.total,
        0,
        'trusted root writes are not approval questions',
      );
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
  }
});

async function approveEveryBatch(
  base: string,
  events: SseConnection,
  replyId: string,
  batches: number,
): Promise<void> {
  for (let index = 0; index < batches; index += 1) {
    const row = await waitFor(
      () => getJson(base, `/api/approvals/${replyId}`),
      (value) => (value['tool_calls'] as unknown[]).length === index + 1 && value['status'] === 'pending',
      `approval batch ${index + 1}`,
    );
    const call = (row['tool_calls'] as Record<string, unknown>[])[index]!;
    await decideApproval(base, replyId, call['tool_call_id'] as string, true);
    await nextApprovalFrame(events, 'approval.resolved', replyId);
  }
}

test('permission modes and rules produce DENY, ask and allow at the one tool gate', async () => {
  const fixture = await startFixture('allibot-m2-e2e-permissions-', {
    behavior: 'permission',
    projectRoot: true,
  });
  const events = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture.base, 'M2 权限频道');
    const agentId = await createAgent(fixture.base, '权限成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);
    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      workspace_root: fixture.projectRoot,
      permission_mode: 'read-only',
    });
    // An allow rule cannot lift the read-only hard ceiling.
    await ok(fixture.base, 'PUT', `/api/channels/${channelId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'notes.txt', behavior: 'allow' },
    ]);

    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '只读轮次',
    });
    let reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    let body = String(reply?.['body']);
    assert.match(body, /\[permission\] mode:read-only/);
    assert.match(body, /Read:notes\.txt=allow/);
    assert.match(body, /Write:notes\.txt=deny/);
    assert.match(body, /Write:sub\/deep\.txt=deny/);
    assert.match(body, /Bash:ls -la=deny/);
    assert.match(body, /mcp:demo\/echo.*=deny/);
    assert.match(body, /\[approval-one\] error:denied/);
    assert.equal(
      (await listApprovals(fixture.base, 'status=pending')).length,
      0,
      'a hard ceiling asks nobody',
    );

    // ask-writes: an explicit deny wins, an allow rule grants one write, the
    // remaining writes and the shell ask.
    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      permission_mode: 'ask-writes',
      allow_local_shell: 1,
    });
    await ok(fixture.base, 'PUT', `/api/channels/${channelId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'notes.txt', behavior: 'deny' },
      { tool_name: 'Write', pattern: 'sub/deep.txt', behavior: 'allow' },
    ]);
    const askedReply = ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '询问轮次',
    });
    const pending = await waitForApprovalCount(fixture.base, 1);
    const replyId = pending['reply_id'] as string;
    await approveEveryBatch(fixture.base, events, replyId, 3);
    await askedReply;
    reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    body = String(reply?.['body']);
    assert.match(body, /\[permission\] mode:ask-writes/);
    assert.match(body, /Write:notes\.txt=deny/);
    assert.match(body, /Write:sub\/deep\.txt=allow/);
    assert.match(body, /Bash:ls -la=ask/);
    assert.match(body, /mcp:demo\/echo.*=ask/);
    assert.match(body, /\[approval-one\] ok/);
    assert.match(body, /\[approval-two\] ok/);
    assert.equal((await getJson(fixture.base, `/api/approvals/${replyId}`))['status'], 'confirmed');

    // trusted-writes auto-allows root-internal writes; the local shell stays a
    // per-call ask (the second hard gate).
    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      permission_mode: 'trusted-writes',
    });
    await ok(fixture.base, 'PUT', `/api/channels/${channelId}/permission-rules`, []);
    const trustedReply = ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '信任轮次',
    });
    const trustedPending = await waitForApprovalCount(fixture.base, 1);
    const trustedReplyId = trustedPending['reply_id'] as string;
    const trustedCalls = trustedPending['tool_calls'] as Record<string, unknown>[];
    assert.equal(trustedCalls.length, 1);
    assert.equal(trustedCalls[0]?.['tool_name'], 'Bash');
    await approveEveryBatch(fixture.base, events, trustedReplyId, 1);
    await trustedReply;
    reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    body = String(reply?.['body']);
    assert.match(body, /\[permission\] mode:trusted-writes/);
    assert.match(body, /Write:notes\.txt=allow/);
    assert.match(body, /Write:sub\/deep\.txt=allow/);
    assert.match(body, /\[approval-one\] ok/);
    assert.match(body, /\[approval-two\] ok/);
    assert.equal((await getJson(fixture.base, `/api/approvals/${trustedReplyId}`))['status'], 'confirmed');
  } finally {
    await events.close();
    await fixture.stop();
  }
});

test('the Agent-home mcp.json is the one declaration: valid servers assemble, an invalid file is zero assembly', async () => {
  const fixture = await startFixture('allibot-m2-e2e-mcp-', {
    behavior: 'mcp',
    projectRoot: true,
    env: { MCP_TEST_TOKEN: 'named-token-value' },
  });
  try {
    const channelId = await createChannel(fixture.base, 'M2 MCP 频道');
    const agentId = await createAgent(fixture.base, 'MCP 成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);
    await ok(fixture.base, 'PATCH', `/api/channels/${channelId}`, {
      workspace_root: fixture.projectRoot,
    });
    await ok(fixture.base, 'PUT', `/api/channels/${channelId}/permission-rules`, [
      { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'allow' },
    ]);
    const agent = await getJson(fixture.base, `/api/agents/${agentId}`);
    const homePath = agent['home_path'] as string;
    const mcpPath = path.join(homePath, 'mcp.json');
    const serverLog = path.join(fixture.tmp, 'demo.log');

    // The management PUT writes the same file runtime assembles from.
    const saved = await ok(fixture.base, 'PUT', `/api/agents/${agentId}/mcp`, {
      entries: [
        {
          name: 'demo',
          transport: 'stdio',
          enabled: true,
          command: process.execPath,
          args: [MCP_SERVER, 'stdio', '--log', serverLog],
          env_names: ['MCP_TEST_TOKEN'],
        },
      ],
    });
    assert.equal(saved['path'], mcpPath);
    assert.equal(saved['present'], true);
    assert.equal(saved['diagnostic'], null);
    const savedEntries = saved['entries'] as Record<string, unknown>[];
    assert.deepEqual(savedEntries[0]?.['env_names'], ['MCP_TEST_TOKEN']);
    assert.equal(JSON.stringify(saved).includes('named-token-value'), false);
    const file = JSON.parse(readFileSync(mcpPath, 'utf8')) as {
      servers: Record<string, unknown>[];
    };
    assert.deepEqual(file.servers[0]?.['env_names'], ['MCP_TEST_TOKEN']);
    assert.equal(readFileSync(mcpPath, 'utf8').includes('named-token-value'), false);
    assert.equal(mcpPath.startsWith(path.join(homePath, '..')), true);

    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '装配 MCP',
    });
    let reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    let body = String(reply?.['body']);
    assert.match(body, /\[mcp\] servers:1/);
    assert.match(body, /\[mcp-server\] demo:stdio:echo/);
    assert.match(body, /\[mcp-call\] demo\/echo:ok/);
    assert.match(body, /\[mcp-tools\] mcp:demo\/echo/);
    assert.match(body, /\[tools\] .*mcp:demo\/echo/);
    assert.equal(readFileSync(serverLog, 'utf8').includes('tools/call'), true);

    // A present-but-invalid file disables the whole declaration: zero servers,
    // one readable diagnostic, no half set and no second source.
    writeFileSync(mcpPath, '{"servers":[{"name":"broken","transport":"stdio","url":"http://x"}]}\n', {
      encoding: 'utf8',
      mode: 0o600,
    });
    const broken = await getJson(fixture.base, `/api/agents/${agentId}/mcp`);
    assert.equal(broken['present'], true);
    assert.equal((broken['entries'] as unknown[]).length, 0);
    assert.match(String(broken['diagnostic']), /stdio|url/);

    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '零装配 MCP',
    });
    reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    body = String(reply?.['body']);
    assert.match(body, /\[mcp\] servers:0/);
    assert.match(body, /\[mcp\] diagnostic:.*(stdio|url)/);
    assert.match(body, /\[mcp-tools\] -/);
    const db = openDatabase(fixture.dataDir);
    try {
      const outcome = queryOne<{ reason: string }>(
        db,
        'SELECT reason FROM round_outcome WHERE target_id = ? ORDER BY rowid DESC',
        [channelId],
      );
      assert.match(String(outcome?.reason), /mcp\.json|stdio|url/);
    } finally {
      db.close();
    }

    // A missing file is zero MCP without an error; the old table is not read.
    const { rmSync } = await import('node:fs');
    rmSync(mcpPath);
    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '缺失 MCP',
    });
    reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    assert.match(String(reply?.['body']), /\[mcp\] absent/);
  } finally {
    await fixture.stop();
  }
});

test('a Skill install lands bytes in the Agent home and the next round assembles its prompt text', async () => {
  const fixture = await startFixture('allibot-m2-e2e-skill-', {
    behavior: 'reply',
    args: ['--scripted-report-team', '--scripted-echo-prompt', '--scripted-reply', '技能轮次'],
  });
  try {
    const channelId = await createChannel(fixture.base, 'M2 Skill 频道');
    const agentId = await createAgent(fixture.base, '技能成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);

    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '安装前',
    });
    let reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    assert.match(String(reply?.['body']), /\[skills\] absent/);

    const skillSource = path.join(fixture.tmp, 'skill-source');
    mkdirSync(skillSource, { recursive: true });
    writeFileSync(
      path.join(skillSource, 'SKILL.md'),
      '---\nname: 示例技能\ndescription: M2 集成技能\n---\n\n# 示例技能\n\n按步骤执行。\n',
      'utf8',
    );
    writeFileSync(path.join(skillSource, 'notes.txt'), 'skill payload\n', 'utf8');
    const installed = await ok(fixture.base, 'POST', `/api/agents/${agentId}/skills`, {
      source: 'directory',
      path: skillSource,
    });
    assert.equal(installed['created'], true);
    const skill = installed['skill'] as Record<string, unknown>;
    const skillName = skill['name'] as string;
    assert.match(String(skill['content_hash']), /^[0-9a-f]{64}$/);
    assert.equal(skill['source'], 'directory');
    assert.equal(skill['enabled'], true);

    const agent = await getJson(fixture.base, `/api/agents/${agentId}`);
    const homePath = agent['home_path'] as string;
    const skillFile = path.join(homePath, 'skills', skillName, 'SKILL.md');
    assert.equal(readFileSync(skillFile, 'utf8').includes('按步骤执行'), true);
    assert.equal(readFileSync(path.join(homePath, 'skills', skillName, 'notes.txt'), 'utf8'), 'skill payload\n');
    const listing = await getJson(fixture.base, `/api/agents/${agentId}/skills`);
    assert.equal(listing['home_path'], homePath);
    assert.equal((listing['skills'] as Record<string, unknown>[])[0]?.['name'], skillName);
    const detail = await getJson(fixture.base, `/api/agents/${agentId}/skills/${skillName}`);
    assert.match(String(detail['markdown']), /按步骤执行/);

    // The mcp declaration lives under the same derived home; both tabs manage
    // one directory, not two stores.
    const mcp = await ok(fixture.base, 'PUT', `/api/agents/${agentId}/mcp`, {
      entries: [],
    });
    assert.equal(mcp['path'], path.join(homePath, 'mcp.json'));

    await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '安装后',
    });
    reply = (await listMessages(fixture.base, channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    const body = String(reply?.['body']);
    assert.match(body, /\[skills\] present/);
    assert.match(body, /按步骤执行/);

    const db = openDatabase(fixture.dataDir);
    try {
      const row = queryOne<{ name: string; content_hash: string; enabled: number }>(
        db,
        'SELECT name, content_hash, enabled FROM skill WHERE member_id = ?',
        [agentId],
      );
      assert.equal(row?.name, skillName);
      assert.equal(row?.content_hash, skill['content_hash']);
      assert.equal(row?.enabled, 1);
      assert.equal(
        queryOne<{ total: number }>(db, 'SELECT count(*) AS total FROM skill')?.total,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('the one SSE stream rotates before the lifetime ends, carries no id, and a reconnect is live-only', async () => {
  const fixture = await startFixture('allibot-m2-e2e-sse-', {
    behavior: 'reply',
    args: ['--sse-lifetime-ms', '500', '--scripted-reply', '重连后的回复'],
  });
  try {
    const channelId = await createChannel(fixture.base, 'M2 订阅频道');
    const agentId = await createAgent(fixture.base, '订阅成员');
    await joinChannel(fixture.base, channelId, agentId);
    await consentModel(fixture.base);

    const openedAt = Date.now();
    const first = await SseConnection.open(`${fixture.base}/api/events`);
    assert.match(first.response.headers.get('content-type') ?? '', /^text\/event-stream/);
    assert.equal(first.response.headers.get('cache-control'), 'no-cache');
    const frames: SseFrame[] = [];
    for (;;) {
      const frame = await first.next(5_000);
      if (frame === null) {
        break;
      }
      assertNoEventId(frame);
      frames.push(frame);
    }
    const elapsed = Date.now() - openedAt;
    assert.equal(frames.at(-1)?.event, 'rotate', 'rotate is the last frame before the close');
    assert.deepEqual(JSON.parse(frames.at(-1)?.data ?? '{}'), {});
    assert.equal(
      frames.filter((frame) => frame.event === 'rotate').length,
      1,
      'one rotation per connection lifetime',
    );
    assert.ok(elapsed >= 350, `rotate should follow the injected lifetime; elapsed ${elapsed}ms`);
    assert.ok(elapsed < 5_000, `rotate should still arrive within the connection test window; elapsed ${elapsed}ms`);

    // The reconnect owes a catch-up read (the frontend does it) and the server
    // itself never replays a frame: nothing from before the reconnect arrives.
    const second = await SseConnection.open(`${fixture.base}/api/events`);
    try {
      assert.deepEqual(await drain(second, 300), [], 'no backlog after a reconnect');
      const posted = await ok(fixture.base, 'POST', `/api/targets/${channelId}/messages`, {
        body: '重连后的一句',
      });
      const created = await nextOfType(second, 'message.created');
      assertNoEventId(created);
      assert.deepEqual(JSON.parse(created.data), {
        target_id: channelId,
        message_id: posted['id'],
        seq: 1,
      });
    } finally {
      await second.close();
    }
  } finally {
    await fixture.stop();
  }
});
