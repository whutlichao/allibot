import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '@allibot/shared';
import {
  REPO_ROOT,
  removeTempDir,
  runCli,
  startRecordingEndpoint,
  startServer,
  type RecordedReply,
  type RecordingEndpoint,
  type RunningServer,
} from './support.ts';

/**
 * MCP 工具进轮内循环 (#76 / T10 / D2 / D3 / D5 / D6 / D10): the tools a round's
 * connected MCP servers actually list are offered to the model under the
 * product's one name, `mcp:<server>/<tool>`, and a call runs through the
 * round's own MCP face — the same gate, the same re-feed cap, the same
 * `DENIED` result a denial has always been.
 *
 * The one seam is the backend HTTP face: a real process, a temporary data
 * directory, `startRecordingEndpoint` answering in Anthropic's wire shape and
 * the test MCP server (`server/test/fixtures/mcp-server.mjs`) injected below
 * the seam exactly as a configured server would be. Nothing here reaches into
 * the adapter; the offered tool set is read off the recorded provider request,
 * the assembled servers are read off the MCP server's own request log, and the
 * round's conclusion is read off the human REST face and the round's rows.
 *
 * One provider row is enough: the wire shape of a tool result is batch one's
 * subject (#58). This file owns what is specific to the MCP namespace — its
 * dynamic tool list, its opaque argument object and its execution-class gate.
 */

/** The sentinel credential the recording endpoint's env carries. */
const PROVIDER_KEY = 'sk-mcp-loop-0123456789abcdefghij-wxyz';

/** The one model this file's Agent is configured with. */
const MODEL = 'anthropic:claude-sonnet-4-5';

/** The test MCP server injected below the seam. */
const MCP_SERVER = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'mcp-server.mjs');

/** `echo`'s own description: the tool definition must come from the server, not a list here. */
const ECHO_DESCRIPTION = 'Return the probe, cwd and a pair of environment-variable readings.';

/** One tool call a provider turn asks the round to run. */
interface ToolCallShape {
  id: string;
  name: string;
  input: unknown;
}

/** One tool definition a recorded request carried, as Anthropic serializes it. */
interface ToolDefinitionShape {
  name: string;
  description: string;
  schema: Record<string, unknown>;
}

/** One tool result a recorded request fed back. */
interface ToolResultShape {
  id: string;
  content: string;
  isError: boolean;
}

function messagesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages = payload['messages'];
  return Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [];
}

