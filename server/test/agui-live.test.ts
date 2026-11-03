import assert from 'node:assert/strict';
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

/**
 * The live orchestration run at the one seam: a real backend process, a
 * temporary data directory and the scripted double injected through startup
 * arguments. The run's job is the human message write plus the rounds that
 * message wakes; the rounds themselves are the same module the backend paths
 * drive, and the AG-UI stream only observes the rows they commit.
 */

const RUN_PATH = '/api/copilotkit/agent/allibot/run';
const STOP_PATH = (threadId: string): string =>
  `/api/copilotkit/agent/allibot/stop/${encodeURIComponent(threadId)}`;

interface LiveFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface AguiEvent {
  type: string;
  [key: string]: unknown;
}

interface FixtureOptions {
  provider?: string;
  extraArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

async function startLiveFixture(prefix: string, options: FixtureOptions = {}): Promise<LiveFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: options.env,
    args: ['--scripted-provider', options.provider ?? 'reply', ...(options.extraArgs ?? [])],
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

function openDatabase(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true, timeout: 2_000 });
}

function queryAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function queryOne<T>(db: Database.Database, sql: string, params: unknown[] = []): T | undefined {
  return queryAll<T>(db, sql, params)[0];
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: LiveFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: LiveFixture, name: string): Promise<string> {
  const response = await postJson(fixture, '/api/channels', { name, description: `${name} 的直播契约` });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function createAgent(fixture: LiveFixture, displayName: string): Promise<string> {
  const response = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
    context_window: 16,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function joinChannel(fixture: LiveFixture, channelId: string, memberId: string): Promise<void> {
  const response = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function confirmConsent(fixture: LiveFixture): Promise<void> {
  const response = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
  assert.equal(response.status, 200, await response.clone().text());
}

function runRequest(
  fixture: LiveFixture,
  threadId: string,
  runId: string,
  messages: readonly Record<string, unknown>[],
): Promise<Response> {
  return fetch(`${fixture.base}${RUN_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({ threadId, runId, messages }),
  });
}

/** One incremental AG-UI event stream decoded from `data: <json>` frames. */
interface AguiStream {
  next(): Promise<AguiEvent>;
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
    async next(): Promise<AguiEvent> {
      if (queue.length === 0) {
        await fill();
      }
      const event = queue.shift();
      assert.ok(event !== undefined, 'the run stream ended before the expected event');
      return event;
    },
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

async function readEvents(response: Response): Promise<AguiEvent[]> {
  return await openAguiStream(response).rest();
}

function types(events: readonly AguiEvent[]): string[] {
  return events.map((event) => event.type);
}

interface TextGroup {
  messageId: string;
  contents: string[];
  closed: boolean;
}

function textGroups(events: readonly AguiEvent[]): TextGroup[] {
  const groups: TextGroup[] = [];
  for (const event of events) {
    const messageId = event['messageId'];
    if (event.type === 'TEXT_MESSAGE_START') {
      groups.push({ messageId: messageId as string, contents: [], closed: false });
      continue;
    }
    if (event.type === 'TEXT_MESSAGE_CONTENT') {
      const current = groups[groups.length - 1];
      assert.ok(current !== undefined, 'a content event must follow a start event');
      assert.equal(messageId, current.messageId, 'a text group never interleaves with another');
      current.contents.push(event['delta'] as string);
      continue;
    }
    if (event.type === 'TEXT_MESSAGE_END') {
      const current = groups[groups.length - 1];
      assert.ok(current !== undefined, 'an end event must follow a start event');
      assert.equal(messageId, current.messageId, 'a text group never interleaves with another');
      current.closed = true;
    }
  }
  return groups;
}

test('a live run persists the new user message before any text event, then streams one reply group per woken member', async () => {
  const fixture = await startLiveFixture('allibot-agui-live-order-', {
    extraArgs: ['--scripted-reply', '我看到了'],
  });
  const db = openDatabase(fixture.dataDir);
  try {
    const channelId = await createChannel(fixture, '直播频道');
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    const response = await runRequest(fixture, channelId, 'run-live-1', [
      { id: 'client-live-1', role: 'user', content: '大家怎么看？' },
    ]);
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(response.headers.get('content-type') ?? '', /^text\/event-stream/);

    const stream = openAguiStream(response);
    const events: AguiEvent[] = [];
    let humanRowAtFirstText:
      | { id: string; seq: number; kind: string; client_message_id: string | null }
      | undefined;
    for (;;) {
      let event: AguiEvent;
      try {
        event = await stream.next();
      } catch {
        break;
      }
      events.push(event);
      if (humanRowAtFirstText === undefined && event.type.startsWith('TEXT_MESSAGE_')) {
        humanRowAtFirstText = queryOne(
          db,
          'SELECT id, seq, kind, client_message_id FROM message WHERE target_id = ? AND client_message_id = ?',
          [channelId, 'client-live-1'],
        );
      }
    }

    const kinds = types(events);
    assert.equal(kinds[0], 'RUN_STARTED', `RUN_STARTED must open the run; got ${kinds.join(',')}`);
    assert.equal(
      kinds[kinds.length - 1],
      'RUN_FINISHED',
      `RUN_FINISHED must close a successful run; got ${kinds.join(',')}`,
    );
    assert.ok(!kinds.includes('RUN_ERROR'), 'a successful run carries no RUN_ERROR');

    const snapshotIndexes = kinds.flatMap((kind, index) =>
      kind === 'STATE_SNAPSHOT' ? [index] : [],
    );
    assert.deepEqual(snapshotIndexes, [1], 'the run starts with RUN_STARTED and one STATE_SNAPSHOT');
    const snapshot = events[1]?.['snapshot'] as {
      target_id?: string;
      members?: { member_id: string; display_name: string; avatar_slot: number }[];
    };
    assert.equal(snapshot.target_id, channelId);
    const memberIds = (snapshot.members ?? []).map((member) => member.member_id);
    assert.ok(memberIds.includes(first) && memberIds.includes(second));
    for (const member of snapshot.members ?? []) {
      assert.equal(typeof member.display_name, 'string');
      assert.equal(typeof member.avatar_slot, 'number');
    }

    // The human message is a stored row before the stream emits any text, and
    // it is the row the run wrote from its own user message.
    assert.ok(humanRowAtFirstText !== undefined, 'the human message is stored before the first text event');
    assert.equal(humanRowAtFirstText.kind, 'human');
    assert.equal(humanRowAtFirstText.client_message_id, 'client-live-1');
    assert.equal(humanRowAtFirstText.seq, 1);

    // Each woken member's reply is one contiguous group, keyed by the SQLite
    // message id; the relay chain is a backend-driven fact published on the
    // global SSE, so it is not streamed by this run.
    const groups = textGroups(events);
    assert.equal(groups.length, 2, `one reply group per woken member; got ${groups.length}`);
    for (const group of groups) {
      assert.ok(group.closed, 'every text group closes with TEXT_MESSAGE_END');
      assert.deepEqual(group.contents, ['我看到了']);
    }
    assert.equal(new Set(groups.map((group) => group.messageId)).size, 2);

    const rows = queryAll<{
      id: string;
      seq: number;
      kind: string;
      author_member_id: string;
      body: string;
    }>(
      db,
      "SELECT id, seq, kind, author_member_id, body FROM message WHERE target_id = ? AND kind = 'agent' ORDER BY seq",
      [channelId],
    );
    const rowById = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(
      groups.map((group) => rowById.get(group.messageId)?.author_member_id),
      [first, second],
      'the streamed ids are the persisted replies, in dispatch order',
    );
    for (const group of groups) {
      assert.equal(rowById.get(group.messageId)?.body, group.contents.join(''));
    }
  } finally {
    db.close();
    await fixture.stop();
  }
});

test('the same client message id lands one row across the run and the REST write, and a replayed run drives no round twice', async () => {
  const fixture = await startLiveFixture('allibot-agui-live-dedupe-', {
    extraArgs: ['--scripted-reply', '我看到了'],
  });
  const db = openDatabase(fixture.dataDir);
  try {
    const channelId = await createChannel(fixture, '去重频道');
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    const message = { id: 'client-dup-1', role: 'user', content: '第一句' };
    const firstRun = await runRequest(fixture, channelId, 'run-dup-1', [message]);
    assert.equal(firstRun.status, 200, await firstRun.clone().text());
    const firstEvents = await readEvents(firstRun);
    assert.ok(
      types(firstEvents).some((kind) => kind.startsWith('TEXT_MESSAGE_')),
      'the first run streams the members it woke',
    );

    const countRows = (kind?: string): number => {
      const row = queryOne<{ total: number }>(
        db,
        kind === undefined
          ? 'SELECT count(*) AS total FROM message WHERE target_id = ?'
          : 'SELECT count(*) AS total FROM message WHERE target_id = ? AND kind = ?',
        kind === undefined ? [channelId] : [channelId, kind],
      );
      return row?.total ?? 0;
    };
    const countOutcomes = (): number => {
      const row = queryOne<{ total: number }>(
        db,
        'SELECT count(*) AS total FROM round_outcome WHERE target_id = ?',
        [channelId],
      );
      return row?.total ?? 0;
    };
    const messagesAfterFirst = countRows();
    const outcomesAfterFirst = countOutcomes();
    const human = queryOne<{ id: string; seq: number }>(
      db,
      'SELECT id, seq FROM message WHERE target_id = ? AND client_message_id = ?',
      [channelId, 'client-dup-1'],
    );
    assert.ok(human !== undefined, 'the first run wrote the human message');
    assert.equal(human.seq, 1);
    assert.ok(countRows('human') === 1, 'one human row for the client message');

    // The same run input again: the client id replays, nothing is written and
    // no round is driven a second time.
    const replayRun = await runRequest(fixture, channelId, 'run-dup-2', [message]);
    assert.equal(replayRun.status, 200, await replayRun.clone().text());
    const replayEvents = await readEvents(replayRun);
    assert.ok(
      !types(replayEvents).some((kind) => kind.startsWith('TEXT_MESSAGE_')),
      'a replayed run streams no reply',
    );
    assert.equal(types(replayEvents).at(-1), 'RUN_FINISHED');
    assert.equal(countRows(), messagesAfterFirst, 'the replay wrote no message');
    assert.equal(countOutcomes(), outcomesAfterFirst, 'the replay drove no round');
    assert.equal(countRows('human'), 1);

    // The non-UI REST entry shares the same client id key: re-posting it
    // replays the run's row instead of appending a second message.
    const reposted = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '同一句但换个正文',
      client_message_id: 'client-dup-1',
    });
    assert.equal(reposted.status, 201, await reposted.clone().text());
    const repostedBody = await readJson(reposted);
    assert.equal(repostedBody['id'], human.id, 'the REST replay resolves to the run-written row');
    assert.equal(repostedBody['seq'], human.seq);
    assert.equal(countRows(), messagesAfterFirst, 'the REST replay wrote no message');
    assert.equal(countOutcomes(), outcomesAfterFirst, 'the REST replay drove no round');

    // A hydrated thread sends the stored SQLite id back as the AG-UI id; that
    // is the same message, not a new one.
    const hydratedRun = await runRequest(fixture, channelId, 'run-dup-3', [
      { id: human.id, role: 'user', content: '第一句' },
    ]);
    assert.equal(hydratedRun.status, 200, await hydratedRun.clone().text());
    const hydratedEvents = await readEvents(hydratedRun);
    assert.ok(
      !types(hydratedEvents).some((kind) => kind.startsWith('TEXT_MESSAGE_')),
      'a hydrated history message wakes nobody',
    );
    assert.equal(countRows(), messagesAfterFirst, 'the hydrated message wrote no duplicate row');
    assert.equal(countOutcomes(), outcomesAfterFirst);
  } finally {
    db.close();
    await fixture.stop();
  }
});

async function readAgentStatus(fixture: LiveFixture, agentId: string): Promise<string> {
  const response = await fetch(`${fixture.base}/api/agents/${agentId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['status'] as string;
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (done(last)) {
      return last;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}; last value: ${JSON.stringify(last)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('cancelling a delayed run closes the round as a human interrupt with no reply message', async () => {
  const fixture = await startLiveFixture('allibot-agui-live-cancel-', {
    provider: 'delay',
    extraArgs: ['--scripted-delay-ms', '1500'],
    env: { OPENAI_API_KEY: 'sk-live-cancel' },
  });
  const db = openDatabase(fixture.dataDir);
  try {
    const channelId = await createChannel(fixture, '取消频道');
    const agentId = await createAgent(fixture, '慢工');
    await confirmConsent(fixture);
    await joinChannel(fixture, channelId, agentId);

    const response = await runRequest(fixture, channelId, 'run-cancel-1', [
      { id: 'client-cancel-1', role: 'user', content: '请慢慢回答' },
    ]);
    // Do not read (a clone of) the body here: draining it would wait for the
    // whole delayed run and close the window this test cancels in.
    assert.equal(response.status, 200);
    const stream = openAguiStream(response);
    const events: AguiEvent[] = [];

    // Wait until the run has opened its snapshot and the delayed round is in
    // flight; the status point reads the process-local in-flight fact.
    const first = await stream.next();
    events.push(first);
    assert.equal(first.type, 'RUN_STARTED');
    const snapshot = await stream.next();
    events.push(snapshot);
    assert.equal(snapshot.type, 'STATE_SNAPSHOT');
    await waitFor(
      () => readAgentStatus(fixture, agentId),
      (status) => status === 'working',
      'the delayed round to be in flight',
    );

    const stopped = await postJson(fixture, STOP_PATH(channelId), { runId: 'run-cancel-1' });
    assert.equal(stopped.status, 200, await stopped.clone().text());
    const stoppedBody = await readJson(stopped);
    assert.equal(stoppedBody['stopped'], true, 'the runtime stops the active run');

    events.push(...(await stream.rest()));
    const kinds = types(events);
    assert.ok(
      !kinds.some((kind) => kind.startsWith('TEXT_MESSAGE_')),
      `a cancelled run streams no reply; got ${kinds.join(',')}`,
    );
    const terminal = events[events.length - 1];
    assert.equal(terminal?.type, 'RUN_FINISHED', `the run ends with the agreed event; got ${kinds.join(',')}`);
    assert.deepEqual(
      terminal?.['outcome'],
      { type: 'cancelled' },
      'the terminal event carries the protocol cancelled outcome',
    );

    const outcome = await waitFor(
      () =>
        queryOne<{ status: string; finished_reason: string | null; reason: string }>(
          db,
          'SELECT status, finished_reason, reason FROM round_outcome WHERE target_id = ? ORDER BY rowid DESC',
          [channelId],
        ) ?? null,
      (row) => row !== null,
      'the interrupted round outcome',
    );
    assert.ok(outcome !== null, 'the interrupted round closed with an outcome row');
    assert.equal(outcome.finished_reason, ZH_CN['round.finished.humanInterrupt'].text);
    assert.equal(outcome.status, 'failed', 'an interrupted round does not reply');
    assert.match(outcome.reason, /人类中断/);
    const replies = queryOne<{ total: number }>(
      db,
      "SELECT count(*) AS total FROM message WHERE target_id = ? AND kind = 'agent'",
      [channelId],
    );
    assert.equal(replies?.total, 0, 'the human interrupt lands no reply message');
    const human = queryOne<{ total: number }>(
      db,
      "SELECT count(*) AS total FROM message WHERE target_id = ? AND kind = 'human'",
      [channelId],
    );
    assert.equal(human?.total, 1, 'the user message that started the run stays stored');
  } finally {
    db.close();
    await fixture.stop();
  }
});

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

test('the backend claim and the live run drive one orchestration: every provider call closes exactly one round', async () => {
  const fixture = await startLiveFixture('allibot-agui-live-calls-', {
    extraArgs: ['--scripted-reply', '我看到了', '--scripted-report-calls'],
    env: { OPENAI_API_KEY: 'sk-live-calls' },
  });
  const db = openDatabase(fixture.dataDir);
  try {
    const channelId = await createChannel(fixture, '单一编排频道');
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    await confirmConsent(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    // Backend-driven path: creating a task wakes the first available
    // auto-claim member and runs that round without any AG-UI run.
    const created = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '认领这件事',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const task = await readJson(created);
    assert.equal(task['status'], 'in_progress', 'the claim ran as a backend-driven round');

    // Live path: the run writes its user message and drives the rounds that
    // message wakes, streaming the direct replies.
    const run = await runRequest(fixture, channelId, 'run-calls-1', [
      { id: 'client-calls-1', role: 'user', content: '大家继续' },
    ]);
    assert.equal(run.status, 200, await run.clone().text());
    const events = await readEvents(run);
    assert.equal(types(events).at(-1), 'RUN_FINISHED', 'the run completed');
    assert.ok(
      types(events).filter((kind) => kind === 'TEXT_MESSAGE_START').length >= 2,
      'the run streamed the members it woke',
    );

    const callNumbers = queryAll<{ body: string }>(
      db,
      "SELECT body FROM message WHERE kind = 'agent' ORDER BY seq",
    ).flatMap((row) =>
      [...row.body.matchAll(/^calls:(\d+)$/gm)].map((match) => Number(match[1])),
    );
    const calls = callNumbers.sort((left, right) => left - right);
    assert.ok(calls.length >= 3, `claim plus the live run called the provider; got ${calls.length}`);
    assert.deepEqual(
      calls,
      Array.from({ length: calls.length }, (_, index) => index + 1),
      'the provider ordinals are contiguous: one provider instance served every round',
    );

    const realRounds = queryAll<{ status: string }>(
      db,
      "SELECT status FROM round_outcome WHERE status NOT IN ('merged', 'budget-exhausted')",
    );
    assert.equal(calls.length, realRounds.length, 'every provider call closed exactly one round outcome');
    assert.equal(
      realRounds.filter((row) => row.status === 'replied').length,
      calls.length,
      'the reply behaviour answers every round it ran',
    );
    const duplicated = queryAll<{ total: number }>(
      db,
      `SELECT count(*) AS total FROM (
         SELECT member_id, target_id, base_seq, count(*) AS rounds
           FROM round_outcome WHERE merged = 0
          GROUP BY member_id, target_id, base_seq HAVING rounds > 1)`,
    );
    assert.equal(duplicated[0]?.total, 0, 'no wake was executed twice');

    // The REST replay of the run's client id drives no further round (and so
    // no further provider call), sharing the same write path.
    const replay = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '大家继续',
      client_message_id: 'client-calls-1',
    });
    assert.equal(replay.status, 201, await replay.clone().text());
    const afterReplay = queryAll<{ status: string }>(
      db,
      "SELECT status FROM round_outcome WHERE status NOT IN ('merged', 'budget-exhausted')",
    );
    assert.equal(afterReplay.length, realRounds.length, 'the replay executed no round');
    const replayCalls = queryAll<{ body: string }>(
      db,
      "SELECT body FROM message WHERE kind = 'agent' ORDER BY seq",
    ).flatMap((row) => [...row.body.matchAll(/^calls:(\d+)$/gm)].map((match) => Number(match[1])));
    assert.equal(replayCalls.length, calls.length, 'the replay called the provider no further time');
  } finally {
    db.close();
    await fixture.stop();
  }
});

test('the HTTP face accepts no member identity and no budget usage write; the CopilotKit handler is the only run face', async () => {
  const fixture = await startLiveFixture('allibot-agui-live-identity-', {
    extraArgs: ['--scripted-reply', '好'],
  });
  const db = openDatabase(fixture.dataDir);
  try {
    const channelId = await createChannel(fixture, '身份频道');
    const agentId = await createAgent(fixture, '甲');
    await joinChannel(fixture, channelId, agentId);

    // A member identity in the message body is an unknown field: the human
    // face never claims to be a member.
    const forgedAuthor = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '我是成员',
      author_member_id: agentId,
    });
    assert.equal(forgedAuthor.status, 400);
    assert.equal(errorCode(await readJson(forgedAuthor)), 'validation_failed');

    const forgedKind = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '以成员名义',
      kind: 'agent',
    });
    assert.equal(forgedKind.status, 400);
    assert.equal(errorCode(await readJson(forgedKind)), 'validation_failed');

    const token = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '带令牌',
      agent_token: 'member-token',
    });
    assert.equal(token.status, 400, 'there is no agent token field on the human face');

    // Identity headers are ignored, not trusted: the row is authored by the
    // owner regardless of what the caller claims.
    const headerSpoofed = await fetch(`${fixture.base}/api/targets/${channelId}/messages`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-allibot-member-id': agentId,
        authorization: 'Bearer member-token',
      },
      body: JSON.stringify({ body: '头里带身份' }),
    });
    assert.equal(headerSpoofed.status, 201, await headerSpoofed.clone().text());
    const owner = queryOne<{ id: string }>(db, "SELECT id FROM member WHERE kind = 'owner'");
    const stored = queryOne<{ author_member_id: string }>(
      db,
      'SELECT author_member_id FROM message WHERE target_id = ? AND body = ?',
      [channelId, '头里带身份'],
    );
    assert.ok(owner !== undefined);
    assert.equal(stored?.author_member_id, owner.id, 'HTTP never carries member identity');

    // No human-face route writes the canonical usage fact.
    const budgetWrite = await fetch(`${fixture.base}/api/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ used: 9 }),
    });
    assert.equal(budgetWrite.status, 400);
    assert.equal(errorCode(await readJson(budgetWrite)), 'validation_failed');
    const budget = queryOne<{ used: number }>(
      db,
      'SELECT used FROM target_budget WHERE target_id = ?',
      [channelId],
    );
    assert.ok((budget?.used ?? 0) === 0, 'the human face cannot raise the used jump count');

    // The CopilotKit handler is the only run face: no REST path accepts a run.
    for (const route of [
      `/api/targets/${channelId}/run`,
      `/api/agents/${agentId}/run`,
      `/api/runs`,
    ]) {
      const response = await postJson(fixture, route, {});
      assert.equal(response.status, 404, `${route} is not a run face`);
      assert.equal(errorCode(await readJson(response)), 'not_found');
    }
  } finally {
    db.close();
    await fixture.stop();
  }
});

const UPLOAD_BOUNDARY = '----allibotLiveBoundary';

/** One small multipart upload body, byte for byte what `curl -F` sends. */
function uploadBody(filename: string, bytes: Buffer, contentType: string): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${UPLOAD_BOUNDARY}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`,
      'utf8',
    ),
    bytes,
    Buffer.from(`\r\n--${UPLOAD_BOUNDARY}--\r\n`),
  ]);
}

