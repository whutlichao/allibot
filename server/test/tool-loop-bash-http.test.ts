import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '@allibot/shared';
import { MAX_SHELL_OUTPUT_BYTES } from '../dist/local-shell.js';
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
 * `Bash` 进轮内循环 (#75 / T9 / D4 / D6 / D10): a real model round requests the
 * execution tool, the round blocks on the one approval the shell always asks,
 * and the command's own result — exit code, stderr, truncated output — is what
 * the model reads back.
 *
 * The one seam is the backend HTTP face: a real process, a temporary data
 * directory and `startRecordingEndpoint` answering in Anthropic's wire shape.
 * Nothing here reaches into the adapter; the approval, the working directory
 * and the output cap are the production faces' own answers, and every case is
 * observed through the recorded provider request, the human REST face and the
 * round's own rows.
 *
 * One provider row is enough here: the wire shape of a tool result is batch
 * one's subject (#58) and `model-tool-loop-http.test.ts` owns that matrix. This
 * file owns what is specific to the execution tool.
 */

/** The sentinel credential the recording endpoint's env carries. */
const PROVIDER_KEY = 'sk-bash-loop-0123456789abcdefghij-wxyz';

/** The one model this file's Agent is configured with. */
const MODEL = 'anthropic:claude-sonnet-4-5';

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
        content: typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content']),
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

/** The request body's keys for a round with no tool available, sorted. */
const SINGLE_COMPLETION_KEYS = ['max_tokens', 'messages', 'model', 'system'];

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
  channelId: string;
  /** The project root path this round would run in; unused when `withRoot: false`. */
  project: string;
}

/**
 * Open the target context a round runs in: an Agent with the model adapter, the
 * consent it needs, an autonomous channel and its workspace switch. `withRoot`
 * false leaves the channel rootless, which is the "no project root" case.
 */
async function openRound(
  fixture: Fixture,
  options: { allowLocalShell?: 0 | 1; withRoot?: boolean } = {},
): Promise<RoundTarget> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '跑命令的成员',
    model: MODEL,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agentId = (await readJson(created))['id'] as string;
  await confirmRemoteDataFlow(fixture);

  const channel = await postJson(fixture, '/api/channels', {
    name: '命令循环频道',
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
  if (options.withRoot !== false) {
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'NEEDLE-ONE\n');
  }
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    ...(options.withRoot === false ? {} : { workspace_root: project }),
    allow_local_shell: options.allowLocalShell ?? 1,
  });
  assert.equal(patched.status, 200, await patched.clone().text());
  return { agentId, channelId, project };
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

