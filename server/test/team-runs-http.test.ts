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
 * `GET /api/targets/{id}/team-runs` (#38 / D2.3 / D3.3): the run snapshot is a
 * data-directory artifact, not a message. The test reads it through the HTTP
 * face and seeds the rows directly (the write paths that create them have their
 * own tests); no private function is called.
 */

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startFixture(
  prefix: string,
  args: readonly string[] = ['--scripted-provider', 'reply'],
): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-team-runs-test' },
    args,
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
  const consent = await fetch(`${fixture.base}/api/remote-data-flow/openai/consent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
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
    name: '运行记录频道',
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
): Promise<{ taskId: string; targetId: string }> {
  const response = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(response.status, 201, await response.clone().text());
  const body = await readJson(response);
  return { taskId: body['id'] as string, targetId: body['target_id'] as string };
}

async function makeTeam(fixture: Fixture, channelId: string, leaderId: string): Promise<void> {
  const response = await patchJson(fixture, `/api/channels/${channelId}`, {
    mode: 'team',
    team_leader_member_id: leaderId,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

interface RunSeed {
  id: string;
  targetId: string;
  channelId: string;
  taskId: string | null;
  leaderId: string;
  status: string;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function insertRun(fixture: Fixture, run: RunSeed): void {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  try {
    db.prepare(
      `INSERT INTO team_run
         (id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at,
          finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id,
      run.targetId,
      run.channelId,
      run.taskId,
      run.leaderId,
      run.status,
      run.reason,
      run.startedAt,
      run.finishedAt,
    );
  } finally {
    db.close();
  }
}

