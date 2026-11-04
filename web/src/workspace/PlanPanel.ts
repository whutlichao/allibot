import {
  t,
  type AgentView,
  type Locale,
  type PlanRunView,
  type PlanTaskView,
} from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import { planTaskStatusLabel } from './plans.ts';

export interface PlanPanelProps {
  plans: readonly PlanRunView[];
  locale: Locale;
  /** The workspace Agent reading resolves a run's member display name. */
  agents?: readonly AgentView[];
}

/**
 * 运行面板的 Plan 区块（#40 / D4.1）：列出每个 (target, member) 最近 run 的
 * 工作清单——标题、三词状态与顺序。它是成员轮次内的清单，不是任务五态，
 * 不渲染成消息，也不进任务看板。
 *
 * 用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，组件级 SSR 契约
 * 测试需要直接 import 本文件。
 */
export function PlanPanel({ plans, locale, agents }: PlanPanelProps) {
  const names = new Map((agents ?? []).map((agent) => [agent.id, agent.display_name]));

  return createElement(
    'section',
    {
      className: 'plan-panel',
      'data-plan-panel': '',
      'aria-label': t(locale, 'workspace.plan.title'),
    },
    createElement('h3', { className: 'plan-panel__title' }, t(locale, 'workspace.plan.title')),
    plans.length === 0
      ? createElement('p', { className: 'plan-panel__empty' }, t(locale, 'workspace.plan.empty'))
      : createElement(
          'ol',
          { className: 'plan-panel__list' },
          ...plans.map((plan) => renderPlan(plan, locale, names)),
        ),
  );
}

function renderPlan(
  plan: PlanRunView,
  locale: Locale,
  names: ReadonlyMap<string, string>,
): ReactNode {
  return createElement(
    'li',
    {
      key: plan.id,
      className: 'plan-panel__run',
      'data-plan-run-id': plan.id,
      'data-plan-member-id': plan.member_id,
    },
    createElement(
      'div',
      { className: 'plan-panel__head' },
      createElement(
        'span',
        { className: 'plan-panel__member' },
        `${t(locale, 'workspace.plan.member')}：${names.get(plan.member_id) ?? plan.member_id}`,
      ),
      createElement(
        'span',
        { className: 'plan-panel__time' },
        `${t(locale, 'workspace.plan.updatedAt')}：${plan.updated_at}`,
      ),
    ),
    createElement(
      'h4',
      { className: 'plan-panel__list-title' },
      t(locale, 'workspace.plan.tasks'),
    ),
    plan.tasks.length === 0
      ? createElement('p', { className: 'plan-panel__empty' }, t(locale, 'workspace.plan.empty'))
      : createElement(
          'ol',
          { className: 'plan-panel__tasks', 'data-plan-tasks': '' },
          ...plan.tasks.map((task) => renderTask(task, locale)),
        ),
  );
}

function renderTask(task: PlanTaskView, locale: Locale): ReactNode {
  return createElement(
    'li',
    {
      key: task.id,
      className: 'plan-panel__task',
      'data-plan-task-id': task.id,
      'data-plan-task-status': task.status,
      'data-plan-task-position': task.position,
    },
    createElement(
      'span',
      { className: 'plan-panel__position' },
      String(task.position + 1),
    ),
    createElement('span', { className: 'plan-panel__task-title' }, task.title),
    createElement(
      'span',
      { className: 'plan-panel__task-status' },
      planTaskStatusLabel(locale, task.status),
    ),
  );
}