/** One assistant turn that requests the given tool calls, optionally with narration. */
function toolCalls(calls: readonly ToolCallShape[], narration?: string): RecordedReply {
  return {
    status: 200,
    body: {
      content: [
        ...(narration === undefined ? [] : [{ type: 'text', text: narration }]),
        ...calls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
    },
  };
}

/** One assistant turn that carries text and asks for nothing. */
function answer(body: string): RecordedReply {
  return { status: 200, body: { content: [{ type: 'text', text: body }] } };
}

/** The tool definitions a recorded request carried. */
function toolDefinitions(payload: Record<string, unknown>): ToolDefinitionShape[] {
  const tools = payload['tools'];
  if (!Array.isArray(tools)) {
    return [];
  }
  return (tools as Record<string, unknown>[]).map((tool) => ({
    name: String(tool['name']),
    description: String(tool['description'] ?? ''),
    schema: (tool['input_schema'] ?? {}) as Record<string, unknown>,
  }));
}

/** The tool results a recorded request fed back, in message order. */
function toolResults(payload: Record<string, unknown>): ToolResultShape[] {
  const results: ToolResultShape[] = [];
  for (const message of messagesOf(payload)) {
    if (message['role'] !== 'user') {
      continue;
    }
    const content = message['content'];
    if (!Array.isArray(content)) {
      continue;
    }
    for (const block of content as Record<string, unknown>[]) {
      if (block['type'] !== 'tool_result') {
        continue;
      }
      results.push({
        id: String(block['tool_use_id']),
        content:
          typeof block['content'] === 'string'
            ? block['content']
            : JSON.stringify(block['content']),
        isError: block['is_error'] === true,
      });
    }
  }
  return results;
}

function requestPayload(request: { body: string }): Record<string, unknown> {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return payload as Record<string, unknown>;
}

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  endpoint: RecordingEndpoint;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

/**
 * Start one fixture: a migrated data directory, the recording endpoint and a
 * real backend process running the model adapter against it. `options.args`
 * adds the server's own arguments, which is how a case drives a shorter
 * approval wait.
 */
async function startFixture(
  prefix: string,
  options: { args?: readonly string[] } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const endpoint = await startRecordingEndpoint();
  const running = await startServer(dataDir, {
    args: ['--provider', 'model', ...(options.args ?? [])],
    env: { HOME: home, ANTHROPIC_API_KEY: PROVIDER_KEY, ANTHROPIC_BASE_URL: endpoint.baseUrl },
  });
  return {
    tmp,
    dataDir,
    home,
    endpoint,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await endpoint.stop();
      await removeTempDir(tmp);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(server: { base: string }, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(server: { base: string }, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** The one-time remote-data-flow consent the model adapter needs before it calls. */
async function confirmRemoteDataFlow(fixture: Fixture): Promise<void> {
  const confirmed = await postJson(fixture, '/api/remote-data-flow/anthropic/consent', {});
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
}

interface RoundTarget {
  agentId: string;
  agentHome: string;
  channelId: string;
  project: string;
}

/**
 * Open the target context a round runs in: an Agent with the model adapter, the
 * consent it needs, an autonomous channel and its workspace root. The local
 * shell switch stays off, so the offered set is the file tools plus whatever
 * MCP this round assembled.
 */
async function openRound(fixture: Fixture): Promise<RoundTarget> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '连 MCP 的成员',
    model: MODEL,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agent = await readJson(created);
  const agentId = agent['id'] as string;
  await confirmRemoteDataFlow(fixture);

  const channel = await postJson(fixture, '/api/channels', {
    name: 'MCP 循环频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(channel.status, 201, await channel.clone().text());
  const channelId = (await readJson(channel))['id'] as string;
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: agentId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());

  const project = path.join(fixture.tmp, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'README.md'), 'project marker\n', 'utf8');
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    workspace_root: project,
  });
  assert.equal(patched.status, 200, await patched.clone().text());
  return { agentId, agentHome: agent['home_path'] as string, channelId, project };
}

/** The Agent-home `mcp.json`, written as the one source of MCP servers (D6.1). */
function writeMcp(round: RoundTarget, servers: unknown[]): void {
  writeFileSync(
    path.join(round.agentHome, 'mcp.json'),
    `${JSON.stringify({ servers }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );
}

interface ChannelRule {
  tool_name: string;
  pattern: string;
  behavior: 'allow' | 'ask' | 'deny';
}

async function writeChannelRules(fixture: Fixture, round: RoundTarget, rules: ChannelRule[]): Promise<void> {
  const response = await fetch(`${fixture.base}/api/channels/${round.channelId}/permission-rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rules),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

/** The fixture MCP server as a stdio entry; its request log proves the connection. */
function stdioServer(fixture: Fixture, name: string): Record<string, unknown> {
  return {
    name,
    transport: 'stdio',
    enabled: true,
    command: process.execPath,
    args: [MCP_SERVER, 'stdio', '--log', mcpLog(fixture, name)],
  };
}

function mcpLog(fixture: Fixture, name: string): string {
  return path.join(fixture.tmp, `${name}.log`);
}

/** The stdio server's own request log; a server that never ran leaves no file. */
function mcpRequests(fixture: Fixture, name: string): string {
  const file = mcpLog(fixture, name);
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

interface StartedMcpServer {
  port: number;
  log: () => string;
  stop: () => Promise<void>;
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').trim().length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

/** A localhost HTTP MCP endpoint: the remote transport's one seam-side double. */
async function startRemoteMcp(fixture: Fixture, name: string): Promise<StartedMcpServer> {
  const portFile = path.join(fixture.tmp, `${name}-port`);
  const child: ChildProcess = spawn(
    process.execPath,
    [MCP_SERVER, 'http', '--port-file', portFile, '--log', mcpLog(fixture, name)],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForFile(portFile);
  return {
    port: Number(readFileSync(portFile, 'utf8').trim()),
    log: () => mcpRequests(fixture, name),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          setTimeout(resolve, 1000).unref?.();
        });
      }
    },
  };
}

/**
 * Arrange the recording endpoint's answers in order: one answer per request the
 * round makes, and the last answer repeats if the round asks again, so an extra
 * round trip shows up as an assertion on the recorded request count.
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

interface PendingApproval {
  reply_id: string;
  status: string;
  tool_calls: {
    tool_call_id: string;
    tool_name: string;
    pattern: string;
    arguments: Record<string, unknown>;
  }[];
}

async function listApprovals(fixture: Fixture, query = 'status=all'): Promise<PendingApproval[]> {
  const response = await fetch(`${fixture.base}/api/approvals?${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['approvals'] as unknown as PendingApproval[];
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

async function waitForPending(fixture: Fixture): Promise<PendingApproval> {
  const rows = await waitFor(
    () => listApprovals(fixture, 'status=pending'),
    (value) => value.length > 0,
    'a pending approval',
  );
  return rows[0]!;
}

/**
 * Send one trigger message, decide the one approval the MCP call registers, and
 * wait for the round's write to settle: an `ask` rule blocks inside the round,
 * so the POST only returns after the decision.
 */
async function sendAndDecide(
  fixture: Fixture,
  targetId: string,
  body: string,
  options: { confirm: boolean },
): Promise<PendingApproval> {
  const sent = postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  const pending = await waitForPending(fixture);
  const call = pending.tool_calls[0];
  assert.ok(call !== undefined, 'the MCP call registered one approval call');
  const decided = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
    tool_call_id: call.tool_call_id,
    confirmed: options.confirm,
  });
  assert.equal(decided.status, 200, await decided.clone().text());
  const response = await sent;
  assert.equal(response.status, 201, await response.clone().text());
  return pending;
}

