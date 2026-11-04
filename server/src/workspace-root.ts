import type Database from 'better-sqlite3';
import {
  accessSync,
  constants,
  existsSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import {
  WORKSPACE_BACKENDS,
  type WorkspaceBackend,
  type WorkspaceStatusReason,
  type WorkspaceStatusView,
} from '@allibot/shared';
import { ApiFailure } from './api-error.js';
import { getDockerWorkspaceManager } from './docker-workspace.js';
import { readTargetKind } from './sql.js';

/**
 * 工作区项目根 / 工作区后端 / Agent 家目录 (#42 / D5.1 / D5.2 / D5.3 / D5.7).
 *
 * One module owns the root boundary facts:
 * - the write-path validation (absolute, existing, directory, canonical real
 *   path outside the data directory and every Agent home);
 * - the derived Agent-home path (`<home>/agents/<member_id>/`), used both by
 *   the root rejection and by the read-only `skills/` second root;
 * - the target-context availability reading (`workspace_status`);
 * - the binding a round needs to decide whether it has local project tools.
 *
 * The project root is never copied into the data directory and never enters
 * the whole-directory backup: this module only stores and checks a path.
 */

export interface TargetWorkspaceBinding {
  targetKind: 'channel' | 'dm' | 'task';
  /** The owning channel; `null` for a DM. */
  channelId: string | null;
  /** The canonical project root, or null when the channel has none. */
  root: string | null;
  /** The channel's default backend (local when there is no channel). */
  backend: WorkspaceBackend;
  allowLocalShell: 0 | 1;
}

/**
 * The process-level home root (`~/.allibot/`); `--home-dir` /
 * `allibot_HOME_DIR` override it (D5.2). An empty override is treated as
 * absent rather than resolving to the process cwd.
 */
export function workspaceHomeRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.allibot_HOME_DIR;
  const homeRoot =
    override !== undefined && override.length > 0
      ? override
      : path.join(env.HOME ?? homedir(), '.allibot');
  return path.resolve(homeRoot);
}

/** `~/.allibot/agents/` — the parent of every derived Agent home. */
export function agentsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(workspaceHomeRoot(env), 'agents');
}

/**
 * 成员家目录 (Agent Home): derived from `member_id`, never stored. #43 creates
 * it; this ticket only reads the `skills/` second root below it.
 */
export function agentHomeRoot(memberId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentsRoot(env), memberId);
}

/** The member's read-only skills second root; absent until #43 creates it. */
export function agentSkillsRoot(memberId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentHomeRoot(memberId, env), 'skills');
}

/**
 * The project-root write path (D5.1). A non-null `workspace_root` must be an
 * absolute existing directory whose realpath is outside the data directory and
 * outside every Agent home. The stored value is that realpath, so a symlink
 * input is accepted only when its target is inside the allowed area.
 */
export function validateWorkspaceRoot(
  value: unknown,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw ApiFailure.validation('workspace_root must be an absolute directory path or null', {
      field: 'workspace_root',
    });
  }
  if (!path.isAbsolute(value)) {
    throw ApiFailure.validation('workspace_root must be an absolute path', {
      field: 'workspace_root',
      value,
    });
  }

  let canonical: string;
  try {
    canonical = realpathSync(value);
  } catch {
    throw ApiFailure.validation('workspace_root does not exist', {
      field: 'workspace_root',
      value,
    });
  }
  let directory = false;
  try {
    directory = statSync(canonical).isDirectory();
  } catch {
    directory = false;
  }
  if (!directory) {
    throw ApiFailure.validation('workspace_root is not a directory', {
      field: 'workspace_root',
      value,
    });
  }

  const dataRoot = canonicalizeLoose(dataDir);
  if (isInsideOrEqual(canonical, dataRoot)) {
    throw ApiFailure.validation(
      'workspace_root must not be inside the data directory',
      { field: 'workspace_root', value },
    );
  }
  const agentRoots = canonicalizeLoose(agentsRoot(env));
  if (isInsideOrEqual(canonical, agentRoots)) {
    throw ApiFailure.validation(
      'workspace_root must not be inside an Agent home',
      { field: 'workspace_root', value },
    );
  }
  return canonical;
}

