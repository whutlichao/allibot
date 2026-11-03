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
 * The AG-UI contract of the one orchestration agent, observed only through the
 * CopilotKit multi-route handler: the run stream's event order, the messageId
 * → SQLite `message.id` mapping, the threadId → target mapping and the
 * multi-route status codes. Nothing here reaches into the agent object; the
 * events are the observation face, the message rows stay the source of truth.
 */

interface AguiFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface AguiEvent {
  type: string;
  [key: string]: unknown;
}

const RUN_PATH = '/api/copilotkit/agent/allibot/run';

async function startAguiFixture(prefix: string): Promise<AguiFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir);
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

function queryAll<T>(dataDir: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function createChannel(fixture: AguiFixture, name: string): Promise<string> {
  const response = await fetch(`${fixture.base}/api/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, description: `${name} 的 AG-UI 契约` }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function createAgent(fixture: AguiFixture, displayName: string): Promise<string> {
  const response = await fetch(`${fixture.base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      display_name: displayName,
      context_window: 16,
      compression_threshold: 0.8,
      max_iterations: 4,
    }),
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function joinChannel(fixture: AguiFixture, channelId: string, memberId: string): Promise<void> {
  const response = await fetch(`${fixture.base}/api/channels/${channelId}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ member_id: memberId }),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

interface SeededTarget {
  channelId: string;
  agentIds: string[];
}

/** A target with the owner, two Agent members and one human message. */
async function seedTarget(fixture: AguiFixture, prefix: string): Promise<SeededTarget> {
  const channelId = await createChannel(fixture, prefix);
  const agentIds = [
    await createAgent(fixture, `${prefix} 甲`),
    await createAgent(fixture, `${prefix} 乙`),
  ];
  for (const agentId of agentIds) {
    await joinChannel(fixture, channelId, agentId);
  }
  const posted = await fetch(`${fixture.base}/api/targets/${channelId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ body: '大家怎么看？' }),
  });
  assert.equal(posted.status, 201, await posted.clone().text());
  return { channelId, agentIds };
}

