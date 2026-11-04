import { randomUUID } from 'node:crypto';
import type { PlanRunView, PlanTaskStatus, PlanTaskView } from '@allibot/shared';
import { PLAN_TASK_STATUSES } from '@allibot/shared';
import type Database from 'better-sqlite3';
import type {
  PlanTaskCreateRequest,
  PlanTaskGetRequest,
  PlanTaskUpdateRequest,
  RoundPlanFace,
} from './agent-seam.js';
import { ApiFailure } from './api-error.js';
import { nowIso } from './clock.js';
import { tFromDb } from './copy.js';
import { publishPlanUpdate } from './events.js';
import { readTargetKind } from './sql.js';

/**
 * Plan (Plan Run, #40 / D4.1): the member's work list inside a round.
 *
 * A `plan_run` is lazily created by the first tool call for one
 * (target, member) pair and keeps its id across rounds while it is the current
 * run; a `plan_task` is one item with its own three-word status and append
 * position. The module is the one place that creates, updates and reads the
 * two tables, so the tool face, the read model, retention and the SSE frame
 * cannot disagree about what a Plan is.
 *
 * A Plan write is not a task write: it never touches `task`, `message`,
 * `read_position`, `target_budget`, a wake, or the search index, and it never
 * creates a target. Each mutation publishes one live `plan_update` frame with
 * the complete current task list, after the transaction commits.
 */

/** 保留策略: recent 20 runs or 30 days per (target, member), whichever drops first. */
export const PLAN_RUN_RETENTION = 20;
export const PLAN_RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export const PLAN_DEFAULT_LIMIT = 20;
export const PLAN_MAX_LIMIT = 50;

const TASK_SELECT = `
SELECT id, plan_run_id, title, status, position, created_at, updated_at
FROM plan_task`;

/** `limit` 1–50 with a default of 20; `member_id` is an optional pair filter. */
export interface PlanQuery {
  limit: number;
  memberId?: string;
}

export function parsePlanQuery(
  db: Database.Database,
  searchParams: URLSearchParams,
): PlanQuery {
  const rawLimit = searchParams.get('limit');
  let limit = PLAN_DEFAULT_LIMIT;
  if (rawLimit !== null) {
    if (
      !/^\d+$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > PLAN_MAX_LIMIT
    ) {
      throw ApiFailure.validation(tFromDb(db, 'plan.error.limit'), {
        field: 'limit',
        value: rawLimit,
      });
    }
    limit = Number(rawLimit);
  }
  const memberId = searchParams.get('member_id');
  return memberId === null ? { limit } : { limit, memberId };
}

/**
 * The Plan read model of one target (D2.3): newest runs first, each with its
 * complete task list. A member who is not a member of the target reads an
 * empty list (the endpoint is a target-scoped reading); an unknown target is a
 * 404 because it names no scope at all.
 */
