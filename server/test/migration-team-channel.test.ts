import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import {
  MIGRATION_FIXTURE,
  makeTempDir,
  readLedger,
  removeTempDir,
  runCli,
} from './support.ts';

/**
 * Schema 步骤 14 (#37 / T13): the `channel` table is rebuilt so `mode` accepts
 * `task`'s sibling topology `team` and the leader column exists. Everything is
 * observed from the data directory the CLI wrote — the database shape, the
 * sibling backup, and the audit ledger — never from a private function.
 *
 * The rebuild is the M2 table-rebuild precedent: `foreign_keys=OFF` outside the
 * transaction, the steps inside it, `PRAGMA foreign_key_check` before commit.
 * Seeding a child row (a reminder that references the channel) is what makes
 * the discipline observable: with foreign keys on, dropping the referenced
 * table would fail, and a wrong rebuild would leave the child dangling.
 */

interface ChannelRow {
  id: string;
  name: string;
  description: string;
  mode: string;
  team_leader_member_id: string | null;
  response_budget_limit: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

const LIVE_CHANNEL = 'channel-live';
const ARCHIVED_CHANNEL = 'channel-archived';
const DELETED_CHANNEL = 'channel-deleted';
const SEEDED_AT = '2026-10-01T08:00:00.000Z';

function openReadOnly(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
}

function readSchemaVersion(dataDir: string): unknown {
  const db = openReadOnly(dataDir);
  try {
    return (
      db.prepare('SELECT schema_version FROM schema_meta').get() as { schema_version: unknown }
    ).schema_version;
  } finally {
    db.close();
  }
}

function channelSql(dataDir: string): string {
  const db = openReadOnly(dataDir);
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'channel'")
      .get() as { sql: string } | undefined;
    assert.ok(row !== undefined, 'the channel table should exist');
    return row.sql;
  } finally {
    db.close();
  }
}

function tableColumns(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (db.pragma(`table_info(${table})`) as { name: string }[]).map((row) => row.name);
  } finally {
    db.close();
  }
}

function foreignKeyViolations(dataDir: string): unknown[] {
  const db = openReadOnly(dataDir);
  try {
    return db.pragma('foreign_key_check') as unknown[];
  } finally {
    db.close();
  }
}

function channels(dataDir: string): ChannelRow[] {
  const db = openReadOnly(dataDir);
  try {
    return db
      .prepare(
        `SELECT id, name, description, mode, team_leader_member_id, response_budget_limit,
                archived_at, deleted_at, created_at, updated_at
           FROM channel ORDER BY id`,
      )
      .all() as ChannelRow[];
  } finally {
    db.close();
  }
}

/** The v13 shape: the leader column does not exist yet. */
function legacyChannels(dataDir: string): Omit<ChannelRow, 'team_leader_member_id'>[] {
  const db = openReadOnly(dataDir);
  try {
    return db
      .prepare(
        `SELECT id, name, description, mode, response_budget_limit,
                archived_at, deleted_at, created_at, updated_at
           FROM channel ORDER BY id`,
      )
      .all() as Omit<ChannelRow, 'team_leader_member_id'>[];
  } finally {
    db.close();
  }
}

