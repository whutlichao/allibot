import { t, type Locale, type WorkspaceSettingsView, type WorkspaceView } from '@allibot/shared';
import { CopilotKitProvider } from '@copilotkit/react-core/v2';
import { createElement, useState, type ReactNode } from 'react';
import {
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
} from '../copilotkit-contract.ts';
import { SettingsPanel } from '../components/SettingsPanel.ts';
import { ContextPanel } from './ContextPanel.ts';
import { WorkspaceChatArea, LiveEventContext, type LiveEventSink } from './WorkspaceChat.ts';
import { initialTargetId, readTargetContext } from './model.ts';
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
  viewportWidth?: number;
  onSelectTarget?: (targetId: string) => void;
  onSettingsChange?: (patch: Partial<WorkspaceSettingsView>) => void;
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
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function WorkspaceShell({
  workspace,
  settings,
  activeTargetId,
  initialDrawer = null,
  viewportWidth = DEFAULT_VIEWPORT_WIDTH,
  onSelectTarget,
  onSettingsChange,
  saveFailed = false,
  onLiveEvent,
}: WorkspaceShellProps) {
  const locale = settings.locale;
  const [drawer, setDrawer] = useState<WorkspaceDrawer | null>(initialDrawer);
  const layout = resolveWorkspaceLayout(viewportWidth);
  const selectedTargetId =
    activeTargetId !== undefined ? activeTargetId : initialTargetId(workspace);
  const context = readTargetContext(workspace, selectedTargetId);

  function selectTarget(targetId: string): void {
    setDrawer(null);
    onSelectTarget?.(targetId);
  }

  function openPanel(panel: WorkspacePanel): void {
    setDrawer(openWorkspacePanel({ activeTargetId: selectedTargetId, drawer }, panel).drawer);
  }

  const navigation = createElement(
    'div',
    { className: 'workspace-navigation' },
    createElement(TargetNav, {
      workspace,
      activeTargetId: selectedTargetId,
      locale,
      onSelectTarget: selectTarget,
      onOpenPanel: openPanel,
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
  );

  const main = createElement(
    'div',
    { className: 'workspace-main' },
    header,
    createElement(
      'div',
      { className: 'workspace-chat' },
      createElement(WorkspaceChatArea, { targetId: selectedTargetId }),
    ),
  );

  let drawerBody: ReactNode = null;
  if (drawer === 'navigation') {
    drawerBody = navigation;
  } else if (drawer === 'context') {
    drawerBody = createElement(ContextPanel, {
      workspace,
      targetId: selectedTargetId,
      locale,
      onOpenPanel: openPanel,
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
