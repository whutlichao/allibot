import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChannelView, TaskView, TeamRunView, WorkspaceView } from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import { TeamRunsPanel } from '../src/workspace/TeamRunsPanel.ts';
import { readTeamRuns } from '../src/workspace/team-runs.ts';

/**
 * 运行面板的呈现契约（#38 / D3.3）：run 的状态、reason、task / channel 归属与
 * 时间来自 `GET /api/targets/{id}/team-runs`，运行记录不是消息。前端只做呈现层
 * 契约（R2）：SSR 只读 props，取数 helper 在系统边界（fetch）上替身。
 */

const TEAM_CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const AUTONOMOUS_CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const OWNER_ID = 'owner-1';
const LEADER_ID = 'agent-1';
const TASK_ID = 'task-1';
const TASK_TARGET_ID = '55555555-5555-4555-8555-555555555555';

function channel(overrides: Partial<ChannelView> & Pick<ChannelView, 'id' | 'name'>): ChannelView {
  return {
    description: '',
    mode: 'autonomous',
    team: { leader_member_id: null, status: 'valid', reason: null },
    response_budget_limit: 3,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

const TEAM_CHANNEL = channel({
  id: TEAM_CHANNEL_ID,
  name: 'team 频道',
  mode: 'team',
  team: { leader_member_id: LEADER_ID, status: 'valid', reason: null },
});

const AUTONOMOUS_CHANNEL = channel({
  id: AUTONOMOUS_CHANNEL_ID,
  name: '自主频道',
});

const TASK: TaskView = {
  id: TASK_ID,
  channel_id: TEAM_CHANNEL_ID,
  target_id: TASK_TARGET_ID,
  title: '整理资料',
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

const RUNS: readonly TeamRunView[] = [
  {
    id: 'run-channel',
    target_id: TEAM_CHANNEL_ID,
    channel_id: TEAM_CHANNEL_ID,
    task_id: null,
    leader_member_id: LEADER_ID,
    status: 'completed',
    reason: null,
    started_at: '2026-11-04T01:00:00.000Z',
    finished_at: '2026-11-04T01:00:02.000Z',
    assignments: [],
  },
  {
    id: 'run-task',
    target_id: TASK_TARGET_ID,
    channel_id: TEAM_CHANNEL_ID,
    task_id: TASK_ID,
    leader_member_id: LEADER_ID,
    status: 'invalid-leader',
    reason: ZH_CN['team.invalid.leaderDisabled'].text,
    started_at: '2026-11-04T02:00:00.000Z',
    finished_at: '2026-11-04T02:00:00.000Z',
    assignments: [],
  },
];

function workspace(): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [],
    channels: [TEAM_CHANNEL, AUTONOMOUS_CHANNEL],
    dms: [
      {
        id: 'dm-1',
        peer: { id: LEADER_ID, display_name: '队长', avatar_slot: 1, deleted_at: null },
      },
    ],
    tasks: [TASK],
    unread_total: 0,
    unread_by_target: { [TEAM_CHANNEL_ID]: 0, [TASK_TARGET_ID]: 0 },
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
  };
}

function renderRuns(runs: readonly TeamRunView[]): string {
  return renderToStaticMarkup(
    createElement(TeamRunsPanel, {
      runs,
      locale: 'zh-CN',
      tasks: [TASK],
      channels: [TEAM_CHANNEL],
    }),
  );
}

test('the run panel lists status, reason, task / channel attribution and time', () => {
  const html = renderRuns(RUNS);
  assert.match(html, /data-team-runs=""/, 'the run panel is its own region');
  assert.match(html, /data-team-run-id="run-channel"/);
  assert.match(html, /data-team-run-id="run-task"/);
  assert.match(html, /data-team-run-status="completed"/);
  assert.match(html, /data-team-run-status="invalid-leader"/);
  assert.ok(html.includes(ZH_CN['workspace.teamRuns.status.completed'].text));
  assert.ok(html.includes(ZH_CN['workspace.teamRuns.status.invalidLeader'].text));
  assert.ok(html.includes(ZH_CN['team.invalid.leaderDisabled'].text), 'the reason renders verbatim');
  assert.match(html, /data-run-attribution="channel"/, 'a channel run reads its channel');
  assert.match(html, /data-run-attribution="task"/, 'a task run names its task');
  assert.ok(html.includes('整理资料'), 'the task title resolves from the board reading');
  assert.ok(html.includes('team 频道'), 'the channel name resolves from the workspace reading');
  assert.ok(html.includes('2026-11-04T01:00:00.000Z'), 'the start time renders');
  assert.ok(html.includes('2026-11-04T01:00:02.000Z'), 'the finished time renders');
});

test('an empty run list renders a readable empty state, not a message', () => {
  const html = renderRuns([]);
  assert.match(html, /data-team-runs=""/);
  assert.ok(html.includes(ZH_CN['workspace.teamRuns.empty'].text));
  assert.doesNotMatch(html, /message-list|data-message-id/, 'a run is never rendered as a message');
});

test('the run panel appears for a team channel and team task, and not for an autonomous channel', () => {
  const teamPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(),
      targetId: TEAM_CHANNEL_ID,
      locale: 'zh-CN',
      channelMembers: [
        { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
        { id: LEADER_ID, kind: 'agent', display_name: '队长', avatar_slot: 1 },
      ],
      teamRuns: RUNS,
    }),
  );
  assert.match(teamPanel, /data-team-runs=""/);

  const taskPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(),
      targetId: TASK_TARGET_ID,
      locale: 'zh-CN',
      teamRuns: RUNS,
    }),
  );
  assert.match(taskPanel, /data-team-runs=""/, 'a team task thread shows its run panel');

  const autonomousPanel = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(),
      targetId: AUTONOMOUS_CHANNEL_ID,
      locale: 'zh-CN',
    }),
  );
  assert.doesNotMatch(autonomousPanel, /data-team-runs/, 'an autonomous channel has no team run panel');
});

test('reading the run snapshot goes through the one target endpoint with the limit', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify({ team_runs: RUNS }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };

  const runs = await readTeamRuns(fakeFetch, TEAM_CHANNEL_ID);
  assert.deepEqual(
    runs.map((run) => run.id),
    ['run-channel', 'run-task'],
  );
  assert.equal(
    calls[0]?.url,
    `/api/targets/${TEAM_CHANNEL_ID}/team-runs?limit=20`,
    'the default page is the one target snapshot',
  );

  await readTeamRuns(fakeFetch, TEAM_CHANNEL_ID, { limit: 5, before: 'run-channel' });
  assert.equal(
    calls[1]?.url,
    `/api/targets/${TEAM_CHANNEL_ID}/team-runs?limit=5&before=run-channel`,
  );
});
