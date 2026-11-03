import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  RoundInput,
  RoundMember,
  RoundMessage,
  RoundProvider,
  RoundResult,
  WakeReason,
} from './agent-seam.js';
import { insertMessageRow } from './message-store.js';
import { liveMemberClause } from './members.js';

/**
 * The readable zh-CN copy for round outcomes (轮次结果 reason) and the round
 * finished reason (轮次结束原因). The spec routes backend-generated text
 * through the string catalog (#8); that catalog is not on this branch yet, so
 * this module is the single formatting entry point — every readable round text
 * goes through `roundText` / `finishedReasonText`, and #8 replaces the tables
 * behind them without touching a caller or a stored row.
 *
 * Stored rows keep the language they were written in; the catalog ticket owns
 * the locale preference, which is why nothing here reads a request header.
 */
export const ROUND_TEXT = {
  'wake.channel-message': '本轮由频道消息唤醒',
  'wake.mention': '本轮由个人提及唤醒',
  'wake.claim': '本轮由认领唤醒',
  'wake.continue': '本轮由自动续跑唤醒',
  'verdict.replied': '已回复',
  'verdict.ignored': '自判忽略：本轮没有需要回应的话',
  'verdict.failed': '处理失败，需要排查',
  'penetration.suffix': '；本轮是被点名的穿透唤醒，回复时顺带加入频道，加入事件 seq={seq}',
  'merged.reason': '已有一轮在进行中（in-flight）：{count} 次重复唤醒合并进那一轮，以最大 seq #{largest} 为准；不排队、不重放',
  'round.no-body': '本轮没有产出可落库的正文',
  'join.event': '{name} 加入了频道：它被点名时并不在频道里，回复时顺带加入（成员变化只随真实回复发生）',
} as const;

export type RoundTextKey = keyof typeof ROUND_TEXT;

/** Render one readable round text; the single formatting entry point. */
export function roundText(
  key: RoundTextKey,
  params: Record<string, string | number> = {},
): string {
  return ROUND_TEXT[key].replace(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name];
    return value === undefined ? match : String(value);
  });
}

/**
 * The round finished reason (轮次结束原因) is a separate fact from the round
 * status. This ticket only produces normal completion and error; a merged row
 * has no round of its own, so its finished reason stays unknown (NULL).
 */
export const FINISHED_REASON = {
  completed: '正常完成',
  error: '错误',
} as const;

export type FinishedReason = keyof typeof FINISHED_REASON;

/** The readable finished-reason value stored in `round_outcome`. */
export function finishedReasonText(reason: FinishedReason): string {
  return FINISHED_REASON[reason];
}

/**
 * One delivered wake. The signal carries identifiers only — `(member_id,
 * targetId, fromSeq, reason)` — and never a body: the round reads messages
 * through the ordinary read path. Whether the member already belongs to the
 * target is a membership fact read when the round closes, not a field of the
 * wake signal.
 */
export interface Wake {
  memberId: string;
  targetId: string;
  fromSeq: number;
  reason: WakeReason;
}

interface AgentMemberRow {
  id: string;
  display_name: string;
  role: string;
  model: string | null;
  system_prompt: string;
}

/**
 * The wake surface for one successfully written message (唤醒面): every live
 * Agent member of the target except the author — human and Agent authors
 * alike — plus any mentioned Agent that is not a member (穿透).
 *
 * `system` messages wake nobody: they are records, not turns. Archived and
 * deleted channels never reach this point because their write path refuses the
 * message first, so they never produce a wake.
 *
 * The caller runs this after the message transaction commits, so a failed
 * write wakes nobody; the mention rows it reads are the write-time snapshot,
 * not a fresh parse of the body.
 */
export function collectWakes(
  db: Database.Database,
  message: { targetId: string; authorMemberId: string; kind: string; seq: number },
): Wake[] {
  if (message.kind !== 'human' && message.kind !== 'agent') {
    return [];
  }

  const mentioned = new Set(
    listMentionedAgents(db, message.targetId, message.seq).map((member) => member.id),
  );
  const wakes: Wake[] = [];
  const woken = new Set<string>();

  for (const member of listTargetAgentMembers(db, message.targetId)) {
    if (member.id === message.authorMemberId) {
      continue;
    }
    wakes.push({
      memberId: member.id,
      targetId: message.targetId,
      fromSeq: message.seq,
      // The reason is readable diagnostics only; a mention is the more
      // specific of the two, and the wake set is the same either way.
      reason: mentioned.has(member.id) ? 'mention' : 'channel-message',
    });
    woken.add(member.id);
  }

  for (const member of listMentionedAgents(db, message.targetId, message.seq)) {
    if (member.id === message.authorMemberId || woken.has(member.id)) {
      continue;
    }
    wakes.push({
      memberId: member.id,
      targetId: message.targetId,
      fromSeq: message.seq,
      reason: 'mention',
    });
    woken.add(member.id);
  }

  return wakes;
}

