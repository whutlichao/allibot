import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

test('serve refuses to start when the database is missing and points at --migrate', async () => {
  const dataDir = await makeTempDir('allibot-serve-missing-');
  try {
    const result = runCli(['serve', '--data-dir', dataDir]);

    assert.notEqual(result.exitCode, 0, `serve without a database must fail; output: ${result.output}`);
    assert.match(result.output, /--migrate/);
  } finally {
    await removeTempDir(dataDir);
  }
});

test('a second serve on the same data directory is rejected until the first exits', async () => {
  const dataDir = await makeTempDir('allibot-lock-');
  let first: RunningServer | undefined;
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    first = await startServer(dataDir);

    const second = runCli(['serve', '--data-dir', dataDir, '--port', '0'], {
      timeoutMs: 5_000,
    });
    assert.notEqual(
      second.exitCode,
      0,
      `a second writer must be rejected; output: ${second.output}`,
    );
    assert.match(second.output, /data directory is already in use/);

    await first.stop();
    first = undefined;

    const restarted = await startServer(dataDir);
    await restarted.stop();
  } finally {
    await first?.stop();
    await removeTempDir(dataDir);
  }
});

test('a crashed server leaves no stale lock that blocks the next start', async () => {
  const dataDir = await makeTempDir('allibot-lock-stale-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const crashed = await startServer(dataDir);
    await crashed.crash();

    const restarted = await startServer(dataDir);
    await restarted.stop();
  } finally {
    await removeTempDir(dataDir);
  }
});
