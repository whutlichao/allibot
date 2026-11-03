import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, readdirSync } from 'node:fs';
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
 * Schema 步骤 15 (#38 / T14): `team_run` and `team_assignment` are the team
 * run records. They are observed from the data directory the CLI wrote — the
 * rebuilt shapes, the CHECKs, the consistency triggers, the sibling backup and
 * the audit ledger — never from a private function.
 *
 * The v14 fixture is the previous ticket's shape, so the strict +1 step is the
 * real v14 -> v15 migration the product runs.
 */

const SEEDED_AT = '2026-10-01T08:00:00.000Z';
const CHANNEL_ID = 'channel-team';
const AGENT_ID = 'agent-leader';
const OTHER_CHANNEL_ID = 'channel-autonomous';
const OTHER_AGENT_ID = 'agent-other';
const TASK_ID = 'task-one';
const TASK_TARGET_ID = 'target-task-one';
const OTHER_TASK_ID = 'task-two';
const OTHER_TASK_TARGET_ID = 'target-task-two';

function openReadOnly(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
}

function openWritable(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  return db;
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

function indexNames(dataDir: string, table: string): string[] {
  const db = openReadOnly(dataDir);
  try {
    return (db.pragma(`index_list(${table})`) as { name: string }[]).map((row) => row.name);
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

function count(db: Database.Database, sql: string, params: unknown[] = []): number {
  return (db.prepare(sql).get(...(params as never[])) as { total: number }).total;
}

/** Build the v14 database with two channels, two tasks and their targets. */
function seedV14(dataDir: string): void {
  const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v14', dataDir], {
    encoding: 'utf8',
  });
  assert.equal(
    fixture.status,
    0,
    `the v14 fixture should build the v14 baseline; output: ${fixture.stdout}${fixture.stderr}`,
  );

  const db = new Database(path.join(dataDir, 'allibot.db'));
  try {
    const insertMember = db.prepare(
      `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
       VALUES (?, 'agent', ?, 1, NULL, ?)`,
    );
    insertMember.run(AGENT_ID, '队长', SEEDED_AT);
    insertMember.run(OTHER_AGENT_ID, '成员', SEEDED_AT);
    const insertConfig = db.prepare(
      `INSERT INTO agent_config (member_id, role, model, system_prompt, enabled, context_window,
         compression_threshold, max_iterations, auto_claim)
       VALUES (?, '', 'openai:gpt-5', '', 1, 10000, 0.8, 8, 0)`,
    );
    insertConfig.run(AGENT_ID);
    insertConfig.run(OTHER_AGENT_ID);

    const insertChannel = db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, team_leader_member_id, response_budget_limit,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, '', ?, ?, 5, NULL, NULL, ?, ?)`,
    );
    insertChannel.run(CHANNEL_ID, 'team 频道', 'team', AGENT_ID, SEEDED_AT, SEEDED_AT);
    insertChannel.run(OTHER_CHANNEL_ID, '自主频道', 'autonomous', null, SEEDED_AT, SEEDED_AT);

    const insertTarget = db.prepare('INSERT INTO target (id, kind) VALUES (?, ?)');
    insertTarget.run(CHANNEL_ID, 'channel');
    insertTarget.run(OTHER_CHANNEL_ID, 'channel');
    insertTarget.run(TASK_TARGET_ID, 'task');
    insertTarget.run(OTHER_TASK_TARGET_ID, 'task');

    const insertTask = db.prepare(
      `INSERT INTO task
         (id, channel_id, target_id, title, status, assignee_member_id, claimed_at, created_at,
          updated_at)
       VALUES (?, ?, ?, ?, 'todo', NULL, NULL, ?, ?)`,
    );
    insertTask.run(TASK_ID, CHANNEL_ID, TASK_TARGET_ID, '任务一', SEEDED_AT, SEEDED_AT);
    insertTask.run(
      OTHER_TASK_ID,
      OTHER_CHANNEL_ID,
      OTHER_TASK_TARGET_ID,
      '任务二',
      SEEDED_AT,
      SEEDED_AT,
    );
  } finally {
    db.close();
  }
}

interface RunInput {
  id: string;
  targetId?: string;
  channelId?: string;
  taskId?: string | null;
  leaderId?: string;
  status?: string;
  reason?: string | null;
  startedAt?: string;
  finishedAt?: string | null;
}

function insertRun(db: Database.Database, input: RunInput): void {
  db.prepare(
    `INSERT INTO team_run
       (id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at,
        finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.id,
    input.targetId ?? CHANNEL_ID,
    input.channelId ?? CHANNEL_ID,
    input.taskId ?? null,
    input.leaderId ?? AGENT_ID,
    input.status ?? 'running',
    input.reason ?? null,
    input.startedAt ?? SEEDED_AT,
    input.finishedAt === undefined ? null : input.finishedAt,
  );
}

test('a v14 data directory migrates to v15 with a whole-directory backup and one ledger line', async () => {
  const parent = await makeTempDir('allibot-team-runs-migrate-');
  const dataDir = path.join(parent, 'data');
  const snapshot = path.join(parent, 'snapshot');
  try {
    seedV14(dataDir);
    assert.equal(readSchemaVersion(dataDir), 14, 'the fixture builds the v14 baseline');
    cpSync(dataDir, snapshot, { recursive: true });

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);
    assert.equal(readSchemaVersion(dataDir), 15, 'the strict +1 step lands at version 15');

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
    assert.equal(last['from'], 14);
    assert.equal(last['to'], 15);
    assert.equal(last['result'], 'ok');
    assert.equal(last['backup_path'], backupPath);
    const startedAt = Date.parse(String(last['started_at']));
    const finishedAt = Date.parse(String(last['finished_at']));
    assert.ok(Number.isFinite(startedAt), 'the audit record has a start timestamp');
    assert.ok(Number.isFinite(finishedAt), 'the audit record has a finish timestamp');
    assert.ok(startedAt <= finishedAt);

    assert.deepEqual(foreignKeyViolations(dataDir), [], 'the migration leaves no dangling reference');

    const db = openReadOnly(dataDir);
    try {
      assert.equal(count(db, 'SELECT count(*) AS total FROM channel'), 2);
      assert.equal(count(db, 'SELECT count(*) AS total FROM task'), 2);
      assert.equal(
        (db.prepare('SELECT mode FROM channel WHERE id = ?').get(CHANNEL_ID) as { mode: string })
          .mode,
        'team',
        'the v14 channel rows survive verbatim',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});

test('v15 creates team_run and team_assignment with their status CHECKs and indexes', async () => {
  const parent = await makeTempDir('allibot-team-runs-shape-');
  const dataDir = path.join(parent, 'data');
  try {
    seedV14(dataDir);
    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    const runSql = tableSql(dataDir, 'team_run');
    assert.ok(runSql !== undefined, 'team_run exists');
    assert.match(runSql, /status IN \('running', 'completed', 'failed', 'invalid-leader'\)/);
    assert.match(
      runSql,
      /status = 'running' AND finished_at IS NULL/,
      `running is bound to a NULL finish time: ${runSql}`,
    );
    assert.match(
      runSql,
      /status <> 'running' AND finished_at IS NOT NULL/,
      `the closed statuses are bound to a finish time: ${runSql}`,
    );

    const assignmentSql = tableSql(dataDir, 'team_assignment');
    assert.ok(assignmentSql !== undefined, 'team_assignment exists');
    assert.match(assignmentSql, /state IN \('running', 'completed', 'failed', 'budget-exhausted'\)/);
    assert.match(assignmentSql, /jump_consumed IN \(0, 1\)/);
    assert.match(
      assignmentSql,
      /state <> 'budget-exhausted' OR jump_consumed = 0/,
      `budget-exhausted is bound to jump_consumed=0: ${assignmentSql}`,
    );

    assert.deepEqual(
      triggerNames(dataDir, 'team_run'),
      [
        'team_run_closed_immutable',
        'team_run_target_consistency_insert',
        'team_run_target_consistency_update',
      ],
      'the run carries the target/task consistency trigger and the one-close guard',
    );
    assert.deepEqual(
      triggerNames(dataDir, 'team_assignment'),
      [
        'team_assignment_closed_immutable',
        'team_assignment_matches_run_insert',
        'team_assignment_matches_run_update',
      ],
      'the assignment carries the parent-consistency trigger and the one-close guard',
    );

    assert.ok(
      indexNames(dataDir, 'team_run').some((name) => name.startsWith('team_run_target')),
      'the snapshot read by target has an index',
    );
    assert.ok(
      indexNames(dataDir, 'team_assignment').some((name) => name.startsWith('team_assignment_run')),
      'the nested assignment read by run has an index',
    );
  } finally {
    await removeTempDir(parent);
  }
});

test('the v15 CHECKs and triggers refuse inconsistent team records', async () => {
  const parent = await makeTempDir('allibot-team-runs-guards-');
  const dataDir = path.join(parent, 'data');
  try {
    seedV14(dataDir);
    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, `migrate should exit 0; output: ${migrated.output}`);

    const db = openWritable(dataDir);
    try {
      insertRun(db, { id: 'run-channel', status: 'completed', finishedAt: SEEDED_AT });
      insertRun(db, {
        id: 'run-task',
        targetId: TASK_TARGET_ID,
        taskId: TASK_ID,
        status: 'completed',
        finishedAt: SEEDED_AT,
      });

      assert.throws(
        () => insertRun(db, { id: 'run-running-closed', status: 'running', finishedAt: SEEDED_AT }),
        /CHECK constraint failed/,
        'a running run cannot carry a finish time',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-completed-open', status: 'completed', finishedAt: null }),
        /CHECK constraint failed/,
        'a completed run must carry a finish time',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-channel-task', taskId: TASK_ID }),
        /target\/task do not match/,
        'a channel-type run is task-free',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-channel-other', targetId: OTHER_CHANNEL_ID }),
        /target\/task do not match/,
        'a channel-type run points at its own channel target',
      );
      assert.throws(
        () => insertRun(db, { id: 'run-task-wrong-task', targetId: TASK_TARGET_ID, taskId: OTHER_TASK_ID }),
        /target\/task do not match/,
        'a task-type run names the task its target owns',
      );
      assert.throws(
        () =>
          insertRun(db, {
            id: 'run-task-other-channel',
            targetId: TASK_TARGET_ID,
            taskId: TASK_ID,
            channelId: OTHER_CHANNEL_ID,
          }),
        /target\/task do not match/,
        'a task-type run names the task channel',
      );

      const insertAssignment = db.prepare(
        `INSERT INTO team_assignment
           (id, team_run_id, target_id, task_id, member_id, state, jump_consumed, reply_excerpt,
            reason, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
      );
      insertAssignment.run(
        'assignment-running',
        'run-channel',
        CHANNEL_ID,
        null,
        OTHER_AGENT_ID,
        'running',
        1,
        SEEDED_AT,
        null,
      );

      assert.throws(
        () =>
          insertAssignment.run(
            'assignment-task-mismatch',
            'run-channel',
            TASK_TARGET_ID,
            TASK_ID,
            OTHER_AGENT_ID,
            'completed',
            1,
            SEEDED_AT,
            SEEDED_AT,
          ),
        /does not match its run/,
        'an assignment inherits its run target / task',
      );
      assert.throws(
        () =>
          insertAssignment.run(
            'assignment-exhausted-charged',
            'run-task',
            TASK_TARGET_ID,
            TASK_ID,
            OTHER_AGENT_ID,
            'budget-exhausted',
            1,
            SEEDED_AT,
            SEEDED_AT,
          ),
        /CHECK constraint failed/,
        'budget-exhausted consumes no jump',
      );
      assert.throws(
        () => db.prepare('UPDATE team_assignment SET jump_consumed = 0 WHERE id = ?').run('assignment-running'),
        /closed or changes an immutable field/,
        'jump_consumed is frozen at insert',
      );
      assert.throws(
        () =>
          db
            .prepare('UPDATE team_assignment SET started_at = ? WHERE id = ?')
            .run('2026-10-02T08:00:00.000Z', 'assignment-running'),
        /closed or changes an immutable field/,
        'started_at is frozen at insert',
      );
      assert.throws(
        () =>
          db
            .prepare("UPDATE team_run SET status = 'failed' WHERE id = 'run-channel'")
            .run(),
        /already closed/,
        'a run closes exactly once',
      );
      assert.throws(
        () =>
          db
            .prepare('UPDATE team_run SET started_at = ? WHERE id = ?')
            .run('2026-10-02T08:00:00.000Z', 'run-channel'),
        /already closed/,
        'a closed run keeps its start time',
      );
      assert.equal(
        count(db, "SELECT count(*) AS total FROM team_run WHERE status = 'completed'"),
        2,
        'the valid records are stored',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});
