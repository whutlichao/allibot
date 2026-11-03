import type {
  AgentStatus,
  AgentView,
  OfflineReason,
  TargetMemberView,
  WorkspaceView,
} from '@allibot/shared';

/**
 * 成员面板 / 成员名册的呈现读数。两个名单的范围不同（R1 词条 76 / 77 / 78）：
 *
 * - 本机 Agent：`GET /api/workspace` 的 `agents`，全工作区、不按频道过滤；
 * - 成员面板：当前频道的成员表（`GET /api/channels/{id}/members`）分成
 *   「已加入（频道里的 Agent）」与「未加入（本机 Agent 里尚未加入的）」；
 * - 成员名册：当前频道的只读全名单，含 owner 与各 Agent。
 *
 * 软删除的 Agent 来自 `GET /api/channels/{id}/members` 的历史行时必须被
 * 过滤掉：成员是否有身份由工作台读数里的本机 Agent 名单裁决，而不是由
 * 一张可能过期的成员表裁决。历史消息不受这里影响——消息行自带作者快照。
 */

export interface MemberRowView {
  id: string;
  displayName: string;
  avatarSlot: number;
  /** 状态点；owner 没有状态点，因此为 null。 */
  status: AgentStatus | null;
  offlineReason: OfflineReason | null;
  model: string | null;
}

export interface MemberPanelView {
  joined: MemberRowView[];
  notJoined: MemberRowView[];
}

function agentRow(agent: AgentView): MemberRowView {
  return {
    id: agent.id,
    displayName: agent.display_name,
    avatarSlot: agent.avatar_slot,
    status: agent.status,
    offlineReason: agent.offline_reason,
    model: agent.model,
  };
}

function liveAgent(workspace: WorkspaceView, memberId: string): AgentView | undefined {
  return workspace.agents.find((agent) => agent.id === memberId && agent.deleted_at === null);
}

/** 频道成员表 → 已加入 / 未加入两段；owner 不属于任一 Agent 段。 */
export function readMemberPanel(
  workspace: WorkspaceView,
  members: readonly TargetMemberView[],
): MemberPanelView {
  const joined: MemberRowView[] = [];
  const seen = new Set<string>();
  for (const member of members) {
    if (member.kind !== 'agent' || seen.has(member.id)) {
      continue;
    }
    const agent = liveAgent(workspace, member.id);
    if (agent === undefined) {
      continue;
    }
    joined.push(agentRow(agent));
    seen.add(agent.id);
  }

  const notJoined = workspace.agents
    .filter((agent) => agent.deleted_at === null && !seen.has(agent.id))
    .map(agentRow);

  return { joined, notJoined };
}

/** 频道成员的只读全名单：owner 第一，随后是仍存在的 Agent 成员。 */
export function readMemberRoster(
  workspace: WorkspaceView,
  members: readonly TargetMemberView[],
): MemberRowView[] {
  const rows: MemberRowView[] = [
    {
      id: workspace.owner.id,
      displayName: workspace.owner.display_name,
      avatarSlot: workspace.owner.avatar_slot,
      status: null,
      offlineReason: null,
      model: null,
    },
  ];
  const seen = new Set<string>([workspace.owner.id]);
  for (const member of members) {
    if (member.kind !== 'agent' || seen.has(member.id)) {
      continue;
    }
    const agent = liveAgent(workspace, member.id);
    if (agent === undefined) {
      continue;
    }
    rows.push(agentRow(agent));
    seen.add(agent.id);
  }
  return rows;
}

export interface MemberNoticeView {
  offline: number;
  error: number;
}

/**
 * 消息流上的「失败 / 未启用」提示读数：只看当前频道已加入的 Agent。
 * 没有失败或未启用的成员时返回 null，壳不渲染提示。
 */
export function readMemberNotice(
  workspace: WorkspaceView,
  members: readonly TargetMemberView[],
): MemberNoticeView | null {
  const { joined } = readMemberPanel(workspace, members);
  const offline = joined.filter((row) => row.status === 'offline').length;
  const error = joined.filter((row) => row.status === 'error').length;
  if (offline === 0 && error === 0) {
    return null;
  }
  return { offline, error };
}

export interface ChannelJoinOutcome {
  members: TargetMemberView[];
  /** 后端响应里的 `joined`：true 表示这次真的新增了一行成员关系。 */
  joined: boolean;
}

/**
 * 把一次成功的加入结果落到本地频道成员表。`joined === true` 是新增；
 * `false` 是后端幂等重复（表里本来就有，只是本地表过期了）：两种情况
 * 成员都属于「已加入」，差别只在宿主是否还需要重读成员表。
 */
export function applyJoinResult(
  members: readonly TargetMemberView[],
  agent: AgentView,
  joined: boolean,
): ChannelJoinOutcome {
  const exists = members.some((member) => member.id === agent.id);
  if (exists) {
    return { members: [...members], joined };
  }
  return {
    members: [
      ...members,
      {
        id: agent.id,
        kind: 'agent',
        display_name: agent.display_name,
        avatar_slot: agent.avatar_slot,
        // Workspace availability is a target fact; reuse the table's reading
        // rather than inventing one for the newly joined row.
        workspace_status: members[0]?.workspace_status ?? {
          backend: 'local',
          available: false,
          reason: 'workspace-root-missing',
        },
        // The channel's default is the owner row's effective mode; the new
        // Agent follows it unless it already carries an override.
        permission_mode:
          members.find((member) => member.kind === 'owner')?.permission_mode ??
          agent.permission_mode ??
          agent.effective_permission_mode,
      },
    ],
    joined,
  };
}
