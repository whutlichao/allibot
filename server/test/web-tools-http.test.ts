import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  removeTempDir,
  runCli,
  startRecordingEndpoint,
  startServer,
  type RecordedReply,
  type RecordedRequest,
  type RecordingEndpoint,
  type RunningServer,
} from './support.ts';
import { PROVIDER_ROWS, type ProviderRow } from './provider-rows.ts';
import {
  checkPermission,
  classifyToolName,
  readTargetPermissionContext,
  type PermissionDecision,
} from '../dist/permissions.js';
import { resolveWebSearch } from '../dist/web-providers.js';

/**
 * 联网工具进轮内循环 (#70 / T4 of M3, D1 / D2 / D4 / D5 / D8 / D10 / D13 / D14):
 * `web_search` and `fetch` are assembled per the effective 联网档, gated by the
 * one tool gate, and shaped like every other read result.
 *
 * The seam is the backend HTTP face: a real process, a temporary data
 * directory, the recorded provider endpoint (`startRecordingEndpoint`) for the
 * model, a second in-process server acting as the fake **web provider** (it
 * serves `web_search` only), and a third acting as the **target host** `fetch`
 * GETs. Every endpoint is `127.0.0.1`; the process environment pins all five
 * provider base URLs at a closed local port, so a mis-resolution cannot reach
 * the internet.
 *
 * The pure decision function is exercised through the exported `checkPermission`
 * seam because a gate reason is never part of an HTTP reading: the reason codes
 * (`read-only-tool`, `web-fetch-tier`, `rule-deny`, `rule-ask`, `mode-ask`) are
 * the evidence for D4's decision order.
 */

/** The closed local port every provider endpoint defaults to: no outbound network. */
const CLOSED_ORIGIN = 'http://127.0.0.1:1';

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  /** The model provider's recorded endpoint. */
  endpoint: RecordingEndpoint;
  /** The fake web provider: it answers `web_search` only. */
  webProvider: RecordingEndpoint;
  /** The target host `fetch` GETs. */
  target: RecordingEndpoint;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface HasBase {
  base: string;
}

/**
 * The process environment of every web case: no provider credential, and all
 * five endpoints on a closed local port. Whatever the resolution does, it
 * cannot open a socket to the internet; a case opts one provider back in.
 */
function noWebEnv(): NodeJS.ProcessEnv {
  return {
    allibot_WEB_SEARCH_PROVIDER: '',
    allibot_WEB_BRAVE_API_KEY: '',
    allibot_WEB_TAVILY_API_KEY: '',
    allibot_WEB_PERPLEXITY_API_KEY: '',
    allibot_WEB_JINA_API_KEY: '',
    allibot_WEB_EXA_API_KEY: '',
    allibot_WEB_BRAVE_BASE_URL: CLOSED_ORIGIN,
    allibot_WEB_TAVILY_BASE_URL: CLOSED_ORIGIN,
    allibot_WEB_PERPLEXITY_BASE_URL: CLOSED_ORIGIN,
    allibot_WEB_JINA_BASE_URL: CLOSED_ORIGIN,
    allibot_WEB_EXA_BASE_URL: CLOSED_ORIGIN,
  };
}

