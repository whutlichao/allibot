import { randomUUID } from 'node:crypto';
import {
  CHANNEL_MODES,
  WORKSPACE_BACKENDS,
  type ChannelMode,
  type ChannelView,
  type WebAccessTier,
  type WorkspaceBackend,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { publishWorkspaceChanged } from './events.js';
import { OWNER_ID_SUBQUERY } from './sql.js';
import {
  addLeaderToTaskTargets,
  assertAssignableTeamLeader,
  readTeamView,
} from './team.js';
import {
  DEFAULT_PERMISSION_MODE,
  isWebAccessTier,
  requirePermissionMode,
  requireWebAccessTier,
} from './permissions.js';
import { validateWorkspaceRoot } from './workspace-root.js';

/** The allowed response budget upper bounds; the default is 3. */
export const RESPONSE_BUDGET_LIMITS = [3, 5, 10] as const;
export const DEFAULT_RESPONSE_BUDGET_LIMIT = 3;

export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  mode: string;
  team_leader_member_id: string | null;
  workspace_root: string | null;
  workspace_backend: string;
  allow_local_shell: number;
  permission_mode: string;
  web_access: string | null;
  docker_egress: number;
  response_budget_limit: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ChannelWriteInput {
  name?: string;
  description?: string;
  responseBudgetLimit?: number;
  mode?: ChannelMode;
  /** `team_leader_member_id` was present in the body (possibly as null). */
  leaderProvided?: boolean;
  teamLeaderMemberId?: string | null;
  /** `workspace_root` was present in the body; explicit null clears it. */
  workspaceRootProvided?: boolean;
  workspaceRoot?: string | null;
  workspaceBackend?: WorkspaceBackend;
  permissionMode?: import('@allibot/shared').PermissionMode;
  /** The raw tier; `null` un-configures it (an omitted field is `undefined`). */
  webAccess?: WebAccessTier | null;
  allowLocalShell?: 0 | 1;
  dockerEgress?: 0 | 1;
}

const CHANNEL_SELECT = `
SELECT id, name, description, mode, team_leader_member_id, workspace_root,
       workspace_backend, allow_local_shell, permission_mode, web_access, docker_egress,
       response_budget_limit, archived_at, deleted_at, created_at, updated_at
FROM channel`;

const FIELD_KEYS = {
  name: 'name',
  description: 'description',
  mode: 'mode',
  team_leader_member_id: 'teamLeaderMemberId',
  workspace_root: 'workspaceRoot',
  workspace_backend: 'workspaceBackend',
  permission_mode: 'permissionMode',
  web_access: 'webAccess',
  allow_local_shell: 'allowLocalShell',
  docker_egress: 'dockerEgress',
  response_budget_limit: 'responseBudgetLimit',
} as const;

type FieldKey = keyof typeof FIELD_KEYS;

export function listChannels(
  db: Database.Database,
  env: NodeJS.ProcessEnv = process.env,
): ChannelView[] {
  const rows = db
    .prepare(`${CHANNEL_SELECT} WHERE deleted_at IS NULL ORDER BY created_at, rowid`)
    .all() as ChannelRow[];
  return rows.map((row) => toChannelView(db, row, env));
}

export function getChannel(
  db: Database.Database,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ChannelView {
  return readLiveChannel(db, id, env);
}

/**
 * A channel is always created autonomous. Team is an explicit opt-in written by
 * PATCH, and the leader must already be a channel member — which cannot be true
 * in the same transaction that creates the channel and its owner membership.
 */
export function createChannel(
  db: Database.Database,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): ChannelView {
  const input = parseCreateInput(body);
  const create = db.transaction((): string => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, team_leader_member_id, workspace_root,
          workspace_backend, allow_local_shell, response_budget_limit,
          archived_at, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'autonomous', NULL, NULL, 'local', 0, ?, NULL, NULL, ?, ?)`,
    ).run(
      id,
      input.name,
      input.description ?? '',
      input.responseBudgetLimit,
      now,
      now,
    );
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(id);
    db.prepare(
      `INSERT INTO target_member (target_id, member_id) VALUES (?, ${OWNER_ID_SUBQUERY})`,
    ).run(id);
    return id;
  });
  const id = create();
  // After the transaction returned: a rolled-back create announces nothing.
  publishWorkspaceChanged({ source: 'channel' });
  return readLiveChannel(db, id, env);
}

/**
 * The channel configuration write (D2.2 / D2.4 / D3.1). Omitted fields mean
 * "unchanged"; an explicit `null` leader is the one nullable value. Switching
 * to team requires a leader, switching back to autonomous clears it, and a
 * leader change also writes the new leader into every task target of the
 * channel in this same transaction. A same-value replay writes no new fact and
 * returns the same reading (the `updated_at` stamp does not move).
 */
export function updateChannel(
  db: Database.Database,
  id: string,
  body: unknown,
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): ChannelView {
  const patch = parsePatchInput(body);
  const update = db.transaction(
    (): { found: boolean; changed: boolean; teamChanged: boolean } => {
      const current = readChannelRow(db, id);
      if (current === undefined) {
        return { found: false, changed: false, teamChanged: false };
      }
      assertChannelWritable(current);

      const mode = patch.mode ?? (current.mode as ChannelMode);
      let leader: string | null;
      if (mode === 'team') {
        if (patch.leaderProvided === true) {
          if (patch.teamLeaderMemberId === null || patch.teamLeaderMemberId === undefined) {
            throw ApiFailure.validation(
              'a team channel requires a team_leader_member_id',
              { field: 'team_leader_member_id' },
            );
          }
          leader = patch.teamLeaderMemberId;
          assertAssignableTeamLeader(db, id, leader);
        } else {
          leader = current.team_leader_member_id;
          if (leader === null) {
            throw ApiFailure.validation(
              'a team channel requires a team_leader_member_id',
              { field: 'team_leader_member_id' },
            );
          }
        }
      } else {
        if (patch.leaderProvided === true && patch.teamLeaderMemberId !== null) {
          throw ApiFailure.validation(
            'an autonomous channel cannot carry a team_leader_member_id',
            { field: 'team_leader_member_id', value: patch.teamLeaderMemberId },
          );
        }
        leader = null;
      }

      const nextName = patch.name ?? current.name;
      const nextDescription = patch.description ?? current.description;
      const nextBudget = patch.responseBudgetLimit ?? current.response_budget_limit;
      const nextBackend = patch.workspaceBackend ?? (current.workspace_backend as WorkspaceBackend);
      const nextPermissionMode = patch.permissionMode ?? current.permission_mode;
      const nextWebAccess = patch.webAccess !== undefined ? patch.webAccess : current.web_access;
      const nextAllowLocalShell = patch.allowLocalShell ?? (current.allow_local_shell === 1 ? 1 : 0);
      const nextDockerEgress = patch.dockerEgress ?? (current.docker_egress === 1 ? 1 : 0);
      const nextRoot = patch.workspaceRootProvided === true
        ? (patch.workspaceRoot === null
            ? null
            : validateWorkspaceRoot(patch.workspaceRoot, dataDir, env))
        : current.workspace_root;
      const modeChanged = mode !== current.mode;
      const leaderChanged = leader !== current.team_leader_member_id;
      const changed =
        modeChanged ||
        leaderChanged ||
        nextName !== current.name ||
        nextDescription !== current.description ||
        nextBudget !== current.response_budget_limit ||
        nextRoot !== current.workspace_root ||
        nextBackend !== current.workspace_backend ||
        nextPermissionMode !== current.permission_mode ||
        nextWebAccess !== current.web_access ||
        nextAllowLocalShell !== current.allow_local_shell ||
        nextDockerEgress !== current.docker_egress;
      if (!changed) {
        return { found: true, changed: false, teamChanged: false };
      }

      db.prepare(
        `UPDATE channel
            SET name = ?, description = ?, mode = ?, team_leader_member_id = ?,
                workspace_root = ?, workspace_backend = ?, permission_mode = ?,
                allow_local_shell = ?, web_access = ?, docker_egress = ?,
                response_budget_limit = ?, updated_at = ?
          WHERE id = ?`,
      ).run(
        nextName,
        nextDescription,
        mode,
        leader,
        nextRoot,
        nextBackend,
        nextPermissionMode,
        nextAllowLocalShell,
        nextWebAccess,
        nextDockerEgress,
        nextBudget,
        new Date().toISOString(),
        id,
      );
      // The leader change and its task-target membership are one fact: a task
      // thread without the leader in `target_member` would have nobody to wake.
      if (leaderChanged && leader !== null) {
        addLeaderToTaskTargets(db, id, leader);
      }
      return { found: true, changed: true, teamChanged: modeChanged || leaderChanged };
    },
  );
  const result = update();
  if (!result.found) {
    throw notFound(id);
  }
  if (result.changed) {
    // Team configuration changes reuse `workspace.changed` with source=team
    // (D2.5); an ordinary name / description / budget edit stays `channel`.
    publishWorkspaceChanged({ source: result.teamChanged ? 'team' : 'channel' });
  }
  return readLiveChannel(db, id, env);
}

/** Archive is idempotent: a second call keeps the first `archived_at`. */
export function archiveChannel(
  db: Database.Database,
  id: string,
  env: NodeJS.ProcessEnv = process.env,
): ChannelView {
  const archive = db.transaction((): boolean => {
    const current = readChannelRow(db, id);
    if (current === undefined) {
      return false;
    }
    if (current.archived_at === null) {
      const now = new Date().toISOString();
      db.prepare('UPDATE channel SET archived_at = ?, updated_at = ? WHERE id = ?').run(
        now,
        now,
        id,
      );
    }
    return true;
  });
  if (!archive()) {
    throw notFound(id);
  }
  publishWorkspaceChanged({ source: 'channel' });
  return readLiveChannel(db, id, env);
}

/**
 * Soft delete writes `deleted_at` and clears `archived_at`; every channel row,
 * the target shadow row and the target_member rows stay in place. A second
 * delete is a 404, not an idempotent success.
 */
export function deleteChannel(db: Database.Database, id: string): void {
  const now = new Date().toISOString();
  const result = db
    .prepare(
      `UPDATE channel SET deleted_at = ?, archived_at = NULL, updated_at = ?
        WHERE id = ? AND deleted_at IS NULL`,
    )
    .run(now, now, id);
  if (result.changes !== 1) {
    throw notFound(id);
  }
  publishWorkspaceChanged({ source: 'channel' });
}

/** The two lifecycle stamps every reader of a channel row asks about. */
export interface ChannelLiveness {
  archived_at: string | null;
  deleted_at: string | null;
}

/** The channel lifecycle row, or undefined when the channel does not exist. */
export function readChannelLiveness(
  db: Database.Database,
  channelId: string,
): ChannelLiveness | undefined {
  return db
    .prepare('SELECT archived_at, deleted_at FROM channel WHERE id = ?')
    .get(channelId) as ChannelLiveness | undefined;
}

export type ChannelReadState = 'live' | 'archived' | 'deleted';

/**
 * The one reading of the lifecycle stamps: deleted wins over archived, and a
 * missing row is deleted. Reminders (skip a deleted channel, deliver on an
 * archived one) and the workspace unread reading (count archived channels but
 * not deleted ones) share this instead of each spelling out the comparison.
 */
export function channelReadState(channel: ChannelLiveness | undefined): ChannelReadState {
  if (channel === undefined || channel.deleted_at !== null) {
    return 'deleted';
  }
  return channel.archived_at === null ? 'live' : 'archived';
}

/**
 * The shared readability guard for every channel-backed endpoint. Tickets that
 * add message and task writes reuse it so archived/deleted channels are
 * rejected in one place.
 */
export function assertChannelReadable(db: Database.Database, id: string): ChannelRow {
  const row = readChannelRow(db, id);
  if (row === undefined) {
    throw notFound(id);
  }
  return row;
}

/** The shared write guard: an archived or deleted channel takes no config writes. */
export function assertChannelWritable(row: ChannelRow): void {
  if (row.deleted_at !== null) {
    throw notFound(row.id);
  }
  if (row.archived_at !== null) {
    throw ApiFailure.validation(`channel is archived: ${row.id}`);
  }
}

function readLiveChannel(
  db: Database.Database,
  id: string,
  env: NodeJS.ProcessEnv,
): ChannelView {
  return toChannelView(db, assertChannelReadable(db, id), env);
}

function readChannelRow(db: Database.Database, id: string): ChannelRow | undefined {
  return db.prepare(`${CHANNEL_SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | ChannelRow
    | undefined;
}

function notFound(id: string): ApiFailure {
  return ApiFailure.notFound(`channel not found: ${id}`);
}

/** A channel is created autonomous; team is written by PATCH (D3.1). */
function parseCreateInput(body: unknown): ChannelWriteInput & { name: string } {
  const record = asObject(body);
  rejectUnknownFields(record);
  const name = requireName(record['name']);
  if (record['mode'] !== undefined) {
    requireAutonomousCreateMode(record['mode']);
  }
  if (record['team_leader_member_id'] !== undefined) {
    throw ApiFailure.validation(
      'team configuration is written by PATCH /api/channels/{id}, not at create time',
      { field: 'team_leader_member_id' },
    );
  }
  return {
    name,
    description: optionalString(record, 'description') ?? '',
    responseBudgetLimit: optionalBudget(record) ?? DEFAULT_RESPONSE_BUDGET_LIMIT,
  };
}

function parsePatchInput(body: unknown): ChannelWriteInput {
  const record = asObject(body);
  rejectUnknownFields(record);
  const patch: ChannelWriteInput = {};
  if (record['mode'] !== undefined) {
    patch.mode = requireMode(record['mode']);
  }
  if (record['team_leader_member_id'] !== undefined) {
    patch.leaderProvided = true;
    patch.teamLeaderMemberId = optionalMemberId(record['team_leader_member_id']);
  }
  if (record['name'] !== undefined) {
    patch.name = requireName(record['name']);
  }
  if (record['workspace_root'] !== undefined) {
    patch.workspaceRootProvided = true;
    patch.workspaceRoot = optionalWorkspaceRoot(record['workspace_root']);
  }
  if (record['workspace_backend'] !== undefined) {
    patch.workspaceBackend = requireWorkspaceBackend(record['workspace_backend']);
  }
  if (record['permission_mode'] !== undefined) {
    patch.permissionMode = requirePermissionMode(record['permission_mode']);
  }
  if (record['web_access'] !== undefined) {
    patch.webAccess = optionalWebAccessTier(record['web_access']);
  }
  if (record['allow_local_shell'] !== undefined) {
    patch.allowLocalShell = requireBinary(record['allow_local_shell'], 'allow_local_shell');
  }
  if (record['docker_egress'] !== undefined) {
    patch.dockerEgress = requireBinary(record['docker_egress'], 'docker_egress');
  }
  const description = optionalString(record, 'description');
  if (description !== undefined) {
    patch.description = description;
  }
  const budget = optionalBudget(record);
  if (budget !== undefined) {
    patch.responseBudgetLimit = budget;
  }
  return patch;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>): void {
  for (const key of Object.keys(record)) {
    if (!Object.hasOwn(FIELD_KEYS, key)) {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
}

function requireName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('name must be a non-empty string');
  }
  return value.trim();
}

function optionalString(record: Record<string, unknown>, key: FieldKey): string | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw ApiFailure.validation(`${key} must be a string`);
  }
  return value;
}

function requireMode(value: unknown): ChannelMode {
  if (typeof value !== 'string' || !(CHANNEL_MODES as readonly string[]).includes(value)) {
    throw ApiFailure.validation(`mode must be one of: ${CHANNEL_MODES.join(', ')}`, {
      field: 'mode',
      value,
    });
  }
  return value as ChannelMode;
}

function requireAutonomousCreateMode(value: unknown): void {
  if (value !== 'autonomous') {
    throw ApiFailure.validation(
      'a channel is created autonomous; PATCH the channel to switch it to team',
      { field: 'mode', value },
    );
  }
}

/** `null` is the stored "unconfigured" value; a string must be one of three tiers. */
function optionalWebAccessTier(value: unknown): WebAccessTier | null {
  return value === null ? null : requireWebAccessTier(value);
}

/** The explicit local-shell switch (#46 / D5.4): exactly 0 or 1. */
function requireBinary(value: unknown, field: string): 0 | 1 {
  if (value !== 0 && value !== 1) {
    throw ApiFailure.validation(`${field} must be 0 or 1`, { field, value });
  }
  return value;
}

/** `null` clears the leader; a non-empty string names the new one. */
function optionalMemberId(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('team_leader_member_id must be a member id or null', {
      field: 'team_leader_member_id',
      value,
    });
  }
  return value.trim();
}

