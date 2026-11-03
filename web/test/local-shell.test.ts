import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  ApprovalView,
  ChannelView,
  TargetMemberView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { ApprovalPanel } from '../src/workspace/ApprovalPanel.ts';
import { ChannelConfigPanel } from '../src/workspace/ChannelConfigPanel.ts';
import { localShellChangePatch } from '../src/workspace/channel-config.ts';
import { patchChannelConfig } from '../src/workspace-actions.ts';

/**
 * 本地 shell 的呈现契约 (#46 / D5.4 / D5.6): the channel config exposes one
 * explicit switch with the "no sandbox, per-call approval" risk copy, and the
 * approval panel renders a shell call by tool name + readable command. It is a
 * data / render contract only, like every other web suite.
 */

const LOCALE = 'zh-CN' as const;
const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';

function channel(overrides: Partial<ChannelView> = {}): ChannelView {
  return {
    id: CHANNEL_ID,
    name: '本地 shell 频道',
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

function members(): TargetMemberView[] {
  return [
    {
      id: OWNER_ID,
      kind: 'owner',
      display_name: '我',
      avatar_slot: 0,
      workspace_status: { backend: 'local', available: true, reason: null },
      allow_local_shell: 1,
      permission_mode: 'ask-writes',
    },
    {
      id: AGENT_ID,
      kind: 'agent',
      display_name: '本地成员',
      avatar_slot: 1,
      workspace_status: { backend: 'local', available: true, reason: null },
      allow_local_shell: 1,
      permission_mode: 'ask-writes',
    },
  ];
}

function renderConfig(target: ChannelView): string {
  return renderToStaticMarkup(
    createElement(ChannelConfigPanel, {
      channel: target,
      members: members(),
      locale: LOCALE,
      onTeamConfigChange: () => Promise.resolve(),
    }),
  );
}

function shellApproval(): ApprovalView {
  return {
    reply_id: 'reply-shell',
    target_id: CHANNEL_ID,
    context_kind: 'round',
    context_id: null,
    status: 'pending',
    requested_at: '2026-11-04T00:00:00.000Z',
    resolved_at: null,
    tool_calls: [
      {
        tool_call_id: 'call-shell',
        tool_name: 'Bash',
        pattern: 'ls -la',
        batch: 1,
        arguments: { tool_name: 'Bash', command: 'ls -la', cwd: '/tmp/project' },
        requested_at: '2026-11-04T00:00:00.000Z',
      },
    ],
    decisions: [],
    batches: [
      {
        batch: 1,
        requested_at: '2026-11-04T00:00:00.000Z',
        tool_calls: [
          {
            tool_call_id: 'call-shell',
            tool_name: 'Bash',
            pattern: 'ls -la',
            batch: 1,
            arguments: { tool_name: 'Bash', command: 'ls -la', cwd: '/tmp/project' },
            requested_at: '2026-11-04T00:00:00.000Z',
          },
        ],
        decisions: [],
      },
    ],
  };
}

test('the channel config renders the explicit local-shell switch and the no-sandbox risk copy', () => {
  const off = renderConfig(channel());
  assert.match(off, /data-action="local-shell"/);
  assert.match(off, /data-allow-local-shell="0"/);
  assert.doesNotMatch(off, /data-allow-local-shell="0"[^>]*checked/);
  assert.ok(
    off.includes(ZH_CN['channel.config.workspace.shell.label'].text),
    'the switch label comes from the catalog',
  );
  assert.ok(
    off.includes(ZH_CN['channel.config.workspace.shell.risk'].text),
    'the risk copy is always visible',
  );
  assert.match(off, /data-shell-risk="true"/);
  assert.match(
    off,
    /无沙箱/,
    'the copy states the known risk instead of calling local a sandbox',
  );

  const on = renderConfig(
    channel({ workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 1 } }),
  );
  assert.match(on, /data-allow-local-shell="1"/);
  assert.match(on, /checked=""/);
});

test('the local-shell switch is a channel-only PATCH and a same-value toggle sends nothing', async () => {
  assert.deepEqual(localShellChangePatch(channel(), true), { allow_local_shell: 1 });
  assert.deepEqual(localShellChangePatch(channel(), false), null);
  const enabled = channel({
    workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 1 },
  });
  assert.deepEqual(localShellChangePatch(enabled, false), { allow_local_shell: 0 });
  assert.deepEqual(localShellChangePatch(enabled, true), null);

  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(channel()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  await patchChannelConfig(fakeFetch, CHANNEL_ID, { allow_local_shell: 1 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, `/api/channels/${CHANNEL_ID}`);
  assert.equal(calls[0]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { allow_local_shell: 1 });
});

test('the approval panel presents a shell call by tool name and readable command, not a raw environment', () => {
  const html = renderToStaticMarkup(
    createElement(ApprovalPanel, {
      approvals: [shellApproval()],
      selectedReplyId: 'reply-shell',
      locale: LOCALE,
      onDecision: () => undefined,
    }),
  );
  assert.match(html, /data-tool-name="Bash"/);
  assert.match(html, /data-approval-shell="true"/);
  assert.ok(html.includes(ZH_CN['workspace.approval.shell.command'].text));
  assert.ok(html.includes('ls -la'), 'the readable command is shown');
  assert.ok(html.includes('/tmp/project'), 'the in-root cwd is shown when present');
  assert.match(html, /data-action="approval-approve"/);
  assert.equal(html.includes('ANTHROPIC_API_KEY'), false);
  assert.equal(html.includes('api_key'), false, 'shell calls do not render a raw argument blob');
});