async function startFixture(
  prefix: string,
  provider: ProviderRow,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const endpoint = await startRecordingEndpoint();
  const webProvider = await startRecordingEndpoint();
  const target = await startRecordingEndpoint();
  const running = await startServer(dataDir, {
    args: ['--provider', 'model'],
    env: {
      HOME: home,
      ...provider.env(endpoint.baseUrl),
      ...noWebEnv(),
      // Brave's endpoint is the fake provider: a case that stores a brave key
      // therefore reaches an in-process server, never the internet (D7).
      allibot_WEB_BRAVE_BASE_URL: webProvider.baseUrl,
      ...options.env,
    },
  });
  return {
    tmp,
    dataDir,
    home,
    endpoint,
    webProvider,
    target,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await endpoint.stop();
      await webProvider.stop();
      await target.stop();
      await removeTempDir(tmp);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(server: HasBase, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(server: HasBase, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function putJson(server: HasBase, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The one-time remote-data-flow consent the model adapter needs before it calls. */
async function confirmRemoteDataFlow(server: HasBase, provider: ProviderRow): Promise<void> {
  const confirmed = await postJson(server, `/api/remote-data-flow/${provider.provider}/consent`, {});
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
}

/** One Agent with the given `model` and optional `web_access` override. */
async function createAgent(
  fixture: Fixture,
  provider: ProviderRow,
  options: { webAccess?: string; permissionMode?: string } = {},
): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '联网成员',
    model: provider.model,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agentId = (await readJson(created))['id'] as string;
  const patch: Record<string, unknown> = {};
  if (options.webAccess !== undefined) {
    patch['web_access'] = options.webAccess;
  }
  if (options.permissionMode !== undefined) {
    patch['permission_mode'] = options.permissionMode;
  }
  if (Object.keys(patch).length > 0) {
    const patched = await patchJson(fixture, `/api/agents/${agentId}`, patch);
    assert.equal(patched.status, 200, await patched.clone().text());
  }
  return agentId;
}

interface ChannelOptions {
  agentId?: string;
  webAccess?: string | null;
  permissionMode?: 'read-only' | 'ask-writes' | 'trusted-writes';
}

/** One autonomous channel, its tier / mode written through the ordinary PATCH. */
async function createChannel(fixture: Fixture, options: ChannelOptions = {}): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '联网频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const channelId = (await readJson(created))['id'] as string;
  const patch: Record<string, unknown> = {};
  if (options.webAccess !== undefined) {
    patch['web_access'] = options.webAccess;
  }
  if (options.permissionMode !== undefined) {
    patch['permission_mode'] = options.permissionMode;
  }
  if (Object.keys(patch).length > 0) {
    const patched = await patchJson(fixture, `/api/channels/${channelId}`, patch);
    assert.equal(patched.status, 200, await patched.clone().text());
  }
  if (options.agentId !== undefined) {
    const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: options.agentId,
    });
    assert.equal(joined.status, 200, await joined.clone().text());
  }
  return channelId;
}

async function putRules(
  fixture: Fixture,
  channelId: string,
  rules: readonly { tool_name: string; pattern: string; behavior: string }[],
): Promise<void> {
  const written = await putJson(fixture, `/api/channels/${channelId}/permission-rules`, rules);
  assert.equal(written.status, 200, await written.clone().text());
}

async function sendMessage(server: HasBase, targetId: string, body: string): Promise<Response> {
  return await postJson(server, `/api/targets/${targetId}/messages`, { body });
}

/**
 * Read one target's gate decision for one call through the one decision point:
 * the context is the same `readTargetPermissionContext` the round builds.
 */
function decide(
  fixture: Fixture,
  memberId: string,
  targetId: string,
  request: { tool_name: string; pattern: string },
): PermissionDecision {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const context = readTargetPermissionContext(db, memberId, targetId);
    assert.ok(context !== null, 'the target context resolves');
    return checkPermission(db, context, request);
  } finally {
    db.close();
  }
}

