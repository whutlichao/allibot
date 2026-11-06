import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { HttpAgent } from '@copilotkit/react-core/v2';
import type {
  AgentView,
  RemoteDataFlowReadView,
  TargetMemberView,
  WorkspaceView,
} from '@allibot/shared';
import { ALLIBOT_AGENT_ID } from '../src/copilotkit-contract.ts';

import {
  AGENT_BASIC_SECTIONS,
  AGENT_DETAIL_TABS,
  editSystemPrompt,
  hasUnsavedSystemPrompt,
  initialAgentDetailState,
  switchAgentDetailTab,
} from '../src/workspace/agent-detail.ts';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import { MemberPanel } from '../src/workspace/MemberPanel.ts';
import { MemberRoster } from '../src/workspace/MemberRoster.ts';
import {
  applyJoinResult,
  readMemberNotice,
  readMemberPanel,
  readMemberRoster,
} from '../src/workspace/member-reading.ts';
import {
  confirmProviderDataFlow,
  createAgent,
  joinChannelMember,
  readChannelMembers,
  readRemoteDataFlow,
} from '../src/workspace-actions.ts';
import {
  editInlineCreateName,
  initialInlineCreate,
  submitInlineCreate,
} from '../src/workspace/inline-create.ts';
import { hydrateThread } from '../src/workspace/message-sync.ts';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import { WorkspaceShell } from '../src/workspace/WorkspaceShell.ts';
import { openWorkspacePanel, type WorkspaceShellState } from '../src/workspace/shell-state.ts';

/**
 * Agent 详情页签、成员面板与成员名册的组件级契约测试（#32 / T8）。
 *
 * 规格 R2：前端只做呈现层契约。这里不建第二套领域 seam：成员关系、状态点、
 * 软删除过滤与加入频道的写路径都由后端 HTTP 面验收；本文件只验证组件按
 * props 呈现、按后端读数分段、按词条渲染，以及「打开 / 切换页签」不改
 * target、不写消息、不重新拉取。
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const DM_ID = '33333333-3333-4333-8333-333333333333';
const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';
const NOT_JOINED_ID = 'agent-2';
const OFFLINE_ID = 'agent-3';

function agent(overrides: Partial<AgentView> & Pick<AgentView, 'id' | 'display_name'>): AgentView {
  return {
    kind: 'agent',
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    role: 'engineer',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: '你是一名负责实现的工程师。',
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

function workspace(overrides: Partial<WorkspaceView> = {}): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [
      agent({ id: AGENT_ID, display_name: '阿蓝' }),
      agent({
        id: NOT_JOINED_ID,
        display_name: '阿绿',
        avatar_slot: 2,
        role: 'reviewer',
        model: 'anthropic:claude-sonnet-5-5',
      }),
      agent({
        id: OFFLINE_ID,
        display_name: '阿灰',
        avatar_slot: 3,
        model: 'openai:gpt-5',
        credential_status: 'missing',
        status: 'offline',
        offline_reason: 'credential-missing',
      }),
    ],
    channels: [
      {
        id: CHANNEL_ID,
        name: '协作环',
        description: '',
        mode: 'autonomous',
        team: { leader_member_id: null, status: 'valid', reason: null },
    workspace: { root: null, backend: 'local', allow_local_shell: 0 },
        permission_mode: 'ask-writes',
        web_access: null,
        docker_egress: 0,
        response_budget_limit: 3,
        archived_at: null,
        deleted_at: null,
        created_at: '2026-11-03T00:00:00.000Z',
        updated_at: '2026-11-03T00:00:00.000Z',
      },
    ],
    dms: [
      {
        id: DM_ID,
        peer: { id: AGENT_ID, display_name: '阿蓝', avatar_slot: 1, deleted_at: null },
      },
    ],
    tasks: [],
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: { [CHANNEL_ID]: 0, [DM_ID]: 0 },
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {
      [AGENT_ID]: { status: 'online', offline_reason: null },
      [NOT_JOINED_ID]: { status: 'online', offline_reason: null },
      [OFFLINE_ID]: { status: 'offline', offline_reason: 'credential-missing' },
    },
    workspace_runtime: {
      docker: { available: false, image: 'node:22-bookworm-slim', reason: 'docker-unavailable' },
    },
    ...overrides,
  };
}

function channelMembers(): TargetMemberView[] {
  return [
    { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
    { id: AGENT_ID, kind: 'agent', display_name: '阿蓝', avatar_slot: 1, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
    { id: OFFLINE_ID, kind: 'agent', display_name: '阿灰', avatar_slot: 3, workspace_status: { backend: 'local', available: false, reason: 'workspace-root-missing' }, allow_local_shell: 0, permission_mode: 'ask-writes' },
  ];
}

function panelRegion(html: string, name: string): string {
  const start = html.indexOf(`data-tab-panel="${name}"`);
  assert.notEqual(start, -1, `missing the ${name} tab panel`);
  const next = html.indexOf('data-tab-panel="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

/** The backend reading that supplies each provider's credential variable name. */
const REMOTE_DATA_FLOW: RemoteDataFlowReadView = {
  data_surfaces: ['消息正文'],
  providers: [
    {
      provider: 'anthropic',
      credential_env: 'ANTHROPIC_API_KEY',
      credential_status: 'missing',
      receiver: 'https://api.anthropic.com',
      confirmed_at: null,
    },
    {
      provider: 'openai',
      credential_env: 'OPENAI_API_KEY',
      credential_status: 'missing',
      receiver: 'https://api.openai.com/v1',
      confirmed_at: null,
    },
  ],
  mcp_consents: [],
  docker_consents: [],
  web_consents: [],
  web_providers: [],
};

