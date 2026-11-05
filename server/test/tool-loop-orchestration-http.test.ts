import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync } from 'node:fs';
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
 * 编排类工具与结构化通道 (#77 / T11 / D3 / D4 / D11): the real model drives the
 * team assignment, the structured task action, the Plan write tools and the
 * SOP verifier's verdict through dedicated tools — never through prose.
 *
 * The one seam is the backend HTTP face: a real process, a temporary data
 * directory and `startRecordingEndpoint` answering in the provider's own wire
 * shape. Every case runs on both provider rows, so neither the wire shape nor
 * the structured channel can drift on one side only.
 */

/** The sentinel credential the recording endpoint's env carries. */
const PROVIDER_KEY = 'sk-orchestration-0123456789abcdefghij-wxyz';

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
  schema: Record<string, unknown>;
}

/** One tool result a recorded request fed back, normalized across providers. */
interface ToolResultShape {
  id: string;
  content: string;
  isError: boolean;
}

/**
 * One provider's wire shape. This file owns what is specific to the
 * orchestration tools and the structured channel; `model-tool-loop-http.test.ts`
 * owns the general parsing matrix, and both rows here answer the same cases.
 */
interface ProviderRow {
  label: 'anthropic' | 'openai';
  model: string;
  provider: 'anthropic' | 'openai';
  env: (baseUrl: string) => NodeJS.ProcessEnv;
  path: string;
  /** One assistant turn that requests the given tool calls. */
  toolCalls: (calls: readonly ToolCallShape[], narration?: string) => RecordedReply;
  /** One assistant turn that carries text and asks for nothing. */
  text: (body: string) => RecordedReply;
  /** One assistant turn that carries no text at all: the empty completion. */
  emptyText: () => RecordedReply;
  toolDefinitions: (payload: Record<string, unknown>) => ToolDefinitionShape[];
  toolResults: (payload: Record<string, unknown>) => ToolResultShape[];
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
  emptyText: () => ({ status: 200, body: { content: [{ type: 'text', text: '' }] } }),
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
          content:
            typeof block['content'] === 'string' ? block['content'] : JSON.stringify(block['content']),
          isError: block['is_error'] === true,
        });
      }
    }
    return results;
  },
};

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
  emptyText: () => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: '' } }] },
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
        // This wire shape has no `is_error`: a failed call states its stable
        // code as the first line of its content.
        isError: /^\[[^\]]+\] error: /.test(content),
      });
    }
    return results;
  },
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

/**
 * Start one backend on the real model provider, pointed at the recording
 * endpoint. The endpoint answers per case, so a case arranges one reply per
 * request its round makes.
 */
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

async function getJson(fixture: Fixture, route: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}${route}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

/** The one-time remote-data-flow consent the model adapter needs before it calls. */
async function confirmRemoteDataFlow(fixture: Fixture, provider: ProviderRow): Promise<void> {
  const confirmed = await postJson(fixture, `/api/remote-data-flow/${provider.provider}/consent`, {});
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

async function createAgent(fixture: Fixture, provider: ProviderRow, name: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: name,
    model: provider.model,
    // A member that claims a task by itself would run a round the case did not
    // arrange; every case here wakes its round by a message instead.
    auto_claim: 0,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createChannel(fixture: Fixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '编排工具频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 10,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(fixture: Fixture, channelId: string, memberId: string): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function makeTeam(fixture: Fixture, channelId: string, leaderId: string): Promise<void> {
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    mode: 'team',
    team_leader_member_id: leaderId,
  });
  assert.equal(patched.status, 200, await patched.clone().text());
}

async function setWorkspaceRoot(
  fixture: Fixture,
  channelId: string,
  name: string,
): Promise<void> {
  const root = path.join(fixture.tmp, name);
  mkdirSync(root, { recursive: true });
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, { workspace_root: root });
  assert.equal(patched.status, 200, await patched.clone().text());
}

