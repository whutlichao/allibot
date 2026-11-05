import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  t,
  type ChannelView,
  type TaskStatus,
  type TaskView,
  type WorkspaceView,
} from '@allibot/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { VISUAL_CONTRACT_TOKENS } from '../src/styles/token-contract.ts';
import { TaskBoard, type TaskBoardProps } from '../src/task-board/TaskBoard.ts';
import {
  TASK_STATUS_COLOR_TOKENS,
  buildTaskBoardColumns,
  canDropTask,
  taskStatusColorToken,
  transitionTask,
} from '../src/task-board/task-board.ts';
import { WorkspaceShell } from '../src/workspace/WorkspaceShell.ts';

/**
 * 任务看板的组件级契约测试（规格 R2：前端只做呈现层契约）。
 *
 * 夹具就是 `GET /api/tasks` 的任务载荷（TaskView）：五态、allowed_transitions、
 * unread_count 都由后端给出。看板只按这些读数呈现，不持迁移表副本、不做乐观
 * 更新、不把任务线程的消息复制到频道。
 */

const CHANNEL_A = '11111111-1111-4111-8111-111111111111';
const CHANNEL_B = '22222222-2222-4222-8222-222222222222';
const ARCHIVED_CHANNEL = '33333333-3333-4333-8333-333333333333';

/** 看板列序：五个承重词，列名是呈现用语。 */
const COLUMNS: readonly TaskStatus[] = ['todo', 'in_progress', 'in_review', 'done', 'closed'];

/** 后端固定的合法迁移集合，测试用它构造任务载荷（前端不得持这份副本）。 */
const BACKEND_ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  todo: ['in_progress'],
  in_progress: ['in_review'],
  in_review: ['done'],
  done: ['closed'],
  closed: [],
};

function channel(id: string, name: string, archived = false): ChannelView {
  return {
    id,
    name,
    description: '',
    mode: 'autonomous',
    team: { leader_member_id: null, status: 'valid', reason: null },
    workspace: { root: null, backend: 'local', allow_local_shell: 0 },
    permission_mode: 'ask-writes',
    web_access: null,
    docker_egress: 0,
    response_budget_limit: 3,
    archived_at: archived ? '2026-11-02T00:00:00.000Z' : null,
    deleted_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
  };
}

function task(status: TaskStatus, overrides: Partial<TaskView> = {}): TaskView {
  const index = COLUMNS.indexOf(status) + 1;
  return {
    id: `task-${status}`,
    channel_id: CHANNEL_A,
    target_id: `target-${status}`,
    title: `任务状态 ${status}`,
    status,
    assignee_member_id: null,
    claimed_at: null,
    created_at: '2026-11-03T00:00:00.000Z',
    updated_at: '2026-11-03T00:00:00.000Z',
    channel_mode: 'autonomous',
    allowed_transitions: BACKEND_ALLOWED[status],
    message_count: index,
    unread_count: index,
    ...overrides,
  };
}

const OTHER_TASK = task('todo', {
  id: 'task-other',
  channel_id: CHANNEL_B,
  target_id: 'target-other',
  title: '另一个频道的任务',
  allowed_transitions: BACKEND_ALLOWED.todo,
  unread_count: 0,
});

const ALL_TASKS: readonly TaskView[] = [...COLUMNS.map((status) => task(status)), OTHER_TASK];

const CHANNELS: readonly ChannelView[] = [
  channel(CHANNEL_A, '协作环'),
  channel(CHANNEL_B, '研究'),
  channel(ARCHIVED_CHANNEL, '旧频道', true),
];

function render(props: Partial<TaskBoardProps> = {}): string {
  return renderToStaticMarkup(
    createElement(TaskBoard, {
      tasks: ALL_TASKS,
      channels: CHANNELS,
      locale: 'zh-CN',
      ...props,
    }),
  );
}

/** 一列的标记片段：从列标记到下一列标记之前。 */
function columnHtml(html: string, status: TaskStatus): string {
  const marker = `data-column-status="${status}"`;
  const start = html.indexOf(marker);
  assert.notEqual(start, -1, `the ${status} column is missing`);
  const next = html.indexOf('class="task-board__column"', start + marker.length);
  return html.slice(start, next === -1 ? undefined : next);
}

/** 一张卡片的标记片段。 */
function cardHtml(html: string, taskId: string): string {
  const pattern = new RegExp(`<article[^>]*data-task-id="${taskId}"[\\s\\S]*?</article>`);
  const match = pattern.exec(html);
  assert.ok(match !== null, `card ${taskId} is missing`);
  return match[0]!;
}

/** 卡片流转菜单里的目标状态，按后端给出的顺序。 */
function transitionTargets(html: string, taskId: string): string[] {
  return [...cardHtml(html, taskId).matchAll(/data-transition-to="([^"]+)"/g)].map(
    (match) => match[1]!,
  );
}

