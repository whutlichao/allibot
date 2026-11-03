import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  REPO_ROOT,
  makeTempDir,
  removeTempDir,
  runCli,
  runNodeScript,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 搜索 (Search) at the process HTTP face: backend substring matching that is
 * case-insensitive for ASCII, message hits carrying every highlight range, and
 * the task / agent hit types that sit beside them. The seam is the human-face
 * REST surface only (R2); rows are never read to decide what a hit is.
 */

interface SearchFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

const CHANNEL_BODY = {
  name: '搜索频道',
  description: '搜索命中',
  mode: 'autonomous',
  response_budget_limit: 3,
};

async function startSearchFixture(prefix: string): Promise<SearchFixture> {
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

async function search(
  fixture: SearchFixture,
  query: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/search?q=${encodeURIComponent(query)}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['hits'] as Record<string, unknown>[];
}

async function createChannel(
  fixture: SearchFixture,
  body: Record<string, unknown> = CHANNEL_BODY,
): Promise<string> {
  const created = await postJson(fixture, '/api/channels', body);
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: SearchFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function postJson(
  fixture: SearchFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postMessage(
  fixture: SearchFixture,
  targetId: string,
  body: string,
): Promise<string> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function listMessages(
  fixture: SearchFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

async function joinChannel(
  fixture: SearchFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

/**
 * An Agent-authored message. The human face can only write `human` messages,
 * so this goes through the same fixture the response-judgment tests use: a
 * second caller of the production `appendMessageAndDispatch` entry point.
 */
const AGENT_MESSAGE_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'agent-message.mjs');

function runAgentMessageFixture(
  fixture: SearchFixture,
  input: { targetId: string; authorMemberId: string; body: string },
): string {
  const result = runNodeScript(AGENT_MESSAGE_FIXTURE, [
    JSON.stringify({
      dataDir: fixture.dataDir,
      targetId: input.targetId,
      authorMemberId: input.authorMemberId,
      body: input.body,
      behavior: 'ignore',
    }),
  ]);
  assert.equal(result.exitCode, 0, `agent-message fixture failed: ${result.output}`);
  const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; id?: string; message?: string };
  assert.equal(parsed.ok, true, `agent-message fixture reported: ${JSON.stringify(parsed)}`);
  return parsed.id as string;
}

/**
 * A DM target. The fixture writes the rows the DM write path owns
 * (`POST /api/dms` would write the same ones); search still has to answer for a
 * DM target, because a DM has no channel row to be filtered by.
 */
const DM_TARGET_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'dm-target.mjs');

function runDmTargetFixture(fixture: SearchFixture, agentId: string): { id: string } {
  const result = runNodeScript(DM_TARGET_FIXTURE, [
    JSON.stringify({ dataDir: fixture.dataDir, agentId }),
  ]);
  assert.equal(result.exitCode, 0, `dm-target fixture failed: ${result.output}`);
  const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; id?: string; message?: string };
  assert.equal(parsed.ok, true, `dm-target fixture reported: ${JSON.stringify(parsed)}`);
  return { id: parsed.id as string };
}

interface SideEffectState {
  messages: number;
  roundOutcomes: number;
  budgetConsumed: number;
}

/**
 * The observable effects a read path must never have. Search writes nothing,
 * so the message count, the round-outcome count and the consumed budget are
 * the three facts that would move if it did. The state is read repeatedly
 * until it stops changing, so a wake fired by the setup message has settled
 * first.
 */
async function waitForStableState(fixture: SearchFixture): Promise<SideEffectState> {
  let previous = readSideEffects(fixture);
  const deadline = Date.now() + 10_000;
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    const current = readSideEffects(fixture);
    if (
      current.messages === previous.messages &&
      current.roundOutcomes === previous.roundOutcomes
    ) {
      return current;
    }
    if (Date.now() >= deadline) {
      assert.fail(`side-effect state did not settle; saw: ${JSON.stringify(current)}`);
    }
    previous = current;
  }
}

function readSideEffects(fixture: SearchFixture): SideEffectState {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const one = (sql: string): number => (db.prepare(sql).get() as { total: number }).total;
    return {
      messages: one('SELECT count(*) AS total FROM message'),
      roundOutcomes: one('SELECT count(*) AS total FROM round_outcome'),
      budgetConsumed: one('SELECT coalesce(sum(budget_consumed), 0) AS total FROM round_outcome'),
    };
  } finally {
    db.close();
  }
}

