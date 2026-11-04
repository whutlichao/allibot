import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type {
  AgentSkillCandidatesView,
  AgentSkillDetailView,
  AgentSkillsView,
  AgentView,
} from '@allibot/shared';
import { AgentDetailPanel } from '../src/workspace/AgentDetailPanel.ts';
import { SkillsPanel } from '../src/workspace/SkillsPanel.ts';
import {
  enabledPatch,
  importableCandidates,
  installCandidateBody,
  resolveCandidateName,
  selectedSkill,
  skillHashPrefix,
} from '../src/workspace/skills-tab.ts';
import {
  deleteAgentSkill,
  importAllAgentSkills,
  installAgentSkill,
  readAgentSkill,
  readAgentSkills,
  readSkillCandidates,
  setAgentSkillEnabled,
} from '../src/workspace-actions.ts';

/**
 * Agent 详情 skills 页签 (#48 / D6.5) 的呈现与数据契约。
 *
 * 规格 R2：前端只做呈现 / 数据契约，不建第二套领域 seam。这里验证左栏列表
 * （名字 / hash 前缀 / 启停态）、右栏元数据 + SKILL.md 的配置文本呈现、顶部
 * 单条导入 / 刷新候选 / 全部导入，以及每个动作打到后端哪条路径。安装校验、
 * 字节与装配由后端 HTTP 面验收。
 */

const AGENT_ID = 'agent-skills-1';

function skillView(overrides: Partial<AgentSkillsView['skills'][number]> = {}) {
  return {
    id: 'skill-1',
    member_id: AGENT_ID,
    name: 'review',
    content_hash: '0123456789abcdef'.repeat(4),
    enabled: true,
    source: 'agents-skills' as const,
    created_at: '2026-11-04T00:00:00.000Z',
    updated_at: '2026-11-04T00:00:00.000Z',
    ...overrides,
  };
}

function skillsView(overrides: Partial<AgentSkillsView> = {}): AgentSkillsView {
  return {
    agent_id: AGENT_ID,
    home_path: `/tmp/home/.allibot/agents/${AGENT_ID}`,
    skills: [
      skillView(),
      skillView({
        id: 'skill-2',
        name: 'notes',
        content_hash: 'fedcba9876543210'.repeat(4),
        enabled: false,
        source: 'directory',
      }),
    ],
    ...overrides,
  };
}

function detailView(overrides: Partial<AgentSkillDetailView> = {}): AgentSkillDetailView {
  return {
    agent_id: AGENT_ID,
    skill: skillView(),
    markdown: '---\nname: review\ndescription: 代码评审\n---\n\n# Review\n\n按清单评审。\n',
    ...overrides,
  };
}

function candidatesView(overrides: Partial<AgentSkillCandidatesView> = {}): AgentSkillCandidatesView {
  return {
    agent_id: AGENT_ID,
    source: '/tmp/home/.agents/skills',
    available: true,
    candidates: [
      {
        name: 'fresh',
        path: '/tmp/home/.agents/skills/fresh',
        importable: true,
        installed: false,
        reason: null,
      },
      {
        name: 'review',
        path: '/tmp/home/.agents/skills/review',
        importable: true,
        installed: true,
        reason: null,
      },
      {
        name: 'broken',
        path: '/tmp/home/.agents/skills/broken',
        importable: false,
        installed: false,
        reason: 'SKILL.md is missing',
      },
    ],
    ...overrides,
  };
}