/** The target's live Agent members, in join order. */
function listTargetAgentMembers(db: Database.Database, targetId: string): AgentMemberRow[] {
  return db
    .prepare(
      `SELECT m.id, m.display_name, c.role, c.model, c.system_prompt
         FROM target_member tm
         JOIN member m ON m.id = tm.member_id
         JOIN agent_config c ON c.member_id = m.id
        WHERE tm.target_id = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}
        ORDER BY tm.rowid`,
    )
    .all(targetId) as AgentMemberRow[];
}

/** The live Agents this message mentioned, members or not. */
function listMentionedAgents(
  db: Database.Database,
  targetId: string,
  messageSeq: number,
): { id: string }[] {
  return db
    .prepare(
      `SELECT DISTINCT m.id
         FROM message_mention mm
         JOIN message msg ON msg.id = mm.message_id
         JOIN member m ON m.id = mm.member_id
        WHERE msg.target_id = ? AND msg.seq = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}
        ORDER BY m.rowid`,
    )
    .all(targetId, messageSeq) as { id: string }[];
}

/**
 * The in-flight registry: process state, never persisted. A restarted backend
 * replays nothing; a round lives only as long as its process.
 */
export interface Turn {
  targetId: string;
  /** Seqs of the same-target wakes that arrived while this round was running. */
  repeats: number[];
  /**
   * Wakes for another target that arrived while this round was running. They
   * are not a repeated wake (a merge must not carry another scope's seq), so
   * they wait for this round to close and then run as their own round. M1 only
   * writes channel targets, so this is the cross-target guard rather than a
   * shape anything exercises today.
   */
  deferred: Wake[];
}

export interface InFlightRounds {
  get(memberId: string): Turn | undefined;
  set(memberId: string, turn: Turn): void;
  delete(memberId: string): void;
}

export function createInFlightRounds(): InFlightRounds {
  const turns = new Map<string, Turn>();
  return {
    get: (memberId) => turns.get(memberId),
    set: (memberId, turn) => {
      turns.set(memberId, turn);
    },
    delete: (memberId) => {
      turns.delete(memberId);
    },
  };
}

/**
 * Deliver a message's wakes. One Agent has at most one round in flight: a wake
 * that arrives while a round runs for the same member is not queued and not
 * replayed — it folds into the running round and leaves one `merged` row.
 *
 * A synchronous adapter finishes its rounds before this returns (the message
 * write request waits for them, which keeps the observable order stable). A
 * deferred adapter (the scripted `delay` behaviour today) is started and left
 * to settle on its own: the write request answers immediately.
 */
export async function dispatchWakes(
  db: Database.Database,
  provider: RoundProvider,
  wakes: readonly Wake[],
  inFlight: InFlightRounds,
  onError: (error: unknown, wake: Wake) => void = (error, wake) => {
    // Failure isolation: one member's round must not fail the message write or
    // another member's round. The message is already committed; an adapter
    // failure is folded into a `failed` outcome by runRound, so what reaches
    // here is a storage-level problem worth a log line and nothing more.
    console.error(`allibot: round for member ${wake.memberId} failed:`, error);
  },
): Promise<void> {
  for (const wake of wakes) {
    if (provider.deferred) {
      void runRound(db, provider, wake, inFlight).catch((error: unknown) => onError(error, wake));
      continue;
    }
    try {
      await runRound(db, provider, wake, inFlight);
    } catch (error) {
      onError(error, wake);
    }
  }
}

/**
 * Run one member round and close it with at most one target message and
 * exactly one round outcome row. Returns the row this wake produced; a wake
 * folded into a running round returns null (its `merged` row is written when
 * that round closes).
 *
 * A penetrated member that replies joins the channel first (a system join
 * event, then the reply); one that does not reply never joins.
 */
