import { randomUUID } from 'node:crypto';
import type { ChannelView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { publishWorkspaceChanged } from './events.js';
import { OWNER_ID_SUBQUERY } from './sql.js';

/**
 * The M1 channel modes. `team` belongs to T10 and is rejected as invalid
 * rather than half-implemented.
 */
export const CHANNEL_MODES = ['autonomous'] as const;

/** The allowed response budget upper bounds; the default is 3. */
export const RESPONSE_BUDGET_LIMITS = [3, 5, 10] as const;
export const DEFAULT_RESPONSE_BUDGET_LIMIT = 3;

export interface ChannelRow {
  id: string;
  name: string;
  description: string;
  mode: string;
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
}

const CHANNEL_SELECT = `
SELECT id, name, description, mode, response_budget_limit,
       archived_at, deleted_at, created_at, updated_at
FROM channel`;

const FIELD_KEYS = {
  name: 'name',
  description: 'description',
  mode: 'mode',
  response_budget_limit: 'responseBudgetLimit',
} as const;

type FieldKey = keyof typeof FIELD_KEYS;

export function listChannels(db: Database.Database): ChannelView[] {
  const rows = db
    .prepare(`${CHANNEL_SELECT} WHERE deleted_at IS NULL ORDER BY created_at, rowid`)
    .all() as ChannelRow[];
  return rows.map(toChannelView);
}

export function getChannel(db: Database.Database, id: string): ChannelView {
  return readLiveChannel(db, id);
}

export function createChannel(db: Database.Database, body: unknown): ChannelView {
  const input = parseCreateInput(body);
  const create = db.transaction((): string => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO channel
         (id, name, description, mode, response_budget_limit, archived_at, deleted_at,
          created_at, updated_at)
       VALUES (?, ?, ?, 'autonomous', ?, NULL, NULL, ?, ?)`,
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
  return readLiveChannel(db, id);
}

export function updateChannel(db: Database.Database, id: string, body: unknown): ChannelView {
  const patch = parsePatchInput(body);
  const update = db.transaction((): boolean => {
    const current = readChannelRow(db, id);
    if (current === undefined) {
      return false;
    }
    assertChannelWritable(current);
    db.prepare(
      `UPDATE channel
          SET name = ?, description = ?, response_budget_limit = ?, updated_at = ?
        WHERE id = ?`,
    ).run(
      patch.name ?? current.name,
      patch.description ?? current.description,
      patch.responseBudgetLimit ?? current.response_budget_limit,
      new Date().toISOString(),
      id,
    );
    return true;
  });
  if (!update()) {
    throw notFound(id);
  }
  publishWorkspaceChanged({ source: 'channel' });
  return readLiveChannel(db, id);
}

/** Archive is idempotent: a second call keeps the first `archived_at`. */
export function archiveChannel(db: Database.Database, id: string): ChannelView {
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
  return readLiveChannel(db, id);
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

function readLiveChannel(db: Database.Database, id: string): ChannelView {
  return toChannelView(assertChannelReadable(db, id));
}

function readChannelRow(db: Database.Database, id: string): ChannelRow | undefined {
  return db.prepare(`${CHANNEL_SELECT} WHERE id = ? AND deleted_at IS NULL`).get(id) as
    | ChannelRow
    | undefined;
}

function notFound(id: string): ApiFailure {
  return ApiFailure.notFound(`channel not found: ${id}`);
}

function parseCreateInput(body: unknown): ChannelWriteInput & { name: string } {
  const record = asObject(body);
  rejectUnknownFields(record);
  const name = requireName(record['name']);
  if (record['mode'] !== undefined) {
    requireMode(record['mode']);
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
  if (record['mode'] !== undefined) {
    // Mode is fixed at create time; the field is known only so that writing it
    // reads as a validation failure rather than an unknown field.
    requireMode(record['mode']);
  }
  const patch: ChannelWriteInput = {};
  if (record['name'] !== undefined) {
    patch.name = requireName(record['name']);
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

function requireMode(value: unknown): void {
  if (typeof value !== 'string' || !(CHANNEL_MODES as readonly string[]).includes(value)) {
    throw ApiFailure.validation(`mode must be one of: ${CHANNEL_MODES.join(', ')}`, {
      field: 'mode',
      value,
    });
  }
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

function toChannelView(row: ChannelRow): ChannelView {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    mode: row.mode,
    response_budget_limit: row.response_budget_limit,
    archived_at: row.archived_at,
    deleted_at: row.deleted_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}
