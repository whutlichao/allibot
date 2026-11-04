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
 * Plan 保留策略 (#40 / D4.1): each (target, member) keeps the newest 20 runs
 * that are also at most 30 days old, whichever drops first. The prune runs in
 * the transaction that creates a new run — never a startup-wide scan — and a
 * deleted plan_task follows its run by cascade.
 *
 * The fixture injects `--fixed-clock`; the old runs are constructed relative to
 * that instant, so the 30-day boundary and the occurrence timestamps are
 * deterministic.
 */

const FIXED_NOW = '2026-11-04T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60 * 1000;

interface RetentionFixture {
  dataDir: string;
  base: string;
  running: RunningServer;
  agentId: string;
  targetId: string;
  stop: () => Promise<void>;
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

async function startRetentionFixture(prefix: string): Promise<RetentionFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const setup = await startServer(dataDir, { args: ['--scripted-provider', 'reply'] });
  const setupBase = `http://127.0.0.1:${setup.port}`;
  let agentId: string;
  let targetId: string;
  try {
    const channelId = (await postJson(setupBase, '/api/channels', {
      name: '保留策略频道',
      description: '',
      mode: 'autonomous',
      response_budget_limit: 3,
    }))['id'] as string;
    agentId = (await postJson(setupBase, '/api/agents', {
      display_name: '保留成员',
      model: 'openai:gpt-5',
    }))['id'] as string;
    await postJson(setupBase, `/api/channels/${channelId}/members`, { member_id: agentId });
    const task = await postJson(setupBase, '/api/tasks', {
      channel_id: channelId,
      title: '保留任务',
    });
    await patchJson(setupBase, `/api/tasks/${task['id'] as string}`, {
      assignee_member_id: agentId,
    });
    targetId = task['target_id'] as string;
  } finally {
    await setup.stop();
  }

  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-plan-retention-test' },
    args: ['--scripted-provider', 'plan', '--fixed-clock', FIXED_NOW],
  });
  const base = `http://127.0.0.1:${running.port}`;
  await postJson(base, '/api/remote-data-flow/openai/consent', {});

  const stop = async (): Promise<void> => {
    await running.stop();
    await removeTempDir(dataDir);
  };
  return { dataDir, base, running, agentId, targetId, stop };
}

