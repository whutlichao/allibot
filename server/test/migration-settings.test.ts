import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
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

function columnNames(dataDir: string, table: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function readSettings(dataDir: string): Record<string, string> {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const rows = db.prepare('SELECT key, value FROM setting ORDER BY key').all() as {
      key: string;
      value: string;
    }[];
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
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

test('migrating an empty data dir adds the setting table seeded with the three workspace settings', async () => {
  const dataDir = await makeTempDir('allibot-settings-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 5);
    const tables = tableNames(dataDir);
    assert.ok(tables.includes('setting'), `setting table is missing; tables: ${tables.join(', ')}`);
    assert.deepEqual(columnNames(dataDir, 'setting'), ['key', 'value']);

    assert.deepEqual(readSettings(dataDir), {
      density: 'comfortable',
      locale: 'zh-CN',
      theme: 'system',
    });
    assert.equal(countRows(dataDir, 'setting'), 3, 'the workspace settings are exactly three rows');

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 5);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 4 data dir upgrades to version 5 with a backup that keeps messages and channels', async () => {
  const parent = await makeTempDir('allibot-settings-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v4', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-4 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 4);

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
           VALUES ('kept-message', 'kept-channel', 1, 'human',
                   (SELECT id FROM member WHERE kind = 'owner'), '我', 0, '历史消息', ?, NULL, NULL, NULL)`,
        )
        .run('2026-01-01T00:00:01.000Z');
    } finally {
      seeded.close();
    }

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 5);
    assert.ok(tableNames(dataDir).includes('setting'));
    assert.equal(
      countRows(dataDir, "message WHERE id = 'kept-message'"),
      1,
      'existing messages survive the setting migration',
    );
    assert.deepEqual(readSettings(dataDir), {
      density: 'comfortable',
      locale: 'zh-CN',
      theme: 'system',
    });

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
      assert.equal(version, 4, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('setting'), false, 'the backup predates the setting table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 4);
    assert.equal(last?.['to'], 5);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});

test('the setting table refuses an unknown key and an empty value', async () => {
  const dataDir = await makeTempDir('allibot-settings-constraints-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      assert.throws(
        () => db.prepare("INSERT INTO setting (key, value) VALUES ('workspace_root', '/tmp')").run(),
        /CHECK constraint failed/,
        'the setting table is not a general key-value store',
      );
      assert.throws(
        () => db.prepare("INSERT INTO setting (key, value) VALUES ('theme', '')").run(),
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});