function runRequest(
  fixture: AguiFixture,
  threadId: string,
  runId: string,
  userText: string,
): Promise<Response> {
  return fetch(`${fixture.base}${RUN_PATH}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify({
      threadId,
      runId,
      messages: [{ id: `${runId}-user`, role: 'user', content: userText }],
    }),
  });
}

/** The AG-UI SSE frames, decoded from `data: <json>` lines. */
async function readEvents(response: Response): Promise<AguiEvent[]> {
  assert.ok(response.body !== null, 'the run response should carry a body stream');
  const decoder = new TextDecoder();
  let buffer = '';
  const events: AguiEvent[] = [];
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk as Uint8Array, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of frame.split('\n')) {
        if (line.startsWith('data: ')) {
          events.push(JSON.parse(line.slice('data: '.length)) as AguiEvent);
        }
      }
      boundary = buffer.indexOf('\n\n');
    }
  }
  return events;
}

function types(events: readonly AguiEvent[]): string[] {
  return events.map((event) => event.type);
}

test('a run streams RUN_STARTED, one target state snapshot, per-member reply groups, RUN_FINISHED', async () => {
  const fixture = await startAguiFixture('allibot-agui-order-');
  try {
    const { channelId, agentIds } = await seedTarget(fixture, '契约频道');

    const response = await runRequest(fixture, channelId, 'run-order-1', '大家怎么看？');
    assert.equal(response.status, 200, await response.clone().text());
    assert.match(
      response.headers.get('content-type') ?? '',
      /^text\/event-stream/,
      'a run answers with text/event-stream',
    );

    const events = await readEvents(response);
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
    assert.ok(snapshotIndexes.length <= 1, 'STATE_SNAPSHOT appears at most once');
    const firstTextIndex = kinds.findIndex((kind) => kind.startsWith('TEXT_MESSAGE_'));
    assert.ok(firstTextIndex > 0, 'the run streams at least one text message');
    for (const index of snapshotIndexes) {
      assert.ok(index < firstTextIndex, 'STATE_SNAPSHOT precedes the first text event');
    }

    assert.deepEqual(
      snapshotIndexes,
      [1],
      'the run starts with RUN_STARTED and then one STATE_SNAPSHOT',
    );
    const snapshot = events[1]?.['snapshot'] as {
      target_id?: string;
      members?: { member_id: string; display_name: string; avatar_slot: number }[];
    };
    assert.equal(snapshot.target_id, channelId, 'the snapshot names the target it belongs to');
    const memberIds = (snapshot.members ?? []).map((member) => member.member_id);
    for (const agentId of agentIds) {
      assert.ok(memberIds.includes(agentId), 'the snapshot carries every Agent member of the target');
    }
    for (const member of snapshot.members ?? []) {
      assert.equal(typeof member.display_name, 'string');
      assert.equal(typeof member.avatar_slot, 'number');
    }

    // Each member reply is one contiguous START → CONTENT* → END group under a
    // single messageId, and the groups never interleave.
    const groups: { messageId: string; start: number; end: number; contents: string[] }[] = [];
    const terminalIndex = kinds.length - 1;
    for (let index = firstTextIndex; index < terminalIndex; index += 1) {
      const kind = kinds[index];
      const messageId = events[index]?.['messageId'];
      if (kind === 'TEXT_MESSAGE_START') {
        groups.push({ messageId: messageId as string, start: index, end: -1, contents: [] });
        continue;
      }
      const current = groups[groups.length - 1];
      assert.ok(current !== undefined, `${kind} must follow a TEXT_MESSAGE_START`);
      assert.equal(messageId, current.messageId, `${kind} belongs to the open message group`);
      if (kind === 'TEXT_MESSAGE_CONTENT') {
        current.contents.push(events[index]?.['delta'] as string);
      } else if (kind === 'TEXT_MESSAGE_END') {
        current.end = index;
      } else {
        assert.fail(`unexpected event inside a reply group: ${kind}`);
      }
    }
    assert.equal(groups.length, agentIds.length, 'one reply group per Agent member of the target');
    const closed = groups.filter((group) => group.end !== -1);
    assert.equal(closed.length, groups.length, 'every reply group closes with TEXT_MESSAGE_END');
    assert.equal(
      new Set(groups.map((group) => group.messageId)).size,
      groups.length,
      'each reply group uses its own messageId',
    );
    for (const group of groups) {
      assert.deepEqual(group.contents, ['echo: 大家怎么看？']);
    }

    // messageId is the SQLite message.id: the durable rows are the truth, the
    // events only observe them.
    const rows = queryAll<{ id: string; target_id: string; kind: string; author_member_id: string; body: string }>(
      fixture.dataDir,
      "SELECT id, target_id, kind, author_member_id, body FROM message WHERE target_id = ? AND kind = 'agent' ORDER BY seq",
      [channelId],
    );
    assert.deepEqual(
      rows.map((row) => row.id),
      groups.map((group) => group.messageId),
      'the streamed messageIds are the persisted Agent message ids, in seq order',
    );
    assert.deepEqual(
      rows.map((row) => row.author_member_id),
      agentIds,
      'one persisted reply per Agent member, authored by that member',
    );
    for (const row of rows) {
      assert.equal(row.body, 'echo: 大家怎么看？');
    }
  } finally {
    await fixture.stop();
  }
});

test('a failed run ends with RUN_ERROR instead of RUN_FINISHED', async () => {
  const fixture = await startAguiFixture('allibot-agui-error-');
  try {
    const response = await runRequest(fixture, 'no-such-target', 'run-error-1', '你好');
    assert.equal(response.status, 200, 'the stream itself opens; the failure is an event');
    const events = await readEvents(response);
    const kinds = types(events);

    assert.equal(kinds[0], 'RUN_STARTED', 'a failed run still opens with RUN_STARTED');
    assert.equal(kinds[kinds.length - 1], 'RUN_ERROR', `RUN_ERROR closes the failed run; got ${kinds.join(',')}`);
    assert.ok(!kinds.includes('RUN_FINISHED'), 'RUN_ERROR replaces RUN_FINISHED');
    assert.ok(
      typeof events[events.length - 1]?.['message'] === 'string',
      'RUN_ERROR carries a human-readable message',
    );
  } finally {
    await fixture.stop();
  }
});

test('the runtime registers exactly one allibot agent, never one agent per member', async () => {
  const fixture = await startAguiFixture('allibot-agui-agents-');
  try {
    const { channelId, agentIds } = await seedTarget(fixture, '单 agent 频道');

    const info = await fetch(`${fixture.base}/api/copilotkit/info`);
    assert.equal(info.status, 200, await info.clone().text());
    const body = await readJson(info);
    const agents = body['agents'];
    assert.ok(typeof agents === 'object' && agents !== null, '/info returns an agents map');
    assert.deepEqual(Object.keys(agents), ['allibot'], 'the agents map holds only the orchestration agent');

    for (const agentId of agentIds) {
      const perMember = await fetch(`${fixture.base}/api/copilotkit/agent/${agentId}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          threadId: channelId,
          runId: 'run-per-member',
          messages: [{ id: 'u-per-member', role: 'user', content: '你好' }],
        }),
      });
      assert.equal(perMember.status, 404, 'a member is not registered as its own agentId');
      const notFound = await readJson(perMember);
      assert.match(String(notFound['message']), /does not exist/);
    }
  } finally {
    await fixture.stop();
  }
});

