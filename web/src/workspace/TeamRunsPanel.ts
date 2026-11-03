import {
  t,
  type ChannelView,
  type Locale,
  type TaskView,
  type TeamRunView,
} from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import { teamRunStatusLabel } from './team-runs.ts';

export interface TeamRunsPanelProps {
  runs: readonly TeamRunView[];
  locale: Locale;
  /** The board reading resolves a task run's title; the id is the fallback. */
  tasks?: readonly TaskView[];
  /** The workspace reading resolves a channel run's name. */
  channels?: readonly ChannelView[];
}

/**
 * 运行面板（#38 / D3.3）：列出队长每个 team 轮次的运行记录——状态、可读
 * reason、task / channel 归属与起止时间。它是取证面，不是消息流：这里不渲染
 * 消息气泡，也不参与未读与搜索。
 *
 * 用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，组件级 SSR 契约
 * 测试需要直接 import 本文件。
 */
export function TeamRunsPanel({ runs, locale, tasks, channels }: TeamRunsPanelProps) {
  const taskTitles = new Map((tasks ?? []).map((task) => [task.target_id, task.title]));
  const channelNames = new Map((channels ?? []).map((channel) => [channel.id, channel.name]));

  return createElement(
    'section',
    {
      className: 'team-runs',
      'data-team-runs': '',
      'aria-label': t(locale, 'workspace.teamRuns.title'),
    },
    createElement('h3', { className: 'team-runs__title' }, t(locale, 'workspace.teamRuns.title')),
    runs.length === 0
      ? createElement(
          'p',
          { className: 'team-runs__empty' },
          t(locale, 'workspace.teamRuns.empty'),
        )
      : createElement(
          'ol',
          { className: 'team-runs__list' },
          ...runs.map((run) => renderRun(run, locale, taskTitles, channelNames)),
        ),
  );
}

function renderRun(
  run: TeamRunView,
  locale: Locale,
  taskTitles: ReadonlyMap<string, string>,
  channelNames: ReadonlyMap<string, string>,
): ReactNode {
  const taskAttribution =
    run.task_id === null
      ? null
      : t(locale, 'workspace.teamRuns.attribution.task') +
        '：' +
        (taskTitles.get(run.target_id) ?? run.task_id);
  const channelAttribution =
    t(locale, 'workspace.teamRuns.attribution.channel') +
    '：' +
    (channelNames.get(run.channel_id) ?? run.channel_id);
  const attribution = taskAttribution ?? channelAttribution;

  return createElement(
    'li',
    {
      key: run.id,
      className: 'team-runs__run',
      'data-team-run-id': run.id,
      'data-team-run-status': run.status,
    },
    createElement(
      'div',
      { className: 'team-runs__head' },
      createElement(
        'span',
        { className: 'team-runs__status', 'data-team-run-status-label': '' },
        teamRunStatusLabel(locale, run.status),
      ),
      createElement(
        'span',
        {
          className: 'team-runs__attribution',
          'data-run-attribution': run.task_id === null ? 'channel' : 'task',
        },
        attribution,
      ),
    ),
    createElement(
      'p',
      { className: 'team-runs__reason' },
      createElement('strong', { className: 'team-runs__label' }, t(locale, 'workspace.teamRuns.reason')),
      run.reason ?? '—',
    ),
    createElement(
      'p',
      { className: 'team-runs__time' },
      createElement('strong', { className: 'team-runs__label' }, t(locale, 'workspace.teamRuns.time')),
      `${run.started_at} → ${run.finished_at ?? '—'}`,
    ),
  );
}