test('the Agent detail renders the three tabs in the fixed order', () => {
  assert.deepEqual([...AGENT_DETAIL_TABS], ['basic', 'skills', 'mcp']);

  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, { agent: agent({ id: AGENT_ID, display_name: '阿蓝' }), locale: 'zh-CN' }),
  );
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['basic', 'skills', 'mcp'], 'the tab order is fixed');
  for (const label of ['基础信息和配置', 'skills', 'mcp']) {
    assert.ok(html.includes(label), `the tab bar is missing ${label}`);
  }
});

test('the basic tab holds stats, system prompt, config, rules and the danger block last', () => {
  assert.deepEqual([...AGENT_BASIC_SECTIONS], [
    'stats',
    'system-prompt',
    'config',
    'rules',
    'danger',
  ]);

  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, { agent: agent({ id: AGENT_ID, display_name: '阿蓝' }), locale: 'zh-CN' }),
  );
  const basic = panelRegion(html, 'basic');
  const sections = [...basic.matchAll(/data-section="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(sections, ['stats', 'system-prompt', 'config', 'rules', 'danger']);
  assert.ok(basic.indexOf('data-section="danger"') > basic.indexOf('data-section="config"'), '危险操作恒为最后一块');

  for (const copy of ['统计', '系统提示', '配置', '家目录与规则', '危险操作']) {
    assert.ok(basic.includes(copy), `the basic tab is missing ${copy}`);
  }
  assert.ok(basic.includes('在线'), 'the stats block shows the status point');
  assert.ok(basic.includes('openai:gpt-5'), 'the stats block shows the model identifier');
  assert.ok(basic.includes('已设置'), 'the stats block shows the credential status');
  assert.ok(basic.includes('engineer'), 'the config block shows the role');
  assert.ok(basic.includes('40'), 'the config block shows context_window');
  assert.ok(basic.includes('0.8'), 'the config block shows the compression threshold');
  assert.ok(basic.includes('8'), 'the config block shows max_iterations');
  assert.ok(
    basic.includes('你是一名负责实现的工程师。'),
    'the system prompt textarea carries the stored prompt',
  );
});

test('skills is the two-column installer panel; mcp is the file editor with no fabricated data', () => {
  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, { agent: agent({ id: AGENT_ID, display_name: '阿蓝' }), locale: 'zh-CN' }),
  );

  const skills = panelRegion(html, 'skills');
  assert.match(skills, /data-section="skills"/);
  assert.match(skills, /data-action="refresh-skill-candidates"/);
  assert.match(skills, /data-action="import-all-skills"/);
  assert.match(skills, /data-field="skills-pending"/);
  assert.doesNotMatch(skills, /<a\b/, 'skills opens no route or link');
  assert.doesNotMatch(skills, /data-skill-name=/, 'a null reading fabricates no skill row');

  // mcp is now the #47 file editor: structured + raw blocks read the same file.
  const mcp = panelRegion(html, 'mcp');
  assert.match(mcp, /data-mcp-block="entries"/);
  assert.match(mcp, /data-mcp-block="raw"/);
  for (const value of ['engineer', 'openai:gpt-5', '你是一名负责实现的工程师。']) {
    assert.ok(!skills.includes(value), `skills must not fabricate ${value}`);
  }
});

