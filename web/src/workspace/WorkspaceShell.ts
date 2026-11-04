import {
  t,
  type AgentMcpView,
  type AgentProvider,
  type AgentRulesView,
  type AgentSkillCandidatesView,
  type AgentSkillDetailView,
  type AgentSkillsView,
  type ApprovalDecisionInput,
  type ApprovalView,
  type ChannelConfigPatch,
  type Locale,
  type PermissionRuleInput,
  type PermissionRuleView,
  type PlanRunView,
  type RemoteDataFlowReadView,
  type SopDefinitionCreate,
  type SopDefinitionView,
  type SopRunView,
  type TargetMemberView,
  type TaskStatus,
  type TaskView,
  type TeamRunView,
  type WorkspaceSettingsView,
  type WorkspaceView,
} from '@allibot/shared';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import { createElement, useState, type ReactNode } from 'react';
import {
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
} from '../copilotkit-contract.ts';
import { SettingsPanel } from '../components/SettingsPanel.ts';
import { TaskBoard } from '../task-board/TaskBoard.ts';
import type { AsyncAction1, AsyncAction2 } from '../async-action.ts';
import { AgentDetailPanel } from './AgentDetailPanel.ts';
import { rulesChannelId } from './agent-rules.ts';
import { ApprovalPanel } from './ApprovalPanel.ts';
import type { McpSaveBody } from './mcp-tab.ts';
import { permissionScopeKey } from './permissions.ts';
import { ContextPanel } from './ContextPanel.ts';
import { MemberPanel } from './MemberPanel.ts';
import { MemberRoster } from './MemberRoster.ts';
import { readMemberNotice } from './member-reading.ts';
import { initialTargetId, readTargetContext, targetKind } from './model.ts';
import { WorkspaceChatArea, LiveEventContext, type LiveEventSink } from './WorkspaceChat.ts';
import {
  closeDrawer,
  openNavigation,
  openWorkspacePanel,
  resolveWorkspaceLayout,
  type WorkspaceDrawer,
  type WorkspacePanel,
} from './shell-state.ts';
import { TargetNav } from './TargetNav.ts';

/** The default test / desktop width; the browser shell passes `innerWidth`. */
const DEFAULT_VIEWPORT_WIDTH = 1280;

