import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentView,
  ChannelView,
  DmView,
  SopDefinitionView,
  SopRunView,
  TargetMemberView,
  TaskView,
  WorkspaceView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import { SopPanel } from '../src/workspace/SopPanel.ts';
import {
  activeSopRun,
  hasActiveSopRun,
  readSopDefinitions,
  readSopRun,
  readSopRuns,
  sopPhaseLabel,
} from '../src/workspace/sops.ts';
import { createSopDefinition, startSopRun } from '../src/workspace-actions.ts';

/**
 * SOP 定义 / 启动的呈现契约 (#41 / D4.2): the form creates one immutable
 * channel-scoped step list, the list starts a definition, and the newest run is
 * rendered read-only (phase / current step / timestamps). A SOP is never a
 * message, a task row or a board column.
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const DM_ID = '22222222-2222-4222-8222-222222222222';
const TASK_TARGET_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = 'owner-1';
const AGENT_A = 'agent-sop-a';
const AGENT_B = 'agent-sop-b';
const DEFINITION_ID = 'sop-def-1';
const RUN_ID = 'sop-run-1';

const MEMBERS: readonly TargetMemberView[] = [
  { id: OWNER_ID, kind: 'owner', display_name: '我', avatar_slot: 0, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
  { id: AGENT_A, kind: 'agent', display_name: '执行者甲', avatar_slot: 1, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
  { id: AGENT_B, kind: 'agent', display_name: '校验者乙', avatar_slot: 2, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
];

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: CHANNEL_ID,
    name: 'SOP 频道',
    description: '',
    mode: 'autonomous',
    team: { leader_member_id: null, status: 'valid', reason: null },
    workspace: { root: null, backend: 'local', allow_local_shell: 0 },
    permission_mode: 'ask-writes',
    response_budget_limit: 3,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

function agent(id: string, displayName: string): AgentView {
  return {
    id,
    kind: 'agent',
    display_name: displayName,
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    status: 'online',
    offline_reason: null,
    role: '',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: '',
    enabled: 1,
    context_window: 10000,
    compression_threshold: 0.8,
    max_iterations: 8,
    auto_claim: 0,
    workspace_backend: null,
    permission_mode: null,
    effective_permission_mode: 'ask-writes',
    home_path: '/tmp/allibot-home/agents/agent-1',
  };
}

const DEFINITION: SopDefinitionView = {
  id: DEFINITION_ID,
  channel_id: CHANNEL_ID,
  name: '周报流程',
  steps: [
    {
      title: '收集资料',
      description: '读规格',
      executor_member_id: AGENT_A,
      verifier_member_id: AGENT_B,
      max_attempts: 2,
    },
    {
      title: '汇总输出',
      description: '',
      executor_member_id: AGENT_B,
      verifier_member_id: AGENT_A,
      max_attempts: 3,
    },
  ],
  created_at: '2026-11-04T01:00:00.000Z',
};

const PENDING_RUN: SopRunView = {
  id: RUN_ID,
  definition_id: DEFINITION_ID,
  channel_id: CHANNEL_ID,
  phase: 'pending',
  state: { current_step: 0, attempt: 0, steps: [], waiting_on: null, error: null },
  current_step: 0,
  started_at: '2026-11-04T01:00:01.000Z',
  updated_at: '2026-11-04T01:00:01.000Z',
  finished_at: null,
};

function workspace(): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: '我', avatar_slot: 0 },
    agents: [agent(AGENT_A, '执行者甲'), agent(AGENT_B, '校验者乙')],
    channels: [channel()],
    dms: [
      {
        id: DM_ID,
        peer: { id: AGENT_A, display_name: '执行者甲', avatar_slot: 1, deleted_at: null },
      } as DmView,
    ],
    tasks: [
      {
        id: 'task-1',
        channel_id: CHANNEL_ID,
        target_id: TASK_TARGET_ID,
        title: '真实任务',
        status: 'todo',
        assignee_member_id: AGENT_A,
        claimed_at: null,
        created_at: '2026-11-03T00:00:00.000Z',
        updated_at: '2026-11-03T00:00:00.000Z',
        channel_mode: 'autonomous',
        allowed_transitions: ['in_progress'],
        message_count: 1,
        unread_count: 0,
      } as TaskView,
    ],
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: { [CHANNEL_ID]: 0, [DM_ID]: 0 },
  };
}

function renderPanel(
  options: { definitions?: readonly SopDefinitionView[]; runs?: Record<string, readonly SopRunView[]>; channel?: ChannelView } = {},
): string {
  return renderToStaticMarkup(
    createElement(SopPanel, {
      channel: options.channel ?? channel(),
      definitions: options.definitions ?? [DEFINITION],
      runsByDefinition: options.runs ?? { [DEFINITION_ID]: [PENDING_RUN] },
      members: MEMBERS,
      locale: 'zh-CN',
    }),
  );
}

test('the SOP panel renders the definition form, the definition list and the pending run read-only', () => {
  const html = renderPanel();
  assert.match(html, /data-sop-panel=""/);
  assert.match(html, /data-sop-form=""/);
  assert.match(html, /data-sop-field="name"/);
  assert.match(html, /data-sop-definition-id="sop-def-1"/);
  assert.match(html, /data-sop-definition-name="周报流程"/);
  assert.ok(html.includes('收集资料'));
  assert.ok(html.includes('汇总输出'));
  assert.ok(html.includes('执行者甲'), 'the executor member id resolves to its display name');
  assert.ok(html.includes('校验者乙'), 'the verifier member id resolves to its display name');
  assert.match(html, /data-sop-step-field="executor_member_id"/);
  assert.match(html, /data-sop-step-field="verifier_member_id"/);
  assert.match(html, /data-sop-step-field="max_attempts"/);
  assert.match(html, /data-action="sop-create"/);
  assert.match(html, /data-action="sop-start"/);
  assert.match(html, /data-sop-run-id="sop-run-1"/);
  assert.match(html, /data-sop-run-phase="pending"/);
  assert.match(html, /data-sop-run-current-step="0"/);
  assert.ok(html.includes(ZH_CN['workspace.sop.phase.pending'].text));
  assert.ok(html.includes(ZH_CN['workspace.sop.runs.title'].text));
  assert.doesNotMatch(html, /data-message-id|message-list/, 'a SOP run is never a message');
  assert.doesNotMatch(html, /data-task-status/, 'a SOP run never renders the task five-state');
  assert.doesNotMatch(html, /data-action="sop-edit"|data-action="sop-delete"/);
});

test('the SOP panel has an empty state, five distinct phase labels and an archived-channel notice', () => {
  const empty = renderPanel({ definitions: [], runs: {} });
  assert.ok(empty.includes(ZH_CN['workspace.sop.empty'].text));
  assert.match(empty, /data-sop-definitions=""/);

  const phases = (['pending', 'running', 'awaiting', 'completed', 'failed'] as const).map(
    (phase) => sopPhaseLabel('zh-CN', phase),
  );
  assert.equal(new Set(phases).size, 5);
  assert.equal(phases[0], ZH_CN['workspace.sop.phase.pending'].text);

  const archived = renderPanel({
    channel: channel({ archived_at: '2026-11-04T02:00:00.000Z' }),
  });
  assert.ok(archived.includes(ZH_CN['workspace.sop.archived'].text));
  assert.match(archived, /data-sop-writable="false"/);
  assert.match(archived, /data-action="sop-create"[^>]*disabled/);
  assert.match(archived, /data-action="sop-start"[^>]*disabled/);
});

test('the SOP panel is shown for channels, not for DMs or task threads', () => {
  const reading = workspace();
  const channelPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: reading,
      targetId: CHANNEL_ID,
      locale: 'zh-CN',
      channelMembers: MEMBERS,
      sopDefinitions: [DEFINITION],
      sopRuns: { [DEFINITION_ID]: [PENDING_RUN] },
      onCreateSop: () => undefined,
      onStartSop: () => undefined,
    }),
  );
  assert.match(channelPanel, /data-sop-panel=""/);
  assert.match(channelPanel, /data-sop-run-id="sop-run-1"/);

  const dmPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: reading,
      targetId: DM_ID,
      locale: 'zh-CN',
      channelMembers: MEMBERS,
      sopDefinitions: [DEFINITION],
      sopRuns: { [DEFINITION_ID]: [PENDING_RUN] },
    }),
  );
  assert.doesNotMatch(dmPanel, /data-sop-panel=""/);

  const taskPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: reading,
      targetId: TASK_TARGET_ID,
      locale: 'zh-CN',
      channelMembers: MEMBERS,
      sopDefinitions: [DEFINITION],
      sopRuns: { [DEFINITION_ID]: [PENDING_RUN] },
    }),
  );
  assert.doesNotMatch(taskPanel, /data-sop-panel=""/);
});

test('the SOP read and write helpers use the D2.3 routes and the start response is the pending run', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const respond = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    if (String(input).startsWith('/api/sops?channel_id=')) {
      return respond({ sops: [DEFINITION] });
    }
    if (String(input) === `/api/sops/${DEFINITION_ID}/runs?limit=5`) {
      return respond({ runs: [PENDING_RUN] });
    }
    if (String(input) === `/api/sops/${DEFINITION_ID}/runs?limit=2&before=${RUN_ID}`) {
      return respond({ runs: [] });
    }
    if (String(input) === `/api/sop-runs/${RUN_ID}`) {
      return respond(PENDING_RUN);
    }
    if (String(input) === '/api/sops' && init?.method === 'POST') {
      return respond(DEFINITION, 201);
    }
    if (String(input) === `/api/sops/${DEFINITION_ID}/runs` && init?.method === 'POST') {
      return respond(PENDING_RUN, 202);
    }
    return respond({ error: { code: 'not_found', message: 'nope' } }, 404);
  }) as typeof fetch;

  const definitions = await readSopDefinitions(fetchImpl, CHANNEL_ID);
  assert.deepEqual(definitions, [DEFINITION]);
  assert.equal(calls[0]?.url, `/api/sops?channel_id=${CHANNEL_ID}`);

  const runs = await readSopRuns(fetchImpl, DEFINITION_ID);
  assert.deepEqual(runs, [PENDING_RUN]);
  assert.equal(calls[1]?.url, `/api/sops/${DEFINITION_ID}/runs?limit=5`);

  await readSopRuns(fetchImpl, DEFINITION_ID, { limit: 2, before: RUN_ID });
  assert.equal(calls[2]?.url, `/api/sops/${DEFINITION_ID}/runs?limit=2&before=${RUN_ID}`);

  assert.deepEqual(await readSopRun(fetchImpl, RUN_ID), PENDING_RUN);
  assert.equal(calls[3]?.url, `/api/sop-runs/${RUN_ID}`);

  const created = await createSopDefinition(fetchImpl, {
    channel_id: CHANNEL_ID,
    name: DEFINITION.name,
    steps: DEFINITION.steps,
  });
  assert.deepEqual(created, DEFINITION);
  assert.equal(calls[4]?.method, 'POST');
  assert.equal(calls[4]?.url, '/api/sops');
  assert.deepEqual(JSON.parse(calls[4]?.body ?? ''), {
    channel_id: CHANNEL_ID,
    name: DEFINITION.name,
    steps: DEFINITION.steps,
  });

  const started = await startSopRun(fetchImpl, DEFINITION_ID);
  assert.deepEqual(started, PENDING_RUN);
  assert.equal(calls[5]?.method, 'POST');
  assert.equal(calls[5]?.url, `/api/sops/${DEFINITION_ID}/runs`);

  const conflictFetch = (async () =>
    new Response(JSON.stringify({ error: { code: 'conflict', message: 'active run' } }), {
      status: 409,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  await assert.rejects(() => startSopRun(conflictFetch, DEFINITION_ID), /409/);
});

test('an active run is pending, running or awaiting and the newest one is shown', () => {
  assert.equal(hasActiveSopRun([PENDING_RUN]), true);
  assert.equal(
    hasActiveSopRun([{ ...PENDING_RUN, phase: 'running' }]),
    true,
  );
  assert.equal(
    hasActiveSopRun([{ ...PENDING_RUN, phase: 'awaiting' }]),
    true,
  );
  assert.equal(
    hasActiveSopRun([{ ...PENDING_RUN, phase: 'completed', finished_at: '2026-11-04T02:00:00.000Z' }]),
    false,
  );
  assert.equal(activeSopRun([{ ...PENDING_RUN, phase: 'failed', finished_at: '2026-11-04T02:00:00.000Z' }]), null);
  assert.equal(activeSopRun([PENDING_RUN])?.id, RUN_ID);
});

test('the shell reads SOP definitions on channel selection and consumes no second SSE stream', () => {
  const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(mainSource, /readSopDefinitions|loadSops/);
  assert.match(mainSource, /startSopRun/);
  assert.match(mainSource, /createSopDefinition/);

  const sopsSource = readFileSync(new URL('../src/workspace/sops.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(sopsSource, /EventSource|setInterval|method: 'PATCH'|method: 'DELETE'/);
  assert.match(sopsSource, /\/api\/sops/);

  const chatSource = readFileSync(
    new URL('../src/workspace/WorkspaceChat.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    chatSource.split('/api/events').length - 1,
    1,
    'the one global SSE subscription is unchanged',
  );

  const taskBoardSource = readFileSync(
    new URL('../src/task-board/TaskBoard.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(taskBoardSource, /sop_definition|sop_run|SopPanel/);
});
