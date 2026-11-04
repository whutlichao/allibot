import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ChannelView,
  TargetMemberView,
  TaskView,
  WorkspaceView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import {
  leaderCandidates,
  leaderChangePatch,
  modeChangePatch,
} from '../src/workspace/channel-config.ts';
import { ChannelConfigPanel } from '../src/workspace/ChannelConfigPanel.ts';
import { patchChannelConfig } from '../src/workspace-actions.ts';
import { parseLiveEvent, shouldRefreshWorkspace } from '../src/workspace/message-sync.ts';

/**
 * 频道 team 配置区的呈现契约（#37）。前端只做呈现层契约（规格 R2）：这里不建
 * 第二套领域 seam，模式 / 队长 / 配置无效原因都是后端读数，动作只验证宿主发出的
 * 那一次 PATCH（mode 与 leader 走同一端点）。
 *
 * 组件用 createElement 渲染，SSR 只读 props；切换 leader 的可执行事实由纯函数
 * 与写路径 helper 承载，因此测试不模拟点击也不进入 React 内部状态。
 */

const TEAM_CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const AUTONOMOUS_CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const DM_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = 'owner-1';
const LEADER_ID = 'agent-1';
const MEMBER_ID = 'agent-2';
const TASK_TARGET_ID = '55555555-5555-4555-8555-555555555555';

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

const TEAM_CHANNEL: ChannelView = channel({
  id: TEAM_CHANNEL_ID,
  name: 'team 频道',
  mode: 'team',
  team: {
    leader_member_id: LEADER_ID,
    status: 'invalid',
    reason: ZH_CN['team.invalid.leaderDisabled'].text,
  },
});

const AUTONOMOUS_CHANNEL: ChannelView = channel({
  id: AUTONOMOUS_CHANNEL_ID,
  name: '自主频道',
});

const MEMBERS: readonly TargetMemberView[] = [
  { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
  { id: LEADER_ID, kind: 'agent', display_name: '队长甲', avatar_slot: 1, workspace_status: { backend: 'local', available: true, reason: null }, allow_local_shell: 0, permission_mode: 'ask-writes' },
  { id: MEMBER_ID, kind: 'agent', display_name: '成员乙', avatar_slot: 2, workspace_status: { backend: 'local', available: true, reason: null }, allow_local_shell: 0, permission_mode: 'ask-writes' },
];

const TASK: TaskView = {
  id: 'task-1',
  channel_id: TEAM_CHANNEL_ID,
  target_id: TASK_TARGET_ID,
  title: '任务',
  status: 'todo',
  assignee_member_id: null,
  claimed_at: null,
  created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z',
  channel_mode: 'team',
  allowed_transitions: ['in_progress'],
  message_count: 1,
  unread_count: 0,
};

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [],
    channels: [TEAM_CHANNEL, AUTONOMOUS_CHANNEL],
    dms: [
      {
        id: DM_ID,
        peer: { id: LEADER_ID, display_name: '队长甲', avatar_slot: 1, deleted_at: null },
      },
    ],
    tasks: [TASK],
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: { [TEAM_CHANNEL_ID]: 0, [DM_ID]: 0 },
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
    workspace_runtime: {
      docker: { available: false, image: 'node:22-bookworm-slim', reason: 'docker-unavailable' },
    },
    ...overrides,
  };
}

function renderPanel(
  targetId: string,
  options: { members?: readonly TargetMemberView[] } = {},
): string {
  return renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(),
      targetId,
      locale: 'zh-CN',
      channelMembers: options.members ?? MEMBERS,
      onChannelConfigChange: () => Promise.resolve(),
    }),
  );
}

test('the channel config area renders the mode, the leader and the invalid reason from the reading', () => {
  const html = renderPanel(TEAM_CHANNEL_ID);
  assert.match(html, /data-channel-config=""/, 'the channel config area is present');
  assert.match(html, /data-channel-mode="team"/, 'the mode is rendered');
  assert.match(html, /data-action="channel-mode"/, 'the mode control exists');
  assert.match(html, /data-action="team-leader"/, 'the leader control exists');
  assert.ok(html.includes(ZH_CN['channel.config.title'].text), 'the config title renders');
  assert.ok(html.includes('队长甲'), 'the leader name renders in the leader control');
  assert.ok(html.includes('成员乙'), 'other Agent members are candidates');
  assert.ok(
    html.includes(ZH_CN['channel.config.mode.team'].text),
    'the team mode label renders from the catalog',
  );
  assert.match(html, /data-team-status="invalid"/, 'the invalid status is rendered');
  assert.ok(
    html.includes(ZH_CN['channel.config.invalid'].text),
    'the invalid label renders from the catalog',
  );
  assert.ok(
    html.includes(ZH_CN['team.invalid.leaderDisabled'].text),
    'the invalid reason renders verbatim',
  );
});