async function uploadDraft(fixture: LiveFixture, filename: string): Promise<string> {
  const response = await fetch(`${fixture.base}/api/attachments`, {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${UPLOAD_BOUNDARY}` },
    body: uploadBody(filename, Buffer.from(`附件 ${filename}`, 'utf8'), 'text/plain'),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

test('the run binds the message metadata attachments in the same transaction as the human row', async () => {
  const fixture = await startLiveFixture('allibot-agui-live-attach-', {
    extraArgs: ['--scripted-reply', '收到附件'],
  });
  const db = openDatabase(fixture.dataDir);
  try {
    const channelId = await createChannel(fixture, '附件频道');
    const agentId = await createAgent(fixture, '甲');
    await joinChannel(fixture, channelId, agentId);
    const attachmentId = await uploadDraft(fixture, '计划.txt');

    const run = await runRequest(fixture, channelId, 'run-attach-1', [
      {
        id: 'client-attach-1',
        role: 'user',
        content: '请看附件',
        metadata: { attachment_ids: [attachmentId] },
      },
    ]);
    assert.equal(run.status, 200, await run.clone().text());
    const events = await readEvents(run);
    assert.equal(types(events).at(-1), 'RUN_FINISHED');

    const human = queryOne<{ id: string }>(
      db,
      'SELECT id FROM message WHERE target_id = ? AND client_message_id = ?',
      [channelId, 'client-attach-1'],
    );
    assert.ok(human !== undefined);
    const bound = queryOne<{ message_id: string | null; filename: string }>(
      db,
      'SELECT message_id, filename FROM attachment WHERE id = ?',
      [attachmentId],
    );
    assert.equal(bound?.message_id, human.id, 'the attachment bound to the human row');
    assert.equal(bound?.filename, '计划.txt');

    const read = await fetch(`${fixture.base}/api/targets/${channelId}/messages`);
    assert.equal(read.status, 200);
    const listed = (await readJson(read))['messages'] as Record<string, unknown>[];
    const first = listed.find((message) => message['id'] === human.id);
    assert.deepEqual(
      (first?.['attachments'] as { id: string }[]).map((attachment) => attachment.id),
      [attachmentId],
      'the read path exposes the bound attachment',
    );

    // An unknown draft id aborts the whole run before any row lands; the
    // message and its binding share one transaction.
    const before = queryAll<{ total: number }>(
      db,
      'SELECT count(*) AS total FROM message WHERE target_id = ?',
      [channelId],
    )[0]?.total;
    const failed = await runRequest(fixture, channelId, 'run-attach-2', [
      { id: 'client-attach-2', role: 'user', content: '坏的附件', metadata: { attachment_ids: ['no-such-draft'] } },
    ]);
    assert.equal(failed.status, 200, 'the stream opens; the failure is an event');
    const failedEvents = await readEvents(failed);
    assert.equal(types(failedEvents).at(-1), 'RUN_ERROR', 'an unknown draft fails the run');
    const after = queryAll<{ total: number }>(
      db,
      'SELECT count(*) AS total FROM message WHERE target_id = ?',
      [channelId],
    )[0]?.total;
    assert.equal(after, before, 'the failed run wrote no message');
  } finally {
    db.close();
    await fixture.stop();
  }
});