test('the board renders the five status columns and each task row in exactly one of them', () => {
  const html = render();

  const positions = COLUMNS.map((status) => html.indexOf(`data-column-status="${status}"`));
  assert.ok(
    positions.every((position) => position >= 0),
    'todo / in_progress / in_review / done / closed are all rendered',
  );
  assert.deepEqual(
    [...positions].sort((left, right) => left - right),
    positions,
    'the columns follow the five-status order',
  );

  for (const status of COLUMNS) {
    const column = columnHtml(html, status);
    assert.ok(
      column.includes(`data-task-id="task-${status}"`),
      `the ${status} task is in the ${status} column`,
    );
    assert.match(
      column,
      new RegExp(`data-task-status="${status}"`),
      `the ${status} card carries its status`,
    );
  }

  for (const row of ALL_TASKS) {
    assert.equal(
      (html.match(new RegExp(`data-task-id="${row.id}"`, 'g')) ?? []).length,
      1,
      `${row.id} appears in exactly one column`,
    );
  }
});

test('the channel filter narrows the board without changing the one-channel ownership fact', () => {
  const full = render();
  assert.ok(full.includes('data-task-id="task-other"'), 'the unfiltered board is the whole workspace');

  const filtered = render({ initialChannelId: CHANNEL_B });
  assert.ok(filtered.includes('data-task-id="task-other"'));
  for (const status of COLUMNS) {
    assert.ok(
      !columnHtml(filtered, status).includes(`data-task-id="task-${status}"`),
      `${status} 的频道 A 任务在频道 B 的筛选里不出现`,
    );
  }

  const columns = buildTaskBoardColumns(ALL_TASKS, CHANNEL_B);
  assert.deepEqual(
    columns.map((column) => column.tasks.map((row) => row.id)),
    [['task-other'], [], [], [], []],
  );
  assert.ok(
    columns
      .flatMap((column) => column.tasks)
      .every((row) => row.channel_id === CHANNEL_B),
    'filtering only narrows the view; every row keeps its channel_id',
  );

  const filterOptions = [...filtered.matchAll(/<option[^>]*value="([^"]*)"/g)].map(
    (match) => match[1]!,
  );
  assert.deepEqual(
    filterOptions,
    ['', CHANNEL_A, CHANNEL_B, ARCHIVED_CHANNEL],
    'every channel of the reading is filterable, archived channels included',
  );
});

test('the transition menu is exactly the backend allowed_transitions', () => {
  const html = render();

  for (const status of COLUMNS) {
    const row = task(status);
    assert.deepEqual(
      transitionTargets(html, row.id),
      row.allowed_transitions,
      `the ${status} menu offers the payload's moves and nothing else`,
    );
  }

  const todoCard = cardHtml(html, 'task-todo');
  for (const forbidden of ['in_review', 'done', 'closed']) {
    assert.ok(
      !todoCard.includes(`data-transition-to="${forbidden}"`),
      `an illegal target (${forbidden}) never appears in the todo menu`,
    );
  }
  assert.ok(
    !cardHtml(html, 'task-closed').includes('data-transition-to'),
    'closed is terminal: its card has no transition entry',
  );
});

test('the menu follows the payload even when it disagrees with any built-in table', () => {
  // 后端写路径才是裁决者：即便载荷给出的集合与任何本地认知不同，看板也只
  // 暴露载荷里的目标。这条测试盯住「前端不持迁移表副本」。
  const divergent = task('in_review', {
    id: 'task-divergent',
    title: '载荷说可回退',
    allowed_transitions: ['todo'],
  });

  const html = render({ tasks: [divergent] });
  assert.deepEqual(transitionTargets(html, divergent.id), ['todo']);
  assert.equal(canDropTask(divergent, 'todo'), true);
  assert.equal(canDropTask(divergent, 'done'), false, 'an unlisted target stays refused');
});

test('an illegal drop target is refused before any write', async () => {
  const todo = task('todo');
  assert.equal(canDropTask(todo, 'in_progress'), true, 'a legal drop is allowed');
  assert.equal(canDropTask(todo, 'in_review'), false, 'an illegal drop is refused');
  assert.equal(canDropTask(task('closed'), 'todo'), false, 'closed accepts no drop');

  const html = render();
  assert.match(cardHtml(html, todo.id), /draggable="true"/, 'cards use native HTML5 drag');
  assert.match(columnHtml(html, 'in_progress'), /data-column-status="in_progress"/);

  const calls: string[] = [];
  const fetchImpl = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return new Response('{}');
  }) as typeof fetch;

  const outcome = await transitionTask(fetchImpl, todo, 'closed');
  assert.deepEqual(outcome, { ok: false, reason: 'not-allowed' });
  assert.deepEqual(calls, [], 'illegal targets write nothing: no request is made');
});

