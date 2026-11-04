import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
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

function countRows(dataDir: string, table: string): number {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number };
    return row.total;
  } finally {
    db.close();
  }
}

test('migrating an empty data dir adds channel, target and target_member', async () => {
  const dataDir = await makeTempDir('allibot-channels-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    const tables = tableNames(dataDir);
    for (const table of ['channel', 'target', 'target_member']) {
      assert.ok(tables.includes(table), `${table} table is missing; tables: ${tables.join(', ')}`);
    }

    // v14 (#37) rebuilds channel: the leader column sits beside mode and the
    // mode CHECK accepts autonomous / team.
    assert.deepEqual(columnNames(dataDir, 'channel'), [
      'id',
      'name',
      'description',
      'mode',
      'team_leader_member_id',
      'response_budget_limit',
      'archived_at',
      'deleted_at',
      'created_at',
      'updated_at',
      'workspace_root',
      'workspace_backend',
      'allow_local_shell',
      'permission_mode',
    ]);
    assert.deepEqual(columnNames(dataDir, 'target'), ['id', 'kind']);
    assert.deepEqual(columnNames(dataDir, 'target_member'), ['target_id', 'member_id']);

    assert.equal(countRows(dataDir, 'channel'), 0, 'the migration does not seed channels');
    assert.equal(countRows(dataDir, 'target'), 0, 'the migration does not seed targets');
    assert.equal(countRows(dataDir, 'target_member'), 0);
    assert.equal(
      countRows(dataDir, 'member'),
      1,
      'the owner row from version 2 survives the channel migration',
    );
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a version 2 data directory upgrades through the chain with a backup that keeps the owner and member rows', async () => {
  const parent = await makeTempDir('allibot-channels-upgrade-');
  const dataDir = path.join(parent, 'data');
  try {
    mkdirSync(dataDir);
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v2', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the version-2 fixture should succeed; output: ${baseline.stdout}${baseline.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 2);

    const seeded = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const owner = seeded.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as {
        id: string;
      };
      seeded
        .prepare(
          `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
           VALUES (?, 'agent', ?, 1, NULL, ?)`,
        )
        .run('kept-agent', 'Kept Agent', new Date().toISOString());
      seeded
        .prepare(
          `INSERT INTO agent_config
             (member_id, role, model, system_prompt, enabled, context_window,
              compression_threshold, max_iterations, auto_claim)
           VALUES ('kept-agent', 'role', NULL, '', 1, 40, 0.8, 10, 1)`,
        )
        .run();
      assert.ok(owner.id.length > 0);
    } finally {
      seeded.close();
    }

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION);
    assert.ok(tableNames(dataDir).includes('channel'));
    assert.equal(
      countRows(dataDir, "member WHERE id = 'kept-agent'"),
      1,
      'existing member rows survive the channel migration',
    );

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
      assert.equal(version, 2, 'the backup keeps the pre-migration schema version');
      const tables = (
        backupDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as {
          name: string;
        }[]
      ).map((row) => row.name);
      assert.equal(tables.includes('channel'), false, 'the backup predates the channel table');
    } finally {
      backupDb.close();
    }

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.equal(last?.['from'], 2);
    assert.equal(last?.['to'], SCHEMA_VERSION);
    assert.equal(last?.['result'], 'ok');
  } finally {
    await removeTempDir(parent);
  }
});
