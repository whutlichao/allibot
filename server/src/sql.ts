import type Database from 'better-sqlite3';

/**
 * The SQL shapes more than one module needs, written once here.
 *
 * These are read-only fragments: the owner subquery and the target-kind /
 * last-seq lookups are facts every read model asks for, so a change to the
 * predicate (or to the owner rule) has one place to land instead of one copy
 * per caller.
 */

/**
 * The one human row, as a scalar subquery. `channel` and `task` writes use it
 * to add the owner to a new target; the owner is read by `kind`, never by
 * display name or list position.
 */
export const OWNER_ID_SUBQUERY = "(SELECT id FROM member WHERE kind = 'owner')";

/** The newest stored seq of one target; an empty target reads as 0. */
export function maxSeqForTarget(db: Database.Database, targetId: string): number {
  const row = db
    .prepare('SELECT coalesce(MAX(seq), 0) AS last FROM message WHERE target_id = ?')
    .get(targetId) as { last: number };
  return row.last;
}

/**
 * The stored kind of a target (`channel` / `dm` / `task`), or `null` when the
 * target row does not exist. Callers that require a target decide whether a
 * missing row is a 404 or an internal error; the query itself answers one
 * shape.
 */
export function readTargetKind(db: Database.Database, targetId: string): string | null {
  const row = db.prepare('SELECT kind FROM target WHERE id = ?').get(targetId) as
    | { kind: string }
    | undefined;
  return row?.kind ?? null;
}