test('different threadIds map to different targets', async () => {
  const fixture = await startAguiFixture('allibot-agui-threads-');
  try {
    const first = await seedTarget(fixture, '甲频道');
    const second = await seedTarget(fixture, '乙频道');

    const firstEvents = await readEvents(await runRequest(fixture, first.channelId, 'run-a', '甲问题'));
    const secondEvents = await readEvents(await runRequest(fixture, second.channelId, 'run-b', '乙问题'));

    const firstIds = firstEvents
      .filter((event) => event.type === 'TEXT_MESSAGE_START')
      .map((event) => event['messageId'] as string);
    const secondIds = secondEvents
      .filter((event) => event.type === 'TEXT_MESSAGE_START')
      .map((event) => event['messageId'] as string);

    assert.equal(firstIds.length, first.agentIds.length);
    assert.equal(secondIds.length, second.agentIds.length);
    assert.equal(
      firstIds.filter((id) => secondIds.includes(id)).length,
      0,
      'two threads never share a reply',
    );

    const targets = queryAll<{ id: string; target_id: string }>(
      fixture.dataDir,
      'SELECT id, target_id FROM message WHERE id IN (?, ?, ?, ?)',
      [...firstIds, ...secondIds],
    );
    const targetOf = new Map(targets.map((row) => [row.id, row.target_id]));
    for (const id of firstIds) {
      assert.equal(targetOf.get(id), first.channelId, 'thread A replies land in target A');
    }
    for (const id of secondIds) {
      assert.equal(targetOf.get(id), second.channelId, 'thread B replies land in target B');
    }
  } finally {
    await fixture.stop();
  }
});

test('the multi-route handler answers GET, POST, PATCH and DELETE per the CopilotKit contract', async () => {
  const fixture = await startAguiFixture('allibot-agui-routes-');
  try {
    const { channelId } = await seedTarget(fixture, '路由频道');

    const info = await fetch(`${fixture.base}/api/copilotkit/info`);
    assert.equal(info.status, 200, 'GET /info serves the runtime info');

    const run = await runRequest(fixture, channelId, 'run-routes', '你好');
    assert.equal(run.status, 200, 'POST /agent/allibot/run serves the run stream');
    assert.match(run.headers.get('content-type') ?? '', /^text\/event-stream/);
    await run.body?.cancel();

    const patch = await fetch(`${fixture.base}/api/copilotkit/threads/${channelId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'renamed' }),
    });
    assert.equal(patch.status, 422, 'thread mutations need an Intelligence runtime');

    const del = await fetch(`${fixture.base}/api/copilotkit/threads/${channelId}`, {
      method: 'DELETE',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(del.status, 422, 'thread deletion needs an Intelligence runtime');

    const wrongMethod = await fetch(`${fixture.base}/api/copilotkit/info`, { method: 'DELETE' });
    assert.equal(wrongMethod.status, 405, 'a known route refuses the wrong method');
    assert.equal(wrongMethod.headers.get('allow'), 'GET');

    const unknown = await fetch(`${fixture.base}/api/copilotkit/nope`);
    assert.equal(unknown.status, 404, 'an unknown CopilotKit route is a 404');

    const outside = await fetch(`${fixture.base}/api/copilotkit-not-really`);
    assert.equal(outside.status, 404);
    const envelope = await readJson(outside);
    assert.equal(
      (envelope['error'] as Record<string, unknown>)['code'],
      'not_found',
      'paths outside the base path keep the unified error envelope',
    );
  } finally {
    await fixture.stop();
  }
});