async function messages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages?limit=50`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

interface OutcomeRow {
  status: string;
  reason: string;
  finished_reason: string | null;
}

function roundOutcomes(fixture: Fixture): OutcomeRow[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT status, reason, finished_reason FROM round_outcome ORDER BY rowid')
      .all() as OutcomeRow[];
  } finally {
    db.close();
  }
}

function roundOutcome(fixture: Fixture): OutcomeRow {
  const outcomes = roundOutcomes(fixture);
  assert.equal(outcomes.length, 1, 'one wake runs exactly one round');
  assert.ok(outcomes[0] !== undefined);
  return outcomes[0];
}

/** The offered tool names of one recorded request, in the order the model saw them. */
function offeredNames(fixture: Fixture, requestIndex = 0): string[] {
  return toolDefinitions(requestPayload(fixture.endpoint.requests[requestIndex]!)).map(
    (definition) => definition.name,
  );
}

test('the connected server’s own tools are offered as mcp:<server>/<tool> and a call’s result is fed back', async () => {
  const fixture = await startFixture('allibot-mcp-loop-offered-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [stdioServer(fixture, 'demo')]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'allow' },
      { tool_name: 'mcp:demo/boom', pattern: '', behavior: 'allow' },
    ]);
    // A nested, non-string argument: the server declares its own schema, so the
    // round's shape check must accept the whole JSON object rather than refusing
    // anything that is not a flat string.
    const probe = { nested: [1, 2], ok: true };
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-echo', name: 'mcp:demo/echo', input: { probe, note: 'two fields' } }], '我查一下 MCP。'),
      answer('MCP 结果我读到了'),
    ]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 用 echo 查一下',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.deepEqual(
      offeredNames(fixture),
      ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'mcp:demo/echo', 'mcp:demo/boom'],
      'the round offers the connected server’s tools under the product name, after the built-ins',
    );
    const definitions = toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
    const echo = definitions.find((definition) => definition.name === 'mcp:demo/echo');
    assert.ok(echo !== undefined, 'the echo tool is offered');
    assert.equal(echo.description, ECHO_DESCRIPTION, 'the definition comes from the server, not from a list here');
    assert.deepEqual(
      echo.schema,
      { type: 'object', properties: {}, additionalProperties: true },
      'an MCP tool declares no schema the round knows: the argument object stays open',
    );

    assert.equal(fixture.endpoint.requests.length, 2, 'the call feeds its result back');
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1, 'the second request carries one tool result');
    assert.equal(results[0]?.id, 'call-echo');
    assert.equal(results[0]?.isError, false, 'a successful MCP call is not a tool error');
    const content = results[0]?.content ?? '';
    assert.ok(
      content.startsWith('[mcp:demo/echo] ok'),
      `the result states its own outcome: ${content}`,
    );
    assert.ok(
      content.includes('"probe":{"nested":[1,2],"ok":true}'),
      `the nested argument really reached the server: ${content}`,
    );
    // `note` is a second, undeclared argument: the call reaching the server at
    // all is the proof that the shape check did not refuse it, because the
    // declared-shape path refuses an unexpected name before the face runs.
    assert.match(mcpRequests(fixture, 'demo'), /request tools\/call/, 'the server saw the call');

    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
      [
        ['human', '@连 MCP 的成员 用 echo 查一下'],
        ['agent', 'MCP 结果我读到了'],
      ],
      'only the final text lands',
    );
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
  } finally {
    await fixture.stop();
  }
});

test('an MCP tool that reports an error is a tool result and the round continues', async () => {
  const fixture = await startFixture('allibot-mcp-loop-error-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [stdioServer(fixture, 'demo')]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:demo/boom', pattern: '', behavior: 'allow' },
    ]);
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-boom', name: 'mcp:demo/boom', input: {} }]),
      answer('那个 MCP 工具自己报错了，我改道回答'),
    ]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 调那个会报错的工具',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.equal(fixture.endpoint.requests.length, 2, 'a failing MCP tool still feeds its result back');
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, 'call-boom');
    assert.equal(results[0]?.isError, true, 'the server’s isError result is a tool error');
    const content = results[0]?.content ?? '';
    assert.ok(
      content.startsWith('[mcp:demo/boom] error: tool-error'),
      `the stable code reaches the model: ${content}`,
    );
    assert.ok(content.includes('BOOM'), `the server’s own body reaches the model: ${content}`);
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
      [
        ['human', '@连 MCP 的成员 调那个会报错的工具'],
        ['agent', '那个 MCP 工具自己报错了，我改道回答'],
      ],
      'a failed MCP tool is a result, not a round failure',
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('an MCP result larger than the re-feed cap is cut for the model and says so', async () => {
  const fixture = await startFixture('allibot-mcp-loop-capped-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [stdioServer(fixture, 'demo')]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'allow' },
    ]);
    // One 30000-character value the server answers with verbatim: the result is
    // past the 20000-character re-feed cap (D6), and only the model's copy is cut.
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-long', name: 'mcp:demo/echo', input: { probe: 'M'.repeat(30000) } }]),
      answer('结果很长，我只读了开头一段'),
    ]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 读一个大结果',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    const content = toolResults(requestPayload(fixture.endpoint.requests[1]!))[0]?.content ?? '';
    assert.ok(
      content.startsWith('[mcp:demo/echo] ok'),
      `the capped copy keeps its state line: ${content.slice(0, 40)}`,
    );
    assert.ok(
      content.length < 20500,
      `the model’s copy is capped: ${String(content.length)} characters`,
    );
    const cutFact = ZH_CN['tool.result.truncated'].text
      .split('{total}')[0]!
      .replace('{given}', '20000');
    assert.ok(content.includes(cutFact), `the cut is stated: ${content.slice(-200)}`);
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human', 'agent'],
      'a capped result is still a result the round concludes from',
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('a remote server without its per-name confirmation is never connected and offers no tool', async () => {
  const fixture = await startFixture('allibot-mcp-loop-unconfirmed-');
  const remote = await startRemoteMcp(fixture, 'remote');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [
      stdioServer(fixture, 'local'),
      {
        name: 'remote',
        transport: 'http',
        enabled: true,
        url: `http://127.0.0.1:${remote.port}/mcp`,
      },
    ]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:local/echo', pattern: '', behavior: 'allow' },
      { tool_name: 'mcp:remote/echo', pattern: '', behavior: 'allow' },
    ]);
    queueReplies(fixture.endpoint, [answer('没有确认过的远端我不连')]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 看一下工具',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.deepEqual(
      offeredNames(fixture),
      ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'mcp:local/echo', 'mcp:local/boom'],
      'the unconfirmed remote server contributes no tool; the confirmed-by-transport local one does',
    );
    assert.doesNotMatch(
      remote.log(),
      /http (initialize|tools\/list|tools\/call)/,
      'the unconfirmed remote server saw no protocol request at all',
    );
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    const unconfirmed = ZH_CN['mcp.runtime.remoteUnconfirmed'].text
      .replace('{name}', 'remote')
      .replace('{transport}', 'http');
    assert.ok(
      outcome.reason.includes(unconfirmed),
      `the round states which server was not confirmed: ${outcome.reason}`,
    );
  } finally {
    await remote.stop();
    await fixture.stop();
  }
});