test('switching tabs keeps the uncommitted draft and never touches the URL or refetches', async () => {
  const initial = initialAgentDetailState(agent({ id: AGENT_ID, display_name: '阿蓝' }));
  const edited = editSystemPrompt(initial, '未提交的草稿');
  assert.equal(hasUnsavedSystemPrompt(edited, agent({ id: AGENT_ID, display_name: '阿蓝' })), true);

  const skills = switchAgentDetailTab(edited, 'skills');
  const mcp = switchAgentDetailTab(skills, 'mcp');
  const basic = switchAgentDetailTab(mcp, 'basic');
  for (const state of [skills, mcp, basic]) {
    assert.equal(state.draft.systemPrompt, '未提交的草稿', 'the draft survives every tab switch');
  }
  assert.equal(basic.tab, 'basic');
  assert.equal(hasUnsavedSystemPrompt(basic, agent({ id: AGENT_ID, display_name: '阿蓝' })), true);

  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent({ id: AGENT_ID, display_name: '阿蓝' }),
      locale: 'zh-CN',
      initialTab: 'skills',
      initialDraft: { systemPrompt: '未提交的草稿' },
    }),
  );
  assert.match(html, /data-tab="skills"[^>]*aria-selected="true"/, 'the skills tab is open');
  assert.match(
    html,
    /<textarea[^>]*>未提交的草稿<\/textarea>/,
    'the draft input stays mounted while another tab is open',
  );

  for (const file of ['agent-detail.ts', 'AgentDetailPanel.ts']) {
    const source = await readFile(new URL(`../src/workspace/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:history|location)\./, `${file} changes the URL`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} refetches a page`);
  }
});

test('the member panel splits joined and not-joined Agents with status, model and reasons', () => {
  const reading = workspace();
  const view = readMemberPanel(reading, channelMembers());

  assert.deepEqual(
    view.joined.map((row) => row.id),
    [AGENT_ID, OFFLINE_ID],
    'joined is the channel member table, owner excluded',
  );
  assert.deepEqual(
    view.notJoined.map((row) => row.id),
    [NOT_JOINED_ID],
    'not joined is the local Agents outside the channel',
  );

  const html = renderToStaticMarkup(
    createElement(MemberPanel, {
      workspace: reading,
      members: channelMembers(),
      locale: 'zh-CN',
      remoteDataFlow: REMOTE_DATA_FLOW,
      onJoin: async () => {},
    }),
  );
  const joined = html.slice(html.indexOf('data-section="joined"'), html.indexOf('data-section="not-joined"'));
  const notJoined = html.slice(html.indexOf('data-section="not-joined"'));

  assert.ok(joined.includes('已加入') && notJoined.includes('未加入'), 'both segments are labelled');
  assert.ok(joined.includes('阿蓝') && joined.includes('阿灰'), 'joined lists the channel Agents');
  assert.ok(notJoined.includes('阿绿'), 'not joined lists the remaining local Agent');
  assert.ok(!joined.includes('anthropic:claude-sonnet-5-5'));
  assert.ok(notJoined.includes('anthropic:claude-sonnet-5-5'), 'each row shows the model identifier');
  assert.ok(joined.includes('缺少凭证'), 'the offline row states why it is not enabled');
  assert.ok(
    joined.includes('OPENAI_API_KEY'),
    'the offline row names the credential variable from /api/remote-data-flow',
  );
  assert.ok(joined.includes('重启后端'), 'the offline row says what to do after setting it');
  assert.ok(joined.includes('未启用'), 'the offline row shows the status point');
  assert.match(notJoined, /data-action="join-member"[^>]*data-member-id="agent-2"/, 'only not-joined rows can be joined');
  assert.doesNotMatch(joined, /data-action="join-member"/, 'joined rows carry no join control');
});