async function createTask(
  fixture: Fixture,
  channelId: string,
  title: string,
): Promise<{ id: string; targetId: string }> {
  const created = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(created.status, 201, await created.clone().text());
  const body = await readJson(created);
  return { id: body['id'] as string, targetId: body['target_id'] as string };
}

async function assignTask(fixture: Fixture, taskId: string, memberId: string): Promise<void> {
  const assigned = await patchJson(fixture, `/api/tasks/${taskId}`, {
    assignee_member_id: memberId,
  });
  assert.equal(assigned.status, 200, await assigned.clone().text());
}

async function sendMessage(fixture: Fixture, targetId: string, body: string): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

async function messages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  return (await getJson(fixture, `/api/targets/${targetId}/messages?limit=50`))[
    'messages'
  ] as Record<string, unknown>[];
}

interface PlanItemShape {
  id: string;
  title: string;
  status: string;
  position: number;
}

/** The current Plan run's items, read through the ordinary read model. */
async function planItems(fixture: Fixture, targetId: string): Promise<PlanItemShape[]> {
  const body = await getJson(fixture, `/api/targets/${targetId}/plans`);
  const plans = body['plans'] as Record<string, unknown>[];
  return (plans[0]?.['tasks'] ?? []) as PlanItemShape[];
}

interface AssignmentShape {
  state: string;
  member_id: string;
  task_id: string | null;
  jump_consumed: number;
  reply_excerpt: string | null;
}

/** The target's team runs with their nested assignments, through the read model. */
async function teamRuns(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  return (await getJson(fixture, `/api/targets/${targetId}/team-runs?limit=5`))[
    'team_runs'
  ] as Record<string, unknown>[];
}

interface OutcomeRow {
  member_id: string;
  status: string;
  reason: string;
  finished_reason: string | null;
}

function roundOutcomes(fixture: Fixture): OutcomeRow[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT member_id, status, reason, finished_reason FROM round_outcome ORDER BY rowid')
      .all() as OutcomeRow[];
  } finally {
    db.close();
  }
}

/**
 * One SOP definition with a single step: the shortest shape that runs one
 * executor round and one verifier round, which is what the structured verdict
 * needs.
 */
