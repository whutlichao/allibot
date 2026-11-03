import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

const LEDGER_PATH = '/schema-migrations.jsonl';

test('the audit ledger has no HTTP write path', async () => {
  const dataDir = await makeTempDir('allibot-audit-http-');
  let running: RunningServer | undefined;

  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
    const ledgerFile = path.join(dataDir, 'schema-migrations.jsonl');
    const before = readFileSync(ledgerFile);

    running = await startServer(dataDir);

    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const response = await fetch(`http://127.0.0.1:${running.port}${LEDGER_PATH}`, {
        method,
        body: method === 'DELETE' ? undefined : '{"result":"ok"}',
      });
      assert.ok(
        response.status === 404 || response.status === 405,
        `${method} ${LEDGER_PATH} should be rejected with 404 or 405, got ${response.status}`,
      );
    }

    assert.deepEqual(
      readFileSync(ledgerFile),
      before,
      'HTTP requests must not be able to write the audit ledger',
    );
  } finally {
    await running?.stop();
    await removeTempDir(dataDir);
  }
});
