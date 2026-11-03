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
  options: { provider?: 'reply' | 'ignore'; args?: readonly string[] } = {},
): Promise<EventsFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
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

    const frame = await stream.next();
    assert.ok(frame !== null, 'the connection should stay open');
    assert.equal(frame.event, 'message.created');
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
    const frame = await stream.next();
    assert.ok(frame !== null);
    assert.equal(frame.event, 'message.created');
    assert.deepEqual(JSON.parse(frame.data), {
      target_id: channelId,
      message_id: posted['id'],
      seq: 1,
    });

    // No second frame: a read never produces an event.
    await assert.rejects(stream.next(300), /no SSE frame within/);
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

    const frame = await stream.next();
    assert.ok(frame !== null);
    assert.equal(frame.event, 'message.created');
    assert.equal((JSON.parse(frame.data) as Record<string, unknown>)['seq'], 1);

    await assert.rejects(
      stream.next(300),
      /no SSE frame within/,
      'a replay writes nothing, so it announces nothing',
    );
    assert.equal((await listMessages(fixture, channelId)).length, 1);
  } finally {
    await stream.close();
    await fixture.stop();
  }
});
