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
 * `GET /api/targets/{id}/plans?member_id=&limit=` (#40 / D2.3 / D4.1): the
 * latest Plan runs of a target with their full task lists. The read model is
 * owner-only and read-only; a Plan has no human-face write endpoint.
 *
 * The fixture seeds the plan rows directly because the read model is the slice
 * under test; the Plan tools are exercised through a round in
 * plans-tools-http.test.ts.
 */

const FIXED_NOW = '2026-11-04T12:00:00.000Z';

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  channelId: string;
  agentA: string;
  agentB: string;
  taskTargetId: string;
  taskId: string;
  stop: () => Promise<void>;
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
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) };
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

async function getJson(
  base: string,
  route: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`);
  const text = await response.text();
  return { status: response.status, body: text.length === 0 ? {} : JSON.parse(text) };
}

async function startFixture(prefix: string): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-plan-read-test' },
    args: ['--scripted-provider', 'reply'],
  });
  const base = `http://127.0.0.1:${running.port}`;
  const channel = await postJson(base, '/api/channels', {
    name: '计划频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  const channelId = channel.body['id'] as string;
  const agentA = (await postJson(base, '/api/agents', {
    display_name: '计划成员甲',
    model: 'openai:gpt-5',
  })).body['id'] as string;
  const agentB = (await postJson(base, '/api/agents', {
    display_name: '计划成员乙',
    model: 'openai:gpt-5',
  })).body['id'] as string;
  for (const memberId of [agentA, agentB]) {
    await postJson(base, `/api/channels/${channelId}/members`, { member_id: memberId });
  }
  const created = await postJson(base, '/api/tasks', {
    channel_id: channelId,
    title: '计划所在任务',
  });
  const taskId = created.body['id'] as string;
  const taskTargetId = created.body['target_id'] as string;
  await patchJson(base, `/api/tasks/${taskId}`, { assignee_member_id: agentA });

  const stop = async (): Promise<void> => {
    await running.stop();
    await removeTempDir(dataDir);
  };
  return { dataDir, running, base, channelId, agentA, agentB, taskTargetId, taskId, stop };
}

interface SeedTask {
  id: string;
  title: string;
  status: string;
  position: number;
}

function seedPlanRun(
  fixture: Fixture,
  input: {
    id: string;
    targetId: string;
    memberId: string;
    createdAt: string;
    tasks: readonly SeedTask[];
  },
): void {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  try {
    db.prepare(
      `INSERT INTO plan_run (id, target_id, member_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(input.id, input.targetId, input.memberId, input.createdAt, input.createdAt);
    const insertTask = db.prepare(
      `INSERT INTO plan_task
         (id, plan_run_id, title, status, position, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const task of input.tasks) {
      insertTask.run(
        task.id,
        input.id,
        task.title,
        task.status,
        task.position,
        input.createdAt,
        input.createdAt,
      );
    }
  } finally {
    db.close();
  }
}

test('the plan read returns the latest runs with their full tasks, filters by member and rejects unknown targets', async (t) => {
  const fixture = await startFixture('allibot-plan-read-');
  t.after(async () => fixture.stop());

  seedPlanRun(fixture, {
    id: 'plan-old',
    targetId: fixture.taskTargetId,
    memberId: fixture.agentA,
    createdAt: '2026-11-03T10:00:00.000Z',
    tasks: [
      { id: 'old-1', title: '旧的第一项', status: 'pending', position: 0 },
      { id: 'old-2', title: '旧的第二项', status: 'completed', position: 1 },
    ],
  });
  seedPlanRun(fixture, {
    id: 'plan-new',
    targetId: fixture.taskTargetId,
    memberId: fixture.agentA,
    createdAt: '2026-11-04T10:00:00.000Z',
    tasks: [
      { id: 'new-1', title: '新的第一项', status: 'in_progress', position: 0 },
      { id: 'new-2', title: '新的第二项', status: 'pending', position: 1 },
      { id: 'new-3', title: '新的第三项', status: 'completed', position: 2 },
    ],
  });
  seedPlanRun(fixture, {
    id: 'plan-b-member',
    targetId: fixture.taskTargetId,
    memberId: fixture.agentB,
    createdAt: '2026-11-04T11:00:00.000Z',
    tasks: [{ id: 'b-1', title: '乙的计划', status: 'pending', position: 0 }],
  });

  const all = await getJson(fixture.base, `/api/targets/${fixture.taskTargetId}/plans`);
  assert.equal(all.status, 200);
  const plans = all.body['plans'] as Record<string, unknown>[];
  assert.deepEqual(
    plans.map((plan) => plan['id']),
    ['plan-b-member', 'plan-new', 'plan-old'],
    'runs are newest first',
  );
  const newest = plans.find((plan) => plan['id'] === 'plan-new');
  assert.ok(newest !== undefined);
  assert.equal(newest['target_id'], fixture.taskTargetId);
  assert.equal(newest['member_id'], fixture.agentA);
  assert.equal(newest['created_at'], '2026-11-04T10:00:00.000Z');
  assert.equal(newest['updated_at'], '2026-11-04T10:00:00.000Z');
  const tasks = newest['tasks'] as Record<string, unknown>[];
  assert.deepEqual(
    tasks.map((task) => [task['title'], task['status'], task['position']]),
    [
      ['新的第一项', 'in_progress', 0],
      ['新的第二项', 'pending', 1],
      ['新的第三项', 'completed', 2],
    ],
    'the run carries its complete task list in plan order',
  );
  assert.deepEqual(Object.keys(tasks[0] ?? {}).sort(), [
    'created_at',
    'id',
    'plan_run_id',
    'position',
    'status',
    'title',
    'updated_at',
  ]);

  const filtered = await getJson(
    fixture.base,
    `/api/targets/${fixture.taskTargetId}/plans?member_id=${fixture.agentA}`,
  );
  assert.deepEqual(
    (filtered.body['plans'] as Record<string, unknown>[]).map((plan) => plan['id']),
    ['plan-new', 'plan-old'],
    'member_id narrows the reading',
  );

  const limited = await getJson(
    fixture.base,
    `/api/targets/${fixture.taskTargetId}/plans?limit=1`,
  );
  assert.equal((limited.body['plans'] as unknown[]).length, 1);

  // Agent B is a channel member but not a member of the task target.
  const notMember = await getJson(
    fixture.base,
    `/api/targets/${fixture.taskTargetId}/plans?member_id=${fixture.agentB}`,
  );
  assert.equal(notMember.status, 200);
  assert.deepEqual(notMember.body['plans'], [], 'a member outside the target reads an empty list');

  const channelPlans = await getJson(fixture.base, `/api/targets/${fixture.channelId}/plans`);
  assert.deepEqual(channelPlans.body['plans'], [], 'a target with no Plan reads an empty list');

  const unknown = await getJson(fixture.base, '/api/targets/no-such-target/plans');
  assert.equal(unknown.status, 404, `unknown target -> ${unknown.status}: ${JSON.stringify(unknown.body)}`);
  assert.equal((unknown.body['error'] as { code: string }).code, 'not_found');

  for (const limit of ['0', '51', 'abc']) {
    const invalid = await getJson(
      fixture.base,
      `/api/targets/${fixture.taskTargetId}/plans?limit=${limit}`,
    );
    assert.equal(invalid.status, 400, `limit=${limit} -> ${invalid.status}`);
  }

  const write = await postJson(fixture.base, `/api/targets/${fixture.taskTargetId}/plans`, {
    title: 'no write endpoint',
  });
  assert.equal(write.status, 404, 'Plan has no human-face write endpoint');

  const fixedRow = await getJson(fixture.base, `/api/tasks`);
  assert.ok(
    (fixedRow.body['tasks'] as { id: string }[]).some((task) => task.id === fixture.taskId),
    'the task board read is unaffected',
  );
});

test('the plan read stays read-only: it writes no message, unread, budget or task row', async (t) => {
  const fixture = await startFixture('allibot-plan-readonly-');
  t.after(async () => fixture.stop());

  seedPlanRun(fixture, {
    id: 'plan-1',
    targetId: fixture.taskTargetId,
    memberId: fixture.agentA,
    createdAt: FIXED_NOW,
    tasks: [{ id: 'one', title: '只读计划', status: 'pending', position: 0 }],
  });

  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  const counts = (): Record<string, number> => {
    const tables = ['message', 'target_budget', 'plan_run', 'plan_task', 'task'];
    return Object.fromEntries(
      tables.map((table) => [
        table,
        (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total,
      ]),
    );
  };
  try {
    const before = counts();
    await getJson(fixture.base, `/api/targets/${fixture.taskTargetId}/plans`);
    await getJson(fixture.base, `/api/targets/${fixture.taskTargetId}/plans?member_id=${fixture.agentA}`);
    const after = counts();
    assert.deepEqual(after, before, 'the plan read model writes nothing');
  } finally {
    db.close();
  }
});
