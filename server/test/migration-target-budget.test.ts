import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import { MIGRATION_FIXTURE, makeTempDir, readLedger, removeTempDir, runCli } from './support.ts';

function readSchemaVersion(dataDir: string): unknown {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (
      db.prepare('SELECT schema_version FROM schema_meta').get() as {
        schema_version: unknown;
      }
    ).schema_version;
  } finally {
    db.close();
  }
}

function columnNames(dataDir: string, table: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function countRows(dataDir: string, table: string): number {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
  } finally {
    db.close();
  }
}

const TARGET_BUDGET_COLUMNS = ['target_id', 'epoch_seq', 'used', 'limit_value'];

test('migrating an empty data dir adds the per-target budget table', async () => {
  const dataDir = await makeTempDir('allibot-target-budget-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.deepEqual(columnNames(dataDir, 'target_budget'), TARGET_BUDGET_COLUMNS);
    assert.equal(countRows(dataDir, 'target_budget'), 0, 'the migration seeds no budget rows');

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], SCHEMA_VERSION);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('target_budget keeps one row per target and refuses a used count above the epoch ceiling', async () => {
  const dataDir = await makeTempDir('allibot-target-budget-guards-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.prepare("INSERT INTO target (id, kind) VALUES ('kept-channel', 'channel')").run();
      db.prepare(
        `INSERT INTO target_budget (target_id, epoch_seq, used, limit_value)
         VALUES ('kept-channel', 1, 0, 3)`,
      ).run();
      assert.throws(
        () =>
          db
            .prepare("INSERT INTO target_budget (target_id, epoch_seq, used, limit_value) VALUES ('kept-channel', 2, 0, 3)")
            .run(),
        /UNIQUE|PRIMARY KEY/i,
        'a second row for the same target is refused',
      );
      assert.throws(
        () => db.prepare("UPDATE target_budget SET used = 4 WHERE target_id = 'kept-channel'").run(),
        /CHECK/i,
        'the used count can never exceed the epoch ceiling',
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE target_budget SET limit_value = 4 WHERE target_id = 'kept-channel'")
            .run(),
        /CHECK/i,
        'only the 3 / 5 / 10 channel ceilings exist',
      );
      assert.equal(
        (db.prepare('SELECT count(*) AS total FROM target_budget').get() as { total: number }).total,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 9 data dir upgrades to version 10 with a backup that keeps channel and message rows', async () => {
  const parent = await makeTempDir('allibot-target-budget-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v9', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-9 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 9);

    const seeded = new Database(path.join(dataDir, 'allibot.db'));
    try {
      seeded
        .prepare(
          `INSERT INTO channel
             (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
              created_at, updated_at)
           VALUES ('kept-channel', '保留频道', '', 'autonomous', 5, NULL, NULL, ?, ?)`,
        )
        .run('2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      seeded.prepare("INSERT INTO target (id, kind) VALUES ('kept-channel', 'channel')").run();
      seeded
        .prepare(
          `INSERT INTO message
             (id, target_id, seq, kind, author_member_id, author_display_name,
              author_avatar_slot, body, created_at, task_ref, task_pointer, client_message_id)
           SELECT 'kept-message', 'kept-channel', 1, 'human', id, display_name, avatar_slot,
                  '保留消息', '2026-01-01T00:00:00.000Z', NULL, NULL, NULL
           FROM member WHERE kind = 'owner'`,
        )
        .run();
    } finally {
      seeded.close();
    }

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.deepEqual(columnNames(dataDir, 'target_budget'), TARGET_BUDGET_COLUMNS);
    assert.equal(countRows(dataDir, "message WHERE id = 'kept-message'"), 1);
    assert.equal(countRows(dataDir, 'target_budget'), 0, 'the upgrade seeds no budget row');

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
      assert.equal(version, 9, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('target_budget'), false, 'the backup predates target_budget');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 9);
    assert.equal(last?.['to'], SCHEMA_VERSION);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});