test('a missing model or credential names the credential source instead of 未配置', () => {
  const fact = (html: string, field: string): string => {
    const start = html.indexOf(`data-field="${field}"`);
    assert.notEqual(start, -1, `missing the ${field} fact`);
    const next = html.indexOf('data-field="', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
  };

  const noModel = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent({
        id: 'agent-8',
        display_name: '阿白',
        avatar_slot: 5,
        model: null,
        credential_status: 'missing',
        status: 'offline',
        offline_reason: 'model-missing',
      }),
      locale: 'zh-CN',
      remoteDataFlow: REMOTE_DATA_FLOW,
    }),
  );
  assert.ok(
    fact(noModel, 'model').includes('模型密钥从环境变量读，不写库'),
    'the model fact says where the key comes from',
  );
  assert.ok(
    fact(noModel, 'model').includes('还没有配置模型'),
    'the model fact states the missing model as a fact, not as 未配置',
  );
  for (const field of ['model', 'credential']) {
    assert.ok(
      !fact(noModel, field).includes('ANTHROPIC_API_KEY') &&
        !fact(noModel, field).includes('OPENAI_API_KEY'),
      `the ${field} fact names no credential variable for an unknown provider`,
    );
  }

  const anthropicNoKey = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent({
        id: 'agent-7',
        display_name: '阿紫',
        avatar_slot: 6,
        model: 'anthropic:claude-sonnet-5-5',
        credential_status: 'missing',
        status: 'offline',
        offline_reason: 'credential-missing',
      }),
      locale: 'zh-CN',
      remoteDataFlow: REMOTE_DATA_FLOW,
    }),
  );
  const anthropicCredential = fact(anthropicNoKey, 'credential');
  assert.ok(
    anthropicCredential.includes('ANTHROPIC_API_KEY'),
    'the credential fact names the provider variable from /api/remote-data-flow',
  );
  assert.ok(
    anthropicCredential.includes('模型密钥从环境变量读，不写库'),
    'the credential fact states where the key comes from',
  );
  assert.ok(anthropicCredential.includes('重启后端'), 'the credential fact says when it takes effect');
});

test('the Agent detail names the credential env and offers the consent entry', () => {
  const credential = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent({
        id: OFFLINE_ID,
        display_name: '阿灰',
        avatar_slot: 3,
        credential_status: 'missing',
        status: 'offline',
        offline_reason: 'credential-missing',
      }),
      locale: 'zh-CN',
      remoteDataFlow: REMOTE_DATA_FLOW,
    }),
  );
  assert.ok(credential.includes('OPENAI_API_KEY'), 'the detail names the variable to set');
  assert.ok(credential.includes('重启后端'), 'the detail says when the setting takes effect');

  const consent = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent({
        id: 'agent-4',
        display_name: '阿橙',
        avatar_slot: 4,
        model: 'anthropic:claude-sonnet-5-5',
        status: 'offline',
        offline_reason: 'consent-missing',
      }),
      locale: 'zh-CN',
      remoteDataFlow: REMOTE_DATA_FLOW,
      onConfirmConsent: async () => {},
    }),
  );
  assert.ok(consent.includes('远端数据流告知'), 'the detail says consent is missing');
  assert.match(consent, /data-action="confirm-consent"/, 'the detail offers the confirmation');
  assert.match(consent, /data-provider="anthropic"/, 'the entry names the provider to confirm');
});

test('the member panel points a consent-missing row at the Agent detail entry', () => {
  const base = workspace();
  const consentAgent = agent({
    id: 'agent-4',
    display_name: '阿橙',
    avatar_slot: 4,
    model: 'anthropic:claude-sonnet-5-5',
    status: 'offline',
    offline_reason: 'consent-missing',
  });
  const reading: WorkspaceView = {
    ...base,
    agents: [...base.agents, consentAgent],
    status_points: {
      ...base.status_points,
      'agent-4': { status: 'offline', offline_reason: 'consent-missing' },
    },
  };
  const members: TargetMemberView[] = [
    ...channelMembers(),
    {
      id: 'agent-4',
      kind: 'agent',
      display_name: '阿橙',
      avatar_slot: 4,
      workspace_status: { backend: 'local', available: false, reason: 'workspace-root-unset' },
      allow_local_shell: 0,
      permission_mode: 'ask-writes',
    },
  ];
  const html = renderToStaticMarkup(
    createElement(MemberPanel, {
      workspace: reading,
      members,
      locale: 'zh-CN',
      remoteDataFlow: REMOTE_DATA_FLOW,
      onOpenAgentDetail: () => {},
    }),
  );
  assert.ok(html.includes('远端数据流告知'), 'the row says consent is missing');
  assert.match(
    html,
    /data-action="open-agent-detail"[^>]*data-member-id="agent-4"/,
    'the row points at the Agent detail where confirmation lives',
  );
});