async function getApproval(fixture: Fixture, replyId: string): Promise<PendingApproval> {
  const response = await fetch(`${fixture.base}/api/approvals/${replyId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response)) as unknown as PendingApproval;
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
 * Send one trigger message, decide the one approval the shell call registers,
 * and wait for the round's write to settle. A `Bash` call always asks, so the
 * POST only returns after the decision.
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
  assert.ok(call !== undefined, 'the shell call registered one approval call');
  const decided = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
    tool_call_id: call.tool_call_id,
    confirmed: options.confirm,
  });
  assert.equal(decided.status, 200, await decided.clone().text());
  const response = await sent;
  assert.equal(response.status, 201, await response.clone().text());
  return pending;
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

test('a Bash call is approved, runs in the project root, and its output is the tool result', async () => {
  const fixture = await startFixture('allibot-bash-approved-');
  try {
    const round = await openRound(fixture);
    const command = 'pwd -P && printf BASH-RAN > bash-ran.txt';
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-root', name: 'Bash', input: { command } }], '我跑一条命令看看。'),
      answer('命令在项目根跑完了'),
    ]);

    const pending = await sendAndDecide(fixture, round.channelId, '@跑命令的成员 看看当前目录', {
      confirm: true,
    });

    const call = pending.tool_calls[0]!;
    assert.equal(call.tool_name, 'Bash', 'the shell call asks under its product name');
    assert.equal(call.pattern, command, 'the approval pattern is the command string');
    assert.deepEqual(
      call.arguments,
      { tool_name: 'Bash', command },
      'the approval summary carries the command and no working directory',
    );
    assert.equal(
      (await getApproval(fixture, pending.reply_id)).status,
      'confirmed',
      'the human decision is the batch outcome',
    );

    const definitions = toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash'],
      'a round with a root and the local shell switch on is handed the execution tool',
    );
    const bash = definitions.find((definition) => definition.name === 'Bash');
    assert.ok(bash !== undefined, 'the round is handed the Bash tool');
    assert.deepEqual(bash.schema['required'], ['command'], 'the command is the one required argument');
    assert.deepEqual(
      Object.keys(bash.schema['properties'] as Record<string, unknown>),
      ['command'],
      'the tool has no working-directory argument: the root is not the model’s to choose',
    );
    assert.ok(bash.description.length > 0, 'the tool definition explains what the tool does');

    assert.equal(fixture.endpoint.requests.length, 2, 'the approved command feeds its result back');
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1, 'the second request carries one tool result');
    assert.equal(results[0]?.id, 'call-root');
    assert.equal(results[0]?.isError, false, 'an approved command is not a tool error');
    const content = results[0]?.content ?? '';
    assert.ok(content.startsWith('[Bash] ok'), `the result states its own outcome: ${content}`);
    assert.ok(content.includes(`command: ${command}`), `the result names the command: ${content}`);
    assert.ok(
      content.includes(`cwd: ${realpathSync(round.project)}`),
      `the process ran in the project root: ${content}`,
    );
    assert.ok(content.includes('exit-code: 0'), `the exit code is the tool's own fact: ${content}`);
    assert.ok(
      content.split('\n').includes(realpathSync(round.project)),
      `the command itself saw the project root: ${content}`,
    );

    assert.equal(
      readFileSync(path.join(round.project, 'bash-ran.txt'), 'utf8'),
      'BASH-RAN',
      'the approved command really ran in the project root',
    );
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
      [
        ['human', '@跑命令的成员 看看当前目录'],
        ['agent', '命令在项目根跑完了'],
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

test('a non-zero exit code and its stderr come back as the tool result and the model reroutes', async () => {
  const fixture = await startFixture('allibot-bash-exit-');
  try {
    const round = await openRound(fixture);
    const command = 'printf BASH-STDERR >&2; exit 3';
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-fail', name: 'Bash', input: { command } }]),
      answer('这条命令退出了 3，我改道回答'),
    ]);

    await sendAndDecide(fixture, round.channelId, '@跑命令的成员 跑一条会失败的', {
      confirm: true,
    });

    assert.equal(fixture.endpoint.requests.length, 2, 'a failing command still feeds its result back');
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.id, 'call-fail');
    assert.equal(
      results[0]?.isError,
      false,
      'a non-zero exit is the command\'s own result, not a tool error',
    );
    const content = results[0]?.content ?? '';
    assert.ok(content.includes('exit-code: 3'), `the exit code reaches the model: ${content}`);
    assert.ok(content.includes('BASH-STDERR'), `the stderr body reaches the model: ${content}`);

    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
      [
        ['human', '@跑命令的成员 跑一条会失败的'],
        ['agent', '这条命令退出了 3，我改道回答'],
      ],
      'a failed command is a result, not a round failure: the final text still lands',
    );
    const outcome = roundOutcome(fixture);
    assert.equal(outcome.status, 'replied');
    assert.equal(outcome.finished_reason, ZH_CN['round.finished.completed'].text);
  } finally {
    await fixture.stop();
  }
});

