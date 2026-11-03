import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { makeTempDir, readLedger, removeTempDir, runCli } from './support.ts';

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

test('migrate initializes an empty data directory at schema version 1 and records an audit entry', async () => {
  const dataDir = await makeTempDir('allibot-migrate-');
  try {
    const result = runCli(['--migrate', '--data-dir', dataDir]);

    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(readSchemaVersion(dataDir), 1);
    assert.equal(existsSync(path.join(dataDir, 'schema-migrations.jsonl')), true);

    const entries = readLedger(dataDir);
    assert.equal(entries.length, 1, 'an empty directory migration writes exactly one ledger line');

    const entry = entries[0];
    assert.ok(entry !== undefined);
    assert.equal(entry['from'], null);
    assert.equal(entry['to'], 1);
    assert.equal(entry['result'], 'ok');
    assert.equal(entry['backup_path'], null);

    const startedAt = Date.parse(String(entry['started_at']));
    const finishedAt = Date.parse(String(entry['finished_at']));
    assert.ok(Number.isFinite(startedAt), 'ledger entry should have a start timestamp');
    assert.ok(Number.isFinite(finishedAt), 'ledger entry should have a finish timestamp');
    assert.ok(startedAt <= finishedAt, 'start timestamp should not be after finish timestamp');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('migrate is idempotent: a second run reports the current version and appends no ledger line', async () => {
  const dataDir = await makeTempDir('allibot-migrate-idempotent-');
  try {
    const first = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(first.exitCode, 0, `first migrate should exit 0; output: ${first.output}`);
    const ledgerAfterFirst = readLedger(dataDir);

    const second = runCli(['--migrate', '--data-dir', dataDir]);

    assert.equal(second.exitCode, 0, `second migrate should exit 0; output: ${second.output}`);
    assert.match(second.output, /already at schema version 1/);
    assert.equal(readSchemaVersion(dataDir), 1);
    assert.deepEqual(
      readLedger(dataDir),
      ledgerAfterFirst,
      'an idempotent migrate must not append an audit record',
    );
  } finally {
    await removeTempDir(dataDir);
  }
});