test('the remote-data-flow read and provider consent write hit the one HTTP face', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    const body =
      init?.method === 'POST'
        ? { provider: 'anthropic', confirmed_at: '2026-11-04T00:00:00.000Z' }
        : REMOTE_DATA_FLOW;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  assert.deepEqual(await readRemoteDataFlow(fetchImpl), REMOTE_DATA_FLOW);
  assert.deepEqual(await confirmProviderDataFlow(fetchImpl, 'anthropic'), {
    provider: 'anthropic',
    confirmed_at: '2026-11-04T00:00:00.000Z',
  });
  assert.deepEqual(calls, [
    'GET /api/remote-data-flow',
    'POST /api/remote-data-flow/anthropic/consent',
  ]);
});

test('a join moves the row only after the backend answers with {joined}', async () => {
  const reading = workspace();
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url} ${String(init?.body ?? '')}`);
    return new Response(JSON.stringify({ joined: true }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  assert.deepEqual(await joinChannelMember(fetchImpl, CHANNEL_ID, NOT_JOINED_ID), { joined: true });
  assert.deepEqual(calls, [
    `POST /api/channels/${CHANNEL_ID}/members {"member_id":"agent-2"}`,
  ]);

  const outcome = applyJoinResult(
    channelMembers(),
    agent({ id: NOT_JOINED_ID, display_name: '阿绿', avatar_slot: 2 }),
    true,
  );
  assert.equal(outcome.joined, true, 'the backend reported a new membership row');
  const view = readMemberPanel(reading, outcome.members);
  assert.ok(view.joined.some((row) => row.id === NOT_JOINED_ID), 'the row moved to joined');
  assert.ok(!view.notJoined.some((row) => row.id === NOT_JOINED_ID), 'the row left not-joined');

  const repeat = applyJoinResult(
    channelMembers(),
    agent({ id: NOT_JOINED_ID, display_name: '阿绿', avatar_slot: 2 }),
    false,
  );
  assert.equal(repeat.joined, false, 'a repeat join says the backend already had the row');
  assert.ok(
    readMemberPanel(reading, repeat.members).joined.some((row) => row.id === NOT_JOINED_ID),
    'a stale table still moves the row to joined',
  );

  const failed = (async () =>
    new Response(JSON.stringify({ error: { code: 'not_found', message: 'x' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
  await assert.rejects(() => joinChannelMember(failed, CHANNEL_ID, NOT_JOINED_ID), 'a failed join rejects');
});

test('creating an Agent from the empty state posts the typed name and re-reads the workspace', async () => {
  const calls: string[] = [];
  const reading = workspace({
    agents: [agent({ id: 'agent-9', display_name: '新同事', model: null, status: 'offline', offline_reason: 'model-missing' })],
  });
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url} ${String(init?.body ?? '')}`.trim());
    if (url === '/api/agents' && init?.method === 'POST') {
      return new Response(JSON.stringify(reading.agents[0]), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === '/api/workspace') {
      return new Response(JSON.stringify(reading), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected request ${init?.method ?? 'GET'} ${url}`);
  }) as typeof fetch;

  const state = editInlineCreateName(initialInlineCreate(), '新同事');
  const settled = await submitInlineCreate(state, (name) => createAgent(fetchImpl, name));

  assert.equal(settled.failed, false, 'the create is reported as done');
  assert.deepEqual(
    calls,
    ['POST /api/agents {"display_name":"新同事"}', 'GET /api/workspace'],
    'the create posts the typed name, then re-reads the workspace snapshot',
  );
  assert.deepEqual(
    await createAgent(fetchImpl, '新同事'),
    reading,
    'the action answers with the refreshed snapshot',
  );
  assert.equal(
    reading.agents[0]?.model,
    null,
    'a new Agent has no model, which falls into the missing-model guidance',
  );
});

test('a rejected Agent create stays in the empty state with its error', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url} ${String(init?.body ?? '')}`.trim());
    return new Response(JSON.stringify({ error: { code: 'validation', message: 'display_name' } }), {
      status: 400,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const state = editInlineCreateName(initialInlineCreate(), '新同事');
  const settled = await submitInlineCreate(state, (name) => createAgent(fetchImpl, name));

  assert.equal(settled.failed, true, 'the failure stays in the empty state');
  assert.deepEqual(calls, ['POST /api/agents {"display_name":"新同事"}'], 'no snapshot after a failure');
});

test('reading the channel member table uses GET /api/channels/{id}/members', async () => {
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(JSON.stringify({ members: channelMembers() }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  assert.deepEqual(await readChannelMembers(fetchImpl, CHANNEL_ID), channelMembers());
  assert.deepEqual(calls, [`/api/channels/${CHANNEL_ID}/members`]);
});

test('the roster is the read-only whole channel list, owner included and no action but close', () => {
  const reading = workspace();
  const rows = readMemberRoster(reading, channelMembers());
  assert.deepEqual(
    rows.map((row) => [row.id, row.status]),
    [
      [OWNER_ID, null],
      [AGENT_ID, 'online'],
      [OFFLINE_ID, 'offline'],
    ],
    'the roster is the channel scope, owner first',
  );

  const html = renderToStaticMarkup(
    createElement(MemberRoster, { workspace: reading, members: channelMembers(), locale: 'zh-CN' }),
  );
  assert.ok(html.includes('owner') && html.includes('阿蓝') && html.includes('阿灰'), 'the whole channel is listed');
  assert.ok(!html.includes('阿绿'), 'a local Agent outside the channel is not in the roster');
  assert.doesNotMatch(html, /<button\b/, 'the roster body has no action');
  assert.match(html, /data-status="online"/);
  assert.match(html, /data-status="offline"/);

  const local = reading.agents.map((row) => row.id);
  const panel = readMemberPanel(reading, channelMembers());
  assert.equal(local.length, 3, '本机 Agent is the whole local list');
  assert.equal(panel.joined.length + panel.notJoined.length, 3, 'the panel is channel-scoped Agent membership');
  assert.equal(rows.length, 3, 'the roster is the channel scope with owner');
  assert.notDeepEqual(local, rows.filter((row) => row.id !== OWNER_ID).map((row) => row.id));
});

test('a soft-deleted Agent leaves the panel and roster but keeps its historical message rows', () => {
  const reading = workspace({
    agents: workspace().agents.filter((row) => row.id !== AGENT_ID),
    dms: [],
    unread_by_target: { [CHANNEL_ID]: 0 },
    status_points: { [NOT_JOINED_ID]: { status: 'online', offline_reason: null } },
  });

  const panel = readMemberPanel(reading, channelMembers());
  assert.ok(!panel.joined.some((row) => row.id === AGENT_ID), 'the panel drops the deleted Agent');
  assert.ok(!panel.notJoined.some((row) => row.id === AGENT_ID));

  const roster = readMemberRoster(reading, channelMembers());
  assert.ok(!roster.some((row) => row.id === AGENT_ID), 'the roster drops the deleted Agent');

  const stored = {
    id: 'message-1',
    target_id: CHANNEL_ID,
    seq: 1,
    kind: 'agent' as const,
    author_member_id: AGENT_ID,
    author_display_name: '阿蓝',
    author_avatar_slot: 1,
    body: '删除前说的话',
    created_at: '2026-11-03T00:00:00.000Z',
    task_ref: null,
    task_pointer: null,
    client_message_id: null,
    mentions: [],
    attachments: [],
  };
  const chat = new HttpAgent({
    url: '/api/copilotkit/agent/allibot/run',
    agentId: ALLIBOT_AGENT_ID,
    threadId: CHANNEL_ID,
    fetch: (async () => new Response('')) as typeof fetch,
  });
  hydrateThread(chat, [stored]);
  assert.deepEqual(chat.messages.map((row) => row.id), ['message-1'], 'history keeps the stored author row');
  assert.equal(stored.author_display_name, '阿蓝', 'the message row keeps the author snapshot');
});

test('the member panel only belongs to a channel and a notice opens it from the conversation', () => {
  const reading = workspace();

  const notice = readMemberNotice(reading, channelMembers());
  assert.deepEqual(notice, { offline: 1, error: 0 }, 'the offline channel member is the notice fact');
  assert.equal(readMemberNotice(reading, [channelMembers()[0]!]), null, 'a healthy channel has no notice');

  const shellState: WorkspaceShellState = { activeTargetId: CHANNEL_ID, drawer: null };
  const opened = openWorkspacePanel(shellState, 'members');
  assert.equal(opened.activeTargetId, CHANNEL_ID, 'opening the panel never moves the target');
  assert.equal(opened.drawer, 'members');

  const channelHtml = renderToStaticMarkup(
    createElement(MemberPanel, {
      workspace: reading,
      members: channelMembers(),
      locale: 'zh-CN',
    }),
  );
  assert.match(channelHtml, /data-panel-body="member-panel"/);

  const dmContext = renderToStaticMarkup(
    createElement(ContextPanel, { workspace: reading, targetId: DM_ID, locale: 'zh-CN' }),
  );
  assert.doesNotMatch(dmContext, /data-panel="members"/, 'a DM offers no member panel');
  assert.doesNotMatch(dmContext, /data-panel="roster"/, 'a DM offers no channel roster');

  const dmShell = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: reading,
      settings: reading.settings,
      activeTargetId: DM_ID,
      initialDrawer: 'members',
      viewportWidth: 1280,
    }),
  );
  assert.doesNotMatch(dmShell, /data-section="not-joined"/, 'a DM never renders the member panel');
  assert.ok(dmShell.includes('成员面板只属于频道'), 'the DM states why the panel is absent');
});

test('the channel shell offers the panel and roster entries, and opens no drawer on arrival', () => {
  const reading = workspace();
  const html = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: reading,
      settings: reading.settings,
      activeTargetId: CHANNEL_ID,
      viewportWidth: 1280,
      channelMembers: { [CHANNEL_ID]: channelMembers() },
    }),
  );

  assert.doesNotMatch(html, /data-drawer=/, 'arriving in a channel opens no drawer');
  const context = renderToStaticMarkup(
    createElement(ContextPanel, { workspace: reading, targetId: CHANNEL_ID, locale: 'zh-CN' }),
  );
  assert.match(context, /data-panel="members"/);
  assert.match(context, /data-panel="roster"/);

  const noticeHtml = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: reading,
      settings: reading.settings,
      activeTargetId: CHANNEL_ID,
      viewportWidth: 1280,
      channelMembers: { [CHANNEL_ID]: channelMembers() },
    }),
  );
  assert.match(
    noticeHtml,
    /data-action="open-panel" data-panel="members"/,
    'the failure / not-enabled notice opens the member panel',
  );

  const joinable = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: reading,
      settings: reading.settings,
      activeTargetId: CHANNEL_ID,
      initialDrawer: 'members',
      viewportWidth: 1280,
      channelMembers: { [CHANNEL_ID]: channelMembers() },
      onJoinMember: async () => {},
    }),
  );
  assert.match(
    joinable,
    /data-action="join-member"[^>]*data-member-id="agent-2"/,
    'the shell wires the join control to the host',
  );
});

