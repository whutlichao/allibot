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

function attachmentColumns(dataDir: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.pragma('table_info(attachment)') as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function triggerNames(dataDir: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
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

test('migrating an empty data dir adds attachment and reaches the current schema version', async () => {
  const dataDir = await makeTempDir('allibot-attachments-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 11);
    assert.deepEqual(attachmentColumns(dataDir), [
      'id',
      'message_id',
      'filename',
      'mime',
      'size',
      'storage_path',
      'created_at',
    ]);
    assert.equal(countRows(dataDir, 'attachment'), 0, 'the migration seeds no attachments');

    const triggers = triggerNames(dataDir);
    assert.ok(
      triggers.includes('attachment_immutable_update'),
      `the UPDATE trigger is missing; triggers: ${triggers.join(', ')}`,
    );
    assert.ok(
      triggers.includes('attachment_immutable_delete'),
      `the DELETE trigger is missing; triggers: ${triggers.join(', ')}`,
    );

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 11);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 4 data dir upgrades through the chain with a backup that keeps message history', async () => {
  const parent = await makeTempDir('allibot-attachments-upgrade-');
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

    assert.equal(readSchemaVersion(dataDir), 11);
    assert.deepEqual(attachmentColumns(dataDir), [
      'id',
      'message_id',
      'filename',
      'mime',
      'size',
      'storage_path',
      'created_at',
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
      assert.equal(version, 4, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('attachment'), false, 'the backup predates the attachment table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 4);
    assert.equal(last?.['to'], 11);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});
