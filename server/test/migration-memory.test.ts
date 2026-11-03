import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { MIGRATION_FIXTURE, makeTempDir, readLedger, removeTempDir, runCli } from './support.ts';

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

const MEMORY_COLUMNS = [
  'id',
  'member_id',
  'content',
  'keywords',
  'source_target_id',
  'source_message_id',
  'created_at',
];

test('migrating an empty data dir adds agent_memory and no embedding or vector table', async () => {
  const dataDir = await makeTempDir('allibot-memory-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 10);
    assert.deepEqual(columnNames(dataDir, 'agent_memory'), MEMORY_COLUMNS);
    assert.equal(countRows(dataDir, 'agent_memory'), 0, 'the migration seeds no memories');

    // The retrieval is keyword matching, never a vector search (ADR 0005): the
    // schema must not grow an embedding or vector table.
    const tables = tableNames(dataDir);
    for (const table of tables) {
      assert.doesNotMatch(table, /embedding|vector/i, `unexpected retrieval table: ${table}`);
    }

    const listed = spawnSync('sqlite3', [path.join(dataDir, 'allibot.db'), '.tables'], {
      encoding: 'utf8',
    });
    assert.equal(listed.status, 0, `sqlite3 should exit 0; stderr: ${listed.stderr}`);
    assert.match(listed.stdout, /\bagent_memory\b/);
    assert.doesNotMatch(listed.stdout, /embedding|vector/i, 'sqlite3 .tables names no retrieval table');

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 10);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 8 data dir upgrades to the current version with a backup that keeps channel and message rows', async () => {
  const parent = await makeTempDir('allibot-memory-upgrade-');
  const dataDir = path.join(parent, 'data');

  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v8', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-8 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 8);

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
    assert.deepEqual(columnNames(dataDir, 'agent_memory'), MEMORY_COLUMNS);
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
      assert.equal(version, 8, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('agent_memory'), false, 'the backup predates the memory table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 8);
    assert.equal(last?.['to'], 10);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});

test('agent_memory keeps cards readable and refuses a card without content or keywords', async () => {
  const dataDir = await makeTempDir('allibot-memory-constraints-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.pragma('foreign_keys = ON');
      const now = '2026-01-01T00:00:00.000Z';
      const owner = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string };
      db.prepare(
        `INSERT INTO channel
           (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
            created_at, updated_at)
         VALUES ('channel-a', '频道', '', 'autonomous', 3, NULL, NULL, ?, ?)`,
      ).run(now, now);
      db.prepare("INSERT INTO target (id, kind) VALUES ('channel-a', 'channel')").run();
      db.prepare(
        `INSERT INTO message
           (id, target_id, seq, kind, author_member_id, author_display_name,
            author_avatar_slot, body, created_at, task_ref, task_pointer, client_message_id)
         VALUES ('message-a', 'channel-a', 1, 'human', ?, '我', 0, '触发', ?, NULL, NULL, NULL)`,
      ).run(owner.id, now);

      const insert = (id: string, content: string, keywords: string): void => {
        db.prepare(
          `INSERT INTO agent_memory
             (id, member_id, content, keywords, source_target_id, source_message_id, created_at)
           VALUES (?, ?, ?, ?, 'channel-a', 'message-a', ?)`,
        ).run(id, owner.id, content, keywords, now);
      };

      insert('memory-ok', '触发消息摘录：触发', '["触发"]');
      assert.throws(
        () => insert('memory-empty-keywords', '触发消息摘录：触发', ''),
        /CHECK constraint failed/,
        'a card always carries at least one keyword',
      );
      assert.throws(
        () => insert('memory-empty-content', '', '["触发"]'),
        /CHECK constraint failed/,
        'a card always carries readable content',
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO agent_memory
                 (id, member_id, content, keywords, source_target_id, source_message_id, created_at)
               VALUES ('memory-bad-member', 'missing-member', '内容', '["内容"]',
                       'channel-a', 'message-a', ?)`,
            )
            .run(now),
        /FOREIGN KEY constraint failed/,
        'a card belongs to a member that exists',
      );
      assert.throws(
        () =>
          db
            .prepare(
              `INSERT INTO agent_memory
                 (id, member_id, content, keywords, source_target_id, source_message_id, created_at)
               VALUES ('memory-bad-message', ?, '内容', '["内容"]', 'channel-a', 'missing', ?)`,
            )
            .run(owner.id, now),
        /FOREIGN KEY constraint failed/,
        'a card names the message it summarises',
      );

      // Memory can be revised (ADR 0005), unlike the append-only message rows.
      db.prepare("UPDATE agent_memory SET content = '修订后的卡片' WHERE id = 'memory-ok'").run();
      assert.equal(
        (
          db.prepare("SELECT content FROM agent_memory WHERE id = 'memory-ok'").get() as {
            content: string;
          }
        ).content,
        '修订后的卡片',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});