export async function runRound(
  db: Database.Database,
  provider: RoundProvider,
  wake: Wake,
  inFlight: InFlightRounds,
): Promise<RoundOutcomeRow | null> {
  const active = inFlight.get(wake.memberId);
  if (active !== undefined) {
    if (active.targetId === wake.targetId) {
      active.repeats.push(wake.fromSeq);
    } else {
      active.deferred.push(wake);
    }
    return null;
  }

  const turn: Turn = { targetId: wake.targetId, repeats: [], deferred: [] };
  inFlight.set(wake.memberId, turn);
  const startedAt = new Date().toISOString();

  let result: RoundResult;
  try {
    result = await provider.runRound(readRoundInput(db, wake));
  } catch (error) {
    // A wake that arrived after the adapter settled but before this round's
    // transaction commits still folds into this round; a crash here must not
    // leave the member marked in-flight forever (working is process state).
    result = { verdict: 'failed', replies: [], detail: errorMessage(error) };
  }

  let committed: RoundOutcomeRow;
  try {
    committed = commitRound(db, wake, turn, startedAt, result);
  } finally {
    inFlight.delete(wake.memberId);
  }
  // The other-target wakes wait here rather than running in parallel: one
  // member still has at most one round in flight.
  for (const deferred of turn.deferred) {
    await runRound(db, provider, deferred, inFlight);
  }
  return committed;
}

export interface RoundOutcomeRow {
  id: string;
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
  finished_reason: string | null;
  started_at: string;
  finished_at: string;
  budget_consumed: number;
  merged: number;
}

function readRoundInput(db: Database.Database, wake: Wake): RoundInput {
  const member = db
    .prepare(
      `SELECT m.id, m.display_name, c.role, c.model, c.system_prompt
         FROM member m JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}`,
    )
    .get(wake.memberId) as RoundMember | undefined;
  if (member === undefined) {
    throw new Error(`round member not found: ${wake.memberId}`);
  }

  const rows = db
    .prepare(
      `SELECT seq, kind, author_member_id, author_display_name, body
         FROM message WHERE target_id = ? AND seq >= ? ORDER BY seq`,
    )
    .all(wake.targetId, wake.fromSeq) as {
    seq: number;
    kind: string;
    author_member_id: string;
    author_display_name: string;
    body: string;
  }[];
  const messages: RoundMessage[] = rows.map((row) => ({
    seq: row.seq,
    kind: row.kind as RoundMessage['kind'],
    author_member_id: row.author_member_id,
    author_display_name: row.author_display_name,
    body: row.body,
  }));

  return { member, targetId: wake.targetId, baseSeq: wake.fromSeq, reason: wake.reason, messages };
}

/**
 * Everything a round writes shares one transaction: the optional join, the
 * reply, the folded `merged` row and the round's own outcome.
 *
 * The wakes that arrived while this round was running are not queued and not
 * replayed: they fold into exactly one `merged` row, whose base seq is the
 * largest of them (以最大 seq 为准), written before the running round's row.
 */
function commitRound(
  db: Database.Database,
  wake: Wake,
  turn: Turn,
  startedAt: string,
  result: RoundResult,
): RoundOutcomeRow {
  const write = db.transaction((): RoundOutcomeRow => {
    const joinedSeq = commitJoin(db, wake, result);
    const replySeq = commitReply(db, wake, result);
    const finishedAt = new Date().toISOString();

    if (turn.repeats.length > 0) {
      insertOutcome(db, {
        wake,
        baseSeq: Math.max(...turn.repeats),
        status: 'merged',
        reason: roundText('merged.reason', {
          count: turn.repeats.length,
          largest: Math.max(...turn.repeats),
        }),
        merged: 1,
        startedAt,
        finishedAt,
      });
    }

    const finishedReason: FinishedReason = result.verdict === 'failed' ? 'error' : 'completed';
    return insertOutcome(db, {
      wake,
      baseSeq: wake.fromSeq,
      status: result.verdict,
      reason: roundReason(wake, result, joinedSeq, replySeq),
      merged: 0,
      startedAt,
      finishedAt,
      finishedReason,
    });
  });
  return write();
}

/**
 * A member woken by a mention without belonging to the target joins only when
 * it actually replies (穿透). The join is recorded before the reply: member
 * change first, then speech. The join event is a `system` message authored by
 * the owner (the existing convention), so it wakes nobody, consumes no budget
 * and is never unread.
 *
 * Only a channel-shaped target gains a member this way. A DM's membership is
 * fixed to its two rows, so a pierced reply there is one-shot delivery with no
 * membership change — that rule belongs to the DM ticket; this guard keeps
 * this ticket from writing a DM membership it cannot own.
 */
