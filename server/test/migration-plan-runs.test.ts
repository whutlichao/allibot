import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import {
  MIGRATION_FIXTURE,
  makeTempDir,
  readLedger,
  removeTempDir,
  runCli,
} from './support.ts';

/**
 * Schema 步骤 16 (#40 / T15): `plan_run` and `plan_task` are the member's Plan
 * work list. They are observed from the data directory the CLI wrote — the
 * strict +1 step, the rebuilt shapes, the three-word status CHECK, the
 * non-negative position, the cascade delete, the indexes, the sibling backup
 * and the audit ledger — never from a private function.
 *
 * The v15 fixture is the previous ticket's shape, so this is the real
 * v15 -> v16 migration the product runs.
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const TARGET_ID = 'target-plan';
const OTHER_TARGET_ID = 'target-other';

function openReadOnly(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
}

function openWritable(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  return db;
}

function readSchemaVersion(dataDir: string): unknown {
  const db = openReadOnly(dataDir);
  try {
    return (
      db.prepare('SELECT schema_version FROM schema_meta').get() as { schema_version: unknown }
    ).schema_version;
  } finally {
    db.close();
  }
}

function tableSql(dataDir: string, table: string): string | undefined {
  const db = openReadOnly(dataDir);
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    return row?.sql;
  } finally {
    db.close();
  }
}

function columns(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function indexNames(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (db.pragma(`index_list(${table})`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function foreignKeyViolations(dataDir: string): unknown[] {
  const db = openReadOnly(dataDir);
  try {
    return db.pragma('foreign_key_check') as unknown[];
  } finally {
    db.close();
  }
}

function count(db: Database.Database, sql: string): number {
  return (db.prepare(sql).get() as { total: number }).total;
}

/** Build the v15 baseline and add a target / member for the new plan rows. */
function seedV15(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v15', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v15 fixture should build the v15 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(TARGET_ID);
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(OTHER_TARGET_ID);
  } finally {
    db.close();
  }
}

function ownerId(db: Database.Database): string {
  return (db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string }).id;
}

