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
 * Team 任务线程收窄 (#38 / D3.2 / D3.3 / D3.5 / D3.8): creating a task wakes
 * the leader once, owner reassignment wakes the leader with `team-change`,
 * ordinary task messages reach only the leader, no penetration happens on a
 * task target, and an unusable leader leaves an `invalid-leader` run instead of
 * a round. Claim and auto-continue do not exist in a team task thread.
 *
 * Everything is observed through the HTTP face plus the data directory's public
 * artifacts (messages, round_outcome, team_run, target_member).
 */

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

const LEADER_NAME = '队长';
const MEMBER_NAME = '成员';
const AGENT_MESSAGE_FIXTURE = path.join(
  REPO_ROOT,
  'server',
  'test',
  'fixtures',
  'agent-message.mjs',
);

async function startFixture(
  prefix: string,
  behavior = 'reply',
): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-team-task-thread-test' },
    args: ['--scripted-provider', behavior],
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

async function postJson(
  fixture: Fixture,
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
  fixture: Fixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(
  fixture: Fixture,
  name: string,
  autoClaim: 0 | 1,
): Promise<string> {
  const response = await postJson(fixture, '/api/agents', {
    display_name: name,
    model: 'openai:gpt-5',
    auto_claim: autoClaim,
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function setupTeam(
  fixture: Fixture,
): Promise<{ leader: string; member: string; channelId: string }> {
  const leader = await createAgent(fixture, LEADER_NAME, 0);
  const member = await createAgent(fixture, MEMBER_NAME, 1);
  const created = await postJson(fixture, '/api/channels', {
    name: '任务线程频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 10,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const channelId = (await readJson(created))['id'] as string;
  for (const memberId of [leader, member]) {
    const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: memberId,
    });
    assert.equal(joined.status, 200, await joined.clone().text());
  }
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    mode: 'team',
    team_leader_member_id: leader,
  });
  assert.equal(patched.status, 200, await patched.clone().text());
  return { leader, member, channelId };
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
  task_pointer: string | null;
}

interface OutcomeReading {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
}

interface TeamRunReading {
  target_id: string;
  task_id: string | null;
  channel_id: string;
  leader_member_id: string;
  status: string;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

function messagesOf(fixture: Fixture, targetId: string): MessageReading[] {
  return readDatabase<MessageReading>(
    fixture,
    'SELECT seq, kind, author_member_id, body, task_pointer FROM message WHERE target_id = ? ORDER BY seq',
    [targetId],
  );
}

function outcomes(fixture: Fixture): OutcomeReading[] {
  return readDatabase<OutcomeReading>(
    fixture,
    'SELECT member_id, target_id, base_seq, status, reason FROM round_outcome ORDER BY rowid',
  );
}

function teamRuns(fixture: Fixture): TeamRunReading[] {
  return readDatabase<TeamRunReading>(
    fixture,
    'SELECT target_id, task_id, channel_id, leader_member_id, status, reason, started_at, finished_at FROM team_run ORDER BY rowid',
  );
}

test('creating a task in a team channel wakes the leader once from the created record', async () => {
  const fixture = await startFixture('allibot-team-task-create-');
  try {
    const { leader, member, channelId } = await setupTeam(fixture);
    const task = await createTask(fixture, channelId, '整理资料');

    const thread = messagesOf(fixture, task.targetId);
    assert.equal(thread[0]?.kind, 'system', 'the task thread opens with the creation record');
    assert.equal(thread[0]?.body, ZH_CN['task.event.created'].text.replace('{title}', '整理资料'));
    const createdSeq = thread[0]?.seq as number;
    assert.deepEqual(
      thread.filter((message) => message.kind === 'agent').map((message) => message.author_member_id),
      [leader],
      'the creation round is the leader reply that follows the record',
    );

    const channelThread = messagesOf(fixture, channelId);
    const pointer = channelThread.find((message) => message.task_pointer === task.id);
    assert.ok(pointer !== undefined, 'the channel carries the task pointer in the same write');
    assert.equal(pointer?.kind, 'system');

    const members = readDatabase<{ member_id: string }>(
      fixture,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [task.targetId],
    ).map((row) => row.member_id);
    assert.ok(members.includes(leader), 'the leader is a member of the task thread');

    const leaderOutcomes = outcomes(fixture).filter((row) => row.member_id === leader);
    assert.equal(leaderOutcomes.length, 1, 'the leader receives exactly one mandatory round');
    assert.equal(leaderOutcomes[0]?.target_id, task.targetId);
    assert.equal(leaderOutcomes[0]?.base_seq, createdSeq, 'from_seq is the 「任务已创建」 record');
    assert.equal(leaderOutcomes[0]?.status, 'replied');
    assert.ok(
      String(leaderOutcomes[0]?.reason).includes(ZH_CN['wake.teamChange'].text),
      `the reason names the task-change signal: ${leaderOutcomes[0]?.reason}`,
    );
    assert.ok(
      String(leaderOutcomes[0]?.reason).includes(ZH_CN['round.mandatory.teamChange'].text),
      'the mandatory mark is its own copy',
    );
    assert.ok(
      !String(leaderOutcomes[0]?.reason).includes(ZH_CN['round.mandatory.claim'].text),
      'a team-change round never claims it was a claim',
    );
    assert.ok(
      !String(leaderOutcomes[0]?.reason).includes(ZH_CN['round.mandatory.mention'].text),
      'a team-change round never claims it was a mention',
    );
    assert.ok(
      !String(leaderOutcomes[0]?.reason).includes(ZH_CN['round.mandatory.humanMessage'].text),
      'a team-change round never claims a human message',
    );

    const runs = teamRuns(fixture);
    assert.equal(runs.length, 1);
    assert.equal(runs[0]?.target_id, task.targetId);
    assert.equal(runs[0]?.task_id, task.id);
    assert.equal(runs[0]?.channel_id, channelId);
    assert.equal(runs[0]?.status, 'completed');

    const memberOutcomes = outcomes(fixture).filter((row) => row.member_id === member);
    assert.deepEqual(memberOutcomes, [], 'the ordinary member receives no round');

    const taskRow = readDatabase<{ status: string; claimed_at: string | null }>(
      fixture,
      'SELECT status, claimed_at FROM task WHERE id = ?',
      [task.id],
    )[0];
    assert.equal(taskRow?.status, 'todo', 'the task stays todo');
    assert.equal(taskRow?.claimed_at, null, 'team mode does not use the claim lock');
    assert.equal(
      thread.some((message) => message.body.includes(ZH_CN['task.event.claimed'].text.slice(0, 4))),
      false,
      'no claim record is appended',
    );
  } finally {
    await fixture.stop();
  }
});

test('a team task thread wakes only the leader and has no mention penetration', async () => {
  const fixture = await startFixture('allibot-team-task-wake-');
  try {
    const { leader, member, channelId } = await setupTeam(fixture);
    const task = await createTask(fixture, channelId, '任务线程');
    const human = await postMessage(fixture, task.targetId, `@${MEMBER_NAME} 你来说一句`);

    const thread = messagesOf(fixture, task.targetId);
    assert.deepEqual(
      thread.filter((message) => message.kind === 'agent').map((message) => message.author_member_id),
      [leader, leader],
      'the creation round and the thread message each land one leader reply',
    );
    assert.equal(
      thread.some((message) => message.author_member_id === member),
      false,
      'a mentioned non-leader is not delivered to (task targets do not penetrate)',
    );

    const taskOutcomes = outcomes(fixture).filter((row) => row.target_id === task.targetId);
    assert.deepEqual(
      taskOutcomes.filter((row) => row.member_id === member),
      [],
      'the mentioned non-leader has no round outcome',
    );
    const leaderRound = taskOutcomes.find((row) => row.base_seq === human.seq);
    assert.equal(leaderRound?.member_id, leader);
    assert.equal(leaderRound?.status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('a leader-authored task message wakes nobody', async () => {
  const fixture = await startFixture('allibot-team-task-leader-author-');
  try {
    const { leader, channelId } = await setupTeam(fixture);
    const task = await createTask(fixture, channelId, '队长自己说话');
    const outcomesBefore = outcomes(fixture).length;
    const messagesBefore = messagesOf(fixture, task.targetId).length;

    const result = spawnSync(
      process.execPath,
      [
        AGENT_MESSAGE_FIXTURE,
        JSON.stringify({
          dataDir: fixture.dataDir,
          targetId: task.targetId,
          authorMemberId: leader,
          body: '队长自己在任务线程里说的一句',
          behavior: 'reply',
        }),
      ],
      { encoding: 'utf8' },
    );
    assert.equal(
      result.status,
      0,
      `the agent-message fixture should succeed; output: ${result.stdout}${result.stderr}`,
    );

    assert.equal(
      messagesOf(fixture, task.targetId).length,
      messagesBefore + 1,
      'the leader-authored message still lands',
    );
    assert.equal(outcomes(fixture).length, outcomesBefore, 'a leader author is a zero-wake surface');
  } finally {
    await fixture.stop();
  }
});

test('owner reassignment updates the assignee and wakes the leader with team-change', async () => {
  const fixture = await startFixture('allibot-team-task-reassign-');
  try {
    const { leader, member, channelId } = await setupTeam(fixture);
    const task = await createTask(fixture, channelId, '需要改派');
    // The creation round is one wake; clear the reading by taking the count.
    const outcomesBefore = outcomes(fixture).length;

    const patched = await patchJson(fixture, `/api/tasks/${task.id}`, {
      assignee_member_id: member,
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    assert.equal((await readJson(patched))['assignee_member_id'], member);

    const thread = messagesOf(fixture, task.targetId);
    const change = thread.find((message) =>
      message.body.includes(ZH_CN['task.event.assignee.assigned'].text.replace('{assignee}', MEMBER_NAME)),
    );
    assert.ok(change !== undefined, 'the reassignment appends one system change record');
    assert.equal(change?.kind, 'system');

    const taskMembers = readDatabase<{ member_id: string }>(
      fixture,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [task.targetId],
    ).map((row) => row.member_id);
    assert.ok(taskMembers.includes(member), 'the new assignee joins the task thread');

    const newOutcomes = outcomes(fixture).slice(outcomesBefore);
    assert.equal(newOutcomes.length, 1, 'owner reassignment wakes the leader exactly once');
    assert.equal(newOutcomes[0]?.member_id, leader);
    assert.equal(newOutcomes[0]?.base_seq, change?.seq, 'from_seq is the change record');
    assert.equal(newOutcomes[0]?.status, 'replied');
    assert.ok(
      String(newOutcomes[0]?.reason).includes(ZH_CN['wake.teamChange'].text),
      'the reassignment round carries the team-change reason',
    );
  } finally {
    await fixture.stop();
  }
});

test('an unusable leader leaves invalid-leader runs on create, reassign and thread messages', async () => {
  const fixture = await startFixture('allibot-team-task-invalid-');
  try {
    const { leader, member, channelId } = await setupTeam(fixture);
    const disabled = await patchJson(fixture, `/api/agents/${leader}`, { enabled: 0 });
    assert.equal(disabled.status, 200, await disabled.clone().text());

    const task = await createTask(fixture, channelId, '队长不可用时创建');
    const afterCreate = teamRuns(fixture);
    assert.equal(afterCreate.length, 1);
    assert.equal(afterCreate[0]?.status, 'invalid-leader');
    assert.equal(afterCreate[0]?.target_id, task.targetId);
    assert.equal(afterCreate[0]?.task_id, task.id);
    assert.ok(afterCreate[0]?.reason?.includes('队长已被禁用'));
    assert.ok(afterCreate[0]?.started_at.length > 0);
    assert.ok(afterCreate[0]?.finished_at !== null);

    const reassigned = await patchJson(fixture, `/api/tasks/${task.id}`, {
      assignee_member_id: member,
    });
    assert.equal(reassigned.status, 200, await reassigned.clone().text());
    assert.equal(teamRuns(fixture).length, 2, 'the reassignment trigger lands its own invalid run');

    const message = await postMessage(fixture, task.targetId, '任务线程消息');
    assert.equal(teamRuns(fixture).length, 3, 'the thread message trigger lands its own invalid run');

    const rerun = await postMessage(fixture, channelId, '频道消息');
    assert.equal(teamRuns(fixture).filter((run) => run.target_id === channelId).length, 1);

    assert.deepEqual(outcomes(fixture).filter((row) => row.member_id === leader), []);
    assert.deepEqual(outcomes(fixture).filter((row) => row.member_id === member), []);
    assert.deepEqual(
      readDatabase(fixture, 'SELECT id FROM team_assignment'),
      [],
      'an invalid leader never creates an assignment',
    );
    assert.equal(
      readDatabase<{ used: number }>(fixture, 'SELECT used FROM target_budget').every(
        (row) => row.used === 0,
      ),
      true,
      'an invalid leader spends no budget (no wake ever reaches a jump)',
    );

    const thread = messagesOf(fixture, task.targetId);
    assert.ok(thread.some((row) => row.body === '任务线程消息'), 'messages still land');
    assert.ok(thread.some((row) => row.seq === message.seq));
    assert.ok(messagesOf(fixture, channelId).some((row) => row.body === '频道消息'));
    assert.ok(rerun.seq > 0);
  } finally {
    await fixture.stop();
  }
});

test('claim and auto-continue do not exist in a team task thread', async () => {
  // The double answers with the structured continue_task action, so the write
  // path's team guard is what must refuse it.
  const fixture = await startFixture('allibot-team-task-continue-', 'continue-task');
  try {
    const { leader, channelId } = await setupTeam(fixture);
    const task = await createTask(fixture, channelId, '不会认领也不会续跑');

    const taskRow = readDatabase<{ status: string; claimed_at: string | null }>(
      fixture,
      'SELECT status, claimed_at FROM task WHERE id = ?',
      [task.id],
    )[0];
    assert.equal(taskRow?.status, 'todo');
    assert.equal(taskRow?.claimed_at, null);

    await postMessage(fixture, task.targetId, '再来一句');

    const thread = messagesOf(fixture, task.targetId);
    assert.equal(
      thread.some((message) => message.body.includes('已认领')),
      false,
      'no claim record exists',
    );
    assert.equal(
      thread.some((message) => message.body.includes('申请续跑')),
      false,
      'no continue record exists',
    );

    const leaderOutcomes = outcomes(fixture).filter((row) => row.member_id === leader);
    assert.equal(leaderOutcomes.length, 2, 'the creation and the thread message each ran one round');
    for (const outcome of leaderOutcomes) {
      assert.equal(outcome.status, 'replied');
      assert.ok(
        String(outcome.reason).includes(ZH_CN['round.continue.teamDisabled'].text),
        `the team continue action reads as a structured refusal: ${outcome.reason}`,
      );
    }
    assert.equal(
      teamRuns(fixture).length,
      2,
      'a refused continue action starts no second round and no second run',
    );
  } finally {
    await fixture.stop();
  }
});
