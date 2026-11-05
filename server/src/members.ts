import { randomUUID } from 'node:crypto';
import {
  AGENT_PROVIDERS,
  WORKSPACE_BACKENDS,
  type AgentView,
  type OwnerView,
  type PermissionMode,
  type WebAccessTier,
  type WorkspaceBackend,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ensureAgentHome } from './agent-home.js';
import { ApiFailure } from './api-error.js';
import { publishMemberStatus, publishWorkspaceChanged } from './events.js';
import {
  DEFAULT_PERMISSION_MODE,
  isPermissionMode,
  isWebAccessTier,
  optionalWebAccessTier,
  requirePermissionMode,
  resolveWebAccessTier,
} from './permissions.js';
import { credentialStatus, parseModelIdentifier } from './providers.js';
import type { InFlightRounds } from './rounds.js';
import { readStatusPoint } from './status.js';
import { agentHomeRoot } from './workspace-root.js';

/**
 * Built-in agent_config defaults. The context window matches the spec's
 * normal-round window (the most recent 40 messages); the other two have no
 * specified value and are chosen once here so every Agent starts the same.
 */
export const AGENT_DEFAULTS = {
  contextWindow: 40,
  compressionThreshold: 0.8,
  maxIterations: 10,
} as const;

export const AVATAR_SLOT_COUNT = 5;

/**
 * The one read-path visibility predicate for member-backed reads. Every read
 * that must hide soft-deleted members (Agent list, channel members, mention
 * candidates, status points, search) goes through this helper, so the filter
 * has a single definition to change if the rule ever moves.
 */
export function liveMemberClause(alias = 'member'): string {
  return `${alias}.deleted_at IS NULL`;
}

/**
 * The one human row, read by kind rather than by display name or list
 * position. The owner's read position is the unread badge's baseline, and the
 * workspace reading returns this same row as its `owner`.
 */
export function readOwner(db: Database.Database): OwnerView {
  const row = db
    .prepare("SELECT id, display_name, avatar_slot FROM member WHERE kind = 'owner'")
    .get() as { id: string; display_name: string; avatar_slot: number } | undefined;
  if (row === undefined) {
    throw new Error('owner row is missing');
  }
  return {
    id: row.id,
    kind: 'owner',
    display_name: row.display_name,
    avatar_slot: row.avatar_slot,
  };
}

export function readOwnerId(db: Database.Database): string {
  return readOwner(db).id;
}

interface AgentRow {
  id: string;
  display_name: string;
  avatar_slot: number;
  deleted_at: string | null;
  created_at: string;
  role: string;
  model: string | null;
  system_prompt: string;
  enabled: number;
  context_window: number;
  compression_threshold: number;
  max_iterations: number;
  auto_claim: number;
  workspace_backend: string | null;
  permission_mode: string | null;
  web_access: string | null;
}

const AGENT_SELECT = `
SELECT m.id,
       m.display_name,
       m.avatar_slot,
       m.deleted_at,
       m.created_at,
       c.role,
       c.model,
       c.system_prompt,
       c.enabled,
       c.context_window,
       c.compression_threshold,
       c.max_iterations,
       c.auto_claim,
       c.workspace_backend,
       c.permission_mode,
       c.web_access
FROM member m
JOIN agent_config c ON c.member_id = m.id
WHERE m.kind = 'agent'`;

export function listAgents(
  db: Database.Database,
  options: {
    includeDeleted: boolean;
    env?: NodeJS.ProcessEnv;
    /** The process-local in-flight registry the status point reads. */
    inFlight: InFlightRounds;
  },
): AgentView[] {
  const visibility = options.includeDeleted ? '' : ` AND ${liveMemberClause('m')}`;
  const rows = db
    .prepare(`${AGENT_SELECT}${visibility} ORDER BY m.created_at, m.rowid`)
    .all() as AgentRow[];
  const env = options.env ?? process.env;
  return rows.map((row) => toAgentView(db, row, env, options.inFlight));
}

export function getAgent(
  db: Database.Database,
  id: string,
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): AgentView | null {
  const row = db
    .prepare(`${AGENT_SELECT} AND m.id = ? AND ${liveMemberClause('m')}`)
    .get(id) as AgentRow | undefined;
  return row === undefined ? null : toAgentView(db, row, env, inFlight);
}