function insertAssignment(
  fixture: Fixture,
  input: {
    id: string;
    runId: string;
    targetId: string;
    taskId: string | null;
    memberId: string;
    state: string;
    jump: number;
    startedAt: string;
    finishedAt: string | null;
  },
): void {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  try {
    db.prepare(
      `INSERT INTO team_assignment
         (id, team_run_id, target_id, task_id, member_id, state, jump_consumed, reply_excerpt,
          reason, started_at, finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
    ).run(
      input.id,
      input.runId,
      input.targetId,
      input.taskId,
      input.memberId,
      input.state,
      input.jump,
      input.startedAt,
      input.finishedAt,
    );
  } finally {
    db.close();
  }
}

async function listTeamRuns(
  fixture: Fixture,
  targetId: string,
  query = '',
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/team-runs${query}`);
  return { status: response.status, body: await readJson(response) };
}

async function setupTeam(
  fixture: Fixture,
): Promise<{ leader: string; member: string; channelId: string; taskId: string; taskTargetId: string }> {
  const leader = await createAgent(fixture, '队长');
  const member = await createAgent(fixture, '成员');
  const channelId = await createChannel(fixture);
  await joinChannel(fixture, channelId, leader);
  await joinChannel(fixture, channelId, member);
  // The task is created while the channel is still autonomous, so no team
  // change wake exists to perturb the read model; the PATCH then installs the
  // team topology.
  const task = await createTask(fixture, channelId, '任务');
  await makeTeam(fixture, channelId, leader);
  return { leader, member, channelId, ...task };
}

test('the team-run snapshot reads newest first, nests assignments and pages with before', async () => {
  const fixture = await startFixture('allibot-team-runs-list-');
  try {
    const { leader, member, channelId, taskId, targetId: taskTargetId } = await setupTeam(fixture);

    insertRun(fixture, {
      id: 'run-old',
      targetId: channelId,
      channelId,
      taskId: null,
      leaderId: leader,
      status: 'completed',
      reason: null,
      startedAt: '2026-11-04T01:00:00.000Z',
      finishedAt: '2026-11-04T01:00:01.000Z',
    });
    insertRun(fixture, {
      id: 'run-middle',
      targetId: channelId,
      channelId,
      taskId: null,
      leaderId: leader,
      status: 'failed',
      reason: '脚本化 provider：本轮被设定为失败',
      startedAt: '2026-11-04T02:00:00.000Z',
      finishedAt: '2026-11-04T02:00:01.000Z',
    });
    insertRun(fixture, {
      id: 'run-new',
      targetId: channelId,
      channelId,
      taskId: null,
      leaderId: leader,
      status: 'invalid-leader',
      reason: '队长已被禁用（enabled=0）。',
      startedAt: '2026-11-04T03:00:00.000Z',
      finishedAt: '2026-11-04T03:00:00.000Z',
    });
    insertRun(fixture, {
      id: 'run-task',
      targetId: taskTargetId,
      channelId,
      taskId,
      leaderId: leader,
      status: 'completed',
      reason: null,
      startedAt: '2026-11-04T04:00:00.000Z',
      finishedAt: '2026-11-04T04:00:01.000Z',
    });
    insertAssignment(fixture, {
      id: 'assignment-1',
      runId: 'run-new',
      targetId: channelId,
      taskId: null,
      memberId: member,
      state: 'completed',
      jump: 1,
      startedAt: '2026-11-04T03:00:00.000Z',
      finishedAt: '2026-11-04T03:00:00.500Z',
    });

    const firstPage = await listTeamRuns(fixture, channelId, '?limit=2');
    assert.equal(firstPage.status, 200);
    const runs = firstPage.body['team_runs'] as Record<string, unknown>[];
    assert.deepEqual(runs.map((run) => run['id']), ['run-new', 'run-middle']);
    assert.equal(runs[0]?.['status'], 'invalid-leader');
    assert.equal(runs[0]?.['task_id'], null, 'a channel run has no task');
    assert.equal(runs[0]?.['channel_id'], channelId);
    const assignments = runs[0]?.['assignments'] as Record<string, unknown>[];
    assert.equal(assignments.length, 1, 'the nested assignment is part of the run reading');
    assert.equal(assignments[0]?.['member_id'], member);
    assert.equal(assignments[0]?.['jump_consumed'], 1);
    assert.deepEqual(runs[1]?.['assignments'], []);

    const secondPage = await listTeamRuns(fixture, channelId, '?limit=2&before=run-middle');
    assert.equal(secondPage.status, 200);
    assert.deepEqual(
      (secondPage.body['team_runs'] as Record<string, unknown>[]).map((run) => run['id']),
      ['run-old'],
      'before is the cursor of the last run on the previous page',
    );

    const taskPage = await listTeamRuns(fixture, taskTargetId);
    assert.equal(taskPage.status, 200);
    const taskRuns = taskPage.body['team_runs'] as Record<string, unknown>[];
    assert.deepEqual(taskRuns.map((run) => run['id']), ['run-task']);
    assert.equal(taskRuns[0]?.['task_id'], taskId, 'a task run names its task');
    assert.equal(taskRuns[0]?.['channel_id'], channelId, 'and its owning channel');
  } finally {
    await fixture.stop();
  }
});

test('the team-run snapshot validates limit, before, target existence and non-team targets', async () => {
  const fixture = await startFixture('allibot-team-runs-rules-');
  try {
    const { channelId } = await setupTeam(fixture);
    const autonomous = await createChannel(fixture);

    assert.equal((await listTeamRuns(fixture, channelId, '?limit=0')).status, 400);
    assert.equal((await listTeamRuns(fixture, channelId, '?limit=51')).status, 400);
    assert.equal((await listTeamRuns(fixture, channelId, '?limit=abc')).status, 400);
    assert.equal((await listTeamRuns(fixture, 'no-such-target')).status, 404);
    assert.equal(
      (await listTeamRuns(fixture, channelId, '?before=no-such-run')).status,
      400,
      'an unknown cursor is a client error rather than a silent empty page',
    );

    const empty = await listTeamRuns(fixture, autonomous, '?limit=5');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body['team_runs'], [], 'a non-team target reads an empty snapshot');

    const emptyTeam = await listTeamRuns(fixture, channelId, '?limit=5');
    assert.equal(emptyTeam.status, 200);
    assert.deepEqual(emptyTeam.body['team_runs'], [], 'a team target with no runs reads empty');
  } finally {
    await fixture.stop();
  }
});

