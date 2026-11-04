import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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
 * The four Plan tools through the member-face seam (#40 / D4.1): a scripted
 * `plan` round calls TaskCreate / TaskGet / TaskList / TaskUpdate, the lazy
 * `plan_run` persists per (target, member), and a task target / team target
 * (including a TeamAssign sub-round) carries the tools while a DM and an
 * autonomous channel's ordinary round do not.
 *
 * The tools are production paths; the scripted `plan` behaviour is the adapter
 * double, and its reply is how a process-level test reads what the tool calls
 * returned.
 */

type Scenario = 'task' | 'team-channel' | 'team-task' | 'dm' | 'channel';

interface PlanFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  scenario: Scenario;
  channelId: string;
  agentA: string;
  agentB: string;
  taskA: { id: string; targetId: string } | null;
  taskB: { id: string; targetId: string } | null;
  dmId: string | null;
  stop: () => Promise<void>;
}

interface FixtureOptions {
  scenario: Scenario;
  /** The leader double assigns this member (team-channel scenario). */
  assign?: boolean;
  extraArgs?: readonly string[];
}

function postJsonStatus(
  base: string,
  route: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).then(async (response) => {
    const text = await response.text();
    return {
      status: response.status,
      body: text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  });
}

async function postJson(
  base: string,
  route: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const result = await postJsonStatus(base, route, body);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${route} -> ${result.status}: ${JSON.stringify(result.body)}`,
  );
  return result.body;
}

async function patchJson(
  base: string,
  route: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, `${route} -> ${response.status}: ${text}`);
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function getJson(base: string, route: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `${route} -> ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

function readIds(dataDir: string): {
  channelId: string;
  agents: string[];
  taskA: { id: string; targetId: string } | null;
  taskB: { id: string; targetId: string } | null;
  dmId: string | null;
} {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const channel = db.prepare('SELECT id FROM channel ORDER BY rowid LIMIT 1').get() as {
      id: string;
    };
    const agents = (
      db.prepare("SELECT id FROM member WHERE kind = 'agent' ORDER BY rowid").all() as {
        id: string;
      }[]
    ).map((row) => row.id);
    const tasks = db
      .prepare('SELECT id, target_id FROM task ORDER BY rowid')
      .all() as { id: string; target_id: string }[];
    const dm = db.prepare("SELECT id FROM target WHERE kind = 'dm' ORDER BY rowid LIMIT 1").get() as
      | { id: string }
      | undefined;
    return {
      channelId: channel.id,
      agents,
      taskA: tasks[0] === undefined ? null : { id: tasks[0].id, targetId: tasks[0].target_id },
      taskB: tasks[1] === undefined ? null : { id: tasks[1].id, targetId: tasks[1].target_id },
      dmId: dm?.id ?? null,
    };
  } finally {
    db.close();
  }
}

