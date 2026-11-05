import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  type ChannelView,
  type SopDefinitionView,
  type SopRunView,
  type SopUpdateFrame,
  type TargetMemberView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { LIVE_EVENT_TYPES } from '../src/workspace/message-sync.ts';
import { SopPanel } from '../src/workspace/SopPanel.ts';
import {
  applySopUpdateFrame,
  mergeSopRun,
  readSopRunState,
  readSopUpdateFrame,
  sopPhaseLabel,
  sopWaitingOnLabel,
} from '../src/workspace/sops.ts';

/**
 * SOP 运行面板 (#45 / D4.2 / D4.3 / D2.5): the five-phase progress, current
 * step / attempt, `waiting_on`, and the executor / verifier excerpts, consumed
 * from the one global `sop_update` frame without a poll loop. A SOP run is
 * never a message, a task row or a board card.
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const DEFINITION_ID = 'sop-def-1';
const RUN_ID = 'sop-run-1';

const MEMBERS: readonly TargetMemberView[] = [
  {
    id: 'agent-a',
    kind: 'agent',
    display_name: '执行者甲',
    avatar_slot: 1,
    workspace_status: { backend: 'local', available: true, reason: null },
    allow_local_shell: 0,
    permission_mode: 'ask-writes',
  },
];

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: CHANNEL_ID,
    name: 'SOP 频道',
    description: '',
    mode: 'autonomous',
    team: { leader_member_id: null, status: 'valid', reason: null },
    workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 0 },
    permission_mode: 'ask-writes',
    web_access: null,
    docker_egress: 0,
    response_budget_limit: 3,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    ...overrides,
  };
}

const DEFINITION: SopDefinitionView = {
  id: DEFINITION_ID,
  channel_id: CHANNEL_ID,
  name: '周报流程',
  steps: [
    {
      title: '收集',
      description: '读规格',
      executor_member_id: 'agent-a',
      verifier_member_id: 'agent-b',
      max_attempts: 2,
    },
  ],
  created_at: '2026-11-04T01:00:00.000Z',
};

const STEP = {
  index: 0,
  title: '收集',
  executor_member_id: 'agent-a',
  verifier_member_id: 'agent-b',
  attempts: 2,
  executor_excerpt: 'EXECUTOR-EXCERPT-STEP-0',
  verifier_excerpt: 'VERIFIER-EXCERPT-STEP-0',
  verifier_verdict: 'fail' as const,
  started_at: '2026-11-04T01:00:02.000Z',
  finished_at: null,
};

function run(overrides: Partial<SopRunView> = {}): SopRunView {
  return {
    id: RUN_ID,
    definition_id: DEFINITION_ID,
    channel_id: CHANNEL_ID,
    phase: 'awaiting',
    state: {
      current_step: 0,
      attempt: 2,
      steps: [STEP],
      waiting_on: 'approval',
      error: null,
      started_at: '2026-11-04T01:00:01.000Z',
      updated_at: '2026-11-04T01:00:03.000Z',
      finished_at: null,
    },
    current_step: 0,
    attempt: 2,
    waiting_on: 'approval',
    started_at: '2026-11-04T01:00:01.000Z',
    updated_at: '2026-11-04T01:00:03.000Z',
    finished_at: null,
    ...overrides,
  };
}

function render(runs: readonly SopRunView[]): string {
  return renderToStaticMarkup(
    createElement(SopPanel, {
      channel: channel(),
      definitions: [DEFINITION],
      runsByDefinition: { [DEFINITION_ID]: runs },
      members: MEMBERS,
      locale: 'zh-CN',
    }),
  );
}

test('the SOP run panel renders the five phases, step / attempt, waiting_on and both excerpts', () => {
  const html = render([run()]);
  assert.match(html, /data-sop-phases=""/);
  for (const phase of ['pending', 'running', 'awaiting', 'completed', 'failed']) {
    assert.match(html, new RegExp(`data-sop-phase="${phase}"`));
  }
  assert.match(html, /data-sop-phase="awaiting" data-sop-phase-active="true"/);
  assert.match(html, /data-sop-phase="failed" data-sop-phase-active="false"/);
  assert.match(html, /data-sop-run-phase="awaiting"/);
  assert.match(html, /data-sop-run-current-step="0"/);
  assert.match(html, /data-sop-run-attempt="2"/);
  assert.match(html, /data-sop-run-waiting-on="approval"/);
  assert.ok(html.includes(ZH_CN['workspace.sop.waiting.approval'].text));
  assert.match(html, /data-sop-executor-excerpt=""/);
  assert.match(html, /data-sop-verifier-excerpt=""/);
  assert.ok(html.includes('EXECUTOR-EXCERPT-STEP-0'));
  assert.ok(html.includes('VERIFIER-EXCERPT-STEP-0'));
  assert.match(html, /data-sop-step-verdict="fail"/);
  assert.doesNotMatch(html, /data-message-id|data-task-status/);

  const failed = render([
    run({
      phase: 'failed',
      waiting_on: null,
      finished_at: '2026-11-04T01:00:04.000Z',
      state: {
        current_step: 0,
        attempt: 2,
        steps: [STEP],
        waiting_on: null,
        error: '最后一次校验者的可读说明',
        started_at: '2026-11-04T01:00:01.000Z',
        updated_at: '2026-11-04T01:00:04.000Z',
        finished_at: '2026-11-04T01:00:04.000Z',
      },
    }),
  ]);
  assert.match(failed, /data-sop-run-phase="failed"/);
  assert.match(failed, /data-sop-phase="failed" data-sop-phase-active="true"/);
  assert.ok(failed.includes('最后一次校验者的可读说明'));

  const labels = (['pending', 'running', 'awaiting', 'completed', 'failed'] as const).map(
    (phase) => sopPhaseLabel('zh-CN', phase),
  );
  assert.equal(new Set(labels).size, 5);
});

test('readSopRunState tolerates malformed snapshots; waiting labels distinguish the two waits', () => {
  const state = readSopRunState({
    current_step: 1,
    attempt: 3,
    waiting_on: 'verifier',
    error: 'boom',
    steps: [
      { index: 0, title: 'A', attempts: 2, executor_excerpt: 'e', verifier_excerpt: 'v', verifier_verdict: 'pass' },
      null,
      { title: 'B-defaults' },
    ],
  });
  assert.equal(state.current_step, 1);
  assert.equal(state.attempt, 3);
  assert.equal(state.waiting_on, 'verifier');
  assert.equal(state.error, 'boom');
  assert.equal(state.steps.length, 2);
  assert.equal(state.steps[0]?.index, 0);
  assert.equal(state.steps[0]?.verifier_verdict, 'pass');
  assert.equal(state.steps[1]?.index, 2, 'a missing index falls back to its snapshot position');
  assert.equal(state.steps[1]?.attempts, 0);
  assert.equal(state.steps[1]?.executor_excerpt, null);

  const empty = readSopRunState({});
  assert.equal(empty.current_step, 0);
  assert.equal(empty.attempt, 0);
  assert.deepEqual(empty.steps, []);
  assert.equal(empty.waiting_on, null);
  assert.equal(empty.error, null);

  assert.equal(sopWaitingOnLabel('zh-CN', 'verifier'), ZH_CN['workspace.sop.waiting.verifier'].text);
  assert.equal(sopWaitingOnLabel('zh-CN', 'approval'), ZH_CN['workspace.sop.waiting.approval'].text);
  assert.equal(sopWaitingOnLabel('zh-CN', null), '—');
});

test('readSopUpdateFrame parses exactly the six D2.5 fields and apply / merge move the run snapshot', () => {
  const frame: SopUpdateFrame = {
    sop_run_id: RUN_ID,
    definition_id: DEFINITION_ID,
    phase: 'running',
    current_step: 1,
    attempt: 2,
    occurred_at: '2026-11-04T01:00:05.000Z',
  };
  assert.deepEqual(readSopUpdateFrame({ ...frame }), frame);
  assert.equal(readSopUpdateFrame({ ...frame, phase: 'paused' }), null);
  assert.equal(readSopUpdateFrame({ ...frame, current_step: '1' }), null);
  assert.equal(readSopUpdateFrame({ ...frame, occurred_at: undefined }), null);

  const updated = applySopUpdateFrame({ [DEFINITION_ID]: [run()] }, frame);
  const row = updated[DEFINITION_ID]?.[0];
  assert.equal(row?.phase, 'running');
  assert.equal(row?.current_step, 1);
  assert.equal(row?.attempt, 2);
  assert.equal(row?.waiting_on, null, 'a non-awaiting frame drops the stale wait');
  assert.equal(row?.updated_at, frame.occurred_at);
  assert.equal(row?.state.current_step, 0, 'the snapshot comes from the catch-up read');

  const unknown = applySopUpdateFrame({ [DEFINITION_ID]: [run()] }, {
    ...frame,
    sop_run_id: 'another-run',
  });
  assert.equal(unknown[DEFINITION_ID]?.[0]?.phase, 'awaiting');

  const merged = mergeSopRun({ [DEFINITION_ID]: [run()] }, run({ phase: 'completed', finished_at: '2026-11-04T01:00:09.000Z' }));
  assert.equal(merged[DEFINITION_ID]?.length, 1);
  assert.equal(merged[DEFINITION_ID]?.[0]?.phase, 'completed');

  const added = mergeSopRun({}, run({ id: 'new-run' }));
  assert.equal(added[DEFINITION_ID]?.[0]?.id, 'new-run');
});

test('the shell consumes sop_update over the one global stream without polling', () => {
  assert.ok((LIVE_EVENT_TYPES as readonly string[]).includes('sop_update'));
  const mainSource = readFileSync(new URL('../src/main.tsx', import.meta.url), 'utf8');
  assert.match(mainSource, /event\.event === 'sop_update'/);
  assert.match(mainSource, /readSopUpdateFrame/);
  assert.match(mainSource, /readSopRun\(fetch, frame\.sop_run_id\)/);
  assert.doesNotMatch(mainSource, /setInterval/);

  const sopsSource = readFileSync(new URL('../src/workspace/sops.ts', import.meta.url), 'utf8');
  assert.match(sopsSource, /sop_update|readSopUpdateFrame/);
  assert.doesNotMatch(sopsSource, /EventSource|setInterval/);

  const chatSource = readFileSync(
    new URL('../src/workspace/WorkspaceChat.ts', import.meta.url),
    'utf8',
  );
  assert.equal(
    chatSource.split('/api/events').length - 1,
    1,
    'the one global SSE subscription is unchanged',
  );
  assert.equal(
    mainSource.split('/api/events').length - 1,
    0,
    'the host never opens a second stream',
  );
});
