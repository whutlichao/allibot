import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  resolveWebSearch,
  type WebSearchMcpFace,
  type WebSearchResolution,
} from '../dist/web-providers.js';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 联网 provider 凭据 (#69 / T3 of M3): the two write faces
 * (`PUT /api/web-providers/{provider}/credential`, `POST
 * /api/web-providers/{provider}/consent`), the masked readout on
 * `GET /api/remote-data-flow`, and the one resolution order T4 will use.
 *
 * The seam is the backend HTTP face: a real server process on a temporary data
 * directory, with the stored rows cross-read from SQLite only to prove what a
 * write landed (and that a rejected write landed nothing). The one pure
 * resolution function is exercised through its exported seam because this
 * ticket has no endpoint that reads it — the round face is T4's.
 */

interface WebProviderFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

/**
 * Every 联网 variable this ticket reads, blanked: the developer's own shell
 * must not be able to point an automation run at a real provider.
 */
const NO_WEB_ENV: NodeJS.ProcessEnv = {
  allibot_WEB_SEARCH_PROVIDER: '',
  allibot_WEB_BRAVE_API_KEY: '',
  allibot_WEB_TAVILY_API_KEY: '',
  allibot_WEB_PERPLEXITY_API_KEY: '',
  allibot_WEB_JINA_API_KEY: '',
  allibot_WEB_EXA_API_KEY: '',
  allibot_WEB_BRAVE_BASE_URL: '',
  allibot_WEB_TAVILY_BASE_URL: '',
  allibot_WEB_PERPLEXITY_BASE_URL: '',
  allibot_WEB_JINA_BASE_URL: '',
  allibot_WEB_EXA_BASE_URL: '',
};

/**
 * The sentinel credential. Its middle run is unique in the fixture, so a leak
 * check can look for any fragment that is not part of the masked form —
 * `assertNoSecret` could not otherwise tell a leak from the mask itself.
 */
const SENTINEL_KEY = 'sk-test-0123456789abcdefghij-9876wxyz';
const SENTINEL_MIDDLE = '0123456789abcdefghij';
const SENTINEL_MASK = 'sk-…wxyz';

async function startWebProviderFixture(
  prefix: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<WebProviderFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, { env: { ...NO_WEB_ENV, ...options.env } });
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

async function putJson(
  fixture: WebProviderFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postJson(
  fixture: WebProviderFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function queryDatabase<T>(
  dataDir: string,
  sql: string,
  params: unknown[] = [],
): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

function queryAll<T>(dataDir: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

function consentRows(fixture: WebProviderFixture): {
  scope_kind: string;
  scope_id: string;
  confirmed_at: string;
}[] {
  return queryAll(
    fixture.dataDir,
    'SELECT scope_kind, scope_id, confirmed_at FROM remote_consent_scope ORDER BY scope_id',
  );
}

function credentialRows(fixture: WebProviderFixture): {
  provider: string;
  is_default: number;
}[] {
  return queryAll(
    fixture.dataDir,
    'SELECT provider, is_default FROM web_provider_credential ORDER BY provider',
  );
}

async function readRemoteDataFlow(
  fixture: WebProviderFixture,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/remote-data-flow`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

function webProviderEntry(
  read: Record<string, unknown>,
  provider: string,
): Record<string, unknown> | undefined {
  return (read['web_providers'] as Record<string, unknown>[]).find(
    (entry) => entry['provider'] === provider,
  );
}

/** Every human-face reading must be free of the key: only the mask may appear. */
function assertNoSecret(text: string, what: string): void {
  assert.ok(!text.includes(SENTINEL_KEY), `${what} must not contain the credential value`);
  assert.ok(
    !text.includes(SENTINEL_MIDDLE),
    `${what} must not contain the credential body — only a masked form may appear`,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

test('PUT credential stores the key and the same-call web consent, and repeats idempotently', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-put-');
  try {
    const first = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: SENTINEL_KEY,
      is_default: 1,
    });
    assert.equal(first.status, 200, await first.clone().text());
    const written = await readJson(first);
    assert.equal(written['provider'], 'brave');
    assert.equal(written['credential_status'], 'present');
    assert.equal(written['is_default'], 1);
    assert.equal(written['api_key_mask'], SENTINEL_MASK, 'the reading is the mask, never the key');
    assert.equal(written['credential_env'], 'allibot_WEB_BRAVE_API_KEY');
    const confirmedAt = written['confirmed_at'];
    assert.equal(typeof confirmedAt, 'string', 'saving a key is also the consent, so it has a time');
    assert.equal(written['receiver'], 'https://api.search.brave.com');
    assertNoSecret(JSON.stringify(written), 'the PUT response');

    const stored = queryDatabase<{
      api_key: string;
      is_default: number;
      created_at: string;
      updated_at: string;
    }>(
      fixture.dataDir,
      'SELECT api_key, is_default, created_at, updated_at FROM web_provider_credential WHERE provider = ?',
      ['brave'],
    );
    assert.equal(stored?.api_key, SENTINEL_KEY, 'the value is stored as the key it is');
    assert.equal(stored?.is_default, 1);
    assert.deepEqual(
      consentRows(fixture).map((row) => [row.scope_kind, row.scope_id]),
      [['web', 'brave']],
      'one call writes the credential and the ("web", provider) row',
    );

    const read = await readRemoteDataFlow(fixture);
    assert.deepEqual(read['web_consents'], [
      { scope_kind: 'web', scope_id: 'brave', confirmed_at: confirmedAt },
    ]);
    const brave = webProviderEntry(read, 'brave');
    assert.equal(brave?.['api_key_mask'], SENTINEL_MASK);
    assert.equal(brave?.['confirmed_at'], confirmedAt);
    assert.equal(brave?.['is_default'], 1);
    assert.equal(read['mcp_consents'] instanceof Array, true, 'the older readings are untouched');
    assertNoSecret(JSON.stringify(read), 'GET /api/remote-data-flow');

    // A repeat is the same fact: the first confirmation instant is kept, and
    // the row is not written twice.
    await delay(5);
    const again = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: SENTINEL_KEY,
      is_default: 1,
    });
    assert.equal(again.status, 200, await again.clone().text());
    assert.equal(
      (await readJson(again))['confirmed_at'],
      confirmedAt,
      'a replay does not refresh the consent time',
    );
    assert.deepEqual(consentRows(fixture).map((row) => row.confirmed_at), [confirmedAt]);
    assert.deepEqual(credentialRows(fixture), [{ provider: 'brave', is_default: 1 }]);
    const replayed = queryDatabase<{ created_at: string; updated_at: string }>(
      fixture.dataDir,
      'SELECT created_at, updated_at FROM web_provider_credential WHERE provider = ?',
      ['brave'],
    );
    assert.equal(
      replayed?.created_at,
      stored?.created_at,
      'the row was written once: created_at is the first write and never moves',
    );
    assert.notEqual(replayed?.updated_at, stored?.updated_at, 'the replay refreshed updated_at');
    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
  } finally {
    await fixture.stop();
  }
});

test('a sixth provider is 400 and the body is validated before anything is written', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-invalid-');
  try {
    for (const route of [
      '/api/web-providers/google/credential',
      '/api/web-providers/brave-search/credential',
      '/api/web-providers/Brave/credential',
    ]) {
      const refused = await putJson(fixture, route, { api_key: SENTINEL_KEY });
      assert.equal(refused.status, 400, `${route} must be refused: ${await refused.clone().text()}`);
      const body = await readJson(refused);
      assert.equal(errorCode(body), 'validation_failed');
      assert.ok(
        JSON.stringify(body).includes('brave') &&
          JSON.stringify(body).includes('exa'),
        'the copy names the five providers',
      );
    }
    assert.deepEqual(credentialRows(fixture), [], 'a sixth provider writes no row');
    assert.deepEqual(consentRows(fixture), [], 'and no consent row either');

    // A stored credential is the mark a rejected body must leave untouched.
    const stored = await putJson(fixture, '/api/web-providers/tavily/credential', {
      api_key: SENTINEL_KEY,
    });
    assert.equal(stored.status, 200, await stored.clone().text());
    const confirmedAt = (await readJson(stored))['confirmed_at'];

    const rejected: unknown[] = [
      { api_key: '' },
      { api_key: '   ' },
      { api_key: 7 },
      {},
      { api_key: SENTINEL_KEY, is_default: 2 },
      { api_key: SENTINEL_KEY, is_default: true },
      { api_key: SENTINEL_KEY, is_default: '1' },
      { api_key: SENTINEL_KEY, provider: 'brave' },
      [SENTINEL_KEY],
    ];
    for (const body of rejected) {
      const refused = await putJson(fixture, '/api/web-providers/tavily/credential', body);
      assert.equal(
        refused.status,
        400,
        `body ${JSON.stringify(body)} must be refused: ${await refused.clone().text()}`,
      );
      assert.equal(errorCode(await readJson(refused)), 'validation_failed');
    }

    assert.deepEqual(credentialRows(fixture), [{ provider: 'tavily', is_default: 0 }]);
    assert.deepEqual(consentRows(fixture).map((row) => row.confirmed_at), [confirmedAt]);
  } finally {
    await fixture.stop();
  }
});

test('setting a second default clears the first in the same transaction', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-defaults-');
  try {
    const brave = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: SENTINEL_KEY,
      is_default: 1,
    });
    assert.equal(brave.status, 200, await brave.clone().text());

    const tavily = await putJson(fixture, '/api/web-providers/tavily/credential', {
      api_key: `${SENTINEL_KEY}-tavily`,
      is_default: 1,
    });
    assert.equal(tavily.status, 200, await tavily.clone().text());
    assert.equal((await readJson(tavily))['is_default'], 1);
    assert.deepEqual(credentialRows(fixture), [
      { provider: 'brave', is_default: 0 },
      { provider: 'tavily', is_default: 1 },
    ]);

    const read = await readRemoteDataFlow(fixture);
    assert.deepEqual(
      (read['web_providers'] as Record<string, unknown>[]).map((entry) => [
        entry['provider'],
        entry['is_default'],
      ]),
      [
        ['brave', 0],
        ['tavily', 1],
        ['perplexity', 0],
        ['jina', 0],
        ['exa', 0],
      ],
      'at most one row carries the default flag, in the fixed order',
    );

    // A row written without the flag is not the default, even for the provider
    // that was the default before.
    const demoted = await putJson(fixture, '/api/web-providers/tavily/credential', {
      api_key: `${SENTINEL_KEY}-tavily`,
    });
    assert.equal(demoted.status, 200, await demoted.clone().text());
    assert.equal((await readJson(demoted))['is_default'], 0);
    assert.deepEqual(credentialRows(fixture), [
      { provider: 'brave', is_default: 0 },
      { provider: 'tavily', is_default: 0 },
    ]);
  } finally {
    await fixture.stop();
  }
});

/**
 * The live subscription while `run` writes: the collected frame text. A
 * credential write is a config write, so the expectation is zero frames; this
 * also proves no event payload can carry a key.
 */
async function collectSubscription(
  fixture: WebProviderFixture,
  run: () => Promise<void>,
): Promise<string> {
  const abort = new AbortController();
  const response = await fetch(`${fixture.base}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: abort.signal,
  });
  const body = response.body;
  assert.ok(body !== null, 'the subscription should carry a body stream');
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  const pump = (async (): Promise<void> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      text += decoder.decode(value, { stream: true });
    }
  })().catch(() => undefined);
  try {
    await run();
    await delay(100);
  } finally {
    abort.abort();
    await pump;
  }
  return text;
}

