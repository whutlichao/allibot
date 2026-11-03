import type { AgentRuleSectionView, AgentRulesView, WorkspaceView } from '@allibot/shared';

/**
 * The read-only effective rules of one Agent (#43 / D2.3 / D5.2).
 *
 * The panel never derives rules itself: `GET /api/agents/{id}/rules` is the one
 * reading, the three sections arrive in assembly order, and the file paths /
 * statuses are the backend's. There is no write entry — `AGENTS.md` is
 * human-maintained.
 */
export async function readAgentRules(
  fetchImpl: typeof fetch,
  agentId: string,
  channelId: string | null,
): Promise<AgentRulesView> {
  const query = channelId === null ? '' : `?channel_id=${encodeURIComponent(channelId)}`;
  const response = await fetchImpl(
    `/api/agents/${encodeURIComponent(agentId)}/rules${query}`,
  );
  if (!response.ok) {
    throw new Error(`GET agent ${agentId} rules failed with ${response.status}`);
  }
  return (await response.json()) as AgentRulesView;
}

/**
 * The channel whose project layer supplies the supplement for a target: the
 * target itself for a channel, its owning channel for a task, and null for a
 * DM / no selected target.
 */
export function rulesChannelId(
  workspace: WorkspaceView,
  targetId: string | null,
): string | null {
  if (targetId === null) {
    return null;
  }
  const channel = workspace.channels.find((row) => row.id === targetId);
  if (channel !== undefined) {
    return channel.id;
  }
  const task = workspace.tasks.find((row) => row.target_id === targetId);
  return task?.channel_id ?? null;
}

/** `present` / `absent` / `unreadable` — the read status the panel renders. */
export function ruleSectionStatus(
  section: AgentRuleSectionView,
): 'present' | 'absent' | 'unreadable' {
  if (!section.present) {
    return 'absent';
  }
  return section.readable ? 'present' : 'unreadable';
}
