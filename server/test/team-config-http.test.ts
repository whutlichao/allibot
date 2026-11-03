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
 * Team 模式配置 (#37 / D3.1 / D2.2 / D2.4): the owner opts a channel into
 * `team` by PATCH and names one leader; the read models carry `mode` and
 * `team {leader_member_id, status, reason}`. Everything is observed through the
 * human-face HTTP seam (REST + the global SSE stream).
 *
 * The leader is available only when it is a live Agent, `enabled=1`, a channel
 * member, and its model provider is ready (D3.8). The fixture therefore grants
 * the model consent and gives the process a credential — the same availability
 * setup the claim tests use — so "valid" is a real reading, not an unchecked
 * assumption.
 */

interface TeamFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface ChannelBody {
  id: string;
  mode: string;
  team: {
    leader_member_id: string | null;
    status: string;
    reason: string | null;
  };
  updated_at: string;
  [key: string]: unknown;
}

const CHANNEL_BODY = {
  name: 'team 配置频道',
  description: '队长与模式的读数',
  mode: 'autonomous',
  response_budget_limit: 3,
};

async function startTeamFixture(prefix: string): Promise<TeamFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-team-config-test' },
    args: ['--scripted-provider', 'reply'],
  });
  const fixture: TeamFixture = {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
  // A model Agent is available only after the remote data flow was confirmed
  // (D1.10 / D1.12); the team read model judges the same availability.
  const consent = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
  assert.equal(consent.status, 200, await consent.clone().text());
  return fixture;
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
  fixture: TeamFixture,
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
  fixture: TeamFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readChannel(fixture: TeamFixture, channelId: string): Promise<ChannelBody> {
  const response = await fetch(`${fixture.base}/api/channels/${channelId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response)) as unknown as ChannelBody;
}

async function createChannel(fixture: TeamFixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(
  fixture: TeamFixture,
  displayName: string,
  body: Record<string, unknown> = {},
): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
    ...body,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: TeamFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function ownerId(fixture: TeamFixture): Promise<string> {
  const workspace = await fetch(`${fixture.base}/api/workspace`);
  assert.equal(workspace.status, 200, await workspace.clone().text());
  const body = await readJson(workspace);
  return (body['owner'] as Record<string, unknown>)['id'] as string;
}

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

function countRows(dataDir: string, table: string): number {
  const row = queryDatabase<{ total: number }>(dataDir, `SELECT count(*) AS total FROM ${table}`);
  return row?.total ?? -1;
}

test('PATCH validates mode and the leader write path with 400 validation_failed', async () => {
  const fixture = await startTeamFixture('allibot-team-config-validate-');
  try {
    const channelId = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长候选');
    const other = await createAgent(fixture, '普通成员');
    const outsider = await createAgent(fixture, '频道外成员');
    const disabled = await createAgent(fixture, '被禁用的成员');
    const deleted = await createAgent(fixture, '被删除的成员');
    for (const memberId of [leader, other, disabled, deleted]) {
      await joinChannel(fixture, channelId, memberId);
    }
    const disabledPatch = await patchJson(fixture, `/api/agents/${disabled}`, { enabled: 0 });
    assert.equal(disabledPatch.status, 200, await disabledPatch.clone().text());
    const deletedResponse = await fetch(`${fixture.base}/api/agents/${deleted}`, {
      method: 'DELETE',
    });
    assert.equal(deletedResponse.status, 204, await deletedResponse.text());

    const owner = await ownerId(fixture);

    const withoutLeader = await patchJson(fixture, `/api/channels/${channelId}`, { mode: 'team' });
    assert.equal(withoutLeader.status, 400, await withoutLeader.clone().text());
    assert.equal(errorCode(await readJson(withoutLeader)), 'validation_failed');

    const ownerLeader = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: owner,
    });
    assert.equal(ownerLeader.status, 400, 'the leader must be an Agent, never the owner');
    assert.equal(errorCode(await readJson(ownerLeader)), 'validation_failed');

    const outsiderLeader = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: outsider,
    });
    assert.equal(outsiderLeader.status, 400, 'the leader must be a channel member');
    assert.equal(errorCode(await readJson(outsiderLeader)), 'validation_failed');

    const disabledLeader = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: disabled,
    });
    assert.equal(disabledLeader.status, 400, 'a disabled Agent cannot lead');
    assert.equal(errorCode(await readJson(disabledLeader)), 'validation_failed');

    const deletedLeader = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: deleted,
    });
    assert.equal(deletedLeader.status, 400, 'a soft-deleted Agent cannot lead');
    assert.equal(errorCode(await readJson(deletedLeader)), 'validation_failed');

    const unknownMode = await patchJson(fixture, `/api/channels/${channelId}`, { mode: 'solo' });
    assert.equal(unknownMode.status, 400);
    assert.equal(errorCode(await readJson(unknownMode)), 'validation_failed');

    const leaderWhileAutonomous = await patchJson(fixture, `/api/channels/${channelId}`, {
      team_leader_member_id: leader,
    });
    assert.equal(leaderWhileAutonomous.status, 400, 'a leader is only writable on a team channel');
    assert.equal(errorCode(await readJson(leaderWhileAutonomous)), 'validation_failed');

    // A rejected write leaves the channel autonomous and leaderless.
    const rejected = await readChannel(fixture, channelId);
    assert.equal(rejected.mode, 'autonomous');
    assert.equal(rejected.team.leader_member_id, null);
    assert.equal(
      queryDatabase<{ total: number }>(fixture.dataDir, 'SELECT count(*) AS total FROM channel')
        ?.total,
      1,
      'rejected PATCHes write no second channel',
    );
  } finally {
    await fixture.stop();
  }
});

test('a valid PATCH switches the channel to team and GET carries the same mode and leader reading', async () => {
  const fixture = await startTeamFixture('allibot-team-config-valid-');
  try {
    const channelId = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长');
    const other = await createAgent(fixture, '副手');
    await joinChannel(fixture, channelId, leader);
    await joinChannel(fixture, channelId, other);

    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    const patchedBody = (await readJson(patched)) as unknown as ChannelBody;
    assert.equal(patchedBody.mode, 'team');
    assert.equal(patchedBody.team.leader_member_id, leader);
    assert.equal(patchedBody.team.status, 'valid');
    assert.equal(patchedBody.team.reason, null);

    const reread = await readChannel(fixture, channelId);
    assert.equal(reread.mode, 'team');
    assert.equal(reread.team.leader_member_id, leader);
    assert.equal(reread.team.status, 'valid');
    assert.equal(reread.team.reason, null);

    // Switching the leader is the same PATCH endpoint with the same field
    // semantics: omitted mode means "unchanged".
    const switched = await patchJson(fixture, `/api/channels/${channelId}`, {
      team_leader_member_id: other,
    });
    assert.equal(switched.status, 200, await switched.clone().text());
    const switchedBody = (await readJson(switched)) as unknown as ChannelBody;
    assert.equal(switchedBody.mode, 'team');
    assert.equal(switchedBody.team.leader_member_id, other);

    const backToAutonomous = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'autonomous',
    });
    assert.equal(backToAutonomous.status, 200, await backToAutonomous.clone().text());
    const autonomousBody = (await readJson(backToAutonomous)) as unknown as ChannelBody;
    assert.equal(autonomousBody.mode, 'autonomous');
    assert.equal(autonomousBody.team.leader_member_id, null, 'switching back clears the leader');
    assert.equal(
      queryDatabase<{ team_leader_member_id: string | null }>(
        fixture.dataDir,
        'SELECT team_leader_member_id FROM channel WHERE id = ?',
        [channelId],
      )?.team_leader_member_id,
      null,
      'the leader column is NULL in SQLite as well',
    );
  } finally {
    await fixture.stop();
  }
});

test('explicit null only clears the leader, and a team channel always keeps one', async () => {
  const fixture = await startTeamFixture('allibot-team-config-null-');
  try {
    const channelId = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长');
    await joinChannel(fixture, channelId, leader);

    // On an autonomous channel the leader is already NULL; the explicit clear
    // is allowed and changes nothing.
    const clearedAutonomous = await patchJson(fixture, `/api/channels/${channelId}`, {
      team_leader_member_id: null,
    });
    assert.equal(clearedAutonomous.status, 200, await clearedAutonomous.clone().text());

    const toTeam = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(toTeam.status, 200, await toTeam.clone().text());

    const clearedTeam = await patchJson(fixture, `/api/channels/${channelId}`, {
      team_leader_member_id: null,
    });
    assert.equal(clearedTeam.status, 400, 'team mode must keep a leader');
    assert.equal(errorCode(await readJson(clearedTeam)), 'validation_failed');
    assert.equal((await readChannel(fixture, channelId)).team.leader_member_id, leader);

    const nullMode = await patchJson(fixture, `/api/channels/${channelId}`, { mode: null });
    assert.equal(nullMode.status, 400, 'explicit null is not a valid mode');
    assert.equal(errorCode(await readJson(nullMode)), 'validation_failed');

    const both = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'autonomous',
      team_leader_member_id: leader,
    });
    assert.equal(both.status, 400, 'autonomous cannot carry a leader');
  } finally {
    await fixture.stop();
  }
});

test('a same-value PATCH is a replay: no updated_at move, no message, no wake, no auto_claim change', async () => {
  const fixture = await startTeamFixture('allibot-team-config-idempotent-');
  try {
    const channelId = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长', { auto_claim: 0 });
    await joinChannel(fixture, channelId, leader);

    const first = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = (await readJson(first)) as unknown as ChannelBody;

    const replay = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(replay.status, 200, await replay.clone().text());
    const replayBody = (await readJson(replay)) as unknown as ChannelBody;
    assert.deepEqual(replayBody, firstBody, 'a same-value replay returns the same reading');
    assert.equal(
      replayBody.updated_at,
      firstBody.updated_at,
      'a replay does not move the updated_at stamp',
    );

    const stored = queryDatabase<{ updated_at: string; auto_claim: number }>(
      fixture.dataDir,
      `SELECT c.updated_at, a.auto_claim
         FROM channel c JOIN agent_config a ON a.member_id = ?
        WHERE c.id = ?`,
      [leader, channelId],
    );
    assert.equal(stored?.updated_at, firstBody.updated_at);
    assert.equal(stored?.auto_claim, 0, 'a team config write never changes auto_claim');
    assert.equal(countRows(fixture.dataDir, 'message'), 0, 'a config write stores no message');
    assert.equal(countRows(fixture.dataDir, 'round_outcome'), 0, 'a config write wakes nobody');

    // A real change still moves the stamp, so the replay rule did not silence
    // ordinary edits.
    const renamed = await patchJson(fixture, `/api/channels/${channelId}`, {
      name: '改名后的频道',
    });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    const renamedBody = (await readJson(renamed)) as unknown as ChannelBody;
    assert.notEqual(renamedBody.updated_at, firstBody.updated_at);

    const sameName = await patchJson(fixture, `/api/channels/${channelId}`, {
      name: '改名后的频道',
    });
    assert.equal(sameName.status, 200);
    assert.equal(
      ((await readJson(sameName)) as unknown as ChannelBody).updated_at,
      renamedBody.updated_at,
      'replaying the same name is also a no-op',
    );
  } finally {
    await fixture.stop();
  }
});

test('changing the leader writes it into every task target while the channel member reading stays put', async () => {
  const fixture = await startTeamFixture('allibot-team-config-propagate-');
  try {
    const channelId = await createChannel(fixture);
    const first = await createAgent(fixture, '第一任队长', { auto_claim: 0 });
    const second = await createAgent(fixture, '第二任队长', { auto_claim: 0 });
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);

    const taskTargets: string[] = [];
    for (const title of ['任务甲', '任务乙']) {
      const created = await postJson(fixture, '/api/tasks', {
        channel_id: channelId,
        title,
      });
      assert.equal(created.status, 201, await created.clone().text());
      taskTargets.push((await readJson(created))['target_id'] as string);
    }

    const channelMembersBefore = await readMembers(fixture, `/api/channels/${channelId}/members`);
    const toTeam = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: first,
    });
    assert.equal(toTeam.status, 200, await toTeam.clone().text());
    for (const targetId of taskTargets) {
      const members = await readMembers(fixture, `/api/targets/${targetId}/members`);
      assert.ok(
        members.includes(first),
        `the first leader joins every task target; target ${targetId} has ${members.join(', ')}`,
      );
    }

    const switched = await patchJson(fixture, `/api/channels/${channelId}`, {
      team_leader_member_id: second,
    });
    assert.equal(switched.status, 200, await switched.clone().text());
    for (const targetId of taskTargets) {
      const members = await readMembers(fixture, `/api/targets/${targetId}/members`);
      assert.ok(members.includes(second), 'the new leader joins every task target');
      assert.ok(members.includes(first), 'the old leader row is kept');
    }

    const channelMembersAfter = await readMembers(fixture, `/api/channels/${channelId}/members`);
    assert.deepEqual(
      channelMembersAfter,
      channelMembersBefore,
      'the channel member reading is not rewritten by the leader write',
    );
  } finally {
    await fixture.stop();
  }
});

async function readMembers(fixture: TeamFixture, route: string): Promise<string[]> {
  const response = await fetch(`${fixture.base}${route}`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await readJson(response);
  return (body['members'] as Record<string, unknown>[]).map((member) => member['id'] as string);
}

test('workspace and task readings carry mode / team and the derived channel_mode, and the task row has no mode column', async () => {
  const fixture = await startTeamFixture('allibot-team-config-reading-');
  try {
    const teamChannel = await createChannel(fixture);
    const autonomousChannel = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长', { auto_claim: 0 });
    await joinChannel(fixture, teamChannel, leader);
    const toTeam = await patchJson(fixture, `/api/channels/${teamChannel}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(toTeam.status, 200, await toTeam.clone().text());

    const teamTask = await postJson(fixture, '/api/tasks', {
      channel_id: teamChannel,
      title: 'team 任务',
    });
    assert.equal(teamTask.status, 201, await teamTask.clone().text());
    const teamTaskView = await readJson(teamTask);
    assert.equal(teamTaskView['channel_mode'], 'team');

    const autonomousTask = await postJson(fixture, '/api/tasks', {
      channel_id: autonomousChannel,
      title: '自主任务',
    });
    assert.equal(autonomousTask.status, 201, await autonomousTask.clone().text());
    assert.equal((await readJson(autonomousTask))['channel_mode'], 'autonomous');

    const workspaceResponse = await fetch(`${fixture.base}/api/workspace`);
    assert.equal(workspaceResponse.status, 200, await workspaceResponse.clone().text());
    const workspace = await readJson(workspaceResponse);
    const channels = workspace['channels'] as ChannelBody[];
    const teamReading = channels.find((channel) => channel.id === teamChannel);
    assert.ok(teamReading !== undefined);
    assert.equal(teamReading.mode, 'team');
    assert.equal(teamReading.team.leader_member_id, leader);
    assert.equal(teamReading.team.status, 'valid');
    assert.equal(teamReading.team.reason, null);
    const autonomousReading = channels.find((channel) => channel.id === autonomousChannel);
    assert.equal(autonomousReading?.mode, 'autonomous');
    assert.equal(autonomousReading?.team.leader_member_id, null);

    const tasks = workspace['tasks'] as Record<string, unknown>[];
    assert.deepEqual(
      tasks.map((task) => [task['title'], task['channel_mode']]),
      [
        ['team 任务', 'team'],
        ['自主任务', 'autonomous'],
      ],
      'the workspace task reading resolves each channel through its mode',
    );

    const listResponse = await fetch(`${fixture.base}/api/tasks`);
    assert.equal(listResponse.status, 200);
    const listed = (await readJson(listResponse))['tasks'] as Record<string, unknown>[];
    assert.deepEqual(
      listed.map((task) => [task['id'], task['channel_mode']]),
      tasks.map((task) => [task['id'], task['channel_mode']]),
    );

    const detailResponse = await fetch(
      `${fixture.base}/api/tasks/${String(teamTaskView['id'])}`,
    );
    assert.equal(detailResponse.status, 200);
    assert.equal((await readJson(detailResponse))['channel_mode'], 'team');

    // `channel_mode` is derived on read: the task row has no mode column at all.
    const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
    try {
      const columns = (db.pragma('table_info(task)') as { name: string }[]).map(
        (column) => column.name,
      );
      assert.equal(columns.includes('mode'), false, 'task rows do not copy mode');
      assert.equal(columns.includes('channel_mode'), false, 'channel_mode is derived, not stored');
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('a disabled leader turns the team reading invalid with a readable reason and enabled=1 restores it', async () => {
  const fixture = await startTeamFixture('allibot-team-config-invalid-');
  try {
    const channelId = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长');
    await joinChannel(fixture, channelId, leader);
    const toTeam = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(toTeam.status, 200, await toTeam.clone().text());
    assert.equal((await readChannel(fixture, channelId)).team.status, 'valid');

    const disabled = await patchJson(fixture, `/api/agents/${leader}`, { enabled: 0 });
    assert.equal(disabled.status, 200, await disabled.clone().text());

    const invalid = await readChannel(fixture, channelId);
    assert.equal(invalid.mode, 'team', 'an invalid leader never falls back to autonomous');
    assert.equal(invalid.team.leader_member_id, leader);
    assert.equal(invalid.team.status, 'invalid');
    assert.ok(
      (invalid.team.reason ?? '').length > 0,
      'the invalid reading carries a readable reason',
    );
    assert.match(invalid.team.reason ?? '', /禁用/);

    const workspaceResponse = await fetch(`${fixture.base}/api/workspace`);
    const workspace = await readJson(workspaceResponse);
    const reading = (workspace['channels'] as ChannelBody[]).find(
      (channel) => channel.id === channelId,
    );
    assert.equal(reading?.team.status, 'invalid');
    assert.equal(reading?.team.reason, invalid.team.reason, 'one reason, one source');

    const restored = await patchJson(fixture, `/api/agents/${leader}`, { enabled: 1 });
    assert.equal(restored.status, 200, await restored.clone().text());
    assert.equal((await readChannel(fixture, channelId)).team.status, 'valid');
    assert.equal((await readChannel(fixture, channelId)).team.reason, null);
  } finally {
    await fixture.stop();
  }
});

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
}

/**
 * Read the one global subscription until the predicate matches. The stream is
 * live-only, so the reader opens before the write that should publish.
 */
async function waitForFrame(
  base: string,
  predicate: (frame: SseFrame) => boolean,
): Promise<SseFrame> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  timer.unref();
  try {
    const response = await fetch(`${base}/api/events`, {
      headers: { accept: 'text/event-stream' },
      signal: controller.signal,
    });
    assert.equal(response.status, 200);
    const body = response.body;
    assert.ok(body !== null);
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const event = /^event:\s*(.+)$/m.exec(block)?.[1];
          const data = /^data:\s*(.+)$/m.exec(block)?.[1];
          if (event === undefined || data === undefined) {
            continue;
          }
          const frame: SseFrame = {
            event,
            data: JSON.parse(data) as Record<string, unknown>,
          };
          if (predicate(frame)) {
            return frame;
          }
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  throw new Error('the subscription closed before the expected frame');
}

test('a team configuration change publishes workspace.changed with source=team on the one stream', async () => {
  const fixture = await startTeamFixture('allibot-team-config-sse-');
  try {
    const channelId = await createChannel(fixture);
    const leader = await createAgent(fixture, '队长');
    await joinChannel(fixture, channelId, leader);

    const watching = waitForFrame(
      fixture.base,
      (frame) => frame.event === 'workspace.changed' && frame.data['source'] === 'team',
    );

    // Give the subscription a moment to attach before the write publishes.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leader,
    });
    assert.equal(patched.status, 200, await patched.clone().text());

    const frame = await watching;
    assert.equal(frame.event, 'workspace.changed');
    assert.equal(frame.data['source'], 'team');
  } finally {
    await fixture.stop();
  }
});

test('an ordinary channel edit keeps source=channel, so the team source is the config-change signal', async () => {
  const fixture = await startTeamFixture('allibot-team-config-sse-channel-');
  try {
    const channelId = await createChannel(fixture);

    const watching = waitForFrame(
      fixture.base,
      (frame) => frame.event === 'workspace.changed' && frame.data['source'] === 'channel',
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    const renamed = await patchJson(fixture, `/api/channels/${channelId}`, { name: '改名' });
    assert.equal(renamed.status, 200, await renamed.clone().text());

    const frame = await watching;
    assert.equal(frame.data['source'], 'channel');
  } finally {
    await fixture.stop();
  }
});
