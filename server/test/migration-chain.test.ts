import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
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

test('a 1->2 fixture migration backs up the whole data directory and records the audit trail', async () => {
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

    assert.equal(readSchemaVersion(dataDir), 2);

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 2, 'the baseline line and the 1->2 line are both kept');
    const last = entries[1];
    assert.ok(last !== undefined);
    assert.equal(last['from'], 1);
    assert.equal(last['to'], 2);
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
      assert.equal(row.schema_version, 1);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(parent);
  }
});

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
