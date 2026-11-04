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
  runCli,
} from './support.ts';

/**
 * Schema 步骤 19 / 20 (#44 / T18): the three permission modes with the channel
 * default and the Agent override (v19), the permission rules (v19) and the
 * approval request (v20). Everything is observed from the data directory the
 * CLI wrote — the strict +1 chain, the columns / defaults / CHECKs, the UNIQUE
 * and scope triggers, the approval lifecycle binding, the sibling backup, the
 * audit ledger and the empty database path — never from a private function.
 *
 * The v18 fixture is #42's delivered shape, so this is the real v18 -> 20
 * migration the product runs (one chain, two strict steps).
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const CHANNEL_ID = 'channel-permissions';
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

function indexNames(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (db.pragma(`index_list(${table})`) as { name: string }[]).map((row) => row.name);
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

function triggerNames(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
        )
        .all(table) as { name: string }[]
    ).map((row) => row.name);
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

/** Build the v18 baseline and seed the rows that must survive the steps. */
function seedV18(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v18', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v18 fixture should build the v18 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    db.prepare(
      `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
       VALUES (?, 'agent', '权限成员', 1, NULL, ?)`,
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
       VALUES (?, '权限频道', '', 'autonomous', NULL, 3, NULL, NULL, ?, ?)`,
    ).run(CHANNEL_ID, SEEDED_AT, SEEDED_AT);
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(CHANNEL_ID);
  } finally {
    db.close();
  }
}

test('a v18 data directory migrates to 21 with modes, rules and approvals; rows and backup survive', async () => {
  const tmp = await makeTempDir('allibot-migration-permissions-');
  const dataDir = path.join(tmp, 'data');
  const snapshot = path.join(tmp, 'snapshot');
  try {
    seedV18(dataDir);
    // Snapshot the whole directory after seeding: the backup must equal it.
    cpSync(dataDir, snapshot, { recursive: true });

    const result = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(readSchemaVersion(dataDir), 21);

    // One sibling backup, byte-identical to the pre-migration snapshot.
    const backups = readdirSync(tmp).filter((entry) => entry.startsWith('data.backup-'));
    assert.equal(backups.length, 1, `one sibling backup; found ${JSON.stringify(backups)}`);
    const backupDir = path.join(tmp, backups[0]!);
    assert.equal(existsSync(path.join(backupDir, 'allibot.db')), true);
    const diff = spawnSync('diff', ['-r', snapshot, backupDir], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `the backup equals the pre-migration snapshot: ${diff.stdout}`);

    // One ledger line for this run, from the fixture baseline all the way to
    // 21 (the fixture's own baseline build recorded its from-null line first).
    const ledger = readLedger(dataDir);
    const lines = ledger.filter((line) => line['to'] === 21);
    assert.equal(lines.length, 1, `one from=18/to=21 line; ledger: ${JSON.stringify(ledger)}`);
    assert.equal(lines[0]!['from'], 18);
    assert.equal(lines[0]!['result'], 'ok');
    assert.equal(typeof lines[0]!['backup_path'], 'string');
    assert.equal(foreignKeyViolations(dataDir).length, 0);

    // Step 19: channel / agent_config modes and the rules table.
    const channelColumns = columns(dataDir, 'channel');
    const channelMode = channelColumns.find((column) => column.name === 'permission_mode');
    assert.ok(channelMode, 'channel.permission_mode exists');
    assert.equal(channelMode.notnull, 1);
    assert.equal(channelMode.dflt_value, "'ask-writes'");
    const agentMode = columns(dataDir, 'agent_config').find(
      (column) => column.name === 'permission_mode',
    );
    assert.ok(agentMode, 'agent_config.permission_mode exists');
    assert.equal(agentMode.notnull, 0);
    assert.equal(agentMode.dflt_value, null);

    const rulesSql = tableSql(dataDir, 'permission_rule');
    assert.ok(rulesSql !== undefined, 'permission_rule exists');
    for (const column of [
      'id',
      'scope_kind',
      'scope_id',
      'tool_name',
      'pattern',
      'behavior',
      'created_at',
      'updated_at',
    ]) {
      assert.ok(
        columns(dataDir, 'permission_rule').some((row) => row.name === column),
        `permission_rule.${column}`,
      );
    }
    assert.match(rulesSql!, /UNIQUE\s*\(scope_kind, scope_id, tool_name, pattern\)/);
    assert.ok(triggerNames(dataDir, 'permission_rule').length >= 1, 'scope triggers exist');

    // Step 20: the approval request table and both indexes.
    const approvalSql = tableSql(dataDir, 'approval_request');
    assert.ok(approvalSql !== undefined, 'approval_request exists');
    for (const column of [
      'reply_id',
      'target_id',
      'context_kind',
      'context_id',
      'tool_calls',
      'decisions',
      'status',
      'requested_at',
      'resolved_at',
    ]) {
      assert.ok(
        columns(dataDir, 'approval_request').some((row) => row.name === column),
        `approval_request.${column}`,
      );
    }
    const indexes = indexNames(dataDir, 'approval_request');
    assert.ok(indexes.length >= 2, `two approval indexes; found ${JSON.stringify(indexes)}`);

    // Existing rows kept their identity and got the defaults.
    const db = new Database(path.join(dataDir, 'allibot.db'));
    try {
      const channel = db
        .prepare('SELECT name, permission_mode, workspace_backend FROM channel WHERE id = ?')
        .get(CHANNEL_ID) as Record<string, unknown>;
      assert.deepEqual(channel, {
        name: '权限频道',
        permission_mode: 'ask-writes',
        workspace_backend: 'local',
      });
      const agent = db
        .prepare('SELECT permission_mode, workspace_backend FROM agent_config WHERE member_id = ?')
        .get(AGENT_ID) as Record<string, unknown>;
      assert.deepEqual(agent, { permission_mode: null, workspace_backend: null });

      // The three modes are the only accepted values, at both scopes.
      assert.throws(
        () => db.prepare("UPDATE channel SET permission_mode = 'BYPASS' WHERE id = ?").run(CHANNEL_ID),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE agent_config SET permission_mode = 'DONT_ASK' WHERE member_id = ?")
            .run(AGENT_ID),
        /CHECK constraint failed/i,
      );
      db.prepare("UPDATE channel SET permission_mode = 'read-only' WHERE id = ?").run(CHANNEL_ID);
      db.prepare("UPDATE agent_config SET permission_mode = 'trusted-writes' WHERE member_id = ?")
        .run(AGENT_ID);
      db.prepare("UPDATE channel SET permission_mode = 'ask-writes' WHERE id = ?").run(CHANNEL_ID);
      db.prepare('UPDATE agent_config SET permission_mode = NULL WHERE member_id = ?').run(AGENT_ID);

      // UNIQUE(scope_kind, scope_id, tool_name, pattern).
      const insertRule = db.prepare(
        `INSERT INTO permission_rule
           (id, scope_kind, scope_id, tool_name, pattern, behavior, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertRule.run('rule-1', 'channel', CHANNEL_ID, 'Write', 'src/**', 'ask', SEEDED_AT, SEEDED_AT);
      insertRule.run('rule-2', 'agent', AGENT_ID, 'Bash', '', 'deny', SEEDED_AT, SEEDED_AT);
      assert.throws(
        () =>
          insertRule.run(
            'rule-3',
            'channel',
            CHANNEL_ID,
            'Write',
            'src/**',
            'allow',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /UNIQUE constraint failed/i,
      );
      assert.throws(
        () =>
          insertRule.run(
            'rule-4',
            'channel',
            CHANNEL_ID,
            'Read',
            '',
            'maybe',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      // The scope-existence triggers: a real channel / agent passes, a
      // mismatched or unknown scope aborts.
      assert.throws(
        () =>
          insertRule.run(
            'rule-5',
            'channel',
            AGENT_ID,
            'Read',
            '',
            'allow',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /scope/i,
      );
      assert.throws(
        () =>
          insertRule.run(
            'rule-6',
            'agent',
            'missing-member',
            'Read',
            '',
            'allow',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /scope/i,
      );

      // approval_request: the pending/resolved binding, the sop target rule,
      // the JSON shape and the default decisions.
      const insertApproval = db.prepare(
        `INSERT INTO approval_request
           (reply_id, target_id, context_kind, context_id, tool_calls, status,
            requested_at, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      insertApproval.run(
        'reply-1',
        CHANNEL_ID,
        'round',
        null,
        '[{"tool_call_id":"call-1"}]',
        'pending',
        SEEDED_AT,
        null,
      );
      const row = db
        .prepare('SELECT decisions, resolved_at FROM approval_request WHERE reply_id = ?')
        .get('reply-1') as Record<string, unknown>;
      assert.deepEqual(row, { decisions: '[]', resolved_at: null });
      db.prepare("UPDATE approval_request SET status = 'confirmed', resolved_at = ? WHERE reply_id = ?")
        .run(SEEDED_AT, 'reply-1');

      assert.throws(
        () =>
          insertApproval.run(
            'reply-2',
            CHANNEL_ID,
            'round',
            null,
            '[]',
            'pending',
            SEEDED_AT,
            SEEDED_AT,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertApproval.run(
            'reply-3',
            CHANNEL_ID,
            'round',
            null,
            '[]',
            'confirmed',
            SEEDED_AT,
            null,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertApproval.run(
            'reply-4',
            CHANNEL_ID,
            'sop',
            'sop-run',
            '[]',
            'pending',
            SEEDED_AT,
            null,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertApproval.run(
            'reply-5',
            null,
            'team-assignment',
            'assignment',
            '[]',
            'pending',
            SEEDED_AT,
            null,
          ),
        /CHECK constraint failed/i,
      );
      assert.throws(
        () =>
          insertApproval.run(
            'reply-6',
            CHANNEL_ID,
            'round',
            null,
            '{}',
            'pending',
            SEEDED_AT,
            null,
          ),
        /CHECK constraint failed/i,
      );
      // A SOP approval carries no target; a team-assignment one does.
      insertApproval.run('reply-7', null, 'sop', 'sop-run', '[]', 'pending', SEEDED_AT, null);
      insertApproval.run(
        'reply-8',
        CHANNEL_ID,
        'team-assignment',
        'assignment-1',
        '[]',
        'pending',
        SEEDED_AT,
        null,
      );
    } finally {
      db.close();
    }
    assert.equal(foreignKeyViolations(dataDir).length, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('an empty data directory migrates straight to 21 with no backup', async () => {
  const tmp = await makeTempDir('allibot-migration-permissions-empty-');
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
