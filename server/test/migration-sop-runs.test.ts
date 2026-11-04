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
 * Schema 步骤 17 (#41 / T16): `sop_definition` (an immutable, channel-scoped
 * ordered step list) and `sop_run` (the five-phase run snapshot). Everything is
 * observed from the data directory the CLI wrote — the strict +1 step, the
 * columns, the JSON-array and five-value CHECKs, the `finished_at` binding, the
 * channel-consistency trigger, the immutable run fields, the sibling backup and
 * the audit ledger — never from a private function.
 *
 * The v16 fixture is the previous ticket's shape, so this is the real
 * v16 -> v17 migration the product runs.
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const CHANNEL_ID = 'channel-sop';
const OTHER_CHANNEL_ID = 'channel-other';
const DEFINITION_ID = 'sop-def-1';
const STEPS = JSON.stringify([
  {
    title: '收集资料',
    description: '先读规格',
    executor_member_id: 'member-exec',
    verifier_member_id: 'member-verify',
    max_attempts: 2,
  },
]);

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

function triggerNames(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
        .all(table) as { name: string }[]
    ).map((row) => row.name);
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

/** Build the v16 baseline and add the channels the new rows will reference. */
function seedV16(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v16', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v16 fixture should build the v16 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    const insertChannel = db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
          created_at, updated_at)
       VALUES (?, ?, '', 'autonomous', 3, NULL, NULL, ?, ?)`,
    );
    insertChannel.run(CHANNEL_ID, 'SOP 频道', SEEDED_AT, SEEDED_AT);
    insertChannel.run(OTHER_CHANNEL_ID, '另一个频道', SEEDED_AT, SEEDED_AT);
  } finally {
    db.close();
  }
}

function insertDefinition(
  db: Database.Database,
  id: string = DEFINITION_ID,
  steps: string = STEPS,
  channelId: string = CHANNEL_ID,
  name = '周报流程',
): void {
  db.prepare(
    `INSERT INTO sop_definition (id, channel_id, name, steps, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(id, channelId, name, steps, SEEDED_AT);
}

interface RunInsert {
  id: string;
  definitionId?: string;
  channelId?: string;
  phase?: string;
  state?: string;
  currentStep?: number;
  startedAt?: string;
  updatedAt?: string;
  finishedAt?: string | null;
}