test('every HTTP reading is the mask, and neither a refused body nor a frame carries the key', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-mask-');
  try {
    const subscription = await collectSubscription(fixture, async () => {
      const written = await putJson(fixture, '/api/web-providers/perplexity/credential', {
        api_key: SENTINEL_KEY,
        is_default: 1,
      });
      assert.equal(written.status, 200, await written.clone().text());
      assertNoSecret(await written.text(), 'the PUT response');
    });
    assert.equal(subscription.includes('event:'), false, 'a credential write publishes no frame');
    assertNoSecret(subscription, 'the subscription stream');

    for (const route of [
      '/api/remote-data-flow',
      '/api/workspace',
      '/api/agents',
      '/api/channels',
      '/api/settings',
    ]) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 200, `${route} should read`);
      assertNoSecret(await response.text(), `GET ${route}`);
    }

    const read = await readRemoteDataFlow(fixture);
    const perplexity = webProviderEntry(read, 'perplexity');
    assert.equal(perplexity?.['api_key_mask'], SENTINEL_MASK);
    assert.equal(
      JSON.stringify(read).split(SENTINEL_MASK).length - 1,
      1,
      'the mask appears exactly once — as the one provider that has a stored key',
    );

    // A body carrying the key and an unknown field is refused whole, and the
    // refusal never echoes the value back.
    const refused = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: SENTINEL_KEY,
      note: `${SENTINEL_KEY} 这是不该出现的回显`,
    });
    assert.equal(refused.status, 400, await refused.clone().text());
    assertNoSecret(await refused.text(), 'the refused PUT response');
    assert.deepEqual(credentialRows(fixture), [{ provider: 'perplexity', is_default: 1 }]);

    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
  } finally {
    await fixture.stop();
  }
});