test('run records stay out of the message stream, unread and search', async () => {
  const fixture = await startFixture('allibot-team-runs-not-message-');
  try {
    const { leader, channelId } = await setupTeam(fixture);
    const messagesBefore = await readJson(
      await fetch(`${fixture.base}/api/targets/${channelId}/messages`),
    );
    insertRun(fixture, {
      id: 'run-visible',
      targetId: channelId,
      channelId,
      taskId: null,
      leaderId: leader,
      status: 'failed',
      reason: '运行记录里的可读原因',
      startedAt: '2026-11-04T05:00:00.000Z',
      finishedAt: '2026-11-04T05:00:01.000Z',
    });

    const messages = await readJson(
      await fetch(`${fixture.base}/api/targets/${channelId}/messages`),
    );
    assert.deepEqual(messages['messages'], messagesBefore['messages'], 'a run is not a message');

    const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
    assert.equal(
      (workspace['unread_by_target'] as Record<string, number>)[channelId],
      0,
      'a run changes no unread reading',
    );

    const search = await readJson(
      await fetch(`${fixture.base}/api/search?q=${encodeURIComponent('运行记录里的可读原因')}`),
    );
    assert.deepEqual(search['hits'], [], 'a run is not a search hit');
  } finally {
    await fixture.stop();
  }
});

async function postMessage(
  fixture: Fixture,
  targetId: string,
  body: string,
): Promise<{ id: string; seq: number }> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
  const parsed = await readJson(response);
  return { id: parsed['id'] as string, seq: parsed['seq'] as number };
}

