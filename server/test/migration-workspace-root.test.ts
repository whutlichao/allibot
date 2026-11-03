import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  MIGRATION_FIXTURE,
  makeTempDir,
  readLedger,
  removeTempDir,
  runCli,
} from './support.ts';

/**
 * Schema 步骤 18 (#42 / T17): the channel-scoped workspace project root and
 * backend plus the per-Agent backend override. Everything is observed from the
 * data directory the CLI wrote — the strict +1 step, the columns / defaults /
 * CHECKs, existing rows, the sibling backup, the audit ledger and the empty
 * database path — never from a private function.
 *
 * The v17 fixture is #41's delivered shape, so this is the real v17 -> v18
 * migration the product runs.
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const CHANNEL_ID = 'channel-workspace';
const AGENT_ID = 'member-agent';

function openReadOnly(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
}

function readSchemaVersion(dataDir: string): unknown {
  const db = openReadOnly(dataDir);
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

function tableSql(dataDir: string, table: string): string | undefined {
  const db = openReadOnly(dataDir);
  try {
    const row = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) as { sql: string } | undefined;
    return row?.sql;
  } finally {
    db.close();
  }
}

function columns(dataDir: string, table: string): { name: string; notnull: number; dflt_value: unknown }[] {
  const db = openReadOnly(dataDir);
  try {
    return db.pragma(`table_info(${table})`) as {
      name: string;
      notnull: number;
      dflt_value: unknown;
    }[];
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

/** Build the v17 baseline and seed the rows that must survive the step. */
function seedV17(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v17', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v17 fixture should build the v17 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    db.prepare(
      `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
       VALUES (?, 'agent', '工作区成员', 1, NULL, ?)`,
    ).run(AGENT_ID, SEEDED_AT);
    db.prepare(
      `INSERT INTO agent_config
         (member_id, role, model, system_prompt, enabled, context_window,
          compression_threshold, max_iterations, auto_claim)
       VALUES (?, 'engineer', 'openai:gpt-5', '', 1, 40, 0.8, 8, 1)`,
    ).run(AGENT_ID);
    db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, team_leader_member_id, response_budget_limit,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, '工作区频道', '', 'autonomous', NULL, 3, NULL, NULL, ?, ?)`,
    ).run(CHANNEL_ID, SEEDED_AT, SEEDED_AT);
  } finally {
    db.close();
  }
}

test('a v17 data directory migrates to v18 with the workspace columns and existing rows intact', async () => {
  const tmp = await makeTempDir('allibot-migration-workspace-');
  const dataDir = path.join(tmp, 'data');
  const snapshot = path.join(tmp, 'snapshot');
  try {
    seedV17(dataDir);
    cpSync(dataDir, snapshot, { recursive: true });
    assert.equal(readSchemaVersion(dataDir), 17, 'the fixture is the v17 shape');

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, migrated.output);
    assert.match(migrated.stdout, /Schema 版本 18/);

    assert.equal(readSchemaVersion(dataDir), 18, 'the strict +1 step lands at version 18');

    const siblingBackups = readdirSync(tmp).filter((entry) =>
      entry.startsWith('data.backup-'),
    );
    assert.equal(siblingBackups.length, 1, 'the migration made one whole-directory backup');
    const backupDb = new Database(path.join(tmp, siblingBackups[0]!, 'allibot.db'), {
      readonly: true,
    });
    try {
      const backupVersion = (
        backupDb.prepare('SELECT schema_version FROM schema_meta').get() as {
          schema_version: number;
        }
      ).schema_version;
      assert.equal(backupVersion, 17, 'the backup is the pre-migration directory');
      const backupChannels = backupDb
        .prepare("SELECT name FROM channel WHERE id = ?")
        .get(CHANNEL_ID) as { name: string } | undefined;
      assert.equal(backupChannels?.name, '工作区频道', 'the backup carries the seeded rows');
    } finally {
      backupDb.close();
    }
    cpSync(path.join(tmp, siblingBackups[0]!, 'allibot.db'), path.join(snapshot, 'check.db'));
    assert.ok(existsSync(path.join(snapshot, 'check.db')));

    const ledger = readLedger(dataDir);
    const last = ledger[ledger.length - 1]!;
    assert.equal(last['from'], 17);
    assert.equal(last['to'], 18);
    assert.equal(last['result'], 'ok');
    assert.equal(typeof last['backup_path'], 'string');
    assert.equal(
      ledger.filter((row) => row['to'] === 18).length,
      1,
      'exactly one ledger line is appended for this migration',
    );

    assert.deepEqual(foreignKeyViolations(dataDir), [], 'no dangling foreign key after the step');

    const channelColumns = columns(dataDir, 'channel');
    const channelByName = new Map(channelColumns.map((column) => [column.name, column]));
    assert.deepEqual(channelByName.get('workspace_root'), {
      cid: channelByName.get('workspace_root')!.cid,
      name: 'workspace_root',
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
      pk: 0,
    });
    assert.deepEqual(channelByName.get('workspace_backend'), {
      cid: channelByName.get('workspace_backend')!.cid,
      name: 'workspace_backend',
      type: 'TEXT',
      notnull: 1,
      dflt_value: "'local'",
      pk: 0,
    });
    assert.deepEqual(channelByName.get('allow_local_shell'), {
      cid: channelByName.get('allow_local_shell')!.cid,
      name: 'allow_local_shell',
      type: 'INTEGER',
      notnull: 1,
      dflt_value: '0',
      pk: 0,
    });

    const agentColumns = new Map(columns(dataDir, 'agent_config').map((column) => [column.name, column]));
    assert.deepEqual(agentColumns.get('workspace_backend'), {
      cid: agentColumns.get('workspace_backend')!.cid,
      name: 'workspace_backend',
      type: 'TEXT',
      notnull: 0,
      dflt_value: null,
      pk: 0,
    });

    const channelSql = tableSql(dataDir, 'channel') ?? '';
    assert.match(channelSql, /workspace_backend TEXT NOT NULL DEFAULT 'local'/);
    assert.match(channelSql, /workspace_backend IN \('local', 'docker'\)/);
    assert.match(channelSql, /allow_local_shell INTEGER NOT NULL DEFAULT 0/);
    assert.match(channelSql, /allow_local_shell IN \(0, 1\)/);
    const agentSql = tableSql(dataDir, 'agent_config') ?? '';
    assert.match(agentSql, /workspace_backend IS NULL OR workspace_backend IN \('local', 'docker'\)/);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const channel = db
        .prepare(
          'SELECT workspace_root, workspace_backend, allow_local_shell FROM channel WHERE id = ?',
        )
        .get(CHANNEL_ID) as {
        workspace_root: unknown;
        workspace_backend: unknown;
        allow_local_shell: unknown;
      };
      assert.deepEqual(channel, {
        workspace_root: null,
        workspace_backend: 'local',
        allow_local_shell: 0,
      });
      const agent = db
        .prepare('SELECT workspace_backend FROM agent_config WHERE member_id = ?')
        .get(AGENT_ID) as { workspace_backend: unknown };
      assert.deepEqual(agent, { workspace_backend: null });

      assert.throws(
        () =>
          db
            .prepare("UPDATE channel SET workspace_backend = 'podman' WHERE id = ?")
            .run(CHANNEL_ID),
        /CHECK constraint failed/,
      );
      assert.throws(
        () =>
          db
            .prepare('UPDATE channel SET allow_local_shell = 2 WHERE id = ?')
            .run(CHANNEL_ID),
        /CHECK constraint failed/,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE agent_config SET workspace_backend = 'podman' WHERE member_id = ?")
            .run(AGENT_ID),
        /CHECK constraint failed/,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an empty data directory migrates to v18 with no backup and one ledger line', async () => {
  const dataDir = await makeTempDir('allibot-migration-workspace-empty-');
  try {
    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, migrated.output);
    assert.equal(readSchemaVersion(dataDir), 18);
    assert.deepEqual(foreignKeyViolations(dataDir), []);
    const ledger = readLedger(dataDir);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!['from'], null);
    assert.equal(ledger[0]!['to'], 18);
    assert.equal(ledger[0]!['result'], 'ok');
    assert.equal(ledger[0]!['backup_path'], null);
  } finally {
    await removeTempDir(dataDir);
  }
});
