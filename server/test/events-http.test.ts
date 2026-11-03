import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 订阅 (Subscription): the one global live stream at GET /api/events, observed
 * only from the process-level HTTP seam. These tests read the frames a real
 * connection receives, the rotate frame that ends a connection's life, and the
 * frames that deliberately do not arrive (live-only: no backlog, no `id:`).
 */

interface EventsFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface SseFrame {
  readonly event: string;
  readonly data: string;
  readonly lines: readonly string[];
  readonly raw: string;
}

async function startEventsFixture(
  prefix: string,
  options: {
    provider?: 'reply' | 'ignore';
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<EventsFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: options.env,
    args: ['--scripted-provider', options.provider ?? 'ignore', ...(options.args ?? [])],
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
  fixture: EventsFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: EventsFixture, name = '订阅频道'): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: EventsFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: EventsFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: EventsFixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function listMessages(
  fixture: EventsFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
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

/**
 * One open subscription, read frame by frame. The connection is a real fetch
 * against a real server process; closing it aborts the request, which is what
 * a browser does when its tab goes away.
 */
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

  static async open(
    url: string,
    headers: Record<string, string> = {},
  ): Promise<SseConnection> {
    const abort = new AbortController();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream', ...headers },
      signal: abort.signal,
    });
    const body = response.body;
    assert.ok(body !== null, 'the subscription should carry a body stream');
    return new SseConnection(abort, body.getReader(), response);
  }

  /** The next frame, or null once the server closed the connection. */
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

/**
 * Read frames until one of `type` arrives. Workspace writes (channel / agent
 * / settings) publish their own frames, so a test that observes one business
 * fact skips the frames it is not asserting on.
 */
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

/** Consume frames for `timeoutMs`; returns the ones that arrived. */
async function drainFrames(
  stream: SseConnection,
  timeoutMs = 300,
): Promise<SseFrame[]> {
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

/** The stream never carries an `id:` line: there is no Last-Event-ID protocol. */
function assertNoEventId(frame: SseFrame): void {
  assert.ok(
    !frame.lines.some((line) => line.startsWith('id:')),
    `the stream must not carry an id: line; got:\n${frame.raw}`,
  );
}

test('a stored message streams one live message.created frame with target, message and seq', async () => {
  const fixture = await startEventsFixture('allibot-events-message-');
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    assert.match(
      stream.response.headers.get('content-type') ?? '',
      /^text\/event-stream/,
      'the subscription answers with text/event-stream',
    );
    assert.equal(stream.response.headers.get('cache-control'), 'no-cache');

    const channelId = await createChannel(fixture);
    const posted = await postMessage(fixture, channelId, { body: '第一句' });

    const frame = await nextOfType(stream, 'message.created');
    assert.deepEqual(JSON.parse(frame.data), {
      target_id: channelId,
      message_id: posted['id'],
      seq: 1,
    });
    assert.deepEqual(
      frame.lines.map((line) => line.split(':')[0]),
      ['event', 'data'],
      'a frame is exactly one event line and one data line',
    );
    assertNoEventId(frame);
  } finally {
    await stream.close();
    await fixture.stop();
  }
});

test('a channel-level message read still answers and the stream carries nothing extra', async () => {
  const fixture = await startEventsFixture('allibot-events-read-');
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture);
    assert.deepEqual(await listMessages(fixture, channelId), [], 'a read writes nothing');

    const posted = await postMessage(fixture, channelId, { body: '只有这一句' });
    const frame = await nextOfType(stream, 'message.created');
    assert.deepEqual(JSON.parse(frame.data), {
      target_id: channelId,
      message_id: posted['id'],
      seq: 1,
    });

    // No second message.created frame: a read never produces one. The frames
    // the channel's own create published are not message reads.
    const extra = await drainFrames(stream, 300);
    assert.equal(
      extra.filter((candidate) => candidate.event === 'message.created').length,
      0,
      `a read writes nothing; saw: ${extra.map((candidate) => candidate.event).join(', ')}`,
    );
  } finally {
    await stream.close();
    await fixture.stop();
  }
});