function insertRun(
  db: Database.Database,
  id: string,
  targetId: string = TARGET_ID,
  memberId: string = ownerId(db),
  createdAt: string = SEEDED_AT,
): void {
  db.prepare(
    `INSERT INTO plan_run (id, target_id, member_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, targetId, memberId, createdAt, createdAt);
}

function insertTask(
  db: Database.Database,
  id: string,
  runId: string,
  position: number,
  title: string = '计划项',
  status: string = 'pending',
): void {
  db.prepare(
    `INSERT INTO plan_task
       (id, plan_run_id, title, status, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, runId, title, status, position, SEEDED_AT, SEEDED_AT);
}

test('a v15 data directory migrates to the current schema with a whole-directory backup and one ledger line', async () => {
  const parent = await makeTempDir('allibot-plan-runs-migrate-');
  const dataDir = path.join(parent, 'data');
  const snapshot = path.join(parent, 'snapshot');
  try {
    seedV15(dataDir);
    assert.equal(readSchemaVersion(dataDir), 15, 'the fixture builds the v15 baseline');
    cpSync(dataDir, snapshot, { recursive: true });

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);
    assert.equal(
      readSchemaVersion(dataDir),
      SCHEMA_VERSION,
      'the strict +1 step lands at the current schema version',
    );

    const backups = readdirSync(parent).filter((name) => name.startsWith('data.backup-'));
    assert.equal(
      backups.length,
      1,
      `expected exactly one sibling backup directory, saw: ${backups.join(', ')}`,
    );
    const backupPath = path.join(parent, backups[0] ?? '');
    const diff = spawnSync('diff', ['-r', backupPath, snapshot], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `the backup must equal the pre-migration data dir; diff: ${diff.stdout}`);
    assert.equal(diff.stdout, '');

    const ledger = readLedger(dataDir);
    const last = ledger[ledger.length - 1];
    assert.ok(last !== undefined, 'the audit ledger has a record for the migration');
    assert.equal(last['from'], 15);
    assert.equal(last['to'], SCHEMA_VERSION);
    assert.equal(last['result'], 'ok');
    assert.equal(last['backup_path'], backupPath);
    assert.ok(Number.isFinite(Date.parse(String(last['started_at']))));
    assert.ok(Number.isFinite(Date.parse(String(last['finished_at']))));

    assert.deepEqual(foreignKeyViolations(dataDir), [], 'the migration leaves no dangling reference');

    const db = openReadOnly(dataDir);
    try {
      assert.equal(count(db, 'SELECT count(*) AS total FROM target'), 2, 'v15 rows survive');
      assert.equal(count(db, 'SELECT count(*) AS total FROM member'), 1);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});

test('v16 creates plan_run and plan_task with the three-word status, position and cascade', async () => {
  const parent = await makeTempDir('allibot-plan-runs-shape-');
  const dataDir = path.join(parent, 'data');
  try {
    seedV15(dataDir);
    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    assert.deepEqual(columns(dataDir, 'plan_run'), [
      'id',
      'target_id',
      'member_id',
      'created_at',
      'updated_at',
    ]);
    assert.deepEqual(columns(dataDir, 'plan_task'), [
      'id',
      'plan_run_id',
      'title',
      'status',
      'position',
      'created_at',
      'updated_at',
    ]);

    const runSql = tableSql(dataDir, 'plan_run');
    assert.ok(runSql !== undefined, 'plan_run exists');
    assert.match(runSql, /target_id TEXT NOT NULL REFERENCES target \(id\)/);
    assert.match(runSql, /member_id TEXT NOT NULL REFERENCES member \(id\)/);

    const taskSql = tableSql(dataDir, 'plan_task');
    assert.ok(taskSql !== undefined, 'plan_task exists');
    assert.match(taskSql, /status TEXT NOT NULL CHECK \(status IN \('pending', 'in_progress', 'completed'\)\)/);
    assert.match(taskSql, /position INTEGER NOT NULL CHECK \(position >= 0\)/);
    assert.match(taskSql, /title TEXT NOT NULL CHECK \(length\(trim\(title\)\) > 0\)/);
    assert.match(taskSql, /plan_run_id TEXT NOT NULL REFERENCES plan_run \(id\) ON DELETE CASCADE/);

    assert.ok(
      indexNames(dataDir, 'plan_run').includes('plan_run_target_member_created'),
      'plan_run is indexed by (target_id, member_id, created_at)',
    );
    assert.ok(
      indexNames(dataDir, 'plan_task').includes('plan_task_run_position'),
      'plan_task is indexed by (plan_run_id, position)',
    );

    const db = openWritable(dataDir);
    try {
      insertRun(db, 'run-1');
      insertTask(db, 'task-1', 'run-1', 0, '第一项', 'pending');
      insertTask(db, 'task-2', 'run-1', 1, '第二项', 'in_progress');
      insertTask(db, 'task-3', 'run-1', 2, '第三项', 'completed');
      assert.equal(count(db, "SELECT count(*) AS total FROM plan_task WHERE plan_run_id = 'run-1'"), 3);

      assert.throws(
        () => insertTask(db, 'task-bad-status', 'run-1', 3, '状态', 'todo'),
        /CHECK constraint failed/,
        'plan_task only accepts the three plan words, not the task five-state',
      );
      assert.throws(
        () => insertTask(db, 'task-negative', 'run-1', -1),
        /CHECK constraint failed/,
        'position is non-negative',
      );
      assert.throws(
        () => insertTask(db, 'task-empty-title', 'run-1', 3, '   '),
        /CHECK constraint failed/,
        'title is non-empty',
      );
      assert.throws(
        () => insertRun(db, 'run-missing-target', 'target-missing'),
        /FOREIGN KEY constraint failed/,
        'a plan_run names an existing target',
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO plan_run (id, target_id, member_id, created_at, updated_at)
               VALUES ('run-missing-member', ?, 'member-missing', ?, ?)`,
            )
            .run(TARGET_ID, SEEDED_AT, SEEDED_AT),
        /FOREIGN KEY constraint failed/,
        'a plan_run names an existing member',
      );

      db.prepare("DELETE FROM plan_run WHERE id = 'run-1'").run();
      assert.equal(
        count(db, "SELECT count(*) AS total FROM plan_task WHERE plan_run_id = 'run-1'"),
        0,
        'deleting a plan_run cascades its plan_task rows',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});