export interface WorkspaceShellProps {
  workspace: WorkspaceView;
  settings: WorkspaceSettingsView;
  /** Selected target; omitted means the first target of the reading. */
  activeTargetId?: string | null;
  /** The drawer a render starts on (tests and deep links); default closed. */
  initialDrawer?: WorkspaceDrawer | null;
  /** The Agent the detail drawer starts on; omitted means the first local Agent. */
  initialAgentId?: string | null;
  /**
   * The selected target's member tables, keyed by target id. The member panel
   * and roster are channel-scoped; the context panel also reads the table's
   * workspace_status for task / DM contexts. An absent table states that it is
   * still loading rather than guessing membership or availability.
   */
  channelMembers?: Record<string, readonly TargetMemberView[]>;
  /** Team run snapshots, keyed by target id; the run panel reads them. */
  teamRuns?: Record<string, readonly TeamRunView[]>;
  /** Plan snapshots, keyed by target id; the run panel reads them. */
  plans?: Record<string, readonly PlanRunView[]>;
  /** The approval list reading (#44); undefined while it is loading. */
  approvals?: readonly ApprovalView[];
  /** Permission rule sets, keyed by `permissionScopeKey`. */
  permissionRules?: Readonly<Record<string, readonly PermissionRuleView[]>>;
  /** SOP definitions, keyed by channel id; the channel context panel reads them. */
  sopDefinitions?: Record<string, readonly SopDefinitionView[]>;
  /** SOP run snapshots, keyed by definition id. */
  sopRuns?: Record<string, readonly SopRunView[]>;
  /** Agent-home mcp.json readings, keyed by Agent id. */
  agentMcp?: Record<string, AgentMcpView>;
  /** `GET /api/remote-data-flow`: provider credential variables and consent. */
  remoteDataFlow?: RemoteDataFlowReadView;
  /** The one-time provider consent write; absent = no confirmation entry. */
  onConfirmProviderConsent?: (provider: AgentProvider) => void | Promise<void>;
  /** Read the Agent's mcp.json when the detail opens; the host fetches. */
  onAgentMcpNeeded?: (agentId: string) => void;
  /** The one mcp.json write shared by the structured form and raw textarea. */
  onAgentMcpChange?: (agentId: string, body: McpSaveBody) => void | Promise<AgentMcpView | void>;
  /** Effective rules per Agent id, read on demand when the detail opens. */
  agentRules?: Record<string, AgentRulesView>;
  /** Installed skills per Agent id (#48); read when the detail opens. */
  agentSkills?: Record<string, AgentSkillsView>;
  /** The selected skill detail (metadata + SKILL.md) per Agent id. */
  agentSkillDetails?: Record<string, AgentSkillDetailView>;
  /** `~/.agents/skills/` candidates per Agent id; the host reads them. */
  agentSkillCandidates?: Record<string, AgentSkillCandidatesView>;
  /** Read the list + candidates when the Agent detail opens. */
  onAgentSkillsNeeded?: (agentId: string) => void;
  /** Read one skill's metadata + SKILL.md when it is selected. */
  onAgentSkillNeeded?: (agentId: string, name: string) => void;
  /** Re-scan the landing directory. */
  onAgentSkillRefreshCandidates?: (agentId: string) => void | Promise<void>;
  /** Import one candidate through the single-entry install path. */
  onAgentSkillImport?: (agentId: string, name: string) => void | Promise<void>;
  /** Import every importable, not-installed candidate. */
  onAgentSkillsImportAll?: (agentId: string) => void | Promise<void>;
  /** Enable / disable one installed skill. */
  onAgentSkillToggle?: (agentId: string, name: string, enabled: boolean) => void | Promise<void>;
  /** Delete one installed skill (bytes and row). */
  onAgentSkillDelete?: (agentId: string, name: string) => void | Promise<void>;
  viewportWidth?: number;
  onSelectTarget?: (targetId: string) => void;
  /** The task board's write entry; the board itself never changes a task row. */
  onTaskTransition?: (task: TaskView, status: TaskStatus) => boolean | Promise<boolean>;
  onSettingsChange?: (patch: Partial<WorkspaceSettingsView>) => void;
  /** Join an Agent into the channel; resolves after the host updated its reading. */
  onJoinMember?: AsyncAction2<string, string>;
  /** Save the Agent's system prompt; resolves after the host re-read the Agent. */
  onSaveAgent?: AsyncAction2<string, { system_prompt: string }>;
  /** Read the channel's team config change; resolves after the host re-read it. */
  onChannelConfigChange?: AsyncAction2<string, ChannelConfigPatch>;
  /** Create / start a SOP; the host writes and re-reads, the panel only displays. */
  onCreateSop?: (input: SopDefinitionCreate) => void | Promise<void>;
  onStartSop?: (definitionId: string) => void | Promise<void>;
  /** Soft delete the Agent; resolves after the host re-read the workspace. */
  onDeleteAgent?: AsyncAction1<string>;
  /** One approval decision (approve / deny); the host re-reads the list. */
  onApprovalDecision?: (replyId: string, input: ApprovalDecisionInput) => void | Promise<void>;
  /** The full-replacement permission rule write for a channel / Agent scope. */
  onPermissionRulesChange?: (
    scope: { kind: 'channel' | 'agent'; id: string },
    rules: PermissionRuleInput[],
  ) => void | Promise<void>;
  /** The raw Agent permission-mode override write (null = follow). */
  onAgentPermissionModeChange?: (agentId: string, mode: string | null) => void | Promise<void>;
  onAgentWorkspaceBackendChange?: (
    agentId: string,
    backend: string | null,
  ) => void | Promise<void>;
  /** Read the Agent's effective rules for the open detail; the host fetches. */
  onAgentRulesNeeded?: (agentId: string, channelId: string | null) => void;
  saveFailed?: boolean;
  onLiveEvent?: LiveEventSink;
}