test('the Agent detail drawer renders the basic tab for the selected Agent', () => {
  const reading = workspace();
  const html = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: reading,
      settings: reading.settings,
      activeTargetId: CHANNEL_ID,
      initialDrawer: 'agent-detail',
      initialAgentId: NOT_JOINED_ID,
      viewportWidth: 1280,
    }),
  );

  assert.match(html, /data-drawer="agent-detail"/);
  assert.match(html, /data-agent-id="agent-2"/);
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['basic', 'skills', 'mcp']);
  assert.ok(html.includes('reviewer'), 'the drawer reads the selected Agent, not the first one');

  const actionable = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: reading,
      settings: reading.settings,
      activeTargetId: CHANNEL_ID,
      initialDrawer: 'agent-detail',
      initialAgentId: NOT_JOINED_ID,
      viewportWidth: 1280,
      onSaveAgent: async () => {},
      onDeleteAgent: async () => {},
    }),
  );
  assert.match(actionable, /data-action="save-agent"/, 'the shell wires the save action');
  assert.match(actionable, /data-action="delete-agent"/, 'the shell wires the danger action');
  assert.match(
    actionable,
    /data-section="danger"[\s\S]*data-action="delete-agent"/,
    '危险操作 stays the last block and carries the delete action',
  );
});
