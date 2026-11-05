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
