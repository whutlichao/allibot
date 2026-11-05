import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { WEB_ACCESS_TIERS, type WebAccessTier } from '@allibot/shared';
import { resolveWebAccessTier } from '../dist/permissions.js';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 联网档 (#68 / T2 of M3): the four-value write face, the effective-tier
 * resolution and the two readings (`GET /api/channels/{id}` gets the raw
 * channel value plus `docker_egress`, `GET /api/agents/{id}` gets the Agent
 * override plus the effective tier in the M2 `permission_mode` shape).
 *
 * The seam is the backend HTTP face: a real server process on a temporary data
 * directory, with the stored row cross-read from SQLite only to prove a
 * rejected write landed nothing. The one pure resolution function is exercised
 * through its exported seam because this ticket has no endpoint that reads a
 * target's effective tier (that is T4's tool assembly).
 */

interface WebAccessFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

const CHANNEL_BODY = {
  name: '联网频道',
  description: '讨论会出网的频道',
  mode: 'autonomous',
};

async function startWebAccessFixture(prefix: string): Promise<WebAccessFixture> {
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

async function postJson(
  fixture: WebAccessFixture,
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
  fixture: WebAccessFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: WebAccessFixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: WebAccessFixture, body: unknown = {}): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '联网助手',
    model: 'anthropic:claude-sonnet-4-5',
    ...(body as Record<string, unknown>),
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

test('GET /api/channels/{id} reads an unconfigured web_access and the default egress switch', async () => {
  const fixture = await startWebAccessFixture('allibot-web-access-channel-read-');
  try {
    const channelId = await createChannel(fixture);

    const detail = await fetch(`${fixture.base}/api/channels/${channelId}`);
    assert.equal(detail.status, 200);
    const channel = await readJson(detail);
    assert.equal(
      channel['web_access'],
      null,
      'NULL is the stored "unconfigured" value and reads back as null, not as the resolved search',
    );
    assert.equal(typeof channel['docker_egress'], 'number');
    assert.equal(channel['docker_egress'], 0, 'a channel has no container network until told to');

    const list = await readJson(await fetch(`${fixture.base}/api/channels`));
    assert.deepEqual(
      (list['channels'] as Record<string, unknown>[]).map((entry) => entry['web_access']),
      [null],
      'the channel list carries the same reading',
    );
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/channels/{id} writes the web-access tier, and an explicit null is unconfigured', async () => {
  const fixture = await startWebAccessFixture('allibot-web-access-channel-write-');
  try {
    const channelId = await createChannel(fixture);

    const off = await patchJson(fixture, `/api/channels/${channelId}`, { web_access: 'off' });
    assert.equal(off.status, 200, await off.clone().text());
    assert.equal((await readJson(off))['web_access'], 'off', 'the PATCH returns the new reading');
    assert.equal(
      queryDatabase<{ web_access: string | null }>(
        fixture.dataDir,
        'SELECT web_access FROM channel WHERE id = ?',
        [channelId],
      )?.web_access,
      'off',
    );

    const fetchTier = await patchJson(fixture, `/api/channels/${channelId}`, {
      web_access: 'search+fetch',
    });
    assert.equal(fetchTier.status, 200, await fetchTier.clone().text());
    const detail = await fetch(`${fixture.base}/api/channels/${channelId}`);
    assert.equal((await readJson(detail))['web_access'], 'search+fetch');

    const search = await patchJson(fixture, `/api/channels/${channelId}`, { web_access: 'search' });
    assert.equal(search.status, 200, await search.clone().text());
    assert.equal((await readJson(search))['web_access'], 'search');

    const cleared = await patchJson(fixture, `/api/channels/${channelId}`, { web_access: null });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.equal(
      (await readJson(cleared))['web_access'],
      null,
      'null is the stored unconfigured value, not a fourth tier',
    );
    assert.equal(
      queryDatabase<{ web_access: string | null }>(
        fixture.dataDir,
        'SELECT web_access FROM channel WHERE id = ?',
        [channelId],
      )?.web_access,
      null,
    );
    assert.equal(
      queryDatabase<{ name: string }>(
        fixture.dataDir,
        'SELECT name FROM channel WHERE id = ?',
        [channelId],
      )?.name,
      CHANNEL_BODY.name,
      'a tier write leaves the other columns alone',
    );
  } finally {
    await fixture.stop();
  }
});

test('a web-access value outside the three tiers is 400 validation_failed and writes nothing', async () => {
  const fixture = await startWebAccessFixture('allibot-web-access-channel-invalid-');
  try {
    const channelId = await createChannel(fixture);
    const stored = await patchJson(fixture, `/api/channels/${channelId}`, { web_access: 'off' });
    assert.equal(stored.status, 200, await stored.clone().text());

    const rejected: unknown[] = ['all', 7, 'search ', 'SEARCH', '', 'search, fetch'];
    for (const value of rejected) {
      const response = await patchJson(fixture, `/api/channels/${channelId}`, {
        web_access: value,
      });
      assert.equal(
        response.status,
        400,
        `web_access ${JSON.stringify(value)} must be refused; body: ${await response
          .clone()
          .text()}`,
      );
      assert.equal(errorCode(await readJson(response)), 'validation_failed');
      assert.equal(
        queryDatabase<{ web_access: string | null }>(
          fixture.dataDir,
          'SELECT web_access FROM channel WHERE id = ?',
          [channelId],
        )?.web_access,
        'off',
        `a refused ${JSON.stringify(value)} leaves the stored tier alone`,
      );
      const detail = await readJson(await fetch(`${fixture.base}/api/channels/${channelId}`));
      assert.equal(detail['web_access'], 'off');
    }
  } finally {
    await fixture.stop();
  }
});

test('the effective tier is the Agent override, then the channel value, then search', async () => {
  // The resolution order of D1 as a table: the expected column is the spec's
  // sentence, not a recomputation of the implementation.
  const cases: {
    agent: WebAccessTier | null;
    channel: WebAccessTier | null;
    effective: WebAccessTier;
    why: string;
  }[] = [
    { agent: null, channel: 'off', effective: 'off', why: 'an unset Agent follows the channel' },
    {
      agent: 'search+fetch',
      channel: 'off',
      effective: 'search+fetch',
      why: 'the Agent override wins over the channel',
    },
    { agent: null, channel: null, effective: 'search', why: 'both unset falls back to search' },
    {
      agent: 'off',
      channel: 'search+fetch',
      effective: 'off',
      why: 'an Agent can tighten below the channel, not only widen',
    },
    {
      agent: 'search',
      channel: 'search+fetch',
      effective: 'search',
      why: 'the stored override is honored even when it is the middle tier',
    },
    {
      agent: null,
      channel: 'search+fetch',
      effective: 'search+fetch',
      why: 'the channel value is written through untouched',
    },
  ];
  for (const entry of cases) {
    assert.equal(
      resolveWebAccessTier(entry.agent, entry.channel),
      entry.effective,
      `agent=${String(entry.agent)} channel=${String(entry.channel)}: ${entry.why}`,
    );
  }

  assert.deepEqual(
    [...WEB_ACCESS_TIERS],
    ['off', 'search', 'search+fetch'],
    'three stored tiers: the fourth accepted write input is null, not a tier string',
  );

  // A DM has no channel dimension: the Agent level plus the default is the
  // whole chain, so an unset DM Agent resolves to search whatever channels say.
  assert.equal(resolveWebAccessTier(null, null), 'search', 'a DM Agent with no override');
  assert.equal(resolveWebAccessTier('search+fetch', null), 'search+fetch', 'a DM Agent override');
});

test('GET /api/agents/{id} reads the override and the effective tier without a channel dimension', async () => {
  const fixture = await startWebAccessFixture('allibot-web-access-agent-read-');
  try {
    // The channel deliberately carries a non-default tier: an Agent reading has
    // no channel dimension (that is the DM rule), so it must not leak in.
    const channelId = await createChannel(fixture);
    const channelPatch = await patchJson(fixture, `/api/channels/${channelId}`, {
      web_access: 'off',
    });
    assert.equal(channelPatch.status, 200, await channelPatch.clone().text());

    const agentId = await createAgent(fixture);

    const detail = await fetch(`${fixture.base}/api/agents/${agentId}`);
    assert.equal(detail.status, 200);
    const agent = await readJson(detail);
    assert.equal(agent['web_access'], null, 'an Agent with no override stores NULL');
    assert.equal(
      agent['effective_web_access'],
      'search',
      'the Agent level plus the default is the whole chain: the channel tier is absent',
    );

    const list = await readJson(await fetch(`${fixture.base}/api/agents`));
    const listed = (list['agents'] as Record<string, unknown>[]).find(
      (entry) => entry['id'] === agentId,
    );
    assert.equal(listed?.['web_access'], null);
    assert.equal(listed?.['effective_web_access'], 'search');
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/agents/{id} sets and clears the web-access override; another explicit null is still 400', async () => {
  const fixture = await startWebAccessFixture('allibot-web-access-agent-write-');
  try {
    const agentId = await createAgent(fixture, { role: '研究助理' });

    const set = await patchJson(fixture, `/api/agents/${agentId}`, {
      web_access: 'search+fetch',
    });
    assert.equal(set.status, 200, await set.clone().text());
    const setBody = await readJson(set);
    assert.equal(setBody['web_access'], 'search+fetch', 'the PATCH returns the raw override');
    assert.equal(setBody['effective_web_access'], 'search+fetch');
    assert.equal(
      queryDatabase<{ web_access: string | null }>(
        fixture.dataDir,
        'SELECT web_access FROM agent_config WHERE member_id = ?',
        [agentId],
      )?.web_access,
      'search+fetch',
    );

    const detail = await readJson(await fetch(`${fixture.base}/api/agents/${agentId}`));
    assert.equal(detail['web_access'], 'search+fetch');
    assert.equal(detail['effective_web_access'], 'search+fetch');

    const cleared = await patchJson(fixture, `/api/agents/${agentId}`, { web_access: null });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    const clearedBody = await readJson(cleared);
    assert.equal(
      clearedBody['web_access'],
      null,
      'an explicit null clears the override back to follow-the-channel',
    );
    assert.equal(
      clearedBody['effective_web_access'],
      'search',
      'with the override cleared the effective tier is the channel value or the default',
    );
    assert.equal(
      queryDatabase<{ web_access: string | null }>(
        fixture.dataDir,
        'SELECT web_access FROM agent_config WHERE member_id = ?',
        [agentId],
      )?.web_access,
      null,
    );
    assert.equal(clearedBody['role'], '研究助理', 'clearing the override leaves role alone');

    // The nullable field does not make every field nullable: the same body with
    // a second explicit null is refused whole, and nothing is written.
    const restored = await patchJson(fixture, `/api/agents/${agentId}`, { web_access: 'off' });
    assert.equal(restored.status, 200, await restored.clone().text());
    const withRoleNull = await patchJson(fixture, `/api/agents/${agentId}`, {
      web_access: null,
      role: null,
    });
    assert.equal(withRoleNull.status, 400, await withRoleNull.clone().text());
    assert.equal(errorCode(await readJson(withRoleNull)), 'validation_failed');
    const stored = queryDatabase<{ web_access: string | null; role: string }>(
      fixture.dataDir,
      'SELECT web_access, role FROM agent_config WHERE member_id = ?',
      [agentId],
    );
    assert.equal(stored?.web_access, 'off', 'the refused PATCH wrote no web_access');
    assert.equal(stored?.role, '研究助理', 'the refused PATCH wrote no role');
  } finally {
    await fixture.stop();
  }
});

test('an Agent web-access value outside the three tiers is 400 validation_failed and writes nothing', async () => {
  const fixture = await startWebAccessFixture('allibot-web-access-agent-invalid-');
  try {
    const agentId = await createAgent(fixture);
    const stored = await patchJson(fixture, `/api/agents/${agentId}`, { web_access: 'off' });
    assert.equal(stored.status, 200, await stored.clone().text());

    const rejected: unknown[] = ['all', 7, 'search ', 'SEARCH', true, ['search']];
    for (const value of rejected) {
      const response = await patchJson(fixture, `/api/agents/${agentId}`, { web_access: value });
      assert.equal(
        response.status,
        400,
        `web_access ${JSON.stringify(value)} must be refused; body: ${await response
          .clone()
          .text()}`,
      );
      assert.equal(errorCode(await readJson(response)), 'validation_failed');
      assert.equal(
        queryDatabase<{ web_access: string | null }>(
          fixture.dataDir,
          'SELECT web_access FROM agent_config WHERE member_id = ?',
          [agentId],
        )?.web_access,
        'off',
        `a refused ${JSON.stringify(value)} leaves the stored override alone`,
      );
    }
    const detail = await readJson(await fetch(`${fixture.base}/api/agents/${agentId}`));
    assert.equal(detail['web_access'], 'off');
    assert.equal(detail['effective_web_access'], 'off');
  } finally {
    await fixture.stop();
  }
});