function readDatabase<T>(
  fixture: Fixture,
  sql: string,
  params: unknown[] = [],
): T[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

interface RunReading {
  id: string;
  target_id: string;
  channel_id: string;
  task_id: string | null;
  leader_member_id: string;
  status: string;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

interface OutcomeReading {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
}

test('a leader round opens and completes one run for its channel or task target', async () => {
  const fixture = await startFixture('allibot-team-run-lifecycle-');
  try {
    const { leader, channelId, taskId, targetId: taskTargetId } = await setupTeam(fixture);

    await postMessage(fixture, channelId, '频道里的一句话');

    const channelRuns = readDatabase<RunReading>(
      fixture,
      'SELECT id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at, finished_at FROM team_run WHERE target_id = ?',
      [channelId],
    );
    assert.equal(channelRuns.length, 1, 'one leader round, one run');
    assert.equal(channelRuns[0]?.status, 'completed');
    assert.equal(channelRuns[0]?.leader_member_id, leader);
    assert.equal(channelRuns[0]?.task_id, null, 'a channel target run names no task');
    assert.equal(channelRuns[0]?.channel_id, channelId);
    assert.equal(channelRuns[0]?.reason, null);
    assert.ok(channelRuns[0]?.started_at.length);
    assert.ok(channelRuns[0]?.finished_at !== null);

    await postMessage(fixture, taskTargetId, '任务线程里的一句话');

    const taskRuns = readDatabase<RunReading>(
      fixture,
      'SELECT id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at, finished_at FROM team_run WHERE target_id = ?',
      [taskTargetId],
    );
    assert.equal(taskRuns.length, 1);
    assert.equal(taskRuns[0]?.status, 'completed');
    assert.equal(taskRuns[0]?.task_id, taskId, 'a task target run names its task');
    assert.equal(taskRuns[0]?.channel_id, channelId);
    assert.equal(taskRuns[0]?.leader_member_id, leader);

    const outcomes = readDatabase<OutcomeReading>(
      fixture,
      'SELECT member_id, target_id, base_seq, status, reason FROM round_outcome ORDER BY rowid',
    );
    assert.deepEqual(
      outcomes.map((row) => [row.target_id, row.member_id, row.status]),
      [
        [channelId, leader, 'replied'],
        [taskTargetId, leader, 'replied'],
      ],
      'the leader runs; no ordinary member receives a round',
    );
  } finally {
    await fixture.stop();
  }
});

test('a failed leader round closes its run as failed with the readable reason', async () => {
  const fixture = await startFixture('allibot-team-run-failed-', [
    '--scripted-provider',
    'fail',
  ]);
  try {
    const { channelId } = await setupTeam(fixture);
    await postMessage(fixture, channelId, '会失败的一轮');

    const runs = readDatabase<RunReading>(
      fixture,
      'SELECT id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at, finished_at FROM team_run WHERE target_id = ?',
      [channelId],
    );
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.status, 'failed');
    assert.match(String(runs[0]?.reason), /脚本化 provider/);
    assert.ok(runs[0]?.finished_at !== null);
  } finally {
    await fixture.stop();
  }
});

test('a restart closes a residual running run as failed/interrupted without replaying anything', async () => {
  const dataDir = await makeTempDir('allibot-team-run-restart-');
  const env = { OPENAI_API_KEY: 'sk-team-runs-test' };
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  let running = await startServer(dataDir, {
    env,
    args: ['--scripted-provider', 'delay', '--scripted-delay-ms', '5000'],
  });
  let fixture: Fixture = {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
  try {
    const consent = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    assert.equal(consent.status, 200, await consent.clone().text());
    const { leader, channelId } = await setupTeam(fixture);

    await postMessage(fixture, channelId, '会让进程留下 running 的一条消息');
    // The human message is the only row the request committed; the deferred
    // leader round has not settled yet.
    const messagesAfterPost = readDatabase<{ total: number }>(
      fixture,
      'SELECT count(*) AS total FROM message',
    )[0]?.total;

    const deadline = Date.now() + 5000;
    let residual: RunReading | undefined;
    while (Date.now() < deadline) {
      const rows = readDatabase<RunReading>(
        fixture,
        'SELECT id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at, finished_at FROM team_run WHERE status = \'running\'',
      );
      if (rows.length === 1) {
        residual = rows[0];
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(residual !== undefined, 'the deferred round leaves a running run');
    assert.equal(residual.status, 'running');
    assert.equal(residual.finished_at, null);
    assert.equal(residual.leader_member_id, leader);

    await running.crash();

    const assignmentsBefore = readDatabase<{ total: number }>(
      fixture,
      'SELECT count(*) AS total FROM team_assignment',
    )[0]?.total;
    const budgetBefore = readDatabase<{ used: number; epoch_seq: number }>(
      fixture,
      'SELECT used, epoch_seq FROM target_budget WHERE target_id = ?',
      [channelId],
    )[0];

    running = await startServer(dataDir, { env, args: ['--scripted-provider', 'reply'] });
    fixture = {
      dataDir,
      running,
      base: `http://127.0.0.1:${running.port}`,
      stop: async () => {
        await running.stop();
        await removeTempDir(dataDir);
      },
    };

    const closed = readDatabase<RunReading>(
      fixture,
      'SELECT id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at, finished_at FROM team_run WHERE id = ?',
      [residual.id],
    )[0];
    assert.equal(closed?.status, 'failed');
    assert.match(String(closed?.reason), /interrupted/);
    assert.equal(closed?.started_at, residual.started_at, 'the start time is frozen');
    assert.ok(closed?.finished_at !== null);

    assert.equal(
      readDatabase<{ total: number }>(fixture, 'SELECT count(*) AS total FROM message')[0]?.total,
      messagesAfterPost,
      'the restart closure writes no message and the killed round lands none',
    );
    assert.equal(
      readDatabase<{ total: number }>(fixture, 'SELECT count(*) AS total FROM team_assignment')[0]
        ?.total,
      assignmentsBefore,
      'the restart closure writes no assignment',
    );
    assert.deepEqual(
      readDatabase<{ used: number; epoch_seq: number }>(
        fixture,
        'SELECT used, epoch_seq FROM target_budget WHERE target_id = ?',
        [channelId],
      )[0],
      budgetBefore,
      'the restart closure refunds nothing',
    );
  } finally {
    await fixture.stop();
  }
});