export function listPlans(db: Database.Database, targetId: string, query: PlanQuery): PlanRunView[] {
  if (readTargetKind(db, targetId) === null) {
    throw ApiFailure.notFound(tFromDb(db, 'plan.error.targetNotFound', { target_id: targetId }));
  }
  if (query.memberId !== undefined) {
    const membership = db
      .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
      .get(targetId, query.memberId);
    if (membership === undefined) {
      return [];
    }
  }

  const params: unknown[] = [targetId];
  let memberClause = '';
  if (query.memberId !== undefined) {
    memberClause = 'AND member_id = ?';
    params.push(query.memberId);
  }
  params.push(query.limit);
  const rows = db
    .prepare(
      `SELECT id, target_id, member_id, created_at, updated_at
         FROM plan_run
        WHERE target_id = ? ${memberClause}
        ORDER BY created_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...(params as never[])) as PlanRunRow[];

  return rows.map((row) => ({
    id: row.id,
    target_id: row.target_id,
    member_id: row.member_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tasks: readPlanTasks(db, row.id),
  }));
}

interface PlanRunRow {
  id: string;
  target_id: string;
  member_id: string;
  created_at: string;
  updated_at: string;
}

interface PlanTaskRow {
  id: string;
  plan_run_id: string;
  title: string;
  status: string;
  position: number;
  created_at: string;
  updated_at: string;
}

function readPlanTasks(db: Database.Database, runId: string): PlanTaskView[] {
  const rows = db
    .prepare(`${TASK_SELECT} WHERE plan_run_id = ? ORDER BY position, rowid`)
    .all(runId) as PlanTaskRow[];
  return rows.map(planTaskView);
}

function planTaskView(row: PlanTaskRow): PlanTaskView {
  return {
    id: row.id,
    plan_run_id: row.plan_run_id,
    title: row.title,
    status: parsePlanTaskStatus(row.status),
    position: row.position,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function parsePlanTaskStatus(value: string): PlanTaskStatus {
  switch (value) {
    case 'pending':
    case 'in_progress':
    case 'completed':
      return value;
    default:
      throw new Error(`plan_task row carries an unknown status: ${value}`);
  }
}

/**
 * The four Plan tools for one round (D4.1). The face holds the pair's current
 * run id after the first call, so several tool calls in one round share one
 * lazily created run. A call never wakes, budgets or writes a message.
 */
export function createPlanFace(
  db: Database.Database,
  targetId: string,
  memberId: string,
): RoundPlanFace {
  let runId: string | null = null;
  const ensureRun = (): string => {
    if (runId === null) {
      runId = ensurePlanRun(db, targetId, memberId);
    }
    return runId;
  };

  const publish = (currentRunId: string): void => {
    const run = db
      .prepare('SELECT updated_at FROM plan_run WHERE id = ?')
      .get(currentRunId) as { updated_at: string } | undefined;
    publishPlanUpdate({
      plan_run_id: currentRunId,
      target_id: targetId,
      member_id: memberId,
      tasks: readPlanTasks(db, currentRunId),
      occurred_at: run?.updated_at ?? nowIso(),
    });
  };

  return {
    TaskCreate(request: PlanTaskCreateRequest): PlanTaskView {
      const currentRunId = ensureRun();
      const title = normalizeTitle(db, request.title);
      const now = nowIso();
      const created = db.transaction((): PlanTaskView => {
        const last = db
          .prepare(
            'SELECT coalesce(MAX(position), -1) AS last FROM plan_task WHERE plan_run_id = ?',
          )
          .get(currentRunId) as { last: number };
        const id = randomUUID();
        db.prepare(
          `INSERT INTO plan_task
             (id, plan_run_id, title, status, position, created_at, updated_at)
           VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
        ).run(id, currentRunId, title, last.last + 1, now, now);
        touchRun(db, currentRunId, now);
        return readPlanTaskOrThrow(db, currentRunId, id);
      })();
      publish(currentRunId);
      return created;
    },

    TaskGet(request: PlanTaskGetRequest): PlanTaskView | null {
      const currentRunId = ensureRun();
      return readPlanTask(db, currentRunId, request.id);
    },

    TaskList(): PlanTaskView[] {
      return readPlanTasks(db, ensureRun());
    },

    TaskUpdate(request: PlanTaskUpdateRequest): PlanTaskView | null {
      const currentRunId = ensureRun();
      const existing = readPlanTask(db, currentRunId, request.id);
      if (existing === null) {
        return null;
      }
      const title = request.title === undefined ? existing.title : normalizeTitle(db, request.title);
      const status =
        request.status === undefined ? existing.status : parseRequestedStatus(db, request.status);
      if (title === existing.title && status === existing.status) {
        // A same-value replay changes no fact and announces nothing (D2.4's
        // idempotency reading for a tool face that has no HTTP method).
        return existing;
      }
      const now = nowIso();
      const updated = db.transaction((): PlanTaskView => {
        db.prepare(
          `UPDATE plan_task SET title = ?, status = ?, updated_at = ?
            WHERE id = ? AND plan_run_id = ?`,
        ).run(title, status, now, existing.id, currentRunId);
        touchRun(db, currentRunId, now);
        return readPlanTaskOrThrow(db, currentRunId, existing.id);
      })();
      publish(currentRunId);
      return updated;
    },
  };
}