async function startPlanFixture(prefix: string, options: FixtureOptions): Promise<PlanFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const setup = await startServer(dataDir, { args: ['--scripted-provider', 'reply'] });
  const setupBase = `http://127.0.0.1:${setup.port}`;
  try {
    const channelId = (await postJson(setupBase, '/api/channels', {
      name: '计划频道',
      description: '',
      mode: 'autonomous',
      response_budget_limit: 10,
    }))['id'] as string;
    const agentA = (await postJson(setupBase, '/api/agents', {
      display_name: '计划成员甲',
      model: 'openai:gpt-5',
    }))['id'] as string;
    const agentB = (await postJson(setupBase, '/api/agents', {
      display_name: '计划成员乙',
      model: 'openai:gpt-5',
    }))['id'] as string;
    for (const memberId of [agentA, agentB]) {
      await postJson(setupBase, `/api/channels/${channelId}/members`, { member_id: memberId });
    }

    if (options.scenario === 'dm') {
      await postJson(setupBase, '/api/dms', { agent_id: agentA });
    }
    if (options.scenario === 'team-channel' || options.scenario === 'team-task') {
      await patchJson(setupBase, `/api/channels/${channelId}`, {
        mode: 'team',
        team_leader_member_id: agentA,
      });
    }
    if (options.scenario === 'task' || options.scenario === 'team-task') {
      const task = await postJson(setupBase, '/api/tasks', {
        channel_id: channelId,
        title: '计划所在任务',
      });
      const taskId = task['id'] as string;
      await patchJson(setupBase, `/api/tasks/${taskId}`, { assignee_member_id: agentA });
    }
    if (options.scenario === 'task') {
      // A second task target assigned to the other member proves Plan runs do
      // not mix across (target, member) pairs.
      const taskB = await postJson(setupBase, '/api/tasks', {
        channel_id: channelId,
        title: '另一条任务',
      });
      await patchJson(setupBase, `/api/tasks/${taskB['id'] as string}`, {
        assignee_member_id: agentB,
      });
    }
  } finally {
    await setup.stop();
  }

  const ids = readIds(dataDir);
  const args = ['--scripted-provider', 'plan', ...(options.extraArgs ?? [])];
  if (options.assign === true) {
    args.push('--scripted-team-assign-member', ids.agents[1] ?? '');
  }
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-plan-tools-test' },
    args,
  });
  const base = `http://127.0.0.1:${running.port}`;
  await postJson(base, '/api/remote-data-flow/openai/consent', {});

  const stop = async (): Promise<void> => {
    await running.stop();
    await removeTempDir(dataDir);
  };
  return {
    dataDir,
    running,
    base,
    scenario: options.scenario,
    channelId: ids.channelId,
    agentA: ids.agents[0] ?? '',
    agentB: ids.agents[1] ?? '',
    taskA: ids.taskA,
    taskB: ids.taskB,
    dmId: ids.dmId,
    stop,
  };
}