test('a replayed write (same client message id) announces nothing', async () => {
  const fixture = await startEventsFixture('allibot-events-replay-');
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture);
    const body = { body: '只写一次', client_message_id: 'client-1' };
    const first = await postMessage(fixture, channelId, body);
    const second = await postMessage(fixture, channelId, body);
    assert.equal(second['id'], first['id'], 'the replay returns the same message');

    const frame = await nextOfType(stream, 'message.created');
    assert.equal((JSON.parse(frame.data) as Record<string, unknown>)['seq'], 1);

    const extra = await drainFrames(stream, 300);
    assert.equal(
      extra.filter((candidate) => candidate.event === 'message.created').length,
      0,
      'a replay writes nothing, so it announces no message',
    );
    assert.equal((await listMessages(fixture, channelId)).length, 1);
  } finally {
    await stream.close();
    await fixture.stop();
  }
});

test('a round streams its reply as message.created and its outcome as round.outcome', async () => {
  const fixture = await startEventsFixture('allibot-events-round-', { provider: 'reply' });
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const human = await postMessage(fixture, channelId, { body: '大家怎么看' });

    const first = await nextOfType(stream, 'message.created');
    assert.deepEqual(JSON.parse(first.data), {
      target_id: channelId,
      message_id: human['id'],
      seq: 1,
    });

    const reply = await nextOfType(stream, 'message.created');
    const replyData = JSON.parse(reply.data) as Record<string, unknown>;
    assert.equal(replyData['target_id'], channelId);
    assert.equal(replyData['seq'], 2, 'the round reply is the second message in the target');
    assertNoEventId(reply);

    const outcome = await nextOfType(stream, 'round.outcome');
    assert.deepEqual(JSON.parse(outcome.data), {
      target_id: channelId,
      member_id: agent,
      status: 'replied',
    });
    assertNoEventId(outcome);

    // The frame names the persisted row, not an invented id.
    const messages = await listMessages(fixture, channelId);
    assert.equal(replyData['message_id'], messages[1]?.['id']);
  } finally {
    await stream.close();
    await fixture.stop();
  }
});

test('two connections over two targets each receive both kinds of frames, told apart by target_id', async () => {
  const fixture = await startEventsFixture('allibot-events-two-targets-', { provider: 'reply' });
  const first = await SseConnection.open(`${fixture.base}/api/events`);
  const second = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelA = await createChannel(fixture, '频道甲');
    const channelB = await createChannel(fixture, '频道乙');
    await joinChannel(fixture, channelA, agent);
    await joinChannel(fixture, channelB, agent);

    await postMessage(fixture, channelA, { body: '甲这边' });
    await postMessage(fixture, channelB, { body: '乙这边' });

    for (const [name, stream] of [
      ['first', first],
      ['second', second],
    ] as const) {
      const frames: SseFrame[] = [];
      for (let index = 0; index < 16; index += 1) {
        const frame = await stream.next();
        assert.ok(frame !== null, `${name} should stay open`);
        frames.push(frame);
        const outcomes = frames.filter((candidate) => candidate.event === 'round.outcome');
        const changes = frames.filter((candidate) => candidate.event === 'unread.changed');
        if (outcomes.length === 2 && changes.length === 2) {
          break;
        }
      }
      const created = frames
        .filter((frame) => frame.event === 'message.created')
        .map((frame) => {
          const data = JSON.parse(frame.data) as Record<string, unknown>;
          return `${String(data['target_id'])}|${String(data['seq'])}`;
        })
        .sort();
      // Both targets' messages reach this one connection: the subscription is
      // not per target, and each frame names its own owner.
      assert.deepEqual(created, [`${channelA}|1`, `${channelA}|2`, `${channelB}|1`, `${channelB}|2`].sort());

      const outcomes = frames.filter((frame) => frame.event === 'round.outcome');
      assert.equal(outcomes.length, 2, `${name} sees one round outcome per target`);
      for (const outcomeFrame of outcomes) {
        const outcome = JSON.parse(outcomeFrame.data) as Record<string, unknown>;
        assert.ok([channelA, channelB].includes(outcome['target_id'] as string));
        assert.equal(outcome['member_id'], agent);
        assert.equal(outcome['status'], 'replied');
      }

      // Each Agent reply raises that target's owner unread reading.
      const changes = frames
        .filter((frame) => frame.event === 'unread.changed')
        .map((frame) => JSON.parse(frame.data) as Record<string, unknown>);
      assert.deepEqual(
        changes.map((data) => `${String(data['target_id'])}|${String(data['unread_count'])}`).sort(),
        [`${channelA}|1`, `${channelB}|1`].sort(),
      );
    }
  } finally {
    await first.close();
    await second.close();
    await fixture.stop();
  }
});

