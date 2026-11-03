import {
  t,
  type AgentRulesView,
  type ChannelConfigPatch,
  type PlanRunView,
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
import { createElement } from 'react';
import type { AsyncAction1, AsyncAction2 } from './async-action.ts';
import { Avatar } from './components/Avatar.ts';
import { SettingsPanel } from './components/SettingsPanel.ts';
import { WorkspaceShell } from './workspace/WorkspaceShell.ts';
import type { LiveEvent } from './workspace/message-sync.ts';

export interface AppProps {
  settings: WorkspaceSettingsView;
  onSettingsChange?: (patch: Partial<WorkspaceSettingsView>) => void;
  saveFailed?: boolean;
  /** The one backend reading; when present the full workspace shell renders. */
  workspace?: WorkspaceView;
  activeTargetId?: string | null;
  viewportWidth?: number;
  /** Target member tables the shell may render, keyed by target id. */
  channelMembers?: Record<string, readonly TargetMemberView[]>;
  /** Team run snapshots the shell may render, keyed by target id. */
  teamRuns?: Record<string, readonly TeamRunView[]>;
  /** Plan snapshots the shell may render, keyed by target id. */
  plans?: Record<string, readonly PlanRunView[]>;
  /** SOP definitions, keyed by channel id. */
  sopDefinitions?: Record<string, readonly SopDefinitionView[]>;
  /** SOP run snapshots, keyed by definition id. */
  sopRuns?: Record<string, readonly SopRunView[]>;
  /** Effective rules per Agent id, keyed by Agent. */
  agentRules?: Record<string, AgentRulesView>;
  onAgentRulesNeeded?: (agentId: string, channelId: string | null) => void;
  onSelectTarget?: (targetId: string) => void;
  /** The task board's write entry; the board itself never changes a task row. */
  onTaskTransition?: (task: TaskView, status: TaskStatus) => boolean | Promise<boolean>;
  onJoinMember?: AsyncAction2<string, string>;
  onSaveAgent?: AsyncAction2<string, { system_prompt: string }>;
  onDeleteAgent?: AsyncAction1<string>;
  onChannelConfigChange?: AsyncAction2<string, ChannelConfigPatch>;
  onCreateSop?: (input: SopDefinitionCreate) => void | Promise<void>;
  onStartSop?: (definitionId: string) => void | Promise<void>;
  onLiveEvent?: (event: LiveEvent) => void;
}

/**
 * 工作台壳：有 `GET /api/workspace` 读数时渲染单一 React 工作台（主区
 * `CopilotChat`、左侧 target 导航、右侧上下文 / 抽屉）；读数不可达时退回
 * 设置面，仍然显示可读文案，而不是静默空白。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function App({
  settings,
  onSettingsChange,
  saveFailed = false,
  workspace,
  activeTargetId,
  viewportWidth,
  channelMembers,
  teamRuns,
  plans,
  sopDefinitions,
  sopRuns,
  agentRules,
  onAgentRulesNeeded,
  onSelectTarget,
  onTaskTransition,
  onJoinMember,
  onSaveAgent,
  onDeleteAgent,
  onChannelConfigChange,
  onCreateSop,
  onStartSop,
  onLiveEvent,
}: AppProps) {
  if (workspace !== undefined) {
    return createElement(WorkspaceShell, {
      workspace,
      settings,
      activeTargetId,
      viewportWidth,
      channelMembers,
      teamRuns,
      plans,
      sopDefinitions,
      sopRuns,
      agentRules,
      onAgentRulesNeeded,
      onSelectTarget,
      onTaskTransition,
      onSettingsChange,
      onJoinMember,
      onSaveAgent,
      onDeleteAgent,
      onChannelConfigChange,
      onCreateSop,
      onStartSop,
      saveFailed,
      onLiveEvent,
    });
  }

  const locale = settings.locale;
  const author = t(locale, 'message.sample.author');

  return createElement(
    'main',
    {
      className: 'app-shell',
      'data-density': settings.density,
      'data-theme': settings.theme,
      'data-locale': locale,
    },
    createElement(SettingsPanel, { settings, onChange: onSettingsChange, saveFailed }),
    createElement(
      'section',
      { className: 'sample-message', 'data-density': settings.density },
      createElement(Avatar, { slot: 0, name: author }),
      createElement(
        'div',
        { className: 'sample-message__body' },
        createElement('span', { className: 'sample-message__author' }, author),
        createElement(
          'p',
          { className: 'sample-message__text' },
          t(locale, 'message.sample.body', { author }),
        ),
      ),
    ),
  );
}
