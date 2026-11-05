import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CopilotChat,
  CopilotKitProvider,
  HttpAgent,
  type Message,
} from '@copilotkit/react-core/v2';
import type {
  AgentView,
  ChannelView,
  DmView,
  MessageView,
  TaskView,
  WorkspaceView,
} from '@allibot/shared';
import { ZH_CN } from '../../shared/dist/index.js';
import {
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
  ALLIBOT_AGENT_ID,
} from '../src/copilotkit-contract.ts';
import {
  buildWorkspaceNav,
  initialTargetId,
  readTargetContext,
  targetKind,
} from '../src/workspace/model.ts';
import {
  NARROW_VIEWPORT_MAX_WIDTH,
  closeDrawer,
  openNavigation,
  openWorkspacePanel,
  resolveWorkspaceLayout,
  selectWorkspaceTarget,
  type WorkspaceShellState,
} from '../src/workspace/shell-state.ts';
import {
  MESSAGE_PAGE_SIZE,
  appendThreadMessage,
  applyMessageCreated,
  dedupeMessages,
  hydrateThread,
  parseLiveEvent,
  readRecentMessages,
  shouldRefreshWorkspace,
  toChatMessage,
} from '../src/workspace/message-sync.ts';
import { TargetNav } from '../src/workspace/TargetNav.ts';
import { ContextPanel } from '../src/workspace/ContextPanel.ts';
import {
  WorkspaceChatArea,
  WorkspaceChatView,
  workspaceChatProps,
} from '../src/workspace/WorkspaceChat.ts';
import { WorkspaceShell } from '../src/workspace/WorkspaceShell.ts';
import { WorkspaceComposer, WorkspaceMessageView } from '../src/workspace/WorkspaceMessages.ts';
import { App } from '../src/App.ts';

/**
 * Component and static contract tests for the one React workspace shell (#29):
 * the reading the navigation renders from, the thread identity the chat binds,
 * manual hydration dedup, the drawer / docked-sidebar discipline and the
 * absence of the retired `/studio/` routes.
 *
 * They render through React SSR and read plain values; effects (hydration and
 * the global SSE subscription) are covered through the exported helpers so no
 * browser, network or second domain seam is introduced.
 */

const CHANNEL_ID = '11111111-1111-4111-8111-111111111111';
const ARCHIVED_CHANNEL_ID = '22222222-2222-4222-8222-222222222222';
const DM_ID = '33333333-3333-4333-8333-333333333333';
const ARCHIVED_DM_ID = '44444444-4444-4444-8444-444444444444';
const TASK_ID = '55555555-5555-4555-8555-555555555555';
const TASK_TARGET_ID = '66666666-6666-4666-8666-666666666666';

const WEB_ROOT = new URL('../', import.meta.url);
const WEB_SRC = new URL('../src/', import.meta.url);

async function sourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
    } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function agent(id: string, displayName: string): AgentView {
  return {
    id,
    kind: 'agent',
    display_name: displayName,
    avatar_slot: 1,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    role: 'engineer',
    model: 'openai:gpt-5',
    credential_status: 'present',
    system_prompt: '',
    enabled: 1,
    context_window: 40,
    compression_threshold: 30,
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
  };
}

function channel(overrides: Partial<ChannelView> & Pick<ChannelView, 'id' | 'name'>): ChannelView {
  return {
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
    ...overrides,
  };
}

function dm(id: string, peerName: string, deletedAt: string | null = null): DmView {
  return {
    id,
    peer: { id: `peer-${id}`, display_name: peerName, avatar_slot: 2, deleted_at: deletedAt },
  };
}

function task(overrides: Partial<TaskView> = {}): TaskView {
  return {
    id: TASK_ID,
    channel_id: CHANNEL_ID,
    target_id: TASK_TARGET_ID,
    title: '把工作台壳接好',
    status: 'in_progress',
    assignee_member_id: 'agent-1',
    claimed_at: '2026-11-03T00:00:00.000Z',
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    channel_mode: 'autonomous',
    allowed_transitions: ['in_review', 'closed'],
    message_count: 2,
    unread_count: 1,
    ...overrides,
  };
}

