import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  REPO_ROOT,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * Team 唤醒面收窄 (#37 / D3.1 / D3.2 / D3.6 / D3.8): a team channel's
 * channel-type target wakes only the leader, a leader-authored message wakes
 * nobody, and an unusable leader produces zero wakes (the message still lands)
 * without ever falling back to the M1 member surface. The channel @mention
 * penetration stays outside the team pipeline: a mentioned non-leader is
 * delivered once and answers as an ordinary M1 message.
 *
 * Observed through the HTTP face; the round_outcome table is the data
 * directory's public forensic artifact, the same reading the M1 wake tests use.
 */

interface WakeFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface RoundOutcomeRow {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
}

const AGENT_MESSAGE_FIXTURE = path.join(
  REPO_ROOT,
  'server',
  'test',
  'fixtures',
  'agent-message.mjs',
);

async function startWakeFixture(prefix: string): Promise<WakeFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-team-wake-test' },
    args: ['--scripted-provider', 'reply'],
  });
  const fixture: WakeFixture = {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
  const consent = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
  assert.equal(consent.status, 200, await consent.clone().text());
  return fixture;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: WakeFixture,
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
  fixture: WakeFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: WakeFixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '唤醒收窄频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 10,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: WakeFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
    auto_claim: 0,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: WakeFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function makeTeam(
  fixture: WakeFixture,
  channelId: string,
  leaderId: string,
): Promise<void> {
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    mode: 'team',
    team_leader_member_id: leaderId,
  });
  assert.equal(patched.status, 200, await patched.clone().text());
}

