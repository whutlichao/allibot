import { randomUUID } from 'node:crypto';
import {
  TASK_STATUSES,
  type ChannelMode,
  type TaskStatus,
  type TaskView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { openEpoch } from './budget.js';
import { assertChannelReadable, assertChannelWritable } from './channels.js';
import { tFromDb } from './copy.js';
import { publishMessageCreated, publishTaskChanged } from './events.js';
import { insertMessageRow } from './message-store.js';
import { liveMemberClause, readOwnerId } from './members.js';
import { appendMessage } from './messages.js';
import { checkProviderAvailability } from './providers.js';
import type { Wake } from './rounds.js';
import { OWNER_ID_SUBQUERY } from './sql.js';
import { countUnread } from './unread.js';

/**
 * The backend-fixed legal move set. `closed` is terminal. The table travels
 * with every task payload as `allowed_transitions`; the frontend never keeps a
 * copy, so a board can only ever offer a move this table allows.
 */
export const TASK_STATUS_TRANSITIONS: Readonly<Record<TaskStatus, readonly TaskStatus[]>> = {
  todo: ['in_progress'],
  in_progress: ['in_review'],
  in_review: ['done'],
  done: ['closed'],
  closed: [],
};

/**
 * Who is performing a task write. The HTTP face is always the owner (there is
 * no login and no agent token); the member face passes the member the
 * orchestrator acts for. Only `in_review -> done` reads the actor: the
 * assignee cannot approve its own work, while the owner and any other member
 * can.
 */
export type TaskActor = { kind: 'owner' } | { kind: 'member'; memberId: string };

const OWNER_ACTOR: TaskActor = { kind: 'owner' };

interface TaskRow {
  id: string;
  channel_id: string;
  target_id: string;
  title: string;
  status: string;
  assignee_member_id: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
}

interface CountedTaskRow extends TaskRow {
  /** The owning channel's mode, derived on read (never stored on the task). */
  channel_mode: string;
  message_count: number;
}

/**
 * The task payload adds the two board readings to the row. `message_count`
 * counts every message in the task thread; `unread_count` is the pointer
 * chip's N — the thread's unread for the owner, read through the one unread
 * module (已读位置之后、kind ∈ {human, agent}、作者非本人的消息).
 *
 * The unread number is deliberately not a second SQL shape here: the task
 * target is one more target kind served by `countUnread`, so the channel, dm
 * and task readings cannot drift apart.
 */
const TASK_SELECT = `
SELECT t.id, t.channel_id, t.target_id, t.title, t.status, t.assignee_member_id,
       t.claimed_at, t.created_at, t.updated_at, c.mode AS channel_mode,
       (SELECT count(*) FROM message m WHERE m.target_id = t.target_id) AS message_count
FROM task t
JOIN channel c ON c.id = t.channel_id`;

/** The create body accepts the channel and the title; nothing else. */
const CREATE_FIELD_KEYS = new Set(['channel_id', 'title']);
/** The patch body changes the row in place; the channel is not a field. */
const PATCH_FIELD_KEYS = new Set(['title', 'status', 'assignee_member_id']);

/**
 * The task board: every task whose channel is alive, in creation order,
 * optionally narrowed to one channel. An archived channel keeps its tasks on
 * the board; a deleted channel takes them off it, while a task read or write
 * by id still works.
 */
export function listTasks(db: Database.Database, query: { channelId?: string }): TaskView[] {
  const where =
    query.channelId === undefined
      ? 'WHERE c.deleted_at IS NULL'
      : 'WHERE c.deleted_at IS NULL AND t.channel_id = ?';
  const params = query.channelId === undefined ? [] : [query.channelId];
  const rows = db
    .prepare(`${TASK_SELECT} ${where} ORDER BY t.created_at, t.rowid`)
    .all(...params) as CountedTaskRow[];
  const ownerId = readOwnerId(db);
  return rows.map((row) => toTaskView(row, countUnread(db, ownerId, row.target_id)));
}

/** A task by id stays readable after its channel is deleted. */
export function getTask(db: Database.Database, id: string): TaskView {
  const row = readTaskRow(db, id);
  return toTaskView(row, countUnread(db, readOwnerId(db), row.target_id));
}

/** The created task plus the seq of the 「任务已创建」 record (the team-change from_seq). */
export interface CreatedTask {
  task: TaskView;
  createdEventSeq: number;
}

/**
 * The owner creates a task. One transaction writes the task row, its task-type
 * target and the one `task_pointer` system message in the channel; any failure
 * leaves nothing behind. The task thread also gets its opening system event.
 *
 * A team channel's task target also gets the configured leader as a member in
 * the same transaction (D3.5): without that row the task-change wake would have
 * nobody to deliver to. The returned creation seq is the system record's seq,
 * which is the `from_seq` of the leader's mandatory first round.
 */
export function createTask(db: Database.Database, body: unknown): CreatedTask {
  const input = parseCreateInput(body);
  const create = db.transaction((): { id: string; createdEventSeq: number } => {
    const channel = assertChannelReadable(db, input.channelId);
    assertChannelWritable(channel);

    const id = randomUUID();
    const targetId = randomUUID();
    const now = new Date().toISOString();

    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'task')").run(targetId);
    db.prepare(
      `INSERT INTO task
         (id, channel_id, target_id, title, status, assignee_member_id, claimed_at,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, 'todo', NULL, NULL, ?, ?)`,
    ).run(id, input.channelId, targetId, input.title, now, now);
    db.prepare(
      `INSERT INTO target_member (target_id, member_id) VALUES (?, ${OWNER_ID_SUBQUERY})`,
    ).run(targetId);
    // The team leader joins the task thread at creation, so the task-change
    // wake has a member surface to deliver to (D3.5).
    db.prepare(
      `INSERT OR IGNORE INTO target_member (target_id, member_id)
       SELECT ?, team_leader_member_id
         FROM channel
        WHERE id = ? AND mode = 'team' AND team_leader_member_id IS NOT NULL`,
    ).run(targetId, input.channelId);

    // The task thread opens with the creation event; the channel gets the
    // pointer. Both are system messages, so neither wakes anyone nor counts
    // as unread. The creation record's seq is the team-change from_seq.
    const createdEvent = appendMessage(db, {
      targetId,
      kind: 'system',
      body: tFromDb(db, 'task.event.created', { title: input.title }),
    });
    appendMessage(db, {
      targetId: input.channelId,
      kind: 'system',
      body: tFromDb(db, 'task.pointer.body', { title: input.title }),
      taskPointer: id,
    });
    return { id, createdEventSeq: createdEvent.seq };
  });
  const created = create();
  const task = getTask(db, created.id);
  publishTaskChanged({ taskId: task.id, targetId: task.target_id, status: task.status });
  return { task, createdEventSeq: created.createdEventSeq };
}

