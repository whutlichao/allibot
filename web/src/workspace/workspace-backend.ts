import {
  WORKSPACE_BACKENDS,
  t,
  type AgentView,
  type Locale,
  type WorkspaceBackend,
} from '@allibot/shared';

/**
 * 工作区后端的呈现与写路径 (#49 / D5.3). The channel select and the Agent
 * override share one vocabulary: `local` / `docker`, and the Agent's `null` is
 * the explicit "follow the channel" choice. A same-value choice sends nothing
 * (D2.4); an invalid select value is ignored rather than written.
 */

export function workspaceBackendLabel(locale: Locale, backend: WorkspaceBackend): string {
  return backend === 'local'
    ? t(locale, 'channel.config.workspace.backend.local')
    : t(locale, 'channel.config.workspace.backend.docker');
}

export function workspaceBackendOptions(
  locale: Locale,
): { value: WorkspaceBackend; label: string }[] {
  return WORKSPACE_BACKENDS.map((backend) => ({
    value: backend,
    label: workspaceBackendLabel(locale, backend),
  }));
}

/** The Agent override write; `follow` is the explicit null (D2.2). */
export function agentBackendChangePatch(
  agent: AgentView,
  value: string,
): { workspace_backend: WorkspaceBackend | null } | null {
  const next =
    value === 'follow'
      ? null
      : (WORKSPACE_BACKENDS as readonly string[]).includes(value)
        ? (value as WorkspaceBackend)
        : undefined;
  if (next === undefined) {
    return null;
  }
  if (next === agent.workspace_backend) {
    return null;
  }
  return { workspace_backend: next };
}
