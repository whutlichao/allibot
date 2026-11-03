import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ChannelView, TeamAssignmentState, TeamAssignmentView, TeamRunView } from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { TeamRunsPanel } from '../src/workspace/TeamRunsPanel.ts';
import {
  LIVE_EVENT_TYPES,
  shouldRefreshWorkspace,
} from '../src/workspace/message-sync.ts';
import {
  applyTeamAssignmentFrame,
  readTeamAssignmentFrame,
  teamAssignmentStateLabel,
} from '../src/workspace/team-runs.ts';

/**
 * 运行面板的分派区块 (#39 / D2.5 / D3.3): a `team_assignment` is a run record,
 * never a message. The panel expands its state / jump / excerpt; the one global
 * stream carries only final frames, and the shell consumes them as a run-panel
 * refresh (no message append, no second connection).
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const LEADER_ID = 'agent-leader';
const MEMBER_ID = 'agent-member';
const RUN_ID = 'run-1';

function channel(): ChannelView {
  return {
    id: CHANNEL_ID,
    name: '分派频道',
    description: '',
    mode: 'team',
    team: { leader_member_id: LEADER_ID, status: 'valid', reason: null },
    workspace: { root: null, backend: 'local', allow_local_shell: 0 },
    response_budget_limit: 3,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
  };
}

function assignment(
  overrides: Partial<TeamAssignmentView> & Pick<TeamAssignmentView, 'id' | 'state'>,
): TeamAssignmentView {
  return {
    team_run_id: RUN_ID,
    target_id: CHANNEL_ID,
    task_id: null,
    member_id: MEMBER_ID,
    jump_consumed: overrides.state === 'budget-exhausted' ? 0 : 1,
    reply_excerpt: null,
    reason: null,
    started_at: '2026-11-04T01:00:00.000Z',
    finished_at: '2026-11-04T01:00:01.000Z',
    ...overrides,
  };
}

const RUN: TeamRunView = {
  id: RUN_ID,
  target_id: CHANNEL_ID,
  channel_id: CHANNEL_ID,
  task_id: null,
  leader_member_id: LEADER_ID,
  status: 'completed',
  reason: null,
  started_at: '2026-11-04T01:00:00.000Z',
  finished_at: '2026-11-04T01:00:02.000Z',
  assignments: [
    assignment({
      id: 'assignment-ok',
      state: 'completed',
      reply_excerpt: '成员整理好的资料',
    }),
    assignment({
      id: 'assignment-failed',
      state: 'failed',
      reply_excerpt: null,
      reason: ZH_CN['team.member.disabled'].text,
    }),
    assignment({
      id: 'assignment-budget',
      state: 'budget-exhausted',
      reply_excerpt: null,
      reason: '分派预算耗尽：本世代已用 3/3 跳，本次分派未运行成员。',
    }),
  ],
};

function renderRuns(runs: readonly TeamRunView[]): string {
  return renderToStaticMarkup(
    createElement(TeamRunsPanel, {
      runs,
      locale: 'zh-CN',
      channels: [channel()],
    }),
  );
}

test('the run panel expands each assignment state, jump and excerpt without rendering a message', () => {
  const html = renderRuns([RUN]);
  assert.match(html, /data-team-assignments=""/, 'assignments are their own region');
  assert.match(html, /data-team-assignment-id="assignment-ok"/);
  assert.match(html, /data-team-assignment-state="completed"/);
  assert.match(html, /data-team-assignment-state="failed"/);
  assert.match(html, /data-team-assignment-state="budget-exhausted"/);
  assert.ok(html.includes(ZH_CN['workspace.teamRuns.assignments.state.completed'].text));
  assert.ok(html.includes(ZH_CN['workspace.teamRuns.assignments.state.budgetExhausted'].text));
  assert.ok(html.includes('成员整理好的资料'), 'the excerpt renders verbatim');
  assert.ok(html.includes(ZH_CN['team.member.disabled'].text), 'the failure reason renders');
  assert.match(html, /data-assignment-jump="1"/);
  assert.match(html, /data-assignment-jump="0"/);
  assert.doesNotMatch(html, /data-message-id|message-list/, 'an assignment is never a message');
});

test('the assignment states have readable labels', () => {
  const states: TeamAssignmentState[] = ['running', 'completed', 'failed', 'budget-exhausted'];
  for (const state of states) {
    const label = teamAssignmentStateLabel('zh-CN', state);
    assert.ok(label.length > 0, `${state} has a label`);
  }
  assert.equal(
    teamAssignmentStateLabel('zh-CN', 'budget-exhausted'),
    ZH_CN['workspace.teamRuns.assignments.state.budgetExhausted'].text,
  );
});

test('a team_assignment frame parses and updates the nested run reading in place', () => {
  const frame = readTeamAssignmentFrame({
    team_run_id: RUN_ID,
    assignment_id: 'assignment-ok',
    target_id: CHANNEL_ID,
    task_id: null,
    member_id: MEMBER_ID,
    state: 'completed',
    jump_consumed: 1,
    reply_excerpt: '新的摘录',
    reason: null,
    occurred_at: '2026-11-04T01:00:03.000Z',
  });
  assert.ok(frame !== null);

  const runs = { [CHANNEL_ID]: [RUN] };
  const next = applyTeamAssignmentFrame(runs, frame);
  const updated = next[CHANNEL_ID]?.[0]?.assignments.find((row) => row.id === 'assignment-ok');
  assert.equal(updated?.state, 'completed');
  assert.equal(updated?.reply_excerpt, '新的摘录');
  assert.equal(updated?.finished_at, '2026-11-04T01:00:03.000Z');
  assert.equal(runs[CHANNEL_ID]?.[0]?.assignments[0]?.reply_excerpt, '成员整理好的资料');

  assert.equal(
    readTeamAssignmentFrame({ assignment_id: 'only-an-id' }),
    null,
    'a malformed frame is ignored, not trusted',
  );
});

test('the one global stream listens to team_assignment and refreshes the run panel, not messages', () => {
  assert.ok((LIVE_EVENT_TYPES as readonly string[]).includes('team_assignment'));
  assert.equal(
    shouldRefreshWorkspace('team_assignment'),
    false,
    'the frame updates the run reading, not the whole workspace',
  );

  const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(mainSource, /event\.event === 'team_assignment'/, 'main handles the frame');
  assert.match(mainSource, /loadTeamRuns\(frame\.target_id\)/, 'the frame re-reads that target runs');

  const source = readFileSync(
    new URL('../src/workspace/WorkspaceChat.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    source.split('/api/events').length - 1,
    1,
    'the SSE subscription stays the one global connection',
  );
});