test('POST consent writes the row without touching the key and keeps the first instant', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-consent-');
  try {
    const confirmed = await postJson(fixture, '/api/web-providers/jina/consent', {});
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    const first = await readJson(confirmed);
    assert.equal(first['provider'], 'jina');
    assert.equal(first['api_key_mask'], null, 'a confirmation stores no key');
    assert.equal(first['credential_status'], 'missing');
    assert.equal(first['is_default'], 0);
    const confirmedAt = first['confirmed_at'];
    assert.equal(typeof confirmedAt, 'string');
    assert.deepEqual(
      consentRows(fixture).map((row) => [row.scope_kind, row.scope_id]),
      [['web', 'jina']],
    );
    assert.deepEqual(credentialRows(fixture), [], 'a confirmation writes no credential row');

    await delay(5);
    const replay = await postJson(fixture, '/api/web-providers/jina/consent', {});
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await readJson(replay))['confirmed_at'], confirmedAt);

    // Saving the key afterwards is the same consent: the first instant stands.
    const written = await putJson(fixture, '/api/web-providers/jina/credential', {
      api_key: SENTINEL_KEY,
    });
    assert.equal(written.status, 200, await written.clone().text());
    const afterKey = await readJson(written);
    assert.equal(afterKey['confirmed_at'], confirmedAt, 'the key write does not re-ask');
    assert.equal(afterKey['api_key_mask'], SENTINEL_MASK);
    assert.deepEqual(consentRows(fixture).map((row) => row.confirmed_at), [confirmedAt]);

    const sixth = await postJson(fixture, '/api/web-providers/serper/consent', {});
    assert.equal(sixth.status, 400, await sixth.clone().text());
    assert.equal(errorCode(await readJson(sixth)), 'validation_failed');
    assert.deepEqual(
      consentRows(fixture).map((row) => row.scope_id),
      ['jina'],
    );
  } finally {
    await fixture.stop();
  }
});

