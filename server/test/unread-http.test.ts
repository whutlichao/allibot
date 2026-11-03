import assert from 'node:assert/strict';
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
 * 未读与已读位置 (#25), observed at the process-level HTTP seam.
 *
 * The human face always writes as the owner, so the owner's own human messages
 * are excluded from its unread by construction; an Agent's reply is what
 * raises the badge. The scripted `reply` provider is the only member face a
 * test can drive without a model.
 */

interface UnreadFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

async function startUnreadFixture(
  prefix: string,
  options: { provider?: 'reply' | 'ignore' } = {},
): Promise<UnreadFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  let running = await startServer(dataDir, {
    args: ['--scripted-provider', options.provider ?? 'reply'],
  });
  return {
    dataDir,
    get running() {
      return running;
    },
    get base() {
      return `http://127.0.0.1:${running.port}`;
    },
    restart: async () => {
      await running.stop();
      running = await startServer(dataDir, {
        args: ['--scripted-provider', options.provider ?? 'reply'],
      });
    },
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
  fixture: UnreadFixture,
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
  fixture: UnreadFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: UnreadFixture, name = '未读频道'): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: UnreadFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: UnreadFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: UnreadFixture,
  targetId: string,
  body: string,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function createTask(
  fixture: UnreadFixture,
  channelId: string,
  title: string,
): Promise<Record<string, unknown>> {
  const created = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(created.status, 201, await created.clone().text());
  return await readJson(created);
}

async function getTask(fixture: UnreadFixture, taskId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/tasks/${taskId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function getWorkspace(fixture: UnreadFixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/workspace`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function markRead(
  fixture: UnreadFixture,
  targetId: string,
  body: unknown,
): Promise<Response> {
  return await postJson(fixture, `/api/targets/${targetId}/read`, body);
}

async function readPosition(
  fixture: UnreadFixture,
  memberId: string,
  targetId: string,
): Promise<number | undefined> {
  return queryDatabase<{ last_read_seq: number }>(
    fixture.dataDir,
    'SELECT last_read_seq FROM read_position WHERE member_id = ? AND target_id = ?',
    [memberId, targetId],
  )?.last_read_seq;
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly raw: string;
}

function parseFrame(raw: string): SseFrame {
  const lines = raw.split('\n');
  const eventLine = lines.find((line) => line.startsWith('event: '));
  const dataLines = lines.filter((line) => line.startsWith('data: '));
  return {
    event: eventLine === undefined ? '' : eventLine.slice('event: '.length),
    data: dataLines.map((line) => line.slice('data: '.length)).join('\n'),
    raw,
  };
}

/** One open subscription, read frame by frame at the process-level seam. */
class SseConnection {
  private readonly decoder = new TextDecoder();
  private buffer = '';
  private readonly frames: SseFrame[] = [];
  private readonly waiting: Array<{
    resolve: (frame: SseFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private closed = false;
  private failure: Error | null = null;
  private readonly abort: AbortController;
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;

  private constructor(
    abort: AbortController,
    reader: ReadableStreamDefaultReader<Uint8Array>,
  ) {
    this.abort = abort;
    this.reader = reader;
    void this.pump();
  }

  static async open(url: string): Promise<SseConnection> {
    const abort = new AbortController();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: abort.signal,
    });
    assert.equal(response.status, 200, 'the subscription should answer');
    const body = response.body;
    assert.ok(body !== null, 'the subscription should carry a body stream');
    return new SseConnection(abort, body.getReader());
  }

  async next(timeoutMs = 5_000): Promise<SseFrame> {
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    if (this.closed) {
      throw this.failure ?? new Error('the subscription closed');
    }
    return await new Promise<SseFrame>((resolve, reject) => {
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
      // The socket is already gone; nothing left to release.
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
        waiter.reject(this.failure ?? new Error('the subscription closed'));
        continue;
      }
      return;
    }
  }
}

/** Read frames until one of `type` arrives (workspace writes publish their own). */
async function nextOfType(
  stream: SseConnection,
  type: string,
  timeoutMs = 5_000,
): Promise<SseFrame> {
  for (;;) {
    const frame = await stream.next(timeoutMs);
    if (frame === null) {
      throw new Error(`the connection closed while waiting for ${type}`);
    }
    if (frame.event === type) {
      return frame;
    }
  }
}

function queryDatabase<T>(
  dataDir: string,
  sql: string,
  params: unknown[] = [],
): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

test('the workspace unread total sums channel and dm targets and excludes the owner and system messages', async () => {
  const fixture = await startUnreadFixture('allibot-unread-workspace-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    // Three owner messages, each answered by the Agent: the six stored
    // messages leave three Agent replies unread. If the author filter were
    // missing, the owner's own three human messages would double the count.
    for (const body of ['第一句', '第二句', '第三句']) {
      await postMessage(fixture, channelId, body);
    }

    const dmCreated = await postJson(fixture, '/api/dms', { agent_id: agent });
    assert.equal(dmCreated.status, 201, await dmCreated.clone().text());
    const dmId = (await readJson(dmCreated))['id'] as string;
    await postMessage(fixture, dmId, '私信一句');

    // A task creation writes two system messages (the task thread's opening
    // record and the channel pointer); neither is unread.
    const task = await createTask(fixture, channelId, '整理未读');

    const workspace = await getWorkspace(fixture);
    const byTarget = workspace['unread_by_target'] as Record<string, number>;
    assert.equal(workspace['unread_total'], 4, 'channel 3 + dm 1; task is separate');
    assert.equal(byTarget[channelId], 3, 'the owner’s own human messages are excluded');
    assert.equal(byTarget[dmId], 1);
    assert.equal(
      Object.hasOwn(byTarget, task['target_id'] as string),
      false,
      'a task target is counted in its task payload, not the workspace total',
    );

    assert.equal(
      (await getTask(fixture, task['id'] as string))['unread_count'],
      0,
      'a system message never counts as unread',
    );
  } finally {
    await fixture.stop();
  }
});

test('POST /api/targets/{id}/read takes a monotonic max and clamps to the newest seq', async () => {
  const fixture = await startUnreadFixture('allibot-unread-read-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    // Three human messages each land one Agent reply: seqs 1..6, unread 3.
    for (const body of ['一', '二', '三']) {
      await postMessage(fixture, channelId, body);
    }

    const first = await markRead(fixture, channelId, { last_read_seq: 4 });
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await readJson(first), {
      target_id: channelId,
      last_read_seq: 4,
      unread_count: 1,
    });

    // A smaller position never moves the row backwards.
    const backwards = await markRead(fixture, channelId, { last_read_seq: 1 });
    assert.equal(backwards.status, 200, await backwards.clone().text());
    assert.deepEqual(await readJson(backwards), {
      target_id: channelId,
      last_read_seq: 4,
      unread_count: 1,
    });

    // A position past the log is clamped to the newest stored seq, so "the
    // future is already read" cannot be written.
    const future = await markRead(fixture, channelId, { last_read_seq: 999 });
    assert.equal(future.status, 200, await future.clone().text());
    assert.deepEqual(await readJson(future), {
      target_id: channelId,
      last_read_seq: 6,
      unread_count: 0,
    });

    const owner = queryDatabase<{ id: string }>(
      fixture.dataDir,
      "SELECT id FROM member WHERE kind = 'owner'",
    )?.['id'] as string;
    assert.equal(await readPosition(fixture, owner, channelId), 6);
    assert.equal((await getWorkspace(fixture))['unread_total'], 0);
  } finally {
    await fixture.stop();
  }
});

test('a task thread keeps its unread in the task payload and the channel pointer stays system', async () => {
  const fixture = await startUnreadFixture('allibot-unread-task-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    const task = await createTask(fixture, channelId, '任务未读');
    const taskId = task['id'] as string;
    const taskTargetId = task['target_id'] as string;

    const assigned = await patchJson(fixture, `/api/tasks/${taskId}`, {
      assignee_member_id: agent,
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());

    // The owner speaks in the task thread; the assignee answers.
    await postMessage(fixture, taskTargetId, '任务里的一句');

    const detail = await getTask(fixture, taskId);
    assert.equal(detail['unread_count'], 1, 'the Agent reply is unread for the owner');

    // The channel's pointer is a system message, so the channel reads zero;
    // the task's unread never leaks into unread_total.
    const workspace = await getWorkspace(fixture);
    const byTarget = workspace['unread_by_target'] as Record<string, number>;
    assert.equal(workspace['unread_total'], 0);
    assert.equal(byTarget[channelId], 0, 'the task pointer is system and never unread');
    assert.equal(Object.hasOwn(byTarget, taskTargetId), false);

    // A task change appends a system event to the thread; it does not raise
    // the badge either.
    const moved = await patchJson(fixture, `/api/tasks/${taskId}`, { status: 'in_progress' });
    assert.equal(moved.status, 200, await moved.clone().text());
    assert.equal((await getTask(fixture, taskId))['unread_count'], 1);

    // The owner's read position on the task target clears the task reading
    // without touching the workspace total.
    const read = await markRead(fixture, taskTargetId, { last_read_seq: 999 });
    assert.equal(read.status, 200, await read.clone().text());
    assert.equal((await getTask(fixture, taskId))['unread_count'], 0);
    assert.equal((await getWorkspace(fixture))['unread_total'], 0);
  } finally {
    await fixture.stop();
  }
});

test('unread.changed follows the reading, and a system-only write publishes none', async () => {
  const fixture = await startUnreadFixture('allibot-unread-events-');
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    // The owner's human message raises no unread of its own; the Agent's reply
    // does. Frames: message.created, message.created, round.outcome, then the
    // unread change.
    await postMessage(fixture, channelId, '有人吗');

    const first = await nextOfType(stream, 'message.created');
    const reply = await nextOfType(stream, 'message.created');
    const outcome = await nextOfType(stream, 'round.outcome');
    const raised = await nextOfType(stream, 'unread.changed');
    assert.equal((JSON.parse(first.data) as Record<string, unknown>)['seq'], 1);
    assert.equal((JSON.parse(reply.data) as Record<string, unknown>)['seq'], 2);
    assert.equal((JSON.parse(outcome.data) as Record<string, unknown>)['status'], 'replied');
    assert.deepEqual(JSON.parse(raised.data), {
      target_id: channelId,
      unread_count: 1,
    });

    // Reading to the newest seq lowers the badge and announces it.
    const read = await markRead(fixture, channelId, { last_read_seq: 999 });
    assert.equal(read.status, 200, await read.clone().text());
    const lowered = await nextOfType(stream, 'unread.changed');
    assert.deepEqual(JSON.parse(lowered.data), {
      target_id: channelId,
      unread_count: 0,
    });

    // A second read at the same position changes nothing, so it announces
    // nothing.
    await markRead(fixture, channelId, { last_read_seq: 999 });
    await assert.rejects(stream.next(300), /no SSE frame within/);

    // Task creation writes two system messages (thread opening + channel
    // pointer). They stream as message.created rows but never as unread; the
    // task row itself publishes task.changed.
    await createTask(fixture, channelId, '系统消息');
    const taskThread = await nextOfType(stream, 'message.created');
    const channelPointer = await nextOfType(stream, 'message.created');
    assert.equal(taskThread.event, 'message.created');
    assert.equal(channelPointer.event, 'message.created');
    let extra: SseFrame | null = null;
    try {
      extra = await stream.next(300);
    } catch {
      extra = null;
    }
    while (extra !== null) {
      assert.notEqual(extra.event, 'unread.changed', 'a system-only write publishes no unread');
      try {
        extra = await stream.next(300);
      } catch {
        extra = null;
      }
    }
  } finally {
    await stream.close();
    await fixture.stop();
  }
});

test('an archived channel keeps its own unread reading but leaves the total; a deleted channel leaves both', async () => {
  const fixture = await startUnreadFixture('allibot-unread-archive-');
  try {
    const agent = await createAgent(fixture, '甲');
    const archived = await createChannel(fixture, '归档频道');
    const deleted = await createChannel(fixture, '删除频道');
    await joinChannel(fixture, archived, agent);
    await joinChannel(fixture, deleted, agent);
    await postMessage(fixture, archived, '归档里的一句');
    await postMessage(fixture, deleted, '删除前的一句');

    const archivedResponse = await postJson(fixture, `/api/channels/${archived}/archive`, {});
    assert.equal(archivedResponse.status, 200, await archivedResponse.clone().text());
    const deletedResponse = await fetch(`${fixture.base}/api/channels/${deleted}`, {
      method: 'DELETE',
    });
    assert.equal(deletedResponse.status, 204);

    const workspace = await getWorkspace(fixture);
    const byTarget = workspace['unread_by_target'] as Record<string, number>;
    assert.equal(workspace['unread_total'], 0, 'neither an archived nor a deleted channel counts');
    assert.equal(byTarget[archived], 1, 'the archived channel keeps its own reading');
    assert.equal(
      Object.hasOwn(byTarget, deleted),
      false,
      'a deleted channel is not part of the workspace',
    );
  } finally {
    await fixture.stop();
  }
});

test('POST /api/targets/{id}/read rejects a malformed body and an unknown target', async () => {
  const fixture = await startUnreadFixture('allibot-unread-validation-');
  try {
    const channelId = await createChannel(fixture);

    for (const body of [{}, { last_read_seq: -1 }, { last_read_seq: 1.5 }, { last_read_seq: '2' }]) {
      const response = await markRead(fixture, channelId, body);
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} should be rejected`);
      const failure = await readJson(response);
      assert.equal(
        (failure['error'] as Record<string, unknown>)['code'],
        'validation_failed',
      );
    }

    const unknown = await markRead(fixture, 'does-not-exist', { last_read_seq: 1 });
    assert.equal(unknown.status, 404);
    assert.equal(
      ((await readJson(unknown))['error'] as Record<string, unknown>)['code'],
      'not_found',
    );

    const unknownField = await markRead(fixture, channelId, { last_read_seq: 1, seq: 1 });
    assert.equal(unknownField.status, 400);
  } finally {
    await fixture.stop();
  }
});

