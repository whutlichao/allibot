import type {
  ChannelConfigPatch,
  ChannelMode,
  ChannelView,
  TargetMemberView,
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