export function createAgent(
  db: Database.Database,
  body: unknown,
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): AgentView {
  const input = parseCreateInput(body);
  const create = db.transaction((): string => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
       VALUES (?, 'agent', ?, ?, NULL, ?)`,
    ).run(id, input.displayName, nextAvatarSlot(db), now);
    db.prepare(
      `INSERT INTO agent_config
         (member_id, role, model, system_prompt, enabled, context_window,
          compression_threshold, max_iterations, auto_claim)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.role,
      input.model,
      input.systemPrompt,
      input.enabled,
      input.contextWindow,
      input.compressionThreshold,
      input.maxIterations,
      input.autoClaim,
    );
    // 家目录 (#43 / D5.2): created with the Agent, derived from the generated
    // id, and nothing under it. Creating it inside the transaction means a
    // failed home creation rolls the member row back instead of leaving an
    // Agent that has no home.
    ensureAgentHome(id, env);
    return id;
  });
  const id = create();
  const agent = getAgent(db, id, env, inFlight);
  if (agent === null) {
    throw new Error('created Agent could not be read back');
  }
  // The Agent list and the status points both moved; the frames carry the
  // committed facts only.
  publishWorkspaceChanged({ source: 'agent' });
  publishMemberStatus({ memberId: agent.id, status: agent.status });
  return agent;
}

export function updateAgent(
  db: Database.Database,
  id: string,
  body: unknown,
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): AgentView {
  const patch = parsePatchInput(body);
  const update = db.transaction((): boolean => {
    const current = db
      .prepare(`SELECT c.* FROM agent_config c JOIN member m ON m.id = c.member_id
                WHERE m.id = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}`)
      .get(id) as AgentRow | undefined;
    if (current === undefined) {
      return false;
    }
    db.prepare(
      `UPDATE agent_config
          SET role = ?, model = ?, system_prompt = ?, enabled = ?, context_window = ?,
              compression_threshold = ?, max_iterations = ?, auto_claim = ?,
              workspace_backend = ?, permission_mode = ?, web_access = ?
        WHERE member_id = ?`,
    ).run(
      patch.role ?? current.role,
      patch.model !== undefined ? patch.model : current.model,
      patch.systemPrompt ?? current.system_prompt,
      patch.enabled ?? current.enabled,
      patch.contextWindow ?? current.context_window,
      patch.compressionThreshold ?? current.compression_threshold,
      patch.maxIterations ?? current.max_iterations,
      patch.autoClaim ?? current.auto_claim,
      patch.workspaceBackend !== undefined
        ? patch.workspaceBackend
        : current.workspace_backend,
      patch.permissionMode !== undefined ? patch.permissionMode : current.permission_mode,
      patch.webAccess !== undefined ? patch.webAccess : current.web_access,
      id,
    );
    if (patch.displayName !== undefined) {
      db.prepare('UPDATE member SET display_name = ? WHERE id = ?').run(patch.displayName, id);
    }
    return true;
  });
  if (!update()) {
    throw ApiFailure.notFound(`agent not found: ${id}`);
  }
  const agent = getAgent(db, id, env, inFlight);
  if (agent === null) {
    throw new Error('updated Agent could not be read back');
  }
  publishWorkspaceChanged({ source: 'agent' });
  publishMemberStatus({ memberId: agent.id, status: agent.status });
  return agent;
}

/**
 * Soft delete writes member.deleted_at and removes the member from every
 * channel and task thread by deleting those target_member rows. DM targets keep
 * their membership rows — the archived DM stays readable and keeps its two
 * members (已归档私信) — and messages, task history, agent_config and round
 * results are deliberately left alone; task.assignee_member_id is not
 * rewritten.
 */
export function softDeleteAgent(db: Database.Database, id: string): void {
  const remove = db.transaction((): boolean => {
    const result = db
      .prepare(
        `UPDATE member SET deleted_at = ?
          WHERE id = ? AND kind = 'agent' AND ${liveMemberClause()}`,
      )
      .run(new Date().toISOString(), id);
    if (result.changes !== 1) {
      return false;
    }
    db.prepare(
      `DELETE FROM target_member
        WHERE member_id = ?
          AND target_id IN (SELECT id FROM target WHERE kind <> 'dm')`,
    ).run(id);
    return true;
  });
  if (!remove()) {
    throw ApiFailure.notFound(`agent not found: ${id}`);
  }
  publishWorkspaceChanged({ source: 'agent' });
}

interface CreateInput {
  displayName: string;
  role: string;
  model: string | null;
  systemPrompt: string;
  enabled: number;
  contextWindow: number;
  compressionThreshold: number;
  maxIterations: number;
  autoClaim: number;
}

