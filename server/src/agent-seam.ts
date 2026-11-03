/**
 * The member-face adapter seam (成员面适配接缝): one member round in, zero or
 * more pending replies plus one round conclusion out.
 *
 * The shape is fixed by the glossary and the spec (D4.3): the scripted adapter
 * injected through `--scripted-provider` is the only implementation this
 * ticket ships, and the real provider adapter arrives behind the same
 * interface without changing it. Nothing here knows about HTTP, SQLite or the
 * scripted double's four behaviours.
 */

/**
 * Why a member was woken. The signal carries the reason for readable
 * diagnostics only; it is never the discipline that decides whether the Agent
 * must answer.
 */
export const WAKE_REASONS = ['channel-message', 'mention', 'claim', 'continue'] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

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

/** The round's input: the member, the context it reads, and the wake reason. */
export interface RoundInput {
  member: RoundMember;
  targetId: string;
  /** The seq of the message that triggered this wake. */
  baseSeq: number;
  reason: WakeReason;
  /** The target's messages from `baseSeq` on, oldest first, read at round start. */
  messages: readonly RoundMessage[];
}

/** The three verdicts a member round can reach in this ticket. */
export type RoundVerdict = 'replied' | 'ignored' | 'failed';

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
