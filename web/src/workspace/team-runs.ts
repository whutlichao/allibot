import {
  t,
  type Locale,
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
