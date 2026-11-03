import {
  t,
  type ChannelConfigPatch,
  type Locale,
  type PlanRunView,
  type SopDefinitionCreate,
  type SopDefinitionView,
  type SopRunView,
  type TargetMemberView,
  type TeamRunView,
  type WorkspaceView,
} from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import { workspaceStatusCopy } from './channel-config.ts';
import { ChannelConfigPanel } from './ChannelConfigPanel.ts';
import { PlanPanel } from './PlanPanel.ts';
import { SopPanel } from './SopPanel.ts';
import { TeamRunsPanel } from './TeamRunsPanel.ts';
import { readChannel, readTargetContext, type TargetKind } from './model.ts';
import type { WorkspacePanel } from './shell-state.ts';
import { taskStatusLabel } from './status-label.ts';

export interface ContextPanelProps {
  workspace: WorkspaceView;
  targetId: string | null;
  locale: Locale;
  /**
   * The selected target's member table (any target kind); the leader control
   * and the target-context workspace_status read it.
   */
  channelMembers?: readonly TargetMemberView[];
  /** The team-config write; mode and leader both use the one channel PATCH. */
  onChannelConfigChange?: (patch: ChannelConfigPatch) => void | Promise<void>;
  /** The selected target's run snapshot, when the shell has read it. */
  teamRuns?: readonly TeamRunView[];
  /** The selected target's Plan reading, when the shell has read it. */
  plans?: readonly PlanRunView[];
  /** The selected channel's SOP definitions, when the shell has read them. */
  sopDefinitions?: readonly SopDefinitionView[];
  /** The SOP run snapshots, keyed by definition id. */
  sopRuns?: Readonly<Record<string, readonly SopRunView[]>>;
  /** The owner's SOP writes; both go through the host, never this panel. */
  onCreateSop?: (input: SopDefinitionCreate) => void | Promise<void>;
  onStartSop?: (definitionId: string) => void | Promise<void>;
  onOpenPanel?: (panel: WorkspacePanel) => void;
}

function kindLabel(locale: Locale, kind: TargetKind): string {
  switch (kind) {
    case 'channel':
      return t(locale, 'workspace.context.kind.channel');
    case 'dm':
      return t(locale, 'workspace.context.kind.dm');
    case 'task':
      return t(locale, 'workspace.context.kind.task');
  }
}

