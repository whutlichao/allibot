import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

interface SettingsFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startSettingsFixture(prefix: string): Promise<SettingsFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir);
  return {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

function queryAll<T>(dataDir: string, sql: string): T[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function readSettings(dataDir: string): Record<string, string> {
  const rows = queryAll<{ key: string; value: string }>(
    dataDir,
    'SELECT key, value FROM setting ORDER BY key',
  );
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

/**
 * Every table except `setting` is business state a settings write must not
 * touch: messages, channels, budgets and round results all live there. Dumping
 * them generically means a later ticket that adds target_budget or
 * round_outcome is covered without rewriting this test.
 */
function businessState(dataDir: string): Record<string, unknown[]> {
  const tables = queryAll<{ name: string }>(
    dataDir,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  ).map((row) => row.name);
  const state: Record<string, unknown[]> = {};
  for (const table of tables) {
    if (table === 'setting') {
      continue;
    }
    state[table] = queryAll<Record<string, unknown>>(dataDir, `SELECT * FROM ${table}`);
  }
  return state;
}

function readLedgerText(dataDir: string): string {
  return readFileSync(path.join(dataDir, 'schema-migrations.jsonl'), 'utf8');
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function getSettings(fixture: SettingsFixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/settings`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function patchSettings(
  fixture: SettingsFixture,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}/api/settings`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

test('GET /api/settings returns the three workspace settings seeded by the migration', async () => {
  const fixture = await startSettingsFixture('allibot-settings-get-');
  try {
    const settings = await getSettings(fixture);

    assert.deepEqual(settings, { locale: 'zh-CN', density: 'comfortable', theme: 'system' });
    // A fresh workspace writes nothing beyond the migration itself.
    assert.equal(
      queryAll<{ total: number }>(fixture.dataDir, 'SELECT count(*) AS total FROM message')[0]
        ?.total,
      0,
    );
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/settings persists density and theme and leaves the other setting alone', async () => {
  const fixture = await startSettingsFixture('allibot-settings-patch-');
  try {
    const patched = await patchSettings(fixture, { density: 'compact', theme: 'dark' });
    assert.equal(patched.status, 200, await patched.clone().text());
    assert.deepEqual(await readJson(patched), {
      locale: 'zh-CN',
      density: 'compact',
      theme: 'dark',
    });

    assert.deepEqual(readSettings(fixture.dataDir), {
      density: 'compact',
      locale: 'zh-CN',
      theme: 'dark',
    });
    assert.deepEqual(await getSettings(fixture), {
      locale: 'zh-CN',
      density: 'compact',
      theme: 'dark',
    });

    const partial = await patchSettings(fixture, { theme: 'light' });
    assert.equal(partial.status, 200, await partial.clone().text());
    assert.deepEqual(await readJson(partial), {
      locale: 'zh-CN',
      density: 'compact',
      theme: 'light',
    });
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/settings accepts only the delivered locale zh-CN', async () => {
  const fixture = await startSettingsFixture('allibot-settings-locale-');
  try {
    const accepted = await patchSettings(fixture, { locale: 'zh-CN' });
    assert.equal(accepted.status, 200, await accepted.clone().text());
    assert.equal((await readJson(accepted))['locale'], 'zh-CN');

    for (const locale of ['en', 'en-US', 'fr', 'zh', '']) {
      const rejected = await patchSettings(fixture, { locale });
      assert.equal(rejected.status, 400, `locale ${locale} must be rejected`);
      const body = await readJson(rejected);
      assert.equal(errorCode(body), 'validation_failed');
      assert.equal(readSettings(fixture.dataDir)['locale'], 'zh-CN', 'a rejected write changes nothing');
    }
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/settings rejects an out-of-enum density or theme and an unknown key', async () => {
  const fixture = await startSettingsFixture('allibot-settings-invalid-');
  try {
    const before = readSettings(fixture.dataDir);

    for (const body of [
      { density: 'cozy' },
      { density: 'COMFORTABLE' },
      { theme: 'sepia' },
      { theme: 'Dark' },
      { workspace_root: '/tmp' },
      { density: 'compact', target_budget_used: 1 },
      { density: 3 },
      { theme: null },
      [],
      'compact',
    ]) {
      const rejected = await patchSettings(fixture, body);
      assert.equal(rejected.status, 400, `body ${JSON.stringify(body)} must be rejected`);
      assert.equal(errorCode(await readJson(rejected)), 'validation_failed');
    }

    assert.deepEqual(readSettings(fixture.dataDir), before, 'rejected writes change no setting');
  } finally {
    await fixture.stop();
  }
});

test('a settings write adds no message, no business row and no audit ledger line', async () => {
  const fixture = await startSettingsFixture('allibot-settings-side-effects-');
  try {
    const beforeState = businessState(fixture.dataDir);
    const beforeLedger = readLedgerText(fixture.dataDir);

    const patched = await patchSettings(fixture, { density: 'compact', theme: 'dark' });
    assert.equal(patched.status, 200, await patched.clone().text());

    assert.deepEqual(
      businessState(fixture.dataDir),
      beforeState,
      'a settings write is not conversation state: no message, budget or round row may change',
    );
    assert.equal(readLedgerText(fixture.dataDir), beforeLedger, 'no migration audit line is written');
    assert.equal(queryAll<{ total: number }>(fixture.dataDir, 'SELECT count(*) AS total FROM setting')[0]?.total, 3);
  } finally {
    await fixture.stop();
  }
});
