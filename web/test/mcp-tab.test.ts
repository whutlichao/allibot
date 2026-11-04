import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentMcpView, AgentView } from '@allibot/shared';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import { McpPanel } from '../src/workspace/McpPanel.ts';
import {
  emptyMcpEntry,
  entriesSaveBody,
  formatArgsText,
  formatEnvNamesText,
  initialMcpEntries,
  initialMcpRaw,
  parseArgsText,
  parseEnvNamesText,
  rawSaveBody,
  withTransport,
} from '../src/workspace/mcp-tab.ts';
import { saveAgentMcp } from '../src/workspace-actions.ts';

/**
 * Agent 详情 mcp 页签 (#47 / D6.5) 的呈现契约。
 *
 * 规格 R2：前端只做呈现 / 数据契约，不建第二套领域 seam。这里验证上块
 * 结构化条目与下块原文文本域渲染同一份读数、两块都走同一个 PUT，以及
 * 切页签不卸载面板（未提交草稿保留）。文件校验、原子写与运行期装配由
 * 后端 HTTP 面验收。
 */

const AGENT_ID = 'agent-mcp-1';

function mcpView(overrides: Partial<AgentMcpView> = {}): AgentMcpView {
  return {
    agent_id: AGENT_ID,
    path: `/tmp/home/.allibot/agents/${AGENT_ID}/mcp.json`,
    present: true,
    entries: [
      {
        name: 'demo',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['server.mjs', '--flag'],
        env_names: ['MCP_TOKEN'],
        },
      {
        name: 'remote',
        transport: 'http',
        enabled: false,
        url: 'http://127.0.0.1:7801/mcp',
      },
    ],
    raw: '{\n  "servers": []\n}\n',
    diagnostic: null,
    ...overrides,
  };
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: AGENT_ID,
    kind: 'agent',
    display_name: 'MCP 成员',
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-04T00:00:00.000Z',
    role: 'engineer',
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
    home_path: `/tmp/home/.allibot/agents/${AGENT_ID}`,
    status: 'online',
    offline_reason: null,
    ...overrides,
  };
}

function panelRegion(html: string, name: string): string {
  const start = html.indexOf(`data-tab-panel="${name}"`);
  assert.notEqual(start, -1, `missing the ${name} tab panel`);
  const next = html.indexOf('data-tab-panel="', start + 1);
  return html.slice(start, next === -1 ? undefined : next);
}

test('the mcp tab renders the structured entries block and the raw block from one reading', () => {
  const html = renderToStaticMarkup(
    createElement(McpPanel, {
      locale: 'zh-CN',
      mcp: mcpView(),
      onSave: async () => undefined,
    }),
  );
  assert.match(html, /data-mcp-block="entries"/);
  assert.match(html, /data-mcp-block="raw"/);
  assert.match(html, /data-section="mcp"/);
  assert.match(html, /两块读写同一份家目录 mcp\.json/);

  // The structured block shows every entry and its transport-specific fields.
  assert.match(html, /value="demo"/);
  assert.match(html, /value="node"/);
  assert.match(html, /data-mcp-args="0">server\.mjs/);
  assert.match(html, /--flag<\/textarea>/);
  assert.match(html, /value="MCP_TOKEN"/);
  assert.match(html, /value="remote"/);
  assert.match(html, /value="http:\/\/127\.0\.0\.1:7801\/mcp"/);
  assert.equal((html.match(/<option/g) ?? []).length, 6, 'three transports per entry');

  // The raw block is the same file text, not a second rendering of entries.
  assert.match(html, /data-field="mcp-raw"/);
  assert.match(html, /&quot;servers&quot;: \[\]/);
  assert.match(html, /data-action="save-mcp-entries"/);
  assert.match(html, /data-action="save-mcp-raw"/);
  assert.doesNotMatch(html, /<a\s/, 'the tab opens no route or link');
});

