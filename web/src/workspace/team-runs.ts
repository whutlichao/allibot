import {
  t,
  type Locale,
  type TeamAssignmentFrame,
  type TeamAssignmentState,
  type TeamRunStatus,
  type TeamRunView,
  type WorkspaceView,
} from '@allibot/shared';

/**
 * 运行记录 (#38 / D3.3) 的呈现层读取：run 快照来自
 * `GET /api/targets/{id}/team-runs`，不是消息、不进未读与搜索。这里只有
 * 「读一次」与「状态怎么显示」两个纯函数，工作台不会把 run 拼成消息。
 */

/** One page of the target's run snapshot; `before` is the run id cursor. */
export async function readTeamRuns(
  fetchImpl: typeof fetch,
  targetId: string,
  options: { limit?: number; before?: string } = {},
): Promise<TeamRunView[]> {
  const limit = options.limit ?? 20;
  const params = new URLSearchParams({ limit: String(limit) });
  if (options.before !== undefined) {
    params.set('before', options.before);
  }
  const response = await fetchImpl(
    `/api/targets/${encodeURIComponent(targetId)}/team-runs?${params.toString()}`,
  );
  if (!response.ok) {
    throw new Error(`GET target ${targetId} team runs failed with ${response.status}`);
  }
  const body = (await response.json()) as { team_runs?: TeamRunView[] };
  return body.team_runs ?? [];
}

export function teamRunStatusLabel(locale: Locale, status: TeamRunStatus): string {
  switch (status) {
    case 'running':
      return t(locale, 'workspace.teamRuns.status.running');
    case 'completed':
      return t(locale, 'workspace.teamRuns.status.completed');
    case 'failed':
      return t(locale, 'workspace.teamRuns.status.failed');
    case 'invalid-leader':
      return t(locale, 'workspace.teamRuns.status.invalidLeader');
  }
}

/**
 * Whether the selected target is in a team topology. A task target resolves the
 * mode through its channel (D3.1); a DM never has a run panel.
 */
export function isTeamTarget(workspace: WorkspaceView, targetId: string | null): boolean {
  if (targetId === null) {
    return false;
  }
  const channel = workspace.channels.find((row) => row.id === targetId);
  if (channel !== undefined) {
    return channel.mode === 'team';
  }
  return workspace.tasks.some(
    (task) => task.target_id === targetId && task.channel_mode === 'team',
  );
}

/** The readable state of one assignment in the run panel (D2.5 / D3.3). */
export function teamAssignmentStateLabel(locale: Locale, state: TeamAssignmentState): string {
  switch (state) {
    case 'running':
      return t(locale, 'workspace.teamRuns.assignments.state.running');
    case 'completed':
      return t(locale, 'workspace.teamRuns.assignments.state.completed');
    case 'failed':
      return t(locale, 'workspace.teamRuns.assignments.state.failed');
    case 'budget-exhausted':
      return t(locale, 'workspace.teamRuns.assignments.state.budgetExhausted');
  }
}

const ASSIGNMENT_STATES: readonly string[] = [
  'running',
  'completed',
  'failed',
  'budget-exhausted',
];

/**
 * Narrow one `team_assignment` SSE payload. The backend publishes only final
 * states; the panel still accepts every declared state so a snapshot and a
 * frame speak one vocabulary. A malformed frame is ignored rather than
 * trusted.
 */
export function readTeamAssignmentFrame(
  data: Record<string, unknown>,
): TeamAssignmentFrame | null {
  const teamRunId = data['team_run_id'];
  const assignmentId = data['assignment_id'];
  const targetId = data['target_id'];
  const taskId = data['task_id'];
  const memberId = data['member_id'];
  const state = data['state'];
  const jump = data['jump_consumed'];
  const excerpt = data['reply_excerpt'];
  const reason = data['reason'];
  const occurredAt = data['occurred_at'];
  if (
    typeof teamRunId !== 'string' ||
    typeof assignmentId !== 'string' ||
    typeof targetId !== 'string' ||
    (taskId !== null && typeof taskId !== 'string') ||
    typeof memberId !== 'string' ||
    typeof state !== 'string' ||
    !ASSIGNMENT_STATES.includes(state) ||
    (jump !== 0 && jump !== 1) ||
    (excerpt !== null && typeof excerpt !== 'string') ||
    (reason !== null && typeof reason !== 'string') ||
    typeof occurredAt !== 'string'
  ) {
    return null;
  }
  return {
    team_run_id: teamRunId,
    assignment_id: assignmentId,
    target_id: targetId,
    task_id: taskId,
    member_id: memberId,
    state: state as TeamAssignmentState,
    jump_consumed: jump,
    reply_excerpt: excerpt,
    reason,
    occurred_at: occurredAt,
  };
}

/**
 * Apply one live assignment frame to the already-read run snapshots: the
 * matching nested assignment takes the final state / excerpt / reason. A frame
 * whose run or assignment is not in the current page changes nothing; the
 * shell re-reads that target's snapshot for rows it has not loaded yet.
 * Assignments never become messages, so no chat state is touched here.
 */
export function applyTeamAssignmentFrame(
  runsByTarget: Record<string, readonly TeamRunView[]>,
  frame: TeamAssignmentFrame,
): Record<string, readonly TeamRunView[]> {
  const runs = runsByTarget[frame.target_id];
  if (runs === undefined) {
    return runsByTarget;
  }
  let changed = false;
  const nextRuns = runs.map((run) => {
    if (run.id !== frame.team_run_id) {
      return run;
    }
    let assignmentChanged = false;
    const assignments = run.assignments.map((row) => {
      if (row.id !== frame.assignment_id) {
        return row;
      }
      assignmentChanged = true;
      return {
        ...row,
        state: frame.state,
        jump_consumed: frame.jump_consumed,
        reply_excerpt: frame.reply_excerpt,
        reason: frame.reason,
        finished_at: frame.occurred_at,
      };
    });
    if (!assignmentChanged) {
      return run;
    }
    changed = true;
    return { ...run, assignments };
  });
  return changed ? { ...runsByTarget, [frame.target_id]: nextRuns } : runsByTarget;
}
