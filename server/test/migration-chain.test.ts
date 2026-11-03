import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
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

test('a fixture migration appended to the chain tail backs up the whole data directory and records the audit trail', async () => {
  const parent = await makeTempDir('allibot-chain-');
  const dataDir = path.join(parent, 'data');
  const snapshot = path.join(parent, 'snapshot');
  const restored = path.join(parent, 'restored');

  try {
    const baseline = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(baseline.exitCode, 0, `baseline migrate should exit 0; output: ${baseline.output}`);

    writeFileSync(path.join(dataDir, 'sentinel.txt'), 'keep me\n', 'utf8');
    mkdirSync(path.join(dataDir, 'attachments'));
    writeFileSync(path.join(dataDir, 'attachments', 'note.txt'), 'attachment bytes\n', 'utf8');
    cpSync(dataDir, snapshot, { recursive: true });

    const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'ok', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(fixture.status, 0, `fixture migration should succeed; output: ${fixture.stdout}${fixture.stderr}`);

    const backups = readdirSync(parent).filter((name) => name.startsWith('data.backup-'));
    assert.equal(backups.length, 1, `expected exactly one backup directory, saw: ${backups.join(', ')}`);
    const backupName = backups[0] ?? '';
    assert.match(backupName, /^data\.backup-\d{4}-\d{2}-\d{2}T/);
    const backupPath = path.join(parent, backupName);

    const diff = spawnSync('diff', ['-r', backupPath, snapshot], { encoding: 'utf8' });
    assert.equal(diff.status, 0, `backup must match the pre-migration data dir; diff: ${diff.stdout}`);
    assert.equal(diff.stdout, '');

    assert.equal(readSchemaVersion(dataDir), 5);

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 2, 'the baseline line and the fixture line are both kept');
    const last = entries[1];
    assert.ok(last !== undefined);
    assert.equal(last['from'], 4);
    assert.equal(last['to'], 5);
    assert.equal(last['result'], 'ok');
    assert.equal(last['backup_path'], backupPath);
    const startedAt = Date.parse(String(last['started_at']));
    const finishedAt = Date.parse(String(last['finished_at']));
    assert.ok(Number.isFinite(startedAt), 'the audit record should have a start timestamp');
    assert.ok(Number.isFinite(finishedAt), 'the audit record should have a finish timestamp');
    assert.ok(startedAt <= finishedAt);

    cpSync(backupPath, restored, { recursive: true });
    const db = new Database(path.join(restored, 'allibot.db'), { readonly: true });
    try {
      assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
      const row = db.prepare('SELECT schema_version FROM schema_meta').get() as {
        schema_version: number;
      };
      assert.equal(row.schema_version, 4);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});

test('a failing migration step rolls the database back and records the failure', async () => {
  const parent = await makeTempDir('allibot-chain-fail-');
  const dataDir = path.join(parent, 'data');

  try {
    const baseline = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(baseline.exitCode, 0, `baseline migrate should exit 0; output: ${baseline.output}`);
    const before = readDatabaseShape(dataDir);

    const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'fail', dataDir], {
      encoding: 'utf8',
    });

    assert.notEqual(
      fixture.status,
      0,
      `a failing step must exit non-zero; output: ${fixture.stdout}${fixture.stderr}`,
    );
    assert.deepEqual(readDatabaseShape(dataDir), before, 'the database must roll back completely');
    assert.equal(
      readDatabaseShape(dataDir).tables.includes('fixture_business'),
      false,
      'the failed step must not leave its table behind',
    );

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.ok(last !== undefined);
    assert.equal(last['result'], 'failed');
    assert.equal(last['from'], 4);
    assert.equal(last['to'], 5);
    assert.match(String(last['reason']), /injected migration step failure/);

    const backups = readdirSync(parent).filter((name) => name.startsWith('data.backup-'));
    assert.equal(backups.length, 1, 'the pre-migration backup stays in place after a failure');
    assert.equal(last['backup_path'], path.join(parent, backups[0] ?? ''));
  } finally {
    await removeTempDir(parent);
  }
});

test('backup failure aborts the migration before any schema step runs', async () => {
  const parent = await makeTempDir('allibot-chain-unwritable-');
  const dataDir = path.join(parent, 'data');

  try {
    const baseline = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(baseline.exitCode, 0, `baseline migrate should exit 0; output: ${baseline.output}`);
    const before = readDatabaseShape(dataDir);

    chmodSync(parent, 0o555);
    try {
      const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'ok', dataDir], {
        encoding: 'utf8',
      });

      assert.notEqual(
        fixture.status,
        0,
        `backup failure must exit non-zero; output: ${fixture.stdout}${fixture.stderr}`,
      );
    } finally {
      chmodSync(parent, 0o755);
    }

    assert.deepEqual(readDatabaseShape(dataDir), before, 'the database must be untouched');
    assert.equal(
      readDatabaseShape(dataDir).tables.includes('fixture_business'),
      false,
      'no business table may appear when the backup fails',
    );

    const entries = readLedger(dataDir);
    const last = entries[entries.length - 1];
    assert.ok(last !== undefined);
    assert.equal(last['result'], 'failed');
    assert.equal(last['from'], 4);
    assert.equal(last['to'], 5);
    assert.equal(last['backup_path'], null);
    assert.ok(
      typeof last['reason'] === 'string' && last['reason'].length > 0,
      'the failed audit record carries a readable reason',
    );
  } finally {
    await removeTempDir(parent);
  }
});

function readDatabaseShape(dataDir: string): { version: unknown; tables: string[] } {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
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
    return { version, tables };
  } finally {
    db.close();
  }
}

function readSchemaVersion(dataDir: string): unknown {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db
      .prepare('SELECT schema_version FROM schema_meta')
      .get() as { schema_version: unknown } | undefined;
    return row?.schema_version;
  } finally {
    db.close();
  }
}