async function postMessage(
  fixture: WakeFixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function listMessages(
  fixture: WakeFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

async function listMembers(
  fixture: WakeFixture,
  route: string,
): Promise<string[]> {
  const response = await fetch(`${fixture.base}${route}`);
  assert.equal(response.status, 200, await response.clone().text());
  return ((await readJson(response))['members'] as Record<string, unknown>[]).map(
    (member) => member['id'] as string,
  );
}

function readChannel(fixture: WakeFixture, channelId: string): Record<string, unknown> {
  return readDatabase<Record<string, unknown>>(
    fixture.dataDir,
    'SELECT mode, team_leader_member_id FROM channel WHERE id = ?',
    [channelId],
  ) as Record<string, unknown>;
}

function readDatabase<T>(
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

function ownerId(fixture: WakeFixture): string {
  const row = readDatabase<{ id: string }>(
    fixture.dataDir,
    "SELECT id FROM member WHERE kind = 'owner'",
  );
  assert.ok(row !== undefined, 'the migration seeds the owner');
  return row.id;
}

function outcomes(fixture: WakeFixture): RoundOutcomeRow[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT member_id, target_id, base_seq, status
           FROM round_outcome ORDER BY rowid`,
      )
      .all() as RoundOutcomeRow[];
  } finally {
    db.close();
  }
}

test('an owner message in a team channel wakes only the leader and the leader reply wakes nobody', async () => {
  const fixture = await startWakeFixture('allibot-team-wake-leader-');
  try {
    const leader = await createAgent(fixture, '队长');
    const member = await createAgent(fixture, '普通成员');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, leader);
    await joinChannel(fixture, channelId, member);
    await makeTeam(fixture, channelId, leader);

    await postMessage(fixture, channelId, { body: '请队长处理这件事' });

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['agent', leader],
      ],
      'only the leader lands an agent message, and its own reply wakes nobody',
    );
    assert.deepEqual(
      outcomes(fixture).map((row) => [row.member_id, row.status]),
      [[leader, 'replied']],
      'the ordinary member has zero round_outcome rows',
    );
  } finally {
    await fixture.stop();
  }
});

test('a leader-authored channel message delivers zero wakes and starts zero rounds', async () => {
  const fixture = await startWakeFixture('allibot-team-wake-author-');
  try {
    const leader = await createAgent(fixture, '队长');
    const member = await createAgent(fixture, '普通成员');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, leader);
    await joinChannel(fixture, channelId, member);
    await makeTeam(fixture, channelId, leader);

    const before = await listMessages(fixture, channelId);
    const fixtureResult = spawnSync(
      process.execPath,
      [
        AGENT_MESSAGE_FIXTURE,
        JSON.stringify({
          dataDir: fixture.dataDir,
          targetId: channelId,
          authorMemberId: leader,
          body: '队长自己发的一句',
          behavior: 'reply',
        }),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      fixtureResult.status,
      0,
      `the agent-message fixture should succeed; output: ${fixtureResult.stdout}${fixtureResult.stderr}`,
    );

    const after = await listMessages(fixture, channelId);
    assert.equal(after.length, before.length + 1, 'the leader-authored message still lands');
    assert.equal(after[after.length - 1]?.['author_member_id'], leader);
    assert.deepEqual(outcomes(fixture), [], 'a leader author is a zero-wake surface');
  } finally {
    await fixture.stop();
  }
});

test('a mentioned non-leader is delivered once, answers as an ordinary message and changes no team config', async () => {
  const fixture = await startWakeFixture('allibot-team-wake-mention-');
  try {
    const leader = await createAgent(fixture, '队长');
    const member = await createAgent(fixture, '被点名的成员');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, leader);
    await joinChannel(fixture, channelId, member);
    await makeTeam(fixture, channelId, leader);
    const membersBefore = await listMembers(fixture, `/api/channels/${channelId}/members`);

    // A channel @mention of a non-leader is outside the team pipeline: it is
    // still the M1 penetration path.
    await postMessage(fixture, channelId, { body: '@被点名的成员 你来说一句' });

    const messages = await listMessages(fixture, channelId);
    const memberReplies = messages.filter(
      (message) => message['kind'] === 'agent' && message['author_member_id'] === member,
    );
    assert.equal(memberReplies.length, 1, 'the mentioned non-leader is delivered exactly once');
    assert.equal(
      memberReplies[0]?.['kind'],
      'agent',
      'the penetration reply is an ordinary M1 agent message',
    );
    const memberOutcomes = outcomes(fixture).filter((row) => row.member_id === member);
    assert.equal(memberOutcomes.length, 1, 'one delivery, one round outcome');
    assert.equal(memberOutcomes[0]?.status, 'replied');

    const channel = await fetch(`${fixture.base}/api/channels/${channelId}`);
    assert.equal(channel.status, 200);
    const channelBody = await readJson(channel);
    assert.equal(channelBody['mode'], 'team');
    assert.equal(
      (channelBody['team'] as Record<string, unknown>)['leader_member_id'],
      leader,
      'the penetration does not change the leader',
    );
    assert.deepEqual(
      await listMembers(fixture, `/api/channels/${channelId}/members`),
      membersBefore,
      'the penetration does not rewrite the channel membership',
    );
  } finally {
    await fixture.stop();
  }
});

test('a disabled leader produces an invalid reading, zero wakes and zero rounds, and recovery needs no re-save', async () => {
  const fixture = await startWakeFixture('allibot-team-wake-invalid-');
  try {
    const leader = await createAgent(fixture, '队长');
    const member = await createAgent(fixture, '普通成员');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, leader);
    await joinChannel(fixture, channelId, member);
    await makeTeam(fixture, channelId, leader);

    const disabled = await patchJson(fixture, `/api/agents/${leader}`, { enabled: 0 });
    assert.equal(disabled.status, 200, await disabled.clone().text());

    await postMessage(fixture, channelId, { body: '队长不在时的一句话' });

    const channel = await readJson(await fetch(`${fixture.base}/api/channels/${channelId}`));
    assert.equal(channel['mode'], 'team', 'an invalid leader never falls back to autonomous');
    const team = channel['team'] as Record<string, unknown>;
    assert.equal(team['status'], 'invalid');
    assert.ok(String(team['reason']).length > 0);

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => message['kind']),
      ['human'],
      'the message still lands; nobody answers',
    );
    assert.deepEqual(outcomes(fixture), [], 'zero wakes, zero rounds, no fallback');
    assert.equal(readChannel(fixture, channelId)['team_leader_member_id'], leader);

    // Recovery is a read-path fact: restoring enabled=1 needs no config re-save.
    const restored = await patchJson(fixture, `/api/agents/${leader}`, { enabled: 1 });
    assert.equal(restored.status, 200, await restored.clone().text());
    await postMessage(fixture, channelId, { body: '恢复后的一句话' });

    const recovered = await listMessages(fixture, channelId);
    assert.deepEqual(
      recovered.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['human', ownerId(fixture)],
        ['agent', leader],
      ],
      'the next message after recovery wakes the leader again',
    );
    assert.deepEqual(
      outcomes(fixture).map((row) => row.member_id),
      [leader],
      'the ordinary member was never woken',
    );
  } finally {
    await fixture.stop();
  }
});

test('a DM keeps the M1 autonomous surface and has no team mode field', async () => {
  const fixture = await startWakeFixture('allibot-team-wake-dm-');
  try {
    const agent = await createAgent(fixture, '私信对象');
    const created = await postJson(fixture, '/api/dms', { agent_id: agent });
    assert.equal(created.status, 201, await created.clone().text());
    const dmId = (await readJson(created))['id'] as string;

    const dms = await readJson(await fetch(`${fixture.base}/api/dms`));
    const dm = (dms['dms'] as Record<string, unknown>[]).find((row) => row['id'] === dmId);
    assert.ok(dm !== undefined);
    assert.equal(Object.hasOwn(dm, 'mode'), false, 'a DM has no mode field');
    assert.equal(Object.hasOwn(dm, 'team'), false, 'a DM has no team reading');

    await postMessage(fixture, dmId, { body: '私信一句' });
    const messages = await listMessages(fixture, dmId);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [
        ['human', ownerId(fixture)],
        ['agent', agent],
      ],
      'the DM owner message wakes its Agent exactly like M1',
    );
    assert.deepEqual(
      outcomes(fixture).map((row) => [row.member_id, row.status]),
      [[agent, 'replied']],
    );
  } finally {
    await fixture.stop();
  }
});
