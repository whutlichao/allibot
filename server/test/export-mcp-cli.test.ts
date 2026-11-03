import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * `export-mcp` (#47 / D6.2), observed through the Node CLI and the files it
 * writes. The command is the only bridge from the historical `mcp_server`
 * table to the Agent-home `mcp.json`; runtime and startup never invoke it.
 *
 * Layout: one temporary HOME, one v21 data directory, legacy rows seeded
 * directly because there is no HTTP write path for the historical table.
 */

const AGENT_ID = 'agent-export-1';
const OTHER_AGENT_ID = 'agent-export-2';
const CHANNEL_ID = 'channel-export-1';
const SEEDED_AT = '2026-10-01T08:00:00.000Z';

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  agentHome: string;
  otherHome: string;
  migrationOutput: string;
  stop: () => Promise<void>;
}

function openDb(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'));
}

function seedAgent(db: Database.Database, id: string): void {
  db.prepare(
    `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
     VALUES (?, 'agent', ?, 1, NULL, ?)`,
  ).run(id, `成员 ${id}`, SEEDED_AT);
  db.prepare(
    `INSERT INTO agent_config
       (member_id, role, model, system_prompt, enabled, context_window,
        compression_threshold, max_iterations, auto_claim)
     VALUES (?, 'engineer', 'openai:gpt-5', '', 1, 40, 0.8, 8, 1)`,
  ).run(id);
}

function seedServer(
  db: Database.Database,
  row: {
    id: string;
    scope_kind: 'agent' | 'channel';
    scope_id: string;
    name: string;
    transport: 'stdio' | 'http' | 'sse';
    config: unknown;
    enabled?: number;
  },
): void {
  db.prepare(
    `INSERT INTO mcp_server
       (id, scope_kind, scope_id, name, transport, config, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.scope_kind,
    row.scope_id,
    row.name,
    row.transport,
    JSON.stringify(row.config),
    row.enabled ?? 1,
    SEEDED_AT,
  );
}

async function startFixture(prefix: string): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const db = openDb(dataDir);
  try {
    seedAgent(db, AGENT_ID);
    seedAgent(db, OTHER_AGENT_ID);
    db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, team_leader_member_id, response_budget_limit,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, '导出频道', '', 'autonomous', NULL, 3, NULL, NULL, ?, ?)`,
    ).run(CHANNEL_ID, SEEDED_AT, SEEDED_AT);
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(CHANNEL_ID);
  } finally {
    db.close();
  }
  return {
    tmp,
    dataDir,
    home,
    agentHome: path.join(home, '.allibot', 'agents', AGENT_ID),
    otherHome: path.join(home, '.allibot', 'agents', OTHER_AGENT_ID),
    migrationOutput: migration.output,
    stop: async () => removeTempDir(tmp),
  };
}

function seedDefaultRows(fixture: Fixture): void {
  const db = openDb(fixture.dataDir);
  try {
    seedServer(db, {
      id: 'row-demo',
      scope_kind: 'agent',
      scope_id: AGENT_ID,
      name: 'demo',
      transport: 'stdio',
      config: { command: 'node', args: ['demo-server.mjs'], env_names: ['MCP_TOKEN'] },
    });
    seedServer(db, {
      id: 'row-remote',
      scope_kind: 'agent',
      scope_id: AGENT_ID,
      name: 'remote',
      transport: 'http',
      config: { url: 'http://127.0.0.1:7777/mcp' },
    });
    seedServer(db, {
      id: 'row-channel',
      scope_kind: 'channel',
      scope_id: CHANNEL_ID,
      name: 'channel-old',
      transport: 'stdio',
      config: { command: 'node', args: [] },
    });
  } finally {
    db.close();
  }
}

function runExport(fixture: Fixture, extra: readonly string[] = []) {
  return runCli(['export-mcp', '--data-dir', fixture.dataDir, ...extra], {
    env: { HOME: fixture.home },
  });
}

function mcpJson(fixture: Fixture): string {
  return path.join(fixture.agentHome, 'mcp.json');
}