test('the two tool classes and the decision order: read-only-tool, web-fetch-tier, and rules still tighten', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-decision-', provider);
  try {
    assert.deepEqual(
      classifyToolName('web_search'),
      { tool_name: 'web_search', tool_class: 'read' },
      'web_search only reads a remote index',
    );
    assert.deepEqual(
      classifyToolName('fetch'),
      { tool_name: 'fetch', tool_class: 'execute' },
      'fetch can reach any host and is execution class (D3)',
    );

    const agentId = await createAgent(fixture, provider);

    // A read-only context denies fetch before any rule can speak (D2), even an
    // explicit allow rule.
    const readOnly = await createChannel(fixture, {
      agentId,
      webAccess: 'search+fetch',
      permissionMode: 'read-only',
    });
    await putRules(fixture, readOnly, [{ tool_name: 'fetch', pattern: '', behavior: 'allow' }]);

    // search+fetch with no rule: the tier exemption is the answer (D4).
    const tiered = await createChannel(fixture, {
      agentId,
      webAccess: 'search+fetch',
      permissionMode: 'ask-writes',
    });

    const denied = await createChannel(fixture, {
      agentId,
      webAccess: 'search+fetch',
      permissionMode: 'ask-writes',
    });
    await putRules(fixture, denied, [
      { tool_name: 'fetch', pattern: 'example.com', behavior: 'deny' },
    ]);

    const asked = await createChannel(fixture, {
      agentId,
      webAccess: 'search+fetch',
      permissionMode: 'ask-writes',
    });
    await putRules(fixture, asked, [
      { tool_name: 'fetch', pattern: 'example.com', behavior: 'ask' },
    ]);

    // A channel that only searches has no tier exemption for fetch.
    const searchOnly = await createChannel(fixture, {
      agentId,
      webAccess: 'search',
      permissionMode: 'ask-writes',
    });

    const dm = await postJson(fixture, '/api/dms', { agent_id: agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmTargetId = (await readJson(dm))['id'] as string;

    const fetchCall = (targetId: string) =>
      decide(fixture, agentId, targetId, { tool_name: 'fetch', pattern: 'example.com' });

    assert.deepEqual(fetchCall(readOnly), { decision: 'deny', reason: 'read-only-tool' });
    assert.deepEqual(
      decide(fixture, agentId, readOnly, { tool_name: 'Read', pattern: 'notes.txt' }),
      { decision: 'allow', reason: 'mode-allow' },
      'read-only still reads',
    );
    assert.deepEqual(fetchCall(tiered), { decision: 'allow', reason: 'web-fetch-tier' });
    assert.deepEqual(
      decide(fixture, agentId, tiered, { tool_name: 'web_search', pattern: '' }),
      { decision: 'allow', reason: 'mode-allow' },
      'web_search is a read tool and never needs the tier exemption',
    );
    assert.deepEqual(fetchCall(denied), { decision: 'deny', reason: 'rule-deny' });
    assert.deepEqual(fetchCall(asked), { decision: 'ask', reason: 'rule-ask' });
    assert.deepEqual(
      fetchCall(searchOnly),
      { decision: 'ask', reason: 'mode-ask' },
      'without the search+fetch tier a fetch would ask like any other execution',
    );
    assert.deepEqual(
      fetchCall(dmTargetId),
      { decision: 'deny', reason: 'read-only-tool' },
      'a DM never fetches, whatever its mode resolves to (D2)',
    );
  } finally {
    await fixture.stop();
  }
});

/**
 * Arrange the model endpoint's answers in order: one answer per request the
 * round makes, the last repeating if the round asks again, so an extra round
 * trip shows up as an assertion on the recorded request count.
 */
function queueReplies(endpoint: RecordingEndpoint, replies: readonly RecordedReply[]): void {
  let served = 0;
  endpoint.respondWith(() => {
    const reply = replies[Math.min(served, replies.length - 1)];
    served += 1;
    assert.ok(reply !== undefined, 'the fixture supplies at least one reply');
    return reply;
  });
}

/** The recorded model request's tool definitions, in the provider's own shape. */
function toolDefinitions(
  provider: ProviderRow,
  request: { body: string },
): { name: string }[] {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return provider.toolDefinitions(payload as Record<string, unknown>);
}

/** The tool names the round offered its model, in the request's own order. */
async function offeredTools(
  fixture: Fixture,
  provider: ProviderRow,
  targetId: string,
): Promise<string[]> {
  const sent = await sendMessage(fixture, targetId, '联网档检查');
  assert.equal(sent.status, 201, await sent.clone().text());
  const request = fixture.endpoint.requests.at(-1);
  assert.ok(request !== undefined, 'the round reached the model');
  return toolDefinitions(provider, request).map((definition) => definition.name);
}

/** Store one provider credential; saving it also writes the ('web', provider) row (D11). */
async function storeCredential(
  fixture: Fixture,
  provider: 'brave' | 'tavily' | 'perplexity' | 'jina' | 'exa',
  apiKey: string,
): Promise<void> {
  const written = await putJson(fixture, `/api/web-providers/${provider}/credential`, {
    api_key: apiKey,
    is_default: 1,
  });
  assert.equal(written.status, 200, await written.clone().text());
}

test('the four tiers assemble exactly the web tools, and an unset tier falls back to search', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-tiers-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId });
    await storeCredential(fixture, 'brave', 'tier-test-key');

    assert.deepEqual(
      await offeredTools(fixture, provider, channelId),
      ['web_search'],
      'an unset tier resolves to search and offers web_search only (D1)',
    );

    const off = await patchJson(fixture, `/api/channels/${channelId}`, { web_access: 'off' });
    assert.equal(off.status, 200, await off.clone().text());
    assert.deepEqual(
      await offeredTools(fixture, provider, channelId),
      [],
      "off assembles zero web tools even with a usable provider: 'off' is not a filter",
    );

    const search = await patchJson(fixture, `/api/channels/${channelId}`, { web_access: 'search' });
    assert.equal(search.status, 200, await search.clone().text());
    assert.deepEqual(await offeredTools(fixture, provider, channelId), ['web_search']);

    const both = await patchJson(fixture, `/api/channels/${channelId}`, {
      web_access: 'search+fetch',
    });
    assert.equal(both.status, 200, await both.clone().text());
    assert.deepEqual(
      await offeredTools(fixture, provider, channelId),
      ['web_search', 'fetch'],
      'search+fetch adds fetch, after web_search',
    );
  } finally {
    await fixture.stop();
  }
});

/** The recorded model request's tool results, in the provider's own shape. */
function toolResults(
  provider: ProviderRow,
  request: RecordedRequest,
): { id: string; content: string; isError: boolean }[] {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return provider.toolResults(payload as Record<string, unknown>);
}

/** The last request the model endpoint recorded: the one that fed results back. */
function lastModelRequest(fixture: Fixture): RecordedRequest {
  const request = fixture.endpoint.requests.at(-1);
  assert.ok(request !== undefined, 'the round reached the model');
  return request;
}