interface PatchInput {
  displayName?: string;
  role?: string;
  model?: string | null;
  systemPrompt?: string;
  enabled?: number;
  contextWindow?: number;
  compressionThreshold?: number;
  maxIterations?: number;
  autoClaim?: number;
  workspaceBackend?: WorkspaceBackend | null;
  permissionMode?: PermissionMode | null;
  /** `null` clears the override (follow the channel); a string must be a tier. */
  webAccess?: WebAccessTier | null;
}

const FIELD_KEYS = {
  display_name: 'displayName',
  role: 'role',
  model: 'model',
  system_prompt: 'systemPrompt',
  enabled: 'enabled',
  context_window: 'contextWindow',
  compression_threshold: 'compressionThreshold',
  max_iterations: 'maxIterations',
  auto_claim: 'autoClaim',
  workspace_backend: 'workspaceBackend',
  permission_mode: 'permissionMode',
  web_access: 'webAccess',
} as const;

type FieldKey = keyof typeof FIELD_KEYS;

function parseCreateInput(body: unknown): CreateInput {
  const record = asObject(body);
  rejectUnknownFields(record);

  const displayName = requireDisplayName(record['display_name']);

  return {
    displayName,
    role: optionalString(record, 'role') ?? '',
    model: optionalModel(record),
    systemPrompt: optionalString(record, 'system_prompt') ?? '',
    enabled: optionalBinary(record, 'enabled') ?? 1,
    contextWindow: optionalInteger(record, 'context_window', 1) ?? AGENT_DEFAULTS.contextWindow,
    compressionThreshold:
      optionalThreshold(record) ?? AGENT_DEFAULTS.compressionThreshold,
    maxIterations: optionalInteger(record, 'max_iterations', 1) ?? AGENT_DEFAULTS.maxIterations,
    autoClaim: optionalBinary(record, 'auto_claim') ?? 1,
  };
}

function parsePatchInput(body: unknown): PatchInput {
  const record = asObject(body);
  rejectUnknownFields(record);

  const patch: PatchInput = {};
  if (record['display_name'] !== undefined) {
    patch.displayName = requireDisplayName(record['display_name']);
  }
  const role = optionalString(record, 'role');
  if (role !== undefined) {
    patch.role = role;
  }
  if (record['model'] !== undefined) {
    patch.model = optionalModel(record);
  }
  const systemPrompt = optionalString(record, 'system_prompt');
  if (systemPrompt !== undefined) {
    patch.systemPrompt = systemPrompt;
  }
  const enabled = optionalBinary(record, 'enabled');
  if (enabled !== undefined) {
    patch.enabled = enabled;
  }
  const contextWindow = optionalInteger(record, 'context_window', 1);
  if (contextWindow !== undefined) {
    patch.contextWindow = contextWindow;
  }
  const threshold = optionalThreshold(record);
  if (threshold !== undefined) {
    patch.compressionThreshold = threshold;
  }
  const maxIterations = optionalInteger(record, 'max_iterations', 1);
  if (maxIterations !== undefined) {
    patch.maxIterations = maxIterations;
  }
  const autoClaim = optionalBinary(record, 'auto_claim');
  if (autoClaim !== undefined) {
    patch.autoClaim = autoClaim;
  }
  if (record['workspace_backend'] !== undefined) {
    patch.workspaceBackend = optionalWorkspaceBackend(record['workspace_backend']);
  }
  if (record['permission_mode'] !== undefined) {
    patch.permissionMode = optionalPermissionMode(record['permission_mode']);
  }
  if (record['web_access'] !== undefined) {
    patch.webAccess = optionalWebAccessTier(record['web_access']);
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

function requireDisplayName(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('display_name must be a non-empty string');
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

/**
 * `provider:model`. The provider picks the credential environment variable and
 * the remote-data-flow scope; the model half is stored exactly as given.
 */
function optionalModel(record: Record<string, unknown>): string | null {
  const value = record['model'];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string') {
    throw ApiFailure.validation('model must be a "provider:model" string or null');
  }
  const separator = value.indexOf(':');
  const provider = separator > 0 ? value.slice(0, separator) : '';
  if (!(AGENT_PROVIDERS as readonly string[]).includes(provider)) {
    throw ApiFailure.validation(
      `model provider must be one of: ${AGENT_PROVIDERS.join(', ')}`,
      { field: 'model', value },
    );
  }
  if (parseModelIdentifier(value) === null) {
    throw ApiFailure.validation('model must name a model after the provider prefix', {
      field: 'model',
      value,
    });
  }
  return value;
}

function optionalBinary(record: Record<string, unknown>, key: FieldKey): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (value !== 0 && value !== 1) {
    throw ApiFailure.validation(`${key} must be 0 or 1`);
  }
  return value;
}

function optionalInteger(
  record: Record<string, unknown>,
  key: FieldKey,
  min: number,
): number | undefined {
  const value = record[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min) {
    throw ApiFailure.validation(`${key} must be an integer >= ${min}`);
  }
  return value;
}

/**
 * `null` clears the override (follow the channel); a backend string sets it.
 * An omitted field is `undefined` and leaves the stored value alone.
 */
/** `null` clears the Agent override (follow the channel / default). */
function optionalPermissionMode(value: unknown): PermissionMode | null {
  if (value === null) {
    return null;
  }
  const mode = requirePermissionMode(value);
  return mode;
}

function optionalWorkspaceBackend(value: unknown): WorkspaceBackend | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || !(WORKSPACE_BACKENDS as readonly string[]).includes(value)) {
    throw ApiFailure.validation(
      `workspace_backend must be one of: ${WORKSPACE_BACKENDS.join(', ')} or null`,
      { field: 'workspace_backend', value },
    );
  }
  return value as WorkspaceBackend;
}

