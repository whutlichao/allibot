import { randomUUID } from 'node:crypto';
import type {
  TeamAssignmentState,
  TeamAssignmentView,
  TeamRunStatus,
  TeamRunView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { tFromDb } from './copy.js';
import { readTargetKind } from './sql.js';
import { readTeamTargetState, type TeamTargetState } from './team.js';

/**
 * 运行记录 (Team Run / Assignment Record, #38 / D3.3): the leader's team rounds
 * and (from #39) their assignments are a forensic face, not messages. This
 * module is the one place that opens, closes and reads them, so the round write
 * path, the task-change triggers and the snapshot endpoint cannot disagree
 * about what a run is.
 *
 * A run opens `running` when the leader's round starts and closes exactly once.
 * A trigger that would have delivered to an unusable leader writes
 * `invalid-leader` with both timestamps at once, without a round. Restarting
 * the process closes residual `running` rows as `failed` (`interrupted`); it
 * never refunds a jump because it never touches the budget at all.
 */

/** The one cursor read of the run snapshot. */
const RUN_SELECT = `
SELECT rowid AS rid, id, target_id, channel_id, task_id, leader_member_id, status, reason,
       started_at, finished_at
FROM team_run`;

/** The nested assignment read; ordered oldest first inside one run. */
const ASSIGNMENT_SELECT = `
SELECT rowid AS rid, id, team_run_id, target_id, task_id, member_id, state, jump_consumed,
       reply_excerpt, reason, started_at, finished_at
FROM team_assignment`;

export interface StartedTeamRun {
  id: string;
  startedAt: string;
}

/**
 * Open the run of one leader round. Only a real leader round on a team target
 * reaches here: the caller has already resolved the target state and matched
 * the leader.
 */
export function startTeamRun(
  db: Database.Database,
  state: TeamTargetState,
  startedAt = new Date().toISOString(),
): StartedTeamRun {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO team_run
       (id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at,
        finished_at)
     VALUES (?, ?, ?, ?, ?, 'running', NULL, ?, NULL)`,
  ).run(id, state.targetId, state.channelId, state.taskId, state.leaderMemberId, startedAt);
  return { id, startedAt };
}

/**
 * Close one run once. A row that some other path already closed is left alone
 * (the database trigger would refuse a second close anyway). `reason` is the
 * round outcome's own readable reason on a failure, NULL on a normal close.
 */
export function closeTeamRun(
  db: Database.Database,
  runId: string,
  status: Extract<TeamRunStatus, 'completed' | 'failed'>,
  reason: string | null,
  finishedAt: string,
): void {
  db.prepare(
    `UPDATE team_run
        SET status = ?, reason = ?, finished_at = ?
      WHERE id = ? AND status = 'running'`,
  ).run(status, reason, finishedAt, runId);
}

/**
 * An unusable leader is a trigger that never became a round (D3.8): one
 * `invalid-leader` row with both timestamps written, zero wakes, zero
 * assignments and zero budget. The reason is the same readable reason the
 * channel reading serves.
 */
export function recordInvalidLeaderRun(
  db: Database.Database,
  state: TeamTargetState,
  now = new Date().toISOString(),
): boolean {
  if (state.leaderMemberId.length === 0) {
    // The channel CHECK forbids a team channel without a leader; a defensive
    // reading must not invent a member id for the NOT NULL column.
    return false;
  }
  db.prepare(
    `INSERT INTO team_run
       (id, target_id, channel_id, task_id, leader_member_id, status, reason, started_at,
        finished_at)
     VALUES (?, ?, ?, ?, ?, 'invalid-leader', ?, ?, ?)`,
  ).run(
    randomUUID(),
    state.targetId,
    state.channelId,
    state.taskId,
    state.leaderMemberId,
    state.reason,
    now,
    now,
  );
  return true;
}

/**
 * Record an invalid-leader trigger for a message write: every trigger that
 * should have delivered to the leader does so while the leader is unusable
 * (D3.8). A leader-authored message is not such a trigger (zero-wake author),
 * and a non-team target has no team record at all.
 */
export function recordInvalidLeaderMessageTrigger(
  db: Database.Database,
  targetId: string,
  authorMemberId: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const state = readTeamTargetState(db, targetId, env);
  if (state === null || state.available) {
    return false;
  }
  if (state.leaderMemberId === authorMemberId) {
    return false;
  }
  return recordInvalidLeaderRun(db, state);
}

/** The structured wake of a task change addressed to the leader. */
export interface TeamChangeWake {
  memberId: string;
  targetId: string;
  fromSeq: number;
  reason: 'team-change';
}

/**
 * Prepare the `team-change` wake of a task change (create / owner reassign /
 * transfer). A valid leader gets the one mandatory wake whose `from_seq` is the
 * system record that stated the change. An unusable leader gets the
 * `invalid-leader` run instead, and a non-team target gets neither.
 */
export function prepareTeamChangeWake(
  db: Database.Database,
  targetId: string,
  fromSeq: number,
  env: NodeJS.ProcessEnv = process.env,
): TeamChangeWake | null {
  const state = readTeamTargetState(db, targetId, env);
  if (state === null) {
    return null;
  }
  if (!state.available) {
    recordInvalidLeaderRun(db, state);
    return null;
  }
  return {
    memberId: state.leaderMemberId,
    targetId,
    fromSeq,
    reason: 'team-change',
  };
}

/** One `team_assignment` row, exactly as the snapshot read and SSE frame shape it. */
export interface TeamAssignmentRecord {
  id: string;
  team_run_id: string;
  target_id: string;
  task_id: string | null;
  member_id: string;
  state: TeamAssignmentState;
  jump_consumed: 0 | 1;
  reply_excerpt: string | null;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

/** What a TeamAssign call writes on its first row: a running assignment or a final refusal. */
interface AssignmentInsert {
  teamRunId: string;
  targetId: string;
  taskId: string | null;
  memberId: string;
  jumpConsumed: 0 | 1;
}

/**
 * Open one assignment as `running` after its jump was consumed (D3.3 / D3.4
 * step 4). The jump is frozen at insert: a member failure never refunds it.
 */
export function startTeamAssignment(
  db: Database.Database,
  input: AssignmentInsert,
  startedAt = new Date().toISOString(),
): TeamAssignmentRecord {
  return insertTeamAssignment(db, {
    ...input,
    state: 'running',
    replyExcerpt: null,
    reason: null,
    startedAt,
    finishedAt: null,
  });
}

/**
 * Write a final assignment that never became a running round: an unavailable
 * target or an exhausted budget. `jump_consumed=0` is frozen with it; the
 * readable reason is the tool result the leader receives.
 */
export function insertFinalTeamAssignment(
  db: Database.Database,
  input: AssignmentInsert & {
    state: Extract<TeamAssignmentState, 'failed' | 'budget-exhausted'>;
    reason: string;
  },
  now = new Date().toISOString(),
): TeamAssignmentRecord {
  return insertTeamAssignment(db, {
    ...input,
    state: input.state,
    replyExcerpt: null,
    reason: input.reason,
    startedAt: now,
    finishedAt: now,
  });
}

/**
 * Close one running assignment exactly once. The state, excerpt and readable
 * reason are the only mutable fields; the jump stays as inserted.
 */
export function closeTeamAssignment(
  db: Database.Database,
  assignmentId: string,
  state: Extract<TeamAssignmentState, 'completed' | 'failed'>,
  fields: { replyExcerpt: string | null; reason: string | null },
  finishedAt = new Date().toISOString(),
): TeamAssignmentRecord {
  const updated = db
    .prepare(
      `UPDATE team_assignment
          SET state = ?, reply_excerpt = ?, reason = ?, finished_at = ?
        WHERE id = ? AND state = 'running'`,
    )
    .run(state, fields.replyExcerpt, fields.reason, finishedAt, assignmentId).changes;
  if (updated !== 1) {
    throw new Error(`team assignment is not running: ${assignmentId}`);
  }
  return readTeamAssignment(db, assignmentId);
}

function readTeamAssignment(db: Database.Database, assignmentId: string): TeamAssignmentRecord {
  const row = db
    .prepare(
      `SELECT id, team_run_id, target_id, task_id, member_id, state, jump_consumed,
              reply_excerpt, reason, started_at, finished_at
         FROM team_assignment WHERE id = ?`,
    )
    .get(assignmentId) as AssignmentRow | undefined;
  if (row === undefined) {
    throw new Error(`team assignment not found: ${assignmentId}`);
  }
  return assignmentRecord(row);
}

interface AssignmentInsertRow extends AssignmentInsert {
  state: TeamAssignmentState;
  replyExcerpt: string | null;
  reason: string | null;
  startedAt: string;
  finishedAt: string | null;
}

function insertTeamAssignment(
  db: Database.Database,
  input: AssignmentInsertRow,
): TeamAssignmentRecord {
  const id = randomUUID();
  db.prepare(
    `INSERT INTO team_assignment
       (id, team_run_id, target_id, task_id, member_id, state, jump_consumed, reply_excerpt,
        reason, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.teamRunId,
    input.targetId,
    input.taskId,
    input.memberId,
    input.state,
    input.jumpConsumed,
    input.replyExcerpt,
    input.reason,
    input.startedAt,
    input.finishedAt,
  );
  return readTeamAssignment(db, id);
}

function assignmentRecord(row: AssignmentRow): TeamAssignmentRecord {
  return {
    id: row.id,
    team_run_id: row.team_run_id,
    target_id: row.target_id,
    task_id: row.task_id,
    member_id: row.member_id,
    state: parseAssignmentState(row.state),
    jump_consumed: row.jump_consumed === 1 ? 1 : 0,
    reply_excerpt: row.reply_excerpt,
    reason: row.reason,
    started_at: row.started_at,
    finished_at: row.finished_at,
  };
}

/** The startup closure (D3.3): every residual `running` run / assignment is a
 * round the previous process never concluded. They close as `failed` with the
 * readable `interrupted` reason; `started_at` and `jump_consumed` are frozen,
 * and nothing is refunded, replayed or written as a message.
 */
export function closeInterruptedTeamRuns(db: Database.Database): {
  runs: number;
  assignments: number;
} {
  const now = new Date().toISOString();
  const reason = tFromDb(db, 'team.run.interrupted');
  const close = db.transaction((): { runs: number; assignments: number } => {
    const runs = db
      .prepare(
        `UPDATE team_run
            SET status = 'failed', reason = ?, finished_at = ?
          WHERE status = 'running'`,
      )
      .run(reason, now).changes;
    const assignments = db
      .prepare(
        `UPDATE team_assignment
            SET state = 'failed', reason = ?, finished_at = ?
          WHERE state = 'running'`,
      )
      .run(reason, now).changes;
    return { runs, assignments };
  });
  return close();
}

export interface TeamRunQuery {
  limit: number;
  /** The opaque cursor: the id of the last run on the previous page. */
  before?: string;
}

const DEFAULT_RUN_LIMIT = 20;
const MAX_RUN_LIMIT = 50;

/**
 * `limit` 1–50 with a default of 20. `before` is the run id cursor of the last
 * row already read; the snapshot is ordered by start time (newest first) with
 * rowid as the tiebreaker, so a same-millisecond clock cannot lose a row.
 */
export function parseTeamRunQuery(searchParams: URLSearchParams): TeamRunQuery {
  const rawLimit = searchParams.get('limit');
  let limit = DEFAULT_RUN_LIMIT;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > MAX_RUN_LIMIT) {
      throw ApiFailure.validation('limit must be an integer between 1 and 50', {
        field: 'limit',
        value: rawLimit,
      });
    }
    limit = Number(rawLimit);
  }

  const rawBefore = searchParams.get('before');
  if (rawBefore === null) {
    return { limit };
  }
  if (rawBefore.trim().length === 0) {
    throw ApiFailure.validation('before must be a non-empty team run id', {
      field: 'before',
      value: rawBefore,
    });
  }
  return { limit, before: rawBefore.trim() };
}

