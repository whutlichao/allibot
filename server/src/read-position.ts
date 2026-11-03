import type Database from 'better-sqlite3';

/**
 * 已读位置 (Read Position): one row per member per target, the canonical "how
 * far has this member read" number. The owner's row is the unread badge's
 * baseline; an Agent's row is its consumption cursor. The two facts share the
 * table and the write rule below, but never read each other's row — the member
 * id is the whole separation.
 *
 * The position only ever moves monotonically inside one target and is clamped
 * to the target's current maximum seq, so a "future message is already read"
 * state cannot be constructed.
 */

/** The stored position, or 0 when the member has no row for this target. */
export function readLastReadSeq(
  db: Database.Database,
  memberId: string,
  targetId: string,
): number {
  const row = db
    .prepare('SELECT last_read_seq FROM read_position WHERE member_id = ? AND target_id = ?')
    .get(memberId, targetId) as { last_read_seq: number } | undefined;
  return row?.last_read_seq ?? 0;
}

/**
 * Move a member's position forward inside one target: `max(previous, seq)`,
 * clamped to the newest stored seq. Returns the previous and stored values so
 * a caller can tell a real advancement from a no-op (only a real change means
 * the member's unread reading changed).
 *
 * The caller owns the transaction when the write has to be atomic with
 * something else; this function does not open one.
 */
export function advanceReadPosition(
  db: Database.Database,
  memberId: string,
  targetId: string,
  seq: number,
): { previous: number; current: number } {
  const previous = readLastReadSeq(db, memberId, targetId);
  const current = Math.max(previous, Math.min(seq, maxSeq(db, targetId)));
  if (current !== previous) {
    db.prepare(
      `INSERT INTO read_position (member_id, target_id, last_read_seq)
       VALUES (?, ?, ?)
       ON CONFLICT (member_id, target_id) DO UPDATE
         SET last_read_seq = MAX(read_position.last_read_seq, excluded.last_read_seq)`,
    ).run(memberId, targetId, current);
  }
  return { previous, current };
}

/** The newest stored seq of one target; an empty target reads as 0. */
export function maxSeq(db: Database.Database, targetId: string): number {
  const row = db
    .prepare('SELECT coalesce(MAX(seq), 0) AS last FROM message WHERE target_id = ?')
    .get(targetId) as { last: number };
  return row.last;
}
