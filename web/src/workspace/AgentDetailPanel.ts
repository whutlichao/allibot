import { t, type AgentView, type Locale } from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import type { AsyncAction, AsyncAction1 } from '../async-action.ts';
import {
  AGENT_DETAIL_TABS,
  editSystemPrompt,
  hasUnsavedSystemPrompt,
  initialAgentDetailState,
  switchAgentDetailTab,
  type AgentDetailDraft,
  type AgentDetailTab,
} from './agent-detail.ts';
import { StatusPoint } from './StatusPoint.ts';
import { offlineReasonLabel } from './status-label.ts';

function tabLabel(locale: Locale, tab: AgentDetailTab): string {
  switch (tab) {
    case 'basic':
      return t(locale, 'workspace.agentDetail.tab.basic');
    case 'skills':
      return t(locale, 'workspace.agentDetail.tab.skills');
    case 'mcp':
      return t(locale, 'workspace.agentDetail.tab.mcp');
  }
}

export interface AgentDetailPanelProps {
  agent: AgentView;
  locale: Locale;
  /** 抽屉从某个页签打开时使用；默认基础信息和配置。 */
  initialTab?: AgentDetailTab;
  /** 测试与深链用的初始草稿；生产路径由系统提示输入框写入。 */
  initialDraft?: Partial<AgentDetailDraft>;
  /** 保存系统提示；未提供时不渲染保存动作。 */
  onSave?: AsyncAction1<{ system_prompt: string }>;
  /** 软删除该 Agent；未提供时不渲染删除动作。 */
  onDelete?: AsyncAction;
}

