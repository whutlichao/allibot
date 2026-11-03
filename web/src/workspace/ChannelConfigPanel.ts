import {
  CHANNEL_MODES,
  t,
  type ChannelConfigPatch,
  type ChannelMode,
  type ChannelView,
  type Locale,
  type TargetMemberView,
} from '@allibot/shared';
import { createElement, useState, type ReactNode } from 'react';
import { leaderCandidates, leaderChangePatch, modeChangePatch } from './channel-config.ts';

export interface ChannelConfigPanelProps {
  channel: ChannelView;
  /** The channel's member table; undefined means it has not been read yet. */
  members: readonly TargetMemberView[] | undefined;
  locale: Locale;
  /**
   * The host's team-config write. It sends one PATCH to the channel URL for
   * both the mode and the leader; the panel never fetches or writes itself.
   */
  onTeamConfigChange?: (patch: ChannelConfigPatch) => void | Promise<void>;
}

function modeLabel(locale: Locale, mode: ChannelMode): string {
  switch (mode) {
    case 'autonomous':
      return t(locale, 'channel.config.mode.autonomous');
    case 'team':
      return t(locale, 'channel.config.mode.team');
  }
}

function selectedValue(event: { target: { value: string } }): string {
  return event.target.value;
}

/**
 * 频道配置区（#37 / D2.2）：把后端读数里的 mode / 队长 / 配置无效原因呈现为
 * 两个控件。DM 没有频道配置区，也就不存在 mode 控件（DM 恒 autonomous）。
 *
 * 切换 mode 或 leader 都只把一次 patch 交给宿主（同一个
 * `PATCH /api/channels/{id}`）；写到 team 时必带队长，写回 autonomous 时清空
 * 队长。配置无效只展示后端给的原因，不在前端推断或回落。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function ChannelConfigPanel({
  channel,
  members,
  locale,
  onTeamConfigChange,
}: ChannelConfigPanelProps) {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const candidates = leaderCandidates(members);
  const team = channel.team;

  function submit(patch: ChannelConfigPatch | null): void {
    if (patch === null || onTeamConfigChange === undefined || saving) {
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    void Promise.resolve(onTeamConfigChange(patch))
      .then(() => setSaving(false))
      .catch(() => {
        setSaving(false);
        setSaveFailed(true);
      });
  }

  const modeOptions = CHANNEL_MODES.map((mode) =>
    createElement(
      'option',
      {
        key: mode,
        value: mode,
        // Switching to team needs an Agent member to lead it.
        disabled: mode === 'team' && candidates.length === 0,
        'data-team-option': mode === 'team' && candidates.length === 0 ? 'disabled' : undefined,
      },
      modeLabel(locale, mode),
    ),
  );

  const leaderOptions: ReactNode[] = [];
  if (team.leader_member_id !== null && !candidates.some((row) => row.id === team.leader_member_id)) {
    // The configured leader may have left the channel; the reading still names
    // it, so the control shows a placeholder instead of silently dropping it.
    leaderOptions.push(
      createElement(
        'option',
        { key: team.leader_member_id, value: team.leader_member_id },
        t(locale, 'channel.config.leader.unknown'),
      ),
    );
  }
  for (const member of candidates) {
    leaderOptions.push(
      createElement('option', { key: member.id, value: member.id }, member.display_name),
    );
  }

  const leaderControl =
    channel.mode === 'team'
      ? createElement(
          'div',
          { className: 'channel-config__field' },
          createElement(
            'label',
            { className: 'channel-config__label', htmlFor: 'channel-config-leader' },
            t(locale, 'channel.config.leader.label'),
          ),
          createElement(
            'select',
            {
              id: 'channel-config-leader',
              className: 'channel-config__select',
              'data-action': 'team-leader',
              value: team.leader_member_id ?? '',
              disabled: saving || candidates.length === 0,
              onChange: (event: { target: { value: string } }) =>
                submit(leaderChangePatch(channel, selectedValue(event))),
            },
            team.leader_member_id === null
              ? createElement(
                  'option',
                  { key: 'placeholder', value: '' },
                  t(locale, 'channel.config.leader.placeholder'),
                )
              : null,
            ...leaderOptions,
          ),
        )
      : null;

  const invalid =
    channel.mode === 'team' && team.status === 'invalid'
      ? createElement(
          'p',
          {
            className: 'channel-config__invalid',
            'data-team-status': 'invalid',
            role: 'status',
          },
          createElement(
            'strong',
            { className: 'channel-config__invalid-title' },
            t(locale, 'channel.config.invalid'),
          ),
          createElement(
            'span',
            { className: 'channel-config__invalid-reason' },
            team.reason ?? '',
          ),
        )
      : null;

  return createElement(
    'section',
    {
      className: 'channel-config',
      'data-channel-config': '',
      'data-channel-mode': channel.mode,
      'aria-label': t(locale, 'channel.config.title'),
    },
    createElement(
      'h3',
      { className: 'channel-config__title' },
      t(locale, 'channel.config.title'),
    ),
    createElement(
      'div',
      { className: 'channel-config__field' },
      createElement(
        'label',
        { className: 'channel-config__label', htmlFor: 'channel-config-mode' },
        t(locale, 'channel.config.mode.label'),
      ),
      createElement(
        'select',
        {
          id: 'channel-config-mode',
          className: 'channel-config__select',
          'data-action': 'channel-mode',
          value: channel.mode,
          disabled: saving,
          onChange: (event: { target: { value: string } }) =>
            submit(modeChangePatch(channel, selectedValue(event) as ChannelMode, members)),
        },
        ...modeOptions,
      ),
    ),
    leaderControl,
    members === undefined
      ? createElement(
          'p',
          { className: 'channel-config__hint' },
          t(locale, 'channel.config.leader.loading'),
        )
      : null,
    invalid,
    saving
      ? createElement(
          'p',
          { className: 'channel-config__hint' },
          t(locale, 'channel.config.leader.saving'),
        )
      : null,
    saveFailed
      ? createElement(
          'p',
          { className: 'channel-config__error', role: 'alert' },
          t(locale, 'channel.config.leader.saveFailed'),
        )
      : null,
  );
}
