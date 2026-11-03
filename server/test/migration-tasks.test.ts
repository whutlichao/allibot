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

/** The partial unique index that allows at most one pointer message per task. */
function indexSql(dataDir: string, name: string): string | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(name) as { sql: string | null } | undefined;
    return row?.sql ?? undefined;
  } finally {
    db.close();
  }
}

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

const TASK_COLUMNS = [
  'id',
  'channel_id',
  'target_id',
  'title',
  'status',
  'assignee_member_id',
  'claimed_at',
  'created_at',
  'updated_at',
];

test('migrating an empty data dir adds the task table with its guards and the pointer index', async () => {
  const dataDir = await makeTempDir('allibot-tasks-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 10);
    const tables = tableNames(dataDir);
    assert.ok(tables.includes('task'), `task table is missing; tables: ${tables.join(', ')}`);
    assert.deepEqual(columnNames(dataDir, 'task'), TASK_COLUMNS);
    assert.equal(countRows(dataDir, 'task'), 0, 'the migration seeds no tasks');

    assert.ok(
      uniqueIndexColumns(dataDir, 'task').some(
        (columns) => columns.length === 1 && columns[0] === 'target_id',
      ),
      'one task-type target carries at most one task row',
    );

    const triggers = triggerNames(dataDir);
    for (const trigger of [
      'task_target_must_be_task_kind',
      'task_scope_is_fixed',
      'task_no_delete',
      'message_task_pointer_guard',
    ]) {
      assert.ok(triggers.includes(trigger), `${trigger} is missing; triggers: ${triggers.join(', ')}`);
    }

    const pointerIndex = indexSql(dataDir, 'message_task_pointer_unique');
    assert.ok(pointerIndex !== undefined, 'the pointer partial unique index is missing');
    assert.match(pointerIndex, /WHERE\s+task_pointer\s+IS\s+NOT\s+NULL/i);

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.['from'], null);
    assert.equal(entries[0]?.['to'], 10);
    assert.equal(entries[0]?.['result'], 'ok');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 6 data dir upgrades to the current version with a backup that keeps channels, members and messages', async () => {
  const parent = await makeTempDir('allibot-tasks-upgrade-');
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
           VALUES ('kept-message', 'kept-channel', 1, 'human',
                   (SELECT id FROM member WHERE kind = 'owner'), '我', 0, '历史消息', ?, NULL, NULL, NULL)`,
        )
        .run('2026-01-01T00:00:01.000Z');
    } finally {
      seeded.close();
    }

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), 10);
    assert.deepEqual(columnNames(dataDir, 'task'), TASK_COLUMNS);
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
      assert.equal(tables.includes('task'), false, 'the backup predates the task table');
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

test('the task table and the pointer guard reject the shapes the invariants forbid', async () => {
  const dataDir = await makeTempDir('allibot-tasks-constraints-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.pragma('foreign_keys = ON');
      const now = '2026-01-01T00:00:00.000Z';
      const owner = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string };
      const insertChannel = (id: string): void => {
        db.prepare(
          `INSERT INTO channel
             (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
              created_at, updated_at)
           VALUES (?, ?, '', 'autonomous', 3, NULL, NULL, ?, ?)`,
        ).run(id, id, now, now);
        db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(id);
      };
      insertChannel('channel-a');
      insertChannel('channel-b');
      db.prepare("INSERT INTO target (id, kind) VALUES ('task-target', 'task')").run();

      const insertTask = (id: string, channelId: string, targetId: string): void => {
        db.prepare(
          `INSERT INTO task (id, channel_id, target_id, title, status, assignee_member_id,
                             claimed_at, created_at, updated_at)
           VALUES (?, ?, ?, '任务', 'todo', NULL, NULL, ?, ?)`,
        ).run(id, channelId, targetId, now, now);
      };
      insertTask('task-1', 'channel-a', 'task-target');

      assert.throws(
        () => insertTask('task-dup-target', 'channel-a', 'task-target'),
        /UNIQUE constraint failed: task\.target_id/,
        'a task-type target belongs to exactly one task',
      );

      db.prepare("INSERT INTO target (id, kind) VALUES ('channel-target', 'channel')").run();
      assert.throws(
        () => insertTask('task-wrong-target', 'channel-a', 'channel-target'),
        /task\.target_id must reference a task-type target/,
        'a task may only point at a task-type target',
      );

      db.prepare("INSERT INTO target (id, kind) VALUES ('task-target-2', 'task')").run();
      assert.throws(
        () =>
          db.prepare(
            `INSERT INTO task (id, channel_id, target_id, title, status, assignee_member_id,
                               claimed_at, created_at, updated_at)
             VALUES ('task-bad-status', 'channel-a', 'task-target-2', '任务', 'doing', NULL, NULL, ?, ?)`,
          ).run(now, now),
        /CHECK constraint failed/,
        'status is one of the five task statuses',
      );

      assert.throws(
        () => db.prepare("UPDATE task SET channel_id = 'channel-b' WHERE id = 'task-1'").run(),
        /task must stay in its channel and target/,
        'a task never moves across channels',
      );
      assert.throws(
        () => db.prepare("DELETE FROM task WHERE id = 'task-1'").run(),
        /task rows are not deleted/,
        'a task is not deleted from its channel',
      );

      const insertPointer = (
        id: string,
        targetId: string,
        kind: string,
        taskPointer: string,
      ): void => {
        db.prepare(
          `INSERT INTO message
             (id, target_id, seq, kind, author_member_id, author_display_name,
              author_avatar_slot, body, created_at, task_ref, task_pointer, client_message_id)
           VALUES (?, ?, (SELECT coalesce(MAX(seq), 0) + 1 FROM message WHERE target_id = ?),
                   ?, ?, '我', 0, '指针', ?, NULL, ?, NULL)`,
        ).run(id, targetId, targetId, kind, owner.id, now, taskPointer);
      };

      assert.throws(
        () => insertPointer('pointer-wrong-kind', 'channel-a', 'human', 'task-1'),
        /task_pointer must be a system message/,
        'a pointer is a system message, never a participant message',
      );
      assert.throws(
        () => insertPointer('pointer-wrong-channel', 'channel-b', 'system', 'task-1'),
        /task_pointer must be a system message on the channel that owns the task/,
        'the pointer lives in the task’s own channel',
      );

      insertPointer('pointer-1', 'channel-a', 'system', 'task-1');
      assert.throws(
        () => insertPointer('pointer-2', 'channel-a', 'system', 'task-1'),
        /UNIQUE constraint failed: message\.task_pointer/,
        'a task has at most one pointer message',
      );

      assert.equal(
        (db.prepare("SELECT count(*) AS total FROM message WHERE task_pointer = 'task-1'").get() as {
          total: number;
        }).total,
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});