/**
 * Agent 详情页签（Agent Detail Tab）：同一详情面的三个分组，固定顺序
 * 基础信息和配置 → skills → mcp。页签是呈现层状态，不写 URL、不重新
 * 拉取整页；三个分组始终挂载，切换只改变哪一个可见，因此输入框里的
 * 未提交草稿不会丢。skills / mcp 只陈述依赖规格 T11（M2），不放控件、
 * 不伪造数据。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function AgentDetailPanel({
  agent,
  locale,
  initialTab = 'basic',
  initialDraft,
  onSave,
  onDelete,
}: AgentDetailPanelProps) {
  const [state, setState] = useState(() =>
    initialAgentDetailState(agent, initialTab, initialDraft),
  );
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [deleteConfirming, setDeleteConfirming] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteFailed, setDeleteFailed] = useState(false);

  const dirty = hasUnsavedSystemPrompt(state, agent);

  function save(): void {
    if (onSave === undefined || saving) {
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    onSave({ system_prompt: state.draft.systemPrompt })
      .then(() => setSaving(false))
      .catch(() => {
        setSaving(false);
        setSaveFailed(true);
      });
  }

  function remove(): void {
    if (onDelete === undefined || deleting) {
      return;
    }
    setDeleting(true);
    setDeleteFailed(false);
    onDelete()
      .then(() => {
        setDeleting(false);
        setDeleteConfirming(false);
      })
      .catch(() => {
        setDeleting(false);
        setDeleteFailed(true);
      });
  }

  function fact(field: string, label: string, value: ReactNode): ReactNode {
    return createElement(
      'div',
      { className: 'agent-detail__fact', 'data-field': field },
      createElement('dt', { className: 'agent-detail__term' }, label),
      createElement('dd', { className: 'agent-detail__value' }, value),
    );
  }

  function statsSection(): ReactNode {
    const reason =
      agent.status === 'offline' && agent.offline_reason !== null
        ? offlineReasonLabel(locale, agent.offline_reason)
        : null;
    return createElement(
      'section',
      { className: 'agent-detail__section', 'data-section': 'stats' },
      createElement(
        'h3',
        { className: 'agent-detail__heading' },
        t(locale, 'workspace.agentDetail.section.stats'),
      ),
      createElement(
        'dl',
        { className: 'agent-detail__facts' },
        fact(
          'status',
          t(locale, 'workspace.agentDetail.field.status'),
          createElement(StatusPoint, { status: agent.status, locale }),
        ),
        reason === null
          ? null
          : createElement(
              'p',
              { className: 'agent-detail__reason', 'data-offline-reason': agent.offline_reason ?? '' },
              reason,
            ),
        fact(
          'model',
          t(locale, 'workspace.agentDetail.field.model'),
          agent.model ?? t(locale, 'workspace.agentDetail.model.unset'),
        ),
        fact(
          'credential',
          t(locale, 'workspace.agentDetail.field.credential'),
          agent.credential_status === 'present'
            ? t(locale, 'workspace.agentDetail.credential.present')
            : t(locale, 'workspace.agentDetail.credential.missing'),
        ),
      ),
    );
  }

  function systemPromptSection(): ReactNode {
    return createElement(
      'section',
      { className: 'agent-detail__section', 'data-section': 'system-prompt' },
      createElement(
        'h3',
        { className: 'agent-detail__heading' },
        t(locale, 'workspace.agentDetail.section.systemPrompt'),
      ),
      createElement('textarea', {
        className: 'agent-detail__prompt',
        name: 'system_prompt',
        rows: 6,
        value: state.draft.systemPrompt,
        onChange: (event: { currentTarget: { value: string } }) =>
          setState((current) => editSystemPrompt(current, event.currentTarget.value)),
      }),
    );
  }

  function configSection(): ReactNode {
    return createElement(
      'section',
      { className: 'agent-detail__section', 'data-section': 'config' },
      createElement(
        'h3',
        { className: 'agent-detail__heading' },
        t(locale, 'workspace.agentDetail.section.config'),
      ),
      createElement(
        'dl',
        { className: 'agent-detail__facts' },
        fact('role', t(locale, 'workspace.agentDetail.field.role'), agent.role),
        fact(
          'enabled',
          t(locale, 'workspace.agentDetail.field.enabled'),
          agent.enabled === 1
            ? t(locale, 'workspace.agentDetail.enabled.on')
            : t(locale, 'workspace.agentDetail.enabled.off'),
        ),
        fact(
          'context-window',
          t(locale, 'workspace.agentDetail.field.contextWindow'),
          String(agent.context_window),
        ),
        fact(
          'compression-threshold',
          t(locale, 'workspace.agentDetail.field.compressionThreshold'),
          String(agent.compression_threshold),
        ),
        fact(
          'max-iterations',
          t(locale, 'workspace.agentDetail.field.maxIterations'),
          String(agent.max_iterations),
        ),
        fact(
          'auto-claim',
          t(locale, 'workspace.agentDetail.field.autoClaim'),
          agent.auto_claim === 1
            ? t(locale, 'workspace.agentDetail.yes')
            : t(locale, 'workspace.agentDetail.no'),
        ),
      ),
    );
  }

  function dangerSection(): ReactNode {
    let action: ReactNode = null;
    if (onDelete !== undefined) {
      action = deleteConfirming
        ? createElement(
            'div',
            { className: 'agent-detail__danger-actions' },
            createElement(
              'button',
              {
                type: 'button',
                className: 'agent-detail__danger-confirm',
                'data-action': 'confirm-delete-agent',
                disabled: deleting,
                onClick: remove,
              },
              deleting
                ? t(locale, 'workspace.agentDetail.deleting')
                : t(locale, 'workspace.agentDetail.deleteConfirm'),
            ),
            createElement(
              'button',
              {
                type: 'button',
                className: 'agent-detail__danger-cancel',
                'data-action': 'cancel-delete-agent',
                onClick: () => setDeleteConfirming(false),
              },
              t(locale, 'workspace.agentDetail.deleteCancel'),
            ),
          )
        : createElement(
            'button',
            {
              type: 'button',
              className: 'agent-detail__danger-delete',
              'data-action': 'delete-agent',
              onClick: () => setDeleteConfirming(true),
            },
            t(locale, 'workspace.agentDetail.delete'),
          );
    }

    return createElement(
      'section',
      { className: 'agent-detail__section agent-detail__section--danger', 'data-section': 'danger' },
      createElement(
        'h3',
        { className: 'agent-detail__heading' },
        t(locale, 'workspace.agentDetail.section.danger'),
      ),
      createElement(
        'p',
        { className: 'agent-detail__warning' },
        t(locale, 'workspace.agentDetail.deleteWarning'),
      ),
      action,
      deleteFailed
        ? createElement(
            'p',
            { className: 'agent-detail__error', role: 'alert' },
            t(locale, 'workspace.agentDetail.deleteFailed'),
          )
        : null,
    );
  }

  function basicPanel(): ReactNode {
    return createElement(
      'div',
      {
        className: 'agent-detail__panel',
        role: 'tabpanel',
        'data-tab-panel': 'basic',
        hidden: state.tab !== 'basic',
      },
      statsSection(),
      systemPromptSection(),
      configSection(),
      dangerSection(),
    );
  }

  function placeholderPanel(tab: 'skills' | 'mcp'): ReactNode {
    return createElement(
      'div',
      {
        className: 'agent-detail__panel agent-detail__panel--placeholder',
        role: 'tabpanel',
        'data-tab-panel': tab,
        hidden: state.tab !== tab,
      },
      createElement(
        'p',
        { className: 'agent-detail__placeholder' },
        t(locale, 'workspace.agentDetail.t11.placeholder'),
      ),
      createElement(
        'p',
        { className: 'agent-detail__placeholder-body' },
        t(locale, 'workspace.agentDetail.t11.body'),
      ),
    );
  }

  const tabs = AGENT_DETAIL_TABS.map((tab) =>
    createElement(
      'button',
      {
        key: tab,
        type: 'button',
        role: 'tab',
        className: 'agent-detail__tab',
        'data-tab': tab,
        'aria-selected': state.tab === tab ? 'true' : 'false',
        onClick: () => setState((current) => switchAgentDetailTab(current, tab)),
      },
      tabLabel(locale, tab),
    ),
  );

  return createElement(
    'section',
    {
      className: 'agent-detail',
      'data-panel-body': 'agent-detail',
      'data-agent-id': agent.id,
    },
    createElement(
      'div',
      { className: 'agent-detail__tabs', role: 'tablist' },
      ...(tabs as ReactNode[]),
    ),
    onSave === undefined
      ? null
      : createElement(
          'div',
          { className: 'agent-detail__save-bar', 'data-role': 'save-bar' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'agent-detail__save',
              'data-action': 'save-agent',
              disabled: saving || !dirty,
              onClick: save,
            },
            saving
              ? t(locale, 'workspace.agentDetail.saving')
              : t(locale, 'workspace.agentDetail.save'),
          ),
          saveFailed
            ? createElement(
                'span',
                { className: 'agent-detail__error', role: 'alert' },
                t(locale, 'workspace.agentDetail.saveFailed'),
              )
            : null,
        ),
    basicPanel(),
    placeholderPanel('skills'),
    placeholderPanel('mcp'),
  );
}