function readDatabase<T>(
  fixture: PlanFixture,
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

interface PlanRunRow {
  id: string;
  target_id: string;
  member_id: string;
  created_at: string;
  updated_at: string;
}

interface PlanTaskRow {
  id: string;
  plan_run_id: string;
  title: string;
  status: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function planRuns(fixture: PlanFixture): PlanRunRow[] {
  return readDatabase<PlanRunRow>(
    fixture,
    'SELECT id, target_id, member_id, created_at, updated_at FROM plan_run ORDER BY created_at, rowid',
  );
}

function planTasks(fixture: PlanFixture): PlanTaskRow[] {
  return readDatabase<PlanTaskRow>(
    fixture,
    `SELECT id, plan_run_id, title, status, position, created_at, updated_at
       FROM plan_task ORDER BY plan_run_id, position`,
  );
}

interface MessageRow {
  seq: number;
  kind: string;
  author_member_id: string;
  body: string;
}

function targetMessages(fixture: PlanFixture, targetId: string): MessageRow[] {
  return readDatabase<MessageRow>(
    fixture,
    'SELECT seq, kind, author_member_id, body FROM message WHERE target_id = ? ORDER BY seq',
    [targetId],
  );
}

function agentReply(fixture: PlanFixture, targetId: string): string {
  const reply = targetMessages(fixture, targetId).find((message) => message.kind === 'agent');
  assert.ok(reply !== undefined, `the round lands one agent reply on ${targetId}`);
  return reply.body;
}

async function postTargetMessage(
  fixture: PlanFixture,
  targetId: string,
  body: string,
): Promise<void> {
  await postJson(fixture.base, `/api/targets/${targetId}/messages`, { body });
}

async function readPlans(
  fixture: PlanFixture,
  targetId: string,
  query = '',
): Promise<Record<string, unknown>[]> {
  const body = await getJson(fixture.base, `/api/targets/${targetId}/plans${query}`);
  return body['plans'] as Record<string, unknown>[];
}

/** Acceptance reads the rows through the sqlite3 CLI, not a private function. */
function sqlite3(fixture: PlanFixture, sql: string): string {
  const result = spawnSync(
    'sqlite3',
    [path.join(fixture.dataDir, 'allibot.db'), '-separator', '|', sql],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `sqlite3 should exit 0; stderr: ${result.stderr}`);
  return result.stdout.trim();
}

test('a task round creates the Plan lazily, appends items, reads them and updates the three-word status', async (t) => {
  const fixture = await startPlanFixture('allibot-plan-task-', { scenario: 'task' });
  t.after(async () => fixture.stop());
  const task = fixture.taskA;
  const taskB = fixture.taskB;
  assert.ok(task !== null);
  const beforeMessages = targetMessages(fixture, task.targetId);
  const beforeTask = sqlite3(fixture, `SELECT title, status, assignee_member_id FROM task WHERE id = '${task.id}'`);

  await postTargetMessage(fixture, task.targetId, '请列出你的计划');

  const runs = planRuns(fixture);
  assert.equal(runs.length, 1, 'TaskList + TaskCreate create exactly one plan_run');
  const run = runs[0];
  assert.ok(run !== undefined);
  assert.equal(run.target_id, task.targetId);
  assert.equal(run.member_id, fixture.agentA);
  assert.ok(Date.parse(run.created_at) > 0, 'created_at is a timestamp');
  assert.ok(Date.parse(run.updated_at) >= Date.parse(run.created_at));

  const tasks = planTasks(fixture);
  assert.deepEqual(
    tasks.map((row) => [row.title, row.status, row.position]),
    [
      ['PLAN-ITEM-ONE-UPDATED', 'in_progress', 0],
      ['PLAN-ITEM-TWO', 'pending', 1],
    ],
    'TaskCreate appends at the end and TaskUpdate changes the title / status',
  );
  assert.equal(tasks[0]?.plan_run_id, run.id);
  assert.equal(tasks[1]?.plan_run_id, run.id);
  assert.ok(Date.parse(tasks[0]?.created_at ?? '') > 0);
  assert.ok(Date.parse(tasks[1]?.updated_at ?? '') > 0);

  const cliRows = sqlite3(
    fixture,
    `SELECT title, status, position, length(created_at), length(updated_at)
       FROM plan_task WHERE plan_run_id = '${run.id}' ORDER BY position`,
  );
  assert.equal(
    cliRows,
    [
      'PLAN-ITEM-ONE-UPDATED|in_progress|0|24|24',
      'PLAN-ITEM-TWO|pending|1|24|24',
    ].join('\n'),
    'sqlite3 reads title / status / position / timestamps back',
  );

  const plans = await readPlans(fixture, task.targetId);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.['id'], run.id);
  assert.equal((plans[0]?.['tasks'] as unknown[]).length, 2);

  const reply = agentReply(fixture, task.targetId);
  assert.match(reply, /\[plan\] available:true/);
  assert.match(reply, new RegExp(`run:${run.id}`));
  assert.match(reply, /before:0 count:2/);
  assert.match(reply, /order:.*in_progress:0/);
  assert.match(reply, /order:.*pending:1/);
  assert.match(reply, /get:pending updated:in_progress/);
  assert.match(reply, /\[plan-tools\] .*TaskCreate,TaskGet,TaskList,TaskUpdate/);

  const afterMessages = targetMessages(fixture, task.targetId);
  assert.equal(
    afterMessages.length - beforeMessages.length,
    2,
    'Plan writes no message: only the human message and the round reply land',
  );
  assert.equal(afterMessages.at(-2)?.kind, 'human');
  assert.equal(afterMessages.at(-1)?.kind, 'agent');
  assert.equal(
    sqlite3(fixture, `SELECT title, status, assignee_member_id FROM task WHERE id = '${task.id}'`),
    beforeTask,
    'Plan never changes a task row',
  );

  const search = await getJson(
    fixture.base,
    `/api/search?q=${encodeURIComponent('PLAN-ITEM-ONE')}`,
  );
  assert.deepEqual(search['hits'], [], 'Plan items are not messages and are not searchable');

  const workspace = await getJson(fixture.base, '/api/workspace');
  assert.doesNotMatch(JSON.stringify(workspace), /PLAN-ITEM-ONE|PLAN-ITEM-TWO/, 'the task board reading carries no Plan item');
  const workspaceTasks = workspace['tasks'] as { id: string; status: string }[];
  assert.deepEqual(
    workspaceTasks.map((row) => row.id).sort(),
    [task.id, taskB?.id ?? ''].filter((id) => id.length > 0).sort(),
    'the task board reads only the real task rows',
  );
});

test('a second round for the same pair reuses the plan_run while another member or target gets its own', async (t) => {
  const fixture = await startPlanFixture('allibot-plan-reuse-', { scenario: 'task' });
  t.after(async () => fixture.stop());
  const taskA = fixture.taskA;
  const taskB = fixture.taskB;
  assert.ok(taskA !== null && taskB !== null);

  await postTargetMessage(fixture, taskA.targetId, '第一轮计划');
  const firstRun = planRuns(fixture)[0];
  assert.ok(firstRun !== undefined);
  assert.equal(planTasks(fixture).length, 2);

  await postTargetMessage(fixture, taskA.targetId, '第二轮计划');
  const afterSecond = planRuns(fixture);
  assert.equal(afterSecond.length, 1, 'the second round reuses the same plan_run');
  assert.equal(afterSecond[0]?.id, firstRun.id);
  assert.equal(firstRun.member_id, fixture.agentA);
  assert.deepEqual(
    planTasks(fixture).map((row) => row.position),
    [0, 1, 2, 3],
    'the second round appends to the same run',
  );
  assert.equal(planTasks(fixture).filter((row) => row.plan_run_id === firstRun.id).length, 4);

  await postTargetMessage(fixture, taskB.targetId, '另一张任务的计划');
  const afterOther = planRuns(fixture);
  assert.equal(afterOther.length, 2, 'a different target / member gets its own run');
  const otherRun = afterOther.find((run) => run.id !== firstRun.id);
  assert.ok(otherRun !== undefined);
  assert.equal(otherRun.target_id, taskB.targetId);
  assert.equal(otherRun.member_id, fixture.agentB);
  assert.notEqual(otherRun.id, firstRun.id);
  assert.equal(
    planTasks(fixture).filter((row) => row.plan_run_id === firstRun.id).length,
    4,
    'the first run keeps its own list',
  );

  const plansA = await readPlans(fixture, taskA.targetId);
  assert.equal(plansA.length, 1);
  assert.equal(plansA[0]?.['member_id'], fixture.agentA);
  const filteredB = await readPlans(fixture, taskA.targetId, `?member_id=${fixture.agentB}`);
  assert.deepEqual(filteredB, [], 'member filtering never mixes the two lists');
});

test('a team channel leader round and its TeamAssign sub-round both carry the four Plan tools', async (t) => {
  const fixture = await startPlanFixture('allibot-plan-team-channel-', {
    scenario: 'team-channel',
    assign: true,
  });
  t.after(async () => fixture.stop());

  await postTargetMessage(fixture, fixture.channelId, '请拆解并维护计划');

  const runs = planRuns(fixture);
  assert.equal(runs.length, 2, 'the leader and the assigned member each own one run');
  const leaderRun = runs.find((run) => run.member_id === fixture.agentA);
  const memberRun = runs.find((run) => run.member_id === fixture.agentB);
  assert.ok(leaderRun !== undefined, 'the leader round calls the Plan tools');
  assert.ok(memberRun !== undefined, 'the sub-round calls the Plan tools');
  assert.equal(leaderRun.target_id, fixture.channelId);
  assert.equal(memberRun.target_id, fixture.channelId);
  assert.equal(planTasks(fixture).filter((row) => row.plan_run_id === leaderRun.id).length, 2);
  assert.equal(planTasks(fixture).filter((row) => row.plan_run_id === memberRun.id).length, 2);

  const reply = agentReply(fixture, fixture.channelId);
  assert.match(reply, /\[plan\] available:true/);
  assert.match(reply, /\[plan-tools\] TeamAssign,TaskCreate,TaskGet,TaskList,TaskUpdate/);
  assert.match(reply, new RegExp(`\\[team-assign\\] ${fixture.agentB}=completed`));

  const assignment = readDatabase<{ reply_excerpt: string | null; state: string }>(
    fixture,
    'SELECT reply_excerpt, state FROM team_assignment',
  )[0];
  assert.ok(assignment !== undefined);
  assert.equal(assignment.state, 'completed');
  assert.match(assignment.reply_excerpt ?? '', /\[plan\] available:true/);
  assert.match(
    assignment.reply_excerpt ?? '',
    /\[plan-tools\] TaskCreate,TaskGet,TaskList,TaskUpdate/,
    'a member sub-round gets the Plan tools and cannot assign further',
  );
  assert.doesNotMatch(assignment.reply_excerpt ?? '', /TeamAssign/);

  const plans = await readPlans(fixture, fixture.channelId);
  assert.deepEqual(
    plans.map((plan) => plan['member_id']).sort(),
    [fixture.agentA, fixture.agentB].sort(),
  );
});

test('a team task round carries the Plan tools for the leader', async (t) => {
  const fixture = await startPlanFixture('allibot-plan-team-task-', { scenario: 'team-task' });
  t.after(async () => fixture.stop());
  const task = fixture.taskA;
  assert.ok(task !== null);

  await postTargetMessage(fixture, task.targetId, '任务线程里维护计划');

  const run = planRuns(fixture)[0];
  assert.ok(run !== undefined);
  assert.equal(run.target_id, task.targetId);
  assert.equal(run.member_id, fixture.agentA);
  assert.equal(planTasks(fixture).length, 2);
  const reply = agentReply(fixture, task.targetId);
  assert.match(
    reply,
    /\[plan-tools\] TeamAssign,transfer_task,TaskCreate,TaskGet,TaskList,TaskUpdate/,
    'a team task round is a team target round; the leader is also the assignee here',
  );
});

test('a DM and an autonomous channel ordinary round have no Plan tools and write no plan_run', async (t) => {
  const dm = await startPlanFixture('allibot-plan-dm-', { scenario: 'dm' });
  t.after(async () => dm.stop());
  assert.ok(dm.dmId !== null);
  await postTargetMessage(dm, dm.dmId, '私信里不需要计划');
  const dmReply = agentReply(dm, dm.dmId);
  assert.match(dmReply, /\[plan\] available:false/);
  assert.match(dmReply, /\[plan-tools\] -/, 'the round tool set is empty of Plan tools');
  assert.deepEqual(planRuns(dm), [], 'a DM writes no plan_run');

  const channel = await startPlanFixture('allibot-plan-channel-', { scenario: 'channel' });
  t.after(async () => channel.stop());
  await postTargetMessage(channel, channel.channelId, '自主频道普通轮次');
  const channelReply = agentReply(channel, channel.channelId);
  assert.match(channelReply, /\[plan\] available:false/);
  assert.match(channelReply, /\[plan-tools\] -/);
  assert.deepEqual(planRuns(channel), [], 'an autonomous ordinary round writes no plan_run');
});

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
  raw: string;
}