/**
 * The run snapshot of one target (D2.3): newest first, with each run's nested
 * assignments. A non-team target reads an empty list; an unknown target is a
 * 404 because it names no scope at all.
 */
export function listTeamRuns(
  db: Database.Database,
  targetId: string,
  query: TeamRunQuery,
  env: NodeJS.ProcessEnv = process.env,
): TeamRunView[] {
  if (readTargetKind(db, targetId) === null) {
    throw ApiFailure.notFound(`target not found: ${targetId}`);
  }
  if (readTeamTargetState(db, targetId, env) === null) {
    return [];
  }

  const params: unknown[] = [targetId];
  let cursorClause = '';
  if (query.before !== undefined) {
    const cursor = db
      .prepare('SELECT rowid AS rid, started_at FROM team_run WHERE id = ? AND target_id = ?')
      .get(query.before, targetId) as { rid: number; started_at: string } | undefined;
    if (cursor === undefined) {
      throw ApiFailure.validation('before must name a team run of this target', {
        field: 'before',
        value: query.before,
      });
    }
    cursorClause = 'AND (started_at < ? OR (started_at = ? AND rowid < ?))';
    params.push(cursor.started_at, cursor.started_at, cursor.rid);
  }
  params.push(query.limit);

  const rows = db
    .prepare(
      `${RUN_SELECT}
        WHERE target_id = ? ${cursorClause}
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...(params as never[])) as RunRow[];

  return rows.map((row) => ({
    id: row.id,
    target_id: row.target_id,
    channel_id: row.channel_id,
    task_id: row.task_id,
    leader_member_id: row.leader_member_id,
    status: parseRunStatus(row.status),
    reason: row.reason,
    started_at: row.started_at,
    finished_at: row.finished_at,
    assignments: readAssignments(db, row.id),
  }));
}

interface RunRow {
  rid: number;
  id: string;
  target_id: string;
  channel_id: string;
  task_id: string | null;
  leader_member_id: string;
  status: string;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

interface AssignmentRow {
  rid: number;
  id: string;
  team_run_id: string;
  target_id: string;
  task_id: string | null;
  member_id: string;
  state: string;
  jump_consumed: number;
  reply_excerpt: string | null;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

function readAssignments(db: Database.Database, runId: string): TeamAssignmentView[] {
  const rows = db
    .prepare(`${ASSIGNMENT_SELECT} WHERE team_run_id = ? ORDER BY started_at, rowid`)
    .all(runId) as AssignmentRow[];
  return rows.map((row) => ({
    id: row.id,
    team_run_id: row.team_run_id,
    target_id: row.target_id,
    task_id: row.task_id,
    member_id: row.member_id,
    state: parseAssignmentState(row.state),
    jump_consumed: row.jump_consumed === 1 ? 1 : 0,
    reply_excerpt: row.reply_excerpt,
    reason: row.reason,
    started_at: row.started_at,
    finished_at: row.finished_at,
  }));
}

function parseRunStatus(value: string): TeamRunStatus {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'invalid-leader':
      return value;
    default:
      throw new Error(`team_run row carries an unknown status: ${value}`);
  }
}

function parseAssignmentState(value: string): TeamAssignmentState {
  switch (value) {
    case 'running':
    case 'completed':
    case 'failed':
    case 'budget-exhausted':
      return value;
    default:
      throw new Error(`team_assignment row carries an unknown state: ${value}`);
  }
}
