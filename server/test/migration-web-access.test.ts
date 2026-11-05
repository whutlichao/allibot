import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import { MIGRATION_FIXTURE, makeTempDir, readLedger, runCli } from './support.ts';

/**
 * Schema 步骤 22-25 (#67 / T1 of the M3 web-access graph): the channel tier
 * (v22), the Agent override (v23), the provider credential table (v24) and the
 * `remote_consent_scope` rebuild that widens the consent vocabulary to `web`
 * (v25).
 *
 * Everything is read from the data directory the CLI wrote — the strict +1
 * chain, `PRAGMA table_info` shapes, the CHECKs, the partial unique index, the
 * rows a rebuild must keep, `PRAGMA foreign_key_check`, the audit ledger and
 * the rollback of a failing chain — never from a private function.
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const CHANNEL_ID = 'channel-web-access';
const AGENT_ID = 'member-agent-web-access';
const MODEL_CONFIRMED_AT = '2026-09-01T01:02:03.000Z';
const MCP_CONFIRMED_AT = '2026-09-02T04:05:06.000Z';
const DOCKER_CONFIRMED_AT = '2026-09-03T07:08:09.000Z';

interface ColumnRow {
  cid: number;
  name: string;
  type: string;
  notnull: number;
  dflt_value: unknown;
  pk: number;
}

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

function tableColumns(dataDir: string, table: string): ColumnRow[] {
  const db = openReadOnly(dataDir);
  try {
    return db.pragma(`table_info(${table})`) as ColumnRow[];
  } finally {
    db.close();
  }
}

function column(columns: readonly ColumnRow[], name: string): ColumnRow | undefined {
  return columns.find((row) => row.name === name);
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

function databaseShape(dataDir: string): {
  version: unknown;
  tables: string[];
  columns: Record<string, Record<string, ColumnRow | undefined>>;
} {
  const db = openReadOnly(dataDir);
  try {
    const version = (
      db.prepare('SELECT schema_version FROM schema_meta').get() as {
        schema_version: unknown;
      }
    ).schema_version;
    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as { name: string }[]
    ).map((row) => row.name);
    const columns: Record<string, Record<string, ColumnRow | undefined>> = {};
    for (const table of tables) {
      columns[table] = Object.fromEntries(
        (db.pragma(`table_info(${table})`) as ColumnRow[]).map((row) => [row.name, row]),
      );
    }
    return { version, tables, columns };
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

function insertChannel(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO channel
       (id, name, description, mode, team_leader_member_id, response_budget_limit,
        archived_at, deleted_at, created_at, updated_at)
     VALUES (?, '联网频道', '', 'autonomous', NULL, 3, NULL, NULL, ?, ?)`,
  ).run(id, SEEDED_AT, SEEDED_AT);
}

test('a fresh install gives channel.web_access the four-tier CHECK and docker_egress the 0/1 switch', async () => {
  const dataDir = await makeTempDir('allibot-web-access-v22-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const channelColumns = tableColumns(dataDir, 'channel');
    const webAccess = column(channelColumns, 'web_access');
    const dockerEgress = column(channelColumns, 'docker_egress');
    assert.deepEqual(
      webAccess,
      {
        cid: webAccess?.cid,
        name: 'web_access',
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      'channel.web_access is nullable and has no default: NULL means unconfigured',
    );
    assert.deepEqual(
      dockerEgress,
      {
        cid: dockerEgress?.cid,
        name: 'docker_egress',
        type: 'INTEGER',
        notnull: 1,
        dflt_value: '0',
        pk: 0,
      },
      'channel.docker_egress defaults to 0, like allow_local_shell',
    );

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      insertChannel(db, CHANNEL_ID);
      assert.deepEqual(
        db
          .prepare('SELECT web_access, docker_egress FROM channel WHERE id = ?')
          .get(CHANNEL_ID),
        { web_access: null, docker_egress: 0 },
        'the channel defaults are unconfigured web access and no container egress',
      );

      const setTier = db.prepare('UPDATE channel SET web_access = ? WHERE id = ?');
      for (const tier of [null, 'off', 'search', 'search+fetch']) {
        setTier.run(tier, CHANNEL_ID);
      }
      assert.throws(
        () => setTier.run('all', CHANNEL_ID),
        /CHECK constraint failed/i,
        'the channel tier is NULL / off / search / search+fetch',
      );
      assert.throws(() => setTier.run('SEARCH', CHANNEL_ID), /CHECK constraint failed/i);

      const setEgress = db.prepare('UPDATE channel SET docker_egress = ? WHERE id = ?');
      setEgress.run(1, CHANNEL_ID);
      setEgress.run(0, CHANNEL_ID);
      assert.throws(
        () => setEgress.run(2, CHANNEL_ID),
        /CHECK constraint failed/i,
        'container egress is a 0 / 1 switch',
      );
      assert.throws(
        () => setEgress.run(null, CHANNEL_ID),
        /NOT NULL constraint failed/i,
        'the switch never reads as NULL',
      );
    } finally {
      db.close();
    }
    assert.deepEqual(foreignKeyViolations(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('agent_config.web_access stays nullable so an Agent follows its channel, with the same four tiers', async () => {
  const dataDir = await makeTempDir('allibot-web-access-v23-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const agentColumns = tableColumns(dataDir, 'agent_config');
    const webAccess = column(agentColumns, 'web_access');
    assert.deepEqual(
      webAccess,
      {
        cid: webAccess?.cid,
        name: 'web_access',
        type: 'TEXT',
        notnull: 0,
        dflt_value: null,
        pk: 0,
      },
      'agent_config.web_access is nullable with no default: NULL follows the channel',
    );

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.prepare(
        `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
         VALUES (?, 'agent', '联网成员', 1, NULL, ?)`,
      ).run(AGENT_ID, SEEDED_AT);
      db.prepare(
        `INSERT INTO agent_config
           (member_id, role, model, system_prompt, enabled, context_window,
            compression_threshold, max_iterations, auto_claim)
         VALUES (?, 'engineer', 'openai:gpt-5', '', 1, 40, 0.8, 8, 1)`,
      ).run(AGENT_ID);
      assert.deepEqual(
        db.prepare('SELECT web_access FROM agent_config WHERE member_id = ?').get(AGENT_ID),
        { web_access: null },
        'an Agent that has never overridden the tier follows its channel',
      );

      const setTier = db.prepare('UPDATE agent_config SET web_access = ? WHERE member_id = ?');
      for (const tier of [null, 'off', 'search', 'search+fetch']) {
        setTier.run(tier, AGENT_ID);
      }
      assert.throws(
        () => setTier.run('all', AGENT_ID),
        /CHECK constraint failed/i,
        'the Agent override is NULL / off / search / search+fetch',
      );
      assert.throws(() => setTier.run('', AGENT_ID), /CHECK constraint failed/i);
    } finally {
      db.close();
    }
    assert.deepEqual(foreignKeyViolations(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('web_provider_credential takes the five providers and at most one default', async () => {
  const dataDir = await makeTempDir('allibot-web-access-v24-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const credentialColumns = tableColumns(dataDir, 'web_provider_credential');
    assert.deepEqual(
      credentialColumns.map((row) => ({
        name: row.name,
        type: row.type,
        notnull: row.notnull,
        dflt_value: row.dflt_value,
        pk: row.pk,
      })),
      [
        { name: 'provider', type: 'TEXT', notnull: 0, dflt_value: null, pk: 1 },
        { name: 'api_key', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'is_default', type: 'INTEGER', notnull: 1, dflt_value: '0', pk: 0 },
        { name: 'created_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
        { name: 'updated_at', type: 'TEXT', notnull: 1, dflt_value: null, pk: 0 },
      ],
      'the credential table is provider / api_key / is_default / timestamps',
    );

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const insert = db.prepare(
        `INSERT INTO web_provider_credential
           (provider, api_key, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      );
      assert.throws(
        () => insert.run('serpapi', 'sk-sixth', 0, SEEDED_AT, SEEDED_AT),
        /CHECK constraint failed/i,
        'the provider vocabulary is exactly the five credential providers',
      );
      assert.throws(
        () => insert.run('brave', '', 0, SEEDED_AT, SEEDED_AT),
        /CHECK constraint failed/i,
        'a stored credential is never an empty key',
      );

      // Several non-default rows are the normal case: one key per provider.
      insert.run('brave', 'sk-brave', 0, SEEDED_AT, SEEDED_AT);
      insert.run('tavily', 'sk-tavily', 0, SEEDED_AT, SEEDED_AT);
      insert.run('perplexity', 'sk-perplexity', 0, SEEDED_AT, SEEDED_AT);
      insert.run('jina', 'sk-jina', 0, SEEDED_AT, SEEDED_AT);
      insert.run('exa', 'sk-exa', 1, SEEDED_AT, SEEDED_AT);
      assert.equal(
        (db.prepare('SELECT count(*) AS total FROM web_provider_credential').get() as {
          total: number;
        }).total,
        5,
        'five providers, one row each',
      );

      assert.throws(
        () => insert.run('exa-mcp', 'sk-second', 1, SEEDED_AT, SEEDED_AT),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          db
            .prepare(
              `UPDATE web_provider_credential
                  SET is_default = 1
                WHERE provider = 'brave'`,
            )
            .run(),
        /UNIQUE constraint failed/i,
        'the partial unique index allows at most one default row',
      );
      const rows = db
        .prepare(
          `SELECT provider FROM web_provider_credential
            WHERE is_default = 1 ORDER BY provider`,
        )
        .all() as { provider: string }[];
      assert.deepEqual(rows, [{ provider: 'exa' }], 'the default row is the one the owner set');
    } finally {
      db.close();
    }
    assert.deepEqual(foreignKeyViolations(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('the consent scope takes web providers after the rebuild and nothing else', async () => {
  const dataDir = await makeTempDir('allibot-web-access-v25-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const insert = db.prepare(
        `INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at)
         VALUES (?, ?, ?)`,
      );
      for (const scope of [
        ['model', 'anthropic'],
        ['mcp', 'demo-server'],
        ['docker', 'node:22-bookworm-slim'],
        ['web', 'brave'],
        ['web', 'exa'],
      ] as const) {
        insert.run(scope[0], scope[1], SEEDED_AT);
      }
      assert.throws(
        () => insert.run('web', 'brave', SEEDED_AT),
        /UNIQUE constraint failed/i,
        'a provider is confirmed once; the pair stays the primary key',
      );
      assert.throws(
        () => insert.run('skill', 'demo', SEEDED_AT),
        /CHECK constraint failed/i,
        'the consent vocabulary is exactly model / mcp / docker / web',
      );
    } finally {
      db.close();
    }
    assert.deepEqual(foreignKeyViolations(dataDir), []);
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('a v21 data directory migrates to 25 with the same shapes as a fresh install and its consent rows intact', async () => {
  const upgradeParent = await makeTempDir('allibot-web-access-upgrade-');
  const freshParent = await makeTempDir('allibot-web-access-fresh-');
  const dataDir = path.join(upgradeParent, 'data');
  const freshDir = path.join(freshParent, 'data');
  try {
    const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v21', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      fixture.status,
      0,
      `the v21 fixture should build the v21 baseline; output: ${fixture.stdout}${fixture.stderr}`,
    );
    assert.equal(readSchemaVersion(dataDir), 21, 'the baseline is the v21 shape');

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.prepare(
        `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
         VALUES (?, 'agent', '联网成员', 1, NULL, ?)`,
      ).run(AGENT_ID, SEEDED_AT);
      db.prepare(
        `INSERT INTO agent_config
           (member_id, role, model, system_prompt, enabled, context_window,
            compression_threshold, max_iterations, auto_claim)
         VALUES (?, 'engineer', 'openai:gpt-5', '', 1, 40, 0.8, 8, 1)`,
      ).run(AGENT_ID);
      insertChannel(db, CHANNEL_ID);
      db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(CHANNEL_ID);

      // The consent rows the v25 rebuild must copy verbatim, one per kind the
      // v21 CHECK already accepted.
      const insertConsent = db.prepare(
        `INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at)
         VALUES (?, ?, ?)`,
      );
      insertConsent.run('model', 'anthropic', MODEL_CONFIRMED_AT);
      insertConsent.run('mcp', 'demo-server', MCP_CONFIRMED_AT);
      insertConsent.run('docker', 'node:22-bookworm-slim', DOCKER_CONFIRMED_AT);
    } finally {
      db.close();
    }

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);
    assert.match(migrated.stdout, /Schema 版本 25/);
    assert.equal(readSchemaVersion(dataDir), 25);

    const fresh = runCli(['--migrate', '--data-dir', freshDir]);
    assert.equal(fresh.exitCode, 0, `fresh migrate should exit 0; output: ${fresh.output}`);
    assert.equal(readSchemaVersion(freshDir), 25);

    // The upgraded database and the fresh one are the same shape: every table's
    // PRAGMA table_info, including the table the v25 rebuild replaced.
    const upgradedTables = tableNames(dataDir);
    assert.deepEqual(upgradedTables, tableNames(freshDir), 'both directories hold the same tables');
    for (const table of upgradedTables) {
      assert.deepEqual(
        tableColumns(dataDir, table),
        tableColumns(freshDir, table),
        `${table} has the same column shape after an upgrade as on a fresh install`,
      );
    }

    // One audit record for this migration run, from 21 to 25 (the fixture's
    // own baseline build recorded its from-null line first).
    const ledger = readLedger(dataDir);
    assert.equal(ledger.length, 2, `two ledger lines; ledger: ${JSON.stringify(ledger)}`);
    const line = ledger[1]!;
    assert.equal(line['from'], 21);
    assert.equal(line['to'], 25);
    assert.equal(line['result'], 'ok');
    assert.equal(typeof line['backup_path'], 'string');

    const backups = readdirSync(upgradeParent).filter((entry) =>
      entry.startsWith('data.backup-'),
    );
    assert.equal(backups.length, 1, `one sibling backup; found ${JSON.stringify(backups)}`);
    const backupDb = new Database(path.join(upgradeParent, backups[0]!, 'allibot.db'), {
      readonly: true,
    });
    try {
      assert.equal(
        (
          backupDb.prepare('SELECT schema_version FROM schema_meta').get() as {
            schema_version: number;
          }
        ).schema_version,
        21,
        'the backup keeps the pre-migration version',
      );
    } finally {
      backupDb.close();
    }

    assert.deepEqual(foreignKeyViolations(dataDir), [], 'the rebuilt chain leaves no dangling row');

    const upgraded = new Database(path.join(dataDir, 'allibot.db'));
    try {
      assert.deepEqual(
        upgraded
          .prepare(
            `SELECT scope_kind, scope_id, confirmed_at FROM remote_consent_scope
              ORDER BY scope_kind, scope_id`,
          )
          .all(),
        [
          { scope_kind: 'docker', scope_id: 'node:22-bookworm-slim', confirmed_at: DOCKER_CONFIRMED_AT },
          { scope_kind: 'mcp', scope_id: 'demo-server', confirmed_at: MCP_CONFIRMED_AT },
          { scope_kind: 'model', scope_id: 'anthropic', confirmed_at: MODEL_CONFIRMED_AT },
        ],
        'the v25 rebuild copies every existing consent row verbatim, confirmed_at included',
      );
      assert.deepEqual(
        upgraded
          .prepare('SELECT web_access, docker_egress FROM channel WHERE id = ?')
          .get(CHANNEL_ID),
        { web_access: null, docker_egress: 0 },
        'the channel rows that predate the steps get the unconfigured tier and no egress',
      );
      assert.deepEqual(
        upgraded.prepare('SELECT web_access FROM agent_config WHERE member_id = ?').get(AGENT_ID),
        { web_access: null },
        'the Agent rows that predate the steps follow their channel',
      );
    } finally {
      upgraded.close();
    }
  } finally {
    rmSync(upgradeParent, { recursive: true, force: true });
    rmSync(freshParent, { recursive: true, force: true });
  }
});

test('a failing step after the web-access steps rolls the whole chain back to the v21 shape', async () => {
  const parent = await makeTempDir('allibot-web-access-rollback-');
  const dataDir = path.join(parent, 'data');
  try {
    const baseline = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v21', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(
      baseline.status,
      0,
      `the v21 fixture should build the v21 baseline; output: ${baseline.stdout}${baseline.stderr}`,
    );
    const before = databaseShape(dataDir);

    const failed = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'fail', dataDir], {
      encoding: 'utf8',
    });
    assert.notEqual(
      failed.status,
      0,
      `a failing step must exit non-zero; output: ${failed.stdout}${failed.stderr}`,
    );

    assert.deepEqual(databaseShape(dataDir), before, 'the chain rolls back completely');
    const shape = databaseShape(dataDir);
    assert.equal(shape.version, 21, 'the schema version stays at the pre-migration number');
    assert.equal(
      shape.tables.includes('web_provider_credential'),
      false,
      'v24 must not leave its credential table behind',
    );
    assert.equal(
      shape.tables.includes('fixture_business'),
      false,
      'the failing step must not leave its table behind',
    );
    assert.equal('web_access' in shape.columns['channel']!, false, 'v22 leaves no column behind');
    assert.equal(
      'docker_egress' in shape.columns['channel']!,
      false,
      'v22 leaves no egress switch behind',
    );
    assert.equal(
      'web_access' in shape.columns['agent_config']!,
      false,
      'v23 leaves no Agent override behind',
    );
    assert.deepEqual(foreignKeyViolations(dataDir), []);

    const ledger = readLedger(dataDir);
    const last = ledger[ledger.length - 1]!;
    assert.equal(last['result'], 'failed');
    assert.equal(last['from'], 21);
    assert.equal(last['to'], 26);
    assert.match(String(last['reason']), /injected migration step failure/);
    assert.equal(typeof last['backup_path'], 'string');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('SCHEMA_VERSION is 25 and a database newer than the code is still refused', async () => {
  assert.equal(SCHEMA_VERSION, 25, 'the chain tail and the code constant agree');

  const parent = await makeTempDir('allibot-web-access-gate-');
  const dataDir = path.join(parent, 'data');
  try {
    const baseline = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(baseline.exitCode, 0, `baseline migrate should exit 0; output: ${baseline.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      db.prepare('UPDATE schema_meta SET schema_version = ?').run(SCHEMA_VERSION + 1);
    } finally {
      db.close();
    }

    const refused = runCli(['--migrate', '--data-dir', dataDir]);
    assert.notEqual(refused.exitCode, 0, `--migrate must refuse; output: ${refused.output}`);
    assert.match(refused.output, /version_mismatch/);
    assert.equal(readSchemaVersion(dataDir), SCHEMA_VERSION + 1, 'the refusal changes no bytes');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
