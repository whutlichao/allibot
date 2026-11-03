import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentRulesView,
  AgentView,
  TaskView,
  WorkspaceView,
} from '@allibot/shared';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import { AGENT_BASIC_SECTIONS } from '../src/workspace/agent-detail.ts';
import {
  readAgentRules,
  ruleSectionStatus,
  rulesChannelId,
} from '../src/workspace/agent-rules.ts';
import { WorkspaceShell } from '../src/workspace/WorkspaceShell.ts';

/**
 * Agent 详情基础信息页签的家目录、规则三段与读取状态 (#43 / D2.3 / D5.2 /
 * D6.5). The backend owns the reading; this contract only asserts that the
 * three sections are displayed in assembly order, read-only, with the read
 * status the API returned, and that the host reads them on demand.
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const TASK_TARGET_ID = '55555555-5555-4555-8555-555555555555';
const OWNER_ID = 'owner-1';
const AGENT_ID = 'agent-1';
const HOME = '/tmp/allibot-home/agents/agent-1';

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: AGENT_ID,
    kind: 'agent',
    display_name: '阿蓝',
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    status: 'online',
    offline_reason: null,
    role: 'engineer',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: 'SYSTEM-TWO',
    enabled: 1,
    context_window: 40,
    compression_threshold: 0.8,
    max_iterations: 8,
    auto_claim: 1,
    workspace_backend: null,
    home_path: HOME,
    ...overrides,
  };
}

function rules(overrides: Partial<AgentRulesView> = {}): AgentRulesView {
  return {
    agent_id: AGENT_ID,
    channel_id: CHANNEL_ID,
    home_path: HOME,
    order: ['global', 'system_prompt', 'project'],
    sections: [
      {
        kind: 'global',
        path: `${HOME}/AGENTS.md`,
        present: true,
        readable: true,
        content: 'GLOBAL-ONE',
      },
      {
        kind: 'system_prompt',
        path: null,
        present: true,
        readable: true,
        content: 'SYSTEM-TWO',
      },
      {
        kind: 'project',
        path: '/tmp/project/.allibot/agents/agent-1/AGENTS.md',
        present: false,
        readable: false,
        content: null,
      },
    ],
    ...overrides,
  };
}

function basicRegion(html: string): string {
  const start = html.indexOf('data-tab-panel="basic"');
  assert.notEqual(start, -1, 'missing the basic tab panel');
  const next = html.indexOf('data-tab-panel="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

function renderPanel(reading: AgentRulesView | null): string {
  return basicRegion(
    renderToStaticMarkup(
      createElement(AgentDetailPanel, {
        agent: agent(),
        locale: 'zh-CN',
        rules: reading,
      }),
    ),
  );
}

const TASK: TaskView = {
  id: 'task-1',
  channel_id: CHANNEL_ID,
  target_id: TASK_TARGET_ID,
  title: '任务',
  status: 'todo',
  assignee_member_id: null,
  claimed_at: null,
  created_at: '2026-11-03T00:00:00.000Z',
  updated_at: '2026-11-03T00:00:00.000Z',
  channel_mode: 'autonomous',
  allowed_transitions: ['in_progress'],
  message_count: 0,
  unread_count: 0,
};

function workspace(): WorkspaceView {
  return {
    owner: { id: OWNER_ID, kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [agent()],
    channels: [
      {
        id: CHANNEL_ID,
        name: '规则频道',
        description: '',
        mode: 'autonomous',
        team: { leader_member_id: null, status: 'valid', reason: null },
        workspace: { root: '/tmp/project', backend: 'local', allow_local_shell: 0 },
        response_budget_limit: 3,
        archived_at: null,
        deleted_at: null,
        created_at: '2026-11-03T00:00:00.000Z',
        updated_at: '2026-11-03T00:00:00.000Z',
      },
    ],
    dms: [
      {
        id: '33333333-3333-4333-8333-333333333333',
        peer: { id: AGENT_ID, display_name: '阿蓝', avatar_slot: 1, deleted_at: null },
      },
    ],
    tasks: [TASK],
    unread_total: 0,
    unread_by_target: {},
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
  };
}

test('the basic tab renders the home path and the three rule sections in assembly order', () => {
  assert.deepEqual([...AGENT_BASIC_SECTIONS], [
    'stats',
    'system-prompt',
    'config',
    'rules',
    'danger',
  ]);
  const basic = renderPanel(rules());

  assert.match(basic, /data-field="home-path"[\s\S]*?\/tmp\/allibot-home\/agents\/agent-1/);
  assert.match(basic, /data-section="rules"/);
  assert.match(basic, /data-rules-order="global,system_prompt,project"/);

  const kinds = [...basic.matchAll(/data-rule-section="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(kinds, ['global', 'system_prompt', 'project']);
  const statuses = [...basic.matchAll(/data-rule-status="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(statuses, ['present', 'present', 'absent']);
  for (const copy of ['全局规则基座', '系统提示（库内）', '项目补充', '已读取', '缺失']) {
    assert.ok(basic.includes(copy), `the rules block is missing ${copy}`);
  }
  assert.ok(basic.includes('GLOBAL-ONE'), 'the global section renders its content');
  assert.ok(basic.includes('SYSTEM-TWO'), 'the stored prompt section renders its content');
  assert.ok(
    basic.indexOf(`${HOME}/AGENTS.md`) > -1,
    'the global rule path is stated, not guessed',
  );

  const rulesRegion = basic.slice(basic.indexOf('data-section="rules"'));
  assert.doesNotMatch(
    rulesRegion,
    /<(button|input|textarea|select)\b/,
    'the rule text is not an editable control',
  );
});

test('an unreadable rule section is stated without fabricating content', () => {
  const reading = rules();
  reading.sections = reading.sections.map((section) =>
    section.kind === 'global'
      ? { ...section, readable: false, content: null }
      : section,
  );
  const basic = renderPanel(reading);
  assert.match(basic, /data-rule-section="global" data-rule-status="unreadable"/);
  assert.ok(basic.includes('不可读'));
  assert.equal(basic.includes('GLOBAL-ONE'), false);
  assert.equal(ruleSectionStatus(reading.sections[0]!), 'unreadable');
});

test('before the reading arrives the panel states it is pending and fabricates no section', () => {
  const basic = renderPanel(null);
  assert.match(basic, /data-rules-pending="true"/);
  assert.ok(basic.includes('规则读取中…'));
  assert.doesNotMatch(basic, /data-rule-section=/);
  assert.match(basic, /data-field="home-path"[\s\S]*?\/tmp\/allibot-home\/agents\/agent-1/);
});

test('the rules reading is one GET and the channel context comes from the target', async () => {
  const requests: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    requests.push(String(input));
    return new Response(JSON.stringify(rules()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const reading = await readAgentRules(fetchImpl, AGENT_ID, CHANNEL_ID);
  assert.deepEqual(requests, [
    `/api/agents/${AGENT_ID}/rules?channel_id=${CHANNEL_ID}`,
  ]);
  assert.equal(reading.agent_id, AGENT_ID);
  assert.deepEqual(reading.order, ['global', 'system_prompt', 'project']);

  requests.length = 0;
  await readAgentRules(fetchImpl, AGENT_ID, null);
  assert.deepEqual(requests, [`/api/agents/${AGENT_ID}/rules`]);

  const world = workspace();
  assert.equal(rulesChannelId(world, CHANNEL_ID), CHANNEL_ID);
  assert.equal(rulesChannelId(world, TASK_TARGET_ID), CHANNEL_ID, 'a task uses its channel');
  assert.equal(
    rulesChannelId(world, world.dms[0]!.id),
    null,
    'a DM has no project layer',
  );
  assert.equal(rulesChannelId(world, null), null);
});

test('the Agent detail drawer renders the loaded rules from the shell reading', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: workspace(),
      settings: workspace().settings,
      activeTargetId: CHANNEL_ID,
      initialDrawer: 'agent-detail',
      initialAgentId: AGENT_ID,
      agentRules: { [AGENT_ID]: rules() },
      viewportWidth: 1280,
    }),
  );
  assert.match(html, /data-agent-id="agent-1"/);
  assert.match(html, /data-rule-section="global"/);
  assert.match(html, /GLOBAL-ONE/);
  assert.match(html, /data-rules-order="global,system_prompt,project"/);
});
