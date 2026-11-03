import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  runNodeScript,
  startServer,
  REPO_ROOT,
  type RunningServer,
} from './support.ts';

/**
 * 私信（#22）的进程级 HTTP seam：显式创建与按 Agent 幂等、两行成员、无加入 /
 * 离开端点、穿透一次性送达、DM 上的零唤醒与预算跳、Agent 软删除后的已归档
 * 私信。断言只读 HTTP 响应与库文件读数；脚本化 provider 经启动参数注入。
 */

interface DmFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startDmFixture(
  prefix: string,
  provider: 'reply' | 'ignore' = 'ignore',
): Promise<DmFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, { args: ['--scripted-provider', provider] });
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

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
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

async function postJson(fixture: DmFixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(fixture: DmFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createDm(
  fixture: DmFixture,
  agentId: string,
): Promise<{ status: number; id: string }> {
  const response = await postJson(fixture, '/api/dms', { agent_id: agentId });
  const body = await readJson(response);
  assert.equal(typeof body['id'], 'string', JSON.stringify(body));
  return { status: response.status, id: body['id'] as string };
}

async function listDms(fixture: DmFixture): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/dms`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['dms'] as Record<string, unknown>[];
}

async function postMessage(
  fixture: DmFixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return await postJson(fixture, `/api/targets/${targetId}/messages`, body);
}

async function listMessages(
  fixture: DmFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

function ownerId(fixture: DmFixture): string {
  const owner = queryDatabase<{ id: string }>(
    fixture.dataDir,
    "SELECT id FROM member WHERE kind = 'owner'",
  );
  assert.ok(owner !== undefined, 'a migrated database carries the owner row');
  return owner.id;
}

/**
 * Write one Agent-authored message through the production entry point (the
 * test-only fixture is another caller of `appendMessageAndDispatch`, not a
 * second orchestration path).
 */
function runAgentMessage(
  fixture: DmFixture,
  input: { targetId: string; authorMemberId: string; body: string; behavior: 'reply' | 'ignore' },
): void {
  const result = runNodeScript(path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'agent-message.mjs'), [
    JSON.stringify({
      dataDir: fixture.dataDir,
      targetId: input.targetId,
      authorMemberId: input.authorMemberId,
      body: input.body,
      behavior: input.behavior,
    }),
  ]);
  const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; message?: string };
  assert.equal(parsed.ok, true, `agent-message fixture reported: ${JSON.stringify(parsed)}`);
}

interface BudgetRow {
  epoch_seq: number;
  used: number;
  limit_value: number;
}

function budgetRow(fixture: DmFixture, targetId: string): BudgetRow {
  const rows = queryAll<BudgetRow>(
    fixture.dataDir,
    'SELECT epoch_seq, used, limit_value FROM target_budget WHERE target_id = ?',
    [targetId],
  );
  assert.equal(rows.length, 1, 'the DM keeps exactly one budget row per target');
  return rows[0]!;
}

test('POST /api/dms creates one two-member DM per Agent and reuses it on repeat', async () => {
  const fixture = await startDmFixture('allibot-dm-create-');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const other = await createAgent(fixture, '另一个对象');

    const first = await createDm(fixture, peer);
    assert.equal(first.status, 201, 'the first creation of a DM is a create');

    const again = await createDm(fixture, peer);
    assert.equal(again.status, 200, 'a repeat is an idempotent reuse, not a second create');
    assert.equal(again.id, first.id, 'the same Agent always maps to the same DM id');

    const otherDm = await createDm(fixture, other);
    assert.equal(otherDm.status, 201);
    assert.notEqual(otherDm.id, first.id, 'one DM per Agent');

    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        "SELECT count(*) AS total FROM target WHERE kind = 'dm'",
      )?.total,
      2,
      'each Agent has exactly one dm target row',
    );

    const owner = ownerId(fixture);
    const members = queryAll<{ member_id: string }>(
      fixture.dataDir,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [first.id],
    );
    assert.deepEqual(
      members.map((row) => row.member_id),
      [owner, peer],
      'the DM is exactly the owner and its Agent, written by the creation',
    );

    const dms = await listDms(fixture);
    assert.equal(dms.length, 2, 'GET /api/dms lists every DM');
    const view = dms.find((dm) => dm['id'] === first.id);
    assert.ok(view !== undefined, 'the created DM is listed');
    const peerRow = queryDatabase<{ avatar_slot: number }>(
      fixture.dataDir,
      'SELECT avatar_slot FROM member WHERE id = ?',
      [peer],
    );
    assert.deepEqual(view['peer'], {
      id: peer,
      display_name: '私信对象',
      avatar_slot: peerRow?.avatar_slot,
      deleted_at: null,
    });

    const join = await postJson(fixture, `/api/dms/${first.id}/members`, { member_id: other });
    assert.equal(join.status, 404, 'a DM has no join endpoint');
    assert.equal(errorCode(await readJson(join)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('POST /api/dms rejects a missing peer, an unknown Agent and an unknown field', async () => {
  const fixture = await startDmFixture('allibot-dm-validation-');
  try {
    const missing = await postJson(fixture, '/api/dms', {});
    assert.equal(missing.status, 400);
    assert.equal(errorCode(await readJson(missing)), 'validation_failed');

    const unknown = await postJson(fixture, '/api/dms', { agent_id: 'nope' });
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(await readJson(unknown)), 'not_found');

    const owner = await postJson(fixture, '/api/dms', { agent_id: ownerId(fixture) });
    assert.equal(owner.status, 404, 'the owner is not an Agent to open a DM with');
    assert.equal(errorCode(await readJson(owner)), 'not_found');

    const extra = await postJson(fixture, '/api/dms', { agent_id: 'nope', name: 'x' });
    assert.equal(extra.status, 400);
    assert.equal(errorCode(await readJson(extra)), 'validation_failed');

    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        "SELECT count(*) AS total FROM target WHERE kind = 'dm'",
      )?.total,
      0,
      'a rejected request writes no target row',
    );
  } finally {
    await fixture.stop();
  }
});

test('owner speaks and the peer answers; the peer reply wakes nobody', async () => {
  const fixture = await startDmFixture('allibot-dm-wake-', 'reply');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const dm = await createDm(fixture, peer);

    const sent = await postMessage(fixture, dm.id, { body: '私信里的一句话' });
    assert.equal(sent.status, 201, await sent.clone().text());

    const messages = await listMessages(fixture, dm.id);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['agent', peer],
      ],
      'the owner message wakes the peer; the peer reply lands and wakes nobody',
    );

    assert.deepEqual(
      budgetRow(fixture, dm.id),
      { epoch_seq: 1, used: 0, limit_value: 3 },
      'the DM gets its own budget row, opened by the first human message, and a reply does not spend a jump',
    );

    const outcomes = queryAll<{ member_id: string; status: string; reason: string }>(
      fixture.dataDir,
      'SELECT member_id, status, reason FROM round_outcome WHERE target_id = ? ORDER BY rowid',
      [dm.id],
    );
    assert.equal(outcomes.length, 1, 'a two-party DM produces exactly one round for one owner message');
    assert.equal(outcomes[0]?.member_id, peer);
    assert.equal(outcomes[0]?.status, 'replied');
    assert.ok(outcomes[0]?.reason.includes('频道消息'), `wake reason: ${outcomes[0]?.reason}`);

    const members = queryAll<{ member_id: string }>(
      fixture.dataDir,
      'SELECT member_id FROM target_member WHERE target_id = ?',
      [dm.id],
    );
    assert.equal(members.length, 2, 'the reply does not change the DM membership');
  } finally {
    await fixture.stop();
  }
});

test('a third Agent mentioned in a DM is delivered once, replies, and stays out of target_member', async () => {
  const fixture = await startDmFixture('allibot-dm-penetration-', 'reply');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const third = await createAgent(fixture, '三号');
    const dm = await createDm(fixture, peer);

    const sent = await postMessage(fixture, dm.id, { body: '@三号 请看一眼这条私信' });
    assert.equal(sent.status, 201, await sent.clone().text());

    const messages = await listMessages(fixture, dm.id);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['agent', peer],
        ['agent', third],
      ],
      'the mention delivers to the third Agent exactly once; its reply lands',
    );
    assert.deepEqual(
      messages.map((message) => message['kind']),
      ['human', 'agent', 'agent'],
      'a pierced reply writes no system join event on a DM',
    );

    const members = queryAll<{ member_id: string }>(
      fixture.dataDir,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [dm.id],
    );
    assert.deepEqual(
      members.map((row) => row.member_id),
      [ownerId(fixture), peer],
      'penetration never writes a target_member row',
    );

    const outcomes = queryAll<{ member_id: string; base_seq: number; reason: string }>(
      fixture.dataDir,
      'SELECT member_id, base_seq, reason FROM round_outcome WHERE target_id = ? ORDER BY rowid',
      [dm.id],
    );
    assert.deepEqual(
      outcomes.map((row) => [row.member_id === third ? '三号' : '对象', row.base_seq]),
      [
        ['对象', 1],
        ['三号', 1],
      ],
      'only the mention delivery starts a round; the pierced reply wakes nobody',
    );
    assert.ok(
      outcomes[1]?.reason.includes('本轮由个人提及唤醒'),
      `mention wake reason: ${outcomes[1]?.reason}`,
    );
  } finally {
    await fixture.stop();
  }
});

test('an Agent reply in a DM wakes nobody, so the peer never answers its own mention of the peer', async () => {
  const fixture = await startDmFixture('allibot-dm-agent-reply-', 'reply');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const dm = await createDm(fixture, peer);

    // The fixture writes one Agent-directed message per owner message; here the
    // peer is the author and it names itself, which is the only shape in which
    // an Agent message could otherwise produce a DM wake.
    runNodeScript(path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'agent-message.mjs'), [
      JSON.stringify({
        dataDir: fixture.dataDir,
        targetId: dm.id,
        authorMemberId: peer,
        body: `@私信对象 自言自语`,
        behavior: 'reply',
      }),
    ]);

    const messages = await listMessages(fixture, dm.id);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [['agent', peer]],
      'an Agent-authored DM message lands and wakes nobody, not even on a self-mention',
    );
    assert.deepEqual(
      queryAll<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM round_outcome WHERE target_id = ?',
        [dm.id],
      ),
      [{ total: 0 }],
      'no round is started by an Agent reply in a DM',
    );
    assert.equal(
      queryAll<{ member_id: string }>(
        fixture.dataDir,
        'SELECT member_id FROM target_member WHERE target_id = ?',
        [dm.id],
      ).length,
      2,
      'the DM membership is still the two rows written at creation',
    );
  } finally {
    await fixture.stop();
  }
});

test('a pierced delivery in a DM spends one jump even though the member surface is silent', async () => {
  const fixture = await startDmFixture('allibot-dm-penetration-budget-');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const third = await createAgent(fixture, '三号');
    const dm = await createDm(fixture, peer);

    // The DM peer authors the message and names a third Agent that is not a
    // member: the member surface wakes nobody on a DM, but the pierced mention
    // is one delivery, so the ledger counts one jump.
    runAgentMessage(fixture, {
      targetId: dm.id,
      authorMemberId: peer,
      body: '私信对象 写的一条，点名 @三号',
      behavior: 'ignore',
    });

    assert.deepEqual(
      budgetRow(fixture, dm.id),
      { epoch_seq: 0, used: 1, limit_value: 3 },
      'a pierced delivery is charged one jump on the DM ledger',
    );
    assert.deepEqual(
      queryAll<{ member_id: string; status: string }>(
        fixture.dataDir,
        'SELECT member_id, status FROM round_outcome WHERE target_id = ? ORDER BY rowid',
        [dm.id],
      ),
      // A mention is a definite signal, so an ignored pierce closes as failed:
      // that is the response-judgment rule (#15), not a budget fact.
      [{ member_id: third, status: 'failed' }],
      'only the pierced third Agent ran a round',
    );
  } finally {
    await fixture.stop();
  }
});

test('a pierced delivery at the DM ceiling wakes nobody and records budget-exhausted', async () => {
  const fixture = await startDmFixture('allibot-dm-penetration-ceiling-');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const third = await createAgent(fixture, '三号');
    const dm = await createDm(fixture, peer);

    // Burn the DM's built-in ceiling through pierced deliveries: each Agent
    // message from the peer delivers exactly one mention wake to the third.
    for (let index = 1; index <= 3; index += 1) {
      runAgentMessage(fixture, {
        targetId: dm.id,
        authorMemberId: peer,
        body: `第 ${index} 条，点名 @三号`,
        behavior: 'ignore',
      });
    }
    assert.deepEqual(
      budgetRow(fixture, dm.id),
      { epoch_seq: 0, used: 3, limit_value: 3 },
      'the DM ledger stops exactly at the built-in ceiling',
    );

    runAgentMessage(fixture, {
      targetId: dm.id,
      authorMemberId: peer,
      body: '第 4 条，点名 @三号',
      behavior: 'ignore',
    });

    assert.deepEqual(
      budgetRow(fixture, dm.id),
      { epoch_seq: 0, used: 3, limit_value: 3 },
      'the suppressed message spends no further jump',
    );
    const outcomes = queryAll<{ base_seq: number; status: string; reason: string }>(
      fixture.dataDir,
      'SELECT base_seq, status, reason FROM round_outcome WHERE target_id = ? ORDER BY rowid',
      [dm.id],
    );
    const suppressed = outcomes.filter((row) => row.status === 'budget-exhausted');
    assert.equal(suppressed.length, 1, 'one budget-exhausted row for the suppressed pierce');
    assert.equal(suppressed[0]?.base_seq, 4, 'the fourth Agent message is the suppressed one');
    assert.ok(
      suppressed[0]?.reason.startsWith('预算耗尽'),
      `the reason is the readable budget-exhausted copy: ${suppressed[0]?.reason}`,
    );
    assert.deepEqual(
      (await listMessages(fixture, dm.id)).map((message) => message['seq']),
      [1, 2, 3, 4],
      'the suppressed message still lands as a row; only its wake is suppressed',
    );
  } finally {
    await fixture.stop();
  }
});

test('soft-deleting the peer archives the DM: still listed, still readable, refuses new sends and reuses the id', async () => {
  const fixture = await startDmFixture('allibot-dm-archive-');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const dm = await createDm(fixture, peer);

    const sent = await postMessage(fixture, dm.id, { body: '删除前的一句话' });
    assert.equal(sent.status, 201, await sent.clone().text());
    const before = queryAll<{ id: string; seq: number; body: string; author_member_id: string }>(
      fixture.dataDir,
      'SELECT id, seq, body, author_member_id FROM message WHERE target_id = ? ORDER BY seq',
      [dm.id],
    );
    assert.equal(before.length, 1);

    const deleted = await fetch(`${fixture.base}/api/agents/${peer}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);

    const dms = await listDms(fixture);
    const view = dms.find((candidate) => candidate['id'] === dm.id);
    assert.ok(view !== undefined, 'the archived DM stays in the list');
    const peerView = view['peer'] as Record<string, unknown>;
    assert.equal(peerView['id'], peer);
    assert.equal(
      typeof peerView['deleted_at'],
      'string',
      'peer.deleted_at marks the DM as archived',
    );

    const history = await listMessages(fixture, dm.id);
    assert.deepEqual(
      history.map((message) => [message['id'], message['seq'], message['body']]),
      before.map((row) => [row.id, row.seq, row.body]),
      'the archived DM keeps every message row and stays readable',
    );

    const refused = await postMessage(fixture, dm.id, { body: '删除后再发一句' });
    assert.equal(refused.status, 400, 'the send entry is disabled on an archived DM');
    assert.equal(errorCode(await readJson(refused)), 'validation_failed');

    const again = await createDm(fixture, peer);
    assert.equal(again.id, dm.id, 're-creating the DM reuses the archived one');
    assert.equal(again.status, 200, 'reuse is not a create');
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        "SELECT count(*) AS total FROM target WHERE kind = 'dm'",
      )?.total,
      1,
      'no second dm target row is written',
    );

    const members = queryAll<{ member_id: string }>(
      fixture.dataDir,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [dm.id],
    );
    assert.deepEqual(
      members.map((row) => row.member_id),
      [ownerId(fixture), peer],
      'the archived DM keeps its two membership rows',
    );
  } finally {
    await fixture.stop();
  }
});

