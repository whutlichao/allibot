import {
  PLAN_TASK_STATUSES,
  t,
  type Locale,
  type PlanRunView,
  type PlanTaskStatus,
  type PlanTaskView,
  type PlanUpdateFrame,
  type WorkspaceView,
} from '@allibot/shared';

/**
 * Plan (Plan Run) 的呈现层读取 (#40 / D4.1): the latest runs come from
 * `GET /api/targets/{id}/plans`, and the one live `plan_update` frame replaces
 * the current task list. A Plan is a work list, never a message or a task-board
 * row; this module only reads and formats it.
 */

/** One page of the target's Plan snapshot. */
export async function readPlans(
  fetchImpl: typeof fetch,
  targetId: string,
  options: { limit?: number; memberId?: string } = {},
): Promise<PlanRunView[]> {
  const limit = options.limit ?? 20;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.memberId !== undefined) {
    params.set('member_id', options.memberId);
  }
  const response = await fetchImpl(
    `/api/targets/${encodeURIComponent(targetId)}/plans?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(`GET target ${targetId} plans failed with ${response.status}`);
  }
  const body = (await response.json()) as { plans?: PlanRunView[] };
  return body.plans ?? [];
}

/** The three-word Plan status, rendered from the one catalog. */
export function planTaskStatusLabel(locale: Locale, status: PlanTaskStatus): string {
  switch (status) {
    case 'pending':
      return t(locale, 'workspace.plan.status.pending');
    case 'in_progress':
      return t(locale, 'workspace.plan.status.inProgress');
    case 'completed':
      return t(locale, 'workspace.plan.status.completed');
  }
}

/**
 * Whether the selected target carries a Plan reading: any task target, or a
 * team channel. A DM and an autonomous channel round have no Plan, matching
 * the backend's tool availability.
 */
export function isPlanTarget(workspace: WorkspaceView, targetId: string | null): boolean {
  if (targetId === null) {
    return false;
  }
  const channel = workspace.channels.find((row) => row.id === targetId);
  if (channel !== undefined) {
    return channel.mode === 'team';
  }
  return workspace.tasks.some((task) => task.target_id === targetId);
}

/**
 * Narrow one `plan_update` payload. `tasks` is the complete current list; a
 * malformed frame is ignored rather than trusted.
 */
export function readPlanUpdateFrame(
  data: Record<string, unknown>,
): PlanUpdateFrame | null {
  const runId = data['plan_run_id'];
  const targetId = data['target_id'];
  const memberId = data['member_id'];
  const occurredAt = data['occurred_at'];
  const tasks = data['tasks'];
  if (
    typeof runId !== 'string' ||
    typeof targetId !== 'string' ||
    typeof memberId !== 'string' ||
    typeof occurredAt !== 'string' ||
    !Array.isArray(tasks)
  ) {
    return null;
  }
  const parsedTasks: PlanTaskView[] = [];
  for (const entry of tasks) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return null;
    }
    const task = entry as Record<string, unknown>;
    const id = task['id'];
    const planRunId = task['plan_run_id'];
    const title = task['title'];
    const status = task['status'];
    const position = task['position'];
    const createdAt = task['created_at'];
    const updatedAt = task['updated_at'];
    if (
      typeof id !== 'string' ||
      typeof planRunId !== 'string' ||
      typeof title !== 'string' ||
      typeof status !== 'string' ||
      !(PLAN_TASK_STATUSES as readonly string[]).includes(status) ||
      typeof position !== 'number' ||
      !Number.isInteger(position) ||
      position < 0 ||
      typeof createdAt !== 'string' ||
      typeof updatedAt !== 'string'
    ) {
      return null;
    }
    parsedTasks.push({
      id,
      plan_run_id: planRunId,
      title,
      status: status as PlanTaskStatus,
      position,
      created_at: createdAt,
      updated_at: updatedAt,
    });
  }
  return {
    plan_run_id: runId,
    target_id: targetId,
    member_id: memberId,
    tasks: parsedTasks,
    occurred_at: occurredAt,
  };
}

/**
 * Apply one live frame to the already-read Plan snapshots: the matching run
 * takes the complete task list and the occurrence time, and a frame for a run
 * not on the current page is prepended for that target. A frame for another
 * target changes nothing; the shell re-reads that target's snapshot for rows
 * it has not loaded yet. Plan updates never become messages.
 */
export function applyPlanUpdateFrame(
  plansByTarget: Record<string, readonly PlanRunView[]>,
  frame: PlanUpdateFrame,
): Record<string, readonly PlanRunView[]> {
  const plans = plansByTarget[frame.target_id];
  if (plans === undefined) {
    return plansByTarget;
  }
  const index = plans.findIndex((plan) => plan.id === frame.plan_run_id);
  if (index === -1) {
    return {
      ...plansByTarget,
      [frame.target_id]: [
        {
          id: frame.plan_run_id,
          target_id: frame.target_id,
          member_id: frame.member_id,
          created_at: frame.occurred_at,
          updated_at: frame.occurred_at,
          tasks: frame.tasks,
        },
        ...plans,
      ],
    };
  }
  return {
    ...plansByTarget,
    [frame.target_id]: plans.map((plan, planIndex) =>
      planIndex === index
        ? { ...plan, updated_at: frame.occurred_at, tasks: frame.tasks }
        : plan,
    ),
  };
}