test('a command that does not exist comes back as a tool result, not a round failure', async () => {
  const fixture = await startFixture('allibot-bash-missing-');
  try {
    const round = await openRound(fixture);
    queueReplies(fixture.endpoint, [
      toolCalls([
        { id: 'call-missing', name: 'Bash', input: { command: 'allibot-no-such-command-xyz' } },
      ]),
      answer('没有这条命令，我换一条路'),
    ]);

    await sendAndDecide(fixture, round.channelId, '@跑命令的成员 跑一条不存在的命令', {
      confirm: true,
    });

    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1);
    const content = results[0]?.content ?? '';
    assert.ok(content.includes('exit-code: 127'), `a missing command is an exit code: ${content}`);
    assert.ok(content.includes('stderr:'), `the result keeps both streams: ${content}`);
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human', 'agent'],
      'the model reroutes and answers',
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('a denied Bash call comes back as DENIED and the round continues', async () => {
  const fixture = await startFixture('allibot-bash-denied-');
  try {
    const round = await openRound(fixture);
    const command = 'printf NOPE > denied.txt';
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-denied', name: 'Bash', input: { command } }]),
      answer('被拒绝了，我不执行这条命令'),
    ]);

    const pending = await sendAndDecide(fixture, round.channelId, '@跑命令的成员 写一个文件', {
      confirm: false,
    });
    assert.equal(
      (await getApproval(fixture, pending.reply_id)).status,
      'denied',
      'the approval row records the refusal',
    );

    assert.equal(
      fixture.endpoint.requests.length,
      2,
      'the denial is fed back and the model gets another turn',
    );
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true, 'a denial is a tool error result');
    const content = results[0]?.content ?? '';
    assert.ok(content.includes('denied'), `the stable code reaches the model: ${content}`);
    assert.ok(content.includes('DENIED'), `a denial reads as DENIED: ${content}`);
    assert.equal(
      existsSync(path.join(round.project, 'denied.txt')),
      false,
      'a denied command never runs',
    );

    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => [message['kind'], message['body']]),
      [
        ['human', '@跑命令的成员 写一个文件'],
        ['agent', '被拒绝了，我不执行这条命令'],
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

test('an approval that times out closes the round failed and is never a tool result', async () => {
  const fixture = await startFixture('allibot-bash-timeout-', {
    args: ['--approval-timeout-ms', '200'],
  });
  try {
    const round = await openRound(fixture);
    const command = 'printf TIMEOUT > timeout.txt';
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-waits', name: 'Bash', input: { command } }]),
      answer('这条永远不会被请求'),
    ]);

    await sendMessage(fixture, round.channelId, '@跑命令的成员 跑一条要等的命令');

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
    assert.equal(
      existsSync(path.join(round.project, 'timeout.txt')),
      false,
      'a timed-out approval never runs the command',
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

test('a Bash output cut at the shell cap says so above the bodies, and that fact survives the re-feed cap', async () => {
  const fixture = await startFixture('allibot-bash-truncated-');
  try {
    const round = await openRound(fixture);
    // Just over the 1 MiB capture cap: the shell keeps a head of the stream and
    // states the cut; the model's copy is then cut again at 20000 characters.
    const command = 'yes BASH-TRUNCATE-ROW | head -c 1100000';
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-long', name: 'Bash', input: { command } }]),
      answer('输出太长了，我只看到开头一段'),
    ]);

    await sendAndDecide(fixture, round.channelId, '@跑命令的成员 输出很多东西', { confirm: true });

    const content = toolResults(requestPayload(fixture.endpoint.requests[1]!))[0]?.content ?? '';
    const fact = ZH_CN['tool.bash.output.truncated'].text.replace(
      '{limit}',
      String(MAX_SHELL_OUTPUT_BYTES),
    );
    const lines = content.split('\n');
    const factLine = lines.findIndex((line) => line.includes(fact));
    const bodyLine = lines.indexOf('stdout:');
    assert.ok(content.startsWith('[Bash] ok'), `the result keeps its state line: ${content.slice(0, 40)}`);
    assert.ok(factLine !== -1, `the shell's own cut is explicit: ${content.slice(0, 400)}`);
    assert.ok(
      bodyLine !== -1 && factLine < bodyLine,
      `the cut is stated before the body it cuts: ${content.slice(0, 400)}`,
    );
    assert.ok(
      content.length < 20500,
      `the model's copy is still capped: ${String(content.length)} characters`,
    );
    assert.ok(
      content.includes('已给 20000 字'),
      `the re-feed cap is stated too: ${content.slice(-200)}`,
    );
    assert.equal(
      content.trimEnd().endsWith('BASH-TRUNCATE-ROW'),
      false,
      'the copy ends with the cut fact, not with the full output',
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('a working-directory argument is refused before the shell face runs', async () => {
  const fixture = await startFixture('allibot-bash-cwd-');
  try {
    const round = await openRound(fixture);
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-cwd', name: 'Bash', input: { command: 'pwd -P', cwd: '/' } }]),
      answer('Bash 不接受 cwd 参数，我不另选工作目录'),
    ]);

    await sendMessage(fixture, round.channelId, '@跑命令的成员 从根目录跑一条命令');

    assert.equal(
      fixture.endpoint.requests.length,
      2,
      'the refused call is fed back and the model gets another turn',
    );
    const results = toolResults(requestPayload(fixture.endpoint.requests[1]!));
    assert.equal(results.length, 1);
    assert.equal(results[0]?.isError, true, 'an extra argument is a tool error result');
    const content = results[0]?.content ?? '';
    assert.ok(content.includes('invalid-arguments'), `the stable code reaches the model: ${content}`);
    assert.ok(content.includes('unexpected argument: cwd'), `the refusal names the argument: ${content}`);
    assert.deepEqual(
      await listApprovals(fixture),
      [],
      'the refused call never reaches the shell face, so it never asks',
    );
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human', 'agent'],
      'a refused argument is a result, not a round failure',
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('allow_local_shell=0 hands the model no Bash at all', async () => {
  const fixture = await startFixture('allibot-bash-disabled-');
  try {
    const round = await openRound(fixture, { allowLocalShell: 0 });
    queueReplies(fixture.endpoint, [answer('这个频道没开本机 shell')]);

    await sendMessage(fixture, round.channelId, '@跑命令的成员 你在吗');

    const definitions = toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
    assert.deepEqual(
      definitions.map((definition) => definition.name),
      ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
      'a round with the shell switch off is handed the file tools and no Bash',
    );
    assert.equal(
      definitions.some((definition) => definition.name === 'Bash'),
      false,
      'Bash is absent from the request, not merely refused at call time',
    );
    assert.equal(roundOutcomes(fixture)[0]?.status, 'replied');

    // A model that asks anyway gets a tool result, and still no approval: the
    // switch decides the offered set, not the call's answer.
    queueReplies(fixture.endpoint, [
      toolCalls([{ id: 'call-forced', name: 'Bash', input: { command: 'pwd -P' } }]),
      answer('这个轮次没有 Bash 可用'),
    ]);
    await sendMessage(fixture, round.channelId, '@跑命令的成员 跑一条 pwd');

    const results = toolResults(requestPayload(fixture.endpoint.requests[2]!));
    assert.equal(results[0]?.isError, true);
    assert.ok(
      (results[0]?.content ?? '').includes('unknown-tool'),
      `a tool this round does not offer is a tool error: ${results[0]?.content ?? ''}`,
    );
    assert.deepEqual(await listApprovals(fixture), [], 'the switch off never asks');
    assert.equal(roundOutcomes(fixture)[1]?.status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('a round with no project root is handed no Bash and sends the single completion', async () => {
  const fixture = await startFixture('allibot-bash-noroot-');
  try {
    const round = await openRound(fixture, { withRoot: false });
    queueReplies(fixture.endpoint, [answer('这个频道没有项目根')]);

    await sendMessage(fixture, round.channelId, '@跑命令的成员 你在吗');

    assert.equal(fixture.endpoint.requests.length, 1, 'no tool call means no second round trip');
    const payload = requestPayload(fixture.endpoint.requests[0]!);
    assert.deepEqual(
      toolDefinitions(payload),
      [],
      'a rootless round hands the provider zero tool definitions, Bash included',
    );
    assert.deepEqual(
      Object.keys(payload).sort(),
      [...SINGLE_COMPLETION_KEYS].sort(),
      'a round with no shell face sends exactly the single completion it always did',
    );
    assert.deepEqual(
      (await messages(fixture, round.channelId)).map((message) => message['kind']),
      ['human', 'agent'],
    );
    assert.equal(roundOutcome(fixture).status, 'replied');
  } finally {
    await fixture.stop();
  }
});