/** One system record a claim landed, shaped like the subscription's publish input. */
export interface ClaimMessage {
  id: string;
  seq: number;
}

/** What a successful claim leaves for its caller to deliver. */
export interface Claim {
  wake: Wake;
  messages: ClaimMessage[];
}

/**
 * 认领 (Claim): the orchestrator, not the model, lets an available Agent take
 * a task nobody is assigned to yet.
 *
 * The whole claim is one transaction: the assignment, the two readable system
 * records (「已认领」 and 「认领后自动开工」), the claimer's `target_member` row,
 * the move to `in_progress`, and the human epoch opened at the 「已认领」 seq.
 * The wake is returned rather than delivered here because rounds are async and
 * write their own transactions; the caller dispatches it after this commit —
 * the same two-phase shape the message write path uses. It is not a jump and
 * is delivered even when the previous epoch was exhausted.
 *
 * `claimed_at` is the at-most-once lock: the guard and the conditional UPDATE
 * both read it, so a second attempt writes nothing.
 *
 * The candidate surface is the channel's live Agent members in join order,
 * filtered by `auto_claim = 1` and availability (model + credential + provider
 * consent, D1.12). One winner is the orchestrator's single-point decision, not
 * a race between several Agents.
 */
export function claimTask(
  db: Database.Database,
  taskId: string,
  env: NodeJS.ProcessEnv = process.env,
): Claim | null {
  const claim = db.transaction((): Claim | null => {
    const task = readTaskRow(db, taskId);
    if (task.claimed_at !== null || task.assignee_member_id !== null) {
      return null;
    }
    const status = parseStoredStatus(task.status);
    if (status !== 'todo' || !TASK_STATUS_TRANSITIONS[status].includes('in_progress')) {
      return null;
    }
    const channel = db
      .prepare('SELECT mode FROM channel WHERE id = ?')
      .get(task.channel_id) as { mode: string } | undefined;
    if (channel?.mode !== 'autonomous') {
      return null;
    }
    const claimer = selectClaimer(db, task.channel_id, env);
    if (claimer === null) {
      return null;
    }

    const now = new Date().toISOString();
    const updated = db
      .prepare(
        `UPDATE task
            SET assignee_member_id = ?, status = 'in_progress', claimed_at = ?, updated_at = ?
          WHERE id = ? AND claimed_at IS NULL AND assignee_member_id IS NULL`,
      )
      .run(claimer.id, now, now, taskId);
    if (updated.changes !== 1) {
      return null;
    }
    db.prepare('INSERT OR IGNORE INTO target_member (target_id, member_id) VALUES (?, ?)').run(
      task.target_id,
      claimer.id,
    );

    const claimed = insertMessageRow(db, {
      targetId: task.target_id,
      kind: 'system',
      body: tFromDb(db, 'task.event.claimed', {
        title: task.title,
        assignee: claimer.display_name,
      }),
    });
    // 首次认领 is a human-epoch opener, and the identity is the 「已认领」
    // record's seq — never the 「认领后自动开工」 record that follows it.
    openEpoch(db, task.target_id, claimed.seq);
    const started = insertMessageRow(db, {
      targetId: task.target_id,
      kind: 'system',
      body: tFromDb(db, 'task.event.claim.started', {
        title: task.title,
        assignee: claimer.display_name,
      }),
    });

    return {
      wake: {
        memberId: claimer.id,
        targetId: task.target_id,
        // The round reads through the latest claim record; the epoch identity
        // is the earlier one.
        fromSeq: started.seq,
        reason: 'claim',
      },
      messages: [claimed, started],
    };
  });
  const result = claim();
  if (result !== null) {
    // Both records are stored facts the subscription relays; the round that
    // follows announces its own reply.
    for (const message of result.messages) {
      publishMessageCreated({
        targetId: result.wake.targetId,
        id: message.id,
        seq: message.seq,
      });
    }
    publishTaskChanged({
      taskId,
      targetId: result.wake.targetId,
      status: 'in_progress',
    });
  }
  return result;
}