async function messages(server: HasBase, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${server.base}/api/targets/${targetId}/messages?limit=50`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

interface ApprovalShape {
  reply_id: string;
  status: string;
  tool_calls: {
    tool_call_id: string;
    tool_name: string;
    pattern: string;
    arguments: Record<string, unknown>;
  }[];
}

async function listApprovals(fixture: Fixture, query = 'status=all'): Promise<ApprovalShape[]> {
  const response = await fetch(`${fixture.base}/api/approvals?${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['approvals'] as unknown as ApprovalShape[];
}

/** The one SSE stream, read verbatim: what a leak would have to pass through. */
async function connectEvents(base: string): Promise<{
  raw: () => string;
  waitFor: (fragment: string, timeoutMs?: number) => Promise<void>;
  close: () => void;
}> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body !== null);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        seen += decoder.decode(value, { stream: true });
      }
    } catch {
      // The test closes the connection; that abort is not a failure.
    }
  })();
  return {
    raw: () => seen,
    async waitFor(fragment, timeoutMs = 8_000) {
      const deadline = Date.now() + timeoutMs;
      while (!seen.includes(fragment)) {
        if (Date.now() >= deadline) {
          throw new Error(`timed out waiting for ${fragment}; saw: ${seen}`);
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    close() {
      controller.abort();
      void pump;
    },
  };
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** The approval batch the round is blocked on, read from the human face. */
async function waitForPending(fixture: Fixture): Promise<ApprovalShape> {
  const rows = await waitFor(
    () => listApprovals(fixture, 'status=pending'),
    (value) => value.length > 0,
    'a pending approval',
  );
  return rows[0]!;
}

interface OutcomeRow {
  status: string;
  reason: string;
}

function latestOutcome(fixture: Fixture): OutcomeRow {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const rows = db
      .prepare('SELECT status, reason FROM round_outcome ORDER BY rowid')
      .all() as OutcomeRow[];
    assert.ok(rows.length > 0, 'the wake ran a round');
    return rows[rows.length - 1]!;
  } finally {
    db.close();
  }
}

/** Every surface a round writes or shows must carry no credential body. */
function assertNoSecret(text: string, secret: string, what: string): void {
  assert.equal(text.includes(secret), false, `${what} must not carry the credential`);
  assert.equal(
    text.includes(secret.slice(3, 23)),
    false,
    `${what} must not carry the credential body — only a masked form may appear`,
  );
}

/**
 * The provider resolution the round's `web_search` would use, read against the
 * fixture's database and a given environment (the same one order T3 shipped).
 */
function resolvedProvider(
  fixture: Fixture,
  env: NodeJS.ProcessEnv,
): { provider: string; api_key: string; api_key_source: 'db' | 'env' } {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const resolution = resolveWebSearch(db, { ...noWebEnv(), ...env }, null);
    assert.equal(resolution.kind, 'provider', 'the fixture has one usable provider');
    if (resolution.kind !== 'provider') {
      throw new Error('unreachable: the assertion above proved the kind');
    }
    return resolution;
  } finally {
    db.close();
  }
}

/** One brave-shaped search answer: two hits, the shape the provider really sends. */
function braveAnswer(hits: readonly { title: string; url: string; description: string }[]): RecordedReply {
  return { status: 200, body: { web: { results: hits } } };
}

test('web_search calls the stored provider with the DB key, shapes its hits, and never leaks the key', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-search-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search' });

    // The key the row holds, and a different key the environment offers: the
    // stored row must win (ADR 0010 / D6).
    const storedKey = 'db-brave-key-0123456789abcdef';
    await storeCredential(fixture, 'brave', storedKey);

    const sentinel = 'env-brave-key-fedcba9876543210';
    // The fixture's environment is fixed at spawn; prove the priority by
    // re-reading the resolution the round uses, under the same DB and an
    // environment that names the other key. The call itself uses the stored row.
    const envWithEnvKey = { allibot_WEB_BRAVE_API_KEY: sentinel } as NodeJS.ProcessEnv;
    const resolution = resolvedProvider(fixture, envWithEnvKey);
    assert.equal(resolution.api_key_source, 'db', 'the stored row is the source of truth');
    assert.equal(resolution.api_key, storedKey);

    fixture.webProvider.respondWith(() =>
      braveAnswer([
        { title: 'HIT-ONE', url: 'https://example.com/one', description: 'FIRST-SNIPPET' },
        { title: 'HIT-TWO', url: 'https://example.com/two', description: 'SECOND-SNIPPET' },
      ]),
    );
    queueReplies(fixture.endpoint, [
      provider.toolCalls([
        { id: 'call-search', name: 'web_search', input: { query: 'needle query' } },
      ]),
      provider.text('搜到两条结果'),
    ]);

    const events = await connectEvents(fixture.base);
    const sent = await sendMessage(fixture, channelId, '@联网成员 搜一下 needle query');
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.equal(fixture.webProvider.requests.length, 1, 'one web_search is one provider request');
    const call = fixture.webProvider.requests[0]!;
    assert.equal(call.method, 'GET');
    assert.equal(
      decodeURIComponent(call.path),
      '/res/v1/web/search?q=needle query',
      'the provider URL carries the query',
    );
    assert.equal(
      call.headers['x-subscription-token'],
      storedKey,
      "the provider's own auth header carries the stored key, not the environment one",
    );

    const results = toolResults(provider, lastModelRequest(fixture));
    assert.deepEqual(
      results.map((result) => [result.id, result.isError]),
      [['call-search', false]],
      'a search answer is a result',
    );
    const content = results[0]?.content ?? '';
    for (const expected of ['[web_search] ok', 'source: brave', 'query: needle query', 'hits: 2', 'HIT-ONE', 'FIRST-SNIPPET', 'HIT-TWO']) {
      assert.ok(content.includes(expected), `the shaped result states ${expected}: ${content}`);
    }
    assert.equal(content.includes('capped'), false, 'two hits are not a capped result');
    assertNoSecret(content, storedKey, 'the tool result');
    assertNoSecret(content, sentinel, 'the tool result');

    // The backend's own surfaces carry the answer and never the key.
    const bodies = (await messages(fixture, channelId)).map((message) => String(message['body'])).join('\n');
    assert.ok(bodies.includes('搜到两条结果'));
    assertNoSecret(bodies, storedKey, 'the message bodies');
    assertNoSecret(bodies, sentinel, 'the message bodies');
    const outcome = latestOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    assertNoSecret(outcome.reason, storedKey, 'the round reason');
    const logs = fixture.running.logs();
    assertNoSecret(logs.stdout + logs.stderr, storedKey, 'the backend logs');
    assertNoSecret(logs.stdout + logs.stderr, sentinel, 'the backend logs');
    assert.deepEqual(await listApprovals(fixture), [], 'a read tool never asks for approval');
    const flow = await readJson(await fetch(`${fixture.base}/api/remote-data-flow`));
    assertNoSecret(JSON.stringify(flow), storedKey, 'the remote-data-flow reading');
    await events.waitFor('round.outcome');
    assertNoSecret(events.raw(), storedKey, 'the SSE frames');
    assertNoSecret(events.raw(), sentinel, 'the SSE frames');
    events.close();
  } finally {
    await fixture.stop();
  }
});

