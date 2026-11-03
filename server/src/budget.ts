import type Database from 'better-sqlite3';
import { DEFAULT_RESPONSE_BUDGET_LIMIT } from './channels.js';
import { tFromDb } from './copy.js';
import { readTargetKind } from './sql.js';

/**
 * The budget ledger (预算表): one row per target, the canonical jump count.
 * `epoch_seq` is the human epoch the row belongs to (the seq of the message
 * that opened it, 0 before any epoch has opened) and `used` counts the
 * agent-to-agent jumps delivered inside that epoch.
 *
 * `limit_value` snapshots the ceiling that was in force when the epoch opened.
 * That is what makes "a channel upper-bound change takes effect at the next
 * human epoch" true: the running epoch keeps reading this column, and only a
 * fresh epoch writes it again.
 *
 * The human face has no write path to this table (ADR 0004): `used` only moves
 * from an epoch reset and from a delivered jump, both backend call sites.
 */
export interface BudgetRow {
  target_id: string;
  epoch_seq: number;
  used: number;
  limit_value: number;
}

const BUDGET_SELECT = 'SELECT target_id, epoch_seq, used, limit_value FROM target_budget';

/**
 * Open a human epoch (人类世代) on one target: reset the used jump count to
 * zero and hand the epoch the full ceiling in force when it opens.
 *
 * There are exactly three epoch openers (D1.13), and each passes the seq of the
 * message that opened it:
 *   1. a `kind='human'` message lands — the message write path calls this with
 *      that message's seq;
 *   2. the owner changes the assignee of a task — the seq of the system
 *      message the change lands;
 *   3. the first claim of a task — #24 calls this with the seq of the
 *      「已认领」 system record, never the 「认领后自动开工」 record that follows
 *      it.
 *
 * The caller owns the transaction; this function does not open one, so a
 * human message and its epoch are written in the same boundary.
 */
export function openEpoch(db: Database.Database, targetId: string, epochSeq: number): void {
  db.prepare(
    `INSERT INTO target_budget (target_id, epoch_seq, used, limit_value)
     VALUES (?, ?, 0, ?)
     ON CONFLICT (target_id) DO UPDATE
       SET epoch_seq = excluded.epoch_seq,
           used = 0,
           limit_value = excluded.limit_value`,
  ).run(targetId, epochSeq, effectiveLimit(db, targetId));
}

function readBudget(db: Database.Database, targetId: string): BudgetRow | undefined {
  return db.prepare(`${BUDGET_SELECT} WHERE target_id = ?`).get(targetId) as BudgetRow | undefined;
}

export interface JumpAttempt {
  /** Whether this agent message gets to deliver its wakes. */
  consumed: boolean;
  /** The row after the attempt: the reason text reads its used / limit. */
  budget: BudgetRow;
}

/**
 * Reserve one jump for an Agent message that will deliver at least one wake,
 * or report that the epoch is exhausted.
 *
 * The reservation happens before the wake loop rather than after it, in one
 * synchronous transaction with the availability check: the write path awaits
 * member rounds, so a later check-then-count would let two Agent messages both
 * pass at `used = limit - 1`. Reserving first is what makes the ceiling a
 * constructive bound (耗尽时一个唤醒都不投递) rather than an after-the-fact
 * statistic; a crash between reservation and delivery over-counts, which fails
 * closed on a budget.
 *
 * A target that never opened an epoch still gets a row here: until a human
 * epoch opens, the built-in epoch 0 runs on the built-in default ceiling.
 */
export function tryConsumeJump(db: Database.Database, targetId: string): JumpAttempt {
  const attempt = db.transaction((): JumpAttempt => {
    const budget = readBudget(db, targetId) ?? insertPreEpochRow(db, targetId);
    if (budget.used >= budget.limit_value) {
      return { consumed: false, budget };
    }
    db.prepare('UPDATE target_budget SET used = used + 1 WHERE target_id = ?').run(targetId);
    return { consumed: true, budget: { ...budget, used: budget.used + 1 } };
  });
  return attempt();
}

/** The readable round reason of a suppressed wake: readable, never an error. */
export function budgetExhaustedReason(db: Database.Database, budget: BudgetRow): string {
  return tFromDb(db, 'round.budgetExhausted', {
    used: budget.used,
    limit: budget.limit_value,
  });
}

/**
 * The ceiling a target runs under when it opens an epoch. Only a channel
 * carries a configured upper bound (3 / 5 / 10, stored on the channel row by
 * #9); DM and task targets fall back to the built-in default 3.
 */
function effectiveLimit(db: Database.Database, targetId: string): number {
  if (readTargetKind(db, targetId) === 'channel') {
    const channel = db
      .prepare('SELECT response_budget_limit FROM channel WHERE id = ?')
      .get(targetId) as { response_budget_limit: number } | undefined;
    if (channel !== undefined) {
      return channel.response_budget_limit;
    }
  }
  return DEFAULT_RESPONSE_BUDGET_LIMIT;
}

/** The epoch 0 row: no human epoch has opened yet, so nothing is used. */
function insertPreEpochRow(db: Database.Database, targetId: string): BudgetRow {
  const limit = effectiveLimit(db, targetId);
  db.prepare(
    `INSERT INTO target_budget (target_id, epoch_seq, used, limit_value) VALUES (?, 0, 0, ?)`,
  ).run(targetId, limit);
  return { target_id: targetId, epoch_seq: 0, used: 0, limit_value: limit };
}