function insertRun(db: Database.Database, input: RunInsert): void {
  db.prepare(
    `INSERT INTO sop_run
       (id, definition_id, channel_id, phase, state, current_step, started_at, updated_at,
        finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.definitionId ?? DEFINITION_ID,
    input.channelId ?? CHANNEL_ID,
    input.phase ?? 'pending',
    input.state ?? '{"current_step":0,"attempt":0,"steps":[],"waiting_on":null,"error":null}',
    input.currentStep ?? 0,
    input.startedAt ?? SEEDED_AT,
    input.updatedAt ?? SEEDED_AT,
    input.finishedAt ?? null,
  );
}

test('a v16 data directory migrates to v17 with a whole-directory backup and one ledger line', async () => {
  const parent = await makeTempDir('allibot-sop-migrate-');
  const dataDir = path.join(parent, 'data');
  const snapshot = path.join(parent, 'snapshot');
  try {
    seedV16(dataDir);
    assert.equal(readSchemaVersion(dataDir), 16, 'the fixture builds the v16 baseline');
    cpSync(dataDir, snapshot, { recursive: true });

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);
    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION, 'the chain lands at the current version');

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
    assert.equal(last['from'], 16);
    assert.equal(last['to'], SCHEMA_VERSION);
    assert.equal(last['result'], 'ok');
    assert.equal(last['backup_path'], backupPath);
    assert.ok(Number.isFinite(Date.parse(String(last['started_at']))));
    assert.ok(Number.isFinite(Date.parse(String(last['finished_at']))));

    assert.deepEqual(foreignKeyViolations(dataDir), [], 'the migration leaves no dangling reference');

    const db = openReadOnly(dataDir);
    try {
      assert.equal(count(db, 'SELECT count(*) AS total FROM channel'), 2, 'v16 rows survive');
      assert.equal(count(db, 'SELECT count(*) AS total FROM target'), 0);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});

test('v17 creates sop_definition and sop_run with the JSON-array, five-phase and trigger rules', async () => {
  const parent = await makeTempDir('allibot-sop-shape-');
  const dataDir = path.join(parent, 'data');
  try {
    seedV16(dataDir);
    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    assert.deepEqual(columns(dataDir, 'sop_definition'), [
      'id',
      'channel_id',
      'name',
      'steps',
      'created_at',
    ]);
    assert.deepEqual(columns(dataDir, 'sop_run'), [
      'id',
      'definition_id',
      'channel_id',
      'phase',
      'state',
      'current_step',
      'started_at',
      'updated_at',
      'finished_at',
    ]);

    const definitionSql = tableSql(dataDir, 'sop_definition');
    assert.ok(definitionSql !== undefined, 'sop_definition exists');
    assert.match(definitionSql, /channel_id TEXT NOT NULL REFERENCES channel \(id\)/);
    assert.match(definitionSql, /steps TEXT NOT NULL CHECK/);
    assert.match(definitionSql, /json_valid\(steps\)/);
    assert.match(definitionSql, /json_type\(steps\) = 'array'/);
    assert.match(definitionSql, /UNIQUE \(channel_id, name\)/);

    const runSql = tableSql(dataDir, 'sop_run');
    assert.ok(runSql !== undefined, 'sop_run exists');
    assert.match(runSql, /definition_id TEXT NOT NULL REFERENCES sop_definition \(id\)/);
    assert.match(runSql, /channel_id TEXT NOT NULL REFERENCES channel \(id\)/);
    assert.match(
      runSql,
      /phase TEXT NOT NULL CHECK \(phase IN \('pending', 'running', 'awaiting', 'completed', 'failed'\)\)/,
    );
    assert.match(runSql, /current_step INTEGER NOT NULL CHECK \(current_step >= 0\)/);
    assert.match(runSql, /finished_at TEXT/);

    const triggers = triggerNames(dataDir, 'sop_run');
    assert.ok(
      triggers.includes('sop_run_channel_consistency_insert'),
      'a run insert must match its definition channel',
    );
    assert.ok(
      triggers.includes('sop_run_channel_consistency_update'),
      'a run update must keep the definition channel',
    );
    assert.ok(
      triggers.includes('sop_run_immutable_fields'),
      'definition_id and started_at are frozen',
    );

    const db = openWritable(dataDir);
    try {
      insertDefinition(db);
      insertRun(db, { id: 'run-pending', phase: 'pending' });
      insertRun(db, { id: 'run-running', phase: 'running' });
      insertRun(db, { id: 'run-awaiting', phase: 'awaiting' });
      insertRun(db, {
        id: 'run-completed',
        phase: 'completed',
        finishedAt: '2026-10-01T09:00:00.000Z',
      });
      insertRun(db, {
        id: 'run-failed',
        phase: 'failed',
        finishedAt: '2026-10-01T09:00:00.000Z',
      });
      assert.equal(count(db, 'SELECT count(*) AS total FROM sop_run'), 5);

      for (const badSteps of ['{', '{"title":"步骤"}', '"just a string"', 'null', '42']) {
        assert.throws(
          () => insertDefinition(db, `def-bad-${badSteps.length}-${badSteps.charCodeAt(0)}`, badSteps, CHANNEL_ID, `坏步骤-${badSteps}`),
          /CHECK constraint failed/,
          `sop_definition.steps rejects ${badSteps}`,
        );
      }
      assert.throws(
        () => insertDefinition(db, 'def-duplicate', STEPS, CHANNEL_ID, '周报流程'),
        /UNIQUE constraint failed/,
        'a channel and name pair is unique',
      );
      assert.throws(
        () => insertDefinition(db, 'def-missing-channel', STEPS, 'channel-missing', '不存在频道'),
        /FOREIGN KEY constraint failed/,
        'a definition names an existing channel',
      );

      assert.throws(
        () => insertRun(db, { id: 'run-bad-phase', phase: 'paused' }),
        /CHECK constraint failed/,
        'sop_run.phase only accepts the five words',
      );
      assert.throws(
        () =>
          insertRun(db, {
            id: 'run-pending-finished',
            phase: 'pending',
            finishedAt: '2026-10-01T09:00:00.000Z',
          }),
        /CHECK constraint failed/,
        'pending keeps finished_at NULL',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-completed-open', phase: 'completed' }),
        /CHECK constraint failed/,
        'completed requires finished_at',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-negative-step', currentStep: -1 }),
        /CHECK constraint failed/,
        'current_step is non-negative',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-bad-state', state: '{' }),
        /CHECK constraint failed/,
        'the state snapshot is JSON',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-wrong-channel', channelId: OTHER_CHANNEL_ID }),
        /sop_run channel does not match/,
        'a run channel must equal its definition channel',
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE sop_run SET channel_id = ? WHERE id = 'run-pending'")
            .run(OTHER_CHANNEL_ID),
        /sop_run channel does not match/,
        'a run cannot move to another channel',
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE sop_run SET definition_id = 'other-definition' WHERE id = 'run-pending'")
            .run(),
        /sop_run changes an immutable field/,
        'definition_id is immutable',
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE sop_run SET started_at = '2026-10-02T00:00:00.000Z' WHERE id = 'run-pending'")
            .run(),
        /sop_run changes an immutable field/,
        'started_at is immutable',
      );

      // The progress fields are the one mutable surface of a run.
      db.prepare(
        `UPDATE sop_run
            SET phase = 'running', state = ?, current_step = 1, updated_at = ?
          WHERE id = 'run-pending'`,
      ).run('{"current_step":1,"attempt":1,"steps":[],"waiting_on":null,"error":null}', SEEDED_AT);
      const updated = db
        .prepare("SELECT phase, state, current_step FROM sop_run WHERE id = 'run-pending'")
        .get() as { phase: string; state: string; current_step: number };
      assert.equal(updated.phase, 'running');
      assert.equal(updated.current_step, 1);
      assert.match(updated.state, /"attempt":1/);

      assert.throws(
        () => db.prepare('DELETE FROM sop_definition WHERE id = ?').run(DEFINITION_ID),
        /FOREIGN KEY constraint failed/,
        'a definition with runs cannot be deleted (the run names an existing definition)',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});
