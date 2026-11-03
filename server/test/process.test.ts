import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { test } from 'node:test';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

test('unknown API path returns the unified not_found error envelope', async () => {
  const dataDir = await makeTempDir('allibot-server-test-');
  let running: RunningServer | undefined;

  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    running = await startServer(dataDir);
    assert.equal(existsSync(dataDir), true, 'the server data dir should exist while running');

    const response = await fetch(`http://127.0.0.1:${running.port}/api/__unknown__`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);

    const body: unknown = await response.json();
    assert.ok(isRecord(body), 'response body should be a JSON object');
    assert.deepEqual(Object.keys(body), ['error']);
    assert.ok(isRecord(body.error), 'response body should contain an error object');
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
    assert.equal(body.error.code, 'not_found');
    assert.ok(
      typeof body.error.message === 'string' && body.error.message.length > 0,
      'error message should be a non-empty string',
    );
  } finally {
    await running?.stop();
    await removeTempDir(dataDir);
  }

  assert.equal(existsSync(dataDir), false, 'the temporary data dir should be removed');
});
