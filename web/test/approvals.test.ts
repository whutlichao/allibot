import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fileURLToPath } from 'node:url';
import type {
  AgentView,
  ApprovalView,
  ChannelView,
  PermissionRuleView,
  TargetMemberView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import { ApprovalPanel } from '../src/workspace/ApprovalPanel.ts';
import { ChannelConfigPanel } from '../src/workspace/ChannelConfigPanel.ts';
import {
  approvalBatchLabel,
  approvalContextLabel,
  approvalStatusLabel,
  callNeedsDecision,
  readApprovalFrame,
} from '../src/workspace/approvals.ts';
import {
  agentPermissionModePatch,
  channelPermissionModePatch,
  permissionRuleInputs,
} from '../src/workspace/permissions.ts';
import {
  LIVE_EVENT_TYPES,
  shouldRefreshWorkspace,
} from '../src/workspace/message-sync.ts';
import {
  saveAgentConfig,
  savePermissionRules,
  submitApprovalDecision,
} from '../src/workspace-actions.ts';

/**
 * 审批面板与权限配置 (#44 / D2.3 / D5.5 / D5.6). The panel is a data contract:
 * it renders the list / detail / multi-batch history and the permission mode +
 * full rule set; decisions and rule writes are one host action each. Approval
 * is never rendered as a message.
 */

const LOCALE = 'zh-CN' as const;
const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const AGENT_ID = 'agent-1';
const REPLY_ID = 'reply-1';
const CALL_ONE = 'call-1';
const CALL_TWO = 'call-2';

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: CHANNEL_ID,
    name: '审批频道',
    description: '',
    mode: 'autonomous',
    team: { leader_member_id: null, status: 'valid', reason: null },
    workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 0 },
    permission_mode: 'ask-writes',
    response_budget_limit: 3,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: AGENT_ID,
    kind: 'agent',
    display_name: '审批成员',
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    role: '',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: '',
    enabled: 1,
    context_window: 40,
    compression_threshold: 0.8,
    max_iterations: 8,
    auto_claim: 1,
    workspace_backend: null,
    permission_mode: null,
    effective_permission_mode: 'ask-writes',
    home_path: '/tmp/allibot-home/agents/agent-1',
    status: 'online',
    offline_reason: null,
    ...overrides,
  };
}