test('the generic consent endpoint takes scope_kind web, and webx stays 400 with the new copy', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-scope-');
  try {
    const web = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'web',
      scope_id: 'exa',
    });
    assert.equal(web.status, 200, await web.clone().text());
    const row = await readJson(web);
    assert.equal(row['scope_kind'], 'web');
    assert.equal(row['scope_id'], 'exa');
    const confirmedAt = row['confirmed_at'];
    assert.equal(typeof confirmedAt, 'string');

    await delay(5);
    const replay = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'web',
      scope_id: 'exa',
    });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await readJson(replay))['confirmed_at'], confirmedAt);

    const read = await readRemoteDataFlow(fixture);
    assert.deepEqual(read['web_consents'], [
      { scope_kind: 'web', scope_id: 'exa', confirmed_at: confirmedAt },
    ]);
    assert.equal(webProviderEntry(read, 'exa')?.['confirmed_at'], confirmedAt);
    assert.equal(webProviderEntry(read, 'exa')?.['credential_status'], 'missing');

    // The old three kinds still work; the vocabulary is wider, not replaced.
    for (const [kind, id] of [
      ['model', 'openai'],
      ['mcp', 'github'],
      ['docker', 'alpine:3.20'],
    ] as const) {
      const response = await postJson(fixture, '/api/remote-data-flow/consent', {
        scope_kind: kind,
        scope_id: id,
      });
      assert.equal(response.status, 200, `${kind} should still be accepted`);
      assert.equal((await readJson(response))['scope_kind'], kind);
    }

    const typo = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'webx',
      scope_id: 'brave',
    });
    assert.equal(typo.status, 400, await typo.clone().text());
    const typoBody = await readJson(typo);
    assert.equal(errorCode(typoBody), 'validation_failed');
    const message = (typoBody['error'] as Record<string, unknown>)['message'] as string;
    for (const kind of ['model', 'mcp', 'docker', 'web']) {
      assert.ok(message.includes(kind), `the copy lists all four kinds: ${message}`);
    }

    const unknownWeb = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'web',
      scope_id: 'google',
    });
    assert.equal(unknownWeb.status, 400, await unknownWeb.clone().text());
    assert.equal(errorCode(await readJson(unknownWeb)), 'validation_failed');
    assert.deepEqual(
      consentRows(fixture).map((row) => [row.scope_kind, row.scope_id]),
      [
        ['docker', 'alpine:3.20'],
        ['web', 'exa'],
        ['mcp', 'github'],
        ['model', 'openai'],
      ],
      'the four kinds coexist; the refused writes landed no row (rows are scope_id ordered)',
    );
  } finally {
    await fixture.stop();
  }
});

