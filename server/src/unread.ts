import type { WorkspaceUnreadView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { channelReadState } from './channels.js';
import { publishUnreadChanged } from './events.js';
import { readOwnerId } from './members.js';
import { advanceReadPosition } from './read-position.js';

/**
 * 未读 (Unread): the messages after the viewer's read position that are top
 * level, `kind ∈ {human, agent}` and not authored by the viewer. `system`
 * records are not turns and never inflate a badge.
 *
 * The count is one SQL shape for every target kind: channel, dm and task all
 * go through the same WHERE clause, and the target kind is never a branch in
 * this predicate (D1.13 / GLOSSARY 未读).
 */
const UNREAD_COUNT_SQL = `
SELECT count(*) AS unread
  FROM message m
 WHERE m.target_id = ?
   AND m.kind IN ('human', 'agent')
   AND m.author_member_id <> ?
   AND m.seq > COALESCE(
     (SELECT rp.last_read_seq
        FROM read_position rp
       WHERE rp.member_id = ? AND rp.target_id = ?),
     0
   )`;

/**
 * The unread count of one target for one member. The owner's row is the
 * badge's baseline; an Agent's row is its consumption cursor — the caller
 * chooses the member, so the same query serves both facts without confusing
 * them.
 */
export function countUnread(
  db: Database.Database,
  memberId: string,
  targetId: string,
): number {
  const row = db.prepare(UNREAD_COUNT_SQL).get(
    targetId,
    memberId,
    memberId,
    targetId,
  ) as { unread: number };
  return row.unread;
}

interface TargetRow {
  id: string;
  kind: string;
  archived_at: string | null;
  deleted_at: string | null;
}

/**
 * The workspace reading: `unread_total` is channel + dm, while a task target is
 * counted only by its task payload's `unread_count`.
 *
 * Archived channels keep their own reading in `unread_by_target` but stay out
 * of the total badge (D1.13 频道归档); deleted channels are not part of the
 * workspace at all. `unread_by_target` carries every visible channel and dm
 * target, zero counts included, so a reader can render a badge per target.
 */
export function readWorkspaceUnread(
  db: Database.Database,
  memberId: string,
): WorkspaceUnreadView {
  const rows = db
    .prepare(
      `SELECT t.id AS id, t.kind AS kind,
              c.archived_at AS archived_at, c.deleted_at AS deleted_at
         FROM target t
         LEFT JOIN channel c ON t.kind = 'channel' AND c.id = t.id
        ORDER BY t.rowid`,
    )
    .all() as TargetRow[];

  const unreadByTarget: Record<string, number> = {};
  let unreadTotal = 0;
  for (const row of rows) {
    if (row.kind === 'channel') {
      const state = channelReadState(row);
      if (state === 'deleted') {
        continue;
      }
      const unread = countUnread(db, memberId, row.id);
      unreadByTarget[row.id] = unread;
      if (state === 'live') {
        unreadTotal += unread;
      }
      continue;
    }
    if (row.kind === 'dm') {
      const unread = countUnread(db, memberId, row.id);
      unreadByTarget[row.id] = unread;
      unreadTotal += unread;
    }
  }
  return { unread_total: unreadTotal, unread_by_target: unreadByTarget };
}

/** The read-position write's answer: the stored position and the new reading. */
export interface TargetReadView {
  target_id: string;
  last_read_seq: number;
  unread_count: number;
}

/**
 * POST /api/targets/{id}/read: advance the owner's read position. The body is
 * only `{last_read_seq}`; the stored position obeys the same monotonic-max and
 * clamp rule as every other read-position write, so a smaller or future value
 * never moves the row backwards or past the log.
 *
 * A read that actually moves the position publishes `unread.changed` after the
 * transaction commits; a no-op read announces nothing.
 */
export function markOwnerRead(
  db: Database.Database,
  targetId: string,
  body: unknown,
): TargetReadView {
  const seq = parseReadRequest(body);
  assertTargetExists(db, targetId);
  const ownerId = readOwnerId(db);
  const write = db.transaction((): { position: number; previous: number; unread: number } => {
    const advanced = advanceReadPosition(db, ownerId, targetId, seq);
    return {
      position: advanced.current,
      previous: advanced.previous,
      unread: countUnread(db, ownerId, targetId),
    };
  });
  const stored = write();
  if (stored.position > stored.previous) {
    // After the commit, like every other frame: a rolled-back read announces
    // nothing.
    publishUnreadChanged({ targetId, unreadCount: stored.unread });
  }
  return {
    target_id: targetId,
    last_read_seq: stored.position,
    unread_count: stored.unread,
  };
}

function parseReadRequest(body: unknown): number {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'last_read_seq') {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const value = record['last_read_seq'];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw ApiFailure.validation('last_read_seq must be a non-negative integer', {
      field: 'last_read_seq',
      value,
    });
  }
  return value;
}

/** A read position writes against any existing target; an unknown id is 404. */
function assertTargetExists(db: Database.Database, targetId: string): void {
  const row = db.prepare('SELECT 1 FROM target WHERE id = ?').get(targetId);
  if (row === undefined) {
    throw ApiFailure.notFound(`target not found: ${targetId}`);
  }
}