function commitJoin(db: Database.Database, wake: Wake, result: RoundResult): number | null {
  if (result.verdict !== 'replied' || !hasBody(result)) {
    return null;
  }
  if (readTargetKind(db, wake.targetId) !== 'channel') {
    return null;
  }
  const already = db
    .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
    .get(wake.targetId, wake.memberId);
  if (already !== undefined) {
    return null;
  }
  const member = db
    .prepare('SELECT display_name FROM member WHERE id = ?')
    .get(wake.memberId) as { display_name: string } | undefined;
  if (member === undefined) {
    return null;
  }

  db.prepare('INSERT INTO target_member (target_id, member_id) VALUES (?, ?)').run(
    wake.targetId,
    wake.memberId,
  );
  return insertMessage(
    db,
    wake.targetId,
    'system',
    ownerId(db),
    roundText('join.event', { name: member.display_name }),
  );
}

function readTargetKind(db: Database.Database, targetId: string): string {
  const row = db.prepare('SELECT kind FROM target WHERE id = ?').get(targetId) as
    | { kind: string }
    | undefined;
  return row?.kind ?? '';
}

function commitReply(db: Database.Database, wake: Wake, result: RoundResult): number | null {
  if (result.verdict !== 'replied' || !hasBody(result)) {
    return null;
  }
  // 一轮 ↔ 至多一条 target 消息: the seam may hand over several pending
  // replies, and this write path lands the first one. Streaming the rest is
  // the AG-UI ticket's shape, not a second message per round here.
  return insertMessage(db, wake.targetId, 'agent', wake.memberId, result.replies[0]!.trim());
}

function hasBody(result: RoundResult): boolean {
  const body = result.replies[0];
  return result.verdict === 'replied' && body !== undefined && body.trim().length > 0;
}

/**
 * Round output goes through the same row insert as every other message writer:
 * one landing path for the author snapshot, `MAX(seq)+1`, mention ranges and
 * attachments. It deliberately does not call `appendMessage`: that path
 * dispatches wakes, and a round reply's own wake delivery is the relay
 * ticket's (#16), where a jump is counted and bounded.
 */
function insertMessage(
  db: Database.Database,
  targetId: string,
  kind: 'agent' | 'system',
  authorMemberId: string,
  body: string,
): number {
  return insertMessageRow(db, { targetId, kind, authorMemberId, body }).seq;
}

function ownerId(db: Database.Database): string {
  const row = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as
    | { id: string }
    | undefined;
  if (row === undefined) {
    throw new Error('owner row is missing');
  }
  return row.id;
}

function roundReason(
  wake: Wake,
  result: RoundResult,
  joinedSeq: number | null,
  replySeq: number | null,
): string {
  const parts: string[] = [roundText(`wake.${wake.reason}`)];
  if (result.verdict === 'replied' && replySeq === null) {
    // A reply verdict with no committable body is still the adapter's own
    // verdict; the response-judgement ticket decides whether that is a
    // failure under a definite signal. Here it is only stated, not judged.
    parts.push(roundText('round.no-body'));
  } else {
    parts.push(roundText(`verdict.${result.verdict}`));
  }
  if (result.detail !== undefined && result.detail.length > 0) {
    parts.push(result.detail);
  }
  if (joinedSeq !== null) {
    parts.push(roundText('penetration.suffix', { seq: joinedSeq }));
  }
  return parts.join('；').replace(/^；/, '');
}

interface InsertOutcomeInput {
  wake: Wake;
  baseSeq: number;
  status: string;
  reason: string;
  merged: number;
  startedAt: string;
  finishedAt: string;
  finishedReason?: FinishedReason;
}

function insertOutcome(db: Database.Database, input: InsertOutcomeInput): RoundOutcomeRow {
  const id = randomUUID();
  const finishedReason =
    input.finishedReason === undefined ? null : finishedReasonText(input.finishedReason);
  db.prepare(
    `INSERT INTO round_outcome
       (id, member_id, target_id, base_seq, status, reason, finished_reason,
        started_at, finished_at, budget_consumed, merged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
  ).run(
    id,
    input.wake.memberId,
    input.wake.targetId,
    input.baseSeq,
    input.status,
    input.reason,
    finishedReason,
    input.startedAt,
    input.finishedAt,
    input.merged,
  );
  return {
    id,
    member_id: input.wake.memberId,
    target_id: input.wake.targetId,
    base_seq: input.baseSeq,
    status: input.status,
    reason: input.reason,
    finished_reason: finishedReason,
    started_at: input.startedAt,
    finished_at: input.finishedAt,
    budget_consumed: 0,
    merged: input.merged,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
