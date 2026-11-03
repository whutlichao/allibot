import { t, type Locale, type TargetMemberView, type WorkspaceView } from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import type { AsyncAction1 } from '../async-action.ts';
import { Avatar, type AvatarSlot } from '../components/Avatar.ts';
import { readMemberPanel, type MemberRowView } from './member-reading.ts';
import { StatusPoint } from './StatusPoint.ts';
import { offlineReasonLabel } from './status-label.ts';

export interface MemberPanelProps {
  workspace: WorkspaceView;
  /** 当前频道的成员表；undefined 表示还没读到，不把「未加入」当成事实。 */
  members: readonly TargetMemberView[] | undefined;
  locale: Locale;
  /**
   * 加入频道：由宿主调用 `POST /api/channels/{id}/members`，Promise 完成
   * 后成员表已更新。面板不自己发请求，也不在响应前移动任何一行。
   */
  onJoin?: AsyncAction1<string>;
}

/**
 * 成员面板（Member Panel）：只属于频道，按当前频道成员表分「已加入 /
 * 未加入」两段。每行显示状态点、模型标识与「为什么未启用」的可读原因；
 * 未加入的行带加入控件。它不是本机 Agent 列表，也不是成员名册。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function MemberPanel({ workspace, members, locale, onJoin }: MemberPanelProps) {
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [joinFailed, setJoinFailed] = useState(false);

  function join(memberId: string): void {
    if (onJoin === undefined || joiningId !== null) {
      return;
    }
    setJoiningId(memberId);
    setJoinFailed(false);
    onJoin(memberId)
      .then(() => setJoiningId(null))
      .catch(() => {
        setJoiningId(null);
        setJoinFailed(true);
      });
  }

  function memberRow(row: MemberRowView, joined: boolean): ReactNode {
    const reason =
      row.status === 'offline' && row.offlineReason !== null
        ? offlineReasonLabel(locale, row.offlineReason)
        : null;
    return createElement(
      'li',
      {
        key: row.id,
        className: 'member-panel__row',
        'data-member-id': row.id,
        'data-member-state': joined ? 'joined' : 'not-joined',
      },
      createElement(Avatar, { slot: row.avatarSlot as AvatarSlot, name: row.displayName }),
      createElement(
        'div',
        { className: 'member-panel__identity' },
        createElement('span', { className: 'member-panel__name' }, row.displayName),
        createElement(
          'span',
          { className: 'member-panel__model' },
          row.model ?? t(locale, 'workspace.agentDetail.model.unset'),
        ),
        reason === null
          ? null
          : createElement(
              'span',
              {
                className: 'member-panel__reason',
                'data-offline-reason': row.offlineReason ?? '',
              },
              reason,
            ),
      ),
      row.status === null ? null : createElement(StatusPoint, { status: row.status, locale }),
      joined || onJoin === undefined
        ? null
        : createElement(
            'button',
            {
              type: 'button',
              className: 'member-panel__join',
              'data-action': 'join-member',
              'data-member-id': row.id,
              disabled: joiningId !== null,
              onClick: () => join(row.id),
            },
            joiningId === row.id
              ? t(locale, 'workspace.member.joining')
              : t(locale, 'workspace.member.join'),
          ),
    );
  }

  if (members === undefined) {
    return createElement(
      'div',
      { className: 'member-panel', 'data-panel-body': 'member-panel' },
      createElement(
        'p',
        { className: 'member-panel__loading' },
        t(locale, 'workspace.member.loading'),
      ),
    );
  }

  const view = readMemberPanel(workspace, members);

  function segment(
    section: 'joined' | 'not-joined',
    title: string,
    rows: MemberRowView[],
  ): ReactNode {
    return createElement(
      'section',
      { className: 'member-panel__section', 'data-section': section },
      createElement('h3', { className: 'member-panel__heading' }, title),
      rows.length === 0
        ? createElement('p', { className: 'member-panel__empty' }, t(locale, 'workspace.member.empty'))
        : createElement(
            'ul',
            { className: 'member-panel__list' },
            rows.map((row) => memberRow(row, section === 'joined')),
          ),
    );
  }

  return createElement(
    'div',
    { className: 'member-panel', 'data-panel-body': 'member-panel' },
    segment('joined', t(locale, 'workspace.member.joined'), view.joined),
    segment('not-joined', t(locale, 'workspace.member.notJoined'), view.notJoined),
    joinFailed
      ? createElement(
          'p',
          { className: 'member-panel__error', role: 'alert' },
          t(locale, 'workspace.member.joinFailed'),
        )
      : null,
  );
}