/** Build a v13 database with the three channel lifecycle rows and a child reminder. */
function seedV13(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v13', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v13 fixture should build the v13 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    const insertChannel = db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
          created_at, updated_at)
       VALUES (?, ?, ?, 'autonomous', 5, ?, ?, ?, ?)`,
    );
    insertChannel.run(
      LIVE_CHANNEL,
      '研究频道',
      '讨论论文与实验',
      null,
      null,
      SEEDED_AT,
      SEEDED_AT,
    );
    insertChannel.run(
      ARCHIVED_CHANNEL,
      '已归档频道',
      '只读历史',
      '2026-10-02T08:00:00.000Z',
      null,
      SEEDED_AT,
      '2026-10-02T08:00:00.000Z',
    );
    insertChannel.run(
      DELETED_CHANNEL,
      '已删除频道',
      '终态软删除',
      null,
      '2026-10-03T08:00:00.000Z',
      SEEDED_AT,
      '2026-10-03T08:00:00.000Z',
    );
    db.prepare(
      `INSERT INTO reminder
         (id, channel_id, due_at_local, text, delivered_at, missed, created_at)
       VALUES ('reminder-1', ?, '2026-10-04T09:00', '提醒', NULL, 0, ?)`,
    ).run(LIVE_CHANNEL, SEEDED_AT);
  } finally {
    db.close();
  }
}

test('a v13 data directory rebuilds channel and lands at the current version with one ledger line', async () => {
  const parent = await makeTempDir('allibot-team-migrate-');
  const dataDir = path.join(parent, 'data');
  const snapshot = path.join(parent, 'snapshot');
  try {
    seedV13(dataDir);
    assert.equal(readSchemaVersion(dataDir), 13, 'the fixture builds the v13 baseline');
    const before = legacyChannels(dataDir);
    assert.equal(before.length, 3);
    cpSync(dataDir, snapshot, { recursive: true });

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    assert.equal(
      readSchemaVersion(dataDir),
      SCHEMA_VERSION,
      'the strict +1 chain lands at the current schema version',
    );
    assert.match(
      channelSql(dataDir),
      /team_leader_member_id/,
      'the rebuilt channel table carries the leader column',
    );

    const backups = readdirSync(parent).filter((name) => name.startsWith('data.backup-'));
    assert.equal(
      backups.length,
      1,
      `expected exactly one sibling backup directory, saw: ${backups.join(', ')}`,
    );
    const backupPath = path.join(parent, backups[0] ?? '');
    const diff = spawnSync('diff', ['-r', backupPath, snapshot], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `the backup must equal the pre-migration data dir; diff: ${diff.stdout}`);
    assert.equal(diff.stdout, '');

    const ledger = readLedger(dataDir);
    const last = ledger[ledger.length - 1];
    assert.ok(last !== undefined, 'the audit ledger has a record for the migration');
    assert.equal(last['from'], 13);
    assert.equal(last['to'], SCHEMA_VERSION);
    assert.equal(last['result'], 'ok');
    assert.equal(last['backup_path'], backupPath);
    const startedAt = Date.parse(String(last['started_at']));
    const finishedAt = Date.parse(String(last['finished_at']));
    assert.ok(Number.isFinite(startedAt), 'the audit record has a start timestamp');
    assert.ok(Number.isFinite(finishedAt), 'the audit record has a finish timestamp');
    assert.ok(startedAt <= finishedAt);
  } finally {
    await removeTempDir(parent);
  }
});

test('the rebuilt channel table carries the two leader CHECKs, keeps every row verbatim and leaves no foreign key violation', async () => {
  const parent = await makeTempDir('allibot-team-rebuild-');
  const dataDir = path.join(parent, 'data');
  try {
    seedV13(dataDir);
    const before = legacyChannels(dataDir);

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    const sql = channelSql(dataDir);
    assert.match(
      sql,
      /CHECK\s*\(\s*mode IN \('autonomous', 'team'\)\s*\)/,
      `the mode CHECK is widened to autonomous/team: ${sql}`,
    );
    assert.match(
      sql,
      /CHECK\s*\(\s*mode = 'team' OR team_leader_member_id IS NULL\s*\)/,
      `the team-mode leader CHECK exists: ${sql}`,
    );
    assert.match(
      sql,
      /CHECK\s*\(\s*mode = 'autonomous' OR team_leader_member_id IS NOT NULL\s*\)/,
      `the autonomous-mode leader CHECK exists: ${sql}`,
    );
    assert.ok(
      tableColumns(dataDir, 'channel').includes('team_leader_member_id'),
      'the leader column is part of the rebuilt shape',
    );

    assert.deepEqual(foreignKeyViolations(dataDir), [], 'the parent rebuild leaves no dangling child');

    const after = channels(dataDir);
    assert.deepEqual(
      after.map(({ team_leader_member_id: _leader, ...row }) => row),
      before,
      'every existing channel row is copied verbatim with a NULL leader',
    );
    assert.equal(after.every((row) => row.team_leader_member_id === null), true);

    const db = openReadOnly(dataDir);
    try {
      const reminder = db
        .prepare("SELECT channel_id FROM reminder WHERE id = 'reminder-1'")
        .get() as { channel_id: string } | undefined;
      assert.equal(reminder?.channel_id, LIVE_CHANNEL, 'the child row survives and still resolves');
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});

test('the rebuilt CHECKs refuse team without a leader and autonomous with a leader', async () => {
  const parent = await makeTempDir('allibot-team-check-');
  const dataDir = path.join(parent, 'data');
  try {
    seedV13(dataDir);
    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const owner = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string };
      const insert = db.prepare(
        `INSERT INTO channel
           (id, name, description, mode, team_leader_member_id, response_budget_limit,
            archived_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, '', ?, ?, 3, NULL, NULL, ?, ?)`,
      );

      assert.throws(
        () => insert.run('team-without-leader', 'team 无队长', 'team', null, SEEDED_AT, SEEDED_AT),
        /CHECK constraint failed/,
        'team mode requires a leader',
      );
      assert.throws(
        () =>
          insert.run('auto-with-leader', '自主有队长', 'autonomous', owner.id, SEEDED_AT, SEEDED_AT),
        /CHECK constraint failed/,
        'autonomous mode forbids a leader',
      );
      insert.run('team-with-leader', 'team', 'team', owner.id, SEEDED_AT, SEEDED_AT);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});
