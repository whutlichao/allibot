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

interface ChannelFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

const CHANNEL_BODY = {
  name: '研究频道',
  description: '讨论论文与实验',
  mode: 'autonomous',
  response_budget_limit: 5,
};

async function startChannelFixture(prefix: string): Promise<ChannelFixture> {
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

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: ChannelFixture,
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
  fixture: ChannelFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

test('POST /api/channels creates an autonomous channel readable by GET and editable by PATCH', async () => {
  const fixture = await startChannelFixture('allibot-channels-create-');
  try {
    const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
    assert.equal(created.status, 201, await created.clone().text());
    const channel = await readJson(created);
    const id = channel['id'];
    assert.equal(typeof id, 'string');
    assert.match(id as string, /^[0-9a-f-]{36}$/, 'the backend generates an opaque UUID id');
    assert.equal(channel['name'], CHANNEL_BODY.name);
    assert.equal(channel['description'], CHANNEL_BODY.description);
    assert.equal(channel['mode'], 'autonomous');
    assert.equal(channel['response_budget_limit'], CHANNEL_BODY.response_budget_limit);
    assert.equal(channel['archived_at'], null);
    assert.equal(channel['deleted_at'], null);

    const detail = await fetch(`${fixture.base}/api/channels/${String(id)}`);
    assert.equal(detail.status, 200);
    assert.deepEqual(await readJson(detail), channel, 'GET returns the same values as the create');

    const owner = queryDatabase<{ id: string }>(
      fixture.dataDir,
      "SELECT id FROM member WHERE kind = 'owner'",
    );
    assert.ok(owner !== undefined, 'the migration seeds the owner row');
    const shadow = queryDatabase<{ kind: string }>(
      fixture.dataDir,
      'SELECT kind FROM target WHERE id = ?',
      [id],
    );
    assert.equal(shadow?.kind, 'channel', 'a channel-type target shadow row reuses the channel id');
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ? AND member_id = ?',
        [id, owner.id],
      )?.total,
      1,
      'the owner is automatically a channel member',
    );

    const patched = await patchJson(fixture, `/api/channels/${String(id)}`, {
      name: '实验频道',
      description: '新的描述',
      response_budget_limit: 10,
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    const patchedBody = await readJson(patched);
    assert.equal(patchedBody['name'], '实验频道');
    assert.equal(patchedBody['description'], '新的描述');
    assert.equal(patchedBody['response_budget_limit'], 10);
    assert.equal(patchedBody['mode'], 'autonomous', 'PATCH leaves the mode alone');

    const reread = await readJson(await fetch(`${fixture.base}/api/channels/${String(id)}`));
    assert.deepEqual(reread, patchedBody);

    const list = await fetch(`${fixture.base}/api/channels`);
    assert.equal(list.status, 200);
    assert.deepEqual(
      (await readJson(list))['channels'],
      [patchedBody],
      'the channel list carries the same view including archived_at',
    );
  } finally {
    await fixture.stop();
  }
});

test('a budget of 4 and the team mode are rejected with 400 validation_failed without creating rows', async () => {
  const fixture = await startChannelFixture('allibot-channels-validation-');
  try {
    const badBudget = await postJson(fixture, '/api/channels', {
      ...CHANNEL_BODY,
      response_budget_limit: 4,
    });
    assert.equal(badBudget.status, 400, await badBudget.clone().text());
    assert.equal(errorCode(await readJson(badBudget)), 'validation_failed');

    const team = await postJson(fixture, '/api/channels', { ...CHANNEL_BODY, mode: 'team' });
    assert.equal(team.status, 400, await team.clone().text());
    assert.equal(errorCode(await readJson(team)), 'validation_failed');

    const unknownMode = await postJson(fixture, '/api/channels', { ...CHANNEL_BODY, mode: 'solo' });
    assert.equal(unknownMode.status, 400);
    assert.equal(errorCode(await readJson(unknownMode)), 'validation_failed');

    const missingName = await postJson(fixture, '/api/channels', { description: 'no name' });
    assert.equal(missingName.status, 400);
    assert.equal(errorCode(await readJson(missingName)), 'validation_failed');

    const unknownField = await postJson(fixture, '/api/channels', {
      ...CHANNEL_BODY,
      archived_at: '2026-01-01T00:00:00.000Z',
    });
    assert.equal(unknownField.status, 400);
    assert.equal(errorCode(await readJson(unknownField)), 'validation_failed');

    const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
    assert.equal(created.status, 201);
    const id = (await readJson(created))['id'];

    const badPatch = await patchJson(fixture, `/api/channels/${String(id)}`, {
      response_budget_limit: 4,
    });
    assert.equal(badPatch.status, 400, await badPatch.clone().text());
    assert.equal(errorCode(await readJson(badPatch)), 'validation_failed');

    const teamPatch = await patchJson(fixture, `/api/channels/${String(id)}`, { mode: 'team' });
    assert.equal(teamPatch.status, 400, 'mode is not patchable in M1');
    assert.equal(errorCode(await readJson(teamPatch)), 'validation_failed');

    assert.equal(
      queryDatabase<{ total: number }>(fixture.dataDir, 'SELECT count(*) AS total FROM channel')
        ?.total,
      1,
      'rejected creates write no channel row',
    );
    const stored = queryDatabase<{ response_budget_limit: number }>(
      fixture.dataDir,
      'SELECT response_budget_limit FROM channel WHERE id = ?',
      [id],
    );
    assert.equal(stored?.response_budget_limit, CHANNEL_BODY.response_budget_limit);

    const unknown = await fetch(`${fixture.base}/api/channels/does-not-exist`);
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(await readJson(unknown)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('archive is idempotent, moves the channel to the archived segment and closes config and join writes', async () => {
  const fixture = await startChannelFixture('allibot-channel-archive-');
  try {
    const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
    assert.equal(created.status, 201);
    const channelId = (await readJson(created))['id'] as string;
    const agent = await postJson(fixture, '/api/agents', {
      display_name: 'Archived Joiner',
      model: 'openai:gpt-5',
    });
    const agentId = (await readJson(agent))['id'] as string;

    const archived = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());
    const archivedBody = await readJson(archived);
    const archivedAt = archivedBody['archived_at'];
    assert.equal(typeof archivedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(archivedAt as string)), 'archived_at is an ISO timestamp');

    const second = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(second.status, 200, 'archiving twice stays a success');
    assert.equal(
      (await readJson(second))['archived_at'],
      archivedAt,
      'a repeated archive does not refresh archived_at',
    );

    const detail = await fetch(`${fixture.base}/api/channels/${channelId}`);
    assert.equal(detail.status, 200, 'an archived channel is still readable');
    assert.equal((await readJson(detail))['archived_at'], archivedAt);

    const list = await readJson(await fetch(`${fixture.base}/api/channels`));
    const listed = (list['channels'] as Record<string, unknown>[]).find(
      (channel) => channel['id'] === channelId,
    );
    assert.ok(listed !== undefined, 'the archived channel stays in the channel list');
    assert.equal(listed?.['archived_at'], archivedAt, 'the list lets the client split the archived segment');

    const patch = await patchJson(fixture, `/api/channels/${channelId}`, {
      name: '改名尝试',
      response_budget_limit: 10,
    });
    assert.equal(patch.status, 400, await patch.clone().text());
    assert.equal(errorCode(await readJson(patch)), 'validation_failed');

    const join = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: agentId,
    });
    assert.equal(join.status, 400, await join.clone().text());
    assert.equal(errorCode(await readJson(join)), 'validation_failed');

    const stored = queryDatabase<{ name: string; response_budget_limit: number; archived_at: string }>(
      fixture.dataDir,
      'SELECT name, response_budget_limit, archived_at FROM channel WHERE id = ?',
      [channelId],
    );
    assert.equal(stored?.name, CHANNEL_BODY.name, 'a refused PATCH writes nothing');
    assert.equal(stored?.response_budget_limit, CHANNEL_BODY.response_budget_limit);
    assert.equal(stored?.archived_at, archivedAt);
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ?',
        [channelId],
      )?.total,
      1,
      'a refused join writes no member row',
    );

    const active = (list['channels'] as Record<string, unknown>[]).filter(
      (channel) => channel['archived_at'] === null,
    );
    assert.equal(active.length, 0, 'the archived channel left the active segment');
  } finally {
    await fixture.stop();
  }
});