/** The runtime readability of a stored root (D5.1: the canonical path itself). */
export function workspaceRootAvailability(
  root: string | null,
): { available: boolean; reason: WorkspaceStatusReason | null } {
  if (root === null) {
    return { available: false, reason: 'workspace-root-missing' };
  }
  try {
    const canonical = realpathSync(root);
    if (canonical !== root) {
      // The configured canonical root no longer names itself (for example the
      // directory was replaced by a symlink): the workspace is not the one the
      // owner configured, so this is not a fallback opportunity.
      return { available: false, reason: 'workspace-root-missing' };
    }
    if (!statSync(canonical).isDirectory()) {
      return { available: false, reason: 'workspace-root-missing' };
    }
    accessSync(canonical, constants.R_OK | constants.X_OK);
    return { available: true, reason: null };
  } catch {
    return { available: false, reason: 'workspace-root-missing' };
  }
}

/** The read model of one target's workspace binding; null when the target is unknown. */
export function readTargetWorkspaceBinding(
  db: Database.Database,
  targetId: string,
): TargetWorkspaceBinding | null {
  const kind = readTargetKind(db, targetId);
  if (kind === null) {
    return null;
  }
  if (kind === 'dm') {
    return { targetKind: 'dm', channelId: null, root: null, backend: 'local', allowLocalShell: 0 };
  }
  if (kind === 'channel') {
    const row = db
      .prepare(
        'SELECT id, workspace_root, workspace_backend, allow_local_shell FROM channel WHERE id = ?',
      )
      .get(targetId) as ChannelWorkspaceRow | undefined;
    return channelBinding('channel', row);
  }
  const row = db
    .prepare(
      `SELECT c.id, c.workspace_root, c.workspace_backend, c.allow_local_shell
         FROM task t JOIN channel c ON c.id = t.channel_id
        WHERE t.target_id = ?`,
    )
    .get(targetId) as ChannelWorkspaceRow | undefined;
  return channelBinding('task', row);
}

/** The raw `agent_config.workspace_backend` override (NULL = follow channel). */
export function readWorkspaceBackendOverride(
  db: Database.Database,
  memberId: string,
): WorkspaceBackend | null {
  const row = db
    .prepare('SELECT workspace_backend FROM agent_config WHERE member_id = ?')
    .get(memberId) as { workspace_backend: string | null } | undefined;
  return parseBackend(row?.workspace_backend);
}

/**
 * The target-context workspace status for one member (D5.7): an Agent override
 * replaces the channel default; the availability reason is the same for every
 * member sharing the target's root. Docker availability is read from the
 * process manager's snapshot plus this target's recorded failure — never from
 * a global status point, so the same Agent can be available in one channel and
 * unavailable in another.
 */
export function readWorkspaceStatus(
  binding: TargetWorkspaceBinding,
  member: { id: string; kind: string },
  db: Database.Database,
  targetId: string,
): WorkspaceStatusView {
  const override =
    member.kind === 'agent' ? readWorkspaceBackendOverride(db, member.id) : null;
  const backend = override ?? binding.backend;
  if (backend === 'docker') {
    // A Docker workspace mounts the project root at /workspace, so a missing
    // root is the root reason, not a Docker daemon reason.
    const root = workspaceRootAvailability(binding.root);
    if (!root.available) {
      return { backend, available: false, reason: 'workspace-root-missing' };
    }
    const status = getDockerWorkspaceManager()?.statusFor({
      memberId: member.id,
      targetId,
    }) ?? { available: false, reason: 'docker-unavailable' as const };
    return { backend, available: status.available, reason: status.reason };
  }
  const root = workspaceRootAvailability(binding.root);
  return { backend, available: root.available, reason: root.reason };
}