interface SseStream {
  next(predicate: (frame: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame | null>;
  close(): void;
}

/** One live `/api/events` connection, read frame by frame (live-only, no replay). */
async function connectEvents(base: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body !== null);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  let closed = false;
  const pump = (async (): Promise<void> => {
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
          if (event !== undefined && data !== undefined) {
            frames.push({ event, data: JSON.parse(data) as Record<string, unknown>, raw: block });
          }
        }
      }
    } catch {
      // The test closes the connection; that abort is not a failure.
    } finally {
      closed = true;
    }
  })();
  return {
    async next(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = frames.findIndex(predicate);
        if (index !== -1) {
          return frames.splice(index, 1)[0] ?? null;
        }
        if (closed || Date.now() >= deadline) {
          return null;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    close() {
      controller.abort();
      void pump;
    },
  };
}

function budgetUsed(fixture: PlanFixture, targetId: string): number | null {
  const rows = readDatabase<{ used: number }>(
    fixture,
    'SELECT used FROM target_budget WHERE target_id = ?',
    [targetId],
  );
  return rows[0]?.used ?? null;
}

function roundOutcomeCount(fixture: PlanFixture, targetId: string): number {
  return (
    readDatabase<{ total: number }>(
      fixture,
      'SELECT count(*) AS total FROM round_outcome WHERE target_id = ?',
      [targetId],
    )[0]?.total ?? 0
  );
}

test('each Plan mutation publishes a live plan_update with the full list and changes nothing else', async (t) => {
  const fixture = await startPlanFixture('allibot-plan-sse-', { scenario: 'task' });
  t.after(async () => fixture.stop());
  const task = fixture.taskA;
  assert.ok(task !== null);
  const beforeMessages = targetMessages(fixture, task.targetId).length;
  const beforeBudget = budgetUsed(fixture, task.targetId);
  const beforeOutcomes = roundOutcomeCount(fixture, task.targetId);
  const beforeTask = sqlite3(
    fixture,
    `SELECT title, status, assignee_member_id, updated_at FROM task WHERE id = '${task.id}'`,
  );

  const stream = await connectEvents(fixture.base);
  t.after(() => stream.close());

  await postTargetMessage(fixture, task.targetId, '请更新计划并直播');

  const frames: SseFrame[] = [];
  const firstFrame = await stream.next((candidate) => candidate.event === 'plan_update', 5000);
  assert.ok(firstFrame !== null, 'the stream carries plan_update frames');
  frames.push(firstFrame);
  let last: SseFrame = firstFrame;
  for (;;) {
    const frame = await stream.next((candidate) => candidate.event === 'plan_update', 300);
    if (frame === null) {
      break;
    }
    frames.push(frame);
    last = frame;
  }
  assert.ok(frames.length >= 3, 'each mutation announces its own frame');
  for (const frame of frames) {
    assert.deepEqual(Object.keys(frame.data).sort(), [
      'member_id',
      'occurred_at',
      'plan_run_id',
      'target_id',
      'tasks',
    ]);
    assert.doesNotMatch(frame.raw, /^id:/m, 'the stream never emits an id line');
    assert.match(frame.raw, /^event: plan_update$/m);
  }

  const run = planRuns(fixture)[0];
  assert.ok(run !== undefined);
  assert.equal(last.data['plan_run_id'], run.id);
  assert.equal(last.data['target_id'], task.targetId);
  assert.equal(last.data['member_id'], fixture.agentA);
  assert.equal(last.data['occurred_at'], run.updated_at);
  const framesTasks = last.data['tasks'] as {
    title: string;
    status: string;
    position: number;
  }[];
  assert.deepEqual(
    framesTasks.map((taskRow) => [taskRow.title, taskRow.status, taskRow.position]),
    [
      ['PLAN-ITEM-ONE-UPDATED', 'in_progress', 0],
      ['PLAN-ITEM-TWO', 'pending', 1],
    ],
    'the frame carries the complete current list, not a delta',
  );

  const extra = await stream.next((candidate) => candidate.event === 'plan_update', 250);
  assert.equal(extra, null, 'a read-only tool call announces nothing');

  const late = await connectEvents(fixture.base);
  t.after(() => late.close());
  const replayed = await late.next((candidate) => candidate.event === 'plan_update', 300);
  assert.equal(replayed, null, 'the stream is live-only and never replays');

  assert.equal(
    targetMessages(fixture, task.targetId).length - beforeMessages,
    2,
    'Plan adds no message beyond the ordinary round',
  );
  assert.equal(
    (await getJson(fixture.base, `/api/tasks/${task.id}`))['unread_count'],
    1,
    'Plan does not move unread; only the round reply does',
  );
  const search = await getJson(
    fixture.base,
    `/api/search?q=${encodeURIComponent('PLAN-ITEM-ONE')}`,
  );
  assert.deepEqual(search['hits'], [], 'Plan items never enter the search index');
  assert.equal(budgetUsed(fixture, task.targetId), beforeBudget, 'Plan spends no response budget');
  assert.equal(
    roundOutcomeCount(fixture, task.targetId) - beforeOutcomes,
    1,
    'Plan starts no extra round or wake',
  );
  assert.equal(
    sqlite3(
      fixture,
      `SELECT title, status, assignee_member_id, updated_at FROM task WHERE id = '${task.id}'`,
    ),
    beforeTask,
    'Plan never changes a task row',
  );
});
