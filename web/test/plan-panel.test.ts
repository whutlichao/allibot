import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentView,
  ChannelView,
  PlanRunView,
  TaskView,
  WorkspaceView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import { PlanPanel } from '../src/workspace/PlanPanel.ts';
import {
  LIVE_EVENT_TYPES,
  shouldRefreshWorkspace,
} from '../src/workspace/message-sync.ts';
import {
  applyPlanUpdateFrame,
  isPlanTarget,
  planTaskStatusLabel,
  readPlanUpdateFrame,
  readPlans,
} from '../src/workspace/plans.ts';

/**
 * Plan 区块的呈现契约 (#40 / D4.1 / D2.5): the panel renders the run's work
 * list with its own three-word statuses and consumes the live `plan_update`
 * frame; it is not a message list, not the task board, and not a second SSE
 * connection.
 */

const TEAM_CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const AUTONOMOUS_CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const CHANNEL_TASK_TARGET = '33333333-3333-4333-8333-333333333333';
const CHANNEL_TASK_ID = 'task-1';
const AGENT_ID = 'agent-plan';

const PLAN: PlanRunView = {
  id: 'plan-run-1',
  target_id: CHANNEL_TASK_TARGET,
  member_id: AGENT_ID,
  created_at: '2026-11-04T01:00:00.000Z',
  updated_at: '2026-11-04T01:00:02.000Z',
  tasks: [
    {
      id: 'plan-task-1',
      plan_run_id: 'plan-run-1',
      title: '整理资料',
      status: 'pending',
      position: 0,
      created_at: '2026-11-04T01:00:00.000Z',
      updated_at: '2026-11-04T01:00:00.000Z',
    },
    {
      id: 'plan-task-2',
      plan_run_id: 'plan-run-1',
      title: '撰写结论',
      status: 'in_progress',
      position: 1,
      created_at: '2026-11-04T01:00:01.000Z',
      updated_at: '2026-11-04T01:00:01.000Z',
    },
    {
      id: 'plan-task-3',
      plan_run_id: 'plan-run-1',
      title: '提交结果',
      status: 'completed',
      position: 2,
      created_at: '2026-11-04T01:00:02.000Z',
      updated_at: '2026-11-04T01:00:02.000Z',
    },
  ],
};

function channel(overrides: Partial<ChannelView> & Pick<ChannelView, 'id' | 'name'>): ChannelView {
  return {
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

function task(): TaskView {
  return {
    id: CHANNEL_TASK_ID,
    channel_id: AUTONOMOUS_CHANNEL_ID,
    target_id: CHANNEL_TASK_TARGET,
    title: '真实任务',
    status: 'todo',
    assignee_member_id: AGENT_ID,
    claimed_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    channel_mode: 'autonomous',
    allowed_transitions: ['in_progress'],
    message_count: 1,
    unread_count: 0,
  };
}

function agent(): AgentView {
  return {
    id: AGENT_ID,
    kind: 'agent',
    display_name: '计划成员',
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

function workspace(): WorkspaceView {
  return {
    owner: {
      id: 'owner-1',
      kind: 'owner',
      display_name: '我',
      avatar_slot: 0,
    },
    agents: [agent()],
    channels: [
      channel({ id: AUTONOMOUS_CHANNEL_ID, name: '自主频道' }),
      channel({
        id: TEAM_CHANNEL_ID,
        name: 'team 频道',
        mode: 'team',
        team: { leader_member_id: AGENT_ID, status: 'valid', reason: null },
      }),
    ],
    dms: [],
    tasks: [task()],
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: { [AGENT_ID]: { status: 'online', offline_reason: null } },
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: {
      [AUTONOMOUS_CHANNEL_ID]: 0,
      [TEAM_CHANNEL_ID]: 0,
    },
  };
}

function renderPanel(plans: readonly PlanRunView[] = [PLAN]): string {
  return renderToStaticMarkup(
    createElement(PlanPanel, { plans, locale: 'zh-CN', agents: [agent()] }),
  );
}

test('the Plan panel renders the work list with the three plan words, not a message or task board', () => {
  const html = renderPanel();
  assert.match(html, /data-plan-panel=""/);
  assert.match(html, /data-plan-run-id="plan-run-1"/);
  assert.match(html, /data-plan-member-id="agent-plan"/);
  assert.match(html, /data-plan-tasks=""/);
  for (const status of ['pending', 'in_progress', 'completed']) {
    assert.match(html, new RegExp(`data-plan-task-status="${status}"`));
  }
  assert.match(html, /data-plan-task-position="0"/);
  assert.match(html, /data-plan-task-position="2"/);
  assert.ok(html.includes('整理资料'));
  assert.ok(html.includes('撰写结论'));
  assert.ok(html.includes('提交结果'));
  assert.ok(html.includes('计划成员'), 'the member display name resolves from the workspace reading');
  assert.ok(html.includes(ZH_CN['workspace.plan.status.pending'].text));
  assert.ok(html.includes(ZH_CN['workspace.plan.status.inProgress'].text));
  assert.ok(html.includes(ZH_CN['workspace.plan.status.completed'].text));
  assert.doesNotMatch(html, /data-message-id|message-list/, 'a Plan item is never a message');
  assert.doesNotMatch(html, /todo|in_review|done|closed/, 'the panel never renders the task five-state');
});

test('the Plan panel has an empty state and the status labels are distinct', () => {
  const empty = renderPanel([]);
  assert.ok(empty.includes(ZH_CN['workspace.plan.empty'].text));
  assert.match(empty, /data-plan-panel=""/);

  const labels = (['pending', 'in_progress', 'completed'] as const).map((status) =>
    planTaskStatusLabel('zh-CN', status),
  );
  assert.equal(new Set(labels).size, 3);
  assert.equal(labels[1], ZH_CN['workspace.plan.status.inProgress'].text);
});

test('the Plan panel is shown for task targets and team channels but not for a DM or autonomous channel', () => {
  const reading = workspace();
  assert.equal(isPlanTarget(reading, CHANNEL_TASK_TARGET), true);
  assert.equal(isPlanTarget(reading, TEAM_CHANNEL_ID), true);
  assert.equal(isPlanTarget(reading, AUTONOMOUS_CHANNEL_ID), false);
  assert.equal(isPlanTarget(reading, null), false);

  const taskPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: reading,
      targetId: CHANNEL_TASK_TARGET,
      locale: 'zh-CN',
      plans: [PLAN],
      channelMembers: [],
    }),
  );
  assert.match(taskPanel, /data-plan-panel=""/);
  assert.ok(taskPanel.includes('整理资料'));

  const autonomousPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: reading,
      targetId: AUTONOMOUS_CHANNEL_ID,
      locale: 'zh-CN',
      plans: [PLAN],
      channelMembers: [],
    }),
  );
  assert.doesNotMatch(autonomousPanel, /data-plan-panel=""/);

  const teamPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: reading,
      targetId: TEAM_CHANNEL_ID,
      locale: 'zh-CN',
      plans: [PLAN],
      channelMembers: [],
    }),
  );
  assert.match(teamPanel, /data-plan-panel=""/);
});