function message(
  id: string,
  seq: number,
  kind: MessageView['kind'],
  body: string,
  overrides: Partial<MessageView> = {},
): MessageView {
  return {
    id,
    target_id: CHANNEL_ID,
    seq,
    kind,
    author_member_id: kind === 'agent' ? 'agent-1' : 'owner-1',
    author_display_name: kind === 'agent' ? '阿蓝' : 'owner',
    author_avatar_slot: kind === 'agent' ? 1 : 0,
    body,
    created_at: '2026-11-03T00:00:00.000Z',
    task_ref: null,
    task_pointer: null,
    client_message_id: null,
    mentions: [],
    attachments: [],
    ...overrides,
  };
}

function workspace(): WorkspaceView {
  return {
    owner: { id: 'owner-1', kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [agent('agent-1', '阿蓝')],
    channels: [
      channel({ id: CHANNEL_ID, name: '协作环' }),
      channel({
        id: ARCHIVED_CHANNEL_ID,
        name: '旧频道',
        archived_at: '2026-11-02T00:00:00.000Z',
      }),
    ],
    dms: [dm(DM_ID, '阿绿'), dm(ARCHIVED_DM_ID, '阿灰', '2026-11-02T00:00:00.000Z')],
    tasks: [task()],
    pending_approvals: 0,
    unread_total: 4,
    unread_by_target: { [CHANNEL_ID]: 2, [DM_ID]: 1, [ARCHIVED_DM_ID]: 1 },
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: { 'agent-1': { status: 'online', offline_reason: null } },
    workspace_runtime: {
      docker: { available: false, image: 'node:22-bookworm-slim', reason: 'docker-unavailable' },
    },
  };
}

test('the navigation groups channels, DMs and tasks from the workspace reading', () => {
  const nav = buildWorkspaceNav(workspace());

  assert.deepEqual(nav.channels, [
    { targetId: CHANNEL_ID, kind: 'channel', label: '协作环', unread: 2 },
  ]);
  assert.deepEqual(nav.archivedChannels, [
    { targetId: ARCHIVED_CHANNEL_ID, kind: 'channel', label: '旧频道', unread: 0 },
  ]);
  assert.deepEqual(nav.dms, [
    { targetId: DM_ID, kind: 'dm', label: '阿绿', unread: 1 },
  ]);
  assert.deepEqual(nav.archivedDms, [
    { targetId: ARCHIVED_DM_ID, kind: 'dm', label: '阿灰', unread: 1 },
  ]);
  assert.deepEqual(nav.tasks, [
    { targetId: TASK_TARGET_ID, kind: 'task', label: '把工作台壳接好', unread: 1 },
  ]);
});

test('the shell opens on the first active target and reads context from the same snapshot', () => {
  const reading = workspace();
  assert.equal(initialTargetId(reading), CHANNEL_ID);
  assert.equal(targetKind(reading, CHANNEL_ID), 'channel');
  assert.equal(targetKind(reading, DM_ID), 'dm');
  assert.equal(targetKind(reading, TASK_TARGET_ID), 'task');
  assert.equal(targetKind(reading, 'not-in-the-reading'), null);

  assert.deepEqual(readTargetContext(reading, CHANNEL_ID), {
    targetId: CHANNEL_ID,
    kind: 'channel',
    label: '协作环',
    description: null,
    unread: 2,
    taskStatus: null,
  });
  assert.deepEqual(readTargetContext(reading, DM_ID), {
    targetId: DM_ID,
    kind: 'dm',
    label: '阿绿',
    description: null,
    unread: 1,
    taskStatus: null,
  });
  assert.deepEqual(readTargetContext(reading, TASK_TARGET_ID), {
    targetId: TASK_TARGET_ID,
    kind: 'task',
    label: '把工作台壳接好',
    description: null,
    unread: 1,
    taskStatus: 'in_progress',
  });
  assert.equal(readTargetContext(reading, null), null);
  assert.equal(readTargetContext(reading, 'not-in-the-reading'), null);
});

test('an empty workspace yields no initial target', () => {
  const empty: WorkspaceView = {
    ...workspace(),
    agents: [],
    channels: [],
    dms: [],
    tasks: [],
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: {},
    status_points: {},
    workspace_runtime: {
      docker: { available: false, image: 'node:22-bookworm-slim', reason: 'docker-unavailable' },
    },
  };

  assert.equal(initialTargetId(empty), null);
});

test('wide layout docks exactly one sidebar and narrow layout keeps navigation reachable', () => {
  const wide = resolveWorkspaceLayout(1280);
  assert.deepEqual(wide, { dockedSidebar: 'navigation', navigationInDrawer: false });

  const narrow = resolveWorkspaceLayout(NARROW_VIEWPORT_MAX_WIDTH - 1);
  assert.deepEqual(narrow, { dockedSidebar: null, navigationInDrawer: true });
  assert.equal(resolveWorkspaceLayout(NARROW_VIEWPORT_MAX_WIDTH).dockedSidebar, 'navigation');
});

test('opening a drawer or navigating never moves the selected target', () => {
  const initial: WorkspaceShellState = { activeTargetId: CHANNEL_ID, drawer: null };

  for (const panel of ['context', 'task-board', 'members', 'roster', 'agent-detail'] as const) {
    const opened = openWorkspacePanel(initial, panel);
    assert.equal(opened.activeTargetId, CHANNEL_ID, `opening ${panel} must not change the target`);
    assert.equal(opened.drawer, panel);
    assert.equal(closeDrawer(opened).activeTargetId, CHANNEL_ID);
    assert.equal(closeDrawer(opened).drawer, null);
  }

  const withPanel = openWorkspacePanel(initial, 'task-board');
  const navigation = openNavigation(withPanel);
  assert.equal(navigation.drawer, 'navigation', 'the navigation drawer replaces the open panel');
  assert.equal(navigation.activeTargetId, CHANNEL_ID);

  const switched = selectWorkspaceTarget(initial, DM_ID);
  assert.equal(switched.activeTargetId, DM_ID, 'selecting a target is the only move that changes it');
  assert.equal(switched.drawer, null, 'selecting a target returns the chat to the front');
});

test('a stored message maps to one chat message with the SQLite id', () => {
  const identity = (view: ReturnType<typeof message>) => {
    const mapped = toChatMessage(view);
    return { id: mapped.id, role: mapped.role, content: mapped.content };
  };
  assert.deepEqual(identity(message('m-human', 1, 'human', '你好')), {
    id: 'm-human',
    role: 'user',
    content: '你好',
  });
  assert.deepEqual(identity(message('m-agent', 2, 'agent', '收到')), {
    id: 'm-agent',
    role: 'assistant',
    content: '收到',
  });
  assert.deepEqual(identity(message('m-system', 3, 'system', '任务已创建')), {
    id: 'm-system',
    role: 'system',
    content: '任务已创建',
  });
});

test('hydration and SSE append dedupe by messageId and survive switching away and back', async () => {
  const agent = new HttpAgent({
    url: '/api/copilotkit/agent/allibot/run',
    agentId: ALLIBOT_AGENT_ID,
    threadId: CHANNEL_ID,
    fetch: (async () => new Response('')) as typeof fetch,
  });
  const first = message('m-1', 1, 'human', '第一条');
  const reply = message('m-2', 2, 'agent', '回复');

  hydrateThread(agent, [first, reply, { ...reply, body: '重复的水合行' }]);
  assert.deepEqual(
    agent.messages.map((row) => [row.id, row.content]),
    [
      ['m-1', '第一条'],
      ['m-2', '重复的水合行'],
    ],
    'hydration keeps one row per messageId and the last copy wins',
  );

  assert.equal(appendThreadMessage(agent, reply), false, 'the SSE append is a no-op for a known id');
  assert.equal(appendThreadMessage(agent, message('m-3', 3, 'agent', '又一条')), true);
  assert.deepEqual(
    agent.messages.map((row) => row.id),
    ['m-1', 'm-2', 'm-3'],
  );

  hydrateThread(agent, [message('m-9', 9, 'human', '另一个 target')], { replace: true });
  assert.deepEqual(
    agent.messages.map((row) => row.id),
    ['m-9'],
    'the thread is replaced when the target changes',
  );

  hydrateThread(agent, [first, reply]);
  hydrateThread(agent, [first, reply]);
  assert.deepEqual(
    agent.messages.map((row) => row.id),
    ['m-1', 'm-2'],
    'switching away and back rehydrates one row per messageId',
  );
});

test('a user message already shown under its client id is not appended twice', () => {
  const agent = new HttpAgent({
    url: '/api/copilotkit/agent/allibot/run',
    agentId: ALLIBOT_AGENT_ID,
    threadId: CHANNEL_ID,
    fetch: (async () => new Response('')) as typeof fetch,
  });
  agent.setMessages([{ id: 'client-1', role: 'user', content: '本地气泡' } as Message]);

  const stored = message('sqlite-1', 1, 'human', '本地气泡', { client_message_id: 'client-1' });
  assert.equal(appendThreadMessage(agent, stored), false);
  assert.deepEqual(
    agent.messages.map((row) => row.id),
    ['client-1'],
  );
});

test('recent hydration pages forward from the backend read and keeps the newest limit', async () => {
  const pages = [
    Array.from({ length: MESSAGE_PAGE_SIZE }, (_, index) =>
      message(`m-${index + 1}`, index + 1, 'human', `第 ${index + 1} 条`),
    ),
    Array.from({ length: 3 }, (_, index) =>
      message(`m-${MESSAGE_PAGE_SIZE + index + 1}`, MESSAGE_PAGE_SIZE + index + 1, 'human', '尾页'),
    ),
  ];
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    const page = pages.shift() ?? [];
    return new Response(JSON.stringify({ messages: page }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  const recent = await readRecentMessages(fetchImpl, CHANNEL_ID, 2);

  assert.deepEqual(
    recent.map((row) => row.id),
    ['m-202', 'm-203'],
    'only the newest N messages are hydrated',
  );
  assert.deepEqual(calls, [
    `/api/targets/${CHANNEL_ID}/messages?after_seq=0&limit=${MESSAGE_PAGE_SIZE}`,
    `/api/targets/${CHANNEL_ID}/messages?after_seq=${MESSAGE_PAGE_SIZE}&limit=${MESSAGE_PAGE_SIZE}`,
  ]);
});

test('a message.created frame appends once and only for the current thread', async () => {
  const agent = new HttpAgent({
    url: '/api/copilotkit/agent/allibot/run',
    agentId: ALLIBOT_AGENT_ID,
    threadId: CHANNEL_ID,
    fetch: (async () => new Response('')) as typeof fetch,
  });
  const stored = message('m-live', 7, 'agent', '实时回复');
  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response(JSON.stringify({ messages: [stored] }), {
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  const frame = { target_id: CHANNEL_ID, message_id: 'm-live', seq: 7 };

  assert.equal(await applyMessageCreated({ data: frame, threadId: CHANNEL_ID, agent, fetchImpl }), true);
  assert.equal(await applyMessageCreated({ data: frame, threadId: CHANNEL_ID, agent, fetchImpl }), false);
  assert.equal(
    await applyMessageCreated({ data: frame, threadId: DM_ID, agent, fetchImpl }),
    false,
    'a frame for another target never enters this thread',
  );
  assert.deepEqual(
    agent.messages.map((row) => row.id),
    ['m-live'],
  );
  assert.deepEqual(calls, [`/api/targets/${CHANNEL_ID}/messages?after_seq=6&limit=1`]);
});

test('live frames are parsed by event type and only workspace facts trigger a re-read', () => {
  assert.deepEqual(parseLiveEvent('message.created', '{"target_id":"t","message_id":"m","seq":1}'), {
    event: 'message.created',
    data: { target_id: 't', message_id: 'm', seq: 1 },
  });
  assert.equal(parseLiveEvent('message.created', 'not json'), null);
  assert.equal(parseLiveEvent('unknown.event', '{}'), null);

  assert.equal(shouldRefreshWorkspace('unread.changed'), true);
  assert.equal(shouldRefreshWorkspace('task.changed'), true);
  assert.equal(shouldRefreshWorkspace('workspace.changed'), true);
  assert.equal(shouldRefreshWorkspace('member.status'), true);
  assert.equal(shouldRefreshWorkspace('round.outcome'), true);
  assert.equal(shouldRefreshWorkspace('reminder.due'), true);
  assert.equal(shouldRefreshWorkspace('unknown.event'), false);
  assert.equal(
    shouldRefreshWorkspace('message.created'),
    false,
    'a chat message is appended to the thread, not re-read through the workspace snapshot',
  );
  assert.equal(dedupeMessages([]).length, 0);
});

test('the left navigation lists every target group and the local Agents from the reading', () => {
  const html = renderToStaticMarkup(
    createElement(TargetNav, {
      workspace: workspace(),
      activeTargetId: CHANNEL_ID,
      locale: 'zh-CN',
    }),
  );

  for (const section of ['channels', 'archived-channels', 'dms', 'archived-dms', 'tasks', 'agents']) {
    assert.match(html, new RegExp(`data-section="${section}"`), `missing the ${section} section`);
  }
  for (const label of ['协作环', '旧频道', '阿绿', '阿灰', '把工作台壳接好', '阿蓝']) {
    assert.ok(html.includes(label), `the navigation is missing ${label}`);
  }

  assert.match(
    html,
    /data-target-id="11111111-1111-4111-8111-111111111111"[^>]*aria-current="true"/,
    'the selected target is marked current',
  );
  assert.ok(html.includes('2 条未读'), 'the unread badge renders the workspace reading');
  assert.match(html, /data-action="open-panel" data-panel="task-board"/);
  assert.match(html, /data-action="open-agent-detail" data-member-id="agent-1"/);
});

test('the context panel reads the selected target from the same workspace snapshot', () => {
  const channelHtml = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(),
      targetId: CHANNEL_ID,
      locale: 'zh-CN',
    }),
  );
  for (const copy of ['协作环', '频道', '2 条未读']) {
    assert.ok(channelHtml.includes(copy), `the context panel is missing ${copy}`);
  }
  for (const panel of ['members', 'roster', 'agent-detail']) {
    assert.match(channelHtml, new RegExp(`data-panel="${panel}"`), `missing the ${panel} entry`);
  }

  const taskHtml = renderToStaticMarkup(
    createElement(ContextPanel, {
      workspace: workspace(),
      targetId: TASK_TARGET_ID,
      locale: 'zh-CN',
    }),
  );
  for (const copy of ['把工作台壳接好', '任务', '进行中', '1 条未读']) {
    assert.ok(taskHtml.includes(copy), `the task context is missing ${copy}`);
  }

  const emptyHtml = renderToStaticMarkup(
    createElement(ContextPanel, { workspace: workspace(), targetId: null, locale: 'zh-CN' }),
  );
  assert.ok(emptyHtml.includes('尚未选择 target'));
});

test('the main area is one CopilotChat bound to agentId="allibot" and threadId=target_id', () => {
  const first = WorkspaceChatArea({ targetId: CHANNEL_ID });
  const chat = (first.props as { children?: { type?: unknown } }).children;
  assert.equal(chat?.type, CopilotChat, 'the shell main area is the CopilotChat component');
  const rendered = renderToStaticMarkup(
    createElement(
      CopilotKitProvider as never,
      { runtimeUrl: AGUI_RUNTIME_URL, useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT } as never,
      first,
    ),
  );
  assert.match(rendered, /data-testid="copilot-chat"/);

  const firstProps = workspaceChatProps(CHANNEL_ID);
  assert.equal(firstProps.agentId, ALLIBOT_AGENT_ID);
  assert.equal(firstProps.threadId, CHANNEL_ID);
  assert.equal(firstProps.chatView, WorkspaceChatView, 'the chat view hosts hydration and SSE');
  assert.equal(
    firstProps.messageView,
    WorkspaceMessageView,
    'the production view mounts the workbench message renderer',
  );
  assert.equal(
    firstProps.input,
    WorkspaceComposer,
    'the production composer mounts mention completion',
  );

  const secondProps = workspaceChatProps(DM_ID);
  assert.equal(secondProps.agentId, ALLIBOT_AGENT_ID, 'the one agent id never follows the target');
  assert.equal(secondProps.threadId, DM_ID, 'the thread identity follows the selected target');
  assert.equal('threadId' in workspaceChatProps(null), false, 'no target means no thread binding');
});

test('the composer placeholder and disclaimer come from the zh-CN catalog', () => {
  const props = workspaceChatProps(CHANNEL_ID, 'zh-CN');
  assert.equal(
    props.labels?.chatInputPlaceholder,
    ZH_CN['workspace.composer.placeholder'].text,
    'the input placeholder is the workspace catalog copy',
  );
  assert.equal(
    props.labels?.chatDisclaimerText,
    ZH_CN['workspace.chat.disclaimer'].text,
    'the footer disclaimer is the workspace catalog copy',
  );

  const rendered = renderToStaticMarkup(
    createElement(
      CopilotKitProvider as never,
      { runtimeUrl: AGUI_RUNTIME_URL, useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT } as never,
      createElement(WorkspaceChatArea, { targetId: CHANNEL_ID }),
    ),
  );
  assert.ok(
    rendered.includes(ZH_CN['workspace.composer.placeholder'].text),
    'the rendered input carries the catalog placeholder',
  );
  assert.ok(
    rendered.includes(ZH_CN['workspace.chat.disclaimer'].text),
    'the rendered footer carries the catalog disclaimer',
  );
});

test('the shell docks one sidebar and every drawer keeps the same thread identity', async () => {
  const reading = workspace();
  const snapshot = structuredClone(reading);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(url);
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    for (const drawer of [null, 'context', 'task-board', 'members', 'roster', 'agent-detail'] as const) {
      const html = renderToStaticMarkup(
        createElement(WorkspaceShell, {
          workspace: reading,
          settings: reading.settings,
          activeTargetId: CHANNEL_ID,
          initialDrawer: drawer,
          viewportWidth: 1280,
        }),
      );
      assert.match(html, new RegExp(`data-thread-id="${CHANNEL_ID}"`), drawer ?? 'no drawer');
      assert.match(html, /data-testid="copilot-chat"/, 'the main area stays the CopilotChat');
      assert.equal(
        (html.match(/data-docked="true"/g) ?? []).length,
        1,
        'exactly one docked sidebar at a time',
      );
      if (drawer !== null) {
        assert.match(html, new RegExp(`data-drawer="${drawer}"`));
      }
    }
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [], 'rendering a drawer and its skeleton performs no request');
  assert.deepEqual(reading, snapshot, 'rendering never mutates the workspace reading');
});

test('an archived DM disables the composer; an active DM keeps it', () => {
  const renderDm = (targetId: string): string =>
    renderToStaticMarkup(
      createElement(WorkspaceShell, {
        workspace: workspace(),
        settings: workspace().settings,
        activeTargetId: targetId,
        viewportWidth: 1280,
      }),
    );

  const archived = renderDm(ARCHIVED_DM_ID);
  assert.match(archived, /data-readonly="true"/, 'the archived DM has no send entry');
  assert.ok(archived.includes('已归档'), 'the read-only notice is readable');

  const active = renderDm(DM_ID);
  assert.doesNotMatch(active, /data-readonly="true"/, 'an active DM keeps its composer');
});

test('a narrow shell moves navigation into a drawer and keeps it reachable', () => {
  const html = renderToStaticMarkup(
    createElement(WorkspaceShell, {
      workspace: workspace(),
      settings: workspace().settings,
      activeTargetId: CHANNEL_ID,
      initialDrawer: 'task-board',
      viewportWidth: NARROW_VIEWPORT_MAX_WIDTH - 1,
    }),
  );

  assert.equal((html.match(/data-docked="true"/g) ?? []).length, 0, 'nothing docks on a narrow screen');
  assert.match(html, /data-action="open-navigation"/, 'the navigation toggle stays reachable');
  assert.match(html, /data-drawer="task-board"/);
  assert.match(html, new RegExp(`data-thread-id="${CHANNEL_ID}"`), 'opening a panel leaves the target');
});

test('the app shell renders the workspace reading into the one workbench', () => {
  const html = renderToStaticMarkup(
    createElement(App, {
      workspace: workspace(),
      settings: workspace().settings,
      activeTargetId: CHANNEL_ID,
      viewportWidth: 1280,
    }),
  );

  assert.match(html, /data-testid="copilot-chat"/, 'the main area is the CopilotChat');
  assert.match(html, new RegExp(`data-thread-id="${CHANNEL_ID}"`));
  for (const copy of ['协作环', '旧频道', '阿绿', '把工作台壳接好', '本机 Agent']) {
    assert.ok(html.includes(copy), `the shell is missing ${copy}`);
  }
});

test('the repository has one React workbench entry and no retired studio routes', async () => {
  const indexHtml = await readFile(new URL('index.html', WEB_ROOT), 'utf8');
  const scriptSources = [...indexHtml.matchAll(/<script[^>]+src="([^"]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(scriptSources, ['/src/main.tsx'], 'index.html has one React entry');

  const main = await readFile(new URL('main.tsx', WEB_SRC), 'utf8');
  assert.match(main, /['"]\/api\/workspace['"]/, 'the shell reads GET /api/workspace');
  assert.match(main, /from '\.\/App(\.ts|\.tsx)?'/, 'main.tsx renders the App shell');

  for (const file of await sourceFiles(WEB_SRC)) {
    const source = await readFile(file, 'utf8');
    const name = file.pathname.slice(file.pathname.lastIndexOf('/') + 1);
    assert.doesNotMatch(source, /\/studio\/v2\/?/, `${name} still carries the retired /studio/v2 route`);
    assert.doesNotMatch(source, /\/studio\//, `${name} still carries the retired /studio route`);
  }
});

test('opening a drawer writes nothing: no POST or message write lives in the shell modules', async () => {
  for (const file of await sourceFiles(new URL('workspace/', WEB_SRC))) {
    const source = await readFile(file, 'utf8');
    const name = file.pathname.slice(file.pathname.lastIndexOf('/') + 1);
    assert.doesNotMatch(source, /method:\s*['"]POST['"]/, `${name} writes through POST`);
    assert.doesNotMatch(source, /method:\s*['"]PATCH['"]/, `${name} writes through PATCH`);
    assert.doesNotMatch(source, /\/api\/targets\/[^`'"]*\/messages['"`]\s*,\s*\{/, `${name} posts a message`);
  }
});