async function createSop(
  fixture: Fixture,
  channelId: string,
  params: { executorId: string; verifierId: string; maxAttempts: number },
): Promise<string> {
  const created = await postJson(fixture, '/api/sops', {
    channel_id: channelId,
    name: '结构化判定流程',
    steps: [
      {
        title: '唯一步骤',
        description: '做一件事',
        executor_member_id: params.executorId,
        verifier_member_id: params.verifierId,
        max_attempts: params.maxAttempts,
      },
    ],
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function startSopRun(fixture: Fixture, definitionId: string): Promise<string> {
  const started = await postJson(fixture, `/api/sops/${definitionId}/runs`, {});
  assert.equal(started.status, 202, await started.clone().text());
  return (await readJson(started))['id'] as string;
}

/**
 * The SOP run's settled reading: the executor and verifier rounds run in the
 * background of the start call, so the case polls the ordinary read model until
 * the run leaves `running` / `awaiting`.
 */
async function finishedSopRun(fixture: Fixture, runId: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 20_000;
  for (;;) {
    const run = await getJson(fixture, `/api/sop-runs/${runId}`);
    const phase = run['phase'];
    if (phase !== 'running' && phase !== 'awaiting' && phase !== 'pending') {
      return run;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for the SOP run to close; last: ${JSON.stringify(run)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

/** One SOP run's recorded step, the one place the structured verdict is stored. */
function sopStep(run: Record<string, unknown>): Record<string, unknown> {
  const state = run['state'] as Record<string, unknown>;
  const steps = state['steps'] as Record<string, unknown>[];
  const step = steps[0];
  assert.ok(step !== undefined, `the run records its one step: ${JSON.stringify(run)}`);
  return step;
}

function requestPayload(request: { body: string }): Record<string, unknown> {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return payload as Record<string, unknown>;
}

function toolNames(payload: Record<string, unknown>, provider: ProviderRow): string[] {
  return provider.toolDefinitions(payload).map((definition) => definition.name);
}

for (const provider of PROVIDER_ROWS) {
  test(`[${provider.label}] a leader's TeamAssign call runs the member inside the leader round`, async () => {
    const fixture = await startFixture(`allibot-orchestration-assign-${provider.label}-`, provider);
    try {
      const channelId = await createChannel(fixture);
      const leaderId = await createAgent(fixture, provider, '队长');
      const memberId = await createAgent(fixture, provider, '成员甲');
      for (const member of [leaderId, memberId]) {
        await joinChannel(fixture, channelId, member);
      }
      await makeTeam(fixture, channelId, leaderId);
      await confirmRemoteDataFlow(fixture, provider);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          {
            id: 'call-assign',
            name: 'TeamAssign',
            input: { member_id: memberId, instruction: '整理资料' },
          },
        ]),
        provider.text('MEMBER-OUTPUT-ONLY-IN-THE-RESULT'),
        provider.text('已分派给成员甲'),
      ]);

      await sendMessage(fixture, channelId, '@队长 把资料整理一下');

      assert.equal(
        fixture.endpoint.requests.length,
        3,
        'the leader turn, the member sub-round and the leader conclusion are three requests',
      );
      assert.deepEqual(
        toolNames(requestPayload(fixture.endpoint.requests[0]!), provider),
        ['TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate', 'TeamAssign'],
        'a team leader round is offered TeamAssign and the Plan tools',
      );
      assert.deepEqual(
        toolNames(requestPayload(fixture.endpoint.requests[1]!), provider),
        ['TaskList', 'TaskGet', 'TaskCreate', 'TaskUpdate'],
        'the member sub-round is offered no TeamAssign',
      );

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[2]!));
      assert.equal(results.length, 1, 'the leader reads one tool result');
      assert.equal(results[0]?.id, 'call-assign');
      assert.equal(results[0]?.isError, false, 'a finished assignment is not a tool error');
      assert.ok(
        (results[0]?.content ?? '').includes('MEMBER-OUTPUT-ONLY-IN-THE-RESULT'),
        `the member output comes back as the tool result: ${results[0]?.content ?? ''}`,
      );

      const runs = await teamRuns(fixture, channelId);
      assert.equal(runs.length, 1, 'the leader round has one run');
      const assignments = (runs[0]?.['assignments'] ?? []) as AssignmentShape[];
      assert.equal(assignments.length, 1, 'the tool call records one assignment');
      assert.equal(assignments[0]?.state, 'completed');
      assert.equal(assignments[0]?.member_id, memberId);
      assert.equal(assignments[0]?.task_id, null);
      assert.equal(assignments[0]?.jump_consumed, 1, 'one assignment costs one jump');
      assert.ok((assignments[0]?.reply_excerpt ?? '').length > 0, 'the excerpt is readable');

      assert.deepEqual(
        (await messages(fixture, channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@队长 把资料整理一下'],
          ['agent', '已分派给成员甲'],
        ],
        'only the final text lands; the member output never becomes a channel message',
      );
      const outcomes = roundOutcomes(fixture);
      assert.deepEqual(
        outcomes.map((outcome) => [outcome.member_id, outcome.status]),
        [[leaderId, 'replied']],
        'the assignment is a tool result, not a second round outcome',
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a TeamAssign call that names the leader itself is a target_self result and the round continues`, async () => {
    const fixture = await startFixture(`allibot-orchestration-assign-self-${provider.label}-`, provider);
    try {
      const channelId = await createChannel(fixture);
      const leaderId = await createAgent(fixture, provider, '队长');
      await joinChannel(fixture, channelId, leaderId);
      await makeTeam(fixture, channelId, leaderId);
      await confirmRemoteDataFlow(fixture, provider);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          {
            id: 'call-self',
            name: 'TeamAssign',
            input: { member_id: leaderId, instruction: '交给自己' },
          },
        ]),
        provider.text('分给自己不行，我自己做'),
      ]);

      await sendMessage(fixture, channelId, '@队长 把这件事交给你自己');

      assert.equal(
        fixture.endpoint.requests.length,
        2,
        'a refused assignment runs no member sub-round',
      );
      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, 'call-self');
      assert.equal(results[0]?.isError, true, 'a refusal is an error tool result');
      assert.ok(
        (results[0]?.content ?? '').startsWith('[TeamAssign] error: target_self'),
        `the stable code reaches the model: ${results[0]?.content ?? ''}`,
      );
      assert.deepEqual(
        (await messages(fixture, channelId)).map((message) => [message['kind'], message['body']]),
        [
          ['human', '@队长 把这件事交给你自己'],
          ['agent', '分给自己不行，我自己做'],
        ],
        'the refusal is a result: the round still answers',
      );
      assert.equal(roundOutcomes(fixture)[0]?.status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a transfer_task call moves the task and the action comes from the tool call`, async () => {
    const fixture = await startFixture(`allibot-orchestration-transfer-${provider.label}-`, provider);
    try {
      const channelId = await createChannel(fixture);
      const assigneeId = await createAgent(fixture, provider, '成员甲');
      const otherId = await createAgent(fixture, provider, '成员乙');
      for (const member of [assigneeId, otherId]) {
        await joinChannel(fixture, channelId, member);
      }
      const task = await createTask(fixture, channelId, '转派任务');
      await assignTask(fixture, task.id, assigneeId);
      await confirmRemoteDataFlow(fixture, provider);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([{ id: 'call-transfer', name: 'transfer_task', input: { member_id: otherId } }]),
        provider.text('已把任务交给成员乙'),
      ]);

      await sendMessage(fixture, task.targetId, '@成员甲 把任务交给成员乙');

      const assignee = readAssignee(fixture, task.id);
      assert.equal(assignee, otherId, 'the tool call transfers the task through the write path');

      const first = requestPayload(fixture.endpoint.requests[0]!);
      assert.ok(
        toolNames(first, provider).includes('transfer_task'),
        `the assignee's round is offered the transfer tool: ${toolNames(first, provider).join(', ')}`,
      );
      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results[0]?.id, 'call-transfer');
      assert.equal(results[0]?.isError, false, 'the transfer call itself is not an error');

      const taskMessages = await messages(fixture, task.targetId);
      assert.ok(
        taskMessages.some(
          (message) =>
            message['kind'] === 'system' &&
            String(message['body']).includes(
              ZH_CN['task.event.assignee.transferred'].text
                .replace('{previous}', '成员甲')
                .replace('{assignee}', '成员乙'),
            ),
        ),
        'the write path appends its own transfer record',
      );
      const firstOutcome = roundOutcomes(fixture)[0];
      assert.equal(firstOutcome?.member_id, assigneeId);
      assert.equal(firstOutcome?.status, 'replied');
      assert.ok(
        (firstOutcome?.reason ?? '').includes(
          ZH_CN['round.transfer.done'].text.replace('{assignee}', '成员乙'),
        ),
        `the round states the structured action it took: ${firstOutcome?.reason ?? ''}`,
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a round that transfers and lands no text leaves the task where it was`, async () => {
    const fixture = await startFixture(
      `allibot-orchestration-transfer-empty-${provider.label}-`,
      provider,
    );
    try {
      const channelId = await createChannel(fixture);
      const assigneeId = await createAgent(fixture, provider, '成员甲');
      const otherId = await createAgent(fixture, provider, '成员乙');
      for (const member of [assigneeId, otherId]) {
        await joinChannel(fixture, channelId, member);
      }
      const task = await createTask(fixture, channelId, '空正文转派任务');
      await assignTask(fixture, task.id, assigneeId);
      await confirmRemoteDataFlow(fixture, provider);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-transfer', name: 'transfer_task', input: { member_id: otherId } },
        ]),
        provider.emptyText(),
      ]);

      await sendMessage(fixture, task.targetId, '@成员甲 把任务交给成员乙，然后什么都不用写');

      const result = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!))[0];
      assert.equal(result?.isError, false, 'the call itself is a result like any other');
      const outcome = roundOutcomes(fixture)[0];
      assert.equal(outcome?.member_id, assigneeId);
      assert.equal(outcome?.status, 'failed', 'no text is still the empty-completion failure');
      assert.equal(
        readAssignee(fixture, task.id),
        assigneeId,
        'a round with no conclusion states no task action, so the task does not move',
      );
      assert.equal(
        (await messages(fixture, task.targetId)).some(
          (message) =>
            message['kind'] === 'system' &&
            String(message['body']).includes(
              ZH_CN['task.event.assignee.transferred'].text
                .replace('{previous}', '成员甲')
                .replace('{assignee}', '成员乙'),
            ),
        ),
        false,
        'the write path wrote no transfer record',
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] TaskCreate and TaskUpdate change the Plan reading, and a round with no Plan face is offered neither`, async () => {
    const fixture = await startFixture(`allibot-orchestration-plan-${provider.label}-`, provider);
    try {
      const channelId = await createChannel(fixture);
      const memberId = await createAgent(fixture, provider, '计划成员');
      await joinChannel(fixture, channelId, memberId);
      const task = await createTask(fixture, channelId, '计划任务');
      await assignTask(fixture, task.id, memberId);
      await confirmRemoteDataFlow(fixture, provider);

      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-create', name: 'TaskCreate', input: { title: '模型创建的计划项' } },
        ]),
        provider.text('加好了一条计划项'),
      ]);
      await sendMessage(fixture, task.targetId, '@计划成员 加一条计划项');

      const created = await planItems(fixture, task.targetId);
      assert.deepEqual(
        created.map((item) => [item.title, item.status]),
        [['模型创建的计划项', 'pending']],
        'the TaskCreate call appended the item to the current run',
      );
      const createdResult = provider.toolResults(
        requestPayload(fixture.endpoint.requests[1]!),
      )[0];
      assert.equal(createdResult?.isError, false);
      assert.ok(
        (createdResult?.content ?? '').includes('模型创建的计划项'),
        `the result names the item it created: ${createdResult?.content ?? ''}`,
      );

      const itemId = created[0]?.id;
      assert.ok(itemId !== undefined);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          {
            id: 'call-update',
            name: 'TaskUpdate',
            input: { id: itemId, title: '改名的计划项', status: 'completed' },
          },
        ]),
        provider.text('更新好了'),
      ]);
      await sendMessage(fixture, task.targetId, '@计划成员 把它标成完成');

      assert.deepEqual(
        (await planItems(fixture, task.targetId)).map((item) => [item.title, item.status]),
        [['改名的计划项', 'completed']],
        'the TaskUpdate call changed the title and the three-word status',
      );
      const updateSchema = provider
        .toolDefinitions(requestPayload(fixture.endpoint.requests[2]!))
        .find((definition) => definition.name === 'TaskUpdate')?.schema;
      assert.deepEqual(
        (updateSchema?.['properties'] as Record<string, Record<string, unknown>>)['status']?.['enum'],
        ['pending', 'in_progress', 'completed'],
        'the schema offers exactly the three-word status',
      );

      // The same member on a channel round: no Plan face, so no Plan write tool.
      const plainChannelId = await createChannel(fixture);
      await joinChannel(fixture, plainChannelId, memberId);
      await setWorkspaceRoot(fixture, plainChannelId, 'plain-project');
      queueReplies(fixture.endpoint, [provider.text('频道轮没有计划面')]);
      await sendMessage(fixture, plainChannelId, '@计划成员 你在吗');

      const plainTools = toolNames(
        requestPayload(fixture.endpoint.requests[fixture.endpoint.requests.length - 1]!),
        provider,
      );
      assert.deepEqual(
        plainTools,
        ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
        'a round with no Plan face and no team is offered no orchestration tool',
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] an out-of-vocabulary TaskUpdate status is an invalid-arguments result and changes nothing`, async () => {
    const fixture = await startFixture(`allibot-orchestration-bad-status-${provider.label}-`, provider);
    try {
      const channelId = await createChannel(fixture);
      const memberId = await createAgent(fixture, provider, '计划成员');
      await joinChannel(fixture, channelId, memberId);
      const task = await createTask(fixture, channelId, '状态任务');
      await assignTask(fixture, task.id, memberId);
      await confirmRemoteDataFlow(fixture, provider);

      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-create', name: 'TaskCreate', input: { title: '保留状态的计划项' } },
        ]),
        provider.text('先加一条'),
      ]);
      await sendMessage(fixture, task.targetId, '@计划成员 加一条');
      const itemId = (await planItems(fixture, task.targetId))[0]?.id;
      assert.ok(itemId !== undefined);

      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-bad-status', name: 'TaskUpdate', input: { id: itemId, status: 'done' } },
        ]),
        provider.text('状态值不合法，我重来'),
      ]);
      await sendMessage(fixture, task.targetId, '@计划成员 标成 done');

      const result = provider.toolResults(requestPayload(fixture.endpoint.requests[3]!))[0];
      assert.equal(result?.isError, true, 'the closed vocabulary refuses the value as a result');
      assert.ok(
        (result?.content ?? '').includes('invalid-arguments'),
        `the refusal keeps its stable code: ${result?.content ?? ''}`,
      );
      assert.deepEqual(
        (await planItems(fixture, task.targetId)).map((item) => [item.title, item.status]),
        [['保留状态的计划项', 'pending']],
        'the refused call never reached the Plan face',
      );
      assert.deepEqual(
        roundOutcomes(fixture).map((outcome) => outcome.status),
        ['replied', 'replied'],
        'a refused argument is a tool result, not a round failure',
      );
    } finally {
      await fixture.stop();
    }
  });
}

/** The task's current assignee, read from the row the write path updates. */
function readAssignee(fixture: Fixture, taskId: string): string | null {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db
      .prepare('SELECT assignee_member_id FROM task WHERE id = ?')
      .get(taskId) as { assignee_member_id: string | null } | undefined;
    return row?.assignee_member_id ?? null;
  } finally {
    db.close();
  }
}

/**
 * One SOP run whose verifier answers through `SopVerdict`: the executor's text,
 * then the verifier's tool call, then the verifier's explanation. The helper
 * returns the three recorded requests plus the settled run, so each case states
 * only what it is about.
 */
async function runVerifierRound(
  fixture: Fixture,
  provider: ProviderRow,
  options: {
    replies: readonly RecordedReply[];
    maxAttempts?: number;
  },
): Promise<{
  executorId: string;
  verifierId: string;
  requests: number;
  run: Record<string, unknown>;
}> {
  const channelId = await createChannel(fixture);
  const executorId = await createAgent(fixture, provider, '执行者');
  const verifierId = await createAgent(fixture, provider, '校验者');
  for (const member of [executorId, verifierId]) {
    await joinChannel(fixture, channelId, member);
  }
  await confirmRemoteDataFlow(fixture, provider);
  const definitionId = await createSop(fixture, channelId, {
    executorId,
    verifierId,
    maxAttempts: options.maxAttempts ?? 1,
  });
  queueReplies(fixture.endpoint, options.replies);
  const runId = await startSopRun(fixture, definitionId);
  const run = await finishedSopRun(fixture, runId);
  return { executorId, verifierId, requests: fixture.endpoint.requests.length, run };
}

for (const provider of PROVIDER_ROWS) {
  test(`[${provider.label}] the verifier's pass verdict comes from the SopVerdict call`, async () => {
    const fixture = await startFixture(`allibot-orchestration-verdict-pass-${provider.label}-`, provider);
    try {
      const { verifierId, requests, run } = await runVerifierRound(fixture, provider, {
        replies: [
          provider.text('步骤已经做完'),
          provider.toolCalls([{ id: 'call-pass', name: 'SopVerdict', input: { verdict: 'pass' } }]),
          provider.text('验收通过'),
        ],
      });

      assert.equal(requests, 3, 'the executor round and the verifier round with one tool call');
      assert.deepEqual(
        toolNames(requestPayload(fixture.endpoint.requests[1]!), provider),
        ['SopVerdict'],
        'a rootless verifier round is offered exactly the verdict tool',
      );
      const result = provider.toolResults(requestPayload(fixture.endpoint.requests[2]!))[0];
      assert.equal(result?.isError, false);
      assert.ok(
        (result?.content ?? '').includes('verdict: pass'),
        `the verdict result states what was recorded: ${result?.content ?? ''}`,
      );

      assert.equal(run['phase'], 'completed', JSON.stringify(run));
      const step = sopStep(run);
      assert.equal(step['verifier_member_id'], verifierId);
      assert.equal(step['verifier_verdict'], 'pass');
      assert.ok(
        String(step['verifier_excerpt']).includes('验收通过'),
        'the verifier body and the verdict are two separate facts',
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] the verifier's fail verdict comes from the SopVerdict call`, async () => {
    const fixture = await startFixture(`allibot-orchestration-verdict-fail-${provider.label}-`, provider);
    try {
      const { run } = await runVerifierRound(fixture, provider, {
        replies: [
          provider.text('步骤已经做完'),
          provider.toolCalls([{ id: 'call-fail', name: 'SopVerdict', input: { verdict: 'fail' } }]),
          provider.text('还差一项，需要重做'),
        ],
      });

      assert.equal(run['phase'], 'failed', JSON.stringify(run));
      assert.equal(sopStep(run)['verifier_verdict'], 'fail');
      assert.ok(
        String(run['state'] !== undefined && (run['state'] as Record<string, unknown>)['error']).includes(
          '还差一项',
        ),
        `a fail verdict is readable in the run's own words: ${JSON.stringify(run)}`,
      );
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a body that says pass without the tool decides nothing`, async () => {
    const fixture = await startFixture(`allibot-orchestration-verdict-prose-${provider.label}-`, provider);
    try {
      const { requests, run } = await runVerifierRound(fixture, provider, {
        replies: [provider.text('步骤已经做完'), provider.text('pass')],
      });

      assert.equal(requests, 2, 'the verifier answered without calling any tool');
      assert.equal(run['phase'], 'failed', 'prose never decides the verdict');
      assert.equal(sopStep(run)['verifier_verdict'], 'fail');
      const error = String((run['state'] as Record<string, unknown>)['error']);
      assert.ok(
        error.includes(ZH_CN['sop.run.verifier.noVerdict'].text),
        `the run states the missing structured verdict: ${error}`,
      );
      assert.ok(error.includes('pass'), `the verifier body is kept as diagnostics: ${error}`);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a verdict survives a verifier round that lands no text`, async () => {
    const fixture = await startFixture(`allibot-orchestration-verdict-empty-${provider.label}-`, provider);
    try {
      const { requests, run } = await runVerifierRound(fixture, provider, {
        replies: [
          provider.text('步骤已经做完'),
          provider.toolCalls([{ id: 'call-pass', name: 'SopVerdict', input: { verdict: 'pass' } }]),
          provider.emptyText(),
        ],
      });

      assert.equal(requests, 3, 'the verdict batch ran before the round ran out of text');
      assert.equal(
        run['phase'],
        'completed',
        `the stated verdict is a fact about the round, not part of its body: ${JSON.stringify(run)}`,
      );
      assert.equal(sopStep(run)['verifier_verdict'], 'pass');
    } finally {
      await fixture.stop();
    }
  });
}
