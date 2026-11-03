import { randomUUID } from 'node:crypto';
import {
  MESSAGE_KINDS,
  type MessageKind,
  type MessageMentionView,
  type MessageView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { bindAttachments, listAttachmentsForMessages } from './attachments.js';
import { assertChannelReadable, assertChannelWritable } from './channels.js';
import { liveMemberClause } from './members.js';
import { parseMentions, type MentionCandidate } from './mentions.js';

/** The human face may only write human messages. */
const HUMAN_MESSAGE_KIND = 'human';
/** A backfill page defaults to 50 rows and is capped at 200. */
const DEFAULT_PAGE_LIMIT = 50;
const MAX_PAGE_LIMIT = 200;

/**
 * The shape the backend write path accepts. The HTTP layer validates a request
 * body into this shape first; backend callers pass it directly, which is why
 * the message kind is not narrowed here. `system` events are written by
 * backend paths only (join-through, task create/change, reminder due,
 * auto-continue, task pointer); the six sources arrive with their own tickets
 * and all of them share this write path rather than growing a second one.
 */
export interface AppendMessageInput {
  targetId: string;
  kind: MessageKind;
  body: string;
  /** Defaults to the owner; a system event names the member it is about. */
  authorMemberId?: string | null;
  clientMessageId?: string | null;
  /** Upload drafts to bind to this message in the same transaction. */
  attachmentIds?: readonly string[];
}

interface MessageRow {
  id: string;
  target_id: string;
  seq: number;
  kind: string;
  author_member_id: string;
  author_display_name: string;
  author_avatar_slot: number;
  body: string;
  created_at: string;
  task_ref: string | null;
  task_pointer: string | null;
  client_message_id: string | null;
}

interface MentionRow {
  message_id: string;
  member_id: string;
  start: number;
  end: number;
}

interface AuthorRow {
  id: string;
  display_name: string;
  avatar_slot: number;
}

const MESSAGE_SELECT = `
SELECT id, target_id, seq, kind, author_member_id, author_display_name, author_avatar_slot,
       body, created_at, task_ref, task_pointer, client_message_id
FROM message`;

export function listMessages(
  db: Database.Database,
  targetId: string,
  query: { afterSeq: number; limit: number },
): MessageView[] {
  assertTargetReadable(db, targetId);
  const rows = db
    .prepare(`${MESSAGE_SELECT} WHERE target_id = ? AND seq > ? ORDER BY seq LIMIT ?`)
    .all(targetId, query.afterSeq, query.limit) as MessageRow[];
  return hydrate(db, rows);
}

/**
 * The single message write path shared by the human face, the backend system
 * events and the later AG-UI run path. Everything happens in one transaction:
 * the archived/deleted guard, the client message id idempotency lookup, the
 * author snapshot, `MAX(seq)+1`, the body insert and the mention rows the
 * parser resolved.
 *
 * Returns the new (or replayed) message identity; a replay writes nothing.
 */
export function appendMessage(
  db: Database.Database,
  input: AppendMessageInput,
): { id: string; seq: number } {
  const write = db.transaction((): { id: string; seq: number } => {
    assertTargetWritable(db, input.targetId);

    if (input.clientMessageId !== null && input.clientMessageId !== undefined) {
      const replay = db
        .prepare('SELECT id, seq FROM message WHERE target_id = ? AND client_message_id = ?')
        .get(input.targetId, input.clientMessageId) as { id: string; seq: number } | undefined;
      if (replay !== undefined) {
        return replay;
      }
    }

    const author = readAuthor(db, input.authorMemberId ?? null);
    const id = randomUUID();
    const seq = nextSeq(db, input.targetId);
    db.prepare(
      `INSERT INTO message
         (id, target_id, seq, kind, author_member_id, author_display_name,
          author_avatar_slot, body, created_at, task_ref, task_pointer, client_message_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)`,
    ).run(
      id,
      input.targetId,
      seq,
      input.kind,
      author.id,
      author.display_name,
      author.avatar_slot,
      input.body,
      new Date().toISOString(),
      input.clientMessageId ?? null,
    );

    // A system event is a record, not a turn: it wakes nobody, so it carries no
    // mention ranges even when its text happens to contain an @name.
    if (input.kind !== 'system') {
      const insertMention = db.prepare(
        `INSERT INTO message_mention (message_id, member_id, start, "end") VALUES (?, ?, ?, ?)`,
      );
      for (const mention of parseMentions(input.body, listMentionCandidates(db))) {
        insertMention.run(id, mention.member_id, mention.start, mention.end);
      }
    }

    // Binding is part of the same transaction as the message row: an unknown or
    // already-bound attachment aborts the whole write, so no message is left
    // holding a partial attachment set.
    bindAttachments(db, id, input.attachmentIds ?? []);
    return { id, seq };
  });
  return write();
}

/**
 * The mention candidate set: every live member, the owner included, in a
 * stable order so duplicate display names resolve reproducibly.
 */
function listMentionCandidates(db: Database.Database): MentionCandidate[] {
  return db
    .prepare(
      `SELECT id, display_name FROM member WHERE ${liveMemberClause()} ORDER BY rowid`,
    )
    .all() as MentionCandidate[];
}

/**
 * The author snapshot: display name and avatar slot are copied into the message
 * row, so renaming or soft-deleting the member later cannot rewrite history.
 * Human writes are always authored by the owner; a backend system event may
 * name the member it is about.
 */
function readAuthor(db: Database.Database, memberId: string | null): AuthorRow {
  const row =
    memberId === null
      ? (db
          .prepare(
            `SELECT id, display_name, avatar_slot FROM member
              WHERE kind = 'owner' AND ${liveMemberClause()}`,
          )
          .get() as AuthorRow | undefined)
      : (db
          .prepare(
            `SELECT id, display_name, avatar_slot FROM member
              WHERE id = ? AND ${liveMemberClause()}`,
          )
          .get(memberId) as AuthorRow | undefined);
  if (row === undefined) {
    throw new Error(`message author not found: ${memberId ?? 'owner'}`);
  }
  return row;
}

/**
 * `MAX(seq) + 1` inside the write transaction. `UNIQUE(target_id, seq)` is the
 * backstop: a second writer would abort rather than reuse a number.
 */
function nextSeq(db: Database.Database, targetId: string): number {
  const row = db
    .prepare('SELECT coalesce(MAX(seq), 0) AS last FROM message WHERE target_id = ?')
    .get(targetId) as { last: number };
  return row.last + 1;
}

function hydrate(db: Database.Database, rows: readonly MessageRow[]): MessageView[] {
  if (rows.length === 0) {
    return [];
  }
  const mentions = new Map<string, MessageMentionView[]>();
  const placeholders = rows.map(() => '?').join(', ');
  const mentionRows = db
    .prepare(
      `SELECT message_id, member_id, start, "end" FROM message_mention
        WHERE message_id IN (${placeholders}) ORDER BY start`,
    )
    .all(...rows.map((row) => row.id)) as MentionRow[];
  for (const mention of mentionRows) {
    const bucket = mentions.get(mention.message_id) ?? [];
    bucket.push({ member_id: mention.member_id, start: mention.start, end: mention.end });
    mentions.set(mention.message_id, bucket);
  }
  const attachments = listAttachmentsForMessages(db, rows.map((row) => row.id));
  return rows.map((row) => ({
    id: row.id,
    target_id: row.target_id,
    seq: row.seq,
    kind: parseStoredKind(row.kind),
    author_member_id: row.author_member_id,
    author_display_name: row.author_display_name,
    author_avatar_slot: row.author_avatar_slot,
    body: row.body,
    created_at: row.created_at,
    task_ref: row.task_ref,
    task_pointer: row.task_pointer,
    client_message_id: row.client_message_id,
    mentions: mentions.get(row.id) ?? [],
    // The metadata of what this message bound; `storage_path` is never part of
    // a message read.
    attachments: attachments.get(row.id) ?? [],
  }));
}

/**
 * Resolve the target row. A channel-type target is a shadow row reusing the
 * channel id, so its state lives in the channel row and is checked through the
 * channel guards; DM and task targets arrive with their own tickets and flow
 * through the same two wrappers.
 */
function readTarget(db: Database.Database, targetId: string): { kind: string } {
  const target = db.prepare('SELECT kind FROM target WHERE id = ?').get(targetId) as
    | { kind: string }
    | undefined;
  if (target === undefined) {
    throw ApiFailure.notFound(`target not found: ${targetId}`);
  }
  return target;
}

/** History stays readable on an archived channel; a deleted channel is 404. */
function assertTargetReadable(db: Database.Database, targetId: string): void {
  if (readTarget(db, targetId).kind === 'channel') {
    assertChannelReadable(db, targetId);
  }
}

/** The write guard from #9, reused rather than restated: archived is 400, deleted is 404. */
function assertTargetWritable(db: Database.Database, targetId: string): void {
  if (readTarget(db, targetId).kind === 'channel') {
    assertChannelWritable(assertChannelReadable(db, targetId));
  }
}

export function parsePageQuery(searchParams: URLSearchParams): {
  afterSeq: number;
  limit: number;
} {
  return {
    // A seq beyond the current maximum is a legal (empty) page, so after_seq
    // has no upper bound; limit is a positive integer capped at the page size.
    afterSeq: parseQueryInteger(searchParams, 'after_seq', 0) ?? 0,
    limit: parseQueryInteger(searchParams, 'limit', 1, MAX_PAGE_LIMIT) ?? DEFAULT_PAGE_LIMIT,
  };
}

function parseQueryInteger(
  searchParams: URLSearchParams,
  field: string,
  min: number,
  max?: number,
): number | undefined {
  const raw = searchParams.get(field);
  if (raw === null) {
    return undefined;
  }
  if (!/^\d+$/.test(raw) || Number(raw) < min || (max !== undefined && Number(raw) > max)) {
    const bound = max === undefined ? `>= ${min}` : `between ${min} and ${max}`;
    throw ApiFailure.validation(`${field} must be an integer ${bound}`, { field, value: raw });
  }
  return Number(raw);
}

/**
 * The human-face request fields. `task_ref` and `task_pointer` are deliberately
 * absent: both are backend facts (a task reference belongs to the task thread,
 * and the channel pointer message is written by the backend when a task is
 * created), so the human face asking for one is an unknown field.
 */
const FIELD_KEYS = new Set(['body', 'kind', 'client_message_id', 'attachment_ids']);

/**
 * The human-face request body. `kind` is accepted as a known field so that
 * asking for a system event reads as a validation failure rather than an
 * unknown field, but only `human` passes: `system` belongs to backend paths.
 * The task reference fields are not part of this shape — they are backend
 * facts, so asking for one is an unknown field.
 */
export function parseMessageRequest(targetId: string, body: unknown): AppendMessageInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!FIELD_KEYS.has(key)) {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }

  const text = record['body'];
  if (typeof text !== 'string' || text.trim().length === 0) {
    throw ApiFailure.validation('body must be a non-empty string');
  }

  return {
    targetId,
    kind: parseHumanKind(record['kind']),
    // The stored body and the parsed body are the same string; mention offsets
    // are relative to it, so trimming happens once, before both.
    body: text.trim(),
    clientMessageId: optionalIdentifier(record, 'client_message_id'),
    attachmentIds: parseAttachmentIds(record['attachment_ids']),
  };
}