/**
 * 右侧的成员与上下文面：当前 target 的名称、类型、未读与描述全部来自
 * `GET /api/workspace` 的同一份读数。成员面板 / 名册 / Agent 详情的具体内容
 * 由后续票补齐，这里只接好入口；打开任一面都不改变 target，也不写消息。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function ContextPanel({
  workspace,
  targetId,
  locale,
  channelMembers,
  onChannelConfigChange,
  teamRuns,
  plans,
  sopDefinitions,
  sopRuns,
  onCreateSop,
  onStartSop,
  onOpenPanel,
}: ContextPanelProps) {
  const context = readTargetContext(workspace, targetId);
  const channel = readChannel(workspace, targetId);
  const selectedTask =
    context?.kind === 'task'
      ? workspace.tasks.find((task) => task.target_id === context.targetId)
      : undefined;
  const showsTeamRuns = channel?.mode === 'team' || selectedTask?.channel_mode === 'team';
  // Plan tools are available on every task target and on a team target; a DM
  // and an autonomous channel round have none (D4.1).
  const showsPlan = context?.kind === 'task' || channel?.mode === 'team';
  // The channel's own workspace is the owner's effective reading; a target
  // context is unavailable when any member's effective backend/root is. Show
  // the first unavailable member so an Agent's docker override is visible,
  // while the channel config area keeps the channel-level (owner) status.
  const ownerWorkspaceStatus =
    channelMembers?.find((member) => member.kind === 'owner')?.workspace_status ??
    channelMembers?.[0]?.workspace_status;
  const targetWorkspaceStatus =
    channelMembers?.find((member) => !member.workspace_status.available)?.workspace_status ??
    ownerWorkspaceStatus;

  function panelButton(panel: WorkspacePanel, label: string): ReactNode {
    return createElement(
      'button',
      {
        key: panel,
        type: 'button',
        className: 'context-panel__entry',
        'data-action': 'open-panel',
        'data-panel': panel,
        onClick: () => onOpenPanel?.(panel),
      },
      label,
    );
  }

  return createElement(
    'section',
    { className: 'context-panel', 'aria-label': t(locale, 'workspace.context.title') },
    createElement('h2', { className: 'context-panel__title' }, t(locale, 'workspace.context.title')),
    context === null
      ? createElement(
          'p',
          { className: 'context-panel__empty' },
          t(locale, 'workspace.context.empty'),
        )
      : createElement(
          'div',
          { className: 'context-panel__body', 'data-target-id': context.targetId },
          createElement(
            'p',
            { className: 'context-panel__target' },
            createElement('strong', { className: 'context-panel__label' }, context.label),
            createElement(
              'span',
              { className: 'context-panel__kind', 'data-target-kind': context.kind },
              kindLabel(locale, context.kind),
            ),
          ),
          createElement(
            'p',
            {
              className: 'context-panel__workspace',
              'data-workspace-status':
                targetWorkspaceStatus === undefined
                  ? 'loading'
                  : targetWorkspaceStatus.available
                    ? 'available'
                    : 'unavailable',
              'data-workspace-reason': targetWorkspaceStatus?.reason ?? '',
            },
            targetWorkspaceStatus === undefined
              ? t(locale, 'workspace.status.loading')
              : t(locale, 'workspace.status.line', {
                  status: workspaceStatusCopy(locale, targetWorkspaceStatus),
                }),
          ),
          context.unread > 0
            ? createElement(
                'p',
                { className: 'context-panel__unread' },
                t(locale, 'workspace.nav.unread', { count: context.unread }),
              )
            : null,
          context.description === null
            ? null
            : createElement('p', { className: 'context-panel__description' }, context.description),
          // 频道配置区只属于频道：DM / 任务线程没有 mode 控件。
          channel === null
            ? null
            : createElement(ChannelConfigPanel, {
                channel,
                members: channelMembers,
                workspaceStatus: ownerWorkspaceStatus,
                locale,
                onTeamConfigChange: onChannelConfigChange,
              }),
          context.taskStatus === null
            ? null
            : createElement(
                'p',
                { className: 'context-panel__status', 'data-task-status': context.taskStatus },
                taskStatusLabel(locale, context.taskStatus),
              ),
          showsTeamRuns
            ? createElement(TeamRunsPanel, {
                runs: teamRuns ?? [],
                locale,
                tasks: workspace.tasks,
                channels: workspace.channels,
              })
            : null,
          channel === null
            ? null
            : createElement(SopPanel, {
                channel,
                definitions: sopDefinitions ?? [],
                runsByDefinition: sopRuns,
                members: channelMembers,
                locale,
                onCreate: onCreateSop,
                onStart: onStartSop,
              }),
          showsPlan
            ? createElement(PlanPanel, {
                plans: plans ?? [],
                locale,
                agents: workspace.agents,
              })
            : null,
          createElement(
            'div',
            { className: 'context-panel__entries' },
            // 成员面板与名册只属于频道（R1 词条 76 / 77）；私信与任务线程
            // 不提供这两个入口。
            context.kind === 'channel'
              ? [
                  panelButton('members', t(locale, 'workspace.panel.members')),
                  panelButton('roster', t(locale, 'workspace.panel.roster')),
                ]
              : null,
            panelButton('agent-detail', t(locale, 'workspace.panel.agentDetail')),
            panelButton('task-board', t(locale, 'workspace.panel.taskBoard')),
          ),
        ),
  );
}