function agent(overrides: Partial<AgentView> = {}): AgentView {
  return {
    id: AGENT_ID,
    kind: 'agent',
    display_name: '技能成员',
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

test('the skills tab renders the left list, the right metadata + SKILL.md text and the top actions', () => {
  const html = renderToStaticMarkup(
    createElement(SkillsPanel, {
      locale: 'zh-CN',
      face: {
        view: skillsView(),
        detail: detailView(),
        candidates: candidatesView(),
        onSelect: () => undefined,
        onRefreshCandidates: async () => undefined,
        onImport: async () => undefined,
        onImportAll: async () => undefined,
        onToggleEnabled: async () => undefined,
        onDelete: async () => undefined,
      },
    }),
  );

  assert.match(html, /data-section="skills"/);
  assert.match(html, /data-field="skills-list"/);
  assert.match(html, /data-skill-name="review"/);
  assert.match(html, /data-skill-name="notes"/);
  assert.match(html, /data-skill-hash="0123456789ab"/, 'the list shows the hash prefix');
  assert.match(html, /data-skill-enabled="true"/);
  assert.match(html, /data-skill-enabled="false"/);
  assert.match(html, /data-action="toggle-skill"/, 'the enable switch lives in the list row');

  assert.match(html, /data-section="skill-detail"/);
  assert.match(html, /data-field="skill-hash"/);
  assert.match(html, /0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef/, 'the right pane has the full hash');
  assert.match(html, /data-field="skill-source"/);
  assert.match(html, /agents-skills/);
  assert.match(html, /data-field="skill-markdown"/);
  assert.match(html, /<pre[^>]*data-field="skill-markdown"[^>]*>[\s\S]*按清单评审。/);
  assert.match(html, /data-action="delete-skill"/);
  assert.doesNotMatch(html, /markdown-body|copilot-message|chat-bubble/, 'the SKILL.md is config text, not a chat bubble');
  assert.doesNotMatch(html, /<a\b/, 'the tab opens no route');

  assert.match(html, /data-action="import-skill"/);
  assert.match(html, /data-action="refresh-skill-candidates"/);
  assert.match(html, /data-action="import-all-skills"/);
  assert.match(html, /data-field="skill-candidate"/);
  assert.match(html, /<option[^>]*value="fresh"/);
  assert.doesNotMatch(html, /<option[^>]*value="review"/, 'an installed candidate is not offered');
  assert.doesNotMatch(html, /<option[^>]*value="broken"/, 'an unimportable candidate is not offered');
});

test('the skills tab renders loading / empty / unavailable candidate states without fabricating rows', () => {
  const pending = renderToStaticMarkup(
    createElement(SkillsPanel, {
      locale: 'zh-CN',
      face: { view: null, detail: null, candidates: null },
    }),
  );
  assert.match(pending, /data-field="skills-pending"/);
  assert.match(pending, /data-field="skill-candidates-pending"/);
  assert.doesNotMatch(pending, /data-skill-name=/);

  const empty = renderToStaticMarkup(
    createElement(SkillsPanel, {
      locale: 'zh-CN',
      face: { view: skillsView({ skills: [] }), detail: null, candidates: candidatesView({ available: false }) },
    }),
  );
  assert.match(empty, /data-field="skills-empty"/);
  assert.match(empty, /data-field="skill-candidates-empty"/);
  assert.doesNotMatch(empty, /data-skill-name=/);
});

test('the skills helpers translate the wire contracts and select a stable row', () => {
  assert.equal(skillHashPrefix('0123456789abcdef'), '0123456789ab');
  assert.equal(skillHashPrefix('0123456789abcdef', 4), '0123');
  assert.deepEqual(installCandidateBody('review'), { source: 'agents-skills', name: 'review' });
  assert.deepEqual(enabledPatch(false), { enabled: false });

  const candidates = candidatesView();
  assert.deepEqual(
    importableCandidates(candidates).map((candidate) => candidate.name),
    ['fresh'],
  );
  assert.equal(resolveCandidateName(candidates, null), 'fresh');
  assert.equal(resolveCandidateName(candidates, 'review'), 'fresh', 'an installed pick falls back');
  assert.equal(resolveCandidateName(candidates, 'fresh'), 'fresh');
  assert.equal(resolveCandidateName(candidatesView({ candidates: [] }), 'fresh'), null);

  const view = skillsView();
  assert.equal(selectedSkill(view, null)?.name, 'review');
  assert.equal(selectedSkill(view, 'notes')?.name, 'notes');
  assert.equal(selectedSkill(view, 'gone')?.name, 'review');
  assert.equal(selectedSkill(skillsView({ skills: [] }), 'review'), null);
});

test('the skills actions hit the documented endpoint with exactly the documented body', async () => {
  const calls: { url: string; method: string; body: string }[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      body: String(init?.body ?? ''),
    });
    const method = init?.method ?? 'GET';
    const body =
      method === 'DELETE'
        ? null
        : method === 'PATCH'
          ? { skill: skillView({ enabled: false }) }
          : method === 'POST' && String(url).endsWith('/skills')
            ? { skill: skillView(), created: true }
            : method === 'POST'
              ? { agent_id: AGENT_ID, results: [], imported: 0, skipped: 0, failed: 0 }
              : String(url).endsWith('/skill-candidates')
                ? candidatesView()
                : String(url).includes('/skills/')
                  ? detailView()
                  : skillsView();
    if (method === 'DELETE') {
      return new Response(null, { status: 204 });
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  await readAgentSkills(fetchImpl, AGENT_ID);
  await readAgentSkill(fetchImpl, AGENT_ID, 'review');
  await readSkillCandidates(fetchImpl, AGENT_ID);
  await installAgentSkill(fetchImpl, AGENT_ID, 'review');
  await importAllAgentSkills(fetchImpl, AGENT_ID);
  await setAgentSkillEnabled(fetchImpl, AGENT_ID, 'review', false);
  await deleteAgentSkill(fetchImpl, AGENT_ID, 'review');

  assert.deepEqual(
    calls.map((call) => [call.method, call.url]),
    [
      ['GET', `/api/agents/${AGENT_ID}/skills`],
      ['GET', `/api/agents/${AGENT_ID}/skills/review`],
      ['GET', `/api/agents/${AGENT_ID}/skill-candidates`],
      ['POST', `/api/agents/${AGENT_ID}/skills`],
      ['POST', `/api/agents/${AGENT_ID}/skills/import-all`],
      ['PATCH', `/api/agents/${AGENT_ID}/skills/review`],
      ['DELETE', `/api/agents/${AGENT_ID}/skills/review`],
    ],
  );
  assert.deepEqual(JSON.parse(calls[3]!.body), { source: 'agents-skills', name: 'review' });
  assert.deepEqual(JSON.parse(calls[5]!.body), { enabled: false });
});

test('the skills panel stays mounted while the basic tab is open, so the selection and drafts survive', () => {
  const html = renderToStaticMarkup(
    createElement(AgentDetailPanel, {
      agent: agent(),
      locale: 'zh-CN',
      initialTab: 'basic',
      initialDraft: { systemPrompt: '未提交的草稿' },
      skills: {
        view: skillsView(),
        detail: detailView(),
        candidates: candidatesView(),
        onSelect: () => undefined,
      },
    }),
  );

  const skills = panelRegion(html, 'skills');
  assert.match(skills, /hidden/, 'the skills panel is hidden, not unmounted');
  assert.match(skills, /data-skill-name="review"/);
  assert.match(html, /<textarea[^>]*>未提交的草稿<\/textarea>/);
  const tabs = [...html.matchAll(/data-tab="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(tabs, ['basic', 'skills', 'mcp']);
});

test('the skills modules never touch the URL or fetch on their own', async () => {
  for (const file of ['SkillsPanel.ts', 'skills-tab.ts']) {
    const source = await readFile(new URL(`../src/workspace/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\b(?:history|location)\./, `${file} changes the URL`);
    assert.doesNotMatch(source, /\bfetch\s*\(/, `${file} fetches directly`);
  }
});