/**
 * The upload drafts this message binds. A repeated id is a client mistake, not
 * two attachments; the read path lists what was bound in upload order.
 */
function parseAttachmentIds(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw ApiFailure.validation('attachment_ids must be an array of strings', {
      field: 'attachment_ids',
      value,
    });
  }
  const ids: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw ApiFailure.validation('attachment_ids must be an array of non-empty strings', {
        field: 'attachment_ids',
        value: entry,
      });
    }
    if (ids.includes(entry)) {
      throw ApiFailure.validation(`duplicate attachment id: ${entry}`, {
        field: 'attachment_ids',
        value: entry,
      });
    }
    ids.push(entry);
  }
  return ids;
}

function parseHumanKind(value: unknown): MessageKind {
  if (value === undefined) {
    return HUMAN_MESSAGE_KIND;
  }
  if (value !== 'human') {
    throw ApiFailure.validation('the human face cannot write an agent or system message', {
      field: 'kind',
      value,
    });
  }
  return HUMAN_MESSAGE_KIND;
}

/**
 * The column is a CHECK constraint, so a stored kind is always one of the
 * three; the guard turns a hand-edited database into a readable error rather
 * than an unchecked cast.
 */
function parseStoredKind(value: string): MessageKind {
  const kind = MESSAGE_KINDS.find((candidate) => candidate === value);
  if (kind === undefined) {
    throw new Error(`message row carries an unknown kind: ${value}`);
  }
  return kind;
}

function optionalIdentifier(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation(`${key} must be a non-empty string or null`, { field: key, value });
  }
  return value;
}