test('a rejected PATCH writes nothing locally: the board keeps the reading it was given', async () => {
  const todo = task('todo');
  const snapshot = structuredClone(todo);
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    requests.push({ url: String(input), init: init! });
    return new Response(
      JSON.stringify({ error: { code: 'validation_failed', message: 'not allowed' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    );
  }) as typeof fetch;

  const outcome = await transitionTask(fetchImpl, todo, 'in_progress');

  assert.deepEqual(outcome, { ok: false, reason: 'rejected', status: 400 });
  assert.deepEqual(todo, snapshot, 'a rejected PATCH leaves the task row untouched');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.url, `/api/tasks/${todo.id}`);
  assert.equal(requests[0]!.init.method, 'PATCH');
  assert.equal(requests[0]!.init.body, JSON.stringify({ status: 'in_progress' }));

  const html = render({ tasks: [todo] });
  assert.match(
    cardHtml(html, todo.id),
    /data-task-status="todo"/,
    'the card still renders the status from the reading: no optimistic update',
  );
});

test('the five task statuses map to the existing role-family tokens, never a new color', () => {
  assert.deepEqual(TASK_STATUS_COLOR_TOKENS, {
    todo: '--faint',
    in_progress: '--accent-graphic',
    in_review: '--working',
    done: '--online',
    closed: '--offline',
  });

  const html = render();
  for (const status of COLUMNS) {
    const token = taskStatusColorToken(status);
    assert.ok(
      (VISUAL_CONTRACT_TOKENS as readonly string[]).includes(token),
      `${token} is a fixed visual-contract token`,
    );
    const card = cardHtml(html, `task-${status}`);
    assert.ok(card.includes(`background-color:var(${token})`), `the ${status} card dot paints ${token}`);
    assert.ok(
      card.includes(`border-inline-start-color:var(${token})`),
      `the ${status} card itself is edged with ${token}`,
    );
  }
  assert.doesNotMatch(html, /hsl\(|#[0-9a-fA-F]{3,8}\b/, 'the board introduces no literal color value');
});

test('the pointer chip shows unread_count, hides a zero count, and enters the task thread', () => {
  const html = render();

  const unreadCard = cardHtml(html, 'task-todo');
  assert.match(unreadCard, /data-action="open-task-thread"/);
  assert.match(unreadCard, /data-target-id="target-todo"/, 'the chip targets the task target');
  assert.ok(
    !unreadCard.includes(`data-target-id="${CHANNEL_A}"`),
    'the chip never points at the channel',
  );
  assert.ok(unreadCard.includes('data-chip-unread="1"'));
  assert.ok(unreadCard.includes(t('zh-CN', 'taskBoard.chip.unread', { count: 1 })));
  assert.ok(unreadCard.includes('1 条未读'));

  const zeroCard = cardHtml(html, 'task-other');
  assert.match(zeroCard, /data-target-id="target-other"/);
  assert.ok(!zeroCard.includes('data-chip-unread'), 'a zero unread count renders no count');
  assert.ok(!zeroCard.includes('0 条未读'));
});

function workspaceView(): WorkspaceView {
  return {
    owner: { id: 'owner-1', kind: 'owner', display_name: 'owner', avatar_slot: 0 },
    agents: [],
    channels: CHANNELS.map((row) => ({ ...row })),
    dms: [],
    tasks: ALL_TASKS.map((row) => ({ ...row })),
    pending_approvals: 0,
    unread_total: 0,
    unread_by_target: {},
    settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    status_points: {},
    workspace_runtime: {
      docker: { available: false, image: 'node:22-bookworm-slim', reason: 'docker-unavailable' },
    },
  };
}

test('opening the board in the shell performs no request and leaves the reading unchanged', () => {
  const reading = workspaceView();
  const snapshot = structuredClone(reading);
  const calls: string[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL): Promise<Response> => {
    calls.push(String(input));
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;

  try {
    const html = renderToStaticMarkup(
      createElement(WorkspaceShell, {
        workspace: reading,
        settings: reading.settings,
        activeTargetId: CHANNEL_A,
        initialDrawer: 'task-board',
        viewportWidth: 1280,
      }),
    );
    assert.match(html, /data-drawer="task-board"/, 'the existing drawer hosts the board');
    assert.ok(html.includes('data-view="task-board"'), 'the placeholder is replaced by the board');
    assert.ok(html.includes('data-task-id="task-todo"'), 'the drawer renders the task rows');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls, [], 'opening the board performs zero fetches');
  assert.deepEqual(reading, snapshot, 'the board is a view: GET /api/workspace readings do not move');
});
