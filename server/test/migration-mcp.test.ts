import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  MIGRATION_FIXTURE,
  makeTempDir,
  readLedger,
  runCli,
} from './support.ts';

/**
 * Schema 步骤 21 (#47 / T19): `mcp_server` (history / migration source only),
 * `skill` (metadata only; installation is #48), and the `remote_consent_scope`
 * rebuild that widens the consent vocabulary to model / mcp / docker.
 *
 * Everything is read from the data directory the CLI wrote: the strict +1
 * chain, the rebuilt table's shape and existing rows, the two new tables'
 * UNIQUE constraints, the sibling backup, the audit ledger and the empty
 * database path. The v20 baseline is the real #37-#44 shape, so this is the
 * production v20 -> 21 migration.
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const CHANNEL_ID = 'channel-mcp';
const AGENT_ID = 'member-agent-mcp';
const ANTHROPIC_AT = '2026-09-01T01:02:03.000Z';
const OPENAI_AT = '2026-09-02T04:05:06.000Z';

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

function columns(
  dataDir: string,
  table: string,
): { name: string; notnull: number; dflt_value: unknown; pk: number }[] {
  const db = openReadOnly(dataDir);
  try {
    return db.pragma(`table_info(${table})`) as {
      name: string;
      notnull: number;
      dflt_value: unknown;
      pk: number;
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

function tableNames(dataDir: string): string[] {
  const db = openReadOnly(dataDir);
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

/** Build the v20 baseline and seed the rows that must survive the rebuild. */
function seedV20(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v20', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v20 fixture should build the v20 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    db.prepare(
      `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
       VALUES (?, 'agent', 'MCP 成员', 1, NULL, ?)`,
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
       VALUES (?, 'MCP 频道', '', 'autonomous', NULL, 3, NULL, NULL, ?, ?)`,
    ).run(CHANNEL_ID, SEEDED_AT, SEEDED_AT);
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(CHANNEL_ID);

    // The two M1 model consent rows that the v21 rebuild must preserve as-is.
    const insertConsent = db.prepare(
      `INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at)
       VALUES ('model', ?, ?)`,
    );
    insertConsent.run('anthropic', ANTHROPIC_AT);
    insertConsent.run('openai', OPENAI_AT);
  } finally {
    db.close();
  }
}

test('a v20 data directory migrates to 21; mcp_server / skill exist and model consents survive', async () => {
  const tmp = await makeTempDir('allibot-migration-mcp-');
  const dataDir = path.join(tmp, 'data');
  const snapshot = path.join(tmp, 'snapshot');
  try {
    seedV20(dataDir);
    cpSync(dataDir, snapshot, { recursive: true });

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(readSchemaVersion(dataDir), 21);
    assert.match(result.output, /Schema 版本 21/);

    // One sibling backup, byte-identical to the pre-migration snapshot.
    const backups = readdirSync(tmp).filter((entry) => entry.startsWith('data.backup-'));
    assert.equal(backups.length, 1, `one sibling backup; found ${JSON.stringify(backups)}`);
    const backupDir = path.join(tmp, backups[0]!);
    const diff = spawnSync('diff', ['-r', snapshot, backupDir], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `the backup equals the pre-migration snapshot: ${diff.stdout}`);

    // One ledger line for this run, from 20 to 21.
    const ledger = readLedger(dataDir);
    const lines = ledger.filter((line) => line['to'] === 21);
    assert.equal(lines.length, 1, `one from=20/to=21 line; ledger: ${JSON.stringify(ledger)}`);
    assert.equal(lines[0]!['from'], 20);
    assert.equal(lines[0]!['result'], 'ok');
    assert.equal(typeof lines[0]!['backup_path'], 'string');
    assert.equal(foreignKeyViolations(dataDir).length, 0);

    // Step 21: the two new tables are present.
    const tables = tableNames(dataDir);
    assert.ok(tables.includes('mcp_server'), `mcp_server exists; tables: ${tables.join(',')}`);
    assert.ok(tables.includes('skill'), `skill exists; tables: ${tables.join(',')}`);

    for (const column of [
      'id',
      'scope_kind',
      'scope_id',
      'name',
      'transport',
      'config',
      'enabled',
      'created_at',
    ]) {
      assert.ok(
        columns(dataDir, 'mcp_server').some((row) => row.name === column),
        `mcp_server.${column}`,
      );
    }
    assert.match(tableSql(dataDir, 'mcp_server')!, /UNIQUE\s*\(scope_kind, scope_id, name\)/);

    for (const column of [
      'id',
      'member_id',
      'name',
      'content_hash',
      'enabled',
      'source',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(
        columns(dataDir, 'skill').some((row) => row.name === column),
        `skill.${column}`,
      );
    }
    assert.match(tableSql(dataDir, 'skill')!, /UNIQUE\s*\(member_id, name\)/);
    assert.match(tableSql(dataDir, 'skill')!, /REFERENCES member\s*\(id\)/i);

    // The rebuilt consent table kept both model rows exactly, with the widened
    // vocabulary and the non-empty scope id.
    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const rows = db
        .prepare(
          `SELECT scope_kind, scope_id, confirmed_at FROM remote_consent_scope
            ORDER BY scope_id`,
        )
        .all() as { scope_kind: string; scope_id: string; confirmed_at: string }[];
      assert.deepEqual(rows, [
        { scope_kind: 'model', scope_id: 'anthropic', confirmed_at: ANTHROPIC_AT },
        { scope_kind: 'model', scope_id: 'openai', confirmed_at: OPENAI_AT },
      ]);
      assert.match(tableSql(dataDir, 'remote_consent_scope')!, /PRIMARY KEY\s*\(scope_kind, scope_id\)/i);

      const insertConsent = db.prepare(
        `INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at)
         VALUES (?, ?, ?)`,
      );
      insertConsent.run('mcp', 'demo-server', SEEDED_AT);
      insertConsent.run('docker', 'node:22-bookworm-slim', SEEDED_AT);
      assert.throws(
        () => insertConsent.run('model', 'anthropic', SEEDED_AT),
        /UNIQUE constraint failed/i,
      );
      assert.throws(
        () => insertConsent.run('web', 'exa', SEEDED_AT),
        /CHECK constraint failed/i,
        'the consent vocabulary is exactly model / mcp / docker',
      );
      assert.throws(
        () => insertConsent.run('mcp', '', SEEDED_AT),
        /CHECK constraint failed/i,
        'a consent scope always names what was confirmed',
      );

      // mcp_server constraints: a non-empty name per scope, three transports,
      // JSON config, 0/1 enabled, UNIQUE(scope_kind, scope_id, name).
      const insertServer = db.prepare(
        `INSERT INTO mcp_server
           (id, scope_kind, scope_id, name, transport, config, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertServer.run(
        'server-1',
        'agent',
        AGENT_ID,
        'demo',
        'stdio',
        JSON.stringify({ command: 'node', args: [] }),
        1,
        SEEDED_AT,
      );
      assert.throws(
        () =>
          insertServer.run(
            'server-2',
            'agent',
            AGENT_ID,
            'demo',
            'http',
            JSON.stringify({ url: 'http://127.0.0.1:1/mcp' }),
            1,
            SEEDED_AT,
          ),
        /UNIQUE constraint failed/i,
      );
      assert.throws(
        () =>
          insertServer.run(
            'server-3',
            'channel',
            CHANNEL_ID,
            'bad-transport',
            'websocket',
            '{}',
            1,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertServer.run(
            'server-4',
            'channel',
            CHANNEL_ID,
            'bad-json',
            'stdio',
            'not-json',
            1,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertServer.run(
            'server-5',
            'channel',
            CHANNEL_ID,
            'bad-enabled',
            'stdio',
            '{}',
            2,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );

      // skill constraints: 64 lowercase hex content hash, three sources, 0/1
      // enabled, FK to member, UNIQUE(member_id, name).
      const insertSkill = db.prepare(
        `INSERT INTO skill
           (id, member_id, name, content_hash, enabled, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertSkill.run(
        'skill-1',
        AGENT_ID,
        'demo',
        'a'.repeat(64),
        1,
        'directory',
        SEEDED_AT,
        SEEDED_AT,
      );
      assert.throws(
        () =>
          insertSkill.run(
            'skill-2',
            AGENT_ID,
            'demo',
            'b'.repeat(64),
            1,
            'zip',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /UNIQUE constraint failed/i,
      );
      assert.throws(
        () =>
          insertSkill.run(
            'skill-3',
            AGENT_ID,
            'bad-hash',
            'a'.repeat(63),
            1,
            'directory',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertSkill.run(
            'skill-4',
            AGENT_ID,
            'non-hex',
            'a'.repeat(63) + 'z',
            1,
            'directory',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertSkill.run(
            'skill-5',
            AGENT_ID,
            'bad-source',
            'c'.repeat(64),
            1,
            'market',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertSkill.run(
            'skill-6',
            'missing-member',
            'orphan',
            'd'.repeat(64),
            1,
            'agents-skills',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /FOREIGN KEY constraint failed/i,
      );
    } finally {
      db.close();
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an empty data directory migrates straight to 21 with no backup', async () => {
  const tmp = await makeTempDir('allibot-migration-mcp-empty-');
  const dataDir = path.join(tmp, 'data');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.match(result.output, /Schema 版本 21/);
    assert.equal(readSchemaVersion(dataDir), 21);

    const ledger = readLedger(dataDir);
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0]!['from'], null);
    assert.equal(ledger[0]!['to'], 21);
    assert.equal(ledger[0]!['result'], 'ok');
    assert.equal(ledger[0]!['backup_path'], null);
    assert.equal(foreignKeyViolations(dataDir).length, 0);
    assert.equal(readdirSync(tmp).filter((entry) => entry.startsWith('data.backup-')).length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