function readPlanTask(
  db: Database.Database,
  runId: string,
  taskId: string,
): PlanTaskView | null {
  const row = db
    .prepare(`${TASK_SELECT} WHERE plan_run_id = ? AND id = ?`)
    .get(runId, taskId) as PlanTaskRow | undefined;
  return row === undefined ? null : planTaskView(row);
}

function readPlanTaskOrThrow(
  db: Database.Database,
  runId: string,
  taskId: string,
): PlanTaskView {
  const task = readPlanTask(db, runId, taskId);
  if (task === null) {
    throw new Error(`plan task not found after write: ${taskId}`);
  }
  return task;
}

function normalizeTitle(db: Database.Database, raw: string): string {
  const title = typeof raw === 'string' ? raw.trim() : '';
  if (title.length === 0) {
    throw new Error(tFromDb(db, 'plan.error.titleRequired'));
  }
  return title;
}

function parseRequestedStatus(db: Database.Database, raw: PlanTaskStatus): PlanTaskStatus {
  if (!(PLAN_TASK_STATUSES as readonly string[]).includes(raw)) {
    throw new Error(tFromDb(db, 'plan.error.statusInvalid', { status: String(raw) }));
  }
  return raw;
}

function touchRun(db: Database.Database, runId: string, now: string): void {
  db.prepare('UPDATE plan_run SET updated_at = ? WHERE id = ?').run(now, runId);
}

/**
 * Lazily resolve the pair's current run. It is reused while it is within the
 * retention window (fewer than 20 runs, at most 30 days old); otherwise the
 * first tool call of the round creates a new run and prunes the pair's history
 * in the same transaction. There is no startup-wide scan.
 */
function ensurePlanRun(db: Database.Database, targetId: string, memberId: string): string {
  const now = nowIso();
  const latest = db
    .prepare(
      `SELECT id, created_at FROM plan_run
        WHERE target_id = ? AND member_id = ?
        ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .get(targetId, memberId) as { id: string; created_at: string } | undefined;
  if (
    latest !== undefined &&
    latest.created_at >= retentionCutoff(now) &&
    countRuns(db, targetId, memberId) < PLAN_RUN_RETENTION
  ) {
    return latest.id;
  }

  return db.transaction((): string => {
    const id = randomUUID();
    db.prepare(
      `INSERT INTO plan_run (id, target_id, member_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, targetId, memberId, now, now);
    prunePlanRuns(db, targetId, memberId, now);
    return id;
  })();
}

function countRuns(db: Database.Database, targetId: string, memberId: string): number {
  return (
    db
      .prepare(
        'SELECT count(*) AS total FROM plan_run WHERE target_id = ? AND member_id = ?',
      )
      .get(targetId, memberId) as { total: number }
  ).total;
}

function retentionCutoff(now: string): string {
  return new Date(Date.parse(now) - PLAN_RETENTION_DAYS * DAY_MS).toISOString();
}

/**
 * Keep the pair's newest 20 runs that are also within 30 days. Everything else
 * is deleted in the creation transaction; `plan_task` follows by cascade. A
 * deletion of a plan run is not a message deletion: Plan rows are working
 * state, never append-only conversation.
 */
function prunePlanRuns(
  db: Database.Database,
  targetId: string,
  memberId: string,
  now: string,
): void {
  const cutoff = retentionCutoff(now);
  db.prepare(
    `DELETE FROM plan_run
      WHERE target_id = ?
        AND member_id = ?
        AND (
          created_at < ?
          OR id NOT IN (
            SELECT id FROM plan_run
             WHERE target_id = ?
               AND member_id = ?
             ORDER BY created_at DESC, rowid DESC
             LIMIT ?
          )
        )`,
  ).run(targetId, memberId, cutoff, targetId, memberId, PLAN_RUN_RETENTION);
}
