import {
  t,
  type ChannelView,
  type Locale,
  type TaskStatus,
  type TaskView,
} from '@allibot/shared';
import {
  createElement,
  useState,
  type ChangeEvent,
  type DragEvent,
  type ReactNode,
} from 'react';
import { taskStatusLabel } from '../workspace/status-label.ts';
import {
  buildTaskBoardColumns,
  canDropTask,
  taskStatusColorToken,
  type TaskBoardColumn,
} from './task-board.ts';

export interface TaskBoardProps {
  /** The task rows of `GET /api/tasks` (the same rows the workspace reading carries). */
  tasks: readonly TaskView[];
  /** The channels the reading carries; the filter only narrows the view. */
  channels: readonly ChannelView[];
  locale: Locale;
  /** The filter a render starts on (tests / deep links); default all channels. */
  initialChannelId?: string | null;
  /** Entering the task thread: the target id is the thread id (ADR 0003). */
  onSelectTarget?: (targetId: string) => void;
  /**
   * The write entry for one transition. Returning false means the backend
   * rejected it, and the card keeps the status the reading gave it.
   */
  onTransition?: (task: TaskView, status: TaskStatus) => boolean | Promise<boolean>;
}

/**
 * 任务看板（Task Board）：按任务状态分列、可按频道筛选的全工作区视图。
 * 它只消费任务载荷呈现，不持状态迁移表副本，也不把任务线程的消息复制到频道。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function TaskBoard({
  tasks,
  channels,
  locale,
  initialChannelId = null,
  onSelectTarget,
  onTransition,
}: TaskBoardProps) {
  const [channelId, setChannelId] = useState<string | null>(initialChannelId);
  const columns = buildTaskBoardColumns(tasks, channelId);

  function requestTransition(task: TaskView, status: TaskStatus): void {
    if (onTransition === undefined) {
      return;
    }
    void Promise.resolve(onTransition(task, status)).catch(() => false);
  }

  function dropTask(event: DragEvent<HTMLDivElement>, status: TaskStatus): void {
    event.preventDefault();
    const taskId = event.dataTransfer.getData('text/plain');
    const task = tasks.find((candidate) => candidate.id === taskId);
    if (task === undefined || !canDropTask(task, status)) {
      return;
    }
    requestTransition(task, status);
  }

  function card(task: TaskView): ReactNode {
    return createElement(
      'article',
      {
        key: task.id,
        className: 'task-card',
        'data-task-id': task.id,
        'data-task-status': task.status,
        style: {
          borderInlineStartColor: `var(${taskStatusColorToken(task.status)})`,
        },
        draggable: true,
        onDragStart: (event: DragEvent<HTMLElement>) => {
          event.dataTransfer.setData('text/plain', task.id);
          event.dataTransfer.effectAllowed = 'move';
        },
      },
      createElement(
        'div',
        { className: 'task-card__heading' },
        createElement('span', {
          className: 'task-card__status',
          'data-status-token': taskStatusColorToken(task.status),
          style: { backgroundColor: `var(${taskStatusColorToken(task.status)})` },
          'aria-hidden': 'true',
        }),
        createElement('span', { className: 'task-card__title' }, task.title),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'task-card__chip',
          'data-action': 'open-task-thread',
          'data-target-id': task.target_id,
          onClick: () => onSelectTarget?.(task.target_id),
        },
        createElement(
          'span',
          { className: 'task-card__chip-label' },
          t(locale, 'taskBoard.chip.thread'),
        ),
        task.unread_count > 0
          ? createElement(
              'span',
              {
                className: 'task-card__chip-unread',
                'data-chip-unread': task.unread_count,
              },
              t(locale, 'taskBoard.chip.unread', { count: task.unread_count }),
            )
          : null,
      ),
      task.allowed_transitions.length === 0
        ? null
        : createElement(
            'details',
            { className: 'task-card__transitions' },
            createElement(
              'summary',
              { className: 'task-card__transitions-summary' },
              t(locale, 'taskBoard.transition.label'),
            ),
            createElement(
              'ul',
              { className: 'task-card__transition-list' },
              task.allowed_transitions.map((status) =>
                createElement(
                  'li',
                  { key: status, className: 'task-card__transition-item' },
                  createElement(
                    'button',
                    {
                      type: 'button',
                      className: 'task-card__transition',
                      'data-transition-to': status,
                      onClick: () => requestTransition(task, status),
                    },
                    taskStatusLabel(locale, status),
                  ),
                ),
              ),
            ),
          ),
    );
  }

  function columnView(column: TaskBoardColumn): ReactNode {
    return createElement(
      'div',
      {
        key: column.status,
        className: 'task-board__column',
        'data-column-status': column.status,
        onDragOver: (event: DragEvent<HTMLDivElement>) => event.preventDefault(),
        onDrop: (event: DragEvent<HTMLDivElement>) => dropTask(event, column.status),
      },
      createElement(
        'header',
        { className: 'task-board__column-header' },
        createElement(
          'h3',
          { className: 'task-board__column-title' },
          taskStatusLabel(locale, column.status),
        ),
        createElement(
          'span',
          { className: 'task-board__column-count' },
          String(column.tasks.length),
        ),
      ),
      column.tasks.length > 0
        ? createElement(
            'ol',
            { className: 'task-board__cards' },
            column.tasks.map((task) =>
              createElement(
                'li',
                { key: task.id, className: 'task-board__card-item' },
                card(task),
              ),
            ),
          )
        : createElement('p', { className: 'task-board__empty' }, t(locale, 'workspace.nav.empty')),
    );
  }

  return createElement(
    'section',
    { className: 'task-board', 'data-view': 'task-board' },
    createElement(
      'label',
      { className: 'task-board__filter' },
      createElement('span', null, t(locale, 'taskBoard.filter.label')),
      createElement(
        'select',
        {
          className: 'task-board__filter-select',
          'data-action': 'filter-channel',
          value: channelId ?? '',
          onChange: (event: ChangeEvent<HTMLSelectElement>) => {
            setChannelId(event.target.value === '' ? null : event.target.value);
          },
        },
        createElement('option', { value: '' }, t(locale, 'taskBoard.filter.all')),
        channels.map((channel) =>
          createElement('option', { key: channel.id, value: channel.id }, channel.name),
        ),
      ),
    ),
    createElement('div', { className: 'task-board__columns' }, columns.map(columnView)),
  );
}
