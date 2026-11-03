import { TASK_STATUSES, type TaskStatus, type TaskView } from '@allibot/shared';

/**
 * 任务看板（Task Board）的呈现模型：按任务状态分列。它只做分组与收窄，
 * 不改变「任务恰好属于一个频道」的归属事实——这里从不改写任务行。
 */
export interface TaskBoardColumn {
  status: TaskStatus;
  tasks: TaskView[];
}

/**
 * 把 `GET /api/tasks` / `GET /api/workspace` 的任务读数按五态分列。
 * `channelId` 为 null 时是全工作区视图；筛选只收窄呈现集合。
 */
export function buildTaskBoardColumns(
  tasks: readonly TaskView[],
  channelId: string | null = null,
): TaskBoardColumn[] {
  const visible =
    channelId === null ? tasks : tasks.filter((task) => task.channel_id === channelId);
  return TASK_STATUSES.map((status) => ({
    status,
    tasks: visible.filter((task) => task.status === status),
  }));
}

/**
 * 五态到既有产品角色族 token 的固定映射（GLOSSARY 任务看板词条）：
 * todo → --faint、in_progress → --accent-graphic、in_review → --working、
 * done → --online、closed → --offline。不新造色位，也不改 token 取值。
 */
export const TASK_STATUS_COLOR_TOKENS: Readonly<Record<TaskStatus, string>> = {
  todo: '--faint',
  in_progress: '--accent-graphic',
  in_review: '--working',
  done: '--online',
  closed: '--offline',
};

export function taskStatusColorToken(status: TaskStatus): string {
  return TASK_STATUS_COLOR_TOKENS[status];
}

/**
 * 拖拽落点是否合法：只读任务载荷的 `allowed_transitions`。前端不持迁移表
 * 副本，也不把「同一个状态」当作可落点（后端给出的集合里本来就没有它）。
 */
export function canDropTask(task: TaskView, status: TaskStatus): boolean {
  return task.allowed_transitions.includes(status);
}

/** 一次状态迁移的结果；失败时看板不改任务行，只等下一次读数。 */
export type TaskTransitionOutcome =
  | { ok: true; task: TaskView }
  | { ok: false; reason: 'not-allowed' | 'rejected'; status?: number };

/**
 * 状态迁移的写入口：先按任务载荷的合法集合挡掉非法落点（零写入），再
 * `PATCH /api/tasks/{id}` 交由写路径裁决。失败（含 400）只返回结果，不在
 * 本地改任务行——看板不做乐观更新。
 */
export async function transitionTask(
  fetchImpl: typeof fetch,
  task: TaskView,
  status: TaskStatus,
): Promise<TaskTransitionOutcome> {
  if (!canDropTask(task, status)) {
    return { ok: false, reason: 'not-allowed' };
  }
  const response = await fetchImpl(`/api/tasks/${encodeURIComponent(task.id)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
  if (!response.ok) {
    return { ok: false, reason: 'rejected', status: response.status };
  }
  return { ok: true, task: (await response.json()) as TaskView };
}
