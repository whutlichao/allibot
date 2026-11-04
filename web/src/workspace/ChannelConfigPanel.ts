import {
  CHANNEL_MODES,
  WORKSPACE_BACKENDS,
  t,
  type ChannelConfigPatch,
  type ChannelMode,
  type ChannelView,
  type Locale,
  type PermissionRuleInput,
  type PermissionRuleView,
  type TargetMemberView,
  type WorkspaceBackend,
  type WorkspaceStatusView,
} from '@allibot/shared';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import {
  backendChangePatch,
  leaderCandidates,
  leaderChangePatch,
  localShellChangePatch,
  modeChangePatch,
  rootChangePatch,
  workspaceStatusCopy,
} from './channel-config.ts';
import { PermissionRulesEditor } from './PermissionRulesEditor.ts';
import {
  channelPermissionModePatch,
  permissionModeOptions,
} from './permissions.ts';

export interface ChannelConfigPanelProps {
  channel: ChannelView;
  /** The channel's member table; undefined means it has not been read yet. */
  members: readonly TargetMemberView[] | undefined;
  /** The selected target's workspace availability; undefined while loading. */
  workspaceStatus?: WorkspaceStatusView;
  locale: Locale;
  /**
   * The host's team-config write. It sends one PATCH to the channel URL for
   * both the mode and the leader; the panel never fetches or writes itself.
   */
  onTeamConfigChange?: (patch: ChannelConfigPatch) => void | Promise<void>;
  /** The channel's permission rule set (#44); undefined while it is loading. */
  permissionRules?: readonly PermissionRuleView[];
  /** The full-replacement rule write; absent = read-only display. */
  onPermissionRulesChange?: (rules: PermissionRuleInput[]) => void | Promise<void>;
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
  workspaceStatus,
  locale,
  onTeamConfigChange,
  permissionRules,
  onPermissionRulesChange,
}: ChannelConfigPanelProps) {
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const [rootDraft, setRootDraft] = useState(channel.workspace.root ?? '');
  const candidates = leaderCandidates(members);
  const team = channel.team;

  // The backend reading is the source of truth: after a save the host re-reads
  // the workspace and the draft follows the stored canonical root.
  useEffect(() => {
    setRootDraft(channel.workspace.root ?? '');
  }, [channel.id, channel.workspace.root]);

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

  const rootPatch = rootChangePatch(channel, rootDraft);
  const shellEnabled = channel.workspace.allow_local_shell === 1;
  const workspaceControls = createElement(
    'div',
    { className: 'channel-config__workspace', 'data-workspace-config': '' },
    createElement(
      'div',
      { className: 'channel-config__field' },
      createElement(
        'label',
        { className: 'channel-config__label', htmlFor: 'channel-config-workspace-root' },
        t(locale, 'channel.config.workspace.root.label'),
      ),
      createElement(
        'div',
        { className: 'channel-config__workspace-row' },
        createElement('input', {
          id: 'channel-config-workspace-root',
          className: 'channel-config__input',
          type: 'text',
          value: rootDraft,
          placeholder: t(locale, 'channel.config.workspace.root.placeholder'),
          disabled: saving,
          'data-action': 'workspace-root',
          onChange: (event: { target: { value: string } }) => setRootDraft(event.target.value),
        }),
        createElement(
          'button',
          {
            type: 'button',
            className: 'channel-config__button',
            'data-action': 'workspace-root-save',
            disabled: saving || rootPatch === null,
            onClick: () => submit(rootPatch),
          },
          t(locale, 'channel.config.workspace.root.save'),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'channel-config__field' },
      createElement(
        'label',
        { className: 'channel-config__label', htmlFor: 'channel-config-workspace-backend' },
        t(locale, 'channel.config.workspace.backend.label'),
      ),
      createElement(
        'select',
        {
          id: 'channel-config-workspace-backend',
          className: 'channel-config__select',
          'data-action': 'workspace-backend',
          'data-workspace-backend': channel.workspace.backend,
          value: channel.workspace.backend,
          disabled: saving,
          onChange: (event: { target: { value: string } }) =>
            submit(
              backendChangePatch(channel, event.target.value as WorkspaceBackend),
            ),
        },
        ...WORKSPACE_BACKENDS.map((backend) =>
          createElement(
            'option',
            { key: backend, value: backend },
            backend === 'local'
              ? t(locale, 'channel.config.workspace.backend.local')
              : t(locale, 'channel.config.workspace.backend.docker'),
          ),
        ),
      ),
    ),
    createElement(
      'div',
      { className: 'channel-config__field', 'data-local-shell-config': '' },
      createElement(
        'label',
        { className: 'channel-config__label', htmlFor: 'channel-config-local-shell' },
        createElement('input', {
          id: 'channel-config-local-shell',
          type: 'checkbox',
          checked: shellEnabled,
          disabled: saving,
          'data-action': 'local-shell',
          'data-allow-local-shell': shellEnabled ? '1' : '0',
          onChange: (event: { target: { checked: boolean } }) =>
            submit(localShellChangePatch(channel, event.target.checked)),
        }),
        t(locale, 'channel.config.workspace.shell.label'),
      ),
      createElement(
        'p',
        {
          className: 'channel-config__risk',
          'data-shell-risk': 'true',
          role: 'note',
        },
        t(locale, 'channel.config.workspace.shell.risk'),
      ),
    ),
    workspaceStatus === undefined
      ? createElement(
          'p',
          {
            className: 'channel-config__hint',
            'data-workspace-status': 'loading',
          },
          t(locale, 'workspace.status.loading'),
        )
      : createElement(
          'p',
          {
            className: 'channel-config__workspace-status',
            'data-workspace-status': workspaceStatus.available ? 'available' : 'unavailable',
            'data-workspace-reason': workspaceStatus.reason ?? '',
            role: 'status',
          },
          createElement(
            'strong',
            { className: 'channel-config__label' },
            t(locale, 'channel.config.workspace.status.label'),
          ),
          createElement(
            'span',
            null,
            workspaceStatusCopy(locale, workspaceStatus),
          ),
        ),
  );

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
    createElement(
      'div',
      { className: 'channel-config__field' },
      createElement(
        'label',
        { className: 'channel-config__label', htmlFor: 'channel-config-permission-mode' },
        t(locale, 'workspace.permission.mode.label'),
      ),
      createElement(
        'select',
        {
          id: 'channel-config-permission-mode',
          className: 'channel-config__select',
          'data-action': 'channel-permission-mode',
          'data-permission-mode': channel.permission_mode,
          value: channel.permission_mode,
          disabled: saving,
          onChange: (event: { target: { value: string } }) =>
            submit(channelPermissionModePatch(channel, event.target.value)),
        },
        ...permissionModeOptions(locale).map((option) =>
          createElement('option', { key: option.value, value: option.value }, option.label),
        ),
      ),
    ),
    workspaceControls,
    createElement(PermissionRulesEditor, {
      key: `channel-rules:${channel.id}`,
      rules: permissionRules,
      locale,
      onSave: onPermissionRulesChange,
    }),
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
