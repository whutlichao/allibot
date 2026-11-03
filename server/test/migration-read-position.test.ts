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

function tableNames(dataDir: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
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

const READ_POSITION_COLUMNS = ['member_id', 'target_id', 'last_read_seq'];

test('migrating an empty data dir adds read_position and is idempotent', async () => {
  const dataDir = await makeTempDir('allibot-read-position-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.deepEqual(columnNames(dataDir, 'read_position'), READ_POSITION_COLUMNS);
    assert.equal(countRows(dataDir, 'read_position'), 0, 'the migration seeds no read positions');

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

test('read_position is one row per member and target with a non-negative position', async () => {
  const dataDir = await makeTempDir('allibot-read-position-guards-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.pragma('foreign_keys = ON');
      db.prepare("INSERT INTO target (id, kind) VALUES ('kept-target', 'channel')").run();
      const owner = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string };
      db.prepare(
        'INSERT INTO read_position (member_id, target_id, last_read_seq) VALUES (?, ?, ?)',
      ).run(owner.id, 'kept-target', 3);

      assert.throws(
        () =>
          db
            .prepare(
              'INSERT INTO read_position (member_id, target_id, last_read_seq) VALUES (?, ?, ?)',
            )
            .run(owner.id, 'kept-target', 4),
        /UNIQUE|PRIMARY KEY/i,
        'a second position for the same member and target is refused',
      );
      assert.throws(
        () =>
          db
            .prepare(
              'UPDATE read_position SET last_read_seq = -1 WHERE member_id = ? AND target_id = ?',
            )
            .run(owner.id, 'kept-target'),
        /CHECK/i,
        'a negative position is refused',
      );
      assert.equal(countRows(dataDir, 'read_position'), 1);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 11 data dir upgrades to the current version with a backup that keeps its rows', async () => {
  const parent = await makeTempDir('allibot-read-position-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v11', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-11 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 11);

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
    assert.deepEqual(columnNames(dataDir, 'read_position'), READ_POSITION_COLUMNS);
    assert.equal(countRows(dataDir, "message WHERE id = 'kept-message'"), 1);
    assert.equal(countRows(dataDir, 'read_position'), 0, 'the upgrade seeds no read positions');

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
      assert.equal(version, 11, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('read_position'), false, 'the backup predates read_position');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 11);
    assert.equal(last?.['to'], SCHEMA_VERSION);
    assert.equal(last?.['result'], 'ok');
    assert.ok(tableNames(dataDir).includes('read_position'));
  } finally {
    await removeTempDir(parent);
  }
});
