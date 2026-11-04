import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ChannelView,
  TargetMemberView,
  TaskView,
  WorkspaceStatusView,
  WorkspaceView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import {
  backendChangePatch,
  rootChangePatch,
  workspaceStatusCopy,
} from '../src/workspace/channel-config.ts';
import { patchChannelConfig } from '../src/workspace-actions.ts';

/**
 * 频道配置区的项目根 / 工作区后端 / 工作区状态，以及目标上下文的
 * workspace_status 原因 (#42 / D2.2 / D5.1 / D5.7)。前端只做呈现契约：
 * 读数来自后端，动作只验证宿主发出的那一次 PATCH；不建第二套领域 seam。
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const TASK_TARGET_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: CHANNEL_ID,
    name: '工作区频道',
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

function members(status: WorkspaceStatusView): TargetMemberView[] {
  return [
    {
      id: OWNER_ID,
      kind: 'owner',
      display_name: 'owner',
      avatar_slot: 0,
      workspace_status: status, allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
    {
      id: AGENT_ID,
      kind: 'agent',
      display_name: '工作区成员',
      avatar_slot: 1,
      workspace_status: status, allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
  ];
}

const TASK: TaskView = {
  id: 'task-1',
  channel_id: CHANNEL_ID,
  target_id: TASK_TARGET_ID,
  title: '工作区任务',
  status: 'todo',
  assignee_member_id: null,
  claimed_at: null,
  created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z',
  channel_mode: 'autonomous',
  allowed_transitions: ['in_progress'],
  message_count: 1,
  unread_count: 0,
};

function workspace(target: ChannelView): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [],
    channels: [target],
    dms: [],
    tasks: [TASK],
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: { [CHANNEL_ID]: 0 },
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
    workspace_runtime: {
      docker: { available: false, image: 'node:22-bookworm-slim', reason: 'docker-unavailable' },
    },
  };
}

function renderContext(
  target: ChannelView,
  targetId: string,
  status: WorkspaceStatusView,
): string {
  return renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(target),
      targetId,
      locale: 'zh-CN',
      channelMembers: members(status),
      onChannelConfigChange: () => Promise.resolve(),
    }),
  );
}

test('the root and backend controls send one channel PATCH only when the value changes', () => {
  const configured = channel({
    workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 0 },
  });
  assert.deepEqual(rootChangePatch(configured, '/tmp/project'), null);
  assert.deepEqual(rootChangePatch(configured, '/tmp/other'), {
    workspace_root: '/tmp/other',
  });
  assert.deepEqual(rootChangePatch(configured, ''), { workspace_root: null });
  assert.deepEqual(rootChangePatch(configured, '   '), { workspace_root: null });
  assert.deepEqual(rootChangePatch(channel(), ''), null, 'clearing an empty root is a no-op');

  assert.deepEqual(backendChangePatch(configured, 'local'), null);
  assert.deepEqual(backendChangePatch(configured, 'docker'), {
    workspace_backend: 'docker',
  });
});

test('the channel config area renders the project root, backend and an available status', () => {
  const html = renderContext(
    channel({
      workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 0 },
    }),
    CHANNEL_ID,
    { backend: 'local', available: true, reason: null },
  );
  assert.match(html, /data-channel-config=""/);
  assert.match(html, /data-action="workspace-root"/);
  assert.match(html, /value="\/tmp\/project"/);
  assert.match(html, /data-action="workspace-backend"/);
  assert.match(html, /data-workspace-backend="local"/);
  assert.ok(html.includes(ZH_CN['channel.config.workspace.root.label'].text));
  assert.ok(html.includes(ZH_CN['channel.config.workspace.backend.local'].text));
  assert.ok(html.includes(ZH_CN['channel.config.workspace.backend.docker'].text));
  assert.match(html, /data-workspace-status="available"/);
  assert.ok(html.includes(ZH_CN['workspace.status.available'].text));
});

test('the channel config area renders the docker-unavailable reason and the empty root', () => {
  const html = renderContext(
    channel({
      workspace: { root: null, backend: 'docker', allow_local_shell: 0 },
    }),
    CHANNEL_ID,
    { backend: 'docker', available: false, reason: 'docker-unavailable' },
  );
  assert.match(html, /data-workspace-backend="docker"/);
  assert.match(html, /data-workspace-status="unavailable"/);
  assert.match(html, /data-workspace-reason="docker-unavailable"/);
  assert.ok(
    html.includes(ZH_CN['workspace.status.reason.dockerUnavailable'].text),
    'the readable docker reason renders',
  );
  assert.ok(
    html.includes(ZH_CN['channel.config.workspace.root.placeholder'].text),
    'an empty root shows the placeholder',
  );
});

test('the target context shows the workspace-root-missing reason for a channel and for a task', () => {
  for (const [targetId, label] of [
    [CHANNEL_ID, 'channel'],
    [TASK_TARGET_ID, 'task'],
  ] as const) {
    const html = renderContext(
      channel({ workspace: { root: '/tmp/gone', backend: 'local', allow_local_shell: 0 } }),
      targetId,
      { backend: 'local', available: false, reason: 'workspace-root-missing' },
    );
    assert.match(
      html,
      /data-workspace-status="unavailable"/,
      `${label} context renders the unavailable status`,
    );
    assert.match(html, /data-workspace-reason="workspace-root-missing"/);
    assert.ok(
      html.includes(ZH_CN['workspace.status.reason.workspaceRootMissing'].text),
      `${label} context renders the readable reason`,
    );
  }
});

test('an unset project root renders a neutral status, not the missing-root error', () => {
  const html = renderContext(channel(), CHANNEL_ID, {
    backend: 'local',
    available: false,
    reason: 'workspace-root-unset',
  });
  assert.match(html, /data-workspace-status="unset"/);
  assert.match(html, /data-workspace-reason="workspace-root-unset"/);
  assert.ok(
    html.includes(ZH_CN['workspace.status.reason.workspaceRootUnset'].text),
    'the neutral unset copy renders',
  );
  assert.doesNotMatch(
    html,
    /data-workspace-status="unavailable"/,
    'an unset root is not an error state',
  );
  assert.ok(
    !html.includes(ZH_CN['workspace.status.reason.workspaceRootMissing'].text),
    'an unset root never reads as missing or unreadable',
  );
});

test('the context drawer folds permission rules and SOP so the column stays readable', () => {
  const html = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(channel()),
      targetId: CHANNEL_ID,
      locale: 'zh-CN',
      channelMembers: members({ backend: 'local', available: false, reason: 'workspace-root-unset' }),
      permissionRules: [],
      onPermissionRulesChange: () => undefined,
      sopDefinitions: [],
      onCreateSop: () => undefined,
      onStartSop: () => undefined,
    }),
  );
  assert.match(
    html,
    /data-action="toggle-fold" data-fold="permission-rules" aria-expanded="false"/,
    'permission rules start collapsed',
  );
  assert.match(
    html,
    /data-action="toggle-fold" data-fold="sop" aria-expanded="false"/,
    'SOP starts collapsed',
  );
  assert.ok(!html.includes('data-permission-rules=""'), 'the rule editor is not in the initial scroll');
  assert.ok(!html.includes('data-sop-panel=""'), 'the SOP form is not in the initial scroll');
  assert.ok(html.includes(ZH_CN['workspace.permission.rules.title'].text));
  assert.ok(html.includes(ZH_CN['workspace.sop.title'].text));
});

test('workspaceStatusCopy never invents a reason for an available workspace', () => {
  assert.equal(
    workspaceStatusCopy('zh-CN', { backend: 'local', available: true, reason: null }),
    ZH_CN['workspace.status.available'].text,
  );
  assert.equal(
    workspaceStatusCopy('zh-CN', {
      backend: 'docker',
      available: false,
      reason: 'docker-unavailable',
    }),
    ZH_CN['workspace.status.reason.dockerUnavailable'].text,
  );
});

test('the channel write helper sends the root and backend patch to the channel URL', async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(channel()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await patchChannelConfig(fetchImpl, CHANNEL_ID, {
    workspace_root: '/tmp/project',
    workspace_backend: 'docker',
  });
  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      url: `/api/channels/${CHANNEL_ID}`,
      body: { workspace_root: '/tmp/project', workspace_backend: 'docker' },
    },
  ]);
});