test('search+fetch with no provider at all: fetch is a direct host GET with no credential header', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-fetch-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search+fetch' });

    // No credential is stored and no provider key is in the environment, so the
    // assembly withholds web_search (D8) while fetch is unaffected (2026-11-05).
    fixture.target.respondWith((request) => ({
      status: 200,
      body: `PAGE-BODY for ${request.path}`,
    }));
    queueReplies(fixture.endpoint, [
      provider.toolCalls([
        {
          id: 'call-fetch',
          name: 'fetch',
          input: { url: `${fixture.target.baseUrl}/page?token=TOKEN-SENTINEL` },
        },
      ]),
      provider.text('页面读完了'),
    ]);

    const sent = await sendMessage(fixture, channelId, '@联网成员 读这个页面');
    assert.equal(sent.status, 201, await sent.clone().text());

    const definitions = toolDefinitions(provider, fixture.endpoint.requests[0]!);
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      ['fetch'],
      'with no usable provider the assembly withholds web_search and keeps fetch',
    );

    assert.equal(fixture.webProvider.requests.length, 0, 'fetch never calls the web provider');
    assert.equal(fixture.target.requests.length, 1, 'one fetch is one target request');
    const request = fixture.target.requests[0]!;
    assert.equal(request.method, 'GET');
    assert.equal(
      request.path,
      '/page?token=TOKEN-SENTINEL',
      'the path and query reach the target exactly as the model asked',
    );
    for (const header of ['authorization', 'x-api-key', 'x-subscription-token', 'proxy-authorization']) {
      assert.equal(
        request.headers[header],
        undefined,
        `fetch sends no credential header (${header}) of any kind`,
      );
    }

    const results = toolResults(provider, lastModelRequest(fixture));
    assert.deepEqual(
      results.map((result) => [result.id, result.isError]),
      [['call-fetch', false]],
      'a completed page is a result',
    );
    const content = results[0]?.content ?? '';
    assert.ok(content.includes('[fetch] ok'), content);
    assert.ok(content.includes('status: 200'), content);
    assert.ok(content.includes('PAGE-BODY for /page?token=TOKEN-SENTINEL'), content);
    assert.ok(
      content.includes('host: 127.0.0.1'),
      `the result states the host, not the URL: ${content}`,
    );

    assert.deepEqual(
      await listApprovals(fixture),
      [],
      'search+fetch runs a fetch with no per-call approval (D4)',
    );
    assert.equal(latestOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

/**
 * A target host that can answer a redirect (the recorded endpoint cannot set a
 * `Location` header): `/same` redirects to `/final` on the same host, `/cross`
 * redirects to another host, anything else is a fixed page.
 */
async function startRedirectTarget(): Promise<{
  port: number;
  baseUrl: string;
  requests: { method: string; path: string }[];
  stop: () => Promise<void>;
}> {
  const requests: { method: string; path: string }[] = [];
  const server = createServer((request, response) => {
    requests.push({ method: request.method ?? 'GET', path: request.url ?? '/' });
    if (request.url === '/same') {
      response.writeHead(302, { location: '/final' });
      response.end();
      return;
    }
    if (request.url === '/cross') {
      response.writeHead(302, { location: 'http://cross-host.example/x' });
      response.end();
      return;
    }
    if (request.url === '/missing') {
      response.writeHead(404, { 'content-type': 'text/plain' });
      response.end('NOT-FOUND-BODY');
      return;
    }
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('REDIRECTED-BODY');
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the redirect target did not bind to a TCP port');
  }
  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    stop: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

test('fetch follows a same-host redirect and refuses a cross-host redirect and a non-http URL', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-fetch-redirect-', provider);
  const target = await startRedirectTarget();
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search+fetch' });

    queueReplies(fixture.endpoint, [
      provider.toolCalls(
        [
          { id: 'call-same', name: 'fetch', input: { url: `${target.baseUrl}/same` } },
          { id: 'call-cross', name: 'fetch', input: { url: `${target.baseUrl}/cross` } },
          { id: 'call-ftp', name: 'fetch', input: { url: 'ftp://example.com/x' } },
          {
            id: 'call-userinfo',
            name: 'fetch',
            input: { url: `http://user:pass@127.0.0.1:${target.port}/basic` },
          },
          { id: 'call-missing', name: 'fetch', input: { url: `${target.baseUrl}/missing` } },
        ],
        '先读这三处',
      ),
      provider.text('同主机的跳转跟了，跨主机和 ftp 都拒了'),
    ]);

    const sent = await sendMessage(fixture, channelId, '@联网成员 读这三个地址');
    assert.equal(sent.status, 201, await sent.clone().text());

    const results = toolResults(provider, lastModelRequest(fixture));
    assert.deepEqual(
      results.map((result) => [result.id, result.isError]),
      [
        ['call-same', false],
        ['call-cross', true],
        ['call-ftp', true],
        ['call-userinfo', true],
        ['call-missing', false],
      ],
      'a followed redirect and a 404 are pages; a cross-host redirect and a URL carrying user info are tool errors',
    );
    assert.ok((results[0]?.content ?? '').includes('REDIRECTED-BODY'), results[0]?.content ?? '');
    assert.ok(
      (results[1]?.content ?? '').includes('cross-host-redirect'),
      `the cross-host refusal states its code: ${results[1]?.content ?? ''}`,
    );
    assert.ok(
      (results[1]?.content ?? '').includes('cross-host.example'),
      'the refusal names the host it declined to follow',
    );
    assert.ok(
      (results[2]?.content ?? '').includes('invalid-url'),
      `a non-http URL is refused before the gate: ${results[2]?.content ?? ''}`,
    );
    assert.ok(
      (results[3]?.content ?? '').includes('invalid-url'),
      `a URL carrying user info is refused before any header exists: ${results[3]?.content ?? ''}`,
    );
    assert.ok((results[4]?.content ?? '').includes('status: 404'), results[4]?.content ?? '');
    assert.ok((results[4]?.content ?? '').includes('NOT-FOUND-BODY'), results[4]?.content ?? '');
    assert.deepEqual(
      target.requests.map((request) => request.path),
      ['/same', '/final', '/cross', '/missing'],
      'only the same-host redirect was followed; the cross-host and credential-carrying URLs were never requested',
    );
    assert.equal(latestOutcome(fixture).status, 'replied');
  } finally {
    await target.stop();
    await fixture.stop();
  }
});

test('read-only hides fetch and a DM never assembles it', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-withheld-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    await storeCredential(fixture, 'brave', 'withheld-key-0123456789');

    const readOnly = await createChannel(fixture, {
      agentId,
      webAccess: 'search+fetch',
      permissionMode: 'read-only',
    });
    assert.deepEqual(
      await offeredTools(fixture, provider, readOnly),
      ['web_search'],
      'read-only drops fetch from the assembled set but keeps the read tool (D2)',
    );

    // A DM's tier follows the Agent override plus the default, and fetch is
    // never assembled there whatever the tier says (D1 / D2).
    const patched = await patchJson(fixture, `/api/agents/${agentId}`, {
      web_access: 'search+fetch',
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    const dm = await postJson(fixture, '/api/dms', { agent_id: agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmTargetId = (await readJson(dm))['id'] as string;
    assert.deepEqual(
      await offeredTools(fixture, provider, dmTargetId),
      ['web_search'],
      'a DM never assembles fetch',
    );

    // The gate's second layer: even a direct call is denied, on both surfaces.
    assert.deepEqual(
      decide(fixture, agentId, readOnly, {
        tool_name: 'fetch',
        pattern: '127.0.0.1',
      }),
      { decision: 'deny', reason: 'read-only-tool' },
    );
    assert.deepEqual(
      decide(fixture, agentId, dmTargetId, {
        tool_name: 'fetch',
        pattern: '127.0.0.1',
      }),
      { decision: 'deny', reason: 'read-only-tool' },
    );
    assert.equal(fixture.target.requests.length, 0, 'nothing was fetched by the assembly checks');
  } finally {
    await fixture.stop();
  }
});

test('a deny rule still denies a tier-exempt fetch; an ask rule asks with the host only and the query never reaches the approval', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-fetch-approval-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search+fetch' });
    await storeCredential(fixture, 'brave', 'approval-key-0123456789');
    const host = '127.0.0.1';

    fixture.target.respondWith((request) => ({ status: 200, body: `BODY ${request.path}` }));
    queueReplies(fixture.endpoint, [
      provider.toolCalls([
        { id: 'call-denied', name: 'fetch', input: { url: `${fixture.target.baseUrl}/denied` } },
      ]),
      provider.text('被规则拒绝了'),
      provider.toolCalls([
        {
          id: 'call-asked',
          name: 'fetch',
          input: { url: `${fixture.target.baseUrl}/page?token=TOKEN-SENTINEL` },
        },
      ]),
      provider.text('批准后读到了页面'),
    ]);

    // 1. A deny rule outranks the tier exemption.
    await putRules(fixture, channelId, [{ tool_name: 'fetch', pattern: host, behavior: 'deny' }]);
    const deniedRound = await sendMessage(fixture, channelId, '@联网成员 先读 denied');
    assert.equal(deniedRound.status, 201, await deniedRound.clone().text());
    assert.equal(fixture.target.requests.length, 0, 'a denied fetch never opens a socket');
    const deniedResult = toolResults(provider, lastModelRequest(fixture))[0];
    assert.equal(deniedResult?.isError, true, 'a denial is a tool error result');
    assert.ok(
      (deniedResult?.content ?? '').includes('[fetch] error: denied'),
      deniedResult?.content ?? '',
    );
    assert.deepEqual(await listApprovals(fixture), [], 'a deny rule never asks');

    // 2. An ask rule still asks; the approval carries the host only.
    await putRules(fixture, channelId, [{ tool_name: 'fetch', pattern: host, behavior: 'ask' }]);
    const pendingRound = sendMessage(fixture, channelId, '@联网成员 再读带 token 的页面');
    const pending = await waitForPending(fixture);
    assert.equal(pending.tool_calls.length, 1);
    const call = pending.tool_calls[0]!;
    assert.equal(call.tool_name, 'fetch');
    assert.equal(call.pattern, host, 'the rule pattern subject is the host');
    assert.deepEqual(
      call.arguments,
      { tool_name: 'fetch', host },
      'the approval payload carries the host and nothing else (D5 / D14)',
    );
    assert.equal(
      JSON.stringify(pending).includes('TOKEN-SENTINEL'),
      false,
      'the query string never enters the approval record',
    );

    const approved = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: call.tool_call_id,
      confirmed: true,
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const answered = await pendingRound;
    assert.equal(answered.status, 201, await answered.clone().text());

    assert.deepEqual(
      fixture.target.requests.map((request) => request.path),
      ['/page?token=TOKEN-SENTINEL'],
      'the approval lets the exact URL through; only the record was host-only',
    );
    const approvedResult = toolResults(provider, lastModelRequest(fixture))[0];
    assert.equal(approvedResult?.isError, false);
    assert.ok((approvedResult?.content ?? '').includes('BODY /page?token=TOKEN-SENTINEL'));
    assert.equal(latestOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

/** Write to the fixture's database while the backend is between transactions. */
function mutateDatabase(fixture: Fixture, sql: string, params: readonly string[] = []): void {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
  try {
    db.pragma('busy_timeout = 5000');
    db.prepare(sql).run(...(params as never[]));
  } finally {
    db.close();
  }
}

test('web_search with an unconfirmed provider at the call point fails the round, names the missing confirmation, and opens zero sockets', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-consent-missing-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search' });
    await storeCredential(fixture, 'brave', 'consent-key-0123456789');

    // The round assembles while the provider is usable, then the confirmation
    // is withdrawn before the model's call arrives: a stale assembly.
    let first = true;
    fixture.endpoint.respondWith(() => {
      if (first) {
        first = false;
        mutateDatabase(
          fixture,
          "DELETE FROM remote_consent_scope WHERE scope_kind = 'web' AND scope_id = ?",
          ['brave'],
        );
        return provider.toolCalls([
          { id: 'call-search', name: 'web_search', input: { query: 'stale' } },
        ]);
      }
      return provider.text('不联网的轮次照常回复');
    });

    const sent = await sendMessage(fixture, channelId, '@联网成员 搜一下 stale');
    assert.equal(sent.status, 201, await sent.clone().text());

    const failed = latestOutcome(fixture);
    assert.equal(failed.status, 'failed', 'the call point closes the round failed (D8)');
    assert.ok(
      failed.reason.includes("('web','brave')"),
      `the reason names the missing confirmation: ${failed.reason}`,
    );
    assert.ok(
      failed.reason.includes('联网搜索不可用'),
      `the reason is the readable web copy: ${failed.reason}`,
    );
    assert.equal(
      fixture.webProvider.requests.length,
      0,
      'no usable provider means zero sockets, not a provider error',
    );
    assert.deepEqual(
      (await messages(fixture, channelId)).map((message) => message['kind']),
      ['human'],
      'a failed round lands no Agent message',
    );
    assertNoSecret(failed.reason, 'consent-key-0123456789', 'the round reason');

    // The same channel's unrelated round still replies: the withholding is per
    // call, never a round-start failure for the whole channel (D8).
    const unrelated = await sendMessage(fixture, channelId, '@联网成员 只是聊一句');
    assert.equal(unrelated.status, 201, await unrelated.clone().text());
    assert.equal(latestOutcome(fixture).status, 'replied');
    assert.deepEqual(
      (await messages(fixture, channelId)).map((message) => message['kind']),
      ['human', 'human', 'agent'],
    );
  } finally {
    await fixture.stop();
  }
});

test('web_search with the named provider credential gone at the call point fails the round and names the environment variable', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-credential-missing-', provider, {
    env: { allibot_WEB_SEARCH_PROVIDER: 'brave' },
  });
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search+fetch' });
    await storeCredential(fixture, 'brave', 'rotated-away-key-0123456789');

    let first = true;
    fixture.endpoint.respondWith(() => {
      if (first) {
        first = false;
        mutateDatabase(fixture, 'DELETE FROM web_provider_credential WHERE provider = ?', ['brave']);
        return provider.toolCalls([
          { id: 'call-search', name: 'web_search', input: { query: 'stale' } },
        ]);
      }
      return provider.text('不联网的轮次照常回复');
    });

    const sent = await sendMessage(fixture, channelId, '@联网成员 搜一下 stale');
    assert.equal(sent.status, 201, await sent.clone().text());

    const failed = latestOutcome(fixture);
    assert.equal(failed.status, 'failed');
    assert.ok(
      failed.reason.includes('allibot_WEB_BRAVE_API_KEY'),
      `the reason names the provider's environment variable: ${failed.reason}`,
    );
    assert.equal(fixture.webProvider.requests.length, 0, 'zero sockets');

    const unrelated = await sendMessage(fixture, channelId, '@联网成员 只是聊一句');
    assert.equal(unrelated.status, 201, await unrelated.clone().text());
    assert.equal(latestOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('web_search reports capped only when the hit cap applies, and a provider error is a masked tool result', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-capped-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search' });
    const storedKey = 'capped-key-0123456789abcdef';
    await storeCredential(fixture, 'brave', storedKey);

    fixture.webProvider.respondWith((request) => {
      const query = new URL(request.path, 'http://provider.invalid').searchParams.get('q') ?? '';
      if (query === 'fail') {
        return { status: 500, body: `provider exploded with ${storedKey} in its log` };
      }
      const count = query === 'many' ? 12 : 2;
      return braveAnswer(
        Array.from({ length: count }, (_, index) => ({
          title: `HIT-${query}-${index}`,
          url: `https://example.com/${query}/${index}`,
          description: `SNIPPET-${index}`,
        })),
      );
    });
    queueReplies(fixture.endpoint, [
      provider.toolCalls([
        { id: 'call-many', name: 'web_search', input: { query: 'many' } },
        { id: 'call-few', name: 'web_search', input: { query: 'few' } },
        { id: 'call-fail', name: 'web_search', input: { query: 'fail' } },
      ]),
      provider.text('三处都答了'),
    ]);

    const sent = await sendMessage(fixture, channelId, '@联网成员 搜三次');
    assert.equal(sent.status, 201, await sent.clone().text());

    const results = toolResults(provider, lastModelRequest(fixture));
    assert.deepEqual(
      results.map((result) => [result.id, result.isError]),
      [
        ['call-many', false],
        ['call-few', false],
        ['call-fail', true],
      ],
      'a provider error is a tool result, never a round failure',
    );
    const many = results[0]?.content ?? '';
    assert.ok(many.includes('hits: 8'), `the capped result holds the cap: ${many}`);
    assert.ok(
      many.includes('capped: hits (limit 8)'),
      `the capped result says the hit cap applied: ${many}`,
    );
    assert.equal(many.includes('HIT-many-8'), false, 'the hits past the cap are cut');
    const few = results[1]?.content ?? '';
    assert.ok(few.includes('hits: 2'));
    assert.equal(few.includes('capped'), false, 'two hits are not a capped result');
    const failed = results[2]?.content ?? '';
    assert.ok(failed.includes('[web_search] error: provider-error'), failed);
    assert.ok(failed.includes('HTTP 500'), failed);
    assertNoSecret(failed, storedKey, 'the provider error result');
    assert.ok(failed.includes('…'), `the provider echo is masked before it lands: ${failed}`);
    assert.equal(latestOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('the provider key is read per call: rotating the stored credential takes effect on the next round', async () => {
  const provider = PROVIDER_ROWS[0]!;
  const fixture = await startFixture('allibot-web-rotation-', provider);
  try {
    const agentId = await createAgent(fixture, provider);
    await confirmRemoteDataFlow(fixture, provider);
    const channelId = await createChannel(fixture, { agentId, webAccess: 'search' });

    const firstKey = 'first-rotation-key-0123456789';
    const secondKey = 'second-rotation-key-9876543210';
    await storeCredential(fixture, 'brave', firstKey);
    fixture.webProvider.respondWith(() => braveAnswer([]));
    queueReplies(fixture.endpoint, [
      provider.toolCalls([{ id: 'call-one', name: 'web_search', input: { query: 'one' } }]),
      provider.text('第一次搜完'),
      provider.toolCalls([{ id: 'call-two', name: 'web_search', input: { query: 'two' } }]),
      provider.text('第二次搜完'),
    ]);

    const first = await sendMessage(fixture, channelId, '@联网成员 第一次搜索');
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal(fixture.webProvider.requests[0]?.headers['x-subscription-token'], firstKey);

    await storeCredential(fixture, 'brave', secondKey);
    const second = await sendMessage(fixture, channelId, '@联网成员 第二次搜索');
    assert.equal(second.status, 201, await second.clone().text());
    assert.equal(
      fixture.webProvider.requests[1]?.headers['x-subscription-token'],
      secondKey,
      'the next round reads the rotated key without a restart (ADR 0010)',
    );
    assert.equal(
      JSON.stringify(fixture.webProvider.requests[1]).includes(firstKey),
      false,
      'the request after the rotation carries only the new key',
    );
  } finally {
    await fixture.stop();
  }
});