/** Construct `count` runs, newest first from `startOffsetMs` before the fixed clock. */
function seedRuns(
  fixture: RetentionFixture,
  seeds: readonly { id: string; createdAt: string; taskTitle: string }[],
): void {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  try {
    const insertRun = db.prepare(
      `INSERT INTO plan_run (id, target_id, member_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    const insertTask = db.prepare(
      `INSERT INTO plan_task
         (id, plan_run_id, title, status, position, created_at, updated_at)
       VALUES (?, ?, ?, 'pending', 0, ?, ?)`,
    );
    for (const seed of seeds) {
      insertRun.run(seed.id, fixture.targetId, fixture.agentId, seed.createdAt, seed.createdAt);
      insertTask.run(
        `task-${seed.id}`,
        seed.id,
        seed.taskTitle,
        seed.createdAt,
        seed.createdAt,
      );
    }
  } finally {
    db.close();
  }
}

interface Counts {
  runs: number;
  tasks: number;
  orphans: number;
}

function counts(fixture: RetentionFixture): Counts {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return {
      runs: (db.prepare('SELECT count(*) AS total FROM plan_run').get() as { total: number }).total,
      tasks: (db.prepare('SELECT count(*) AS total FROM plan_task').get() as { total: number }).total,
      orphans: (
        db
          .prepare(
            `SELECT count(*) AS total FROM plan_task
              WHERE plan_run_id NOT IN (SELECT id FROM plan_run)`,
          )
          .get() as { total: number }
      ).total,
    };
  } finally {
    db.close();
  }
}

function runIds(fixture: RetentionFixture): string[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return (
      db.prepare('SELECT id FROM plan_run ORDER BY created_at DESC, rowid DESC').all() as {
        id: string;
      }[]
    ).map((row) => row.id);
  } finally {
    db.close();
  }
}

async function postTargetMessage(fixture: RetentionFixture, body: string): Promise<void> {
  await postJson(fixture.base, `/api/targets/${fixture.targetId}/messages`, { body });
}

function recentSeeds(count: number): { id: string; createdAt: string; taskTitle: string }[] {
  const now = Date.parse(FIXED_NOW);
  return Array.from({ length: count }, (_, index) => ({
    id: `seed-run-${index + 1}`,
    // index 0 is the newest; one minute apart keeps the ordering independent of rowid.
    createdAt: new Date(now - (index + 1) * 60_000).toISOString(),
    taskTitle: `SEED-TASK-${index + 1}`,
  }));
}

test('creating one more run beyond twenty prunes the oldest run and cascades its tasks', async (t) => {
  const fixture = await startRetentionFixture('allibot-plan-retention-20-');
  t.after(async () => fixture.stop());

  seedRuns(fixture, recentSeeds(20));
  assert.deepEqual(counts(fixture), { runs: 20, tasks: 20, orphans: 0 });

  await postTargetMessage(fixture, '开始新一轮计划');

  const after = counts(fixture);
  assert.equal(after.runs, 20, 'the pair keeps only the newest 20 runs');
  assert.equal(after.orphans, 0, 'plan_task follows the deleted run');
  const ids = runIds(fixture);
  assert.ok(!ids.includes('seed-run-20'), 'the oldest run is deleted');
  assert.ok(ids.includes('seed-run-1'), 'the newest seeded run is kept');
  const newRun = ids.find((id) => !id.startsWith('seed-run-'));
  assert.ok(newRun !== undefined, 'the round created a new run');
  assert.equal(after.tasks, 19 + 2, 'the deleted run tasks cascaded; the new run appended its items');

  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const createdAt = (
      db.prepare('SELECT created_at FROM plan_run WHERE id = ?').get(newRun) as {
        created_at: string;
      }
    ).created_at;
    assert.equal(createdAt, FIXED_NOW, 'the new run uses the injected fixed clock');
  } finally {
    db.close();
  }

  // The cap holds for the next round too: the current run set is saturated, so
  // the next first tool call rotates once more and prunes one run.
  await postTargetMessage(fixture, '再来一轮计划');
  const again = counts(fixture);
  assert.equal(again.runs, 20);
  assert.equal(again.orphans, 0);
});

test('a run older than thirty days is pruned when a new run is created', async (t) => {
  const fixture = await startRetentionFixture('allibot-plan-retention-30d-');
  t.after(async () => fixture.stop());

  const oldAt = new Date(Date.parse(FIXED_NOW) - 31 * DAY_MS).toISOString();
  seedRuns(fixture, [{ id: 'seed-old', createdAt: oldAt, taskTitle: 'SEED-OLD-TASK' }]);
  assert.deepEqual(counts(fixture), { runs: 1, tasks: 1, orphans: 0 });

  await postTargetMessage(fixture, '三十天后的新计划');

  assert.equal(counts(fixture).runs, 1, 'the expired current run is replaced by a new one');
  const ids = runIds(fixture);
  assert.ok(!ids.includes('seed-old'), 'a run older than 30 days is pruned');

  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    assert.equal(
      (
        db
          .prepare("SELECT count(*) AS total FROM plan_task WHERE title = 'SEED-OLD-TASK'")
          .get() as { total: number }
      ).total,
      0,
      'the expired run tasks cascade too',
    );
  } finally {
    db.close();
  }
});

test('the twenty-run and thirty-day limits drop whichever comes first', async (t) => {
  const fixture = await startRetentionFixture('allibot-plan-retention-mixed-');
  t.after(async () => fixture.stop());

  const now = Date.parse(FIXED_NOW);
  const recent = recentSeeds(20);
  const old = Array.from({ length: 5 }, (_, index) => ({
    id: `seed-ancient-${index + 1}`,
    createdAt: new Date(now - (31 + index) * DAY_MS).toISOString(),
    taskTitle: `SEED-ANCIENT-${index + 1}`,
  }));
  seedRuns(fixture, [...recent, ...old]);
  assert.deepEqual(counts(fixture), { runs: 25, tasks: 25, orphans: 0 });

  await postTargetMessage(fixture, '混合保留');

  const after = counts(fixture);
  assert.equal(after.runs, 20, 'the cap keeps 20 runs');
  assert.equal(after.orphans, 0);
  const ids = runIds(fixture);
  for (const seed of old) {
    assert.ok(!ids.includes(seed.id), 'every expired run is dropped even below the count cap');
  }
  // 25 seeded + 1 new = 26; keep newest 20 => new + 19 recent; the 20th recent
  // and the 5 ancient runs are dropped.
  assert.ok(!ids.includes('seed-run-20'), 'the count cap also drops the 20th newest seeded run');
  assert.ok(ids.includes('seed-run-19'));
  assert.equal(after.tasks, 19 + 2);
});