function members(): TargetMemberView[] {
  return [
    {
      id: 'owner-1',
      kind: 'owner',
      display_name: '我',
      avatar_slot: 0,
      workspace_status: { backend: 'local', available: true, reason: null }, allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
    {
      id: AGENT_ID,
      kind: 'agent',
      display_name: '审批成员',
      avatar_slot: 1,
      workspace_status: { backend: 'local', available: true, reason: null }, allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
  ];
}

function rule(
  id: string,
  toolName: string,
  pattern: string,
  behavior: PermissionRuleView['behavior'],
): PermissionRuleView {
  return {
    id,
    scope_kind: 'channel',
    scope_id: CHANNEL_ID,
    tool_name: toolName,
    pattern,
    behavior,
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
  };
}

function approval(overrides: Partial<ApprovalView> = {}): ApprovalView {
  const base: ApprovalView = {
    reply_id: REPLY_ID,
    target_id: CHANNEL_ID,
    context_kind: 'round',
    context_id: null,
    status: 'pending',
    requested_at: '2026-11-04T01:00:00.000Z',
    resolved_at: null,
    tool_calls: [
      {
        tool_call_id: CALL_ONE,
        tool_name: 'Write',
        pattern: 'first.txt',
        batch: 1,
        arguments: { path: 'first.txt', content: 'one' },
        requested_at: '2026-11-04T01:00:00.000Z',
      },
      {
        tool_call_id: CALL_TWO,
        tool_name: 'Write',
        pattern: 'second.txt',
        batch: 2,
        arguments: { path: 'second.txt', content: 'two' },
        requested_at: '2026-11-04T01:01:00.000Z',
      },
    ],
    decisions: [
      { tool_call_id: CALL_ONE, confirmed: true, decided_at: '2026-11-04T01:00:30.000Z' },
    ],
    batches: [
      {
        batch: 1,
        requested_at: '2026-11-04T01:00:00.000Z',
        tool_calls: [
          {
            tool_call_id: CALL_ONE,
            tool_name: 'Write',
            pattern: 'first.txt',
            batch: 1,
            arguments: { path: 'first.txt', content: 'one' },
            requested_at: '2026-11-04T01:00:00.000Z',
          },
        ],
        decisions: [
          { tool_call_id: CALL_ONE, confirmed: true, decided_at: '2026-11-04T01:00:30.000Z' },
        ],
      },
      {
        batch: 2,
        requested_at: '2026-11-04T01:01:00.000Z',
        tool_calls: [
          {
            tool_call_id: CALL_TWO,
            tool_name: 'Write',
            pattern: 'second.txt',
            batch: 2,
            arguments: { path: 'second.txt', content: 'two' },
            requested_at: '2026-11-04T01:01:00.000Z',
          },
        ],
        decisions: [],
      },
    ],
  };
  return { ...base, ...overrides };
}

test('the approval list renders pending and resolved rows with readable status and context, and an empty state', () => {
  const pending = approval();
  const resolved = approval({
    reply_id: 'reply-2',
    status: 'denied',
    context_kind: 'team-assignment',
    context_id: 'assignment-1',
    resolved_at: '2026-11-04T02:00:00.000Z',
    decisions: [
      ...pending.decisions,
      { tool_call_id: CALL_TWO, confirmed: false, decided_at: '2026-11-04T01:02:00.000Z' },
    ],
  });
  const html = renderToStaticMarkup(
    createElement(ApprovalPanel, {
      approvals: [pending, resolved],
      locale: LOCALE,
    }),
  );
  assert.match(html, /data-approval-list="true"/);
  assert.match(html, new RegExp(`data-approval-reply="${REPLY_ID}"`));
  assert.match(html, /data-approval-status="pending"/);
  assert.match(html, /data-approval-status="denied"/);
  assert.match(html, new RegExp(ZH_CN['workspace.approval.status.pending'].text));
  assert.match(html, new RegExp(ZH_CN['workspace.approval.status.denied'].text));
  assert.match(html, new RegExp(ZH_CN['workspace.approval.context.round'].text));
  assert.match(html, new RegExp(ZH_CN['workspace.approval.context.teamAssignment'].text));

  const empty = renderToStaticMarkup(
    createElement(ApprovalPanel, { approvals: [], locale: LOCALE }),
  );
  assert.match(empty, /data-approval-empty="true"/);
  assert.match(empty, new RegExp(ZH_CN['workspace.approval.empty'].text));
});

test('the approval detail renders every batch and its decisions, offers decisions only for the pending call, and renders no message', () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalPanel, {
      approvals: [approval()],
      selectedReplyId: REPLY_ID,
      locale: LOCALE,
    }),
  );
  assert.match(html, new RegExp(`data-approval-detail="${REPLY_ID}"`));
  assert.match(html, /data-approval-batch="1"/);
  assert.match(html, /data-approval-batch="2"/);
  assert.match(html, new RegExp(approvalBatchLabel(LOCALE, 1)));
  assert.match(html, new RegExp(approvalBatchLabel(LOCALE, 2)));
  assert.match(html, /data-tool-name="Write"/);
  assert.match(html, /first\.txt/);
  assert.match(html, /second\.txt/);
  // The first batch is decided; only the second batch offers approve / deny.
  assert.match(html, /data-decision="approved"/);
  assert.match(html, new RegExp(`data-action="approval-approve" data-tool-call="${CALL_TWO}"`));
  assert.match(html, new RegExp(`data-action="approval-deny" data-tool-call="${CALL_TWO}"`));
  assert.equal(html.includes(`data-action="approval-approve" data-tool-call="${CALL_ONE}"`), false);
  assert.match(html, new RegExp(ZH_CN['workspace.approval.decided'].text));
  // Approval is not a message: no chat bubble / message markup is produced.
  assert.equal(html.includes('class="message'), false);
  assert.equal(html.includes('data-message'), false);
  assert.equal(html.includes('data-approval-decisions="1"'), true);
});

