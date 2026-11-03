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
  /** The target's messages from `baseSeq` on, oldest first, read at round start. */
  messages: readonly RoundMessage[];
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
 * The seam's output. `replies` holds zero or more bodies the adapter wants
 * persisted; the round's write path lands at most one target message per
 * round (一轮 ↔ 至多一条 target 消息), so only the first pending reply is
 * committed here. Multi-reply streaming belongs to the AG-UI ticket.
 *
 * `detail` is the adapter's readable diagnostic for the round (a failure
 * reason today); it is folded into the round outcome's readable `reason` and
 * never replaces the status.
 */
export interface RoundResult {
  verdict: RoundVerdict;
  replies: readonly string[];
  detail?: string;
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
