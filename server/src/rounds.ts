import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type {
  RoundDiscipline,
  RoundInput,
  RoundMember,
  RoundMemory,
  RoundMessage,
  RoundProvider,
  RoundResult,
  RoundTargetKind,
  WakeReason,
} from './agent-seam.js';
import { budgetExhaustedReason, tryConsumeJump, type BudgetRow } from './budget.js';
import { tFromDb } from './copy.js';
import { publishMessageCreated, publishRoundOutcome } from './events.js';
import { memoryPromptSection, recallForRound, writeRoundMemoryCard } from './memory.js';
import { insertMessageRow } from './message-store.js';
import { liveMemberClause } from './members.js';

/**
 * The readable round copy. Backend-generated text renders through the shared
 * string catalog (#8) by the stored locale preference, so every readable round
 * text goes through `tFromDb` — the one formatting entry point — and stored
 * rows keep the language they were written in (a later preference switch never
 * rewrites history).
 */

/** The readable text of a wake reason; the reason only picks diagnostics copy. */
function wakeText(db: Database.Database, reason: WakeReason): string {
  switch (reason) {
    case 'channel-message':
      return tFromDb(db, 'wake.channelMessage');
    case 'mention':
      return tFromDb(db, 'wake.mention');
    case 'claim':
      return tFromDb(db, 'wake.claim');
    case 'continue':
      return tFromDb(db, 'wake.continue');
  }
}

/**
 * The seam verdict's readable text. Whether a silent / ignored / body-less
 * verdict closes as a failure is the response judgement's rule (回应判断),
 * which is applied on top of this text, never derived from it.
 */
function verdictText(db: Database.Database, verdict: RoundResult['verdict']): string {
  switch (verdict) {
    case 'replied':
      return tFromDb(db, 'round.replied');
    case 'ignored':
      return tFromDb(db, 'round.ignored');
    case 'silent':
      return tFromDb(db, 'round.silent');
    case 'failed':
      return tFromDb(db, 'round.failed');
  }
}

/**
 * The readable text of the definite signal that woke the round. Each signal
 * picks its own key: a claim round never borrows the human-message copy, and a
 * mention round never borrows the claim copy — that would state a fact that
 * did not happen.
 */
function mandatoryText(
  db: Database.Database,
  signal: NonNullable<RoundDiscipline['signal']>,
): string {
  switch (signal) {
    case 'mention':
      return tFromDb(db, 'round.mandatory.mention');
    case 'claim':
      return tFromDb(db, 'round.mandatory.claim');
    case 'human-message':
      return tFromDb(db, 'round.mandatory.humanMessage');
    case 'continue':
      return tFromDb(db, 'round.mandatory.continue');
  }
}

/**
 * The round finished reason (轮次结束原因) is a separate fact from the round
 * status. This ticket only produces normal completion and error; a merged row
 * has no round of its own, so its finished reason stays unknown (NULL).
 */
export type FinishedReason = 'completed' | 'error';

