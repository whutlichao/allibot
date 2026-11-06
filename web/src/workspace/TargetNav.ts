import { t, type Locale, type WorkspaceView } from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import type { AsyncAction1 } from '../async-action.ts';
import {
  InlineCreateForm,
  editInlineCreateName,
  initialInlineCreate,
  runInlineCreate,
} from './inline-create.ts';
import { buildWorkspaceNav, type TargetNavEntry } from './model.ts';
import { StatusPoint } from './StatusPoint.ts';
import type { WorkspacePanel } from './shell-state.ts';

export interface TargetNavProps {
  workspace: WorkspaceView;
  activeTargetId: string | null;
  locale: Locale;
  onSelectTarget?: (targetId: string) => void;
  onOpenPanel?: (panel: WorkspacePanel) => void;
  /** 本机 Agent 行打开哪一位 Agent 的详情；缺省时只打开详情面。 */
  onOpenAgentDetail?: (agentId: string) => void;
  /**
   * 空频道列表里的创建入口：名字由用户输入，空名字不提交。未提供时不渲染
   * 创建表单，只留引导文案。
   */
  onCreateChannel?: AsyncAction1<string>;
  /** 空本机 Agent 列表里的创建入口，形状同 `onCreateChannel`。 */
  onCreateAgent?: AsyncAction1<string>;
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
  onOpenAgentDetail,
  onCreateChannel,
  onCreateAgent,
}: TargetNavProps) {
  const nav = buildWorkspaceNav(workspace);
  const [channelCreate, setChannelCreate] = useState(initialInlineCreate);
  const [agentCreate, setAgentCreate] = useState(initialInlineCreate);

  /**
   * 空状态引导（D9）：先说下一步做什么，再给一个单行创建表单。表单只在
   * 列表真为空、且宿主提供了创建动作时出现；非空状态不给第二入口。
   */
  const channelEmptyState = createElement(
    'div',
    { className: 'target-nav__empty-state', 'data-empty-state': 'channels' },
    createElement(
      'p',
      { className: 'target-nav__empty' },
      t(locale, 'workspace.nav.channelsEmpty'),
    ),
    onCreateChannel === undefined
      ? null
      : createElement(InlineCreateForm, {
          state: channelCreate,
          locale,
          nameLabel: t(locale, 'workspace.nav.channelName'),
          submitLabel: t(locale, 'workspace.nav.createChannel'),
          action: 'create-channel',
          onChange: (name: string) =>
            setChannelCreate(editInlineCreateName(channelCreate, name)),
          onSubmit: () => {
            void runInlineCreate(channelCreate, onCreateChannel, setChannelCreate);
          },
        }),
  );

  const agentEmptyState = createElement(
    'div',
    { className: 'target-nav__empty-state', 'data-empty-state': 'agents' },
    createElement(
      'p',
      { className: 'target-nav__empty' },
      t(locale, 'workspace.nav.agentsEmpty'),
    ),
    onCreateAgent === undefined
      ? null
      : createElement(InlineCreateForm, {
          state: agentCreate,
          locale,
          nameLabel: t(locale, 'workspace.nav.agentName'),
          submitLabel: t(locale, 'workspace.nav.createAgent'),
          action: 'create-agent',
          onChange: (name: string) => setAgentCreate(editInlineCreateName(agentCreate, name)),
          onSubmit: () => {
            void runInlineCreate(agentCreate, onCreateAgent, setAgentCreate);
          },
        }),
  );

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
    options: { empty?: ReactNode; extra?: ReactNode } = {},
  ): ReactNode {
    return createElement(
      'section',
      { className: 'target-nav__section', 'data-section': section },
      createElement('h2', { className: 'target-nav__title' }, title),
      entries.length > 0
        ? createElement('ul', { className: 'target-nav__list' }, entries.map(targetButton))
        : (options.empty ??
          createElement(
            'p',
            { className: 'target-nav__empty' },
            t(locale, 'workspace.nav.empty'),
          )),
      options.extra ?? null,
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
          onClick: () => {
            if (onOpenAgentDetail !== undefined) {
              onOpenAgentDetail(agent.id);
            } else {
              onOpenPanel?.('agent-detail');
            }
          },
        },
        createElement('span', { className: 'target-nav__label' }, agent.display_name),
        point === undefined ? null : createElement(StatusPoint, { status: point.status, locale }),
      ),
    );
  });

  return createElement(
    'nav',
    { className: 'target-nav', 'aria-label': t(locale, 'workspace.nav.title') },
    targetSection('channels', t(locale, 'workspace.nav.channels'), nav.channels, {
      empty: channelEmptyState,
    }),
    targetSection(
      'archived-channels',
      t(locale, 'workspace.nav.channelsArchived'),
      nav.archivedChannels,
    ),
    targetSection('dms', t(locale, 'workspace.nav.dms'), nav.dms),
    targetSection('archived-dms', t(locale, 'workspace.nav.dmsArchived'), nav.archivedDms),
    targetSection('tasks', t(locale, 'workspace.nav.tasks'), nav.tasks, { extra: taskBoard }),
    createElement(
      'section',
      { className: 'target-nav__section', 'data-section': 'agents' },
      createElement('h2', { className: 'target-nav__title' }, t(locale, 'workspace.nav.agents')),
      agents.length > 0
        ? createElement('ul', { className: 'target-nav__list' }, agents)
        : agentEmptyState,
    ),
  );
}