test('GET /api/search rejects an empty q with validation_failed', async () => {
  const fixture = await startSearchFixture('allibot-search-empty-q-');
  try {
    for (const route of ['/api/search', '/api/search?q=', '/api/search?q=%20%20']) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 400, `route: ${route}`);
      assert.equal(errorCode(await readJson(response)), 'validation_failed', `route: ${route}`);
    }
  } finally {
    await fixture.stop();
  }
});

test('a message hit returns every occurrence, folds ASCII case and skips system events', async () => {
  const fixture = await startSearchFixture('allibot-search-message-hits-');
  try {
    const channelId = await createChannel(fixture);
    const messageId = await postMessage(fixture, channelId, 'Alpha 与 ALPHA，还有 alpha。');
    await postMessage(fixture, channelId, '另一条不带查询词的消息');
    // A task's creation writes a system pointer and a system thread event; the
    // pointer body names the task title, so a system event carrying the query
    // is the natural way to prove the exclusion.
    const taskResponse = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: 'Alpha 任务',
    });
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());

    const hits = await search(fixture, 'alpha');
    const messageHits = hits.filter((hit) => hit['type'] === 'message');
    assert.equal(messageHits.length, 1, `only the human message matches; hits: ${JSON.stringify(hits)}`);
    const hit = messageHits[0];
    assert.ok(hit !== undefined);
    assert.deepEqual(Object.keys(hit).sort(), ['highlights', 'message_id', 'target_id', 'type']);
    assert.equal(hit['target_id'], channelId);
    assert.equal(hit['message_id'], messageId);
    assert.deepEqual(
      hit['highlights'],
      [
        { start: 0, end: 5 },
        { start: 8, end: 13 },
        { start: 17, end: 22 },
      ],
      'every occurrence is ranged, not just the first',
    );

    const upper = await search(fixture, 'ALPHA');
    assert.deepEqual(upper, hits, 'ALPHA and alpha return the same hits');

    const channelMessages = await listMessages(fixture, channelId);
    assert.ok(
      channelMessages.some(
        (message) => message['kind'] === 'system' && /alpha/i.test(String(message['body'])),
      ),
      `the fixture must hold a system message carrying the query; messages: ${JSON.stringify(channelMessages)}`,
    );
  } finally {
    await fixture.stop();
  }
});

test('a hit lists every occurrence of a non-ASCII query verbatim, without folding it', async () => {
  const fixture = await startSearchFixture('allibot-search-chinese-');
  try {
    const channelId = await createChannel(fixture);
    // 项目进度：进度不错，进度表已更新。 — offsets counted by hand:
    // 项0 目1 进2 度3 ：4 进5 度6 不7 错8 ，9 进10 度11 表12 已13 更14 新15 。16
    const messageId = await postMessage(fixture, channelId, '项目进度：进度不错，进度表已更新。');

    const hits = await search(fixture, '进度');
    assert.equal(hits.length, 1, `one message matches; hits: ${JSON.stringify(hits)}`);
    const hit = hits[0];
    assert.ok(hit !== undefined);
    assert.equal(hit['message_id'], messageId);
    assert.deepEqual(
      hit['highlights'],
      [
        { start: 2, end: 4 },
        { start: 5, end: 7 },
        { start: 10, end: 12 },
      ],
      'Chinese matches are ranged at their UTF-16 offsets, one range per occurrence',
    );
  } finally {
    await fixture.stop();
  }
});