function optionalThreshold(record: Record<string, unknown>): number | undefined {
  const value = record['compression_threshold'];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 1) {
    throw ApiFailure.validation('compression_threshold must be a number in (0, 1]');
  }
  return value;
}

function nextAvatarSlot(db: Database.Database): number {
  const counts = new Map<number, number>();
  for (let slot = 0; slot < AVATAR_SLOT_COUNT; slot += 1) {
    counts.set(slot, 0);
  }
  const rows = db
    .prepare(
      `SELECT avatar_slot AS slot, count(*) AS total FROM member
        WHERE ${liveMemberClause()} GROUP BY avatar_slot`,
    )
    .all() as { slot: number; total: number }[];
  for (const row of rows) {
    counts.set(row.slot, row.total);
  }
  let bestSlot = 0;
  let bestCount = Number.POSITIVE_INFINITY;
  for (let slot = 0; slot < AVATAR_SLOT_COUNT; slot += 1) {
    const count = counts.get(slot) ?? 0;
    if (count < bestCount) {
      bestCount = count;
      bestSlot = slot;
    }
  }
  return bestSlot;
}

function toAgentView(
  db: Database.Database,
  row: AgentRow,
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): AgentView {
  const webAccess = isWebAccessTier(row.web_access) ? row.web_access : null;
  return {
    ...readStatusPoint(db, row, env, inFlight),
    id: row.id,
    kind: 'agent',
    display_name: row.display_name,
    avatar_slot: row.avatar_slot,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    role: row.role,
    model: row.model,
    credential_status: readCredentialStatus(row.model, env),
    system_prompt: row.system_prompt,
    enabled: row.enabled,
    context_window: row.context_window,
    compression_threshold: row.compression_threshold,
    max_iterations: row.max_iterations,
    auto_claim: row.auto_claim,
    workspace_backend:
      typeof row.workspace_backend === 'string' &&
      (WORKSPACE_BACKENDS as readonly string[]).includes(row.workspace_backend)
        ? (row.workspace_backend as WorkspaceBackend)
        : null,
    permission_mode: isPermissionMode(row.permission_mode) ? row.permission_mode : null,
    effective_permission_mode: isPermissionMode(row.permission_mode)
      ? row.permission_mode
      : DEFAULT_PERMISSION_MODE,
    web_access: webAccess,
    // An Agent reading has no channel dimension: this is the DM chain (Agent
    // level, then the default), so it passes no channel value at all.
    effective_web_access: resolveWebAccessTier(webAccess, null),
    // 家目录路径由 member_id 派生，不落库 (#43 / D5.2).
    home_path: agentHomeRoot(row.id, env),
  };
}

/**
 * The credential fact is a status, never a value: an Agent whose model names a
 * provider reports whether that provider's environment variable is set. An
 * Agent without a model is missing by definition — there is no provider to read
 * a credential for.
 */
function readCredentialStatus(
  model: string | null,
  env: NodeJS.ProcessEnv,
): AgentView['credential_status'] {
  const parsed = parseModelIdentifier(model);
  return parsed === null ? 'missing' : credentialStatus(parsed.provider, env);
}