/**
 * The one resolution function through its exported seam: this ticket has no
 * endpoint that reads a target's web provider (that is T4's round assembly),
 * so the order is exercised the way `resolveWebAccessTier` is in the T2 test —
 * with an explicit environment and the fixture's own database.
 */
function resolveIn(
  fixture: WebProviderFixture,
  env: NodeJS.ProcessEnv,
  mcp: WebSearchMcpFace | null = null,
): WebSearchResolution {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return resolveWebSearch(db, env, mcp);
  } finally {
    db.close();
  }
}

type SelectedWebProvider = Extract<WebSearchResolution, { kind: 'provider' }>;

function selectedProvider(resolution: WebSearchResolution): SelectedWebProvider {
  if (resolution.kind !== 'provider') {
    assert.fail(`expected a provider: ${JSON.stringify(resolution)}`);
  }
  return resolution;
}

test('the resolution order is the named provider, then the stored default, then the fixed order', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-order-');
  try {
    assert.deepEqual(
      resolveIn(fixture, {}),
      {
        kind: 'unusable',
        reason: 'provider-missing',
        provider: null,
        credential_env: null,
      },
      'nothing stored, no environment, no exa MCP: nothing is usable',
    );

    const tavily = await putJson(fixture, '/api/web-providers/tavily/credential', {
      api_key: `${SENTINEL_KEY}-tavily`,
    });
    assert.equal(tavily.status, 200, await tavily.clone().text());
    assert.equal(selectedProvider(resolveIn(fixture, {})).provider, 'tavily');
    assert.equal(selectedProvider(resolveIn(fixture, {})).chosen_by, 'order');

    // The fixed order, not the write order: jina was written second and still
    // loses to tavily, which sits earlier in brave → tavily → … → exa.
    const jina = await putJson(fixture, '/api/web-providers/jina/credential', {
      api_key: `${SENTINEL_KEY}-jina`,
    });
    assert.equal(jina.status, 200, await jina.clone().text());
    assert.equal(selectedProvider(resolveIn(fixture, {})).provider, 'tavily');

    const brave = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: `${SENTINEL_KEY}-brave`,
    });
    assert.equal(brave.status, 200, await brave.clone().text());
    assert.equal(selectedProvider(resolveIn(fixture, {})).provider, 'brave');

    // A stored default beats the order.
    const jinaDefault = await putJson(fixture, '/api/web-providers/jina/credential', {
      api_key: `${SENTINEL_KEY}-jina`,
      is_default: 1,
    });
    assert.equal(jinaDefault.status, 200, await jinaDefault.clone().text());
    const byDefault = selectedProvider(resolveIn(fixture, {}));
    assert.equal(byDefault.provider, 'jina');
    assert.equal(byDefault.chosen_by, 'default');

    // The environment name beats the stored default. `exa` has no stored row:
    // its key and its consent come from the environment and the consent face.
    const exaConsent = await postJson(fixture, '/api/web-providers/exa/consent', {});
    assert.equal(exaConsent.status, 200, await exaConsent.clone().text());
    const named = selectedProvider(
      resolveIn(fixture, {
        allibot_WEB_SEARCH_PROVIDER: 'exa',
        allibot_WEB_EXA_API_KEY: `${SENTINEL_KEY}-exa`,
      }),
    );
    assert.equal(named.provider, 'exa');
    assert.equal(named.chosen_by, 'env-provider');
    assert.equal(named.api_key_source, 'env', 'no row is stored, so the environment value is used');
    assert.equal(named.api_key, `${SENTINEL_KEY}-exa`);

    // An unknown name is not a provider: it reads as "none named" and the
    // stored facts answer, because a process env value cannot be refused at a
    // request and a typo must not fail every web call.
    assert.equal(
      selectedProvider(resolveIn(fixture, { allibot_WEB_SEARCH_PROVIDER: 'google' })).provider,
      'jina',
      'an unknown name falls back to the stored default',
    );
  } finally {
    await fixture.stop();
  }
});