test('task and Agent hits are siblings of message hits, each with its own type', async () => {
  const fixture = await startSearchFixture('allibot-search-task-agent-hits-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture, 'Alpha 助手');
    const secondAgentId = await createAgent(fixture, 'Beta');
    const roleResponse = await fetch(`${fixture.base}/api/agents/${secondAgentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'alpha 审阅者' }),
    });
    assert.equal(roleResponse.status, 200, await roleResponse.clone().text());

    const taskResponse = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: 'Alpha 上线清单',
    });
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const task = await readJson(taskResponse);

    const hits = await search(fixture, 'alpha');
    const taskHits = hits.filter((hit) => hit['type'] === 'task');
    assert.deepEqual(
      taskHits,
      [{ type: 'task', task_id: task['id'], title: 'Alpha 上线清单' }],
      'the task hit names the task title as its subject',
    );

    const agentHits = hits.filter((hit) => hit['type'] === 'agent');
    assert.deepEqual(
      agentHits,
      [
        { type: 'agent', member_id: agentId, display_name: 'Alpha 助手', role: '' },
        { type: 'agent', member_id: secondAgentId, display_name: 'Beta', role: 'alpha 审阅者' },
      ],
      'a display name and a role are both Agent hit subjects',
    );
    for (const hit of [...taskHits, ...agentHits]) {
      assert.ok(!Object.hasOwn(hit, 'highlights'), 'task and Agent hits carry no range');
    }
  } finally {
    await fixture.stop();
  }
});

test('a soft-deleted Agent leaves the hit set but its history still matches', async () => {
  const fixture = await startSearchFixture('allibot-search-soft-deleted-author-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture, 'Falcon');
    const agentMessageId = runAgentMessageFixture(fixture, {
      targetId: channelId,
      authorMemberId: agentId,
      body: 'falcon 说过的一句话',
    });

    const before = await search(fixture, 'falcon');
    assert.equal(
      before.filter((hit) => hit['type'] === 'agent').length,
      1,
      'a live Agent is an Agent hit',
    );

    const deleted = await fetch(`${fixture.base}/api/agents/${agentId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204, await deleted.clone().text());

    const after = await search(fixture, 'falcon');
    assert.equal(
      after.filter((hit) => hit['type'] === 'agent').length,
      0,
      'a soft-deleted Agent is not an Agent hit',
    );
    const messageHits = after.filter((hit) => hit['type'] === 'message');
    assert.equal(messageHits.length, 1, 'the soft-deleted author history still matches');
    assert.equal(messageHits[0]?.['message_id'], agentMessageId);
    // The author snapshot survives the delete, so the hit still reads the same.
    assert.deepEqual(messageHits[0]?.['highlights'], [{ start: 0, end: 6 }]);
  } finally {
    await fixture.stop();
  }
});

test('a deleted channel takes its messages and its tasks out of search', async () => {
  const fixture = await startSearchFixture('allibot-search-deleted-channel-');
  try {
    const deletedChannel = await createChannel(fixture, { ...CHANNEL_BODY, name: '将删除的频道' });
    const liveChannel = await createChannel(fixture, { ...CHANNEL_BODY, name: '保留的频道' });

    const deletedMessage = await postMessage(fixture, deletedChannel, 'Phoenix 会消失');
    const liveMessage = await postMessage(fixture, liveChannel, 'Phoenix 会留下');
    const deletedTask = await postJson(fixture, '/api/tasks', {
      channel_id: deletedChannel,
      title: 'Phoenix 删除频道任务',
    });
    const liveTask = await postJson(fixture, '/api/tasks', {
      channel_id: liveChannel,
      title: 'Phoenix 保留频道任务',
    });
    assert.equal(deletedTask.status, 201, await deletedTask.clone().text());
    assert.equal(liveTask.status, 201, await liveTask.clone().text());

    // A task thread carries its own target; the thread's messages leave search
    // with the channel that owns the task.
    const threadTarget = (await readJson(deletedTask))['target_id'] as string;
    await postMessage(fixture, threadTarget, 'Phoenix 任务线程的消息');

    const removed = await fetch(`${fixture.base}/api/channels/${deletedChannel}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 204, await removed.clone().text());

    const hits = await search(fixture, 'phoenix');
    assert.deepEqual(
      hits.filter((hit) => hit['type'] === 'message').map((hit) => hit['message_id']),
      [liveMessage],
      'only the live channel message matches',
    );
    assert.deepEqual(
      hits.filter((hit) => hit['type'] === 'task').map((hit) => hit['task_id']),
      [(await readJson(liveTask))['id']],
      'only the live channel task matches',
    );
    assert.ok(
      !JSON.stringify(hits).includes(deletedMessage),
      'the deleted channel message never appears',
    );
  } finally {
    await fixture.stop();
  }
});

test('an unmatched query is an empty hit list, and repeated calls are stable', async () => {
  const fixture = await startSearchFixture('allibot-search-no-hit-');
  try {
    const channelId = await createChannel(fixture);
    await postMessage(fixture, channelId, '这里只有普通内容');

    const none = await search(fixture, '不存在的词');
    assert.deepEqual(none, [], 'no hit is an empty list, not a 404');
    assert.deepEqual(await search(fixture, '这里只有普通内容'), await search(fixture, '这里只有普通内容'));
  } finally {
    await fixture.stop();
  }
});

test('searching writes no message, wakes no member and moves no budget', async () => {
  const fixture = await startSearchFixture('allibot-search-no-side-effect-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture, 'Echo');
    await joinChannel(fixture, channelId, agentId);
    await postMessage(fixture, channelId, 'Echo 请看一下');
    // The mention above wakes Echo once; wait for that round to settle before
    // the baseline is taken.
    const baseline = await waitForStableState(fixture);
    assert.ok(baseline.messages > 0);

    for (let index = 0; index < 3; index += 1) {
      assert.ok((await search(fixture, 'echo')).length > 0);
    }

    const after = readSideEffects(fixture);
    assert.deepEqual(after, baseline, 'search adds no message, no wake and no budget change');
  } finally {
    await fixture.stop();
  }
});

test('search results are capped per kind without dropping the other kinds', async () => {
  const fixture = await startSearchFixture('allibot-search-cap-');
  try {
    const channelId = await createChannel(fixture);
    for (let index = 0; index < 55; index += 1) {
      await postMessage(fixture, channelId, `cap 消息 ${index}`);
    }
    const taskResponse = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: 'cap 任务',
    });
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());

    const hits = await search(fixture, 'cap');
    const messageHits = hits.filter((hit) => hit['type'] === 'message');
    assert.equal(messageHits.length, 50, 'the per-kind cap is 50');
    assert.equal(
      hits.filter((hit) => hit['type'] === 'task').length,
      1,
      'a capped kind does not crowd out another kind',
    );
    assert.deepEqual(
      await search(fixture, 'cap'),
      hits,
      'the capped result set is stable across calls',
    );
  } finally {
    await fixture.stop();
  }
});

test('an archived channel stays searchable', async () => {
  const fixture = await startSearchFixture('allibot-search-archived-');
  try {
    const channelId = await createChannel(fixture);
    const messageId = await postMessage(fixture, channelId, 'Kestrel 归档前的一条');
    const taskResponse = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: 'Kestrel 归档任务',
    });
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());

    const archived = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());

    const hits = await search(fixture, 'kestrel');
    assert.deepEqual(
      hits.filter((hit) => hit['type'] === 'message').map((hit) => hit['message_id']),
      [messageId],
      'archive hides nothing from search',
    );
    assert.equal(
      hits.filter((hit) => hit['type'] === 'task').length,
      1,
      'an archived channel keeps its task hits',
    );
  } finally {
    await fixture.stop();
  }
});

test('a DM message is a message hit: a direct message has no channel to be filtered by', async () => {
  const fixture = await startSearchFixture('allibot-search-dm-');
  try {
    const agentId = await createAgent(fixture, 'Gull');
    const dm = runDmTargetFixture(fixture, agentId);
    const hitBefore = await search(fixture, 'gull');
    assert.equal(hitBefore.filter((hit) => hit['type'] === 'message').length, 0);

    const dmMessage = await postMessage(fixture, dm.id, 'Gull 的私信内容');
    const hits = await search(fixture, 'gull');
    const messageHits = hits.filter((hit) => hit['type'] === 'message');
    assert.deepEqual(
      messageHits.map((hit) => [hit['message_id'], hit['target_id'], hit['highlights']]),
      [[dmMessage, dm.id, [{ start: 0, end: 4 }]]],
      'a DM message belongs to the workspace search surface',
    );
  } finally {
    await fixture.stop();
  }
});

test('the database holds no FTS or vector table', async () => {
  const fixture = await startSearchFixture('allibot-search-no-fts-');
  try {
    const dbPath = path.join(fixture.dataDir, 'allibot.db');
    const listed = spawnSync('sqlite3', [dbPath, '.tables'], { encoding: 'utf8' });
    assert.equal(listed.status, 0, `sqlite3 should exit 0; stderr: ${listed.stderr}`);
    assert.doesNotMatch(listed.stdout, /fts|vector|embedding/i, `tables: ${listed.stdout}`);

    const db = new Database(dbPath, { readonly: true });
    try {
      const objects = db
        .prepare("SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
        .all() as { name: string; type: string }[];
      for (const object of objects) {
        assert.doesNotMatch(
          object.name,
          /fts|vector|embedding/i,
          `unexpected search object: ${object.type} ${object.name}`,
        );
      }
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
  }
});
