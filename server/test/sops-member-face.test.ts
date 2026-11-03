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
 * The member face has no SOP write tools (#41 / D4.2): an Agent cannot create
 * or start an SOP. The scripted double's `sop-create` / `sop-start` behaviours
 * state that the tool is unavailable and write nothing; the round's own tool
 * list carries no SOP tool either. SOP creation / start exist only on the
 * human face, which is the HTTP routes tested in sops-http / sop-runs-http.
 */

const AGENT_MODEL = 'openai:gpt-5';

interface Fixture {
  dataDir: string;
  base: string;
  channelId: string;
  running: RunningServer;
}

async function postJson(
  base: string,
  route: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  return {
    status: response.status,
    body:
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {},
  };
}

async function startFixture(behavior: string): Promise<Fixture> {
  const dir = await makeTempDir('allibot-sop-member-face-');
  const migration = runCli(['--migrate', '--data-dir', dir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dir, {
    env: { OPENAI_API_KEY: 'sk-sop-member-face-test' },
    args: ['--scripted-provider', behavior, '--scripted-report-team'],
  });
  const base = `http://127.0.0.1:${running.port}`;
  const channelId = (await postJson(base, '/api/channels', { name: '成员面频道' })).body[
    'id'
  ] as string;
  const agentId = (await postJson(base, '/api/agents', {
    display_name: '成员甲',
    model: AGENT_MODEL,
    auto_claim: 0,
  })).body['id'] as string;
  await postJson(base, `/api/channels/${channelId}/members`, { member_id: agentId });
  await postJson(base, '/api/remote-data-flow/openai/consent', {});
  return { dataDir: dir, base, channelId, running };
}

async function stopFixture(fixture: Fixture, remove: boolean): Promise<void> {
  await fixture.running.stop();
  if (remove) {
    await removeTempDir(fixture.dataDir);
  }
}

async function sendOwnerMessage(fixture: Fixture): Promise<string> {
  const posted = await postJson(
    fixture.base,
    `/api/targets/${fixture.channelId}/messages`,
    { body: '请开始工作' },
  );
  assert.equal(posted.status, 201);
  const list = await fetch(`${fixture.base}/api/targets/${fixture.channelId}/messages`);
  assert.equal(list.status, 200);
  const body = (await list.json()) as { messages?: { kind: string; body: string }[] };
  const replies = (body.messages ?? []).filter((message) => message.kind === 'agent');
  assert.equal(replies.length, 1, 'the Agent round landed exactly one reply');
  const reply = replies[0]?.body ?? '';
  return reply;
}

function sopRowCounts(dataDir: string): { definitions: number; runs: number } {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const definitions = (
      db.prepare('SELECT count(*) AS total FROM sop_definition').get() as { total: number }
    ).total;
    const runs = (
      db.prepare('SELECT count(*) AS total FROM sop_run').get() as { total: number }
    ).total;
    return { definitions, runs };
  } finally {
    db.close();
  }
}

test('the scripted sop-create behaviour reports the tool as unavailable and writes no SOP', async () => {
  const fixture = await startFixture('sop-create');
  try {
    const reply = await sendOwnerMessage(fixture);
    assert.match(reply, /\[sop-create\] unavailable/);
    assert.match(reply, /\[sop-tools\] -/);
    assert.doesNotMatch(reply, /\[tools\][^\n]*sop/i, 'the round tool list has no SOP tool');
    assert.deepEqual(sopRowCounts(fixture.dataDir), { definitions: 0, runs: 0 });
  } finally {
    await stopFixture(fixture, true);
  }
});

test('the scripted sop-start behaviour reports the tool as unavailable and starts no run', async () => {
  const fixture = await startFixture('sop-start');
  try {
    const reply = await sendOwnerMessage(fixture);
    assert.match(reply, /\[sop-start\] unavailable/);
    assert.match(reply, /\[sop-tools\] -/);
    assert.doesNotMatch(reply, /\[tools\][^\n]*sop/i, 'the round tool list has no SOP tool');
    assert.deepEqual(sopRowCounts(fixture.dataDir), { definitions: 0, runs: 0 });
  } finally {
    await stopFixture(fixture, true);
  }
});

test('a normal round carries no SOP tool on any target context', async () => {
  const fixture = await startFixture('reply');
  try {
    const reply = await sendOwnerMessage(fixture);
    assert.match(reply, /\[tools\]/);
    assert.doesNotMatch(reply, /sop-create|sop-start|SopCreate|SopStart/i);
    assert.deepEqual(sopRowCounts(fixture.dataDir), { definitions: 0, runs: 0 });
  } finally {
    await stopFixture(fixture, true);
  }
});
