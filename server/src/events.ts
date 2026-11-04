import type { PlanTaskView } from '@allibot/shared';

/**
 * 订阅 (Subscription): the process-local publish/subscribe hub behind the one
 * global live stream. It carries events only — it never reads the database and
 * never replays: a connection sees what is published after it subscribed.
 *
 * The event names are declared once, here, so the later tickets that add
 * `member.status`, `task.changed`, `unread.changed`, `reminder.due` and
 * `workspace.changed` frames do not invent a second spelling. `rotate` is not
 * a business event: it is the stream's own lifecycle frame, sent before the
 * server closes a connection so the frontend can tell a routine rotation from
 * an unreachable backend.
 */
export const SSE_EVENT_TYPES = [
  'message.created',
  'member.status',
  'round.outcome',
  'task.changed',
  'unread.changed',
  'reminder.due',
  'workspace.changed',
  'team_assignment',
  'plan_update',
  'sop_update',
  'approval.requested',
  'approval.resolved',
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** The one lifecycle frame; `data` is an empty object so every frame is shaped alike. */
export const SSE_ROTATE_EVENT = 'rotate';

export interface SseEvent {
  readonly event: SseEventType;
  readonly data: Record<string, unknown>;
}

/** One wire frame: `event: <type>\ndata: <json>\n\n`, and never an `id:` line. */
export function formatSseFrame(event: { event: string; data: Record<string, unknown> }): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * The process-local hub. Publishing is synchronous and side-effect free with
 * respect to the database: callers publish after their transaction commits, so
 * a rolled-back write never reaches a subscriber.
 */
export interface EventHub {
  publish(event: SseEvent): void;
  /** Subscribe; the returned function is the unsubscribe. */
  subscribe(listener: (event: SseEvent) => void): () => void;
}

export function createEventHub(): EventHub {
  const listeners = new Set<(event: SseEvent) => void>();
  return {
    publish: (event) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The one hub of this process. The stream is process-wide and carries no
 * configuration, so the write paths publish through this instance directly
 * rather than threading a hub through every signature; a test observes it
 * through the process's own `/api/events` connection.
 */
export const eventHub: EventHub = createEventHub();

/** The frame a stored message produces; `target_id` is the ownership fact. */
export function publishMessageCreated(message: {
  targetId: string;
  id: string;
  seq: number;
}): void {
  eventHub.publish({
    event: 'message.created',
    data: { target_id: message.targetId, message_id: message.id, seq: message.seq },
  });
}

/**
 * The frame a changed unread reading produces. It is published only when the
 * reading actually moved: a system-only message and a no-op read change
 * nothing, so they announce nothing.
 */
export function publishUnreadChanged(change: {
  targetId: string;
  unreadCount: number;
}): void {
  eventHub.publish({
    event: 'unread.changed',
    data: { target_id: change.targetId, unread_count: change.unreadCount },
  });
}

/**
 * The frame a due reminder produces. `target_id` is the owning channel, or
 * null for a reminder that belongs to no channel; no `message.created` frame
 * accompanies the null case, because no message is written.
 */
export function publishReminderDue(due: {
  reminderId: string;
  targetId: string | null;
}): void {
  eventHub.publish({
    event: 'reminder.due',
    data: { reminder_id: due.reminderId, target_id: due.targetId },
  });
}

/** The frame one round outcome row produces. */
export function publishRoundOutcome(outcome: {
  target_id: string;
  member_id: string;
  status: string;
}): void {
  eventHub.publish({
    event: 'round.outcome',
    data: {
      target_id: outcome.target_id,
      member_id: outcome.member_id,
      status: outcome.status,
    },
  });
}

/**
 * The frame one final TeamAssign assignment produces (D2.5). Only a final state
 * is published — `running` itself is not a frame, and the live hub never
 * replays, so a reconnecting client re-reads the run snapshot instead.
 */
export function publishTeamAssignment(assignment: {
  team_run_id: string;
  id: string;
  target_id: string;
  task_id: string | null;
  member_id: string;
  state: string;
  jump_consumed: number;
  reply_excerpt: string | null;
  reason: string | null;
  finished_at: string | null;
}): void {
  if (assignment.finished_at === null) {
    return;
  }
  eventHub.publish({
    event: 'team_assignment',
    data: {
      team_run_id: assignment.team_run_id,
      assignment_id: assignment.id,
      target_id: assignment.target_id,
      task_id: assignment.task_id,
      member_id: assignment.member_id,
      state: assignment.state,
      jump_consumed: assignment.jump_consumed,
      reply_excerpt: assignment.reply_excerpt,
      reason: assignment.reason,
      occurred_at: assignment.finished_at,
    },
  });
}

/**
 * The frame a Plan mutation produces (D2.5): `tasks` is the run's complete
 * current list, never a delta, so a subscriber can replace its copy. Only a
 * committed mutation publishes; a read-only tool call and the retention prune
 * announce nothing.
 */
export function publishPlanUpdate(update: {
  plan_run_id: string;
  target_id: string;
  member_id: string;
  tasks: readonly PlanTaskView[];
  occurred_at: string;
}): void {
  eventHub.publish({
    event: 'plan_update',
    data: {
      plan_run_id: update.plan_run_id,
      target_id: update.target_id,
      member_id: update.member_id,
      tasks: update.tasks,
      occurred_at: update.occurred_at,
    },
  });
}


/**
 * The frame one SOP run progress point produces (D2.5): a phase change or a
 * step / attempt change. The stream is live-only; the excerpt snapshot stays on
 * `GET /api/sop-runs/{id}` and is never replayed here.
 */
export function publishSopUpdate(update: {
  sopRunId: string;
  definitionId: string;
  phase: string;
  currentStep: number;
  attempt: number;
  occurredAt: string;
}): void {
  eventHub.publish({
    event: 'sop_update',
    data: {
      sop_run_id: update.sopRunId,
      definition_id: update.definitionId,
      phase: update.phase,
      current_step: update.currentStep,
      attempt: update.attempt,
      occurred_at: update.occurredAt,
    },
  });
}

/**
 * The frame an approval batch produces (D2.5). `tool_call_ids` names only the
 * calls this frame is about: a reopened batch publishes the new calls, not the
 * history. The payload carries no tool arguments, so no masked / raw parameter
 * can leak through it.
 */
export function publishApprovalRequested(payload: ApprovalSsePayload): void {
  eventHub.publish({ event: 'approval.requested', data: { ...payload } });
}

/** The frame a batch closure produces: confirmed / denied / failed / expired. */
export function publishApprovalResolved(payload: ApprovalSsePayload): void {
  eventHub.publish({ event: 'approval.resolved', data: { ...payload } });
}

export interface ApprovalSsePayload {
  reply_id: string;
  context_kind: string;
  context_id: string | null;
  target_id: string | null;
  status: string;
  tool_call_ids: string[];
}

/**
 * The frame a status point transition produces. `status` is the transition the
 * writer just committed (working / online / error / offline); the reading that
 * carries reasons and config stays `GET /api/workspace`, so this frame only
 * tells a subscriber that the point moved.
 */
export function publishMemberStatus(change: {
  memberId: string;
  status: string;
}): void {
  eventHub.publish({
    event: 'member.status',
    data: { member_id: change.memberId, status: change.status },
  });
}

/** The frame a task row change produces; `target_id` is the task thread. */
export function publishTaskChanged(change: {
  taskId: string;
  targetId: string;
  status: string;
}): void {
  eventHub.publish({
    event: 'task.changed',
    data: { task_id: change.taskId, target_id: change.targetId, status: change.status },
  });
}

/**
 * The frame a workspace-reading change produces. It names only the write
 * surface that changed; subscribers re-read `GET /api/workspace` rather than
 * assembling a reading from frames.
 */
export function publishWorkspaceChanged(change: {
  source: 'channel' | 'dm' | 'settings' | 'agent' | 'team';
}): void {
  eventHub.publish({
    event: 'workspace.changed',
    data: { source: change.source },
  });
}

/** How long one connection lives before the server rotates it (30 minutes). */
export const DEFAULT_SSE_LIFETIME_MS = 30 * 60 * 1000;