function optionalWorkspaceRoot(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.length === 0) {
    throw ApiFailure.validation('workspace_root must be an absolute directory path or null', {
      field: 'workspace_root',
      value,
    });
  }
  return value;
}

function requireWorkspaceBackend(value: unknown): WorkspaceBackend {
  if (
    typeof value !== 'string' ||
    !(WORKSPACE_BACKENDS as readonly string[]).includes(value)
  ) {
    throw ApiFailure.validation(
      `workspace_backend must be one of: ${WORKSPACE_BACKENDS.join(', ')}`,
      { field: 'workspace_backend', value },
    );
  }
  return value as WorkspaceBackend;
}

function optionalBudget(record: Record<string, unknown>): number | undefined {
  const value = record['response_budget_limit'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !(RESPONSE_BUDGET_LIMITS as readonly number[]).includes(value)) {
    throw ApiFailure.validation(
      `response_budget_limit must be one of: ${RESPONSE_BUDGET_LIMITS.join(', ')}`,
      { field: 'response_budget_limit', value },
    );
  }
  return value;
}

function toChannelView(
  db: Database.Database,
  row: ChannelRow,
  env: NodeJS.ProcessEnv,
): ChannelView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode as ChannelMode,
    team: readTeamView(
      db,
      row.id,
      { mode: row.mode, team_leader_member_id: row.team_leader_member_id },
      env,
    ),
    workspace: {
      root: row.workspace_root,
      backend: row.workspace_backend as WorkspaceBackend,
      allow_local_shell: row.allow_local_shell === 1 ? 1 : 0,
    },
    permission_mode:
      typeof row.permission_mode === 'string'
        ? (row.permission_mode as ChannelView['permission_mode'])
        : DEFAULT_PERMISSION_MODE,
    web_access: isWebAccessTier(row.web_access) ? row.web_access : null,
    docker_egress: row.docker_egress === 1 ? 1 : 0,
    response_budget_limit: row.response_budget_limit,
    archived_at: row.archived_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
