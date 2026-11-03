import type { TaskStatus, WorkspaceView } from '@allibot/shared';

/**
 * The shell's read-only view of the one workspace reading (#27). Everything
 * here is derived from `GET /api/workspace`; the shell never keeps a second
 * source of truth and never writes.
 */

/** The three target kinds; a target id names exactly one of them. */
export type TargetKind = 'channel' | 'dm' | 'task';

/** One navigation row: the target id is the thread id (ADR 0003). */
export interface TargetNavEntry {
  targetId: string;
  kind: TargetKind;
  label: string;
  unread: number;
}

/**
 * The left navigation grouped as the product reads it: active channels and
 * DMs first, then the archived segments (a channel's `archived_at` and a DM's
 * `peer.deleted_at` are the whole archived rule), then the task list.
 */
export interface WorkspaceNav {
  channels: TargetNavEntry[];
  archivedChannels: TargetNavEntry[];
  dms: TargetNavEntry[];
  archivedDms: TargetNavEntry[];
  tasks: TargetNavEntry[];
}

function channelEntry(
  workspace: WorkspaceView,
  channel: WorkspaceView['channels'][number],
): TargetNavEntry {
  return {
    targetId: channel.id,
    kind: 'channel',
    label: channel.name,
    unread: workspace.unread_by_target[channel.id] ?? 0,
  };
}

function dmEntry(workspace: WorkspaceView, dm: WorkspaceView['dms'][number]): TargetNavEntry {
  return {
    targetId: dm.id,
    kind: 'dm',
    label: dm.peer.display_name,
    unread: workspace.unread_by_target[dm.id] ?? 0,
  };
}

function taskEntry(task: WorkspaceView['tasks'][number]): TargetNavEntry {
  return {
    targetId: task.target_id,
    kind: 'task',
    label: task.title,
    unread: task.unread_count,
  };
}

/**
 * Build the navigation. The backend already hides deleted channels; the
 * `deleted_at` filter is repeated here so a malformed reading can never put a
 * deleted row in the navigation.
 */
export function buildWorkspaceNav(workspace: WorkspaceView): WorkspaceNav {
  const channels = workspace.channels.filter((row) => row.deleted_at === null);
  const dms = workspace.dms;

  return {
    channels: channels
      .filter((row) => row.archived_at === null)
      .map((row) => channelEntry(workspace, row)),
    archivedChannels: channels
      .filter((row) => row.archived_at !== null)
      .map((row) => channelEntry(workspace, row)),
    dms: dms.filter((row) => row.peer.deleted_at === null).map((row) => dmEntry(workspace, row)),
    archivedDms: dms
      .filter((row) => row.peer.deleted_at !== null)
      .map((row) => dmEntry(workspace, row)),
    tasks: workspace.tasks.map((row) => taskEntry(row)),
  };
}

/** Every navigation entry in render order; used for the initial target. */
export function allNavEntries(nav: WorkspaceNav): TargetNavEntry[] {
  return [
    ...nav.channels,
    ...nav.dms,
    ...nav.tasks,
    ...nav.archivedChannels,
    ...nav.archivedDms,
  ];
}

/**
 * The target the shell opens on a fresh reading: the first active channel,
 * else the first active DM, else the first task, else an archived row. The
 * reading is the only input, so a reload lands on the same target.
 */
export function initialTargetId(workspace: WorkspaceView): string | null {
  return allNavEntries(buildWorkspaceNav(workspace))[0]?.targetId ?? null;
}

/** The kind of a target id, or null when the reading does not contain it. */
export function targetKind(workspace: WorkspaceView, targetId: string): TargetKind | null {
  return allNavEntries(buildWorkspaceNav(workspace)).find(
    (entry) => entry.targetId === targetId,
  )?.kind ?? null;
}

/** The right context column's reading for the selected target. */
export interface TargetContextView {
  targetId: string;
  kind: TargetKind;
  label: string;
  description: string | null;
  unread: number;
  taskStatus: TaskStatus | null;
}

/**
 * The context shown for the selected target. It is a projection of the
 * workspace reading only — opening it performs no request (the member panel
 * details arrive with their own ticket).
 */
export function readTargetContext(
  workspace: WorkspaceView,
  targetId: string | null,
): TargetContextView | null {
  if (targetId === null) {
    return null;
  }

  const entry = allNavEntries(buildWorkspaceNav(workspace)).find(
    (candidate) => candidate.targetId === targetId,
  );
  if (entry === undefined) {
    return null;
  }

  const channel = workspace.channels.find((row) => row.id === targetId);
  if (channel !== undefined) {
    return {
      targetId,
      kind: 'channel',
      label: channel.name,
      description: channel.description === '' ? null : channel.description,
      unread: entry.unread,
      taskStatus: null,
    };
  }

  const dm = workspace.dms.find((row) => row.id === targetId);
  if (dm !== undefined) {
    return {
      targetId,
      kind: 'dm',
      label: dm.peer.display_name,
      description: null,
      unread: entry.unread,
      taskStatus: null,
    };
  }

  const task = workspace.tasks.find((row) => row.target_id === targetId);
  if (task !== undefined) {
    return {
      targetId,
      kind: 'task',
      label: task.title,
      description: null,
      unread: task.unread_count,
      taskStatus: task.status,
    };
  }

  return null;
}