test('read positions and unread survive a restart, and the owner row never moves the Agent cursor', async () => {
  const fixture = await startUnreadFixture('allibot-unread-restart-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    for (const body of ['一', '二', '三']) {
      await postMessage(fixture, channelId, body);
    }

    const owner = queryDatabase<{ id: string }>(
      fixture.dataDir,
      "SELECT id FROM member WHERE kind = 'owner'",
    )?.['id'] as string;

    // The rounds consumed their triggers: the last one is seq 5. The owner
    // has not read anything yet, so there is no row to confuse with it.
    assert.equal(await readPosition(fixture, agent, channelId), 5);
    assert.equal(await readPosition(fixture, owner, channelId), undefined);

    assert.equal((await markRead(fixture, channelId, { last_read_seq: 2 })).status, 200);
    assert.equal(await readPosition(fixture, owner, channelId), 2);
    assert.equal(
      await readPosition(fixture, agent, channelId),
      5,
      'the owner’s read position is a different row from the Agent’s cursor',
    );
    assert.equal((await getWorkspace(fixture))['unread_total'], 2);

    await fixture.restart();

    // The reading is recomputed from the persisted rows; both positions are
    // unchanged.
    assert.equal((await getWorkspace(fixture))['unread_total'], 2);
    assert.equal(await readPosition(fixture, owner, channelId), 2);
    assert.equal(await readPosition(fixture, agent, channelId), 5);

    // A post-restart read keeps moving the same persistent row.
    assert.equal((await markRead(fixture, channelId, { last_read_seq: 999 })).status, 200);
    assert.equal((await getWorkspace(fixture))['unread_total'], 0);
    await fixture.restart();
    assert.equal((await getWorkspace(fixture))['unread_total'], 0);
    assert.equal(await readPosition(fixture, owner, channelId), 6);
  } finally {
    await fixture.stop();
  }
});
