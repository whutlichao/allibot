import assert from 'node:assert/strict';
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

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  endpoint: RecordingEndpoint;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startFixture(prefix: string, provider: ProviderRow): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const endpoint = await startRecordingEndpoint();
  const running = await startServer(dataDir, {
    args: ['--provider', 'model'],
    env: { HOME: home, ...provider.env(endpoint.baseUrl) },
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

async function postJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
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

  const confirmed = await postJson(fixture, `/api/remote-data-flow/${provider.provider}/consent`, {});
  assert.equal(confirmed.status, 200, await confirmed.clone().text());

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

async function sendMessage(fixture: Fixture, targetId: string, body: string): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
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

function requestPayload(request: { body: string }): Record<string, unknown> {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return payload as Record<string, unknown>;
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
        ['Read'],
        'the request carries exactly the round tool this batch offers',
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
}