test('the stored key wins over the environment one and a new stored key takes effect at once', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-db-first-');
  try {
    const stored = await putJson(fixture, '/api/web-providers/tavily/credential', {
      api_key: `${SENTINEL_KEY}-stored`,
    });
    assert.equal(stored.status, 200, await stored.clone().text());

    const env = {
      allibot_WEB_SEARCH_PROVIDER: 'tavily',
      allibot_WEB_TAVILY_API_KEY: `${SENTINEL_KEY}-env`,
    } satisfies NodeJS.ProcessEnv;
    const first = selectedProvider(resolveIn(fixture, env));
    assert.equal(first.api_key, `${SENTINEL_KEY}-stored`, 'the stored row is the source of truth');
    assert.equal(first.api_key_source, 'db');

    // Rotating in the UI is a configuration change: the same environment and a
    // fresh process-free resolution reads the new value.
    const rotated = await putJson(fixture, '/api/web-providers/tavily/credential', {
      api_key: `${SENTINEL_KEY}-rotated`,
    });
    assert.equal(rotated.status, 200, await rotated.clone().text());
    const second = selectedProvider(resolveIn(fixture, env));
    assert.equal(second.api_key, `${SENTINEL_KEY}-rotated`, 'no restart is needed to rotate a key');
    assert.equal(second.api_key_source, 'db');
  } finally {
    await fixture.stop();
  }
});

test('an unconfirmed provider is unusable, and a named provider with no key falls through', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-unconfirmed-');
  try {
    const env = {
      allibot_WEB_SEARCH_PROVIDER: 'jina',
      allibot_WEB_JINA_API_KEY: `${SENTINEL_KEY}-jina`,
    } satisfies NodeJS.ProcessEnv;
    assert.deepEqual(
      resolveIn(fixture, env),
      {
        kind: 'unusable',
        reason: 'consent-missing',
        provider: 'jina',
        credential_env: 'allibot_WEB_JINA_API_KEY',
      },
      'a key without its ("web", provider) row is not usable',
    );

    // A named provider with no credential at all falls through to the next
    // step instead of failing the whole resolution.
    const brave = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: `${SENTINEL_KEY}-brave`,
      is_default: 1,
    });
    assert.equal(brave.status, 200, await brave.clone().text());
    assert.equal(
      selectedProvider(resolveIn(fixture, { allibot_WEB_SEARCH_PROVIDER: 'perplexity' })).provider,
      'brave',
      'a named provider with no credential is skipped, and the stored default answers',
    );

    // An unconfirmed stored row is the same verdict for the stored-default step.
    const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
    try {
      db.prepare("DELETE FROM remote_consent_scope WHERE scope_kind = 'web' AND scope_id = 'brave'")
        .run();
    } finally {
      db.close();
    }
    assert.deepEqual(
      resolveIn(fixture, {}),
      {
        kind: 'unusable',
        reason: 'consent-missing',
        provider: 'brave',
        credential_env: 'allibot_WEB_BRAVE_API_KEY',
      },
      'the stored default without its consent row is unusable too',
    );
  } finally {
    await fixture.stop();
  }
});

