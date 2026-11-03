import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import { MIGRATION_FIXTURE, makeTempDir, readLedger, removeTempDir, runCli } from './support.ts';

/**
 * 提醒 (Reminder) 的落点：reminder 表跟随提醒 / 到点票追加到 Schema 链尾。
 * 行的 delivered_at 承担「至多投递一次、至多补投一次」，missed 记录「超过
 * 24 小时窗口才发现」这一事实。
 */

function withDatabase<T>(dataDir: string, read: (db: Database.Database) => T): T {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return read(db);
  } finally {
    db.close();
  }
}

function readSchemaVersion(dataDir: string): unknown {
  return withDatabase(
    dataDir,
    (db) =>
      (db.prepare('SELECT schema_version FROM schema_meta').get() as { schema_version: unknown })
        .schema_version,
  );
}

function tableNames(dataDir: string): string[] {
  return withDatabase(dataDir, (db) =>
    (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name),
  );
}

function columnNames(dataDir: string, table: string): string[] {
  return withDatabase(dataDir, (db) =>
    (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name),
  );
}

function countRows(dataDir: string, table: string): number {
  return withDatabase(
    dataDir,
    (db) => (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total,
  );
}

const REMINDER_COLUMNS = [
  'id',
  'channel_id',
  'due_at_local',
  'text',
  'delivered_at',
  'missed',
  'created_at',
];

test('migrating an empty data dir adds reminder and is idempotent', async () => {
  const dataDir = await makeTempDir('allibot-reminder-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.deepEqual(columnNames(dataDir, 'reminder'), REMINDER_COLUMNS);
    assert.equal(countRows(dataDir, 'reminder'), 0, 'the migration seeds no reminders');

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], SCHEMA_VERSION);
    assert.equal(entries[0]?.['result'], 'ok');

    const again = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(again.exitCode, 0, `a second migrate should exit 0; output: ${again.output}`);
    assert.match(again.stdout, new RegExp(`已是 Schema 版本 ${SCHEMA_VERSION}`));
    assert.equal(readLedger(dataDir).length, 1, 'an already-current migration appends no ledger line');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('reminder rows keep the fixed local-time format and a delivered/missed pairing', async () => {
  const dataDir = await makeTempDir('allibot-reminder-guards-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.pragma('foreign_keys = ON');
      db.prepare(
        `INSERT INTO channel
           (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
            created_at, updated_at)
         VALUES ('kept-channel', '保留频道', '', 'autonomous', 3, NULL, NULL, ?, ?)`,
      ).run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      db.prepare("INSERT INTO target (id, kind) VALUES ('kept-channel', 'channel')").run();

      db.prepare(
        `INSERT INTO reminder (id, channel_id, due_at_local, text, delivered_at, missed, created_at)
         VALUES ('kept-reminder', 'kept-channel', '2026-11-03T10:00', '备忘', NULL, 0, ?)`,
      ).run('2026-11-02T00:00:00.000Z');

      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO reminder (id, channel_id, due_at_local, text, delivered_at, missed, created_at)
               VALUES ('bad-format', NULL, '2026-11-03 10:00', '备忘', NULL, 0, ?)`,
            )
            .run('2026-11-02T00:00:00.000Z'),
        /CHECK constraint failed/,
        'the local time keeps the fixed YYYY-MM-DDTHH:mm format',
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO reminder (id, channel_id, due_at_local, text, delivered_at, missed, created_at)
               VALUES ('missed-before-due', NULL, '2026-11-03T10:00', '备忘', NULL, 1, ?)`,
            )
            .run('2026-11-02T00:00:00.000Z'),
        /CHECK constraint failed/,
        'a missed reminder is always a delivered one',
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO reminder (id, channel_id, due_at_local, text, delivered_at, missed, created_at)
               VALUES ('unknown-channel', 'missing-channel', '2026-11-03T10:00', '备忘', NULL, 0, ?)`,
            )
            .run('2026-11-02T00:00:00.000Z'),
        /FOREIGN KEY constraint failed/,
        'a reminder channel is a real channel row',
      );
      assert.equal(countRows(dataDir, 'reminder'), 1);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 12 data dir upgrades to the current version with a backup that keeps its rows', async () => {
  const parent = await makeTempDir('allibot-reminder-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v12', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-12 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 12);

    const seeded = new Database(path.join(dataDir, 'allibot.db'));
    try {
      seeded
        .prepare(
          `INSERT INTO channel
             (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
              created_at, updated_at)
           VALUES ('kept-channel', '保留频道', '', 'autonomous', 3, NULL, NULL, ?, ?)`,
        )
        .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      seeded.prepare("INSERT INTO target (id, kind) VALUES ('kept-channel', 'channel')").run();
    } finally {
      seeded.close();
    }

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.deepEqual(columnNames(dataDir, 'reminder'), REMINDER_COLUMNS);
    assert.equal(countRows(dataDir, "channel WHERE id = 'kept-channel'"), 1);
    assert.equal(countRows(dataDir, 'reminder'), 0, 'the upgrade seeds no reminders');

    const backups = readdirSync(parent).filter((name) => name.startsWith('data.backup-'));
    assert.equal(backups.length, 1, `expected exactly one backup, saw: ${backups.join(', ')}`);
    const backupDb = new Database(path.join(parent, backups[0] ?? '', 'allibot.db'), {
      readonly: true,
    });
    try {
      const version = (
        backupDb.prepare('SELECT schema_version FROM schema_meta').get() as {
          schema_version: number;
        }
      ).schema_version;
      assert.equal(version, 12, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('reminder'), false, 'the backup predates the reminder table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 12);
    assert.equal(last?.['to'], SCHEMA_VERSION);
    assert.equal(last?.['result'], 'ok');
    assert.ok(tableNames(dataDir).includes('reminder'));
  } finally {
    await removeTempDir(parent);
  }
});
