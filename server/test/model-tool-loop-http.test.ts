import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '@allibot/shared';
import {
  removeTempDir,
  runCli,
  startRecordingEndpoint,
  startServer,
  type RecordedReply,
  type RecordingEndpoint,
  type RunningServer,
} from './support.ts';

/**
 * 轮内工具循环 (#57 / #58 / D1 / D2 / D3 / D5 / D7 / D9): the real model adapter
 * runs model → tool → model round trips inside one `runRound` call and lands
 * only the final text.
 *
 * The one seam is still the backend HTTP face: a real process, a temporary data
 * directory, and `startRecordingEndpoint` answering in the provider's own wire
 * shape. The matrix is parameterised by provider (`PROVIDER_ROWS`) and is the
 * only source of these cases: both rows run the same scenarios and the same
 * assertions, so a parsing fix on one side cannot silently diverge from the
 * other.
 */

/** The sentinel credential the recording endpoint's env carries. */
const PROVIDER_KEY = 'sk-tool-loop-0123456789abcdefghij-wxyz';

/** One tool call a provider turn asks the round to run. */
interface ToolCallShape {
  id: string;
  name: string;
  input: unknown;
}

/** One tool definition a recorded request carried, normalized across providers. */
interface ToolDefinitionShape {
  name: string;
  description: string;
  /** The parameter schema, as the provider serialized it. */
  schema: Record<string, unknown>;
}

/** One tool result a recorded request fed back, normalized across providers. */
interface ToolResultShape {
  /** The provider's call id the result answers. */
  id: string;
  content: string;
  isError: boolean;
}

/**
 * One provider's wire shape: how a tool call is requested, how a text answer is
 * shaped, and how the recorded request is read back. Nothing here reaches into
 * the adapter; the row exists so a second provider is a second row.
 */
interface ProviderRow {
  label: 'anthropic' | 'openai';
  /** The `provider:model` the Agent is configured with. */
  model: string;
  /** The consent route segment, i.e. the provider the adapter reads. */
  provider: 'anthropic' | 'openai';
  /** The env that points this provider's adapter at the recording endpoint. */
  env: (baseUrl: string) => NodeJS.ProcessEnv;
  /** The path the adapter posts to. */
  path: string;
  /** One assistant turn that requests the given tool calls. */
  toolCalls: (calls: readonly ToolCallShape[], narration?: string) => RecordedReply;
  /** One assistant turn that carries text and asks for nothing. */
  text: (body: string) => RecordedReply;
  /** The tool definitions the recorded request carried. */
  toolDefinitions: (payload: Record<string, unknown>) => ToolDefinitionShape[];
  /** The tool results the recorded request fed back. */
  toolResults: (payload: Record<string, unknown>) => ToolResultShape[];
  /** The assistant tool-call ids the recorded request echoed back. */
  echoedToolCalls: (payload: Record<string, unknown>) => string[];
  /**
   * A 200 answer that carries no readable turn: an assistant message this
   * provider's wire shape cannot read as either text or tool calls.
   */
  unparseable: () => RecordedReply;
  /**
   * The request body's keys for a round with no tool available, sorted: the
   * single completion the adapter always sent, and nothing added by the loop.
   */
  singleCompletionKeys: readonly string[];
}

function messagesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages = payload['messages'];
  return Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [];
}

function blocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message['content'];
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const ANTHROPIC: ProviderRow = {
  label: 'anthropic',
  model: 'anthropic:claude-sonnet-4-5',
  provider: 'anthropic',
  env: (baseUrl) => ({ ANTHROPIC_API_KEY: PROVIDER_KEY, ANTHROPIC_BASE_URL: baseUrl }),
  path: '/v1/messages',
  toolCalls: (calls, narration) => ({
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
  }),
  text: (body) => ({ status: 200, body: { content: [{ type: 'text', text: body }] } }),
  toolDefinitions: (payload) => {
    const tools = payload['tools'];
    if (!Array.isArray(tools)) {
      return [];
    }
    return (tools as Record<string, unknown>[]).map((tool) => ({
      name: String(tool['name']),
      description: String(tool['description'] ?? ''),
      schema: (tool['input_schema'] ?? {}) as Record<string, unknown>,
    }));
  },
  toolResults: (payload) => {
    const results: ToolResultShape[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'user') {
        continue;
      }
      for (const block of blocksOf(message)) {
        if (block['type'] !== 'tool_result') {
          continue;
        }
        results.push({
          id: String(block['tool_use_id']),
          content: typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content']),
          isError: block['is_error'] === true,
        });
      }
    }
    return results;
  },
  echoedToolCalls: (payload) => {
    const ids: string[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'assistant') {
        continue;
      }
      for (const block of blocksOf(message)) {
        if (block['type'] === 'tool_use') {
          ids.push(String(block['id']));
        }
      }
    }
    return ids;
  },
  unparseable: () => ({ status: 200, body: { content: 'not-a-block-array' } }),
  singleCompletionKeys: ['max_tokens', 'messages', 'model', 'system'],
};

/**
 * The OpenAI-compatible wire shape: `tools[].function.parameters` out,
 * `choices[0].message.{content,tool_calls}` in, `role: "tool"` results back.
 *
 * OpenAI carries no `is_error` flag, so a failed call states its stable error
 * code on the result's first line (`[Read] error: outside-root`); that first
 * line is what this row reads back as the result being an error.
 */
