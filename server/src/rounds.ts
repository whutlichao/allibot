import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type Database from 'better-sqlite3';
import type {
  RoundDiscipline,
  RoundInput,
  RoundMember,
  RoundMemory,
  RoundMessage,
  RoundPromptSections,
  RoundProvider,
  RoundResult,
  RoundTargetKind,
  RoundTeamContext,
  RoundWorkspaceContext,
  TeamAssignRequest,
  TeamAssignToolResult,
  WakeReason,
} from './agent-seam.js';
import { budgetExhaustedReason, tryConsumeJump, type BudgetRow } from './budget.js';
import {
  advanceConsumedSeq,
  readConsumedSeq,
  readContextWindow,
  type ContextScope,
} from './context-window.js';
import { tFromDb } from './copy.js';
import {
  publishMemberStatus,
  publishMessageCreated,
  publishRoundOutcome,
  publishTeamAssignment,
  publishUnreadChanged,
} from './events.js';
import { readRoundRuleSections } from './agent-home.js';
import { skillPromptSection } from './skills.js';
import { memoryPromptSection, recallForRound, writeRoundMemoryCard } from './memory.js';
import { buildRoundMcp, closeRoundMcp } from './mcp-runtime.js';
import { createPlanFace } from './plans.js';
import { insertMessageRow } from './message-store.js';
import { liveMemberClause, readOwnerId } from './members.js';
import { readTargetKind } from './sql.js';
import { createLocalShell, getShellEnvNames } from './local-shell.js';
import { createToolGate } from './tool-gate.js';
import { readTargetPermissionContext } from './permissions.js';
import { createRoundFileTools } from './workspace-files.js';
import {
  readRoundWorkspaceBinding,
  readRoundWorkspaceFailure,
  readTargetWorkspaceBinding,
} from './workspace-root.js';
import {
  readTeamMemberAvailability,
  readTeamTargetState,
  readTeamWakeState,
  type TeamTargetState,
} from './team.js';
import {
  closeTeamAssignment,
  closeTeamRun,
  insertFinalTeamAssignment,
  recordInvalidLeaderRun,
  startTeamAssignment,
  startTeamRun,
  type StartedTeamRun,
} from './team-runs.js';
import { truncateTeamAssignmentExcerpt } from './team-assignments.js';
import { countUnread } from './unread.js';
import { transferTaskAsMember } from './tasks.js';

/**
 * 自动续跑 (Auto-continue) is bounded independently of the response budget:
 * one human epoch allows the assignee four work rounds on a task — the first
 * round plus three auto-continues. The count resets when the next human epoch
 * opens, not when a jump is delivered.
 */
export const TASK_WORK_ROUNDS_PER_EPOCH = 4;

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
    case 'team-change':
      return tFromDb(db, 'wake.teamChange');
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
    case 'team-change':
      return tFromDb(db, 'round.mandatory.teamChange');
  }
}

/**
 * The round finished reason (轮次结束原因) is a separate fact from the round
 * status: a normal completion, a human interrupt, an iteration limit and an
 * error are four different ways for a round to end. Only some rounds have a
 * round of their own to finish: a merged row folds into another round and a
 * suppressed wake runs no round at all, so both keep `NULL` — the unknown
 * reading the spec asks old rows to keep.
 */
export type FinishedReason = 'completed' | 'human-interrupt' | 'iteration-limit' | 'error';