test('an invalid mcp.json assembles nothing and the round settles with zero MCP tools', async () => {
  const fixture = await startFixture('allibot-mcp-loop-invalid-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [
      stdioServer(fixture, 'half'),
      {
        // One invalid entry invalidates the whole file (M2 D6.1): the valid
        // neighbour must not be connected either.
        name: 'broken',
        transport: 'stdio',
        enabled: true,
        command: process.execPath,
        args: [MCP_SERVER, 'stdio'],
        url: 'http://127.0.0.1:9/mcp',
      },
    ]);
    queueReplies(fixture.endpoint, [answer('mcp.json 有问题，我不用 MCP 工具')]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 试一下',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.deepEqual(
      offeredNames(fixture),
      ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
      'an invalid file is whole-file zero MCP',
    );
    assert.equal(mcpRequests(fixture, 'half'), '', 'not even the valid entry is connected');
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human', 'agent'],
      'the round still settles normally',
    );
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
    const entryProblem = ZH_CN['mcp.file.entryStdioUrl'].text.replace('{index}', '2');
    assert.ok(
      outcome.reason.includes(entryProblem),
      `the round states the file's diagnostic: ${outcome.reason}`,
    );
  } finally {
    await fixture.stop();
  }
});

test('a server that cannot be reached offers no tool of its own and the round still settles', async () => {
  const fixture = await startFixture('allibot-mcp-loop-disconnect-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [
      { name: 'gone', transport: 'stdio', enabled: true, command: '/nonexistent/allibot-mcp-server', args: [] },
      stdioServer(fixture, 'live'),
    ]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:gone/echo', pattern: '', behavior: 'allow' },
      { tool_name: 'mcp:live/echo', pattern: '', behavior: 'allow' },
    ]);
    queueReplies(fixture.endpoint, [answer('有一个 server 连不上，我用剩下的工具')]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 看看工具',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.deepEqual(
      offeredNames(fixture),
      ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'mcp:live/echo', 'mcp:live/boom'],
      'a server that failed to connect contributes nothing; the round does not fail',
    );
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    const connectFailed = ZH_CN['mcp.runtime.connectFailed'].text
      .split('{detail}')[0]!
      .replace('{name}', 'gone');
    assert.ok(
      outcome.reason.includes(connectFailed),
      `the round states which server failed: ${outcome.reason}`,
    );
  } finally {
    await fixture.stop();
  }
});

