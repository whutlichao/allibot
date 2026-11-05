import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentView,
  ChannelView,
  TargetMemberView,
  WorkspaceStatusView,
  WorkspaceView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import { workspaceStatusCopy } from '../src/workspace/channel-config.ts';
import {
  agentBackendChangePatch,
  workspaceBackendOptions,
} from '../src/workspace/workspace-backend.ts';
import { saveAgentConfig } from '../src/workspace-actions.ts';

/**
 * 工作区后端选择与 Docker 原因呈现 (#49 / D2.2 / D5.3 / D5.7). 前端只做数据
 * 契约：后端选择来自同一份读数，Docker 原因由文案目录渲染，宿主只发一次
 * 写请求；不建第二套领域 seam。
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';
const IMAGE = 'node:22-bookworm-slim';

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: AGENT_ID,
    kind: 'agent',
    display_name: '工作区 Agent',
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    role: 'engineer',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: '你是实现者。',
    enabled: 1,
    context_window: 40,
    compression_threshold: 0.8,
    max_iterations: 8,
    auto_claim: 1,
    workspace_backend: null,
    permission_mode: null,
    effective_permission_mode: 'ask-writes',
    web_access: null,
    effective_web_access: 'search',
    home_path: '/tmp/allibot-home/agents/agent-1',
    status: 'online',
    offline_reason: null,
    ...overrides,
  };
}

function channel(backend: 'local' | 'docker', root: string | null): ChannelView {
  return {
    id: CHANNEL_ID,
    name: 'Docker 频道',
    description: '',
    mode: 'autonomous',
    team: { leader_member_id: null, status: 'valid', reason: null },
    workspace: { root, backend, allow_local_shell: 0 },
    permission_mode: 'ask-writes',
    web_access: null,
    docker_egress: 0,
    response_budget_limit: 3,
    archived_at: null,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
  };
}

function workspace(target: ChannelView): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [agent()],
    channels: [target],
    dms: [],
    tasks: [],
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: {},
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
    workspace_runtime: {
      docker: { available: false, image: IMAGE, reason: 'docker-unavailable' },
    },
  };
}

function members(status: WorkspaceStatusView): TargetMemberView[] {
  return [
    {
      id: OWNER_ID,
      kind: 'owner',
      display_name: 'owner',
      avatar_slot: 0,
      workspace_status: status,
      allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
    {
      id: AGENT_ID,
      kind: 'agent',
      display_name: '工作区 Agent',
      avatar_slot: 1,
      workspace_status: status,
      allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
  ];
}

function renderAgentDetail(
  view: AgentView,
  onChange?: (backend: 'local' | 'docker' | null) => void,
): string {
  return renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: view,
      locale: 'zh-CN',
      onWorkspaceBackendChange: onChange,
    }),
  );
}

test('the Agent backend override helper writes only a changed value and treats follow as null', () => {
  const follow = agent({ workspace_backend: null });
  assert.deepEqual(agentBackendChangePatch(follow, 'docker'), { workspace_backend: 'docker' });
  assert.equal(agentBackendChangePatch(follow, 'follow'), null);
  assert.equal(agentBackendChangePatch(follow, 'podman'), null);

  const docker = agent({ workspace_backend: 'docker' });
  assert.equal(agentBackendChangePatch(docker, 'docker'), null);
  assert.deepEqual(agentBackendChangePatch(docker, 'local'), { workspace_backend: 'local' });
  assert.deepEqual(agentBackendChangePatch(docker, 'follow'), { workspace_backend: null });

  assert.deepEqual(
    workspaceBackendOptions('zh-CN').map((option) => option.value),
    ['local', 'docker'],
  );
});

test('the Agent config area renders the backend select from the raw override', () => {
  const followHtml = renderAgentDetail(agent({ workspace_backend: null }), () => undefined);
  assert.match(followHtml, /data-action="agent-workspace-backend"/);
  assert.match(followHtml, /data-workspace-backend="follow"/);
  assert.ok(followHtml.includes(ZH_CN['channel.config.workspace.backend.label'].text));
  assert.ok(followHtml.includes(ZH_CN['workspace.agent.workspaceBackend.followChannel'].text));
  assert.ok(followHtml.includes(ZH_CN['channel.config.workspace.backend.local'].text));
  assert.ok(followHtml.includes(ZH_CN['channel.config.workspace.backend.docker'].text));

  const dockerHtml = renderAgentDetail(
    agent({ workspace_backend: 'docker' }),
    () => undefined,
  );
  assert.match(dockerHtml, /data-workspace-backend="docker"/);
  assert.ok(
    dockerHtml.includes(ZH_CN['channel.config.workspace.backend.docker'].text),
    'the raw override renders without the host resolving the channel value',
  );
});

test('the Agent detail read-only form shows the follow-channel copy without a write entry', () => {
  const html = renderAgentDetail(agent({ workspace_backend: null }));
  assert.equal(html.includes('data-action="agent-workspace-backend"'), false);
  assert.ok(html.includes(ZH_CN['workspace.agent.workspaceBackend.followChannel'].text));
});

test('Docker image reasons render the readable copy in the target context', () => {
  for (const [reason, key] of [
    ['docker-image-missing', 'workspace.status.reason.dockerImageMissing'],
    ['docker-consent-missing', 'workspace.status.reason.dockerConsentMissing'],
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(ContextPanel, {
        workspace: workspace(channel('docker', '/tmp/project')),
        targetId: CHANNEL_ID,
        locale: 'zh-CN',
        channelMembers: members({ backend: 'docker', available: false, reason }),
      }),
    );
    assert.match(html, new RegExp(`data-workspace-reason="${reason}"`));
    assert.ok(html.includes(ZH_CN[key].text), `${reason} has the readable catalog copy`);
    assert.equal(
      workspaceStatusCopy('zh-CN', { backend: 'docker', available: false, reason }),
      ZH_CN[key].text,
    );
  }
});

test('the Agent save path sends the raw workspace_backend override to the Agent URL', async () => {
  const calls: { method: string; url: string; body: unknown }[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(input),
      body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    return new Response(JSON.stringify(agent({ workspace_backend: 'docker' })), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await saveAgentConfig(fetchImpl, AGENT_ID, { workspace_backend: 'docker' });
  await saveAgentConfig(fetchImpl, AGENT_ID, { workspace_backend: null });
  assert.deepEqual(calls, [
    {
      method: 'PATCH',
      url: `/api/agents/${AGENT_ID}`,
      body: { workspace_backend: 'docker' },
    },
    {
      method: 'PATCH',
      url: `/api/agents/${AGENT_ID}`,
      body: { workspace_backend: null },
    },
  ]);
});
