import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { makeTempDir, removeTempDir, runCli } from './support.ts';

const DB_FILENAME = 'allibot.db';

function migrateToBaseline(dataDir: string): void {
  const result = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(result.exitCode, 0, `baseline migrate should exit 0; output: ${result.output}`);
}

function setSchemaVersion(dataDir: string, version: number): void {
  const db = new Database(path.join(dataDir, DB_FILENAME));
  try {
    db.prepare('UPDATE schema_meta SET schema_version = ?').run(version);
  } finally {
    db.close();
  }
}

function databaseSha256(dataDir: string): string {
  return createHash('sha256')
    .update(readFileSync(path.join(dataDir, DB_FILENAME)))
    .digest('hex');
}

test('a database newer than the code is refused by serve and --migrate without touching its bytes', async () => {
  const dataDir = await makeTempDir('allibot-gate-newer-');
  try {
    migrateToBaseline(dataDir);
    setSchemaVersion(dataDir, 8);
    const before = databaseSha256(dataDir);

    const migrate = runCli(['--migrate', '--data-dir', dataDir]);
    assert.notEqual(migrate.exitCode, 0, `--migrate must refuse; output: ${migrate.output}`);
    assert.match(migrate.output, /version_mismatch/);
    assert.equal(databaseSha256(dataDir), before, '--migrate must not change the database file');

    const serve = runCli(['serve', '--data-dir', dataDir, '--port', '0'], { timeoutMs: 5_000 });
    assert.notEqual(serve.exitCode, 0, `serve must refuse; output: ${serve.output}`);
    assert.match(serve.output, /version_mismatch/);
    assert.equal(databaseSha256(dataDir), before, 'serve must not change the database file');
  } finally {
    await removeTempDir(dataDir);
  }
});

test('serve refuses a database older than the code and points at --migrate', async () => {
  const dataDir = await makeTempDir('allibot-gate-older-');
  try {
    migrateToBaseline(dataDir);
    setSchemaVersion(dataDir, 0);
    const before = databaseSha256(dataDir);

    const serve = runCli(['serve', '--data-dir', dataDir, '--port', '0'], { timeoutMs: 5_000 });

    assert.notEqual(serve.exitCode, 0, `serve must refuse; output: ${serve.output}`);
    assert.match(serve.output, /--migrate/);
    assert.equal(databaseSha256(dataDir), before, 'serve must not change the database file');
  } finally {
    await removeTempDir(dataDir);
  }
});