interface ClaimCandidate {
  id: string;
  display_name: string;
  model: string | null;
}

/** The first available Agent member of the channel that opted into auto-claim. */
function selectClaimer(
  db: Database.Database,
  channelId: string,
  env: NodeJS.ProcessEnv,
): ClaimCandidate | null {
  const candidates = db
    .prepare(
      `SELECT m.id, m.display_name, c.model
         FROM target_member tm
         JOIN member m ON m.id = tm.member_id
         JOIN agent_config c ON c.member_id = m.id
        WHERE tm.target_id = ? AND m.kind = 'agent' AND c.auto_claim = 1
          AND c.enabled = 1 AND ${liveMemberClause('m')}
        ORDER BY tm.rowid`,
    )
    .all(channelId) as ClaimCandidate[];
  for (const candidate of candidates) {
    // The same availability fact the status point reads as `offline` (#23):
    // no model, no provider consent, or no credential means no claim.
    if (checkProviderAvailability(db, candidate.model, env).ok) {
      return candidate;
    }
  }
  return null;
}

/**
 * Change the title, the status or the assignee. The row is mutable; every
 * actual change appends exactly one system event to the task thread, which is
 * the "what changed" history. A rejected patch writes nothing.
 *
 * The HTTP face calls this with the owner actor; the member face calls
 * `updateTaskStatusAsMember`, so the review rule applies to whoever the
 * orchestrator acts for.
 */
export interface TaskUpdate {
  task: TaskView;
  /**
   * The seq of the system record an assignee change appended, or null when the
   * assignment did not move. It is the `from_seq` of the leader's team-change
   * round on a team channel.
   */
  assigneeEventSeq: number | null;
}

