import { randomUUID } from 'node:crypto';
import type { MessageKind } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { bindAttachments } from './attachments.js';
import { liveMemberClause } from './members.js';
import { parseMentions, type MentionCandidate } from './mentions.js';

/**
 * The one row insert behind every message write: the human face, backend
 * system events and a member round all land their rows here (轮次的落库路径
 * 只有一条). The caller owns the transaction; this function does not open one,
 * so a round can write its join event, its reply and its outcome in a single
 * boundary.
 *
 * What lives here is the part every writer shares: the author snapshot, the
 * `MAX(seq)+1` allocation, the mention ranges and the attachment binding. What
 * stays with the callers is what differs: the human face's archived/deleted
 * guard and client-id idempotency (`appendMessage`), and a round's decision to
 * dispatch wakes or not.
 */
export interface MessageRowInput {
  targetId: string;
  kind: MessageKind;
  /** Defaults to the owner; a system event names the member it is about. */
  authorMemberId?: string | null;
  body: string;
  clientMessageId?: string | null;
  /** Upload drafts to bind to this message in the same transaction. */
  attachmentIds?: readonly string[];
  /**
   * The task this channel system message points into. Backend-written only:
   * the db trigger refuses anything that is not a system message on the
   * channel that owns the task, and the human-face parser has no such field.
   */
  taskPointer?: string | null;
}

interface AuthorRow {
  id: string;
  display_name: string;
  avatar_slot: number;
}

export function insertMessageRow(
  db: Database.Database,
  input: MessageRowInput,
): { id: string; seq: number } {
  const author = readAuthor(db, input.authorMemberId ?? null);
  const id = randomUUID();
  const seq = nextSeq(db, input.targetId);
  db.prepare(
    `INSERT INTO message
       (id, target_id, seq, kind, author_member_id, author_display_name,
        author_avatar_slot, body, created_at, task_ref, task_pointer, client_message_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
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
    input.taskPointer ?? null,
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
}

/**
 * The author snapshot: display name and avatar slot are copied into the
 * message row, so renaming or soft-deleting the member later cannot rewrite
 * history. Human writes are always authored by the owner; a backend system
 * event may name the member it is about.
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

/**
 * The mention candidate set: every live member, the owner included, in a
 * stable order so duplicate display names resolve reproducibly.
 */
function listMentionCandidates(db: Database.Database): MentionCandidate[] {
  return db
    .prepare(`SELECT id, display_name FROM member WHERE ${liveMemberClause()} ORDER BY rowid`)
    .all() as MentionCandidate[];
}