test('the Plan read helper reads the target plans and the frame replaces the complete current list', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request) => {
    calls.push(String(input));
    return new Response(JSON.stringify({ plans: [PLAN] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const plans = await readPlans(fetchImpl, CHANNEL_TASK_TARGET);
  assert.equal(plans.length, 1);
  assert.equal(plans[0]?.id, 'plan-run-1');
  assert.equal(
    calls[0],
    `/api/targets/${CHANNEL_TASK_TARGET}/plans?limit=20`,
    'the read uses the D2.3 target route',
  );

  await readPlans(fetchImpl, CHANNEL_TASK_TARGET, { memberId: 'agent-plan', limit: 5 });
  assert.equal(
    calls[1],
    `/api/targets/${CHANNEL_TASK_TARGET}/plans?limit=5&member_id=agent-plan`,
    'member_id narrows the read',
  );

  const frame = readPlanUpdateFrame({
    plan_run_id: 'plan-run-1',
    target_id: CHANNEL_TASK_TARGET,
    member_id: 'agent-plan',
    tasks: [
      {
        ...PLAN.tasks[0],
        title: '新的清单项',
        status: 'completed',
      },
    ],
    occurred_at: '2026-11-04T01:00:09.000Z',
  });
  assert.ok(frame !== null);
  const next = applyPlanUpdateFrame({ [CHANNEL_TASK_TARGET]: [PLAN] }, frame);
  const updated = next[CHANNEL_TASK_TARGET]?.[0];
  assert.equal(updated?.updated_at, '2026-11-04T01:00:09.000Z');
  assert.equal(updated?.tasks.length, 1, 'the frame carries the complete list, not a delta');
  assert.equal(updated?.tasks[0]?.title, '新的清单项');
  assert.equal(PLAN.tasks.length, 3, 'the previous reading is not mutated');

  const newRunFrame = readPlanUpdateFrame({
    plan_run_id: 'plan-run-2',
    target_id: CHANNEL_TASK_TARGET,
    member_id: 'agent-plan',
    tasks: [],
    occurred_at: '2026-11-04T01:00:10.000Z',
  });
  assert.ok(newRunFrame !== null);
  const withNew = applyPlanUpdateFrame({ [CHANNEL_TASK_TARGET]: [PLAN] }, newRunFrame);
  assert.deepEqual(
    withNew[CHANNEL_TASK_TARGET]?.map((plan) => plan.id),
    ['plan-run-2', 'plan-run-1'],
    'a frame for a run not on the page is prepended for that target',
  );

  assert.equal(readPlanUpdateFrame({ plan_run_id: 'only-an-id' }), null);
  assert.equal(
    readPlanUpdateFrame({
      plan_run_id: 'run',
      target_id: 'target',
      member_id: 'member',
      tasks: [{ id: 'x', status: 'todo' }],
      occurred_at: 'now',
    }),
    null,
    'a task five-state in a Plan frame is rejected',
  );
});

test('the one global stream consumes plan_update without polling or a second connection', () => {
  assert.ok((LIVE_EVENT_TYPES as readonly string[]).includes('plan_update'));
  assert.equal(
    shouldRefreshWorkspace('plan_update'),
    false,
    'the frame updates the Plan reading, not the whole workspace',
  );

  const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(mainSource, /event\.event === 'plan_update'/);
  assert.match(mainSource, /loadPlans\(frame\.target_id\)/, 'the frame re-reads that target plans');
  assert.doesNotMatch(mainSource, /setInterval/, 'the shell polls no Plan reading');

  const plansSource = readFileSync(
    new URL('../src/workspace/plans.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(plansSource, /setInterval|setTimeout/, 'the Plan read model never polls');

  const chatSource = readFileSync(
    new URL('../src/workspace/WorkspaceChat.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    chatSource.split('/api/events').length - 1,
    1,
    'the SSE subscription stays the one global connection',
  );

  const taskBoardSource = readFileSync(
    new URL('../src/task-board/TaskBoard.ts', import.meta.url),
    'utf8',
  );
  assert.doesNotMatch(taskBoardSource, /plan_run|plan_task|PlanPanel/);
});
