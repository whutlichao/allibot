import { createElement, useState, type ReactNode } from 'react';

export interface ContextFoldProps {
  /** Stable section name; also the toggle's `data-fold` contract value. */
  section: 'permission-rules' | 'sop';
  title: string;
  children?: ReactNode;
  /** Tests and deep links may start a fold open; production starts closed. */
  defaultOpen?: boolean;
}

/**
 * 右抽屉里的折叠分区 (F4)：SOP 与权限规则默认收起，只把标题留在
 * 单列里，展开时才挂载内容。`aria-expanded` 是呈现契约，不写 URL、
 * 不重新拉取、不改变任何领域状态。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function ContextFold({
  section,
  title,
  children,
  defaultOpen = false,
}: ContextFoldProps) {
  const [open, setOpen] = useState(defaultOpen);
  const bodyId = `context-fold-${section}-body`;
  return createElement(
    'section',
    { className: 'context-fold', 'data-fold': section },
    createElement(
      'button',
      {
        type: 'button',
        className: 'context-fold__toggle',
        'data-action': 'toggle-fold',
        'data-fold': section,
        'aria-expanded': open,
        'aria-controls': bodyId,
        onClick: () => setOpen((current) => !current),
      },
      title,
    ),
    open
      ? createElement('div', { className: 'context-fold__body', id: bodyId }, children)
      : null,
  );
}
