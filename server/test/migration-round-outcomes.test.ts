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

function columnNames(dataDir: string, table: string): string[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
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

const ROUND_OUTCOME_COLUMNS = [
  'id',
  'member_id',
  'target_id',
  'base_seq',
  'status',
  'reason',
  'finished_reason',
  'started_at',
  'finished_at',
  'budget_consumed',
  'merged',
];

test('migrating an empty data dir adds round_outcome at the current schema version', async () => {
  const dataDir = await makeTempDir('allibot-round-outcomes-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 10);
    assert.deepEqual(columnNames(dataDir, 'round_outcome'), ROUND_OUTCOME_COLUMNS);
    assert.equal(countRows(dataDir, 'round_outcome'), 0, 'the migration seeds no round outcomes');

    const triggers = triggerNames(dataDir);
    for (const trigger of ['round_outcome_append_only_update', 'round_outcome_append_only_delete']) {
      assert.ok(
        triggers.includes(trigger),
        `${trigger} is missing; triggers: ${triggers.join(', ')}`,
      );
    }
    assert.notEqual(
      triggerNames(dataDir).includes('round_outcome_append_only_insert'),
      true,
      'round outcomes are written by the backend only; INSERT itself is allowed',
    );

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 10);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('round_outcome refuses UPDATE and DELETE at the database level', async () => {
  const dataDir = await makeTempDir('allibot-round-outcomes-append-only-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const channelId = 'kept-channel';
      db.prepare(
        `INSERT INTO channel
           (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
            created_at, updated_at)
         VALUES (?, '频道', '', 'autonomous', 3, NULL, NULL, ?, ?)`,
      ).run(channelId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(channelId);
      const owner = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string };
      db.prepare(
        `INSERT INTO round_outcome
           (member_id, target_id, base_seq, status, reason, finished_reason,
            started_at, finished_at, budget_consumed, merged)
         VALUES (?, ?, 1, 'replied', '已回复', 'completed', ?, ?, 0, 0)`,
      ).run(owner.id, channelId, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:01.000Z');

      assert.throws(() => db.prepare("UPDATE round_outcome SET status = 'failed'").run(), /append-only/);
      assert.throws(() => db.prepare('DELETE FROM round_outcome').run(), /append-only/);
      assert.equal(
        (db.prepare('SELECT count(*) AS total FROM round_outcome').get() as { total: number }).total,
        1,
        'both refused statements leave the row in place',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 6 data dir upgrades to version 7 with a backup that keeps channel and message rows', async () => {
  const parent = await makeTempDir('allibot-round-outcomes-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v6', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-6 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 6);

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

    assert.equal(readSchemaVersion(dataDir), 10);
    assert.deepEqual(columnNames(dataDir, 'round_outcome'), ROUND_OUTCOME_COLUMNS);
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
      assert.equal(version, 6, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('round_outcome'), false, 'the backup predates round_outcome');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 6);
    assert.equal(last?.['to'], 10);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});