/** The readable finished-reason value stored in `round_outcome`. */
export function finishedReasonText(db: Database.Database, reason: FinishedReason): string {
  switch (reason) {
    case 'completed':
      return tFromDb(db, 'round.finished.completed');
    case 'human-interrupt':
      return tFromDb(db, 'round.finished.humanInterrupt');
    case 'iteration-limit':
      return tFromDb(db, 'round.finished.iterationLimit');
    case 'error':
      return tFromDb(db, 'round.finished.error');
  }
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
  avatar_slot: number;
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
  env: NodeJS.ProcessEnv = process.env,
): Wake[] {
  if (message.kind !== 'human' && message.kind !== 'agent') {
    return [];
  }

  const mentions = listMentionedAgents(db, message.targetId, message.seq);
  const mentioned = new Set(mentions.map((member) => member.id));
  const targetKind = readTargetKind(db, message.targetId);

  // team 模式收窄（D3.2 / D3.8）：the channel-type target's ordinary wake
  // surface is only the leader. A team channel with an unusable leader delivers
  // zero leader wakes and never falls back to the M1 member surface; the
  // channel @mention penetration stays outside the team pipeline (D3.6).
  if (targetKind === 'channel') {
    const team = readTeamWakeState(db, message.targetId, env);
    if (team !== null) {
      return collectTeamChannelWakes(message, mentions, mentioned, team);
    }
  }

  // team 任务线程收窄（D3.2 / D3.5）: a task target of a team channel wakes only
  // the leader, and a task target has no penetration exception at all. The
  // invalid-leader trigger is recorded by the message write path, not here: the
  // wake surface stays a pure reading.
  if (targetKind === 'task') {
    const team = readTeamTargetState(db, message.targetId, env);
    if (team !== null) {
      return collectTeamTaskWakes(message, mentioned, team);
    }
  }

  const wakes: Wake[] = [];
  const woken = new Set<string>();

  const wakesTargetMembers = !(message.kind === 'agent' && targetKind === 'dm');
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

/**
 * The team channel's wake set (D3.2 / D3.6 / D3.8):
 * - the leader is the whole ordinary surface, and only while it is usable;
 * - a leader-authored message wakes nobody at all — not the ordinary surface
 *   and not the mention penetration (the leader's final reply must not loop);
 * - an @mention of a non-leader is still the M1 penetration path: it is
 *   delivered once, member or not, and never changes the leader identity.
 */
function collectTeamChannelWakes(
  message: { targetId: string; authorMemberId: string; kind: string; seq: number },
  mentions: readonly { id: string }[],
  mentioned: ReadonlySet<string>,
  team: { leaderMemberId: string; available: boolean },
): Wake[] {
  if (team.leaderMemberId === message.authorMemberId) {
    return [];
  }
  const wakes: Wake[] = [];
  const delivered = new Set<string>();
  if (team.leaderMemberId.length > 0) {
    delivered.add(team.leaderMemberId);
    if (team.available) {
      wakes.push({
        memberId: team.leaderMemberId,
        targetId: message.targetId,
        fromSeq: message.seq,
        // A mention of the leader is the more specific readable reason.
        reason: mentioned.has(team.leaderMemberId) ? 'mention' : 'channel-message',
      });
    }
  }
  for (const member of mentions) {
    if (member.id === message.authorMemberId || delivered.has(member.id)) {
      continue;
    }
    wakes.push({
      memberId: member.id,
      targetId: message.targetId,
      fromSeq: message.seq,
      reason: 'mention',
    });
    delivered.add(member.id);
  }
  return wakes;
}

/**
 * The team task target's wake set: the leader is the whole surface, a
 * leader-authored message wakes nobody, and a mention of anyone else never
 * penetrates (task targets have no penetration exception, D3.6).
 */
function collectTeamTaskWakes(
  message: { targetId: string; authorMemberId: string; kind: string; seq: number },
  mentioned: ReadonlySet<string>,
  team: { leaderMemberId: string; available: boolean },
): Wake[] {
  if (team.leaderMemberId.length === 0 || team.leaderMemberId === message.authorMemberId) {
    return [];
  }
  if (!team.available) {
    return [];
  }
  return [
    {
      memberId: team.leaderMemberId,
      targetId: message.targetId,
      fromSeq: message.seq,
      reason: mentioned.has(team.leaderMemberId) ? 'mention' : 'channel-message',
    },
  ];
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
      `SELECT m.id, m.display_name, m.avatar_slot, c.role, c.model, c.system_prompt
         FROM target_member tm
         JOIN member m ON m.id = tm.member_id
         JOIN agent_config c ON c.member_id = m.id
        WHERE tm.target_id = ? AND m.kind = 'agent' AND c.enabled = 1
          AND ${liveMemberClause('m')}
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
         JOIN agent_config c ON c.member_id = m.id
        WHERE msg.target_id = ? AND msg.seq = ? AND m.kind = 'agent' AND c.enabled = 1
          AND ${liveMemberClause('m')}
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
 * The orchestration runtime the write paths drive: the member-face adapter and
 * the process-local in-flight registry. The human-face message write, the claim
 * and the live AG-UI run all hand this same value to the orchestration, so a
 * reply or a claim round is executed by one module with one registry.
 */
export interface OrchestrationRuntime {
  provider: RoundProvider;
  inFlight: InFlightRounds;
}

/** One reply a round committed, as the live run observes it. */
export interface CommittedReply {
  /** The SQLite `message.id` — the AG-UI `messageId` is this value. */
  id: string;
  seq: number;
  memberId: string;
  /** The author snapshot the row recorded, for the live renderer. */
  authorDisplayName: string;
  authorAvatarSlot: number;
  body: string;
}

/**
 * The observation face of one dispatch call (the live AG-UI run):
 * - `onReply` sees the replies this call's own wakes produced, in commit order.
 *   The agent-to-agent relay rounds stay backend-driven facts published on the
 *   global SSE; the run does not stream them a second time.
 * - `signal` is the run's cancellation: an in-flight round closes as a human
 *   interrupt (no reply message), and no further round of this dispatch starts.
 * - `awaitDeferred` makes a deferred adapter settle inside the call instead of
 *   after it; the live run waits so it can stream and be cancelled. The plain
 *   message write keeps the adapter's deferred behaviour.
 *
 * None of these starts a round: the rounds are still exactly those
 * `dispatchWakes` delivers, so a round never executes twice.
 */
export interface DispatchOptions {
  /** The kind of message the wakes belong to; `null` when no message is charged. */
  messageKind?: string | null;
  onError?: (error: unknown, wake: Wake) => void;
  /** The live run's cancellation; an aborted round closes as a human interrupt. */
  signal?: AbortSignal;
  /** The live run's observation of the replies this dispatch produced. */
  onReply?(reply: CommittedReply): void;
  /** Await rounds a deferred adapter would otherwise leave to settle later. */
  awaitDeferred?: boolean;
}

export interface RoundRunOptions {
  /** The counted jump this delivery was charged; 0 when no jump applies. */
  jump?: number;
  /** The run's cancellation; an aborted round closes as a human interrupt. */
  signal?: AbortSignal;
  /** The live run's observation of the reply this round commits. */
  onReply?(reply: CommittedReply): void;
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
  options: DispatchOptions = {},
): Promise<void> {
  const { messageKind = null, signal, onReply, awaitDeferred = false } = options;
  const onError: (error: unknown, wake: Wake) => void =
    options.onError ??
    ((error, wake) => {
      // Failure isolation: one member's round must not fail the message write or
      // another member's round. The message is already committed; an adapter
      // failure is folded into a `failed` outcome by runRound, so what reaches
      // here is a storage-level problem worth a log line and nothing more.
      console.error(`allibot: round for member ${wake.memberId} failed:`, error);
    });
  if (wakes.length === 0 || signal?.aborted) {
    return;
  }
  const delivering = wakes.filter((wake) => !foldsIntoInFlight(inFlight, wake));
  const firstDelivering = delivering[0];
  const relayed =
    messageKind === 'agent' && firstDelivering !== undefined
      ? tryConsumeJump(db, firstDelivering.targetId)
      : null;
  const delivered = relayed !== null && relayed.consumed;
  if (relayed !== null && !delivered) {
    // Only the wakes that would actually have started a round are suppressed.
    // A wake folded into a running round is delivered to that round and leaves
    // its one `merged` row when the round closes; it is not a suppressed
    // member and must not also get a `budget-exhausted` row.
    await suppressWakes(db, delivering, relayed.budget);
    return;
  }
  const jump = delivered ? 1 : 0;
  for (const wake of wakes) {
    // A cancelled run starts no further round. The wakes it never started are
    // not rounds and leave no outcome row: the member's consumption cursor did
    // not move, so a later wake reads the message again.
    if (signal?.aborted) {
      return;
    }
    if (provider.deferred && !awaitDeferred) {
      void runRound(db, provider, wake, inFlight, { jump, signal, onReply }).catch(
        (error: unknown) => onError(error, wake),
      );
      continue;
    }
    try {
      await runRound(db, provider, wake, inFlight, { jump, signal, onReply });
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
  options: RoundRunOptions = {},
): Promise<RoundOutcomeRow | null> {
  const { jump = 0, signal, onReply } = options;
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
  // 审批 identity (D5.6): the reply id is allocated before the adapter runs. If
  // this round later lands a message, this id is the message id; every approval
  // batch of this reply uses the same stable identity.
  const replyId = randomUUID();
  // 运行记录 (D3.3): a real leader round on a team target opens one run. The
  // target state is the same reading the wake surface used, so the run names
  // the same leader, channel and task the delivery did.
  const teamRun = openTeamRunForWake(db, wake, startedAt);
  // The TeamAssign tool face (#39 / D3.4): only a leader round opens it, and it
  // is bound to this run so the assignment rows and the sub-round belong to the
  // same leader round.
  const assign: TeamAssignExecutor | null =
    teamRun === null
      ? null
      : (request) =>
          executeTeamAssignment(db, provider, inFlight, {
            run: teamRun,
            targetId: wake.targetId,
            leaderMemberId: wake.memberId,
            baseSeq: wake.fromSeq,
            wakeReason: wake.reason,
            request,
            signal,
          });
  // The status point's `working` state is process state; the frame announces
  // the transition now, and the reading that carries reasons stays the
  // workspace snapshot.
  publishMemberStatus({ memberId: wake.memberId, status: 'working' });

  // The response discipline is computed once, from the data the wake points
  // at. A read failure leaves it undefined, which judges as non-definite: an
  // unreadable round has no definite signal to enforce.
  let input: RoundInput | undefined;
  let result: RoundResult;
  let interrupted = false;
  try {
    input = await readRoundInput(db, wake, { teamRun, assign, replyId });
    const settled = await runProviderRound(provider, input, signal);
    interrupted = settled.interrupted;
    result = settled.result;
  } catch (error) {
    // A wake that arrived after the adapter settled but before this round's
    // transaction commits still folds into this round; a crash here must not
    // leave the member marked in-flight forever (working is process state).
    result = { verdict: 'failed', replies: [], detail: errorMessage(error) };
  }

  let committed: CommittedRound;
  try {
    committed = commitRound(db, wake, turn, startedAt, result, input, {
      jump,
      interrupted,
      replyId,
    });
    if (teamRun !== null) {
      closeRoundTeamRun(db, teamRun, committed);
    }
  } finally {
    await closeRoundMcp(input?.mcp);
    inFlight.delete(wake.memberId);
  }
  // The subscription relays what the round committed, after its transaction
  // returned; a rolled-back round announces nothing.
  for (const message of committed.messages) {
    publishMessageCreated({ targetId: wake.targetId, id: message.id, seq: message.seq });
  }
  if (committed.reply !== null) {
    const author = input?.member;
    onReply?.({
      ...committed.reply,
      memberId: wake.memberId,
      authorDisplayName: author?.display_name ?? '',
      authorAvatarSlot: author?.avatar_slot ?? 0,
    });
  }
  for (const outcome of committed.outcomes) {
    publishRoundOutcome(outcome);
  }
  // The round's own conclusion decides the stored `error` / `online` point; a
  // member whose availability keeps it offline never reaches a round.
  publishMemberStatus({
    memberId: wake.memberId,
    status: committed.outcome.status === 'failed' ? 'error' : 'online',
  });
  // A landed reply is an Agent conversation message, so the owner's unread
  // reading for this target moved; a round that landed nothing (ignored,
  // failed, merged) leaves it untouched. A merged join system message never
  // counts, so `replySeq` is the whole condition.
  if (committed.replySeq !== null) {
    publishUnreadChanged({
      targetId: wake.targetId,
      unreadCount: countUnread(db, readOwnerId(db), wake.targetId),
    });
  }
  // The other-target wakes wait here rather than running in parallel: one
  // member still has at most one round in flight. They were deferred into this
  // round's turn, not delivered to another member, so they carry no jump. A
  // cancelled run starts none of them: they were never rounds.
  for (const deferred of turn.deferred) {
    if (signal?.aborted) {
      break;
    }
    await runRound(db, provider, deferred, inFlight, { signal });
  }
  // The reply is itself an Agent message, so it relays to the other members
  // under the same response budget: its wakes are charged as one more jump, or
  // suppressed when the epoch is exhausted. Depth first, so the next members'
  // rounds close before this one returns and the chain is observable in seq
  // order on the synchronous adapter. The relay stays backend-driven: it is
  // not handed to the live run's observer, which only streams the replies the
  // run's own message woke.
  if (committed.replySeq !== null) {
    const replyWakes = collectWakes(db, {
      targetId: wake.targetId,
      authorMemberId: wake.memberId,
      kind: 'agent',
      seq: committed.replySeq,
    });
    await dispatchWakes(db, provider, replyWakes, inFlight, { messageKind: 'agent', signal });
  }
  // 自动续跑 carries no jump: the caller passes no message kind, so the wake
  // is delivered even in an exhausted epoch and never advances target_budget.
  if (committed.pendingWakes.length > 0) {
    await dispatchWakes(db, provider, committed.pendingWakes, inFlight, { signal });
  }
  return committed.outcome;
}

/**
 * Whether this wake is the leader's own team round. The leader is the only
 * ordinary wake target of a team channel / task target (D3.2), so a delivered
 * wake from one of those surfaces is exactly the round the run records. A
 * claim / continue wake never exists in a team target; guarding on the reason
 * keeps a hypothetical one from opening a record.
 */
function openTeamRunForWake(
  db: Database.Database,
  wake: Wake,
  startedAt: string,
): StartedTeamRun | null {
  if (
    wake.reason !== 'channel-message' &&
    wake.reason !== 'mention' &&
    wake.reason !== 'team-change'
  ) {
    return null;
  }
  const state = readTeamTargetState(db, wake.targetId, process.env);
  if (state === null || !state.available || state.leaderMemberId !== wake.memberId) {
    return null;
  }
  return startTeamRun(db, state, startedAt);
}

/** Close the leader round's run with the round conclusion (D3.3). */
function closeRoundTeamRun(
  db: Database.Database,
  run: StartedTeamRun,
  committed: CommittedRound,
): void {
  const failed = committed.outcome.status === 'failed';
  closeTeamRun(
    db,
    run.id,
    failed ? 'failed' : 'completed',
    failed ? committed.outcome.reason : null,
    committed.outcome.finished_at,
  );
}

/** The TeamAssign tool face a leader round hands to the adapter. */
type TeamAssignExecutor = (request: TeamAssignRequest) => Promise<TeamAssignToolResult>;

interface TeamAssignExecution {
  run: StartedTeamRun;
  targetId: string;
  leaderMemberId: string;
  /** The leader round's trigger, used by the sub-round's prompt context. */
  baseSeq: number;
  wakeReason: WakeReason;
  request: TeamAssignRequest;
  signal?: AbortSignal;
}

/**
 * One TeamAssign call (D3.4). The fixed decision order is:
 *
 * 1. the caller is this target's leader; the target is another live Agent
 *    member of the channel (or the task's channel), with a ready model provider.
 *    A target that fails this is a `failed` assignment with `jump_consumed=0`
 *    and an error tool result — no jump was spent and no member ran;
 * 2. the budget target is the target itself: the channel's own `target_budget`
 *    for a channel target, the task's own `target_budget` for a task target.
 *    There is no borrowing across targets and no second jump ledger;
 * 3. `tryConsumeJump` checks and decrements atomically. Exhausted means
 *    `budget-exhausted`, `jump_consumed=0`, no member run, error tool result;
 * 4. otherwise one `running` assignment with `jump_consumed=1` is inserted, the
 *    member sub-round runs inside this leader round, and the full output is the
 *    tool result. A member failure closes the assignment `failed` and never
 *    refunds the jump.
 *
 * The member sub-round writes no target message, no `round_outcome`, no unread,
 * no search hit and no second budget fact; only the truncated excerpt is stored
 * on the assignment (D3.4 step 6).
 */
async function executeTeamAssignment(
  db: Database.Database,
  provider: RoundProvider,
  inFlight: InFlightRounds,
  context: TeamAssignExecution,
): Promise<TeamAssignToolResult> {
  const { run, targetId, leaderMemberId, request } = context;
  const team = readTeamTargetState(db, targetId, process.env);
  if (team === null || team.leaderMemberId !== leaderMemberId) {
    return {
      ok: false,
      assignment_id: null,
      member_id: request.member_id,
      state: null,
      jump_consumed: 0,
      reply_excerpt: null,
      reason: tFromDb(db, 'team.assignment.reason.notLeader'),
      code: 'not_leader',
      output: null,
    };
  }

  if (request.member_id === leaderMemberId) {
    const reason = tFromDb(db, 'team.assignment.reason.self');
    const assignment = insertFinalTeamAssignment(db, {
      teamRunId: run.id,
      targetId: team.targetId,
      taskId: team.taskId,
      memberId: request.member_id,
      jumpConsumed: 0,
      state: 'failed',
      reason,
    });
    publishTeamAssignment(assignment);
    return {
      ok: false,
      assignment_id: assignment.id,
      member_id: request.member_id,
      state: 'failed',
      jump_consumed: 0,
      reply_excerpt: null,
      reason,
      code: 'target_self',
      output: null,
    };
  }

  const workspaceFailure = readRoundWorkspaceFailure(db, request.member_id, team.targetId);
  if (workspaceFailure !== null) {
    const reason = workspaceFailureReason(db, workspaceFailure.backend);
    const assignment = insertFinalTeamAssignment(db, {
      teamRunId: run.id,
      targetId: team.targetId,
      taskId: team.taskId,
      memberId: request.member_id,
      jumpConsumed: 0,
      state: 'failed',
      reason,
    });
    publishTeamAssignment(assignment);
    return {
      ok: false,
      assignment_id: assignment.id,
      member_id: request.member_id,
      state: 'failed',
      jump_consumed: 0,
      reply_excerpt: null,
      reason,
      code: 'target_unavailable',
      output: null,
    };
  }

  const availability = readTeamMemberAvailability(
    db,
    team.channelId,
    request.member_id,
    process.env,
  );
  if (!availability.ok) {
    const assignment = insertFinalTeamAssignment(db, {
      teamRunId: run.id,
      targetId: team.targetId,
      taskId: team.taskId,
      memberId: request.member_id,
      jumpConsumed: 0,
      state: 'failed',
      reason: availability.reason,
    });
    publishTeamAssignment(assignment);
    return {
      ok: false,
      assignment_id: assignment.id,
      member_id: request.member_id,
      state: 'failed',
      jump_consumed: 0,
      reply_excerpt: null,
      reason: availability.reason,
      code: 'target_unavailable',
      output: null,
    };
  }

  // The budget target is the assignment's target: channel target uses the
  // channel budget, task target uses the task target's budget (D3.4 step 2).
  const attempt = tryConsumeJump(db, team.targetId);
  if (!attempt.consumed) {
    const reason = tFromDb(db, 'team.assignment.budgetExhausted', {
      used: attempt.budget.used,
      limit: attempt.budget.limit_value,
    });
    const assignment = insertFinalTeamAssignment(db, {
      teamRunId: run.id,
      targetId: team.targetId,
      taskId: team.taskId,
      memberId: request.member_id,
      jumpConsumed: 0,
      state: 'budget-exhausted',
      reason,
    });
    publishTeamAssignment(assignment);
    return {
      ok: false,
      assignment_id: assignment.id,
      member_id: request.member_id,
      state: 'budget-exhausted',
      jump_consumed: 0,
      reply_excerpt: null,
      reason,
      code: 'budget_exhausted',
      output: null,
    };
  }

  const assignment = startTeamAssignment(db, {
    teamRunId: run.id,
    targetId: team.targetId,
    taskId: team.taskId,
    memberId: request.member_id,
    jumpConsumed: 1,
  });

  // The sub-round gets its own stable reply identity; it never lands a message,
  // so this id only ever names its approval batches (D5.6).
  const subInput = await readAssignmentRoundInput(db, {
    team,
    run,
    memberId: request.member_id,
    assignmentId: assignment.id,
    instruction: request.instruction,
    baseSeq: context.baseSeq,
    reason: context.wakeReason,
    replyId: randomUUID(),
  });
  const turn: Turn = { targetId: team.targetId, repeats: [], deferred: [] };
  const ownsTurn = inFlight.get(request.member_id) === undefined;
  if (ownsTurn) {
    inFlight.set(request.member_id, turn);
  }
  let result: RoundResult;
  let interrupted = false;
  try {
    const settled = await runProviderRound(provider, subInput, context.signal);
    result = settled.result;
    interrupted = settled.interrupted;
  } catch (error) {
    result = { verdict: 'failed', replies: [], detail: errorMessage(error) };
  } finally {
    await closeRoundMcp(subInput.mcp);
    if (ownsTurn) {
      inFlight.delete(request.member_id);
    }
  }

  const output = result.replies.join('\n\n').trim();
  if (!interrupted && result.verdict === 'replied' && output.length > 0) {
    const excerpt = truncateTeamAssignmentExcerpt(db, output);
    const closed = closeTeamAssignment(db, assignment.id, 'completed', {
      replyExcerpt: excerpt,
      reason: null,
    });
    publishTeamAssignment(closed);
    return {
      ok: true,
      assignment_id: assignment.id,
      member_id: request.member_id,
      state: 'completed',
      jump_consumed: 1,
      reply_excerpt: excerpt,
      reason: null,
      code: null,
      output,
    };
  }

  const reason = tFromDb(db, 'team.assignment.memberFailed', {
    reason: assignmentFailureReason(db, result, interrupted),
  });
  const closed = closeTeamAssignment(db, assignment.id, 'failed', {
    replyExcerpt: null,
    reason,
  });
  publishTeamAssignment(closed);
  return {
    ok: false,
    assignment_id: assignment.id,
    member_id: request.member_id,
    state: 'failed',
    jump_consumed: 1,
    reply_excerpt: null,
    reason,
    code: 'member_failed',
    output: null,
  };
}

/**
 * The readable reason of a failed member sub-round: the adapter's own detail
 * when it gave one, the structured verdict copy otherwise. A replied round
 * without a committable body is its own failure, not a silent success.
 */
function assignmentFailureReason(
  db: Database.Database,
  result: RoundResult,
  interrupted: boolean,
): string {
  if (interrupted) {
    return tFromDb(db, 'round.interrupted');
  }
  if (result.detail !== undefined && result.detail.length > 0) {
    return result.detail;
  }
  if (result.verdict === 'replied') {
    return tFromDb(db, 'team.assignment.memberNoOutput');
  }
  return verdictText(db, result.verdict);
}

/**
 * The member sub-round's input: the same member-face seam as an ordinary
 * round, with the assignment context stated instead of a wake. It reads the
 * target window and recalls memory (understanding only), but it is not a
 * target round: the caller writes no message and no round outcome.
 */
async function readAssignmentRoundInput(
  db: Database.Database,
  params: {
    team: TeamTargetState;
    run: StartedTeamRun;
    memberId: string;
    assignmentId: string;
    instruction: string;
    baseSeq: number;
    reason: WakeReason;
    replyId: string;
  },
): Promise<RoundInput> {
  const member = db
    .prepare(
      `SELECT m.id, m.display_name, m.avatar_slot, c.role, c.model, c.system_prompt
         FROM member m JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}`,
    )
    .get(params.memberId) as RoundMember | undefined;
  if (member === undefined) {
    throw new Error(`assignment member not found: ${params.memberId}`);
  }
  const targetKind: RoundTargetKind = params.team.targetKind;
  const workspace = readRoundWorkspace(db, member.id, params.team.targetId, {
    replyId: params.replyId,
    contextKind: 'team-assignment',
    contextId: params.assignmentId,
  });
  const mcp = await buildRoundMcp({
    db,
    dataDir: readRoundDataDir(db),
    memberId: member.id,
    sessionId: params.replyId,
    targetId: params.team.targetId,
    contextKind: 'team-assignment',
    contextId: params.assignmentId,
    projectRoot: readTargetProjectRoot(db, params.team.targetId),
    env: process.env,
  });
  const messages = readContextWindow(db, params.team.targetId, 'window');
  const memories = recallForRound(db, member.id, params.team.targetId, messages);
  const prompt = composeSystemPrompt(db, member, targetKind, false, params.reason, memories, {
    isLeader: false,
    assignmentInstruction: params.instruction,
    projectRoot: readTargetProjectRoot(db, params.team.targetId),
  });
  return {
    member,
    targetId: params.team.targetId,
    targetKind,
    channelMode: 'team',
    // A TeamAssign sub-round is a team-target member round, so the four Plan
    // tools are part of its tool set too (D4.1). MCP tools are appended after
    // the built-ins, as `mcp:<server>/<tool>`.
    tools: [
      ...readRoundTools(
        db,
        member.id,
        params.team.targetId,
        targetKind,
        false,
        true,
        workspace !== null,
        workspace?.allow_local_shell === 1,
      ),
      ...mcpToolNames(mcp),
    ],
    plan: createPlanFace(db, params.team.targetId, member.id),
    workspace,
    mcp,
    team: {
      leader_member_id:
        params.team.leaderMemberId.length === 0 ? null : params.team.leaderMemberId,
      is_leader: false,
      task_id: params.team.taskId,
      team_run_id: params.run.id,
      assignment: { assignment_id: params.assignmentId, instruction: params.instruction },
      assign: null,
    },
    replyId: params.replyId,
    sop: null,
    baseSeq: params.baseSeq,
    reason: params.reason,
    discipline: { definite: true, signal: null },
    contextScope: 'window',
    messages,
    consumedSeq: readConsumedSeq(db, member.id, params.team.targetId),
    memories,
    systemPrompt: prompt.systemPrompt,
    promptSections: prompt.sections,
  };
}

/** The data directory of the one SQLite file (mcp-hosts lives beside it). */
function readRoundDataDir(db: Database.Database): string {
  return path.dirname(db.name);
}

/** MCP tools the adapter may call, in the stable built-in-then-MCP order. */
function mcpToolNames(mcp: RoundInput['mcp']): string[] {
  if (mcp === null) {
    return [];
  }
  return mcp.servers.flatMap((server) =>
    server.tools.map((tool) => `mcp:${server.name}/${tool.name}`),
  );
}

/** One SOP step as the executor reads it (the stored definition step). */
export interface SopRoundStep {
  title: string;
  description: string;
  executor_member_id: string;
  verifier_member_id: string;
  max_attempts: number;
}

export interface SopRoundInputParams {
  memberId: string;
  runId: string;
  definitionId: string;
  channelId: string;
  /** The stable identity of this internal round; it only ever names approvals. */
  replyId: string;
  step: SopRoundStep;
  stepIndex: number;
  attempt: number;
  role: 'executor' | 'verifier';
  /** The executor's text; `null` in an executor round. */
  executorText: string | null;
  /** The run's phase hook while an approval batch waits. */
  onApprovalWait?: () => void;
  /** The run's phase hook when the approval wait settles. */
  onApprovalSettled?: () => void;
}

/**
 * The input of one SOP executor / verifier round (D4.3). It is the same member
 * face as an ordinary round, with the step / role stated instead of a wake. It
 * reads the channel window and the member's available tool set, but it is not a
 * target round: the caller writes no message and no round outcome.
 *
 * The approval identity is this round's stable `replyId`; a tool ask during the
 * round registers `context_kind='sop'` with the run id, so the human approval
 * face can mark the run `awaiting` while it waits.
 */
export async function readSopRoundInput(
  db: Database.Database,
  params: SopRoundInputParams,
): Promise<RoundInput> {
  const member = db
    .prepare(
      `SELECT m.id, m.display_name, m.avatar_slot, c.role, c.model, c.system_prompt
         FROM member m JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}`,
    )
    .get(params.memberId) as RoundMember | undefined;
  if (member === undefined) {
    throw new Error(`SOP round member not found: ${params.memberId}`);
  }
  const channel = db
    .prepare('SELECT mode FROM channel WHERE id = ?')
    .get(params.channelId) as { mode: string } | undefined;
  const channelMode: 'autonomous' | 'team' = channel?.mode === 'team' ? 'team' : 'autonomous';
  const workspace = readRoundWorkspace(db, member.id, params.channelId, {
    replyId: params.replyId,
    contextKind: 'sop',
    contextId: params.runId,
    // A SOP approval has no target (D5.6), but the permission context still
    // resolves from the channel the definition belongs to.
    approvalTargetId: null,
    onApprovalWait: params.onApprovalWait,
    onApprovalSettled: params.onApprovalSettled,
  });
  const mcp = await buildRoundMcp({
    db,
    dataDir: readRoundDataDir(db),
    memberId: member.id,
    sessionId: params.replyId,
    targetId: params.channelId,
    contextKind: 'sop',
    contextId: params.runId,
    projectRoot: readTargetProjectRoot(db, params.channelId),
    env: process.env,
    approvalTargetId: null,
    onApprovalWait: params.onApprovalWait,
    onApprovalSettled: params.onApprovalSettled,
  });
  const messages = readContextWindow(db, params.channelId, 'window');
  const prompt = composeSystemPrompt(db, member, 'channel', false, 'channel-message', [], {
    isLeader: false,
    assignmentInstruction: null,
    projectRoot: readTargetProjectRoot(db, params.channelId),
    sop: {
      role: params.role,
      stepTitle: params.step.title,
      description: params.step.description,
      stepIndex: params.stepIndex,
      attempt: params.attempt,
      maxAttempts: params.step.max_attempts,
      executorText: params.executorText,
    },
  });
  return {
    member,
    targetId: params.channelId,
    targetKind: 'channel',
    channelMode,
    tools: [
      ...readRoundTools(
        db,
        member.id,
        params.channelId,
        'channel',
        false,
        false,
        workspace !== null,
        // A SOP round is an internal member round with the same workspace face:
        // the explicit shell switch adds Bash, still behind the per-call gate.
        workspace?.allow_local_shell === 1,
      ),
      ...mcpToolNames(mcp),
    ],
    team: null,
    plan: null,
    workspace,
    mcp,
    replyId: params.replyId,
    sop: {
      run_id: params.runId,
      definition_id: params.definitionId,
      step_index: params.stepIndex,
      step_title: params.step.title,
      step_description: params.step.description,
      role: params.role,
      attempt: params.attempt,
      max_attempts: params.step.max_attempts,
      executor_text: params.executorText,
    },
    baseSeq: 0,
    reason: 'channel-message',
    discipline: { definite: false, signal: null },
    contextScope: 'window',
    messages,
    consumedSeq: readConsumedSeq(db, member.id, params.channelId),
    memories: [],
    systemPrompt: prompt.systemPrompt,
    promptSections: prompt.sections,
  };
}

/** The readable copy for a zero-fallback workspace failure (D5.3 / D5.7). */
function workspaceFailureReason(db: Database.Database, backend: string): string {
  if (backend === 'docker') {
    return tFromDb(db, 'workspace.round.dockerUnavailable');
  }
  return tFromDb(db, 'workspace.round.rootMissing');
}

/**
 * The round's local workspace face (D5.1 / D5.3). A configured root that has
 * disappeared and the docker backend are readable round failures before the
 * adapter runs: zero tool calls, no local fallback. A DM or a local channel /
 * task without a root simply has no workspace face.
 */
function readRoundWorkspace(
  db: Database.Database,
  memberId: string,
  targetId: string,
  approval: {
    replyId: string;
    contextKind: 'round' | 'team-assignment' | 'sop';
    contextId: string | null;
    approvalTargetId?: string | null;
    onApprovalWait?: () => void;
    onApprovalSettled?: () => void;
  },
): RoundWorkspaceContext | null {
  const failure = readRoundWorkspaceFailure(db, memberId, targetId);
  if (failure !== null) {
    throw new Error(workspaceFailureReason(db, failure.backend));
  }
  const binding = readRoundWorkspaceBinding(db, memberId, targetId);
  if (binding === null) {
    return null;
  }
  const permission = readTargetPermissionContext(db, memberId, targetId);
  if (permission === null) {
    throw new Error(`permission context not found: ${targetId}`);
  }
  const gate = createToolGate({
    db,
    permission,
    replyId: approval.replyId,
    contextKind: approval.contextKind,
    contextId: approval.contextId,
    approvalTargetId: approval.approvalTargetId,
    onApprovalWait: approval.onApprovalWait,
    onApprovalSettled: approval.onApprovalSettled,
  });
  return {
    root: binding.root,
    backend: 'local',
    permission_mode: permission.effective,
    allow_local_shell: permission.allowLocalShell,
    skills_root: binding.skillsRoot,
    permission: {
      mode: permission.effective,
      check: (request) => gate.check(request),
      authorize: (request) => gate.authorize(request),
    },
    files: createRoundFileTools({
      root: binding.root,
      skillsRoot: binding.skillsRoot,
      gate,
    }),
    shell: createLocalShell({
      root: binding.root,
      allowLocalShell: permission.allowLocalShell,
      // #47 replaces this process-level list with the member's enabled MCP
      // servers' `env_names`; the shell face itself already merges per round.
      envNames: getShellEnvNames(),
      gate,
    }),
  };
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

async function readRoundInput(
  db: Database.Database,
  wake: Wake,
  context: {
    teamRun: StartedTeamRun | null;
    assign: TeamAssignExecutor | null;
    replyId: string;
  },
): Promise<RoundInput> {
  const member = db
    .prepare(
      `SELECT m.id, m.display_name, m.avatar_slot, c.role, c.model, c.system_prompt
         FROM member m JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ? AND m.kind = 'agent' AND ${liveMemberClause('m')}`,
    )
    .get(wake.memberId) as RoundMember | undefined;
  if (member === undefined) {
    throw new Error(`round member not found: ${wake.memberId}`);
  }

  const targetKind = readRoundTargetKind(db, wake.targetId);
  const consumedSeq = readConsumedSeq(db, member.id, wake.targetId);
  // 上下文窗口: a normal round reads the most recent 40 target messages; an
  // auto-continue round keeps working on its whole task thread. The window is
  // history only — it never decides the signal, the discipline or the cursor.
  const contextScope = contextScopeFor(wake, targetKind);
  const messages: RoundMessage[] = readContextWindow(db, wake.targetId, contextScope);

  const triggeredByHuman = wokeByHuman(db, wake);
  const discipline = readDiscipline(db, wake, triggeredByHuman);
  // Recall happens before the round runs and only informs its understanding
  // (D5.2): it reads this round's input and never writes, wakes or spends
  // budget.
  const memories = recallForRound(db, member.id, wake.targetId, messages);

  // 队长提示与工具集 (#39 / D3.7): the team reading is the same target state the
  // wake surface used. The leader is the only round that carries TeamAssign;
  // transfer_task belongs to the task's current assignee, so a leader who is
  // not the assignee does not see it.
  const teamState = readTeamTargetState(db, wake.targetId, process.env);
  const isLeader =
    teamState !== null && teamState.available && teamState.leaderMemberId === member.id;
  // Plan tools (D4.1): a task target and any team target carry them; a DM and
  // an autonomous channel's ordinary round do not. The subtarget's own member
  // is the Plan owner, so the same face serves the leader and a plain member.
  const planAvailable =
    targetKind === 'task' || (targetKind === 'channel' && teamState !== null);
  const workspace = readRoundWorkspace(db, member.id, wake.targetId, {
    replyId: context.replyId,
    contextKind: 'round',
    contextId: null,
  });
  const mcp = await buildRoundMcp({
    db,
    dataDir: readRoundDataDir(db),
    memberId: member.id,
    sessionId: context.replyId,
    targetId: wake.targetId,
    contextKind: 'round',
    contextId: null,
    projectRoot: readTargetProjectRoot(db, wake.targetId),
    env: process.env,
  });
  const tools = [
    ...readRoundTools(
      db,
      member.id,
      wake.targetId,
      targetKind,
      isLeader,
      planAvailable,
      workspace !== null,
      workspace?.allow_local_shell === 1,
    ),
    ...mcpToolNames(mcp),
  ];
  const plan = planAvailable ? createPlanFace(db, wake.targetId, member.id) : null;
  const team: RoundTeamContext | null =
    teamState === null
      ? null
      : {
          leader_member_id:
            teamState.leaderMemberId.length === 0 ? null : teamState.leaderMemberId,
          is_leader: isLeader,
          task_id: teamState.taskId,
          team_run_id: context.teamRun?.id ?? null,
          assignment: null,
          assign: isLeader ? context.assign : null,
        };
  const prompt = composeSystemPrompt(
    db,
    member,
    targetKind,
    triggeredByHuman,
    wake.reason,
    memories,
    { isLeader, assignmentInstruction: null, projectRoot: readTargetProjectRoot(db, wake.targetId) },
  );
  return {
    member,
    targetId: wake.targetId,
    targetKind,
    channelMode: teamState === null ? 'autonomous' : 'team',
    tools,
    team,
    plan,
    workspace,
    mcp,
    replyId: context.replyId,
    sop: null,
    baseSeq: wake.fromSeq,
    reason: wake.reason,
    discipline,
    contextScope,
    messages,
    consumedSeq,
    memories,
    systemPrompt: prompt.systemPrompt,
    promptSections: prompt.sections,
  };
}

/**
 * The tools one round may call (D3.7). `TeamAssign` is the leader's own tool;
 * `transfer_task` is the structured action of the task's current assignee, so
 * it is absent from a leader round that did not take the task. The four Plan
 * tools are appended on every task / team round (D4.1).
 */
function readRoundTools(
  db: Database.Database,
  memberId: string,
  targetId: string,
  targetKind: RoundTargetKind,
  isLeader: boolean,
  planAvailable: boolean,
  fileToolsAvailable: boolean,
  shellAvailable: boolean,
): readonly string[] {
  const tools: string[] = [];
  if (isLeader) {
    tools.push('TeamAssign');
  }
  if (targetKind === 'task') {
    const task = db
      .prepare('SELECT assignee_member_id FROM task WHERE target_id = ?')
      .get(targetId) as { assignee_member_id: string | null } | undefined;
    if (task?.assignee_member_id === memberId) {
      tools.push('transfer_task');
    }
  }
  if (planAvailable) {
    // The tool names are product names; the adapter calls the same face under
    // its `RoundInput.plan`.
    tools.push('TaskCreate', 'TaskGet', 'TaskList', 'TaskUpdate');
  }
  if (fileToolsAvailable) {
    // A local round with a project root gets exactly the restricted file tools.
    tools.push('Read', 'Glob', 'Grep', 'Write', 'Edit');
  }
  if (shellAvailable) {
    // The explicit switch adds the local shell to the offered set. The switch
    // alone does not skip the per-call approval: the gate still asks (D5.4).
    tools.push('Bash');
  }
  return tools;
}

/**
 * How much history this round reads. 自动续跑 (Auto-continue) continues a task thread
 * and therefore reads that thread whole; every other round reads the recent
 * window. The wake reason alone is not enough: only a continue wake on a task
 * target is a thread-wide round.
 */
function contextScopeFor(wake: Wake, targetKind: RoundTargetKind): ContextScope {
  return wake.reason === 'continue' && targetKind === 'task' ? 'full' : 'window';
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
    case 'team-change':
      // 队长被任务变化唤醒（建任务 / owner 改派 / Agent 转派）: a definite
      // signal with its own copy, never the claim / mention / human-message text.
      return { definite: true, signal: 'team-change' };
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

/** The channel project root behind a target; null for a DM / no-root target. */
function readTargetProjectRoot(db: Database.Database, targetId: string): string | null {
  return readTargetWorkspaceBinding(db, targetId)?.root ?? null;
}

/**
 * The system prompt a round is handed. It states its own composition (D3.7 /
 * D5.2) as `RoundPromptSections`: the global rules base → the stored
 * `agent_config.system_prompt` → the project supplement → the assembled skills,
 * then the display-name identity sentence, the target's response discipline,
 * the mandatory-answer sentences, the leader duties on a leader round, the
 * assignment paragraph on a TeamAssign sub-round, and finally the recalled-memory
 * section.
 *
 * The global base (the member home's `AGENTS.md`) and the project supplement
 * (`<workspace_root>/.allibot/agents/<member_id>/AGENTS.md`) are read by the
 * host and injected as prompt text (#43). A missing / unreadable / empty piece
 * is absent, never an empty section, and only that piece is omitted. A DM is
 * stated one-to-one with an explicit mandatory answer (the glossary's
 * "一对一口径 + 显式必答句") instead of the channel rubric. The memory section
 * is appended only — it never replaces the stored prompt (D5.2).
 */
function composeSystemPrompt(
  db: Database.Database,
  member: RoundMember,
  targetKind: RoundTargetKind,
  triggeredByHuman: boolean,
  reason: WakeReason,
  memories: readonly RoundMemory[],
  options: {
    isLeader: boolean;
    assignmentInstruction: string | null;
    /** The channel's project root; null for a DM / no-root round. */
    projectRoot: string | null;
    /** The SOP step / role when this is an internal executor / verifier round. */
    sop?: {
      role: 'executor' | 'verifier';
      stepTitle: string;
      description: string;
      stepIndex: number;
      attempt: number;
      maxAttempts: number;
      executorText: string | null;
    } | null;
  },
): { systemPrompt: string; sections: RoundPromptSections } {
  const sop = options.sop ?? null;
  const targetDiscipline =
    sop !== null
      ? tFromDb(db, 'prompt.sop.discipline')
      : targetKind === 'dm'
        ? tFromDb(db, 'prompt.dm.oneToOne')
        : tFromDb(db, 'prompt.channel.rubric');
  const mandatory: string[] = [];
  if (sop === null) {
    if (targetKind === 'dm') {
      mandatory.push(
        triggeredByHuman
          ? tFromDb(db, 'prompt.humanMessage.mandatory')
          : tFromDb(db, 'prompt.dm.mandatory'),
      );
    } else {
      if (triggeredByHuman) {
        mandatory.push(tFromDb(db, 'prompt.humanMessage.mandatory'));
      }
      if (reason === 'team-change') {
        mandatory.push(tFromDb(db, 'prompt.teamChange.mandatory'));
      }
    }
  }
  const rules = readRoundRuleSections(member.id, options.projectRoot);
  const sections: RoundPromptSections = {
    rulesBase: rules.rulesBase,
    systemPrompt: member.system_prompt.trim(),
    projectSupplement: rules.projectSupplement,
    skills: skillPromptSection(db, member.id),
    identity: tFromDb(db, 'prompt.identity', { name: member.display_name }),
    targetDiscipline,
    mandatory,
    leaderDuties: options.isLeader ? tFromDb(db, 'prompt.teamLeader.duties') : null,
    assignment:
      options.assignmentInstruction === null
        ? null
        : tFromDb(db, 'prompt.teamAssignment.context', {
            instruction: options.assignmentInstruction,
          }),
    memory: memoryPromptSection(db, memories),
    sop:
      sop === null
        ? null
        : sop.role === 'executor'
          ? tFromDb(db, 'prompt.sop.executor', {
              title: sop.stepTitle,
              step: String(sop.stepIndex + 1),
              attempt: String(sop.attempt),
              max_attempts: String(sop.maxAttempts),
              description: sop.description,
            })
          : tFromDb(db, 'prompt.sop.verifier', {
              title: sop.stepTitle,
              step: String(sop.stepIndex + 1),
              attempt: String(sop.attempt),
              max_attempts: String(sop.maxAttempts),
              executor: sop.executorText ?? '',
            }),
  };
  const parts = [
    sections.rulesBase,
    sections.systemPrompt.length > 0 ? sections.systemPrompt : null,
    sections.projectSupplement,
    sections.skills,
    sections.identity,
    sections.targetDiscipline,
    ...sections.mandatory,
    sections.leaderDuties,
    sections.assignment,
    sections.sop,
    sections.memory,
  ];
  return {
    systemPrompt: parts.filter((part): part is string => part !== null && part.length > 0).join('\n\n'),
    sections,
  };
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
  options: { jump: number; interrupted: boolean; replyId: string },
): CommittedRound {
  const { jump, interrupted, replyId } = options;
  const discipline = roundInput?.discipline ?? { definite: false, signal: null };
  const messages: WrittenMessage[] = [];
  const outcomes: RoundOutcomeRow[] = [];
  const write = db.transaction((): {
    outcome: RoundOutcomeRow;
    reply: { id: string; seq: number; body: string } | null;
    pendingWakes: Wake[];
  } => {
    const joinedSeq = interrupted ? null : commitJoin(db, wake, result, messages);
    const reply = interrupted ? null : commitReply(db, wake, result, messages, replyId);
    const finishedAt = new Date().toISOString();

    // Long-term memory is written back deterministically at round close
    // (D5.1): the trigger excerpt plus this member's reply excerpt, or the
    // "no reply" wording for an ignored / failed round. It never calls a model
    // and has no switch; a round whose input could not even be read writes no
    // card, because nothing was understood. An interrupted round never
    // concluded its understanding, so it writes no card either.
    if (roundInput !== undefined && !interrupted) {
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

    // 人类中断 (human interrupt) is the orchestration's fact, not the adapter's:
    // the run was cancelled before the round's conclusion could be committed.
    // The round lands no reply; it closes as failed so the consumption cursor
    // stays where it is and the message is read again by the next wake.
    const judged = interrupted
      ? { status: 'failed' as const, finishedReason: 'human-interrupt' as const }
      : judgeRound(discipline, result, reply?.seq ?? null);
    // 自动续跑: the structured action lands its own system record in this same
    // transaction, either with one more wake for the same assignee or with the
    // paused record once the epoch's four work rounds are used up.
    const action = interrupted ? null : commitTaskAction(db, wake, roundInput, result, messages);
    const outcome = insertOutcome(db, {
      wake,
      baseSeq: wake.fromSeq,
      status: judged.status,
      reason: interrupted
        ? [wakeText(db, wake.reason), tFromDb(db, 'round.interrupted')].join('；')
        : roundReason(
            db,
            wake,
            discipline,
            result,
            judged,
            joinedSeq,
            reply?.seq ?? null,
            action?.clause ?? null,
            roundInput?.mcp?.diagnostics.join('；') ?? null,
          ),
      merged: 0,
      startedAt,
      finishedAt,
      finishedReason: judged.finishedReason,
      // The row-level marker of "this round was delivered by a counted jump".
      // A folded reply lands here too, so the row count never decides the hop
      // count (the ledger does); one jump marks every member it was delivered to.
      budgetConsumed: jump,
    });
    outcomes.push(outcome);
    // 消费游标 (Agent Read Cursor) advances only on replied / ignored: a failed
    // round leaves its message new, so the next wake reads it again instead of
    // skipping it. The cursor and the round's own rows share this transaction.
    if (advancesCursor(judged.status)) {
      advanceConsumedSeq(db, wake.memberId, wake.targetId, wake.fromSeq);
    }
    return {
      outcome,
      reply,
      pendingWakes: action === null || action.wake === null ? [] : [action.wake],
    };
  });
  const { outcome, reply, pendingWakes } = write();
  return { outcome, reply, replySeq: reply?.seq ?? null, messages, outcomes, pendingWakes };
}

/**
 * Handle one round's structured `continue_task` action (自动续跑).
 *
 * The action is honoured only on a task thread and only for the task's current
 * assignee: the member must be the one the task was claimed by / assigned to.
 * Team task threads do not offer it; M1's channel mode check admits only
 * `autonomous`, so there is no team branch to add here.
 *
 * The cap is per human epoch: it counts the real work rounds this member has
 * already concluded on this task since the epoch's opener (`merged` rows and
 * suppressed wakes are not rounds). Four rounds means the first plus three
 * auto-continues; the fourth request lands `continue_paused` and wakes nobody.
 * The action is not a jump: the returned wake is delivered by the caller with
 * no jump charged.
 */
function commitTaskAction(
  db: Database.Database,
  wake: Wake,
  roundInput: RoundInput | undefined,
  result: RoundResult,
  written: WrittenMessage[],
): { clause: string; wake: Wake | null } | null {
  if (result.taskAction === 'transfer_task') {
    return commitTransferAction(db, wake, roundInput, result);
  }
  if (result.taskAction !== 'continue_task' || roundInput === undefined) {
    return null;
  }
  if (roundInput.targetKind !== 'task') {
    return null;
  }
  // 自动续跑在 team 任务线程不提供（D3.5）: the leader-only wake rule is not
  // reopened by a structured action, and the refusal is readable in the round
  // reason. It starts no round, writes no continue record and charges no jump.
  if (readTeamTargetState(db, wake.targetId, process.env) !== null) {
    return {
      clause: tFromDb(db, 'round.continue.teamDisabled'),
      wake: null,
    };
  }
  const task = db
    .prepare('SELECT title, assignee_member_id FROM task WHERE target_id = ?')
    .get(wake.targetId) as { title: string; assignee_member_id: string | null } | undefined;
  if (task === undefined || task.assignee_member_id !== wake.memberId) {
    return null;
  }

  const currentRound = countEpochWorkRounds(db, wake) + 1;
  if (currentRound >= TASK_WORK_ROUNDS_PER_EPOCH) {
    const paused = insertMessage(
      db,
      wake.targetId,
      'system',
      readOwnerId(db),
      tFromDb(db, 'task.event.continue.paused', {
        rounds: TASK_WORK_ROUNDS_PER_EPOCH,
        assignee: roundInput.member.display_name,
        title: task.title,
      }),
    );
    written.push(paused);
    return {
      clause: tFromDb(db, 'round.continue.paused', { rounds: TASK_WORK_ROUNDS_PER_EPOCH }),
      wake: null,
    };
  }

  const record = insertMessage(
    db,
    wake.targetId,
    'system',
    readOwnerId(db),
    tFromDb(db, 'task.event.continue', {
      assignee: roundInput.member.display_name,
      title: task.title,
    }),
  );
  written.push(record);
  return {
    clause: tFromDb(db, 'round.continue.granted', { round: currentRound }),
    wake: {
      memberId: wake.memberId,
      targetId: wake.targetId,
      fromSeq: record.seq,
      reason: 'continue',
    },
  };
}

/**
 * Handle one round's structured `transfer_task` action (转派, D3.5).
 *
 * Only the task's current assignee can transfer it, only to another live Agent
 * member of the same channel. The assignee change and the system change record
 * share the round's transaction; a refusal writes nothing and is readable in
 * the round reason. 人类世代 does not open here, and no message body is
 * written. On a team channel the change wakes the leader with `team-change`
 * (from_seq = the system record) unless the leader is the actor; an autonomous
 * channel adds no wake.
 */
function commitTransferAction(
  db: Database.Database,
  wake: Wake,
  roundInput: RoundInput | undefined,
  result: RoundResult,
): { clause: string; wake: Wake | null } | null {
  if (roundInput === undefined || roundInput.targetKind !== 'task') {
    return null;
  }
  if (result.taskTransferMemberId === undefined || result.taskTransferMemberId.length === 0) {
    return {
      clause: tFromDb(db, 'round.transfer.rejected', {
        reason: tFromDb(db, 'round.transfer.noTarget'),
      }),
      wake: null,
    };
  }
  const task = db
    .prepare('SELECT id FROM task WHERE target_id = ?')
    .get(wake.targetId) as { id: string } | undefined;
  if (task === undefined) {
    return null;
  }
  // Imported lazily at module scope would be a cycle: tasks.ts already knows
  // this write path, and this module only formats the outcome.
  const transfer = transferTaskAsMember(db, task.id, wake.memberId, result.taskTransferMemberId);
  if (!transfer.ok) {
    return {
      clause: tFromDb(db, 'round.transfer.rejected', { reason: transfer.reason }),
      wake: null,
    };
  }
  const team = readTeamTargetState(db, wake.targetId, process.env);
  let nextWake: Wake | null = null;
  if (team !== null && wake.memberId !== team.leaderMemberId) {
    if (team.available) {
      nextWake = {
        memberId: team.leaderMemberId,
        targetId: wake.targetId,
        fromSeq: transfer.assigneeEventSeq,
        reason: 'team-change',
      };
    } else {
      // The transfer itself is a task change that should have reached the
      // leader: an unusable leader leaves the invalid-leader run instead.
      recordInvalidLeaderRun(db, team);
    }
  }
  return {
    clause: tFromDb(db, 'round.transfer.done', { assignee: transfer.assigneeName }),
    wake: nextWake,
  };
}

/**
 * The work rounds this member already concluded on the task inside the current
 * human epoch. The epoch is the budget row's opener seq; rows older than it
 * belong to an earlier epoch. Folded wakes are not rounds, and a suppressed
 * wake never ran at all, so neither counts against the auto-continue cap.
 */
function countEpochWorkRounds(db: Database.Database, wake: Wake): number {
  const budget = db
    .prepare('SELECT epoch_seq FROM target_budget WHERE target_id = ?')
    .get(wake.targetId) as { epoch_seq: number } | undefined;
  const epochSeq = budget?.epoch_seq ?? 0;
  const row = db
    .prepare(
      `SELECT count(*) AS total
         FROM round_outcome
        WHERE member_id = ? AND target_id = ? AND merged = 0
          AND status <> 'budget-exhausted' AND base_seq >= ?`,
    )
    .get(wake.memberId, wake.targetId, epochSeq) as { total: number };
  return row.total;
}

/**
 * Whether a round's conclusion consumes its triggering message. Only the two
 * normal protocol conclusions do: `replied` and `ignored`. A structured silence
 * is the model's explicit protocol answer, but the spec's cursor rule names
 * exactly these two statuses, so silence neither advances nor rewinds it. A
 * failed round never consumes; a merged row is not a round of its own and
 * moves nothing.
 */
function advancesCursor(status: RoundOutcomeStatus): boolean {
  return status === 'replied' || status === 'ignored';
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
  /** The persisted reply this round landed, if any (一轮 ↔ 至多一条). */
  reply: { id: string; seq: number; body: string } | null;
  replySeq: number | null;
  messages: WrittenMessage[];
  /** Every outcome row written by this round, in write order. */
  outcomes: RoundOutcomeRow[];
  /**
   * Wakes the round committed but did not deliver itself: auto-continue's
   * explicit re-wake of the assignee. They are delivered after this round
   * closes, with no jump charged (自动续跑 is not a jump).
   */
  pendingWakes: Wake[];
}

/**
 * Await the adapter's round, or the run's cancellation — whichever comes
 * first. A cancelled run discards the adapter's late result and closes the
 * round as a human interrupt; the abandoned promise's rejection is swallowed
 * so it cannot escape as an unhandled one.
 */
async function runProviderRound(
  provider: RoundProvider,
  input: RoundInput,
  signal: AbortSignal | undefined,
): Promise<{ result: RoundResult; interrupted: boolean }> {
  if (signal === undefined) {
    return { result: await provider.runRound(input), interrupted: false };
  }
  if (signal.aborted) {
    return { result: { verdict: 'failed', replies: [] }, interrupted: true };
  }
  const round = provider.runRound(input);
  round.catch(() => undefined);
  const interruptedResult: RoundResult = { verdict: 'failed', replies: [] };
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<null>((resolve) => {
    onAbort = () => resolve(null);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try {
    const settled = await Promise.race([
      round.then((result) => ({ result, interrupted: false as const })),
      aborted.then(() => ({ result: interruptedResult, interrupted: true as const })),
    ]);
    // An abort that lands after the adapter settled but before the round's
    // transaction ran still stops the run: the human cancelled before the
    // conclusion was committed.
    if (!settled.interrupted && signal.aborted) {
      return { result: { verdict: 'failed', replies: [] }, interrupted: true };
    }
    return settled;
  } finally {
    if (onAbort !== undefined) {
      signal.removeEventListener('abort', onAbort);
    }
  }
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
 *
 * The finished reason (轮次结束原因) is computed separately: an adapter that
 * states how it ended (the iteration limit) says so even when the response
 * discipline then closes the round as failed, and an adapter failure with no
 * statement of its own is an error. Every other round ran to completion.
 */
function judgeRound(
  discipline: RoundDiscipline,
  result: RoundResult,
  replySeq: number | null,
): { status: RoundOutcomeStatus; finishedReason: FinishedReason } {
  const finishedReason = finishedReasonOf(result);
  if (result.verdict === 'failed') {
    return { status: 'failed', finishedReason };
  }
  if (result.verdict === 'replied') {
    // A round that only submits a structured task action has answered, even
    // though it landed no body: "无正文且无任务动作" is the failure condition,
    // not "no body" alone (D1.13 回应判断).
    const answeredByAction = result.taskAction !== undefined;
    return replySeq === null && !answeredByAction && discipline.definite
      ? { status: 'failed', finishedReason }
      : { status: 'replied', finishedReason };
  }
  if (discipline.definite) {
    return { status: 'failed', finishedReason };
  }
  return { status: result.verdict, finishedReason };
}

/**
 * How the round ended, as the seam stated it. The adapter only states departures
 * from a normal completion; an absent statement plus a failed verdict is the
 * error reason, because a failure that says nothing about its ending ended in
 * an error.
 */
function finishedReasonOf(result: RoundResult): FinishedReason {
  if (result.finishedReason !== undefined) {
    return result.finishedReason;
  }
  return result.verdict === 'failed' ? 'error' : 'completed';
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
    readOwnerId(db),
    tFromDb(db, 'system.member.piercedJoin', { name: member.display_name }),
  );
  written.push(join);
  return join.seq;
}

/** The same target-kind row, narrowed for the round input. */
function readRoundTargetKind(db: Database.Database, targetId: string): RoundTargetKind {
  const kind = readTargetKind(db, targetId);
  return kind === 'dm' || kind === 'task' ? kind : 'channel';
}

function commitReply(
  db: Database.Database,
  wake: Wake,
  result: RoundResult,
  written: WrittenMessage[],
  replyId: string,
): { id: string; seq: number; body: string } | null {  if (result.verdict !== 'replied' || !hasBody(result)) {
    return null;
  }
  // 一轮 ↔ 至多一条 target 消息: the seam may hand over several pending
  // replies, and this write path lands the first one. Streaming the rest is
  // the AG-UI ticket's shape, not a second message per round here.
  const body = result.replies[0]?.trim();
  if (body === undefined || body.length === 0) {
    return null;
  }
  const reply = {
    ...insertMessage(db, wake.targetId, 'agent', wake.memberId, body, replyId),
    body,
  };
  written.push(reply);
  return reply;
}

function hasBody(result: RoundResult): boolean {
  const body = result.replies[0];
  return result.verdict === 'replied' && body !== undefined && body.trim().length > 0;
}

/**
 * The body the round was woken by: the message at the wake's `baseSeq`. The
 * trigger is normally the newest message when the round reads, so it is inside
 * the context window and the lookup is exact. A trigger older than the window
 * start (a deferred wake that waited while more than a window of messages
 * landed) falls back to the oldest message the round did read — the window
 * message nearest the trigger — so the card always carries an excerpt.
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
  id?: string,
): { id: string; seq: number } {
  return insertMessageRow(db, { id, targetId, kind, authorMemberId, body });
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
  taskActionClause: string | null,
  mcpDiagnostic: string | null,
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
  if (taskActionClause !== null) {
    parts.push(taskActionClause);
  }
  if (mcpDiagnostic !== null && mcpDiagnostic.length > 0) {
    // 文件非法 / 未确认远端 / 连接失败: only the readable diagnostic enters the
    // round outcome; it never fabricates half a tool set.
    parts.push(mcpDiagnostic);
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