test('an autonomous channel renders the mode control but no leader control', () => {
  const html = renderPanel(AUTONOMOUS_CHANNEL_ID);
  assert.match(html, /data-channel-mode="autonomous"/);
  assert.match(html, /data-action="channel-mode"/);
  assert.doesNotMatch(html, /data-action="team-leader"/);
});

test('a DM renders no channel config area and therefore no mode control', () => {
  const html = renderPanel(DM_ID);
  assert.doesNotMatch(html, /data-channel-config/);
  assert.doesNotMatch(html, /data-action="channel-mode"/);
  assert.doesNotMatch(html, /data-action="team-leader"/);
});

test('switching the leader and switching the mode both go through one PATCH to the channel URL', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(TEAM_CHANNEL), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const leaderPatch = leaderChangePatch(TEAM_CHANNEL, MEMBER_ID);
  assert.deepEqual(leaderPatch, { team_leader_member_id: MEMBER_ID });
  await patchChannelConfig(fakeFetch, TEAM_CHANNEL_ID, leaderPatch ?? {});

  const modePatch = modeChangePatch(TEAM_CHANNEL, 'autonomous', MEMBERS);
  assert.deepEqual(modePatch, { mode: 'autonomous' });
  await patchChannelConfig(fakeFetch, TEAM_CHANNEL_ID, modePatch ?? {});

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, `/api/channels/${TEAM_CHANNEL_ID}`);
    assert.equal(call.init?.method, 'PATCH', 'both actions use the same PATCH endpoint');
    assert.equal(
      (call.init?.headers as Record<string, string> | undefined)?.['content-type'],
      'application/json',
    );
  }
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
    team_leader_member_id: MEMBER_ID,
  });
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), { mode: 'autonomous' });
});

test('switching to team needs a leader and reuses the leader already in the reading', () => {
  assert.deepEqual(modeChangePatch(AUTONOMOUS_CHANNEL, 'autonomous', MEMBERS), null);
  assert.deepEqual(
    leaderChangePatch(AUTONOMOUS_CHANNEL, MEMBER_ID),
    null,
    'a leader is only writable on a team channel',
  );
  assert.deepEqual(
    leaderChangePatch(TEAM_CHANNEL, LEADER_ID),
    null,
    'choosing the current leader is a no-op',
  );

  const leaderless = channel({
    id: AUTONOMOUS_CHANNEL_ID,
    name: '自主频道',
    mode: 'autonomous',
  });
  assert.deepEqual(
    modeChangePatch(leaderless, 'team', MEMBERS),
    { mode: 'team', team_leader_member_id: LEADER_ID },
    'the first Agent member becomes the leader when none is configured',
  );
  assert.deepEqual(
    modeChangePatch(leaderless, 'team', []),
    null,
    'team cannot be selected without an Agent member',
  );
  assert.deepEqual(
    materializePanel(leaderless, []),
    'disabled',
    'the team option is disabled when there is no candidate',
  );
});

/** Inspect whether the rendered team option is disabled (empty candidate list). */
function materializePanel(target: ChannelView, members: readonly TargetMemberView[]): string {
  const html = renderToStaticMarkup(
    createElement(ChannelConfigPanel, {
      channel: target,
      members,
      locale: 'zh-CN',
      onTeamConfigChange: () => Promise.resolve(),
    }),
  );
  return html.includes('data-team-option="disabled"') ? 'disabled' : 'enabled';
}

test('leader candidates are the channel Agent members, never the owner', () => {
  assert.deepEqual(
    leaderCandidates(MEMBERS).map((member) => member.id),
    [LEADER_ID, MEMBER_ID],
  );
  assert.deepEqual(leaderCandidates(undefined), []);
});

test('a workspace.changed frame with source=team refreshes the workspace and has no second stream', async () => {
  const event = parseLiveEvent('workspace.changed', JSON.stringify({ source: 'team' }));
  assert.ok(event !== null);
  assert.equal(event.event, 'workspace.changed');
  assert.equal(event.data['source'], 'team');
  assert.equal(shouldRefreshWorkspace('workspace.changed'), true);

  // The shell owns exactly one global subscription; no target opens a second
  // EventSource (D2.5 / R1 subscription).
  const sources = await sourceFiles(new URL('../src/', import.meta.url));
  const subscriptions: string[] = [];
  for (const file of sources) {
    const source = await readFile(file, 'utf8');
    const count = source.split('/api/events').length - 1;
    if (count > 0) {
      subscriptions.push(`${file.pathname}:${count}`);
    }
  }
  assert.deepEqual(subscriptions.length, 1, `one subscription site only: ${subscriptions.join(', ')}`);
  assert.match(subscriptions[0] ?? '', /WorkspaceChat\.ts:1$/);
});

async function sourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}