export function updateTask(
  db: Database.Database,
  id: string,
  body: unknown,
  actor: TaskActor = OWNER_ACTOR,
): TaskUpdate {
  const patch = parsePatchInput(body);

  const update = db.transaction((): { changed: boolean; assigneeEventSeq: number | null } => {
    const current = readTaskRow(db, id);
    const nextTitle = patch.title ?? current.title;
    const nextStatus: TaskStatus = patch.status ?? parseStoredStatus(current.status);
    const nextAssignee =
      patch.assigneeMemberId === undefined
        ? current.assignee_member_id
        : patch.assigneeMemberId;

    if (nextStatus !== current.status) {
      assertLegalTransition(current, nextStatus, actor);
    }
    if (nextAssignee !== current.assignee_member_id) {
      assertAssignable(db, nextAssignee);
    }

    const titleChanged = nextTitle !== current.title;
    const statusChanged = nextStatus !== current.status;
    const assigneeChanged = nextAssignee !== current.assignee_member_id;
    // A patch that changes nothing is a no-op: no row update, no event.
    if (titleChanged || statusChanged || assigneeChanged) {
      db.prepare(
        `UPDATE task
            SET title = ?, status = ?, assignee_member_id = ?, updated_at = ?
          WHERE id = ?`,
      ).run(nextTitle, nextStatus, nextAssignee, new Date().toISOString(), id);
    }

    if (titleChanged) {
      appendMessage(db, {
        targetId: current.target_id,
        kind: 'system',
        body: tFromDb(db, 'task.event.title.renamed', {
          previous: current.title,
          title: nextTitle,
        }),
      });
    }
    if (statusChanged) {
      appendMessage(db, {
        targetId: current.target_id,
        kind: 'system',
        body: tFromDb(db, 'task.event.status.changed', {
          previous: statusLabel(db, parseStoredStatus(current.status)),
          status: statusLabel(db, nextStatus),
        }),
      });
    }
    let assigneeEventSeq: number | null = null;
    if (assigneeChanged) {
      assigneeEventSeq = appendAssigneeEvent(db, current, nextAssignee);
    }
    return {
      changed: titleChanged || statusChanged || assigneeChanged,
      assigneeEventSeq,
    };
  });
  const updated = update();
  const task = getTask(db, id);
  if (updated.changed) {
    // A no-op patch wrote nothing, so it announces nothing.
    publishTaskChanged({ taskId: task.id, targetId: task.target_id, status: task.status });
  }
  return { task, assigneeEventSeq: updated.assigneeEventSeq };
}

/**
 * The member-face status write. #24 (claim) and #26 (orchestrated rounds)
 * drive this entry point when a write is performed on behalf of a member
 * rather than the owner; HTTP never calls it, because the HTTP face is the
 * human face and cannot claim a member identity.
 *
 * The transition table is the same one the owner path uses. The one extra
 * rule is the review rule: the assignee cannot move its own `in_review` work
 * to `done` (409 conflict), while the owner and any other member can.
 */
export function updateTaskStatusAsMember(
  db: Database.Database,
  id: string,
  memberId: string,
  status: TaskStatus,
): TaskView {
  const member = db
    .prepare(`SELECT id FROM member WHERE id = ? AND ${liveMemberClause()}`)
    .get(memberId) as { id: string } | undefined;
  if (member === undefined) {
    throw ApiFailure.notFound(`member not found: ${memberId}`);
  }
  return updateTask(db, id, { status }, { kind: 'member', memberId }).task;
}

function assertLegalTransition(current: TaskRow, next: TaskStatus, actor: TaskActor): void {
  const from = parseStoredStatus(current.status);
  if (!TASK_STATUS_TRANSITIONS[from].includes(next)) {
    throw ApiFailure.validation(
      `status transition ${from} -> ${next} is not allowed`,
      { field: 'status', from, to: next, allowed_transitions: TASK_STATUS_TRANSITIONS[from] },
    );
  }
  // The review rule: an assignee cannot approve its own in_review work.
  if (
    from === 'in_review' &&
    next === 'done' &&
    actor.kind === 'member' &&
    actor.memberId === current.assignee_member_id
  ) {
    throw ApiFailure.conflict('the assignee cannot approve its own in_review work', {
      field: 'status',
      from,
      to: next,
      actor_member_id: actor.memberId,
    });
  }
}

/**
 * The M1 assignment surface is the owner's reassignment. An assignee is a live
 * Agent member; `null` takes the assignment back. Assigning does not change
 * the status — claim, not assignment, moves a task to in_progress.
 */
function assertAssignable(db: Database.Database, memberId: string | null): void {
  if (memberId === null) {
    return;
  }
  const member = db
    .prepare(`SELECT id, kind FROM member WHERE id = ? AND ${liveMemberClause()}`)
    .get(memberId) as { id: string; kind: string } | undefined;
  if (member === undefined) {
    throw ApiFailure.notFound(`member not found: ${memberId}`);
  }
  if (member.kind !== 'agent') {
    throw ApiFailure.validation('only an Agent can be assigned a task', {
      field: 'assignee_member_id',
      value: memberId,
    });
  }
}

