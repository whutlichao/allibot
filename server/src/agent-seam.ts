/**
 * The member-face adapter seam (成员面适配接缝): one member round in, zero or
 * more pending replies plus one round conclusion out.
 *
 * The shape is fixed by the glossary and the spec (D4.3): the scripted adapter
 * injected through `--scripted-provider` is the only implementation this
 * ticket ships, and the real provider adapter arrives behind the same
 * interface without changing it. Nothing here knows about HTTP, SQLite or the
 * scripted double's chosen behaviour.
 *
 * Long-term memory (#17) and response judgment (#15) both extend the input
 * side only: a round now also carries the memory cards recalled for it and the
 * assembled system prompt, the same way a task-thread round carries task
 * context. The output shape — zero or more pending replies plus one round
 * result — is unchanged.
 */

/**
 * Why a member was woken. The signal carries the reason for readable
 * diagnostics only; it is never the discipline that decides whether the Agent
 * must answer.
 */
export const WAKE_REASONS = ['channel-message', 'mention', 'claim', 'continue'] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

/** The three target kinds; a DM round reads its own one-to-one prompt. */
export type RoundTargetKind = 'channel' | 'dm' | 'task';

/**
 * 上下文窗口 (Context Window): a normal round reads the most recent 40 target
 * messages. An auto-continue round reads the whole task thread it keeps working
 * on instead, because that thread is the work item.
 */
export const ROUND_CONTEXT_WINDOW = 40;

/** How much history one round reads: the recent window, or the whole thread. */
export type ContextScope = 'window' | 'full';

/** What the round is allowed to know about the member it runs for. */
export interface RoundMember {
  id: string;
  display_name: string;
  role: string;
  model: string | null;
  system_prompt: string;
}

/**
 * One message the round reads through the same read path the human face uses.
 * Bodies travel here because the round understands the request; the wake
 * signal that started the round never carried them.
 */
export interface RoundMessage {
  seq: number;
  kind: 'human' | 'agent' | 'system';
  author_member_id: string;
  author_display_name: string;
  body: string;
}

/**
 * The response discipline (回应判断) computed from the triggering message, not
 * from the wake reason: the reason is readable diagnostics only, and a merged
 * wake keeps the reason of whichever arrived first.
 *
 * `definite` is true for the M1 definite signals: a personal mention, a claim
 * wake, a human message the round is woken by, and an auto-continue wake. It
 * is the stored rule the adapter reads from its input, never something the
 * adapter infers back from the reason's text.
 */
export interface RoundDiscipline {
  definite: boolean;
  /** The definite signal that fired; `null` when `definite` is false. */
  signal: 'mention' | 'claim' | 'human-message' | 'continue' | null;
}

/** The round's input: the member, the context it reads, and its discipline. */
export interface RoundInput {
  member: RoundMember;
  targetId: string;
  /** The kind of target this round runs in; a DM reads a one-to-one prompt. */
  targetKind: RoundTargetKind;
  /** The seq of the message that triggered this wake. */
  baseSeq: number;
  reason: WakeReason;
  discipline: RoundDiscipline;
  /**
   * How much history this round reads. A normal round reads the window; an
   * auto-continue round reads the whole task thread. The scope is stated here
   * so the adapter never has to infer it from the wake reason's text.
   */
  contextScope: ContextScope;
  /**
   * The target's context window (上下文窗口) for this round, oldest first: the
   * most recent messages — human, other members and this member's own history
   * replies alike — plus the triggering message, which is always part of the
   * window. An auto-continue round reads the whole thread it keeps working on
   * instead of the recent window.
   *
   * History is for understanding only: the wake, the response discipline and
   * the consumption cursor are computed from the new message, never from what
   * the window happens to reach back to.
   */
  messages: readonly RoundMessage[];
  /**
   * How far this member had consumed the target before this round: the
   * consumption cursor's `last_read_seq` (0 when the member has never consumed
   * anything there). A message newer than it and older than `baseSeq` is a
   * message an earlier round read but did not consume, so this round reads it
   * again — the round input states the cursor, the adapter only reads it.
   */
  consumedSeq: number;
  /**
   * The member's long-term memory cards recalled for this round (D5.2), best
   * match first. They are assembled into the prompt's memory section by the
   * seam; recall only informs this round's understanding and changes nothing
   * else about it.
   */
  memories: readonly RoundMemory[];
  /**
   * The assembled system prompt the adapter hands the model: the stored
   * `agent_config.system_prompt`, the target's response discipline, the
   * mandatory answer sentence where the round must answer, and the memory
   * section when this round recalled cards. The round input carries it so the
   * seam stays the one prompt assembly path.
   */
  systemPrompt: string;
}

/** One recalled memory card as a round reads it. */
export interface RoundMemory {
  id: string;
  content: string;
  /** The card keywords this round's input matched. */
  matched_keywords: readonly string[];
}

/**
 * What one member round concluded. `silent` is the deliberate silence (沉默):
 * a structured verdict the adapter states, never a message kind and never
 * derived from the readable text. `ignored` is the ordinary self-judged skip.
 * Both are normal protocol results on their own; under a definite signal the
 * round closes as `failed` (回应判断), which is the round write path's rule,
 * not the adapter's.
 */
export type RoundVerdict = 'replied' | 'ignored' | 'silent' | 'failed';

/**
 * 自动续跑 (Auto-continue) as a structured task action: "this task is not done,
 * wake me again". Prose that says "I will continue" has no execution face;
 * only this action does. It is part of the one round result — the output shape
 * is still zero or more pending replies plus one round result — and the round
 * write path decides what to land (a continue record and one more wake) and
 * when the per-epoch round cap pauses it.
 */
export type RoundTaskAction = 'continue_task';

/**
 * How a round ended, when the adapter knows it was not an ordinary completion.
 * The iteration cap (迭代上限) is an adapter-side fact: the adapter stopped
 * because its iteration budget ran out, not because it had nothing more to say,
 * so the partial conclusion it produced is still a conclusion. It is a field of
 * the round result, not a second output: the seam still answers with zero or
 * more pending replies plus one round result.
 *
 * The human interrupt (人类中断) is not stated here — it belongs to the run's
 * cancellation, which is the orchestration's fact, not the adapter's.
 */
export type RoundFinishReason = 'iteration-limit';

/**
 * The seam's output. `replies` holds zero or more bodies the adapter wants
 * persisted; the round's write path lands at most one target message per
 * round (一轮 ↔ 至多一条 target 消息), so only the first pending reply is
 * committed here. Multi-reply streaming belongs to the AG-UI ticket.
 *
 * `detail` is the adapter's readable diagnostic for the round (a failure
 * reason today); it is folded into the round outcome's readable `reason` and
 * never replaces the status.
 *
 * `finishedReason` states how the round ended when it was not a normal
 * completion. Absent means the round ran to completion; a `failed` verdict
 * without it closes as the error finished reason.
 */
export interface RoundResult {
  verdict: RoundVerdict;
  replies: readonly string[];
  detail?: string;
  finishedReason?: RoundFinishReason;
  /**
   * The structured task action this round requests, if any. Only
   * `continue_task` exists in M1; a body that merely says "I will continue"
   * never counts as one.
   */
  taskAction?: RoundTaskAction;
}

export interface RoundProvider {
  /**
   * `true` when the adapter settles its round after the delivery call returns
   * (the scripted `delay` behaviour today, a long model call later). The write
   * path then returns without waiting; the round still closes exactly once.
   */
  readonly deferred: boolean;
  /** The adapter's name, for the one startup line that says which face is live. */
  readonly name: string;
  runRound(input: RoundInput): Promise<RoundResult>;
}
