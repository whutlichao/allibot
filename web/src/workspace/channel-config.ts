import {
  t,
  type ChannelConfigPatch,
  type ChannelMode,
  type ChannelView,
  type Locale,
  type TargetMemberView,
  type WorkspaceBackend,
  type WorkspaceStatusView,
} from '@allibot/shared';

/**
 * 频道 team 配置的呈现层推导（#37 / D3.1）。这里是纯函数：从后端读数与频道
 * 成员表算出「这个控件该发什么 PATCH」。mode 与 leader 共用同一个 patch 形状，
 * 宿主的写路径因此只走一个 `PATCH /api/channels/{id}`。
 */

/** The leader candidates: the channel's Agent members, never the owner. */
export function leaderCandidates(
  members: readonly TargetMemberView[] | undefined,
): TargetMemberView[] {
  return (members ?? []).filter((member) => member.kind === 'agent');
}

/**
 * Switching the mode. Going to team needs a leader in the same write: the
 * configured one if present, else the first Agent member. `null` means the
 * control cannot perform this move (no candidate, or the value did not change).
 */
export function modeChangePatch(
  channel: ChannelView,
  mode: ChannelMode,
  members: readonly TargetMemberView[] | undefined,
): ChannelConfigPatch | null {
  if (mode === channel.mode) {
    return null;
  }
  if (mode === 'autonomous') {
    return { mode: 'autonomous' };
  }
  const leader = channel.team.leader_member_id ?? leaderCandidates(members)[0]?.id ?? null;
  if (leader === null) {
    return null;
  }
  return { mode: 'team', team_leader_member_id: leader };
}

/**
 * Switching the leader. It is only writable on a team channel, and choosing the
 * current leader is a no-op; both cases return `null` so the host sends nothing.
 */
export function leaderChangePatch(
  channel: ChannelView,
  leaderMemberId: string,
): ChannelConfigPatch | null {
  if (channel.mode !== 'team') {
    return null;
  }
  if (leaderMemberId === channel.team.leader_member_id) {
    return null;
  }
  return { team_leader_member_id: leaderMemberId };
}

/**
 * The project-root write (#42 / D5.1). The input is the owner's raw text; an
 * empty value is the explicit null that clears the root. A same-value replay
 * returns null so the host sends nothing (D2.4).
 */
export function rootChangePatch(
  channel: ChannelView,
  root: string,
): ChannelConfigPatch | null {
  const trimmed = root.trim();
  const next = trimmed.length === 0 ? null : trimmed;
  if (next === channel.workspace.root) {
    return null;
  }
  return { workspace_root: next };
}

/** The workspace-backend write; a same-value choice sends nothing. */
export function backendChangePatch(
  channel: ChannelView,
  backend: WorkspaceBackend,
): ChannelConfigPatch | null {
  if (backend === channel.workspace.backend) {
    return null;
  }
  return { workspace_backend: backend };
}

/**
 * The readable workspace status. The reason is a stable backend code; the copy
 * comes from the catalog, never from the frontend inventing a diagnosis.
 */
export function workspaceStatusCopy(locale: Locale, status: WorkspaceStatusView): string {
  if (status.available) {
    return t(locale, 'workspace.status.available');
  }
  switch (status.reason) {
    case 'workspace-root-missing':
      return t(locale, 'workspace.status.reason.workspaceRootMissing');
    case 'docker-unavailable':
      return t(locale, 'workspace.status.reason.dockerUnavailable');
    default:
      return t(locale, 'workspace.status.reason.workspaceRootMissing');
  }
}
