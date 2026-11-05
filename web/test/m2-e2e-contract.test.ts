import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  RESERVED_LOCALES,
  SUPPORTED_LOCALES,
  ZH_CN,
  type AgentMcpView,
  type AgentSkillsView,
  type AgentView,
} from '@allibot/shared';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import {
  AGENT_DETAIL_TABS,
  editSystemPrompt,
  initialAgentDetailState,
  switchAgentDetailTab,
} from '../src/workspace/agent-detail.ts';
import {
  INITIAL_STREAM_STATE,
  LIVE_EVENT_TYPES,
  parseLiveEvent,
  reduceStreamState,
  shouldRefreshWorkspace,
} from '../src/workspace/message-sync.ts';

/**
 * #50 / T20 的工作台契约：the shell has one React workbench and one global
 * subscription. This file is a data / render / static contract, not a browser
 * E2E suite: the domain behaviour is verified at the backend HTTP seam.
 */

const WEB_SRC = new URL('../src/', import.meta.url);
const WEB_ROOT = new URL('../', import.meta.url);

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

async function readSource(file: URL): Promise<string> {
  return await readFile(file, 'utf8');
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: 'agent-m2-1',
    kind: 'agent',
    display_name: '集成成员',
    avatar_slot: 2,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    role: 'engineer',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: '原系统提示',
    enabled: 1,
    context_window: 40,
    compression_threshold: 0.8,
    max_iterations: 8,
    auto_claim: 0,
    workspace_backend: 'docker',
    permission_mode: 'read-only',
    effective_permission_mode: 'read-only',
    web_access: null,
    effective_web_access: 'search',
    home_path: '/tmp/allibot-home/agents/agent-m2-1',
    status: 'online',
    offline_reason: null,
    ...overrides,
  };
}

function mcp(path: string): AgentMcpView {
  return {
    agent_id: 'agent-m2-1',
    path,
    present: true,
    entries: [
      { name: 'demo', transport: 'stdio', enabled: true, command: 'node', args: ['server.mjs'] },
    ],
    raw: '{"servers":[{"name":"demo","transport":"stdio","enabled":true,"command":"node","args":["server.mjs"]}]}\n',
    diagnostic: null,
  };
}

function skills(homePath: string): AgentSkillsView {
  return {
    agent_id: 'agent-m2-1',
    home_path: homePath,
    skills: [
      {
        id: 'skill-1',
        member_id: 'agent-m2-1',
        name: 'demo-skill',
        content_hash: 'a'.repeat(64),
        enabled: true,
        source: 'directory',
        created_at: '2026-11-04T00:00:00.000Z',
        updated_at: '2026-11-04T00:00:00.000Z',
      },
    ],
  };
}