test('approval frames parse the five-field payload; both events are live and refresh the reading, never a message append', () => {
  const frame = readApprovalFrame({
    reply_id: REPLY_ID,
    context_kind: 'round',
    context_id: null,
    target_id: CHANNEL_ID,
    status: 'pending',
    tool_call_ids: [CALL_ONE],
  });
  assert.deepEqual(frame, {
    reply_id: REPLY_ID,
    context_kind: 'round',
    context_id: null,
    target_id: CHANNEL_ID,
    status: 'pending',
    tool_call_ids: [CALL_ONE],
  });
  assert.equal(readApprovalFrame({ reply_id: REPLY_ID }), null);
  assert.equal(
    readApprovalFrame({
      reply_id: REPLY_ID,
      context_kind: 'unknown',
      status: 'pending',
      tool_call_ids: [],
    }),
    null,
  );
  assert.ok(LIVE_EVENT_TYPES.includes('approval.requested'));
  assert.ok(LIVE_EVENT_TYPES.includes('approval.resolved'));
  assert.equal(shouldRefreshWorkspace('approval.requested'), true);
  assert.equal(shouldRefreshWorkspace('approval.resolved'), true);
  assert.equal(approvalStatusLabel(LOCALE, 'expired'), ZH_CN['workspace.approval.status.expired'].text);
  assert.equal(approvalContextLabel(LOCALE, 'sop'), ZH_CN['workspace.approval.context.sop'].text);
  assert.equal(callNeedsDecision(approval(), CALL_ONE), false);
  assert.equal(callNeedsDecision(approval(), CALL_TWO), true);
});

test('the channel permission control renders the three modes and the full rule set', () => {
  const rules = [
    rule('rule-1', 'Write', 'src/**', 'ask'),
    rule('rule-2', 'Bash', '', 'deny'),
  ];
  const html = renderToStaticMarkup(
    createElement(ChannelConfigPanel, {
      channel: channel(),
      members: members(),
      workspaceStatus: { backend: 'local', available: true, reason: null },
      locale: LOCALE,
      permissionRules: rules,
      onPermissionRulesChange: () => undefined,
    }),
  );
  assert.match(html, /data-action="channel-permission-mode"/);
  assert.match(html, /data-permission-mode="ask-writes"/);
  assert.match(html, new RegExp(ZH_CN['workspace.permission.mode.readOnly'].text));
  assert.match(html, new RegExp(ZH_CN['workspace.permission.mode.trustedWrites'].text));
  assert.match(html, /data-permission-rules=""/);
  assert.match(html, /data-permission-rule="0"/);
  assert.match(html, /data-permission-rule="1"/);
  assert.match(html, /value="src\/\*\*"/);
  assert.match(html, new RegExp(ZH_CN['workspace.permission.behavior.deny'].text));
  assert.match(html, /data-action="save-permission-rules"/);
  assert.match(html, /data-action="add-permission-rule"/);
  assert.match(html, new RegExp(ZH_CN['workspace.permission.rules.title'].text));
});

test('the Agent permission control renders the follow-channel option and the full rule set', () => {
  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent({ permission_mode: 'read-only' }),
      locale: LOCALE,
      onPermissionModeChange: () => undefined,
      permissionRules: [rule('rule-1', 'Read', 'secret/**', 'deny')],
      onPermissionRulesChange: () => undefined,
    }),
  );
  assert.match(html, /data-action="agent-permission-mode"/);
  assert.match(html, /data-permission-mode="read-only"/);
  assert.match(html, new RegExp(ZH_CN['workspace.permission.mode.followChannel'].text));
  assert.match(html, /data-permission-rules=""/);
  assert.match(html, /value="secret\/\*\*"/);
  assert.match(html, new RegExp(ZH_CN['workspace.permission.rules.title'].text));
});