test('the mcp tab renders missing / invalid file states without fabricating entries', () => {
  const missing = renderToStaticMarkup(
    createElement(McpPanel, {
      locale: 'zh-CN',
      mcp: mcpView({ present: false, entries: [], raw: '', diagnostic: null }),
    }),
  );
  assert.match(missing, /mcp\.json 缺失/);
  assert.match(missing, /data-field="mcp-entries-empty"/);
  assert.doesNotMatch(missing, /data-mcp-entry=/);

  const invalid = renderToStaticMarkup(
    createElement(McpPanel, {
      locale: 'zh-CN',
      mcp: mcpView({
        entries: [],
        raw: '{"servers":[{"name":"x"}]}',
        diagnostic: 'mcp.json 条目名重复：x',
      }),
    }),
  );
  assert.match(invalid, /data-field="mcp-diagnostic"/);
  assert.match(invalid, /mcp\.json 条目名重复：x/);
  assert.match(invalid, /data-mcp-block="raw"/);
  assert.doesNotMatch(invalid, /data-mcp-entry=/);
});

test('both blocks write the same Agent mcp endpoint with exactly one body shape', async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    });
    return new Response(JSON.stringify(mcpView()), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const entriesBody = entriesSaveBody([emptyMcpEntry()]);
  await saveAgentMcp(fetchImpl, AGENT_ID, entriesBody);
  await saveAgentMcp(fetchImpl, AGENT_ID, rawSaveBody('{"servers":[]}'));

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.url, `/api/agents/${AGENT_ID}/mcp`);
    assert.equal(call.method, 'PUT');
  }
  assert.deepEqual(JSON.parse(calls[0]!.body), {
    entries: [{ name: '', transport: 'stdio', enabled: true, command: '', args: [] }],
  });
  assert.deepEqual(JSON.parse(calls[1]!.body), { raw: '{"servers":[]}' });
});

test('the form helpers translate transport-specific fields without keeping the other shape', () => {
  assert.deepEqual(parseArgsText(' a \n\n b '), ['a', 'b']);
  assert.deepEqual(parseEnvNamesText(' TOKEN, OTHER , '), ['TOKEN', 'OTHER']);
  assert.deepEqual(formatArgsText({ name: 'x', transport: 'stdio', enabled: true, args: ['a'] }), 'a');
  assert.deepEqual(
    formatEnvNamesText({ name: 'x', transport: 'http', enabled: true, env_names: ['A', 'B'] }),
    'A, B',
  );

  const stdio = {
    name: 'x',
    transport: 'stdio' as const,
    enabled: true,
    command: 'node',
    args: ['a'],
    env_names: ['A'],
  };
  const remote = withTransport(stdio, 'http');
  assert.deepEqual(remote, {
    name: 'x',
    transport: 'http',
    enabled: true,
    url: '',
    env_names: ['A'],
  });
  assert.equal('command' in remote, false, 'the structured form never keeps a mismatched field');
  assert.equal('args' in remote, false);

  const view = mcpView();
  const entries = initialMcpEntries(view);
  assert.notEqual(entries, view.entries, 'the component edits a draft, not the host reading');
  assert.notEqual(entries[0]!.args, view.entries[0]!.args);
  assert.equal(initialMcpRaw(view), view.raw);
});

test('the detail keeps the mcp panel mounted while another tab is shown, so drafts survive', () => {
  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent(),
      locale: 'zh-CN',
      initialTab: 'basic',
      mcp: mcpView(),
      onMcpChange: async () => undefined,
    }),
  );
  const mcp = panelRegion(html, 'mcp');
  assert.match(mcp, /hidden/, 'the mcp panel is hidden, not unmounted');
  assert.match(mcp, /data-mcp-block="entries"/);
  assert.match(mcp, /data-mcp-block="raw"/);
  assert.match(mcp, /data-action="save-mcp-entries"/);
  assert.match(mcp, /data-action="save-mcp-raw"/);

  // The mcp tab is still the third fixed tab; the skills panel stays mounted.
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['basic', 'skills', 'mcp']);
  assert.match(panelRegion(html, 'skills'), /data-section="skills"/);
  assert.match(html, /data-tab-panel="mcp"/);
});