test('export-mcp defaults to dry-run, needs both --apply and --yes, then backs up and writes a manifest', async () => {
  const fixture = await startFixture('allibot-export-mcp-');
  try {
    seedDefaultRows(fixture);
    // A pre-existing declaration: one unrelated entry must survive, and the
    // existing bytes must be backed up before the write.
    mkdirSync(fixture.agentHome, { recursive: true });
    const existing = `${JSON.stringify(
      {
        servers: [
          {
            name: 'other',
            transport: 'stdio',
            enabled: true,
            command: 'node',
            args: ['other.mjs'],
          },
        ],
      },
      null,
      2,
    )}\n`;
    writeFileSync(mcpJson(fixture), existing, { mode: 0o600 });
    // One existing remote consent is copied forward (kept, never invented).
    const db = openDb(fixture.dataDir);
    try {
      db.prepare(
        `INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at)
         VALUES ('mcp', 'remote', ?)`,
      ).run('2026-10-02T00:00:00.000Z');
    } finally {
      db.close();
    }

    const dry = runExport(fixture);
    assert.equal(dry.exitCode, 0, dry.output);
    assert.match(dry.output, /dry-run|预览/);
    assert.match(dry.output, new RegExp(AGENT_ID));
    assert.equal(readFileSync(mcpJson(fixture), 'utf8'), existing, 'dry-run writes nothing');
    assert.equal(readdirSync(fixture.agentHome).some((name) => name.includes('backup')), false);

    const applyOnly = runExport(fixture, ['--apply']);
    assert.notEqual(applyOnly.exitCode, 0, '--apply alone must not write');
    assert.equal(readFileSync(mcpJson(fixture), 'utf8'), existing);

    const yesOnly = runExport(fixture, ['--yes']);
    assert.notEqual(yesOnly.exitCode, 0, '--yes alone must not write');
    assert.equal(readFileSync(mcpJson(fixture), 'utf8'), existing);

    const applied = runExport(fixture, ['--apply', '--yes']);
    assert.equal(applied.exitCode, 0, applied.output);
    const written = readFileSync(mcpJson(fixture), 'utf8');
    const document = JSON.parse(written) as { servers: Record<string, unknown>[] };
    assert.deepEqual(
      document.servers.map((server) => server['name']),
      ['demo', 'other', 'remote'],
      'the legacy Agent entries merge into the existing declaration, channel rows ignored',
    );
    assert.deepEqual(document.servers.find((server) => server['name'] === 'demo'), {
      name: 'demo',
      transport: 'stdio',
      enabled: true,
      command: 'node',
      args: ['demo-server.mjs'],
      env_names: ['MCP_TOKEN'],
    });
    assert.deepEqual(document.servers.find((server) => server['name'] === 'remote'), {
      name: 'remote',
      transport: 'http',
      enabled: true,
      url: 'http://127.0.0.1:7777/mcp',
    });
    assert.equal(statSync(mcpJson(fixture)).mode & 0o777, 0o600);

    const backups = readdirSync(fixture.agentHome).filter((name) =>
      name.startsWith('mcp.json.backup-'),
    );
    assert.equal(backups.length, 1, 'one backup of the pre-existing file');
    assert.equal(
      readFileSync(path.join(fixture.agentHome, backups[0]!), 'utf8'),
      existing,
      'the backup is the exact pre-write file',
    );

    const manifests = readdirSync(fixture.agentHome).filter((name) =>
      name.startsWith('mcp-export-manifest-'),
    );
    assert.equal(manifests.length, 1, 'one manifest');
    const manifest = JSON.parse(
      readFileSync(path.join(fixture.agentHome, manifests[0]!), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal(manifest['agent_id'], AGENT_ID);
    assert.deepEqual(
      (manifest['servers'] as Record<string, unknown>[]).map((server) => server['name']),
      ['demo', 'remote'],
    );
    assert.deepEqual(manifest['consents'], [
      { scope_kind: 'mcp', scope_id: 'remote', confirmed_at: '2026-10-02T00:00:00.000Z' },
    ]);
    assert.equal(typeof manifest['backup_path'], 'string');

    // The command never deletes library rows and never invents a new consent.
    const after = openDb(fixture.dataDir);
    try {
      assert.equal(
        (after.prepare('SELECT count(*) AS total FROM mcp_server').get() as { total: number })
          .total,
        3,
      );
      assert.deepEqual(
        after
          .prepare('SELECT scope_kind, scope_id FROM remote_consent_scope ORDER BY scope_id')
          .all(),
        [{ scope_kind: 'mcp', scope_id: 'remote' }],
        'only the pre-existing consent row exists; no confirmation was made on the owner behalf',
      );
    } finally {
      after.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('export-mcp refuses the whole write when a same-name entry has a different shape', async () => {
  const fixture = await startFixture('allibot-export-mcp-conflict-');
  try {
    seedDefaultRows(fixture);
    mkdirSync(fixture.agentHome, { recursive: true });
    const existing = `${JSON.stringify(
      {
        servers: [
          {
            name: 'demo',
            transport: 'http',
            enabled: true,
            url: 'http://127.0.0.1:9999/other',
          },
        ],
      },
      null,
      2,
    )}\n`;
    writeFileSync(mcpJson(fixture), existing, { mode: 0o600 });

    const result = runExport(fixture, ['--apply', '--yes']);
    assert.notEqual(result.exitCode, 0, 'a same-name different-shape entry refuses the export');
    assert.match(result.output, /demo/);
    assert.equal(readFileSync(mcpJson(fixture), 'utf8'), existing, 'no partial write');
    assert.equal(
      readdirSync(fixture.agentHome).some((name) => name.startsWith('mcp-export-manifest-')),
      false,
      'no manifest for a refused export',
    );

    // An invalid existing file is also refused wholesale.
    writeFileSync(mcpJson(fixture), '{not json', { mode: 0o600 });
    const invalid = runExport(fixture, ['--apply', '--yes']);
    assert.notEqual(invalid.exitCode, 0);
    assert.equal(readFileSync(mcpJson(fixture), 'utf8'), '{not json');
  } finally {
    await fixture.stop();
  }
});

test('migrate-mcp is retired and startup never exports', async () => {
  const fixture = await startFixture('allibot-export-mcp-retired-');
  let running: RunningServer | null = null;
  try {
    seedDefaultRows(fixture);
    const retired = runCli(['migrate-mcp', '--data-dir', fixture.dataDir], {
      env: { HOME: fixture.home },
    });
    assert.notEqual(retired.exitCode, 0, 'the old command is retired');
    assert.equal(existsSync(mcpJson(fixture)), false);

    running = await startServer(fixture.dataDir, {
      env: { HOME: fixture.home },
      args: ['--provider', 'scripted', '--scripted-provider', 'reply'],
    });
    await running.stop();
    running = null;
    assert.equal(
      existsSync(mcpJson(fixture)),
      false,
      'starting the backend never exports or migrates MCP declarations',
    );

    const other = runExport(fixture, ['--apply', '--yes']);
    assert.equal(other.exitCode, 0, other.output);
    assert.equal(existsSync(path.join(fixture.otherHome, 'mcp.json')), false, 'no rows, no file');
  } finally {
    await running?.stop();
    await fixture.stop();
  }
});