test('a deny rule on mcp:<server>/<tool> comes back as DENIED and the round continues', async () => {
  const fixture = await startFixture('allibot-mcp-loop-denied-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [stdioServer(fixture, 'demo')]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'deny' },
    ]);
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-denied', name: 'mcp:demo/echo', input: { probe: 'ping' } }]),
      answer('被拒绝了，我不再调这个工具'),
    ]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 调一下 echo',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.equal(fixture.endpoint.requests.length, 2, 'the denial is fed back and the model gets another turn');
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true, 'a denial is a tool error result');
    const content = results[0]?.content ?? '';
    assert.ok(content.includes('denied'), `the stable code reaches the model: ${content}`);
    assert.ok(content.includes('DENIED'), `a denial reads as DENIED: ${content}`);
    assert.doesNotMatch(
      mcpRequests(fixture, 'demo'),
      /request tools\/call/,
      'a denied MCP call never reaches the server',
    );
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human', 'agent'],
      'the round still answers after a denial',
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('an ask rule blocks the MCP call inside the round until the human decides', async () => {
  const fixture = await startFixture('allibot-mcp-loop-asked-');
  try {
    const round = await openRound(fixture);
    writeMcp(round, [stdioServer(fixture, 'demo')]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'ask' },
    ]);
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-asked', name: 'mcp:demo/echo', input: { probe: 'ping' } }]),
      answer('确认后我拿到了 MCP 的结果'),
    ]);

    const pending = await sendAndDecide(fixture, round.channelId, '@连 MCP 的成员 调一下 echo', {
      confirm: true,
    });

    const call = pending.tool_calls[0]!;
    assert.equal(call.tool_name, 'mcp:demo/echo', 'the approval is under the product name (D3)');
    assert.equal(
      call.pattern,
      '{"probe":"ping"}',
      'the pattern is the stable JSON of the arguments',
    );
    assert.deepEqual(call.arguments, {
      // The approval summary is the tool's name plus the arguments it carries.
      tool_name: 'mcp:demo/echo',
      probe: 'ping',
    });

    assert.equal(fixture.endpoint.requests.length, 2, 'the confirmed call feeds its result back');
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results[0]?.isError, false, 'an approved call is not a tool error');
    assert.ok((results[0]?.content ?? '').startsWith('[mcp:demo/echo] ok'));
    assert.match(mcpRequests(fixture, 'demo'), /request tools\/call/, 'the approved call ran');
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
      [
        ['human', '@连 MCP 的成员 调一下 echo'],
        ['agent', '确认后我拿到了 MCP 的结果'],
      ],
    );
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
  } finally {
    await fixture.stop();
  }
});