function appendAssigneeEvent(
  db: Database.Database,
  current: TaskRow,
  nextAssignee: string | null,
): number {
  // The assignee joins the task thread's wake surface: assignment is the
  // owner's version of the same membership write claim performs.
  addAssigneeToThread(db, current.target_id, nextAssignee);

  const previousName =
    current.assignee_member_id === null ? null : displayName(db, current.assignee_member_id);
  const seq =
    nextAssignee === null
      ? appendMessage(db, {
          targetId: current.target_id,
          kind: 'system',
          body: tFromDb(db, 'task.event.assignee.unassigned'),
        }).seq
      : appendMessage(db, {
          targetId: current.target_id,
          kind: 'system',
          body:
            previousName === null
              ? tFromDb(db, 'task.event.assignee.assigned', { assignee: displayName(db, nextAssignee) })
              : tFromDb(db, 'task.event.assignee.reassigned', {
                  previous: previousName,
                  assignee: displayName(db, nextAssignee),
                }),
        }).seq;

  // The owner changing a task's assignee is one of the three human-epoch
  // openers (D1.13): the system message the change lands is the opener, and its
  // seq is the epoch identity. Unassigning is the same human act and lands the
  // same kind of record, so it opens an epoch the same way.
  openEpoch(db, current.target_id, seq);
  return seq;
}

/**
 * 转派 (Transfer, #38 / D3.5): the current assignee hands its task to another
 * live Agent member of the same channel. It changes only the assignee, appends
 * one system change record and adds the new assignee to the task target. It
 * does not open a human epoch, does not change the task five-state, does not
 * write a message body and never crosses the channel boundary.
 *
 * The caller owns the transaction (a round's commit), so a rejected transfer
 * writes nothing and the round keeps its own outcome.
 */
export type TaskTransferResult =
  | { ok: true; assigneeEventSeq: number; assigneeName: string }
  | { ok: false; reason: string };

export function transferTaskAsMember(
  db: Database.Database,
  taskId: string,
  actorMemberId: string,
  targetMemberId: string,
): TaskTransferResult {
  const task = readTaskRow(db, taskId);
  if (task.assignee_member_id !== actorMemberId) {
    return { ok: false, reason: tFromDb(db, 'round.transfer.notAssignee') };
  }
  if (targetMemberId === actorMemberId) {
    return { ok: false, reason: tFromDb(db, 'round.transfer.self') };
  }
  if (targetMemberId === task.assignee_member_id) {
    return { ok: false, reason: tFromDb(db, 'round.transfer.same') };
  }
  const target = db
    .prepare(
      `SELECT id, display_name FROM member
        WHERE id = ? AND kind = 'agent' AND ${liveMemberClause()}`,
    )
    .get(targetMemberId) as { id: string; display_name: string } | undefined;
  if (target === undefined) {
    return { ok: false, reason: tFromDb(db, 'round.transfer.notMember') };
  }
  const membership = db
    .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
    .get(task.channel_id, targetMemberId);
  if (membership === undefined) {
    return { ok: false, reason: tFromDb(db, 'round.transfer.notMember') };
  }

  const previousName = displayName(db, actorMemberId);
  db.prepare('UPDATE task SET assignee_member_id = ?, updated_at = ? WHERE id = ?').run(
    targetMemberId,
    new Date().toISOString(),
    taskId,
  );
  addAssigneeToThread(db, task.target_id, targetMemberId);
  const event = appendMessage(db, {
    targetId: task.target_id,
    kind: 'system',
    body: tFromDb(db, 'task.event.assignee.transferred', {
      previous: previousName,
      assignee: target.display_name,
    }),
  });
  return {
    ok: true,
    assigneeEventSeq: event.seq,
    assigneeName: target.display_name,
  };
}

function addAssigneeToThread(
  db: Database.Database,
  targetId: string,
  assigneeMemberId: string | null,
): void {
  if (assigneeMemberId === null) {
    return;
  }
  db.prepare('INSERT OR IGNORE INTO target_member (target_id, member_id) VALUES (?, ?)').run(
    targetId,
    assigneeMemberId,
  );
}

function displayName(db: Database.Database, memberId: string): string {
  const row = db.prepare('SELECT display_name FROM member WHERE id = ?').get(memberId) as
    | { display_name: string }
    | undefined;
  if (row === undefined) {
    throw new Error(`task member not found: ${memberId}`);
  }
  return row.display_name;
}

