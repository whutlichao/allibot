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
    assert.match(result.output, /找不到数据库/, 'the refusal copy renders in zh-CN');
    assert.doesNotMatch(result.output, /database not found at/);
  } finally {
    await removeTempDir(dataDir);
  }
});

test('serve defaults to the real model adapter; the scripted double needs an explicit injection', async () => {
  const dataDir = await makeTempDir('allibot-serve-provider-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const production = await startServer(dataDir, { useProductionProvider: true });
    try {
      assert.match(
        production.logs().stdout,
        /allibot 成员面适配器：model/,
        'a serve without provider arguments runs the real adapter',
      );
      assert.doesNotMatch(production.logs().stdout, /scripted/);
    } finally {
      await production.stop();
    }

    const scripted = await startServer(dataDir, { args: ['--scripted-provider', 'reply'] });
    try {
      assert.match(
        scripted.logs().stdout,
        /allibot 成员面适配器：scripted:reply/,
        'a --scripted-* option is an explicit test injection',
      );
    } finally {
      await scripted.stop();
    }
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