function drawerTitle(locale: Locale, drawer: WorkspaceDrawer): string {
  switch (drawer) {
    case 'navigation':
      return t(locale, 'workspace.nav.title');
    case 'context':
      return t(locale, 'workspace.context.title');
    case 'task-board':
      return t(locale, 'workspace.panel.taskBoard');
    case 'members':
      return t(locale, 'workspace.panel.members');
    case 'roster':
      return t(locale, 'workspace.panel.roster');
    case 'agent-detail':
      return t(locale, 'workspace.panel.agentDetail');
    case 'approvals':
      return t(locale, 'workspace.approval.title');
  }
}

/**
 * 单一 React 工作台壳（ADR 0002）：
 *
 * - 主区恒为 `CopilotChat`，`agentId` 固定 `allibot`，`threadId` 是当前 target id；
 * - 左侧 `TargetNav` 从 `GET /api/workspace` 列出频道 / 私信 / 任务 / 本机 Agent；
 * - 右侧上下文与任务看板 / 成员面板 / 名册 / Agent 详情走抽屉；
 * - 宽屏只 dock 左侧导航，窄屏把导航移入抽屉，导航始终可达；
 * - 抽屉与导航都是呈现层：不改变 target、不写消息、不唤醒、不消耗预算。
 *
 * 成员面板 / 名册只属于频道（R1 词条 76 / 77）；Agent 详情页签是同一详情面的
 * 三个分组（词条 75），打开与切换都不改 URL、不重新拉取整页。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function WorkspaceShell({
  workspace,
  settings,
  activeTargetId,
  initialDrawer = null,
  initialAgentId = null,
  channelMembers,
  viewportWidth = DEFAULT_VIEWPORT_WIDTH,
  onSelectTarget,
  onTaskTransition,
  onSettingsChange,
  onJoinMember,
  onSaveAgent,
  onDeleteAgent,
  onChannelConfigChange,
  teamRuns,
  plans,
  approvals,
  permissionRules,
  sopDefinitions,
  sopRuns,
  onCreateSop,
  onStartSop,
  onApprovalDecision,
  onPermissionRulesChange,
  onAgentPermissionModeChange,
  onAgentWorkspaceBackendChange,
  agentRules,
  onAgentRulesNeeded,
  agentMcp,
  remoteDataFlow,
  onConfirmProviderConsent,
  onAgentMcpNeeded,
  onAgentMcpChange,
  agentSkills,
  agentSkillDetails,
  agentSkillCandidates,
  onAgentSkillsNeeded,
  onAgentSkillNeeded,
  onAgentSkillRefreshCandidates,
  onAgentSkillImport,
  onAgentSkillsImportAll,
  onAgentSkillToggle,
  onAgentSkillDelete,
  saveFailed = false,
  onLiveEvent,
}: WorkspaceShellProps) {
  const locale = settings.locale;
  const [drawer, setDrawer] = useState<WorkspaceDrawer | null>(initialDrawer);
  const [approvalReplyId, setApprovalReplyId] = useState<string | null>(null);
  const [detailAgentId, setDetailAgentId] = useState<string | null>(initialAgentId);
  const layout = resolveWorkspaceLayout(viewportWidth);
  const selectedTargetId =
    activeTargetId !== undefined ? activeTargetId : initialTargetId(workspace);
  const context = readTargetContext(workspace, selectedTargetId);
  const selectedKind =
    selectedTargetId === null ? null : targetKind(workspace, selectedTargetId);
  const channelSelected = selectedKind === 'channel';
  // 已归档私信：对方的 Agent 被软删除后，历史仍可读，但 composer 与发送入口
  // 一并禁用（票 #22），不把 400 留给用户输入之后。
  const selectedDm =
    selectedKind === 'dm' && selectedTargetId !== null
      ? workspace.dms.find((dm) => dm.id === selectedTargetId)
      : undefined;
  const archivedDm = selectedDm !== undefined && selectedDm.peer.deleted_at !== null;
  // The target's member table also carries workspace_status for a task / DM
  // context; only the channel-scoped panels are gated by `channelSelected`.
  const selectedMembers =
    selectedTargetId !== null ? channelMembers?.[selectedTargetId] : undefined;
  const selectedAgent =
    detailAgentId === null
      ? (workspace.agents[0] ?? null)
      : (workspace.agents.find((agent) => agent.id === detailAgentId) ?? null);

  function selectTarget(targetId: string): void {
    setDrawer(null);
    onSelectTarget?.(targetId);
  }

  function openPanel(panel: WorkspacePanel, agentId?: string): void {
    if (panel === 'agent-detail' && agentId !== undefined) {
      setDetailAgentId(agentId);
      // The rules are a separate read (D2.3); opening the detail asks the host
      // for them instead of fabricating sections from the workspace snapshot.
      onAgentRulesNeeded?.(
        agentId,
        rulesChannelId(workspace, selectedTargetId),
      );
      onAgentMcpNeeded?.(agentId);
      onAgentSkillsNeeded?.(agentId);
    }
    setDrawer(openWorkspacePanel({ activeTargetId: selectedTargetId, drawer }, panel).drawer);
  }

  const notice =
    channelSelected && selectedMembers !== undefined
      ? readMemberNotice(workspace, selectedMembers)
      : null;

  const navigation = createElement(
    'div',
    { className: 'workspace-navigation' },
    createElement(TargetNav, {
      workspace,
      activeTargetId: selectedTargetId,
      locale,
      onSelectTarget: selectTarget,
      onOpenPanel: openPanel,
      onOpenAgentDetail: (agentId: string) => openPanel('agent-detail', agentId),
    }),
    createElement(SettingsPanel, { settings, onChange: onSettingsChange, saveFailed }),
  );

  const dockedSidebar =
    layout.dockedSidebar === null
      ? null
      : createElement(
          'aside',
          {
            className: 'workspace-sidebar',
            'data-docked': 'true',
            'data-panel': layout.dockedSidebar,
            'aria-label': t(locale, 'workspace.nav.title'),
          },
          navigation,
        );

  const header = createElement(
    'header',
    { className: 'workspace-header' },
    layout.navigationInDrawer
      ? createElement(
          'button',
          {
            type: 'button',
            className: 'workspace-header__action',
            'data-action': 'open-navigation',
            'aria-label': t(locale, 'workspace.nav.open'),
            onClick: () =>
              setDrawer(openNavigation({ activeTargetId: selectedTargetId, drawer }).drawer),
          },
          t(locale, 'workspace.nav.open'),
        )
      : null,
    createElement(
      'span',
      { className: 'workspace-header__title' },
      context?.label ?? t(locale, 'workspace.context.empty'),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'workspace-header__action',
        'data-action': 'open-panel',
        'data-panel': 'context',
        'aria-label': t(locale, 'workspace.context.title'),
        onClick: () => openPanel('context'),
      },
      t(locale, 'workspace.context.title'),
    ),
    createElement(
      'button',
      {
        type: 'button',
        className: 'workspace-header__action workspace-header__action--approvals',
        'data-action': 'open-approvals',
        'data-pending-approvals': workspace.pending_approvals,
        'aria-label': t(locale, 'workspace.approval.open'),
        onClick: () => openPanel('approvals'),
      },
      workspace.pending_approvals > 0
        ? `${t(locale, 'workspace.approval.title')} (${workspace.pending_approvals})`
        : t(locale, 'workspace.approval.title'),
    ),
  );

  const memberNotice =
    notice === null
      ? null
      : createElement(
          'div',
          { className: 'workspace-notice', 'data-notice': 'members' },
          createElement(
            'span',
            { className: 'workspace-notice__text' },
            t(locale, 'workspace.member.notice', { count: notice.offline + notice.error }),
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'workspace-notice__action',
              'data-action': 'open-panel',
              'data-panel': 'members',
              onClick: () => openPanel('members'),
            },
            t(locale, 'workspace.member.notice.open'),
          ),
        );

  const main = createElement(
    'div',
    { className: 'workspace-main' },
    header,
    memberNotice,
    createElement(
      'div',
      { className: 'workspace-chat' },
      createElement(WorkspaceChatArea, {
        targetId: selectedTargetId,
        tasks: workspace.tasks,
        locale,
        archivedDm,
        onSelectTarget: selectTarget,
      }),
    ),
  );

  let drawerBody: ReactNode = null;
  if (drawer === 'navigation') {
    drawerBody = navigation;
  } else if (drawer === 'task-board') {
    drawerBody = createElement(TaskBoard, {
      tasks: workspace.tasks,
      channels: workspace.channels,
      locale,
      onSelectTarget: selectTarget,
      onTransition: onTaskTransition,
    });
  } else if (drawer === 'context') {
    drawerBody = createElement(ContextPanel, {
      workspace,
      targetId: selectedTargetId,
      locale,
      channelMembers: selectedMembers,
      onChannelConfigChange:
        selectedTargetId === null || onChannelConfigChange === undefined
          ? undefined
          : (patch: ChannelConfigPatch) => onChannelConfigChange(selectedTargetId, patch),
      teamRuns: selectedTargetId === null ? undefined : teamRuns?.[selectedTargetId],
      plans: selectedTargetId === null ? undefined : plans?.[selectedTargetId],
      sopDefinitions:
        selectedTargetId === null ? undefined : sopDefinitions?.[selectedTargetId],
      sopRuns,
      permissionRules:
        selectedTargetId === null || selectedKind !== 'channel'
          ? undefined
          : permissionRules?.[
              permissionScopeKey({ kind: 'channel', id: selectedTargetId })
            ],
      onPermissionRulesChange:
        selectedTargetId === null ||
        selectedKind !== 'channel' ||
        onPermissionRulesChange === undefined
          ? undefined
          : (rules) =>
              onPermissionRulesChange(
                { kind: 'channel', id: selectedTargetId },
                rules,
              ),
      onCreateSop,
      onStartSop,
      onOpenPanel: openPanel,
    });
  } else if (drawer === 'members') {
    drawerBody = channelSelected
      ? createElement(MemberPanel, {
          key: selectedTargetId ?? 'members',
          workspace,
          members: selectedMembers,
          locale,
          remoteDataFlow,
          onOpenAgentDetail: (memberId: string) => openPanel('agent-detail', memberId),
          onJoin:
            selectedTargetId === null || onJoinMember === undefined
              ? undefined
              : (memberId: string) => onJoinMember(selectedTargetId, memberId),
        })
      : createElement(
          'p',
          { className: 'workspace-panel__pending' },
          t(locale, 'workspace.member.channelOnly'),
        );
  } else if (drawer === 'roster') {
    drawerBody = channelSelected
      ? createElement(MemberRoster, { workspace, members: selectedMembers, locale })
      : createElement(
          'p',
          { className: 'workspace-panel__pending' },
          t(locale, 'workspace.roster.channelOnly'),
        );
  } else if (drawer === 'agent-detail') {
    drawerBody =
      selectedAgent === null
        ? createElement(
            'p',
            { className: 'workspace-panel__pending' },
            t(locale, 'workspace.agentDetail.missing'),
          )
        : createElement(AgentDetailPanel, {
            key: selectedAgent.id,
            agent: selectedAgent,
            locale,
            rules: agentRules?.[selectedAgent.id] ?? null,
            remoteDataFlow,
            onConfirmConsent: onConfirmProviderConsent,
            mcp: agentMcp?.[selectedAgent.id] ?? null,
            onMcpChange:
              onAgentMcpChange === undefined
                ? undefined
                : (body) => onAgentMcpChange(selectedAgent.id, body),
            skills: {
              view: agentSkills?.[selectedAgent.id] ?? null,
              detail: agentSkillDetails?.[selectedAgent.id] ?? null,
              candidates: agentSkillCandidates?.[selectedAgent.id] ?? null,
              onSelect:
                onAgentSkillNeeded === undefined
                  ? undefined
                  : (name) => onAgentSkillNeeded(selectedAgent.id, name),
              onRefreshCandidates:
                onAgentSkillRefreshCandidates === undefined
                  ? undefined
                  : () => onAgentSkillRefreshCandidates(selectedAgent.id),
              onImport:
                onAgentSkillImport === undefined
                  ? undefined
                  : (name) => onAgentSkillImport(selectedAgent.id, name),
              onImportAll:
                onAgentSkillsImportAll === undefined
                  ? undefined
                  : () => onAgentSkillsImportAll(selectedAgent.id),
              onToggleEnabled:
                onAgentSkillToggle === undefined
                  ? undefined
                  : (name, enabled) => onAgentSkillToggle(selectedAgent.id, name, enabled),
              onDelete:
                onAgentSkillDelete === undefined
                  ? undefined
                  : (name) => onAgentSkillDelete(selectedAgent.id, name),
            },
            onSave:
              onSaveAgent === undefined
                ? undefined
                : (patch: { system_prompt: string }) => onSaveAgent(selectedAgent.id, patch),
            onDelete:
              onDeleteAgent === undefined ? undefined : () => onDeleteAgent(selectedAgent.id),
            permissionRules:
              permissionRules?.[
                permissionScopeKey({ kind: 'agent', id: selectedAgent.id })
              ],
            onPermissionRulesChange:
              onPermissionRulesChange === undefined
                ? undefined
                : (rules) =>
                    onPermissionRulesChange({ kind: 'agent', id: selectedAgent.id }, rules),
            onPermissionModeChange:
              onAgentPermissionModeChange === undefined
                ? undefined
                : (mode) => onAgentPermissionModeChange(selectedAgent.id, mode),
            onWorkspaceBackendChange:
              onAgentWorkspaceBackendChange === undefined
                ? undefined
                : (backend) => onAgentWorkspaceBackendChange(selectedAgent.id, backend),
          });
  } else if (drawer === 'approvals') {
    drawerBody = createElement(ApprovalPanel, {
      approvals,
      selectedReplyId: approvalReplyId,
      locale,
      onSelect: setApprovalReplyId,
      onDecision:
        onApprovalDecision === undefined
          ? undefined
          : (replyId, input) => onApprovalDecision(replyId, input),
    });
  } else if (drawer !== null) {
    drawerBody = createElement(
      'div',
      { className: 'workspace-panel', 'data-panel': drawer },
      createElement('h2', { className: 'workspace-panel__title' }, drawerTitle(locale, drawer)),
      createElement(
        'p',
        { className: 'workspace-panel__pending' },
        t(locale, 'workspace.panel.pending'),
      ),
    );
  }

  const drawerElement =
    drawer === null
      ? null
      : createElement(
          'aside',
          {
            className: 'workspace-drawer',
            'data-drawer': drawer,
            role: 'dialog',
            'aria-label': drawerTitle(locale, drawer),
          },
          createElement(
            'header',
            { className: 'workspace-drawer__header' },
            createElement('h2', { className: 'workspace-drawer__title' }, drawerTitle(locale, drawer)),
            createElement(
              'button',
              {
                type: 'button',
                className: 'workspace-drawer__close',
                'data-action': 'close-drawer',
                onClick: () =>
                  setDrawer(closeDrawer({ activeTargetId: selectedTargetId, drawer }).drawer),
              },
              t(locale, 'workspace.drawer.close'),
            ),
          ),
          drawerBody,
        );

  return createElement(CopilotKitProvider, {
    runtimeUrl: AGUI_RUNTIME_URL,
    useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT,
    children: createElement(
      LiveEventContext.Provider,
      { value: onLiveEvent ?? null },
      createElement(
        'div',
        {
          className: 'workspace-shell',
          'data-layout': layout.dockedSidebar === null ? 'narrow' : 'wide',
          'data-thread-id': selectedTargetId ?? '',
          'data-density': settings.density,
          'data-theme': settings.theme,
          'data-locale': locale,
        },
        dockedSidebar,
        main,
        drawerElement,
      ),
    ),
  });
}