test('soft-deleting an Agent keeps its DM membership but still clears channel and task membership', async () => {
  const fixture = await startDmFixture('allibot-dm-archive-channel-');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const dm = await createDm(fixture, peer);

    const channel = await postJson(fixture, '/api/channels', {
      name: '频道',
      description: '',
      mode: 'autonomous',
      response_budget_limit: 3,
    });
    assert.equal(channel.status, 201, await channel.clone().text());
    const channelId = (await readJson(channel))['id'] as string;
    const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: peer,
    });
    assert.equal(joined.status, 200);

    const deleted = await fetch(`${fixture.base}/api/agents/${peer}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);

    assert.deepEqual(
      queryAll<{ target_id: string }>(
        fixture.dataDir,
        'SELECT target_id FROM target_member WHERE member_id = ? ORDER BY rowid',
        [peer],
      ).map((row) => row.target_id),
      [dm.id],
      'only the DM keeps its membership row after the soft delete',
    );
  } finally {
    await fixture.stop();
  }
});

test('a pierced third Agent’s reply in a DM wakes nobody, so no agent-to-agent loop starts', async () => {
  // Every scripted reply names the DM peer, so the pierced third Agent's reply
  // would reach the peer under an ordinary member surface. A DM reply delivers
  // no wake at all, so the peer answers only the owner's message.
  const dataDir = await makeTempDir('allibot-dm-pierced-reply-');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'reply', '--scripted-reply', '@私信对象 我看到这条私信了'],
  });
  const fixture: DmFixture = {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
  try {
    const peer = await createAgent(fixture, '私信对象');
    const third = await createAgent(fixture, '三号');
    const dm = await createDm(fixture, peer);

    const sent = await postMessage(fixture, dm.id, { body: '@三号 请看一眼这条私信' });
    assert.equal(sent.status, 201, await sent.clone().text());

    const messages = await listMessages(fixture, dm.id);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['agent', peer],
        ['agent', third],
      ],
      'the pierced reply that names the peer does not wake it: a DM reply delivers no wake',
    );
    assert.deepEqual(
      queryAll<{ member_id: string }>(
        fixture.dataDir,
        'SELECT member_id FROM round_outcome WHERE target_id = ? ORDER BY rowid',
        [dm.id],
      ).map((row) => row.member_id),
      [peer, third],
      'exactly the two wakes the owner message produced ran; the reply produced none',
    );
  } finally {
    await fixture.stop();
  }
});