/** The readable finished-reason value stored in `round_outcome`. */
export function finishedReasonText(db: Database.Database, reason: FinishedReason): string {
  return reason === 'completed'
    ? tFromDb(db, 'round.finished.completed')
    : tFromDb(db, 'round.finished.error');
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
 * A DM narrows the member surface on an Agent-authored message: its two rows
 * are the owner and its Agent, and an Agent reply there wakes nobody (私信:
 * "owner 发言唤醒对方，agent 的回复不再唤醒任何人"), so a DM has no
 * agent-to-agent loop by construction. The mention surface is untouched — a
 * mentioned third Agent is still delivered once (穿透), membership unchanged.
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

  const mentions = listMentionedAgents(db, message.targetId, message.seq);
  const mentioned = new Set(mentions.map((member) => member.id));
  const wakes: Wake[] = [];
  const woken = new Set<string>();

  const isDm = readTargetKind(db, message.targetId) === 'dm';
  const wakesTargetMembers = !(message.kind === 'agent' && isDm);
  if (wakesTargetMembers) {
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
  }

  for (const member of mentions) {
    if (member.id === message.authorMemberId || woken.has(member.id)) {
      continue;
    }
    // A mention of a member is still the member surface, so a DM Agent reply
    // does not wake it either; only a non-member (穿透) is delivered.
    if (!wakesTargetMembers && isTargetMember(db, message.targetId, member.id)) {
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

/** Whether the member holds a target_member row on this target (any kind). */
function isTargetMember(db: Database.Database, targetId: string, memberId: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
    .get(targetId, memberId);
  return row !== undefined;
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
 *
 * An Agent-authored message is relayed under the response budget: it either
 * lands as one jump (at least one wake is delivered to another member) or the
 * epoch is exhausted and no wake is delivered at all. A wake that folds into a
 * running round on the same target is delivered to that round (the member gets
 * the message) and does not start a second round; only the case where every
 * wake folds — zero delivery — is not a jump.
 *
 * `messageKind` is the kind of the message the wakes belong to; `null` means the
 * wakes did not come from a message write (nothing to charge a jump to).
 */
export async function dispatchWakes(
  db: Database.Database,
  provider: RoundProvider,
  wakes: readonly Wake[],
  inFlight: InFlightRounds,
  messageKind: string | null = null,
  onError: (error: unknown, wake: Wake) => void = (error, wake) => {
    // Failure isolation: one member's round must not fail the message write or
    // another member's round. The message is already committed; an adapter
    // failure is folded into a `failed` outcome by runRound, so what reaches
    // here is a storage-level problem worth a log line and nothing more.
    console.error(`allibot: round for member ${wake.memberId} failed:`, error);
  },
): Promise<void> {
  if (wakes.length === 0) {
    return;
  }
  const delivering = wakes.filter((wake) => !foldsIntoInFlight(inFlight, wake));
  const relayed =
    messageKind === 'agent' && delivering.length > 0
      ? tryConsumeJump(db, wakes[0]!.targetId)
      : null;
  const delivered = relayed !== null && relayed.consumed;
  if (relayed !== null && !delivered) {
    await suppressWakes(db, wakes, relayed.budget);
    return;
  }
  const jump = delivered ? 1 : 0;
  for (const wake of wakes) {
    if (provider.deferred) {
      void runRound(db, provider, wake, inFlight, jump).catch((error: unknown) => onError(error, wake));
      continue;
    }
    try {
      await runRound(db, provider, wake, inFlight, jump);
    } catch (error) {
      onError(error, wake);
    }
  }
}

/**
 * A wake folds into a running round when the same member already runs one on
 * the same target: it is delivered to that round (as a `merged` row) and never
 * starts a second round. A wake for another target is deferred rather than
 * folded and does reach the member once the running round closes, so it still
 * counts as a delivery.
 */
function foldsIntoInFlight(inFlight: InFlightRounds, wake: Wake): boolean {
  const active = inFlight.get(wake.memberId);
  return active !== undefined && active.targetId === wake.targetId;
}

/**
 * Suppress every wake of an exhausted message: the message stays in the
 * target, no wake is delivered, and each member that would have been woken
 * gets one `budget-exhausted` round outcome. It is not an error (the status
 * point stays idle) and it is not a silent drop (the row is the evidence).
 */
async function suppressWakes(
  db: Database.Database,
  wakes: readonly Wake[],
  budget: BudgetRow,
): Promise<void> {
  const now = new Date().toISOString();
  const write = db.transaction((): void => {
    for (const wake of wakes) {
      insertOutcome(db, {
        wake,
        baseSeq: wake.fromSeq,
        status: 'budget-exhausted',
        reason: budgetExhaustedReason(db, budget),
        merged: 0,
        startedAt: now,
        finishedAt: now,
      });
    }
  });
  write();
}

/**
 * Run one member round and close it with at most one target message and
 * exactly one round outcome row. Returns the row this wake produced; a wake
 * folded into a running round returns null (its `merged` row is written when
 * that round closes).
 *
 * A penetrated member that replies joins the channel first (a system join
 * event, then the reply); one that does not reply never joins.
 *
 * A landed reply is itself an Agent message, so it relays to the other members
 * under the same response budget: this call delivers that message's wakes, and
 * the next members' rounds run inside it. The relay runs depth first (the
 * next round closes before this call returns) so the chain is observable in
 * seq order on the synchronous adapter, and the budget stops it at the epoch
 * ceiling.
 */
export async function runRound(
  db: Database.Database,
  provider: RoundProvider,
  wake: Wake,
  inFlight: InFlightRounds,
  budgetConsumed = 0,
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

  // The response discipline is computed once, from the data the wake points
  // at. A read failure leaves it undefined, which judges as non-definite: an
  // unreadable round has no definite signal to enforce.
  let input: RoundInput | undefined;
  let result: RoundResult;
  try {
    input = readRoundInput(db, wake);
    result = await provider.runRound(input);
  } catch (error) {
    // A wake that arrived after the adapter settled but before this round's
    // transaction commits still folds into this round; a crash here must not
    // leave the member marked in-flight forever (working is process state).
    result = { verdict: 'failed', replies: [], detail: errorMessage(error) };
  }

  let committed: CommittedRound;
  try {
    committed = commitRound(db, wake, turn, startedAt, result, input, budgetConsumed);
  } finally {
    inFlight.delete(wake.memberId);
  }
  // The subscription relays what the round committed, after its transaction
  // returned; a rolled-back round announces nothing.
  for (const message of committed.messages) {
    publishMessageCreated({ targetId: wake.targetId, id: message.id, seq: message.seq });
  }
  for (const outcome of committed.outcomes) {
    publishRoundOutcome(outcome);
  }
  // The other-target wakes wait here rather than running in parallel: one
  // member still has at most one round in flight. They were deferred into this
  // round's turn, not delivered to another member, so they carry no jump.
  for (const deferred of turn.deferred) {
    await runRound(db, provider, deferred, inFlight);
  }
  // The reply is itself an Agent message, so it relays to the other members
  // under the same response budget: its wakes are charged as one more jump, or
  // suppressed when the epoch is exhausted. Depth first, so the next members'
  // rounds close before this one returns and the chain is observable in seq
  // order on the synchronous adapter.
  if (committed.replySeq !== null) {
    const replyWakes = collectWakes(db, {
      targetId: wake.targetId,
      authorMemberId: wake.memberId,
      kind: 'agent',
      seq: committed.replySeq,
    });
    await dispatchWakes(db, provider, replyWakes, inFlight, 'agent');
  }
  return committed.outcome;
}

/**
 * The commit of one round. The reply seq travels back with the outcome so the
 * caller can relay that message under the response budget; `null` means the
 * round landed no message (ignored, failed, or a reply with no committable
 * body), so there is nothing to relay.
 */

export interface RoundOutcomeRow {
  id: string;
  member_id: string;
  target_id: string;
  base_seq: number;
  status: RoundOutcomeStatus;
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

  const targetKind = readTargetKindOf(db, wake.targetId);
  const triggeredByHuman = wokeByHuman(db, wake);
  const discipline = readDiscipline(db, wake, triggeredByHuman);
  // Recall happens before the round runs and only informs its understanding
  // (D5.2): it reads this round's input and never writes, wakes or spends
  // budget.
  const memories = recallForRound(db, member.id, wake.targetId, messages);
  return {
    member,
    targetId: wake.targetId,
    targetKind,
    baseSeq: wake.fromSeq,
    reason: wake.reason,
    discipline,
    messages,
    memories,
    systemPrompt: composeSystemPrompt(db, member, targetKind, triggeredByHuman, memories),
  };
}

/**
 * 回应判断 (Response Judgment) for one round. The signals are read from the
 * data the wake points at, never from the wake reason's text: a merged wake
 * keeps whichever reason arrived first, and the reason is diagnostics only.
 *
 * M1's four definite signals — a personal mention, a claim wake, a human
 * message that woke the round, and an auto-continue wake — must be answered.
 * `channel-message` is the ordinary wake and stays a self-judged round: a
 * conversation between others, without a mention, is legitimately ignored.
 * A mention overrides the human-message signal (both must answer; the mention
 * is the more specific copy). The team leader's task-change signal is T10 and
 * deliberately absent.
 */
function readDiscipline(
  db: Database.Database,
  wake: Wake,
  triggeredByHuman: boolean,
): RoundDiscipline {
  switch (wake.reason) {
    case 'claim':
      return { definite: true, signal: 'claim' };
    case 'continue':
      return { definite: true, signal: 'continue' };
    case 'mention':
      return { definite: true, signal: 'mention' };
    case 'channel-message':
      if (mentionsMember(db, wake)) {
        return { definite: true, signal: 'mention' };
      }
      return triggeredByHuman
        ? { definite: true, signal: 'human-message' }
        : { definite: false, signal: null };
  }
}

/** The write-time mention snapshot of the triggering message names this member. */
function mentionsMember(db: Database.Database, wake: Wake): boolean {
  const row = db
    .prepare(
      `SELECT 1 FROM message_mention mm
         JOIN message msg ON msg.id = mm.message_id
        WHERE msg.target_id = ? AND msg.seq = ? AND mm.member_id = ?`,
    )
    .get(wake.targetId, wake.fromSeq, wake.memberId);
  return row !== undefined;
}

/** The message the wake points at is a human message (message.kind == human). */
function wokeByHuman(db: Database.Database, wake: Wake): boolean {
  const row = db
    .prepare('SELECT kind FROM message WHERE target_id = ? AND seq = ?')
    .get(wake.targetId, wake.fromSeq) as { kind: string } | undefined;
  return row?.kind === 'human';
}

/**
 * The system prompt a round is handed: the stored Agent prompt, the target's
 * response discipline, the mandatory-answer sentence, and the memory section
 * when this round recalled cards.
 *
 * A DM is stated one-to-one with an explicit mandatory answer (the glossary's
 * "一对一口径 + 显式必答句") instead of the channel rubric: a DM never claims
 * to be a multi-member channel and has no "not mentioned therefore silent"
 * case. A channel keeps the silence rubric verbatim; a human-message round
 * appends the human-message mandatory sentence as its own paragraph, and no
 * other channel round gets that copy. The memory section is appended only — it
 * never replaces the stored prompt (D5.2).
 */
function composeSystemPrompt(
  db: Database.Database,
  member: RoundMember,
  targetKind: RoundTargetKind,
  triggeredByHuman: boolean,
  memories: readonly RoundMemory[],
): string {
  const sections = [member.system_prompt.trim()];
  if (targetKind === 'dm') {
    sections.push(tFromDb(db, 'prompt.dm.oneToOne'));
    sections.push(
      triggeredByHuman
        ? tFromDb(db, 'prompt.humanMessage.mandatory')
        : tFromDb(db, 'prompt.dm.mandatory'),
    );
  } else {
    sections.push(tFromDb(db, 'prompt.channel.rubric'));
    if (triggeredByHuman) {
      sections.push(tFromDb(db, 'prompt.humanMessage.mandatory'));
    }
  }
  const memorySection = memoryPromptSection(db, memories);
  if (memorySection !== null) {
    sections.push(memorySection);
  }
  return sections.filter((section) => section.length > 0).join('\n\n');
}

/**
 * Everything a round writes shares one transaction: the optional join, the
 * reply, the folded `merged` row, the round's own outcome and the one memory
 * card the round closes with.
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
  roundInput: RoundInput | undefined,
  budgetConsumed: number,
): CommittedRound {
  const signal = roundInput?.discipline ?? { definite: false, signal: null };
  const messages: WrittenMessage[] = [];
  const outcomes: RoundOutcomeRow[] = [];
  const write = db.transaction((): { outcome: RoundOutcomeRow; replySeq: number | null } => {
    const joinedSeq = commitJoin(db, wake, result, messages);
    const reply = commitReply(db, wake, result, messages);
    const finishedAt = new Date().toISOString();

    // Long-term memory is written back deterministically at round close
    // (D5.1): the trigger excerpt plus this member's reply excerpt, or the
    // "no reply" wording for an ignored / failed round. It never calls a model
    // and has no switch; a round whose input could not even be read writes no
    // card, because nothing was understood.
    if (roundInput !== undefined) {
      writeRoundMemoryCard(db, {
        memberId: wake.memberId,
        targetId: wake.targetId,
        triggerBody: triggerBody(roundInput),
        reply,
      });
    }

    if (turn.repeats.length > 0) {
      outcomes.push(
        insertOutcome(db, {
          wake,
          baseSeq: Math.max(...turn.repeats),
          status: 'merged',
          reason: tFromDb(db, 'round.merged', {
            count: turn.repeats.length,
            largest: Math.max(...turn.repeats),
          }),
          merged: 1,
          startedAt,
          finishedAt,
        }),
      );
    }

    const judged = judgeRound(signal, result, reply?.seq ?? null);
    const outcome = insertOutcome(db, {
      wake,
      baseSeq: wake.fromSeq,
      status: judged.status,
      reason: roundReason(db, wake, signal, result, judged, joinedSeq, reply?.seq ?? null),
      merged: 0,
      startedAt,
      finishedAt,
      finishedReason: judged.finishedReason,
      // The row-level marker of "this round was delivered by a counted jump".
      // A folded reply lands here too, so the row count never decides the hop
      // count (the ledger does); one jump marks every member it was delivered to.
      budgetConsumed,
    });
    outcomes.push(outcome);
    return { outcome, replySeq: reply?.seq ?? null };
  });
  const { outcome, replySeq } = write();
  return { outcome, replySeq, messages, outcomes };
}

/** One target message a round committed, as the subscription relays it. */
interface WrittenMessage {
  id: string;
  seq: number;
}

/**
 * The round's committed rows: its outcome, the seq of the reply it landed
 * (`null` when it landed no message), and everything the subscription relays.
 */
interface CommittedRound {
  outcome: RoundOutcomeRow;
  replySeq: number | null;
  messages: WrittenMessage[];
  /** Every outcome row written by this round, in write order. */
  outcomes: RoundOutcomeRow[];
}

/**
 * The stored round-outcome status vocabulary (轮次结果). This ticket produces
 * replied / ignored / failed / merged / silent; `budget-exhausted` arrives with
 * the budget ticket.
 */
export type RoundOutcomeStatus =
  | 'replied'
  | 'ignored'
  | 'failed'
  | 'merged'
  | 'budget-exhausted'
  | 'silent';

/**
 * 回应判断 (Response Judgment) applied to one round's adapter verdict.
 *
 * Under a definite signal — a personal mention, a claim wake, a human message,
 * an auto-continue wake — a round that stays silent (`ignored` or the
 * structured `silent`) or that answers without a committable body closes as
 * `failed`. That is the response discipline's rule; the adapter's own verdict
 * is still stated in the readable reason, so the row shows both facts. Under
 * no definite signal, `ignored` and `silent` stay what they are: normal
 * protocol results, not failures — a body-less reply keeps the adapter's own
 * `replied` verdict and only the reason says it landed nothing.
 *
 * The stored status is computed from the structured verdict, never from the
 * reason text, so the text can gain clauses without changing what is recorded.
 */
function judgeRound(
  discipline: RoundDiscipline,
  result: RoundResult,
  replySeq: number | null,
): { status: RoundOutcomeStatus; finishedReason: FinishedReason } {
  if (result.verdict === 'failed') {
    return { status: 'failed', finishedReason: 'error' };
  }
  if (result.verdict === 'replied') {
    return replySeq === null && discipline.definite
      ? { status: 'failed', finishedReason: 'completed' }
      : { status: 'replied', finishedReason: 'completed' };
  }
  if (discipline.definite) {
    return { status: 'failed', finishedReason: 'completed' };
  }
  return { status: result.verdict, finishedReason: 'completed' };
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
function commitJoin(
  db: Database.Database,
  wake: Wake,
  result: RoundResult,
  written: WrittenMessage[],
): number | null {
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
  const join = insertMessage(
    db,
    wake.targetId,
    'system',
    ownerId(db),
    tFromDb(db, 'system.member.piercedJoin', { name: member.display_name }),
  );
  written.push(join);
  return join.seq;
}

function readTargetKind(db: Database.Database, targetId: string): string {
  const row = db.prepare('SELECT kind FROM target WHERE id = ?').get(targetId) as
    | { kind: string }
    | undefined;
  return row?.kind ?? '';
}

/** The same row, narrowed for the round input; a target row always exists here. */
function readTargetKindOf(db: Database.Database, targetId: string): RoundTargetKind {
  const kind = readTargetKind(db, targetId);
  return kind === 'dm' || kind === 'task' ? kind : 'channel';
}

function commitReply(
  db: Database.Database,
  wake: Wake,
  result: RoundResult,
  written: WrittenMessage[],
): { id: string; seq: number; body: string } | null {
  if (result.verdict !== 'replied' || !hasBody(result)) {
    return null;
  }
  // 一轮 ↔ 至多一条 target 消息: the seam may hand over several pending
  // replies, and this write path lands the first one. Streaming the rest is
  // the AG-UI ticket's shape, not a second message per round here.
  const body = result.replies[0]!.trim();
  const reply = { ...insertMessage(db, wake.targetId, 'agent', wake.memberId, body), body };
  written.push(reply);
  return reply;
}

function hasBody(result: RoundResult): boolean {
  const body = result.replies[0];
  return result.verdict === 'replied' && body !== undefined && body.trim().length > 0;
}

/**
 * The body the round was woken by: the message at the wake's `baseSeq`. A round
 * whose first read message already moved past it (a pierced wake is the only
 * shape today) falls back to the oldest message it did read, so the card always
 * carries a trigger excerpt.
 */
function triggerBody(input: RoundInput): string {
  const exact = input.messages.find((message) => message.seq === input.baseSeq);
  return exact?.body ?? input.messages[0]?.body ?? '';
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
): { id: string; seq: number } {
  return insertMessageRow(db, { targetId, kind, authorMemberId, body });
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

/**
 * The readable round reason. The verdict clause states what the adapter
 * concluded; the response-judgement clause states what the discipline made of
 * it — each definite signal with its own key, and the "normal protocol
 * result" wording only where nothing forced an answer. The text never decides
 * the stored status (judgeRound does, from the structured verdict).
 */
function roundReason(
  db: Database.Database,
  wake: Wake,
  discipline: RoundDiscipline,
  result: RoundResult,
  judged: { status: RoundOutcomeStatus; finishedReason: FinishedReason },
  joinedSeq: number | null,
  replySeq: number | null,
): string {
  const parts: string[] = [wakeText(db, wake.reason)];
  if (result.verdict === 'replied' && replySeq === null) {
    parts.push(tFromDb(db, 'round.noBody'));
  } else {
    parts.push(verdictText(db, result.verdict));
  }
  if (discipline.definite && discipline.signal !== null) {
    parts.push(mandatoryText(db, discipline.signal));
  }
  if (judged.status === 'failed' && result.verdict !== 'failed') {
    // Only a definite signal is what turned this round into a failure; a
    // body-less reply is failed on its own and must not claim otherwise.
    if (discipline.definite) {
      parts.push(tFromDb(db, 'round.mandatory.closed'));
    }
  } else if (judged.status === 'silent') {
    parts.push(tFromDb(db, 'round.silent.allowed'));
  } else if (judged.status === 'ignored' && result.verdict === 'ignored') {
    parts.push(tFromDb(db, 'round.ignored.allowed'));
  }
  if (result.detail !== undefined && result.detail.length > 0) {
    parts.push(result.detail);
  }
  if (joinedSeq !== null) {
    parts.push(tFromDb(db, 'round.penetrationSuffix', { seq: joinedSeq }));
  }
  return parts.join('；');
}

interface InsertOutcomeInput {
  wake: Wake;
  baseSeq: number;
  status: RoundOutcomeStatus;
  reason: string;
  merged: number;
  startedAt: string;
  finishedAt: string;
  finishedReason?: FinishedReason;
  /**
   * 1 when the row was delivered by a counted agent-to-agent jump, 0 otherwise.
   * It is a row-level marker, not a hop counter: a suppressed wake is always 0
   * (nothing was delivered) and a folded reply keeps the marker of the delivery
   * it belonged to, so summing rows would over-count a fan-out jump.
   */
  budgetConsumed?: number;
}

function insertOutcome(db: Database.Database, input: InsertOutcomeInput): RoundOutcomeRow {
  const id = randomUUID();
  const budgetConsumed = input.budgetConsumed ?? 0;
  const finishedReason =
    input.finishedReason === undefined ? null : finishedReasonText(db, input.finishedReason);
  db.prepare(
    `INSERT INTO round_outcome
       (id, member_id, target_id, base_seq, status, reason, finished_reason,
        started_at, finished_at, budget_consumed, merged)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    budgetConsumed,
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
    budget_consumed: budgetConsumed,
    merged: input.merged,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
