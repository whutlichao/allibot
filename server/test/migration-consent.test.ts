import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import { MIGRATION_FIXTURE, makeTempDir, readLedger, removeTempDir, runCli } from './support.ts';

/**
 * 远端数据流告知的落点（D1.10 / R4）：新仓只建 remote_consent_scope，
 * 按 ('model', provider) 记录「何时确认过」，不存连接参数、不存密钥。
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

/** The schema must never carry a model credential column or table. */
function assertNoCredentialSchema(dataDir: string): void {
  const secretColumn = /(api_?key|apikey|secret|password|credential|bearer)/i;
  const secretTable = /(api_?key|apikey|secret|password|credential|bearer)/i;
  for (const table of tableNames(dataDir)) {
    assert.doesNotMatch(table, secretTable, `unexpected credential table: ${table}`);
    for (const column of columnNames(dataDir, table)) {
      assert.doesNotMatch(column, secretColumn, `unexpected credential column: ${table}.${column}`);
    }
  }
}

test('migrating an empty data dir adds remote_consent_scope and reaches the current schema version', async () => {
  const dataDir = await makeTempDir('allibot-consent-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.deepEqual(columnNames(dataDir, 'remote_consent_scope'), [
      'scope_kind',
      'scope_id',
      'confirmed_at',
    ]);
    assert.equal(countRows(dataDir, 'remote_consent_scope'), 0, 'the migration seeds no consent');

    const listed = spawnSync('sqlite3', [path.join(dataDir, 'allibot.db'), '.tables'], {
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, `sqlite3 should exit 0; stderr: ${listed.stderr}`);
    assert.match(listed.stdout, /\bremote_consent_scope\b/);

    assertNoCredentialSchema(dataDir);

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], SCHEMA_VERSION);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 9 data dir upgrades to version 10 with a backup that keeps channel and message rows', async () => {
  const parent = await makeTempDir('allibot-consent-upgrade-');
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
    assert.deepEqual(columnNames(dataDir, 'remote_consent_scope'), [
      'scope_kind',
      'scope_id',
      'confirmed_at',
    ]);
    assert.equal(countRows(dataDir, "message WHERE id = 'kept-message'"), 1);

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
      assert.equal(tables.includes('remote_consent_scope'), false, 'the backup predates the consent table');
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

test('remote_consent_scope records only the scope and when it was confirmed, once per scope', async () => {
  const dataDir = await makeTempDir('allibot-consent-constraints-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.prepare(
        "INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at) VALUES ('model', 'anthropic', ?)",
      ).run('2026-01-01T00:00:00.000Z');
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at) VALUES ('model', 'anthropic', ?)",
            )
            .run('2026-01-02T00:00:00.000Z'),
        /UNIQUE constraint failed/,
        'one provider is confirmed once; the row is the key',
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at) VALUES ('model', '', ?)",
            )
            .run('2026-01-01T00:00:00.000Z'),
        /CHECK constraint failed/,
        'a consent scope always names what was confirmed',
      );
      assert.throws(
        () =>
          db
            .prepare(
              "INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at) VALUES ('mcp', 'x', ?)",
            )
            .run('2026-01-01T00:00:00.000Z'),
        /CHECK constraint failed/,
        'M1 confirms model providers only',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});
