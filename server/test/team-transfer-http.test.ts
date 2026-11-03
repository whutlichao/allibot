import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '../../shared/dist/index.js';
import {
  makeTempDir,
  removeTempDir,
  REPO_ROOT,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * `transfer_task` (转派, #38 / D3.5): the current assignee hands the task to
 * another live Agent member of the same channel. The write path is a member
 * round; the team channel adds one `team-change` wake to the leader, the
 * autonomous channel adds none. The run is driven by the narrow member-round
 * fixture because the HTTP face cannot name a member identity (a TeamAssign
 * sub-round is #39's delivery surface).
 */

const TEAM_ROUND_FIXTURE = path.join(
  REPO_ROOT,
  'server',
  'test',
  'fixtures',
  'team-round.mjs',
);

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startFixture(prefix: string): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-team-transfer-test' },
    args: ['--scripted-provider', 'reply'],
  });
  const fixture: Fixture = {
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
  assert.ok(typeof body === 'object' && body !== null);
  return body as Record<string, unknown>;
}

async function postJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(fixture: Fixture, name: string): Promise<string> {
  const response = await postJson(fixture, '/api/agents', {
    display_name: name,
    model: 'openai:gpt-5',
    auto_claim: 0,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function createChannel(fixture: Fixture): Promise<string> {
  const response = await postJson(fixture, '/api/channels', {
    name: '转派频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 10,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function joinChannel(fixture: Fixture, channelId: string, memberId: string): Promise<void> {
  const response = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function createTask(
  fixture: Fixture,
  channelId: string,
  title: string,
): Promise<{ id: string; targetId: string }> {
  const response = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(response.status, 201, await response.clone().text());
  const body = await readJson(response);
  return { id: body['id'] as string, targetId: body['target_id'] as string };
}

async function assign(
  fixture: Fixture,
  taskId: string,
  memberId: string,
): Promise<void> {
  const response = await patchJson(fixture, `/api/tasks/${taskId}`, {
    assignee_member_id: memberId,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function makeTeam(fixture: Fixture, channelId: string, leaderId: string): Promise<void> {
  const response = await patchJson(fixture, `/api/channels/${channelId}`, {
    mode: 'team',
    team_leader_member_id: leaderId,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

function readDatabase<T>(fixture: Fixture, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

interface MessageReading {
  seq: number;
  kind: string;
  author_member_id: string;
  body: string;
}

interface OutcomeReading {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
}

function messagesOf(fixture: Fixture, targetId: string): MessageReading[] {
  return readDatabase<MessageReading>(
    fixture,
    'SELECT seq, kind, author_member_id, body FROM message WHERE target_id = ? ORDER BY seq',
    [targetId],
  );
}

function outcomes(fixture: Fixture): OutcomeReading[] {
  return readDatabase<OutcomeReading>(
    fixture,
    'SELECT member_id, target_id, base_seq, status, reason FROM round_outcome ORDER BY rowid',
  );
}

function epochSeq(fixture: Fixture, targetId: string): number | null {
  const row = readDatabase<{ epoch_seq: number }>(
    fixture,
    'SELECT epoch_seq FROM target_budget WHERE target_id = ?',
    [targetId],
  )[0];
  return row?.epoch_seq ?? null;
}

function runMemberRound(
  fixture: Fixture,
  input: {
    targetId: string;
    memberId: string;
    fromSeq: number;
    reason?: string;
    behavior?: string;
    transferMemberId?: string;
  },
): { ok: boolean; status: number | null; reason: string | null; message?: string } {
  const result = spawnSync(
    process.execPath,
    [
      TEAM_ROUND_FIXTURE,
      JSON.stringify({
        dataDir: fixture.dataDir,
        behavior: 'transfer-task',
        ...input,
      }),
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, OPENAI_API_KEY: 'sk-team-transfer-test' },
    },
  );
  assert.equal(
    result.status,
    0,
    `the team-round fixture should succeed; output: ${result.stdout}${result.stderr}`,
  );
  return JSON.parse(result.stdout) as {
    ok: boolean;
    status: number | null;
    reason: string | null;
    message?: string;
  };
}

test('an autonomous task transfer changes the assignee, appends a system record and wakes nobody', async () => {
  const fixture = await startFixture('allibot-transfer-autonomous-');
  try {
    const first = await createAgent(fixture, '成员甲');
    const second = await createAgent(fixture, '成员乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, first);
    await joinChannel(fixture, channelId, second);
    const task = await createTask(fixture, channelId, '自主频道转派');
    await assign(fixture, task.id, first);

    const assigneeRecord = messagesOf(fixture, task.targetId).find(
      (message) => message.kind === 'system' && message.body.includes('任务已指派给'),
    );
    assert.ok(assigneeRecord !== undefined);
    const epochBefore = epochSeq(fixture, task.targetId);
    const outcomesBefore = outcomes(fixture).length;
    const messagesBefore = messagesOf(fixture, task.targetId);

    const result = runMemberRound(fixture, {
      targetId: task.targetId,
      memberId: first,
      fromSeq: assigneeRecord.seq,
      transferMemberId: second,
    });
    assert.equal(result.ok, true);
    assert.equal(result.status, 'replied');

    const taskRow = readDatabase<{ assignee_member_id: string }>(
      fixture,
      'SELECT assignee_member_id FROM task WHERE id = ?',
      [task.id],
    )[0];
    assert.equal(taskRow?.assignee_member_id, second);

    const members = readDatabase<{ member_id: string }>(
      fixture,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [task.targetId],
    ).map((row) => row.member_id);
    assert.ok(members.includes(second), 'the new assignee joins the task thread');

    const after = messagesOf(fixture, task.targetId);
    assert.equal(after.length, messagesBefore.length + 1, 'the transfer appends exactly one record');
    const transferRecord = after[after.length - 1];
    assert.equal(transferRecord?.kind, 'system');
    assert.equal(
      transferRecord?.body,
      ZH_CN['task.event.assignee.transferred'].text
        .replace('{previous}', '成员甲')
        .replace('{assignee}', '成员乙'),
    );
    assert.equal(
      after.some((message) => message.kind === 'agent'),
      false,
      'a transfer writes no message body',
    );
    assert.equal(epochSeq(fixture, task.targetId), epochBefore, 'a transfer opens no human epoch');
    assert.equal(
      outcomes(fixture).length,
      outcomesBefore + 1,
      'the autonomous transfer adds no wake and no second round',
    );
    assert.deepEqual(
      readDatabase(fixture, 'SELECT id FROM team_run'),
      [],
      'an autonomous channel writes no team run',
    );
  } finally {
    await fixture.stop();
  }
});

test('a team task transfer wakes the leader with team-change and keeps the task budget epoch', async () => {
  const fixture = await startFixture('allibot-transfer-team-');
  try {
    const leader = await createAgent(fixture, '队长');
    const first = await createAgent(fixture, '成员甲');
    const second = await createAgent(fixture, '成员乙');
    const channelId = await createChannel(fixture);
    for (const memberId of [leader, first, second]) {
      await joinChannel(fixture, channelId, memberId);
    }
    await makeTeam(fixture, channelId, leader);
    const task = await createTask(fixture, channelId, 'team 频道转派');
    await assign(fixture, task.id, first);

    const assigneeRecord = messagesOf(fixture, task.targetId).find(
      (message) => message.kind === 'system' && message.body.includes('任务已指派给'),
    );
    assert.ok(assigneeRecord !== undefined);
    const epochBefore = epochSeq(fixture, task.targetId);
    const runsBefore = readDatabase<{ id: string }>(fixture, 'SELECT id FROM team_run').length;
    const outcomesBefore = outcomes(fixture).length;

    const result = runMemberRound(fixture, {
      targetId: task.targetId,
      memberId: first,
      fromSeq: assigneeRecord.seq,
      transferMemberId: second,
    });
    assert.equal(result.ok, true);

    const taskRow = readDatabase<{
      assignee_member_id: string;
      status: string;
    }>(fixture, 'SELECT assignee_member_id, status FROM task WHERE id = ?', [task.id])[0];
    assert.equal(taskRow?.assignee_member_id, second);
    assert.equal(taskRow?.status, 'todo', 'a transfer does not change the five-state');

    assert.equal(epochSeq(fixture, task.targetId), epochBefore, 'the transfer keeps epoch_seq');

    const transferRecord = messagesOf(fixture, task.targetId).find(
      (message) => message.body.includes('转派给'),
    );
    assert.ok(transferRecord !== undefined);
    assert.equal(transferRecord?.kind, 'system');

    const newOutcomes = outcomes(fixture).slice(outcomesBefore);
    assert.equal(newOutcomes.length, 2, 'the transfer round plus the leader team-change round');
    const leaderRound = newOutcomes.find((row) => row.member_id === leader);
    assert.ok(leaderRound !== undefined, 'the leader runs the team-change round');
    assert.equal(leaderRound.base_seq, transferRecord?.seq, 'from_seq is the change record');
    assert.ok(
      String(leaderRound.reason).includes(ZH_CN['wake.teamChange'].text),
      'the leader round carries the team-change reason',
    );
    assert.equal(
      newOutcomes.find((row) => row.member_id !== leader)?.base_seq,
      assigneeRecord.seq,
      'the transfer actor round read the triggering message',
    );

    const newRuns = readDatabase<{
      target_id: string;
      task_id: string | null;
      status: string;
    }>(fixture, 'SELECT target_id, task_id, status FROM team_run ORDER BY rowid').slice(runsBefore);
    assert.equal(newRuns.length, 1, 'the leader team-change round writes one run');
    assert.equal(newRuns[0]?.target_id, task.targetId);
    assert.equal(newRuns[0]?.task_id, task.id);
    assert.equal(newRuns[0]?.status, 'completed');
    assert.deepEqual(
      readDatabase(fixture, 'SELECT id FROM team_assignment'),
      [],
      'no assignment is written by this ticket',
    );
  } finally {
    await fixture.stop();
  }
});

test('a leader who is the assignee transfers with zero additional wake', async () => {
  const fixture = await startFixture('allibot-transfer-leader-');
  try {
    const leader = await createAgent(fixture, '队长');
    const member = await createAgent(fixture, '成员');
    const channelId = await createChannel(fixture);
    for (const memberId of [leader, member]) {
      await joinChannel(fixture, channelId, memberId);
    }
    await makeTeam(fixture, channelId, leader);
    const task = await createTask(fixture, channelId, '队长自己转派');
    await assign(fixture, task.id, leader);

    const assigneeRecord = messagesOf(fixture, task.targetId).find(
      (message) => message.body.includes('任务已指派给'),
    );
    assert.ok(assigneeRecord !== undefined);
    const outcomesBefore = outcomes(fixture).length;
    const runsBefore = readDatabase<{ id: string }>(fixture, 'SELECT id FROM team_run').length;

    const result = runMemberRound(fixture, {
      targetId: task.targetId,
      memberId: leader,
      fromSeq: assigneeRecord.seq,
      transferMemberId: member,
    });
    assert.equal(result.ok, true);

    const taskRow = readDatabase<{ assignee_member_id: string }>(
      fixture,
      'SELECT assignee_member_id FROM task WHERE id = ?',
      [task.id],
    )[0];
    assert.equal(taskRow?.assignee_member_id, member);
    const transferRecord = messagesOf(fixture, task.targetId).find(
      (message) => message.body.includes('转派给'),
    );
    assert.ok(transferRecord !== undefined);

    const newOutcomes = outcomes(fixture).slice(outcomesBefore);
    assert.equal(newOutcomes.length, 1, 'the leader round itself is the only outcome');
    assert.equal(newOutcomes[0]?.member_id, leader);
    assert.notEqual(
      newOutcomes[0]?.base_seq,
      transferRecord?.seq,
      'no team-change round was woken by the leader-authored change',
    );
    assert.equal(
      readDatabase<{ id: string }>(fixture, 'SELECT id FROM team_run').length,
      runsBefore + 1,
      'only the leader round itself opened a run',
    );
  } finally {
    await fixture.stop();
  }
});

test('a transfer to a non-member is a structured refusal with no write and no wake', async () => {
  const fixture = await startFixture('allibot-transfer-refused-');
  try {
    const leader = await createAgent(fixture, '队长');
    const first = await createAgent(fixture, '成员甲');
    const channelId = await createChannel(fixture);
    for (const memberId of [leader, first]) {
      await joinChannel(fixture, channelId, memberId);
    }
    await makeTeam(fixture, channelId, leader);
    const task = await createTask(fixture, channelId, '拒绝转派');
    await assign(fixture, task.id, first);

    const assigneeRecord = messagesOf(fixture, task.targetId).find(
      (message) => message.body.includes('任务已指派给'),
    );
    assert.ok(assigneeRecord !== undefined);
    const messagesBefore = messagesOf(fixture, task.targetId).length;
    const outcomesBefore = outcomes(fixture).length;

    const result = runMemberRound(fixture, {
      targetId: task.targetId,
      memberId: first,
      fromSeq: assigneeRecord.seq,
      transferMemberId: 'not-a-channel-member',
    });
    assert.equal(result.ok, true, 'a refusal is a round result, not a process failure');
    assert.match(String(result.reason), /transfer_task/);
    assert.match(String(result.reason), /同一频道/);

    const taskRow = readDatabase<{ assignee_member_id: string }>(
      fixture,
      'SELECT assignee_member_id FROM task WHERE id = ?',
      [task.id],
    )[0];
    assert.equal(taskRow?.assignee_member_id, first, 'the assignee is unchanged');
    assert.equal(
      messagesOf(fixture, task.targetId).length,
      messagesBefore,
      'a refused transfer appends no record',
    );
    assert.equal(outcomes(fixture).length, outcomesBefore + 1, 'and wakes nobody');
  } finally {
    await fixture.stop();
  }
});