const OPENAI: ProviderRow = {
  label: 'openai',
  model: 'openai:gpt-5',
  provider: 'openai',
  env: (baseUrl) => ({ OPENAI_API_KEY: PROVIDER_KEY, OPENAI_BASE_URL: baseUrl }),
  path: '/chat/completions',
  toolCalls: (calls, narration) => ({
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: narration ?? null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          },
        },
      ],
    },
  }),
  text: (body) => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: body } }] },
  }),
  toolDefinitions: (payload) => {
    const tools = payload['tools'];
    if (!Array.isArray(tools)) {
      return [];
    }
    return (tools as Record<string, unknown>[]).map((tool) => {
      const fn = isRecord(tool['function']) ? tool['function'] : {};
      return {
        name: String(fn['name']),
        description: String(fn['description'] ?? ''),
        schema: (fn['parameters'] ?? {}) as Record<string, unknown>,
      };
    });
  },
  toolResults: (payload) => {
    const results: ToolResultShape[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'tool') {
        continue;
      }
      const content =
        typeof message['content'] === 'string'
          ? message['content']
          : JSON.stringify(message['content']);
      results.push({
        id: String(message['tool_call_id']),
        content,
        isError: /^\[[^\]]+\] error: /.test(content),
      });
    }
    return results;
  },
  echoedToolCalls: (payload) => {
    const ids: string[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'assistant' || !Array.isArray(message['tool_calls'])) {
        continue;
      }
      for (const call of message['tool_calls'] as Record<string, unknown>[]) {
        ids.push(String(call['id']));
      }
    }
    return ids;
  },
  unparseable: () => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: null } }] },
  }),
  singleCompletionKeys: ['messages', 'model'],
};

/** Both rows run the same cases; this list is the matrix's only source. */
const PROVIDER_ROWS: readonly ProviderRow[] = [ANTHROPIC, OPENAI];

/** The minimal shape every helper posts to: a started backend. */
interface HasBase {
  base: string;
}

/** One task target whose Plan run a seeding round already filled. */
interface SeededPlan {
  taskTargetId: string;
  /** The seeded run's item ids in append order. */
  taskIds: string[];
}

/** A backend a scenario seeds state on before the recorded server starts. */
interface SetupPhase extends HasBase {
  tmp: string;
  dataDir: string;
  home: string;
}

interface Fixture extends HasBase {
  tmp: string;
  dataDir: string;
  home: string;
  endpoint: RecordingEndpoint;
  running: RunningServer;
  /** The seeded Plan run a plan scenario reads; `null` on every other scenario. */
  plan: SeededPlan | null;
  stop: () => Promise<void>;
}

/**
 * Start one fixture. `seed`, when given, runs against a scripted double on the
 * same data directory and is stopped before the recording endpoint's server
 * starts: a scenario that needs state the model cannot create itself (the Plan
 * run's items; #63 brings the Plan write tools) seeds it through the ordinary
 * HTTP face first. `options` adds the server's own arguments and environment
 * overrides, which is how a case drives a shorter approval wait or a different
 * provider endpoint.
 */
async function startFixture(
  prefix: string,
  provider: ProviderRow,
  seed?: (setup: SetupPhase) => Promise<SeededPlan>,
  options: { args?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const plan = seed === undefined ? null : await runSeed({ tmp, dataDir, home }, seed);
  const endpoint = await startRecordingEndpoint();
  const running = await startServer(dataDir, {
    args: ['--provider', 'model', ...(options.args ?? [])],
    env: { HOME: home, ...provider.env(endpoint.baseUrl), ...options.env },
  });
  return {
    tmp,
    dataDir,
    home,
    endpoint,
    running,
    plan,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await endpoint.stop();
      await removeTempDir(tmp);
    },
  };
}