test('the exa MCP fallback needs a server named exactly exa and a search-ish tool', async () => {
  const fixture = await startWebProviderFixture('allibot-web-cred-exa-mcp-');
  try {
    const server = (name: string, tools: string[]): WebSearchMcpFace => ({
      servers: [{ name, tools: tools.map((tool) => ({ name: tool })) }],
    });

    assert.deepEqual(
      resolveIn(fixture, {}, server('exa', ['crawl', 'web_search_exa', 'search'])),
      {
        kind: 'mcp',
        server: 'exa',
        tool: 'web_search_exa',
        call: 'mcp:exa/web_search_exa',
      },
      'the first search-ish tool by name is the call identity',
    );

    for (const name of ['exa-search', 'exa2', 'my-exa', 'Exa']) {
      assert.deepEqual(
        resolveIn(fixture, {}, server(name, ['web_search_exa'])),
        {
          kind: 'unusable',
          reason: 'provider-missing',
          provider: null,
          credential_env: null,
        },
        `${name} is a near miss and must not match`,
      );
    }

    assert.deepEqual(
      resolveIn(fixture, {}, server('exa', ['crawl', 'get_contents'])),
      { kind: 'unusable', reason: 'provider-missing', provider: null, credential_env: null },
      'a connected exa server without a search-ish tool is not a search',
    );
    assert.equal(resolveIn(fixture, {}, null).kind, 'unusable', 'no MCP face means no fallback');

    // A confirmed key stops the order before the fallback: real provider and
    // MCP search are never both offered.
    const brave = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: `${SENTINEL_KEY}-brave`,
    });
    assert.equal(brave.status, 200, await brave.clone().text());
    assert.equal(
      resolveIn(fixture, {}, server('exa', ['web_search_exa'])).kind,
      'provider',
      'a usable key wins over the credential-free fallback',
    );
  } finally {
    await fixture.stop();
  }
});

test('each provider has its own endpoint override, with trailing slashes stripped', async () => {
  const override = 'http://127.0.0.1:4321';
  const fixture = await startWebProviderFixture('allibot-web-cred-base-url-', {
    env: { allibot_WEB_BRAVE_BASE_URL: `${override}//` },
  });
  try {
    const written = await putJson(fixture, '/api/web-providers/brave/credential', {
      api_key: SENTINEL_KEY,
    });
    assert.equal(written.status, 200, await written.clone().text());
    assert.equal(
      (await readJson(written))['receiver'],
      override,
      'the reading shows the endpoint a call would use',
    );

    const read = await readRemoteDataFlow(fixture);
    assert.equal(webProviderEntry(read, 'brave')?.['receiver'], override);
    assert.equal(
      webProviderEntry(read, 'tavily')?.['receiver'],
      'https://api.tavily.com',
      'the override belongs to its own provider',
    );

    const resolved = selectedProvider(
      resolveIn(fixture, { allibot_WEB_BRAVE_BASE_URL: `${override}//` }),
    );
    assert.equal(resolved.base_url, override);
    assert.equal(
      selectedProvider(resolveIn(fixture, {})).base_url,
      'https://api.search.brave.com',
      'no override reads as the provider default',
    );
  } finally {
    await fixture.stop();
  }
});
