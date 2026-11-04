import {
  PERMISSION_BEHAVIORS,
  PERMISSION_MODES,
  t,
  type AgentView,
  type ChannelView,
  type Locale,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionRuleInput,
  type PermissionRuleView,
} from '@allibot/shared';

/**
 * 权限配置的呈现与写路径 (#44 / D5.5). The three modes are the product
 * vocabulary; the panel never invents a fourth. The rule editor sends the
 * complete replacement the backend's `PUT` expects.
 */

export function permissionModeLabel(locale: Locale, mode: PermissionMode): string {
  switch (mode) {
    case 'read-only':
      return t(locale, 'workspace.permission.mode.readOnly');
    case 'ask-writes':
      return t(locale, 'workspace.permission.mode.askWrites');
    case 'trusted-writes':
      return t(locale, 'workspace.permission.mode.trustedWrites');
  }
}

export function permissionModeOptions(locale: Locale): { value: PermissionMode; label: string }[] {
  return PERMISSION_MODES.map((mode) => ({ value: mode, label: permissionModeLabel(locale, mode) }));
}

export function permissionBehaviorLabel(locale: Locale, behavior: PermissionBehavior): string {
  switch (behavior) {
    case 'allow':
      return t(locale, 'workspace.permission.behavior.allow');
    case 'ask':
      return t(locale, 'workspace.permission.behavior.ask');
    case 'deny':
      return t(locale, 'workspace.permission.behavior.deny');
  }
}

export function permissionBehaviorOptions(
  locale: Locale,
): { value: PermissionBehavior; label: string }[] {
  return PERMISSION_BEHAVIORS.map((behavior) => ({
    value: behavior,
    label: permissionBehaviorLabel(locale, behavior),
  }));
}

export interface PermissionScope {
  kind: 'channel' | 'agent';
  id: string;
}

/** The one key the shell stores each scope's rules under. */
export function permissionScopeKey(scope: PermissionScope): string {
  return `${scope.kind}:${scope.id}`;
}

/** One editable row; the editor owns the draft and converts it on save. */
export interface PermissionRuleDraft {
  tool_name: string;
  pattern: string;
  behavior: PermissionBehavior;
}

export function permissionRuleDrafts(
  rules: readonly PermissionRuleView[] | undefined,
): PermissionRuleDraft[] {
  return (rules ?? []).map((rule) => ({
    tool_name: rule.tool_name,
    pattern: rule.pattern,
    behavior: rule.behavior,
  }));
}

/** Drop fully empty rows (an "add" click that was not filled in). */
export function permissionRuleInputs(
  drafts: readonly PermissionRuleDraft[],
): PermissionRuleInput[] {
  return drafts
    .filter((draft) => draft.tool_name.trim().length > 0)
    .map((draft) => ({
      tool_name: draft.tool_name.trim(),
      pattern: draft.pattern,
      behavior: draft.behavior,
    }));
}

/**
 * The channel mode control's patch: a same-value selection writes nothing.
 */
export function channelPermissionModePatch(
  channel: ChannelView,
  mode: string,
): { permission_mode: PermissionMode } | null {
  if (!(PERMISSION_MODES as readonly string[]).includes(mode) || mode === channel.permission_mode) {
    return null;
  }
  return { permission_mode: mode as PermissionMode };
}

/**
 * The Agent override control: `follow` clears the override (null); a same-value
 * selection writes nothing.
 */
export function agentPermissionModePatch(
  agent: AgentView,
  value: string,
): { permission_mode: PermissionMode | null } | null {
  if (value === 'follow') {
    return agent.permission_mode === null ? null : { permission_mode: null };
  }
  if (!(PERMISSION_MODES as readonly string[]).includes(value)) {
    return null;
  }
  const mode = value as PermissionMode;
  return agent.permission_mode === mode ? null : { permission_mode: mode };
}