test('DELETE soft-deletes once, makes every channel endpoint 404 and retains every row', async () => {
  const fixture = await startChannelFixture('allibot-channel-delete-');
  try {
    const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
    assert.equal(created.status, 201);
    const channelId = (await readJson(created))['id'] as string;
    const agent = await postJson(fixture, '/api/agents', {
      display_name: 'Deleted Channel Joiner',
      model: 'openai:gpt-5',
    });
    const agentId = (await readJson(agent))['id'] as string;
    const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: agentId,
    });
    assert.equal(joined.status, 200);
    assert.deepEqual(await readJson(joined), { joined: true });

    // Archive first to prove deletion clears archived_at as its own tier.
    assert.equal((await postJson(fixture, `/api/channels/${channelId}/archive`, {})).status, 200);

    const deleted = await fetch(`${fixture.base}/api/channels/${channelId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '', '204 carries no body');

    for (const route of [
      `/api/channels/${channelId}`,
      `/api/channels/${channelId}/members`,
      `/api/targets/${channelId}/members`,
    ]) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 404, `${route} must read as not found`);
      assert.equal(errorCode(await readJson(response)), 'not_found');
    }
    const patch = await patchJson(fixture, `/api/channels/${channelId}`, { name: 'nope' });
    assert.equal(patch.status, 404);
    assert.equal(errorCode(await readJson(patch)), 'not_found');
    const archive = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(archive.status, 404, 'a deleted channel cannot be archived');
    const join = await postJson(fixture, `/api/channels/${channelId}/members`, { member_id: agentId });
    assert.equal(join.status, 404);

    const second = await fetch(`${fixture.base}/api/channels/${channelId}`, { method: 'DELETE' });
    assert.equal(second.status, 404, 'deletion is not idempotent');
    assert.equal(errorCode(await readJson(second)), 'not_found');

    const list = await readJson(await fetch(`${fixture.base}/api/channels`));
    assert.deepEqual(list['channels'], [], 'a deleted channel is not listed');

    const row = queryDatabase<{ deleted_at: string | null; archived_at: string | null }>(
      fixture.dataDir,
      'SELECT deleted_at, archived_at FROM channel WHERE id = ?',
      [channelId],
    );
    assert.ok(typeof row?.deleted_at === 'string' && row.deleted_at.length > 0, 'deleted_at is set');
    assert.equal(row?.archived_at, null, 'deletion clears archived_at');
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target WHERE id = ?',
        [channelId],
      )?.total,
      1,
      'the target shadow row is retained',
    );
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ?',
        [channelId],
      )?.total,
      2,
      'the target_member rows are retained',
    );
  } finally {
    await fixture.stop();
  }
});