function panelRegion(html: string, name: string): string {
  const start = html.indexOf(`data-tab-panel="${name}"`);
  assert.notEqual(start, -1, `missing the ${name} tab panel`);
  const next = html.indexOf('data-tab-panel="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

test('the shell opens exactly one /api/events connection, not one per target, panel or tab', async () => {
  const files = await sourceFiles(WEB_SRC);
  const sources = new Map<string, string>();
  for (const file of files) {
    sources.set(file.pathname, await readSource(file));
  }
  const all = [...sources.values()].join('\n');
  assert.equal(
    (all.match(/new EventSource\(/g) ?? []).length,
    1,
    'the workbench creates exactly one subscription',
  );
  assert.equal(
    (all.match(/['"]\/api\/events['"]/g) ?? []).length,
    1,
    'the one stream URL is declared once',
  );
  assert.equal((all.match(/setInterval/g) ?? []).length, 0, 'no poll loop exists in web/src');
  assert.equal((all.match(/setTimeout/g) ?? []).length, 0, 'the workbench schedules no delayed re-read');

  const chat = [...sources.entries()].find(([path]) => path.endsWith('/workspace/WorkspaceChat.ts'))?.[1];
  assert.ok(chat !== undefined);
  assert.match(chat, /new EventSource\('\/api\/events'\)/);
  assert.match(chat, /\}, \[agent\]\);/, 'the subscription survives a target switch (no thread dependency)');

  // Opening a panel / tab renders readings; it cannot open a connection or
  // fetch a second copy of the stream.
  for (const name of [
    'AgentDetailPanel.ts',
    'ApprovalPanel.ts',
    'ContextPanel.ts',
    'McpPanel.ts',
    'PlanPanel.ts',
    'SkillsPanel.ts',
    'SopPanel.ts',
    'TeamRunsPanel.ts',
  ]) {
    const entry = [...sources.entries()].find(([path]) => path.endsWith(`/${name}`));
    assert.ok(entry !== undefined, `${name} is missing`);
    assert.doesNotMatch(entry[1], /EventSource|\/api\/events/, `${name} opens its own stream`);
  }
});

test('all five M2 frames are consumed by the one stream and update their own panel', async () => {
  for (const type of [
    'team_assignment',
    'plan_update',
    'sop_update',
    'approval.requested',
    'approval.resolved',
    'workspace.changed',
  ]) {
    assert.ok((LIVE_EVENT_TYPES as readonly string[]).includes(type), `${type} is not subscribed`);
  }
  assert.equal(shouldRefreshWorkspace('team_assignment'), false);
  assert.equal(shouldRefreshWorkspace('plan_update'), false);
  assert.equal(shouldRefreshWorkspace('sop_update'), false);
  assert.equal(shouldRefreshWorkspace('approval.requested'), true);
  assert.equal(shouldRefreshWorkspace('approval.resolved'), true);
  assert.equal(shouldRefreshWorkspace('workspace.changed'), true);

  const main = await readSource(new URL('main.tsx', WEB_SRC));
  assert.match(main, /event\.event === 'team_assignment'/);
  assert.match(main, /loadTeamRuns\(frame\.target_id\)/);
  assert.match(main, /event\.event === 'plan_update'/);
  assert.match(main, /loadPlans\(frame\.target_id\)/);
  assert.match(main, /event\.event === 'sop_update'/);
  assert.match(main, /readSopRun\(fetch, frame\.sop_run_id\)/);
  assert.match(main, /event\.event === 'approval\.requested' \|\| event\.event === 'approval\.resolved'/);
  assert.match(main, /loadApprovals\(\)/);
  assert.match(main, /shouldRefreshWorkspace\(event\.event\)/);

  const shell = await readSource(new URL('workspace/WorkspaceShell.ts', WEB_SRC));
  assert.match(shell, /ApprovalPanel/);
  assert.match(shell, /AgentDetailPanel/);
  const contextPanel = await readSource(new URL('workspace/ContextPanel.ts', WEB_SRC));
  assert.match(contextPanel, /TeamRunsPanel/);
  assert.match(contextPanel, /PlanPanel/);
  assert.match(contextPanel, /SopPanel/);
  assert.match(shell, /teamRuns: selectedTargetId === null \? undefined : teamRuns\?\.\[selectedTargetId\]/);
  assert.match(shell, /plans: selectedTargetId === null \? undefined : plans\?\.\[selectedTargetId\]/);
  assert.match(shell, /sopRuns,/);
  assert.match(shell, /createElement\(ApprovalPanel, \{\s*approvals,/);
});

test('a reconnect re-reads workspace and messages instead of replaying frames', async () => {
  const first = reduceStreamState(INITIAL_STREAM_STATE, 'open');
  assert.equal(first.catchUp, false);
  const rotating = reduceStreamState(first.state, 'rotate');
  assert.equal(rotating.catchUp, false, 'the rotate frame itself starts no read');
  const reconnected = reduceStreamState(rotating.state, 'open');
  assert.equal(reconnected.catchUp, true, 'the reconnect owes a catch-up read');
  const unreachable = reduceStreamState(reconnected.state, 'error');
  assert.equal(reduceStreamState(unreachable.state, 'open').catchUp, true);

  const chat = await readSource(new URL('workspace/WorkspaceChat.ts', WEB_SRC));
  assert.match(chat, /onEventRef\.current\?\.\(\{ event: 'workspace\.changed', data: \{ source: 'reconnect' \} \}\)/);
  assert.match(chat, /readRecentMessages\(fetch, currentThread\)/);
  assert.match(chat, /source\.addEventListener\(ROTATE_EVENT/);
  assert.doesNotMatch(chat, /Last-Event-ID|lastEventId/i, 'the stream has no resume cursor');

  const parsed = parseLiveEvent('rotate', '{}');
  assert.equal(parsed, null, 'rotate is a lifecycle frame, not a business event');
  assert.deepEqual(parseLiveEvent('workspace.changed', '{"source":"reconnect"}'), {
    event: 'workspace.changed',
    data: { source: 'reconnect' },
  });

  // The server half: no id line, no replay buffer, rotate before the close.
  const eventsSource = await readSource(new URL('../../server/src/events.ts', import.meta.url));
  assert.ok(
    eventsSource.includes(
      'return `event: ${event.event}\\ndata: ${JSON.stringify(event.data)}\\n\\n`;',
    ),
    'a frame is exactly one event line and one data line',
  );
  assert.doesNotMatch(eventsSource, /\nid: /, 'formatSseFrame emits no id line');
  const httpSource = await readSource(new URL('../../server/src/http.ts', import.meta.url));
  assert.match(httpSource, /formatSseFrame\(\{ event: SSE_ROTATE_EVENT, data: \{\} \}\)/);
  assert.match(httpSource, /rotateTimer = setTimeout\(/);
});

test('Agent detail keeps three fixed tabs; basic shows raw workspace / permission overrides and home_path', async () => {
  assert.deepEqual([...AGENT_DETAIL_TABS], ['basic', 'skills', 'mcp']);
  const view = agent();
  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: view,
      locale: 'zh-CN',
      rules: null,
      mcp: mcp(`${view.home_path}/mcp.json`),
      skills: { view: skills(view.home_path), detail: null, candidates: null },
      onSave: async () => undefined,
      onWorkspaceBackendChange: async () => undefined,
      onPermissionModeChange: async () => undefined,
    }),
  );
  const tabs = [...html.matchAll(/data-tab="(basic|skills|mcp)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['basic', 'skills', 'mcp']);
  const basic = panelRegion(html, 'basic');
  assert.match(basic, /data-workspace-backend="docker"/);
  assert.match(basic, /data-permission-mode="read-only"/);
  assert.ok(basic.includes(view.home_path), 'basic shows the derived home path');
  assert.match(basic, /AGENTS\.md|规则/);

  const skillsPanel = panelRegion(html, 'skills');
  assert.match(skillsPanel, /demo-skill/);
  assert.equal(skillsPanel.includes('read-only'), false, 'skills panel is a list/detail face');
  const mcpPanel = panelRegion(html, 'mcp');
  assert.match(mcpPanel, /data-mcp-block="entries"/);
  assert.match(mcpPanel, /data-mcp-block="raw"/);
  assert.match(mcpPanel, /同一份|same file|mcp\.json/i, 'both blocks state they share one home file');

  // Switching tabs is presentation state only: no URL, no target, no write,
  // and the unsubmitted draft survives.
  let state = initialAgentDetailState(view);
  state = editSystemPrompt(state, '未提交的草稿');
  state = switchAgentDetailTab(state, 'skills');
  state = switchAgentDetailTab(state, 'mcp');
  assert.equal(state.tab, 'mcp');
  assert.equal(state.draft.systemPrompt, '未提交的草稿');

  const detailSource = await readSource(new URL('workspace/AgentDetailPanel.ts', WEB_SRC));
  assert.doesNotMatch(detailSource, /history\.|location\.|pushState|replaceState/);
  assert.doesNotMatch(detailSource, /fetch\(|api\/agents\/.*\/(skills|mcp)/);
  assert.match(detailSource, /hidden: state\.tab !== 'basic'/);
  assert.match(detailSource, /hidden: state\.tab !== 'skills'/);
  assert.match(detailSource, /hidden: state\.tab !== 'mcp'/, 'all panels stay mounted, so drafts survive');
});

test('the workbench is one React entry: no retired /studio/ route or build', async () => {
  const indexHtml = await readFile(new URL('index.html', WEB_ROOT), 'utf8');
  const entries = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(entries, ['/src/main.tsx']);
  for (const file of await sourceFiles(WEB_SRC)) {
    const source = await readSource(file);
    const name = file.pathname.slice(file.pathname.lastIndexOf('/') + 1);
    assert.doesNotMatch(source, /\/studio\/v2\/?/, `${name} still carries /studio/v2`);
    assert.doesNotMatch(source, /\/studio\//, `${name} still carries /studio/`);
  }
  const dirs = await readdir(new URL('../', WEB_ROOT));
  assert.equal(dirs.includes('studio'), false, 'no studio build entry exists');
});

test('the string catalog delivers zh-CN only: en-US is reserved, with no orphan English key set', async () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['zh-CN']);
  assert.deepEqual([...RESERVED_LOCALES], ['en-US']);
  const catalogFiles = await readdir(new URL('../../shared/src/strings/', import.meta.url));
  assert.deepEqual(catalogFiles.sort(), ['index.ts', 'zh-CN.ts']);
  const catalogSource = await readSource(new URL('../../shared/src/strings/index.ts', import.meta.url));
  assert.match(catalogSource, /'zh-CN': ZH_CN/);
  assert.doesNotMatch(catalogSource, /'en-US':/, 'the English catalog is a reserved slot, not a delivery');
  assert.ok(Object.keys(ZH_CN).length > 0);
  // No key is English-only: the catalog type is keyed from the one zh-CN map,
  // so a missing value is a compile error rather than a fallback.
  for (const key of Object.keys(ZH_CN)) {
    assert.equal(typeof ZH_CN[key as keyof typeof ZH_CN].text, 'string');
  }
});

test('T12 is absent and the deployment note still says container network isolation is not delivered', async () => {
  const roots = [
    new URL('../../server/src/', import.meta.url),
    new URL('../../web/src/', import.meta.url),
    new URL('../../shared/src/', import.meta.url),
  ];
  for (const root of roots) {
    for (const file of await sourceFiles(root)) {
      const source = await readSource(file);
      const name = file.pathname.slice(file.pathname.lastIndexOf('/') + 1);
      for (const forbidden of [
        'web_access',
        'web_provider_credential',
        'docker_egress',
        'web_search',
        'web_fetch',
        "'--network'",
        'container_egress',
      ]) {
        assert.equal(source.includes(forbidden), false, `${name} still carries T12 token ${forbidden}`);
      }
    }
  }
  const adr = await readFile(
    new URL('../../docs/adr/0006-docker-workspace-backend.md', import.meta.url),
    'utf8',
  );
  assert.match(adr, /网络隔离尚未交付/);
  assert.match(adr, /T12/);
});
