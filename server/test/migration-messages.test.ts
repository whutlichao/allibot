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

/** The unique index on (target_id, seq) is the seq allocation backstop. */
function uniqueIndexColumns(dataDir: string, table: string): string[][] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const indexes = db.pragma(`index_list(${table})`) as { name: string; unique: number }[];
    return indexes
      .filter((index) => index.unique === 1)
      .map((index) =>
        (db.pragma(`index_info(${index.name})`) as { name: string }[]).map((row) => row.name),
      );
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

test('migrating an empty data dir adds message and message_mention and reaches the current schema version', async () => {
  const dataDir = await makeTempDir('allibot-messages-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 12);
    const tables = tableNames(dataDir);
    for (const table of ['message', 'message_mention']) {
      assert.ok(tables.includes(table), `${table} table is missing; tables: ${tables.join(', ')}`);
    }

    assert.deepEqual(columnNames(dataDir, 'message'), [
      'id',
      'target_id',
      'seq',
      'kind',
      'author_member_id',
      'author_display_name',
      'author_avatar_slot',
      'body',
      'created_at',
      'task_ref',
      'task_pointer',
      'client_message_id',
    ]);
    assert.deepEqual(columnNames(dataDir, 'message_mention'), [
      'message_id',
      'member_id',
      'start',
      'end',
    ]);

    assert.ok(
      uniqueIndexColumns(dataDir, 'message').some(
        (columns) => columns.length === 2 && columns[0] === 'target_id' && columns[1] === 'seq',
      ),
      'message has a unique index on (target_id, seq)',
    );

    assert.equal(countRows(dataDir, 'message'), 0, 'the migration seeds no messages');
    assert.equal(countRows(dataDir, 'message_mention'), 0);

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 12);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 3 data dir upgrades through the chain with a backup that keeps channel rows', async () => {
  const parent = await makeTempDir('allibot-messages-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v3', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-3 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 3);

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

    assert.equal(readSchemaVersion(dataDir), 12);
    assert.ok(tableNames(dataDir).includes('message'));
    assert.equal(
      countRows(dataDir, "channel WHERE id = 'kept-channel'"),
      1,
      'existing channel rows survive the message migration',
    );
    assert.equal(countRows(dataDir, "target WHERE id = 'kept-channel'"), 1);

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
      assert.equal(version, 3, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('message'), false, 'the backup predates the message table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 3);
    assert.equal(last?.['to'], 12);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});