function statusLabel(db: Database.Database, status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return tFromDb(db, 'task.status.todo');
    case 'in_progress':
      return tFromDb(db, 'task.status.inProgress');
    case 'in_review':
      return tFromDb(db, 'task.status.inReview');
    case 'done':
      return tFromDb(db, 'task.status.done');
    case 'closed':
      return tFromDb(db, 'task.status.closed');
  }
}

function readTaskRow(db: Database.Database, id: string): CountedTaskRow {
  const row = db.prepare(`${TASK_SELECT} WHERE t.id = ?`).get(id) as CountedTaskRow | undefined;
  if (row === undefined) {
    throw ApiFailure.notFound(`task not found: ${id}`);
  }
  return row;
}

function toTaskView(row: CountedTaskRow, unreadCount: number): TaskView {
  const status = parseStoredStatus(row.status);
  return {
    id: row.id,
    channel_id: row.channel_id,
    target_id: row.target_id,
    title: row.title,
    status,
    assignee_member_id: row.assignee_member_id,
    claimed_at: row.claimed_at,
    created_at: row.created_at,
    updated_at: row.updated_at,
    channel_mode: parseChannelMode(row.channel_mode),
    allowed_transitions: [...TASK_STATUS_TRANSITIONS[status]],
    message_count: row.message_count,
    unread_count: unreadCount,
  };
}

function parseChannelMode(value: string): ChannelMode {
  if (value !== 'autonomous' && value !== 'team') {
    throw new Error(`task row carries an unknown channel mode: ${value}`);
  }
  return value;
}

function parseStoredStatus(value: string): TaskStatus {
  const status = TASK_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw new Error(`task row carries an unknown status: ${value}`);
  }
  return status;
}

interface CreateInput {
  channelId: string;
  title: string;
}

interface PatchInput {
  title?: string;
  status?: TaskStatus;
  assigneeMemberId?: string | null;
}

function parseCreateInput(body: unknown): CreateInput {
  const record = asObject(body);
  rejectUnknownFields(record, CREATE_FIELD_KEYS);
  return {
    channelId: requireIdentifier(record, 'channel_id'),
    title: requireTitle(record['title']),
  };
}

/**
 * The PATCH body: `title`, `status` and `assignee_member_id` are optional, at
 * least one must be present, and an unknown field is a validation failure. The
 * pointer fields are not part of this shape: they are backend facts.
 */
function parsePatchInput(body: unknown): PatchInput {
  const record = asObject(body);
  rejectUnknownFields(record, PATCH_FIELD_KEYS);
  const keys = Object.keys(record);
  if (keys.length === 0) {
    throw ApiFailure.validation('request body must name at least one task field');
  }

  const patch: PatchInput = {};
  if (record['title'] !== undefined) {
    patch.title = requireTitle(record['title']);
  }
  if (record['status'] !== undefined) {
    patch.status = parseStatus(record['status']);
  }
  if (Object.hasOwn(record, 'assignee_member_id')) {
    patch.assigneeMemberId = parseAssignee(record['assignee_member_id']);
  }
  return patch;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function rejectUnknownFields(record: Record<string, unknown>, allowed: Set<string>): void {
  for (const key of Object.keys(record)) {
    if (!allowed.has(key)) {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
}

function requireIdentifier(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation(`${key} must be a non-empty string`, { field: key });
  }
  return value.trim();
}

function requireTitle(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('title must be a non-empty string', { field: 'title' });
  }
  return value.trim();
}

function parseStatus(value: unknown): TaskStatus {
  const status = TASK_STATUSES.find((candidate) => candidate === value);
  if (status === undefined) {
    throw ApiFailure.validation(`status must be one of: ${TASK_STATUSES.join(', ')}`, {
      field: 'status',
      value,
    });
  }
  return status;
}

function parseAssignee(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('assignee_member_id must be a non-empty string or null', {
      field: 'assignee_member_id',
      value,
    });
  }
  return value.trim();
}

/**
 * The board filter. `channel_id` is an optional body-free query parameter; an
 * empty value is a client mistake rather than "every channel".
 */
export function parseTaskQuery(searchParams: URLSearchParams): { channelId?: string } {
  const raw = searchParams.get('channel_id');
  if (raw === null) {
    return {};
  }
  if (raw.trim().length === 0) {
    throw ApiFailure.validation('channel_id must be a non-empty string', { field: 'channel_id' });
  }
  return { channelId: raw.trim() };
}
