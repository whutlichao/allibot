import { t, type Locale, type TargetMemberView, type WorkspaceView } from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import { Avatar, type AvatarSlot } from '../components/Avatar.ts';
import { readMemberRoster } from './member-reading.ts';
import { StatusPoint } from './StatusPoint.ts';

export interface MemberRosterProps {
  workspace: WorkspaceView;
  /** 当前频道的成员表；undefined 表示还没读到。 */
  members: readonly TargetMemberView[] | undefined;
  locale: Locale;
}

/**
 * 成员名册（Member Roster）：一个频道成员的只读全名单，含 owner 与各成员
 * 的状态点，回答「这个频道里有谁」。它没有管理动作——唯一动作是抽屉的
 * 关闭；加入频道属于成员面板。它不是成员面板的别名，也不是本机 Agent
 * 列表的别名。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function MemberRoster({ workspace, members, locale }: MemberRosterProps) {
  if (members === undefined) {
    return createElement(
      'div',
      { className: 'member-roster', 'data-panel-body': 'member-roster' },
      createElement(
        'p',
        { className: 'member-roster__loading' },
        t(locale, 'workspace.member.loading'),
      ),
    );
  }

  const rows = readMemberRoster(workspace, members);

  function row(member: (typeof rows)[number]): ReactNode {
    const isOwner = member.id === workspace.owner.id;
    return createElement(
      'li',
      {
        key: member.id,
        className: 'member-roster__row',
        'data-member-id': member.id,
      },
      createElement(Avatar, { slot: member.avatarSlot as AvatarSlot, name: member.displayName }),
      createElement('span', { className: 'member-roster__name' }, member.displayName),
      isOwner
        ? createElement(
            'span',
            { className: 'member-roster__owner' },
            t(locale, 'workspace.roster.ownerRole'),
          )
        : null,
      member.status === null
        ? null
        : createElement(StatusPoint, { status: member.status, locale }),
    );
  }

  return createElement(
    'div',
    { className: 'member-roster', 'data-panel-body': 'member-roster' },
    createElement(
      'ul',
      { className: 'member-roster__list' },
      rows.map(row),
    ),
  );
}
