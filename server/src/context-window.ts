import type Database from 'better-sqlite3';
import { ROUND_CONTEXT_WINDOW } from './agent-seam.js';
import { advanceReadPosition, readLastReadSeq } from './read-position.js';

/**
 * 上下文窗口 (Context Window) and 消费游标 (Agent Read Cursor).
 *
 * Two facts share this module because they share one read: a round reads the
 * most recent window of a target, and it reads the member's own consumed
 * position to know which message is new. The cursor reuses the read-position
 * row (已读位置) — the same table the owner's unread badge reads — but it is a
 * different fact, so nothing here ever writes or reads the owner's row on an
 * Agent's behalf.
 */

/**
 * How much history the round reads: the recent window, or the whole thread
 * (自动续跑 keeps the full task thread it is still working on).
 */
export type ContextScope = 'window' | 'full';

/**
 * The member's consumption cursor: the last seq it consumed in a round that
 * closed as replied or ignored. `0` when it has never consumed anything there.
 * A failed round never advances it, so its message is still new to the next
 * round — that is the whole point of the cursor.
 */
export function readConsumedSeq(
  db: Database.Database,
  memberId: string,
  targetId: string,
): number {
  return readLastReadSeq(db, memberId, targetId);
}

/**
 * Advance the member's consumption cursor to the seq of the message that
 * opened the round. It only moves forward inside one target and is clamped to
 * the target's current maximum seq, so a position ahead of the log cannot be
 * written and a late-arriving wake for an older message never moves the
 * cursor backwards.
 *
 * The caller owns the transaction: this runs inside the round's own commit
 * boundary, so the reply (or the ignore) and the cursor position are one
 * fact.
 */
export function advanceConsumedSeq(
  db: Database.Database,
  memberId: string,
  targetId: string,
  seq: number,
): void {
  advanceReadPosition(db, memberId, targetId, seq);
}

/**
 * The messages a round reads, oldest first. A `window` round reads the most
 * recent ROUND_CONTEXT_WINDOW messages of the target; a `full` round (an
 * auto-continue continuing its task thread) reads the whole target.
 *
 * The window is history, not a second wake surface: it decides nothing about
 * whether the round answers, which signal fired or where the cursor sits.
 */
export function readContextWindow(
  db: Database.Database,
  targetId: string,
  scope: ContextScope,
  limit = ROUND_CONTEXT_WINDOW,
): {
  seq: number;
  kind: 'human' | 'agent' | 'system';
  author_member_id: string;
  author_display_name: string;
  body: string;
}[] {
  const rows =
    scope === 'full'
      ? (db
          .prepare(
            `SELECT seq, kind, author_member_id, author_display_name, body
               FROM message WHERE target_id = ? ORDER BY seq`,
          )
          .all(targetId) as {
          seq: number;
          kind: string;
          author_member_id: string;
          author_display_name: string;
          body: string;
        }[])
      : (db
          .prepare(
            `SELECT seq, kind, author_member_id, author_display_name, body
               FROM message WHERE target_id = ? ORDER BY seq DESC LIMIT ?`,
          )
          .all(targetId, limit) as {
          seq: number;
          kind: string;
          author_member_id: string;
          author_display_name: string;
          body: string;
        }[])
          // The page is read newest-first so the LIMIT keeps the tail; the
          // round reads it oldest-first like every other message read.
          .reverse();
  return rows.map((row) => ({
    seq: row.seq,
    kind: row.kind as 'human' | 'agent' | 'system',
    author_member_id: row.author_member_id,
    author_display_name: row.author_display_name,
    body: row.body,
  }));
}
