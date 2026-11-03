import { t, type Locale, type WorkspaceView } from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import { buildWorkspaceNav, type TargetNavEntry } from './model.ts';
import { statusLabel } from './status-label.ts';
import type { WorkspacePanel } from './shell-state.ts';

export interface TargetNavProps {
  workspace: WorkspaceView;
  activeTargetId: string | null;
  locale: Locale;
  onSelectTarget?: (targetId: string) => void;
  onOpenPanel?: (panel: WorkspacePanel) => void;
}

/**
 * 工作台左侧的 target 导航：频道（含已归档段）、私信（含已归档段）、任务与
 * 本机 Agent。每一行都从 `GET /api/workspace` 的同一份读数派生，切换 target
 * 只改变当前 thread 身份，不写消息（ADR 0002）。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function TargetNav({
  workspace,
  activeTargetId,
  locale,
  onSelectTarget,
  onOpenPanel,
}: TargetNavProps) {
  const nav = buildWorkspaceNav(workspace);

  function targetButton(entry: TargetNavEntry): ReactNode {
    return createElement(
      'li',
      { key: entry.targetId },
      createElement(
        'button',
        {
          type: 'button',
          className: 'target-nav__target',
          'data-target-id': entry.targetId,
          'data-target-kind': entry.kind,
          'aria-current': entry.targetId === activeTargetId ? 'true' : undefined,
          onClick: () => onSelectTarget?.(entry.targetId),
        },
        createElement('span', { className: 'target-nav__label' }, entry.label),
        entry.unread > 0
          ? createElement(
              'span',
              {
                className: 'target-nav__unread',
                'data-unread': entry.unread,
                'aria-label': t(locale, 'workspace.nav.unread', { count: entry.unread }),
              },
              String(entry.unread),
            )
          : null,
      ),
    );
  }

  function targetSection(
    section: string,
    title: string,
    entries: TargetNavEntry[],
    extra?: ReactNode,
  ): ReactNode {
    return createElement(
      'section',
      { className: 'target-nav__section', 'data-section': section },
      createElement('h2', { className: 'target-nav__title' }, title),
      entries.length > 0
        ? createElement('ul', { className: 'target-nav__list' }, entries.map(targetButton))
        : createElement('p', { className: 'target-nav__empty' }, t(locale, 'workspace.nav.empty')),
      extra ?? null,
    );
  }

  const taskBoard = createElement(
    'button',
    {
      type: 'button',
      className: 'target-nav__panel',
      'data-action': 'open-panel',
      'data-panel': 'task-board',
      onClick: () => onOpenPanel?.('task-board'),
    },
    t(locale, 'workspace.panel.taskBoard'),
  );

  const agents = workspace.agents.map((agent) => {
    const point = workspace.status_points[agent.id];
    return createElement(
      'li',
      { key: agent.id, className: 'target-nav__agent', 'data-member-id': agent.id },
      createElement(
        'button',
        {
          type: 'button',
          className: 'target-nav__target',
          'data-action': 'open-agent-detail',
          'data-member-id': agent.id,
          onClick: () => onOpenPanel?.('agent-detail'),
        },
        createElement('span', { className: 'target-nav__label' }, agent.display_name),
        point === undefined
          ? null
          : createElement(
              'span',
              {
                className: 'status-point',
                'data-status': point.status,
                title: statusLabel(locale, point.status),
              },
              statusLabel(locale, point.status),
            ),
      ),
    );
  });

  return createElement(
    'nav',
    { className: 'target-nav', 'aria-label': t(locale, 'workspace.nav.title') },
    targetSection('channels', t(locale, 'workspace.nav.channels'), nav.channels),
    targetSection(
      'archived-channels',
      t(locale, 'workspace.nav.channelsArchived'),
      nav.archivedChannels,
    ),
    targetSection('dms', t(locale, 'workspace.nav.dms'), nav.dms),
    targetSection('archived-dms', t(locale, 'workspace.nav.dmsArchived'), nav.archivedDms),
    targetSection('tasks', t(locale, 'workspace.nav.tasks'), nav.tasks, taskBoard),
    createElement(
      'section',
      { className: 'target-nav__section', 'data-section': 'agents' },
      createElement('h2', { className: 'target-nav__title' }, t(locale, 'workspace.nav.agents')),
      agents.length > 0
        ? createElement('ul', { className: 'target-nav__list' }, agents)
        : createElement('p', { className: 'target-nav__empty' }, t(locale, 'workspace.nav.empty')),
    ),
  );
}