test('permission mode patches write only on a change and follow clears the Agent override', () => {
  assert.equal(channelPermissionModePatch(channel(), 'ask-writes'), null);
  assert.deepEqual(channelPermissionModePatch(channel(), 'trusted-writes'), {
    permission_mode: 'trusted-writes',
  });
  assert.equal(channelPermissionModePatch(channel(), 'BYPASS'), null);

  assert.equal(agentPermissionModePatch(agent(), 'follow'), null);
  assert.deepEqual(agentPermissionModePatch(agent({ permission_mode: 'read-only' }), 'follow'), {
    permission_mode: null,
  });
  assert.deepEqual(agentPermissionModePatch(agent(), 'read-only'), {
    permission_mode: 'read-only',
  });
  assert.equal(agentPermissionModePatch(agent({ permission_mode: 'read-only' }), 'read-only'), null);

  assert.deepEqual(
    permissionRuleInputs([
      { tool_name: 'Write', pattern: 'src/**', behavior: 'ask' },
      { tool_name: '   ', pattern: '', behavior: 'deny' },
    ]),
    [{ tool_name: 'Write', pattern: 'src/**', behavior: 'ask' }],
  );
});

test('the host actions send the one PUT / POST / PATCH each, with the full rule set and no second write path', async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    if (init?.method === 'PUT') {
      return new Response(JSON.stringify({ rules: [] }), { status: 200 });
    }
    if (init?.method === 'POST') {
      return new Response(JSON.stringify(approval()), { status: 200 });
    }
    return new Response(JSON.stringify(channel()), { status: 200 });
  }) as typeof fetch;

  await savePermissionRules(fetchImpl, { kind: 'channel', id: CHANNEL_ID }, [
    { tool_name: 'Write', pattern: 'src/**', behavior: 'ask' },
  ]);
  await submitApprovalDecision(fetchImpl, REPLY_ID, {
    tool_call_id: CALL_TWO,
    confirmed: false,
    rules: [{ tool_name: 'Write', pattern: '', behavior: 'deny' }],
  });
  await saveAgentConfig(fetchImpl, AGENT_ID, { permission_mode: null });

  assert.deepEqual(calls[0], {
    method: 'PUT',
    url: `/api/channels/${CHANNEL_ID}/permission-rules`,
    body: [{ tool_name: 'Write', pattern: 'src/**', behavior: 'ask' }],
  });
  assert.deepEqual(calls[1], {
    method: 'POST',
    url: `/api/approvals/${REPLY_ID}`,
    body: {
      tool_call_id: CALL_TWO,
      confirmed: false,
      rules: [{ tool_name: 'Write', pattern: '', behavior: 'deny' }],
    },
  });
  assert.deepEqual(calls[2], {
    method: 'PATCH',
    url: `/api/agents/${AGENT_ID}`,
    body: { permission_mode: null },
  });
});

test('the shell loads the approval list and consumes approval frames through the one live stream', async () => {
  const main = readFileSync(
    fileURLToPath(new URL('../src/main.tsx', import.meta.url)),
    'utf8',
  );
  assert.match(main, /readApprovals/);
  assert.match(main, /loadApprovals/);
  assert.match(main, /approval\.requested/);
  assert.match(main, /approval\.resolved/);
  assert.match(main, /readApprovalFrame/);
  assert.equal((main.match(/new EventSource\(/g) ?? []).length <= 1, true);
  const shell = readFileSync(
    fileURLToPath(new URL('../src/workspace/WorkspaceShell.ts', import.meta.url)),
    'utf8',
  );
  assert.match(shell, /ApprovalPanel/);
  assert.match(shell, /data-action': 'open-approvals'/);
  assert.equal(shell.includes('data-message'), false);
});