/**
 * The round's workspace decision. It returns:
 * - `null` for a DM or a local channel / task with no project root: the round
 *   runs without project file tools and without a shell (D5.1);
 * - the workspace context when a local root is configured and usable;
 * - throws a readable failure when a configured root disappeared or when the
 *   effective backend is Docker: zero tools, no local fallback (D5.3 / D5.7).
 */
export function readRoundWorkspaceFailure(
  db: Database.Database,
  memberId: string,
  targetId: string,
): { backend: WorkspaceBackend; reason: WorkspaceStatusReason } | null {
  const binding = readTargetWorkspaceBinding(db, targetId);
  if (binding === null || binding.targetKind === 'dm') {
    return null;
  }
  const override = readWorkspaceBackendOverride(db, memberId);
  const backend = override ?? binding.backend;
  if (backend === 'docker') {
    // Docker mounts the project root at /workspace; a missing root is the root
    // reason, not a daemon reason. When the root is usable, the manager's
    // snapshot answers daemon / image / consent, and the round's `prepare`
    // answers container creation.
    const root = workspaceRootAvailability(binding.root);
    if (!root.available) {
      return { backend, reason: 'workspace-root-missing' };
    }
    const status = getDockerWorkspaceManager()?.statusFor({
      memberId,
      targetId,
    }) ?? { available: false, reason: 'docker-unavailable' as const };
    if (status.available) {
      return null;
    }
    return { backend, reason: status.reason ?? 'docker-unavailable' };
  }
  if (binding.root === null) {
    return null;
  }
  const availability = workspaceRootAvailability(binding.root);
  if (!availability.available) {
    return { backend, reason: availability.reason ?? 'workspace-root-missing' };
  }
  return null;
}

/** The round's usable local workspace context, or null for DM / no-root rounds. */
export function readRoundWorkspaceBinding(
  db: Database.Database,
  memberId: string,
  targetId: string,
): { root: string; allowLocalShell: 0 | 1; skillsRoot: string | null } | null {
  const binding = readTargetWorkspaceBinding(db, targetId);
  if (binding === null || binding.targetKind === 'dm' || binding.root === null) {
    return null;
  }
  const override = readWorkspaceBackendOverride(db, memberId);
  if ((override ?? binding.backend) !== 'local') {
    return null;
  }
  const skillsRoot = agentSkillsRoot(memberId);
  return {
    root: binding.root,
    allowLocalShell: binding.allowLocalShell,
    skillsRoot: existsSync(skillsRoot) ? realpathSync(skillsRoot) : null,
  };
}

interface ChannelWorkspaceRow {
  id: string;
  workspace_root: string | null;
  workspace_backend: string;
  allow_local_shell: number;
}

function channelBinding(
  targetKind: 'channel' | 'task',
  row: ChannelWorkspaceRow | undefined,
): TargetWorkspaceBinding {
  return {
    targetKind,
    channelId: row?.id ?? null,
    root: row?.workspace_root ?? null,
    backend: parseBackend(row?.workspace_backend) ?? 'local',
    allowLocalShell: row?.allow_local_shell === 1 ? 1 : 0,
  };
}

function parseBackend(value: string | null | undefined): WorkspaceBackend | null {
  return typeof value === 'string' && (WORKSPACE_BACKENDS as readonly string[]).includes(value)
    ? (value as WorkspaceBackend)
    : null;
}

/** Lexical containment on canonical absolute paths. */
export function isInsideOrEqual(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

/**
 * `realpath` for a path that may not exist yet: resolve the nearest existing
 * ancestor and append the missing segments. The write-path checks stay sound
 * when the data directory / home root sits under a symlinked temp directory
 * (macOS `/var` -> `/private/var`).
 */
function canonicalizeLoose(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return path.resolve(target);
    }
    missing.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSync(current), ...missing);
}
