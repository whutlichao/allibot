import { t, type Locale, type WorkspaceView } from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import { readTargetContext, type TargetKind } from './model.ts';
import type { WorkspacePanel } from './shell-state.ts';
import { taskStatusLabel } from './status-label.ts';

export interface ContextPanelProps {
  workspace: WorkspaceView;
  targetId: string | null;
  locale: Locale;
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
export function ContextPanel({ workspace, targetId, locale, onOpenPanel }: ContextPanelProps) {
  const context = readTargetContext(workspace, targetId);

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
          context.taskStatus === null
            ? null
            : createElement(
                'p',
                { className: 'context-panel__status', 'data-task-status': context.taskStatus },
                taskStatusLabel(locale, context.taskStatus),
              ),
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