/** Run one seeding phase on the scripted `plan` double, then stop it. */
async function runSeed(
  context: Omit<SetupPhase, 'base'>,
  seed: (setup: SetupPhase) => Promise<SeededPlan>,
): Promise<SeededPlan> {
  const running = await startServer(context.dataDir, { args: ['--scripted-provider', 'plan'] });
  try {
    return await seed({ ...context, base: `http://127.0.0.1:${running.port}` });
  } finally {
    await running.stop();
  }
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

async function getJson(server: HasBase, route: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${server.base}${route}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

/** The one-time remote-data-flow consent the model adapter needs before it calls. */
async function confirmRemoteDataFlow(server: HasBase, provider: ProviderRow): Promise<void> {
  const confirmed = await postJson(server, `/api/remote-data-flow/${provider.provider}/consent`, {});
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
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

interface RoundTarget {
  agentId: string;
  channelId: string;
  /** The project root this round reads; `null` leaves the channel rootless. */
  project: string | null;
}

async function openRound(
  fixture: Fixture,
  provider: ProviderRow,
  options: { prefix: string; withRoot: boolean },
): Promise<RoundTarget> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '读文件的成员',
    model: provider.model,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agentId = (await readJson(created))['id'] as string;

  await confirmRemoteDataFlow(fixture, provider);

  const channel = await postJson(fixture, '/api/channels', {
    name: '工具循环频道',
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

  if (!options.withRoot) {
    return { agentId, channelId, project: null };
  }
  const project = path.join(fixture.tmp, options.prefix);
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'notes.txt'), 'NEEDLE-ONE\n');
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, { workspace_root: project });
  assert.equal(patched.status, 200, await patched.clone().text());
  return { agentId, channelId, project };
}

/**
 * Seed one task target whose Plan run already holds items. The task is created
 * before the Agent joins the channel so no claim round fires, then the member
 * is assigned and the seeding round runs on the scripted `plan` double: it is
 * the only face that creates Plan items today (#63 brings the write tools).
 * The item ids come back through `GET /api/targets/{id}/plans`, the same read
 * model the UI uses.
 */
async function seedPlanRound(
  setup: SetupPhase,
  provider: ProviderRow,
  options: { withRoot: boolean },
): Promise<SeededPlan> {
  const channel = await postJson(setup, '/api/channels', {
    name: '计划工具频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 10,
  });
  assert.equal(channel.status, 201, await channel.clone().text());
  const channelId = (await readJson(channel))['id'] as string;

  const task = await postJson(setup, '/api/tasks', { channel_id: channelId, title: '计划工具任务' });
  assert.equal(task.status, 201, await task.clone().text());
  const taskView = await readJson(task);
  const taskId = taskView['id'] as string;
  const taskTargetId = taskView['target_id'] as string;

  const created = await postJson(setup, '/api/agents', {
    display_name: '读计划的成员',
    model: provider.model,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agentId = (await readJson(created))['id'] as string;
  const joined = await postJson(setup, `/api/channels/${channelId}/members`, {
    member_id: agentId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
  const assigned = await patchJson(setup, `/api/tasks/${taskId}`, {
    assignee_member_id: agentId,
  });
  assert.equal(assigned.status, 200, await assigned.clone().text());

  if (options.withRoot) {
    const project = path.join(setup.tmp, 'plan-project');
    mkdirSync(path.join(project, 'sub'), { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'NEEDLE-ONE\n');
    writeFileSync(path.join(project, 'sub', 'other.txt'), 'NEEDLE-TWO\n');
    const patched = await patchJson(setup, `/api/channels/${channelId}`, {
      workspace_root: project,
    });
    assert.equal(patched.status, 200, await patched.clone().text());
  }

  await sendMessage(setup, taskTargetId, '@读计划的成员 把你的计划列一下');
  const taskIds = (await planItems(setup, taskTargetId)).map((item) => item.id);
  assert.equal(taskIds.length, 2, 'the seeding round fills the run with two items');
  return { taskTargetId, taskIds };
}

interface PlanItemShape {
  id: string;
  title: string;
  status: string;
  position: number;
}

/** The current Plan run's items, read through the ordinary read model. */
async function planItems(server: HasBase, targetId: string): Promise<PlanItemShape[]> {
  const body = await getJson(server, `/api/targets/${targetId}/plans`);
  const plans = body['plans'] as Record<string, unknown>[];
  const tasks = (plans[0]?.['tasks'] ?? []) as PlanItemShape[];
  return tasks;
}

async function sendMessage(server: HasBase, targetId: string, body: string): Promise<void> {
  const response = await postJson(server, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

async function messages(server: HasBase, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${server.base}/api/targets/${targetId}/messages?limit=50`);
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

/**
 * How far the member had consumed the target: the same row the round input reads
 * as its cursor. An answered round advances it, which is what makes the trigger
 * message unread-free for the next wake.
 */
function consumedSeq(fixture: Fixture, memberId: string, targetId: string): number {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db
      .prepare('SELECT last_read_seq FROM read_position WHERE member_id = ? AND target_id = ?')
      .get(memberId, targetId) as { last_read_seq: number } | undefined;
    return row?.last_read_seq ?? 0;
  } finally {
    db.close();
  }
}

async function patchMaxIterations(fixture: Fixture, agentId: string, value: number): Promise<void> {
  const response = await patchJson(fixture, `/api/agents/${agentId}`, { max_iterations: value });
  assert.equal(response.status, 200, await response.clone().text());
  const body = await readJson(response);
  assert.equal(body['max_iterations'], value, 'the Agent keeps the configured cap');
}

/** The round just finished: a seeded scenario ran a round of its own first. */
function latestOutcome(fixture: Fixture): OutcomeRow {
  const outcomes = roundOutcomes(fixture);
  assert.ok(outcomes.length > 0, 'the wake ran a round');
  return outcomes[outcomes.length - 1]!;
}

function requestPayload(request: { body: string }): Record<string, unknown> {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return payload as Record<string, unknown>;
}

/** The credential's body, so a leaked fragment is detectable, not only the whole key. */
const PROVIDER_KEY_MIDDLE = '0123456789abcdefghij';

/** Every surface a round touches must carry only a masked form of the credential. */
function assertNoCredential(text: string, what: string): void {
  assert.equal(text.includes(PROVIDER_KEY), false, `${what} must not carry the credential`);
  assert.equal(
    text.includes(PROVIDER_KEY_MIDDLE),
    false,
    `${what} must not carry the credential body — only a masked form may appear`,
  );
}

interface PendingApproval {
  reply_id: string;
  tool_calls: { tool_call_id: string; tool_name: string }[];
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
async function waitForPending(fixture: Fixture): Promise<PendingApproval> {
  const rows = await waitFor(
    async () => {
      const response = await fetch(`${fixture.base}/api/approvals?status=pending`);
      assert.equal(response.status, 200, await response.clone().text());
      return (await readJson(response))['approvals'] as unknown as PendingApproval[];
    },
    (value) => value.length > 0,
    'a pending approval',
  );
  return rows[0]!;
}

/** Put the plain read behind the gate: a `rule-ask` outranks the mode default (D10). */
async function putReadAskRule(fixture: Fixture, channelId: string, pattern: string): Promise<void> {
  const response = await fetch(`${fixture.base}/api/channels/${channelId}/permission-rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify([{ tool_name: 'Read', pattern, behavior: 'ask' }]),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

interface SseFrame {
  event: string;
  raw: string;
}

interface SseStream {
  waitFor(event: string, timeoutMs: number): Promise<SseFrame | null>;
  /** Everything the stream sent, verbatim: what a leak would have to pass through. */
  raw(): string;
  close(): void;
}

async function connectEvents(base: string): Promise<SseStream> {
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
  const frames: SseFrame[] = [];
  const seen: string[] = [];
  let buffer = '';
  let closed = false;
  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          seen.push(block);
          const event = /^event:\s*(.+)$/m.exec(block)?.[1];
          if (event !== undefined) {
            frames.push({ event, raw: block });
          }
        }
      }
    } catch {
      // The test closes the connection; that abort is not a failure.
    } finally {
      closed = true;
    }
  })();
  return {
    async waitFor(event, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = frames.findIndex((candidate) => candidate.event === event);
        if (index !== -1) {
          return frames.splice(index, 1)[0] ?? null;
        }
        if (closed || Date.now() >= deadline) {
          return null;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    raw: () => seen.join('\n\n'),
    close() {
      controller.abort();
      void pump;
    },
  };
}

/**
 * A local endpoint that accepts the request and never answers: the adapter's
 * own single-call timeout is what has to close this round (D9).
 */
async function startHangingEndpoint(): Promise<{
  baseUrl: string;
  requests: () => number;
  stop: () => Promise<void>;
}> {
  let received = 0;
  const sockets = new Set<import('node:net').Socket>();
  const server = createServer((request, response) => {
    received += 1;
    request.resume();
    request.on('end', () => {
      // Held open on purpose: the response headers never arrive.
      void response;
    });
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  assert.ok(address !== null && typeof address !== 'string', 'the hanging endpoint binds a port');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests: () => received,
    stop: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const provider of PROVIDER_ROWS) {
  test(`[${provider.label}] a round that reads one file answers with the final text only`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-one-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }], '我先读一下这个文件。'),
        provider.text('最终回答：文件里有 NEEDLE-ONE'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下 notes.txt');

      assert.equal(fixture.endpoint.requests.length, 2, 'one tool call adds one round trip');
      const first = provider.toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
      assert.deepEqual(
        first.map((definition) => definition.name),
        ['Read', 'Glob', 'Grep'],
        "the request carries exactly the batch's read tools this round offers",
      );
      const schema = first[0]?.schema ?? {};
      assert.deepEqual(schema['required'], ['path'], 'the schema names the one required argument');
      assert.deepEqual(
        (schema['properties'] as Record<string, Record<string, unknown>>)['path']?.['type'],
        'string',
        'the schema types the argument',
      );
      assert.ok(
        (first[0]?.description ?? '').length > 0,
        'the tool definition explains what the tool does',
      );

      const second = requestPayload(fixture.endpoint.requests[1]!);
      assert.deepEqual(
        provider.echoedToolCalls(second),
        ['call-1'],
        'the second request echoes the assistant tool call it answers',
      );
      const results = provider.toolResults(second);
      assert.equal(results.length, 1, 'the second request carries one tool result');
      assert.equal(results[0]?.id, 'call-1');
      assert.equal(results[0]?.isError, false, 'a successful read is not a tool error');
      assert.ok(
        (results[0]?.content ?? '').includes('NEEDLE-ONE'),
        `the result carries the file body: ${results[0]?.content ?? ''}`,
      );
      assert.ok(
        (results[0]?.content ?? '').includes('notes.txt'),
        'the result names the path it read',
      );

      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 读一下 notes.txt'],
          ['agent', '最终回答：文件里有 NEEDLE-ONE'],
        ],
        'only the final text lands, and it is the one new message',
      );
      for (const message of await messages(fixture, round.channelId)) {
        assert.equal(
          String(message['body']).includes('我先读一下这个文件'),
          false,
          'the narration between tool calls never lands',
        );
      }

      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'replied');
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] two tool calls in one round both run and still land one message`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-two-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      assert.ok(round.project !== null);
      const skillFile = path.join(
        fixture.home,
        '.allibot',
        'agents',
        round.agentId,
        'skills',
        'demo',
        'SKILL.md',
      );
      mkdirSync(path.dirname(skillFile), { recursive: true });
      writeFileSync(skillFile, 'SKILL-NEEDLE\nskill body\n');

      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-project', name: 'Read', input: { path: 'notes.txt' } },
          { id: 'call-skills', name: 'Read', input: { path: skillFile } },
        ]),
        provider.text('项目根和 skills 第二根都读到了'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读两个地方');

      assert.equal(fixture.endpoint.requests.length, 2, 'two calls in one turn stay one round trip');
      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results.length, 2, 'both calls are executed and answered');
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-project', false],
          ['call-skills', false],
        ],
      );
      assert.ok(
        (results[0]?.content ?? '').includes('NEEDLE-ONE'),
        'the project root read reached the file face',
      );
      assert.ok(
        (results[1]?.content ?? '').includes('SKILL-NEEDLE'),
        'the member read-only skills second root reached the file face',
      );

      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 读两个地方'],
          ['agent', '项目根和 skills 第二根都读到了'],
        ],
        'two tool calls still land exactly one message',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a round with no project root asks for zero tools and answers in one call`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-rootless-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: false });
      queueReplies(fixture.endpoint, [provider.text('没有项目根，直接回答')]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 你在吗');

      assert.equal(fixture.endpoint.requests.length, 1, 'no tool call means no second round trip');
      const payload = requestPayload(fixture.endpoint.requests[0]!);
      assert.deepEqual(
        provider.toolDefinitions(payload),
        [],
        'a rootless round hands the provider zero tool definitions',
      );
      assert.deepEqual(
        Object.keys(payload).sort(),
        [...provider.singleCompletionKeys].sort(),
        'a round with nothing to call sends exactly the single completion it always did',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 你在吗'],
          ['agent', '没有项目根，直接回答'],
        ],
        'the rootless round behaves like the single completion it always was',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] an out-of-root path comes back as a stable tool error and the round answers`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-escape-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      writeFileSync(path.join(fixture.tmp, 'outside.txt'), 'OUTSIDE-SECRET\n');
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-escape', name: 'Read', input: { path: '../outside.txt' } }]),
        provider.text('那条路径越界了，我在根内换一个'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读 ../outside.txt');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results.length, 1);
      assert.equal(results[0]?.isError, true, 'a root escape is a tool error result');
      assert.ok(
        (results[0]?.content ?? '').includes('outside-root'),
        `the stable error code reaches the model: ${results[0]?.content ?? ''}`,
      );
      assert.equal(
        (results[0]?.content ?? '').includes('OUTSIDE-SECRET'),
        false,
        'the tool result never carries the outside file body',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 读 ../outside.txt'],
          ['agent', '那条路径越界了，我在根内换一个'],
        ],
        'a tool error is a result, not a round failure',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'replied');
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] malformed tool arguments become results and never reach the face`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-args-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-missing', name: 'Read', input: {} },
          { id: 'call-typed', name: 'Read', input: { path: 42 } },
          { id: 'call-extra', name: 'Read', input: { path: 'notes.txt', limit: 10 } },
        ]),
        provider.text('参数不对，我按 schema 重来'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读文件');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-missing', true],
          ['call-typed', true],
          ['call-extra', true],
        ],
        'a missing field, a wrong type and an extra field are all tool errors',
      );
      for (const result of results) {
        assert.ok(
          result.content.includes('invalid-arguments'),
          `the shape failure reports its own stable code: ${result.content}`,
        );
        assert.equal(
          result.content.includes('NEEDLE-ONE'),
          false,
          'a malformed call never reaches the file face',
        );
      }
      assert.equal((await messages(fixture, round.channelId))[1]?.['body'], '参数不对，我按 schema 重来');
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] an empty final text after a tool call closes the round as failed`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-empty-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }]),
        provider.text(''),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下');

      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'tool activity never substitutes for an answer',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('empty completion'),
        `the existing empty-completion rule closes the round: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] the Agent's max_iterations bounds the round trips, and a later change applies to the next round`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-cap-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      await patchMaxIterations(fixture, round.agentId, 1);

      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }], '第一批'),
        provider.toolCalls([{ id: 'call-2', name: 'Read', input: { path: 'notes.txt' } }], '第二批'),
        provider.text('这条永远不会被请求'),
      ]);
      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下');

      assert.equal(
        fixture.endpoint.requests.length,
        2,
        'a cap of 1 executes one batch and stops when the model asks for another',
      );
      assert.equal(
        provider.toolResults(requestPayload(fixture.endpoint.requests[1]!)).length,
        1,
        'exactly one tool batch was executed before the cap stopped the loop',
      );
      assert.equal(
        roundOutcomes(fixture)[0]?.finished_reason,
        ZH_CN['round.finished.iterationLimit'].text,
        'the cap of 1 the Agent was patched to is the cap the round ran under',
      );

      // The same provider behaviour — asking for a tool every turn — runs a
      // second batch once the Agent's cap is 2.
      await patchMaxIterations(fixture, round.agentId, 2);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-3', name: 'Read', input: { path: 'notes.txt' } }], '第三批'),
        provider.toolCalls([{ id: 'call-4', name: 'Read', input: { path: 'notes.txt' } }], '第四批'),
        provider.text('两批都读完了'),
      ]);
      await sendMessage(fixture, round.channelId, '@读文件的成员 再读一下');

      assert.equal(
        fixture.endpoint.requests.length,
        5,
        'a cap of 2 executes two batches and then answers',
      );
      assert.equal(
        provider.toolResults(requestPayload(fixture.endpoint.requests[4]!)).length,
        2,
        'the second round really executed two batches instead of one',
      );
      const outcomes = roundOutcomes(fixture);
      assert.equal(outcomes.length, 2, 'two wakes ran two rounds');
      assert.equal(
        outcomes[1]?.finished_reason,
        ZH_CN['round.finished.completed'].text,
        'a round the model stops by itself is a normal completion, never iteration-limit',
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] hitting the cap lands the partial conclusion as the iteration-limit reply and consumes the trigger`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-cap-partial-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      await patchMaxIterations(fixture, round.agentId, 1);
      queueReplies(fixture.endpoint, [
        provider.toolCalls(
          [{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }],
          '我先读一下这个文件。',
        ),
        provider.toolCalls(
          [{ id: 'call-2', name: 'Read', input: { path: 'notes.txt' } }],
          '部分结论：notes.txt 里有 NEEDLE-ONE，细节还想再看一眼。',
        ),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下');

      const rows = await messages(fixture, round.channelId);
      assert.deepEqual(
        rows.map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 读一下'],
          ['agent', '部分结论：notes.txt 里有 NEEDLE-ONE，细节还想再看一眼。'],
        ],
        'the turn that hit the cap is the one extra message, and it is the partial conclusion',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'replied', 'a capped round is answered, not failed');
      assert.equal(
        outcome.finished_reason,
        ZH_CN['round.finished.iterationLimit'].text,
        'the cap reads as its own finished reason',
      );
      assert.equal(
        consumedSeq(fixture, round.agentId, round.channelId),
        rows[0]?.['seq'],
        'the trigger message is consumed, so the next wake does not re-read it',
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] hitting the cap with no text closes the round as failed and lands nothing`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-cap-empty-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      await patchMaxIterations(fixture, round.agentId, 1);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }]),
        provider.toolCalls([{ id: 'call-2', name: 'Read', input: { path: 'notes.txt' } }]),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下');

      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'a capped round with no conclusion writes no message',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('empty completion'),
        `the existing empty-completion rule closes the capped round: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a provider error inside the loop fails the round and lands nothing`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-provider-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      let served = 0;
      fixture.endpoint.respondWith(() => {
        served += 1;
        return served === 1
          ? provider.toolCalls([{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }])
          : { status: 500, body: { error: { message: 'upstream exploded' } } };
      });

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下');

      assert.equal(fixture.endpoint.requests.length, 2, 'the failure happens inside the loop');
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'a provider failure writes no Agent message',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('500'),
        `the provider status is the readable reason: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] an unparseable answer fails the round and invents no tool result`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-unreadable-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      fixture.endpoint.respondWith(() => provider.unparseable());

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下 notes.txt');

      assert.equal(
        fixture.endpoint.requests.length,
        1,
        'an answer with no readable turn ends the round instead of feeding anything back',
      );
      assert.deepEqual(
        provider.toolResults(requestPayload(fixture.endpoint.requests[0]!)),
        [],
        'an unreadable answer is never turned into a tool result',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'an unreadable answer writes no Agent message',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes(`${provider.label} response`),
        `the reason names the provider shape that could not be read: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a round globs the project root and receives one path per line`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-glob-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      assert.ok(round.project !== null);
      mkdirSync(path.join(round.project, 'sub'), { recursive: true });
      writeFileSync(path.join(round.project, 'sub', 'other.txt'), 'OTHER-BODY\n');
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-glob', name: 'Glob', input: { pattern: '**/*.txt' } },
          { id: 'call-escape', name: 'Glob', input: { pattern: '*', path: '..' } },
        ]),
        provider.text('根内有两个 txt，越界那条不算'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 列出根下的 txt');

      const definitions = provider.toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
      const glob = definitions.find((definition) => definition.name === 'Glob');
      assert.ok(glob !== undefined, 'the round is handed the Glob tool');
      assert.deepEqual(glob.schema['required'], ['pattern'], 'only the pattern is required');
      assert.deepEqual(
        Object.keys(glob.schema['properties'] as Record<string, unknown>).sort(),
        ['path', 'pattern'],
        "the schema names exactly the face's two arguments",
      );

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-glob', false],
          ['call-escape', true],
        ],
        'a hit list is a result and a base outside the roots is a tool error',
      );
      assert.deepEqual(
        (results[0]?.content ?? '')
          .split('\n')
          .filter((line) => /^\S+\.txt$/.test(line))
          .sort(),
        ['notes.txt', 'sub/other.txt'],
        `the result lists one path per line: ${results[0]?.content ?? ''}`,
      );
      assert.ok(
        (results[1]?.content ?? '').includes('outside-root'),
        `a path outside the readable roots keeps the file face's stable code: ${
          results[1]?.content ?? ''
        }`,
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 列出根下的 txt'],
          ['agent', '根内有两个 txt，越界那条不算'],
        ],
        'a Glob tool error is a result, not a round failure',
      );
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a non-2xx answer fails the round and invents no tool result`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-status-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      fixture.endpoint.respondWith(() => ({
        status: 502,
        body: { error: { message: 'bad gateway' } },
      }));

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下 notes.txt');

      assert.equal(
        fixture.endpoint.requests.length,
        1,
        'a non-2xx answer ends the round instead of feeding anything back',
      );
      assert.deepEqual(
        provider.toolResults(requestPayload(fixture.endpoint.requests[0]!)),
        [],
        'a provider status is never turned into a tool result',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'a non-2xx answer writes no Agent message',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('502'),
        `the provider status is the readable reason: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a denied approval comes back as a DENIED tool result and the round answers`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-denied-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      await putReadAskRule(fixture, round.channelId, 'notes.txt');
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-denied', name: 'Read', input: { path: 'notes.txt' } }]),
        provider.text('读被拒绝了，我按已知信息回答'),
      ]);

      // The round blocks on the approval, so the POST settles only after the
      // human decision; the wake itself is awaited at the end.
      const sent = postJson(fixture, `/api/targets/${round.channelId}/messages`, {
        body: '@读文件的成员 读一下 notes.txt',
      });
      const pending = await waitForPending(fixture);
      assert.equal(pending.tool_calls[0]?.tool_name, 'Read', 'a plain read behind an ask rule waits');
      const denied = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
        tool_call_id: pending.tool_calls[0]!.tool_call_id,
        confirmed: false,
      });
      assert.equal(denied.status, 200, await denied.clone().text());
      const response = await sent;
      assert.equal(response.status, 201, await response.clone().text());

      assert.equal(
        fixture.endpoint.requests.length,
        2,
        'the denial is fed back and the model gets another turn',
      );
      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [['call-denied', true]],
        'a denial is a tool error result, never a round failure',
      );
      assert.ok(
        (results[0]?.content ?? '').includes('denied'),
        `the stable code reaches the model: ${results[0]?.content ?? ''}`,
      );
      assert.equal(
        (results[0]?.content ?? '').includes('NEEDLE-ONE'),
        false,
        'a denied read never carries the file body',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@读文件的成员 读一下 notes.txt'],
          ['agent', '读被拒绝了，我按已知信息回答'],
        ],
        'the round still answers after a denial',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'replied');
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] an approval that times out fails the round and is never a tool result`, async () => {
    const fixture = await startFixture(
      `allibot-tool-loop-approval-timeout-${provider.label}-`,
      provider,
      undefined,
      { args: ['--approval-timeout-ms', '200'] },
    );
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      await putReadAskRule(fixture, round.channelId, 'notes.txt');
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-waits', name: 'Read', input: { path: 'notes.txt' } }]),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下 notes.txt');

      assert.equal(
        fixture.endpoint.requests.length,
        1,
        'the timeout is never fed back, so no further turn is taken',
      );
      assert.deepEqual(
        provider.toolResults(requestPayload(fixture.endpoint.requests[0]!)),
        [],
        'the first request carries no tool result at all',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'a timed-out approval writes no Agent message',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('审批等待超时'),
        `the existing approval-timeout copy is the reason: ${outcome.reason}`,
      );
      assert.equal(
        outcome.reason.includes('模型调用失败'),
        false,
        `an approval timeout is not a model-call failure: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a round greps the project root and receives path:line: text`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-grep-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      assert.ok(round.project !== null);
      mkdirSync(path.join(round.project, 'sub'), { recursive: true });
      writeFileSync(path.join(round.project, 'sub', 'other.txt'), 'FIRST\nSECOND-NEEDLE-TWO\n');
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-grep', name: 'Grep', input: { pattern: 'NEEDLE' } }]),
        provider.text('两行命中'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 搜 NEEDLE');

      const definitions = provider.toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
      const grep = definitions.find((definition) => definition.name === 'Grep');
      assert.ok(grep !== undefined, 'the round is handed the Grep tool');
      assert.deepEqual(grep.schema['required'], ['pattern'], 'only the pattern is required');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results[0]?.isError, false, 'a grep hit list is a successful result');
      assert.deepEqual(
        (results[0]?.content ?? '')
          .split('\n')
          .filter((line) => /^\S+:\d+: /.test(line)),
        ['notes.txt:1: NEEDLE-ONE', 'sub/other.txt:2: SECOND-NEEDLE-TWO'],
        `every hit is one path:line: text line: ${results[0]?.content ?? ''}`,
      );
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a grep hit list that is exactly the cap is not reported as capped`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-grep-exact-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      assert.ok(round.project !== null);
      const lines = Array.from({ length: 200 }, (_unused, index) => `NEEDLE-${index + 1}`);
      writeFileSync(path.join(round.project, 'notes.txt'), `${lines.join('\n')}\n`);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-grep', name: 'Grep', input: { pattern: 'NEEDLE' } }]),
        provider.text('两百条'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 搜 NEEDLE');

      const content = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!))[0]?.content ?? '';
      assert.equal(
        content.split('\n').filter((line) => /^\S+:\d+: /.test(line)).length,
        200,
        `every one of the 200 hits is listed: ${content}`,
      );
      assert.ok(
        !content.includes(ZH_CN['tool.grep.capped.matches'].text.slice(0, 6)),
        `a full but complete hit list carries no cap fact: ${content}`,
      );
      assert.ok(!content.includes('还有更多匹配'), `no cap wording: ${content}`);
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a grep hit list over the cap says more matches exist`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-grep-capped-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      assert.ok(round.project !== null);
      const lines = Array.from({ length: 201 }, (_unused, index) => `NEEDLE-${index + 1}`);
      writeFileSync(path.join(round.project, 'notes.txt'), `${lines.join('\n')}\n`);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-grep', name: 'Grep', input: { pattern: 'NEEDLE' } }]),
        provider.text('只有前两百条'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 搜 NEEDLE');

      const content = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!))[0]?.content ?? '';
      assert.equal(
        content.split('\n').filter((line) => /^\S+:\d+: /.test(line)).length,
        200,
        `the list stops at the cap: ${content}`,
      );
      assert.ok(
        content.includes(
          ZH_CN['tool.grep.capped.matches'].text.replace('{limit}', '200'),
        ),
        `the model is told more matches exist: ${content}`,
      );
      assert.ok(!content.includes('还有文件未扫描'), `the other reason is not claimed: ${content}`);
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a read result over the re-feed cap is cut and says so`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-refeed-cap-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      assert.ok(round.project !== null);
      writeFileSync(
        path.join(round.project, 'big.txt'),
        `HEAD-OF-FILE\n${'x'.repeat(30000)}\nEND-OF-FILE\n`,
      );
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-read', name: 'Read', input: { path: 'big.txt' } }]),
        provider.text('文件很长'),
      ]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 读 big.txt');

      const content = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!))[0]?.content ?? '';
      assert.ok(content.startsWith('[Read] ok'), `the result keeps its state line: ${content.slice(0, 40)}`);
      assert.ok(content.includes('已截断'), `the cut is explicit: ${content.slice(-160)}`);
      assert.ok(content.includes('已给 20000 字'), `the kept size is named: ${content.slice(-160)}`);
      assert.ok(!content.includes('END-OF-FILE'), 'the tail past the cap never reaches the model');
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a round with no Plan face is handed no Plan tool`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-noplan-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      queueReplies(fixture.endpoint, [provider.text('这个频道没有计划面')]);

      await sendMessage(fixture, round.channelId, '@读文件的成员 列出你的计划');

      const names = provider
        .toolDefinitions(requestPayload(fixture.endpoint.requests[0]!))
        .map((definition) => definition.name);
      assert.deepEqual(
        names,
        ['Read', 'Glob', 'Grep'],
        'an autonomous channel round carries the file tools only',
      );
      assert.deepEqual(
        names.filter((name) => name.startsWith('Task')),
        [],
        'TaskList and TaskGet are absent from the request, not merely refused',
      );
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a task round lists the items of its own Plan run`, async () => {
    const fixture = await startFixture(
      `allibot-tool-loop-tasklist-${provider.label}-`,
      provider,
      async (setup) => await seedPlanRound(setup, provider, { withRoot: false }),
    );
    try {
      const plan = fixture.plan;
      assert.ok(plan !== null);
      await confirmRemoteDataFlow(fixture, provider);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-list', name: 'TaskList', input: {} }]),
        provider.text('计划共两条'),
      ]);

      await sendMessage(fixture, plan.taskTargetId, '@读计划的成员 现在计划是什么');

      const definitions = provider.toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
      assert.deepEqual(
        definitions.map((definition) => definition.name),
        ['TaskList', 'TaskGet'],
        'a Plan round without a project root carries exactly the read-only Plan tools',
      );
      const list = definitions.find((definition) => definition.name === 'TaskList');
      assert.deepEqual(list?.schema['properties'], {}, 'TaskList takes no argument');
      assert.deepEqual(list?.schema['required'], []);

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results[0]?.isError, false, 'reading the run is a successful result');
      const content = results[0]?.content ?? '';
      assert.ok(
        content.includes(`- [in_progress] PLAN-ITEM-ONE-UPDATED (${plan.taskIds[0]})`),
        `the list states status, title and id: ${content}`,
      );
      assert.ok(
        content.includes(`- [pending] PLAN-ITEM-TWO (${plan.taskIds[1]})`),
        `every item of the run is listed: ${content}`,
      );
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] TaskGet answers one item and reports a missing id as a result`, async () => {
    const fixture = await startFixture(
      `allibot-tool-loop-taskget-${provider.label}-`,
      provider,
      async (setup) => await seedPlanRound(setup, provider, { withRoot: false }),
    );
    try {
      const plan = fixture.plan;
      assert.ok(plan !== null);
      await confirmRemoteDataFlow(fixture, provider);
      const existingId = plan.taskIds[0] ?? '';
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-get', name: 'TaskGet', input: { id: existingId } },
          { id: 'call-missing', name: 'TaskGet', input: { id: 'no-such-item' } },
        ]),
        provider.text('一条在，一条不在'),
      ]);

      await sendMessage(fixture, plan.taskTargetId, '@读计划的成员 第一条是什么');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-get', false],
          ['call-missing', true],
        ],
        'a missing item is a tool error result, not a round failure',
      );
      const found = results[0]?.content ?? '';
      assert.ok(found.includes(`id: ${existingId}`), `the item is named by id: ${found}`);
      assert.ok(
        found.includes('title: PLAN-ITEM-ONE-UPDATED'),
        `the item states its title: ${found}`,
      );
      assert.ok(found.includes('status: in_progress'), `the item states its status: ${found}`);
      assert.ok(
        (results[1]?.content ?? '').includes('not-found'),
        `the missing id keeps a stable code: ${results[1]?.content ?? ''}`,
      );
      const landed = await messages(fixture, plan.taskTargetId);
      assert.equal(
        landed[landed.length - 1]?.['body'],
        '一条在，一条不在',
        'the tool error still lands the round answer',
      );
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a provider call that never answers times out as a round failure`, async () => {
    // The production single-call timeout is 60 s (D9); letting it fire for real
    // is the only way to prove the boundary without faking the abort.
    const hanging = await startHangingEndpoint();
    const fixture = await startFixture(
      `allibot-tool-loop-slow-provider-${provider.label}-`,
      provider,
      undefined,
      { env: provider.env(hanging.baseUrl) },
    );
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      fixture.endpoint.respondWith(() => provider.text('never used'));
      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下 notes.txt');

      assert.equal(hanging.requests(), 1, 'the round made exactly one call');
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'a timed-out call writes no Agent message',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('timed out'),
        `the reason names the timeout: ${outcome.reason}`,
      );
      assert.ok(
        outcome.reason.includes(`${provider.label} request timed out after 60000ms`),
        `the reason names the provider line and the single-call budget: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
      await hanging.stop();
    }
  });

  test(`[${provider.label}] a second-round provider error echoing the credential lands only as a masked reason`, async () => {
    const fixture = await startFixture(`allibot-tool-loop-mask-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: true });
      const events = await connectEvents(fixture.base);
      let served = 0;
      fixture.endpoint.respondWith(() => {
        served += 1;
        return served === 1
          ? provider.toolCalls([{ id: 'call-1', name: 'Read', input: { path: 'notes.txt' } }])
          : {
              status: 500,
              body: { error: { message: `Incorrect API key provided: ${PROVIDER_KEY}` } },
            };
      });

      await sendMessage(fixture, round.channelId, '@读文件的成员 读一下 notes.txt');

      assert.equal(fixture.endpoint.requests.length, 2, 'the failure happens inside the loop');
      const frame = await events.waitFor('round.outcome', 3_000);
      assert.ok(frame !== null, 'the failed round publishes its outcome');
      assertNoCredential(events.raw(), 'the SSE stream');
      assertNoCredential(
        fixture.running.logs().stdout + fixture.running.logs().stderr,
        'process output',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('500'),
        `the provider status is part of the readable reason: ${outcome.reason}`,
      );
      assert.ok(
        outcome.reason.includes(PROVIDER_KEY.slice(-4)),
        `only the masked tail survives: ${outcome.reason}`,
      );
      assertNoCredential(outcome.reason, 'the round reason');
      events.close();
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] malformed arguments never reach any face of the batch`, async () => {
    const fixture = await startFixture(
      `allibot-tool-loop-shape-${provider.label}-`,
      provider,
      async (setup) => await seedPlanRound(setup, provider, { withRoot: true }),
    );
    try {
      const plan = fixture.plan;
      assert.ok(plan !== null);
      await confirmRemoteDataFlow(fixture, provider);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-missing', name: 'Grep', input: {} },
          { id: 'call-typed', name: 'Glob', input: { pattern: 42 } },
          { id: 'call-extra', name: 'TaskList', input: { limit: 1 } },
          { id: 'call-no-id', name: 'TaskGet', input: {} },
        ]),
        provider.text('四个参数都不合形状，我按 schema 重来'),
      ]);

      await sendMessage(fixture, plan.taskTargetId, '@读计划的成员 用这四个工具');

      assert.deepEqual(
        provider
          .toolDefinitions(requestPayload(fixture.endpoint.requests[0]!))
          .map((definition) => definition.name),
        ['Read', 'Glob', 'Grep', 'TaskList', 'TaskGet'],
        'a task round with a project root is handed the whole batch',
      );

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-missing', true],
          ['call-typed', true],
          ['call-extra', true],
          ['call-no-id', true],
        ],
        'a missing field, a wrong type and an extra field are all tool errors',
      );
      for (const result of results) {
        assert.ok(
          result.content.includes('invalid-arguments'),
          `the shape failure reports its own stable code: ${result.content}`,
        );
        for (const forbidden of ['PLAN-ITEM', 'NEEDLE-ONE', ...plan.taskIds]) {
          assert.equal(
            result.content.includes(forbidden),
            false,
            `a malformed call never reaches a face: ${result.content}`,
          );
        }
      }
      assert.deepEqual(
        (await planItems(fixture, plan.taskTargetId)).map((item) => item.id),
        plan.taskIds,
        'no refused call changed the run',
      );
      assert.equal(latestOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });
}