test('the per-target subscription is a 404, and it is not swallowed by the channel routes', async () => {
  const fixture = await startEventsFixture('allibot-events-per-target-');
  try {
    const channelId = await createChannel(fixture);
    const response = await fetch(`${fixture.base}/api/channels/${channelId}/events`, {
      headers: { accept: 'text/event-stream' },
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);
    const body = await readJson(response);
    assert.equal((body['error'] as Record<string, unknown>)['code'], 'not_found');

    const unknown = await fetch(`${fixture.base}/api/channels/does-not-exist/events`);
    assert.equal(unknown.status, 404, 'the route answers 404 before it reads the channel');
  } finally {
    await fixture.stop();
  }
});

test('the lifetime ends with a rotate frame and a close; a reconnect starts live with no backlog', async () => {
  const fixture = await startEventsFixture('allibot-events-rotate-', {
    args: ['--sse-lifetime-ms', '3000'],
  });
  try {
    const channelId = await createChannel(fixture);
    // Written while no connection is open: a later connection must not replay it.
    const offline = await postMessage(fixture, channelId, { body: '断开期间' });

    const live = await SseConnection.open(`${fixture.base}/api/events`, {
      'last-event-id': '99',
    });
    try {
      const posted = await postMessage(fixture, channelId, { body: '重连后' });
      const message = await live.next();
      assert.ok(message !== null, 'the connection stays open until its lifetime ends');
      assert.equal(message.event, 'message.created');
      const data = JSON.parse(message.data) as Record<string, unknown>;
      assert.equal(data['message_id'], posted['id'], 'the first frame is the live message');
      assert.notEqual(
        data['message_id'],
        offline['id'],
        'Last-Event-ID is ignored: the frame written while disconnected is not replayed',
      );
      assertNoEventId(message);

      const rotate = await live.next();
      assert.ok(rotate !== null, 'the server closes the connection itself rather than dropping it');
      assert.equal(rotate.event, 'rotate');
      assert.deepEqual(JSON.parse(rotate.data), {}, 'the rotate frame carries no business data');
      assertNoEventId(rotate);
      assert.equal(await live.next(), null, 'the connection is closed right after the rotate frame');
    } finally {
      await live.close();
    }

    // A reconnect succeeds and, like every fresh subscription, only sees what
    // is published after it.
    const reconnected = await SseConnection.open(`${fixture.base}/api/events`);
    try {
      const posted = await postMessage(fixture, channelId, { body: '再连一次' });
      const frame = await reconnected.next();
      assert.ok(frame !== null);
      assert.equal(frame.event, 'message.created');
      assert.equal(
        (JSON.parse(frame.data) as Record<string, unknown>)['message_id'],
        posted['id'],
      );
    } finally {
      await reconnected.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('AG-UI events are a different endpoint and never appear on /api/events', async () => {
  const fixture = await startEventsFixture('allibot-events-agui-');
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const run = await fetch(`${fixture.base}/api/copilotkit/agent/allibot/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({
        threadId: channelId,
        runId: 'run-events-1',
        messages: [{ id: 'run-events-1-user', role: 'user', content: '你好' }],
      }),
    });
    assert.equal(run.status, 200, await run.clone().text());
    const aguiText = await run.text();
    assert.match(aguiText, /"type":"RUN_STARTED"/, 'the AG-UI stream is the run endpoint');

    const posted = await postMessage(fixture, channelId, { body: '订阅只看落库' });
    // The run's own persisted reply is a stored row, so it is relayed like any
    // other; what must never cross over is the AG-UI event vocabulary.
    let frame = await stream.next();
    let sawPosted = false;
    for (let index = 0; index < 10 && frame !== null; index += 1) {
      assert.ok(
        !frame.raw.includes('RUN_STARTED') &&
          !frame.raw.includes('TEXT_MESSAGE') &&
          !frame.raw.includes('STATE_SNAPSHOT') &&
          !frame.raw.includes('RUN_FINISHED'),
        `AG-UI frames do not cross over: ${frame.raw}`,
      );
      const data = JSON.parse(frame.data) as Record<string, unknown>;
      if (data['message_id'] === posted['id']) {
        sawPosted = true;
        break;
      }
      frame = await stream.next();
    }
    assert.ok(sawPosted, 'the ordinary stored message arrives on the subscription');
  } finally {
    await stream.close();
    await fixture.stop();
  }
});

test('an open subscription does not hold the server open: SIGTERM still shuts it down', async () => {
  const fixture = await startEventsFixture('allibot-events-shutdown-');
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    await createChannel(fixture);
    const startedAt = Date.now();
    await fixture.running.stop();
    const elapsed = Date.now() - startedAt;
    assert.ok(
      elapsed < 4_000,
      `the server should shut down without waiting for the stream timeout; took ${elapsed}ms`,
    );
  } finally {
    await stream.close();
    await removeTempDir(fixture.dataDir);
  }
});

test('member.status, task.changed and workspace.changed publish after their writes commit', async () => {
  const fixture = await startEventsFixture('allibot-events-workspace-frames-', {
    provider: 'reply',
    env: { OPENAI_API_KEY: 'sk-events-test' },
  });
  const stream = await SseConnection.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture);
    const channelChanged = await nextOfType(stream, 'workspace.changed');
    assert.deepEqual(JSON.parse(channelChanged.data), { source: 'channel' });

    const agent = await createAgent(fixture, '甲');
    const agentFrames = [await stream.next(), await stream.next()];
    const workspaceAgent = agentFrames.find((frame) => frame?.event === 'workspace.changed');
    assert.ok(workspaceAgent !== undefined && workspaceAgent !== null);
    assert.deepEqual(JSON.parse(workspaceAgent.data), { source: 'agent' });
    const offline = agentFrames.find((frame) => frame?.event === 'member.status');
    assert.ok(offline !== undefined && offline !== null);
    assert.deepEqual(JSON.parse(offline.data), { member_id: agent, status: 'offline' });

    const settings = await fetch(`${fixture.base}/api/settings`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ density: 'compact' }),
    });
    assert.equal(settings.status, 200);
    const settingsChanged = await nextOfType(stream, 'workspace.changed');
    assert.deepEqual(JSON.parse(settingsChanged.data), { source: 'settings' });

    const taskResponse = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '发帧任务',
    });
    assert.equal(taskResponse.status, 201);
    const task = await readJson(taskResponse);
    const created = await nextOfType(stream, 'task.changed');
    assert.deepEqual(JSON.parse(created.data), {
      task_id: task['id'],
      target_id: task['target_id'],
      status: 'todo',
    });

    const transition = await fetch(`${fixture.base}/api/tasks/${String(task['id'])}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ status: 'in_progress' }),
    });
    assert.equal(transition.status, 200);
    const changed = await nextOfType(stream, 'task.changed');
    assert.deepEqual(JSON.parse(changed.data), {
      task_id: task['id'],
      target_id: task['target_id'],
      status: 'in_progress',
    });

    // Make the Agent available, then a human message moves its point through
    // working -> online.
    const consent = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    assert.equal(consent.status, 200);
    await joinChannel(fixture, channelId, agent);
    await postMessage(fixture, channelId, { body: '请回应' });

    const statuses: string[] = [];
    const deadline = Date.now() + 8_000;
    while (statuses.length < 2 && Date.now() < deadline) {
      const frame = await nextOfType(stream, 'member.status');
      const data = JSON.parse(frame.data) as Record<string, unknown>;
      if (data['member_id'] === agent) {
        statuses.push(String(data['status']));
      }
    }
    assert.deepEqual(statuses, ['working', 'online']);
  } finally {
    await stream.close();
    await fixture.stop();
  }
});