test('an MCP approval that waits past the timeout closes the round failed and is never a tool result', async () => {
  const fixture = await startFixture('allibot-mcp-loop-timeout-', {
    args: ['--approval-timeout-ms', '200'],
  });
  try {
    const round = await openRound(fixture);
    writeMcp(round, [stdioServer(fixture, 'demo')]);
    await writeChannelRules(fixture, round, [
      { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'ask' },
    ]);
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-waits', name: 'mcp:demo/echo', input: { probe: 'ping' } }]),
      answer('这条永远不会被请求'),
    ]);

    const sent = await postJson(fixture, `/api/targets/${round.channelId}/messages`, {
      body: '@连 MCP 的成员 调一下 echo',
    });
    assert.equal(sent.status, 201, await sent.clone().text());

    assert.equal(
      fixture.endpoint.requests.length,
      1,
      'the timeout is never fed back, so no further turn is taken',
    );
    assert.deepEqual(
      toolResults(requestPayload(fixture.endpoint.requests[0]!)),
      [],
      'the first request carries no tool result at all',
    );
    assert.doesNotMatch(
      mcpRequests(fixture, 'demo'),
      /request tools\/call/,
      'a timed-out approval never runs the call',
    );
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human'],
      'a timed-out approval writes no Agent message',
    );
    const rows = await listApprovals(fixture);
    assert.equal(rows[0]?.status, 'failed', 'the approval row states the timeout');
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'failed');
    assert.ok(
      outcome.reason.includes('审批等待超时'),
      `the existing approval-timeout copy is the reason: ${outcome.reason}`,
    );
    assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
  } finally {
    await fixture.stop();
  }
});
