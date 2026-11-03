import { setTimeout as delay } from 'node:timers/promises';
import type { RoundInput, RoundProvider, RoundResult } from './agent-seam.js';

/**
 * The scripted provider double (D4.3): a fixed behaviour injected through the
 * `--scripted-provider` startup argument, so behaviour tests run with no
 * network and no model cost.
 *
 * The four behaviours are the spec's fixed set. `delay` settles one round
 * after `delayMs`, which is what makes the "one round in flight" window
 * observable without a real model. It is an adapter choice, not a production
 * back door: production code never branches on a test environment variable —
 * the CLI selects this adapter by name, exactly like the future real one.
 */
export type ScriptedBehavior = 'reply' | 'ignore' | 'fail' | 'delay';

export const SCRIPTED_BEHAVIORS: readonly ScriptedBehavior[] = [
  'reply',
  'ignore',
  'fail',
  'delay',
];

export interface ScriptedProviderOptions {
  behavior: ScriptedBehavior;
  /** How long the `delay` behaviour holds a round before it settles. */
  delayMs: number;
  /** The bodies a `reply` (and `delay`, once settled) round lands. */
  replies?: readonly string[];
}

/** The default scripted reply: deterministic, readable and free of model calls. */
export function defaultScriptedReply(input: RoundInput): string {
  return `收到 #${input.baseSeq}（${input.member.display_name}）${memoryReport(input)}`;
}

/**
 * The double's report of what the round actually recalled. It is the test
 * double's own observation face (D4.3): the count is the number of cards the
 * seam assembled into the system prompt's memory section, and each
 * `mem:<keyword>` line names a card whose keywords this round's input matched.
 * It stays inside this file — production code never parses a reply body.
 */
function memoryReport(input: RoundInput): string {
  const markers = [
    ...new Set(input.memories.flatMap((memory) => memory.matched_keywords)),
  ].map((keyword) => `mem:${keyword}`);
  const injected = input.memories.filter((memory) =>
    input.systemPrompt.includes(memory.content),
  ).length;
  return ['', `memcount:${injected}`, ...markers].join('\n');
}

export function createScriptedProvider(options: ScriptedProviderOptions): RoundProvider {
  return {
    deferred: options.behavior === 'delay',
    name: `scripted:${options.behavior}`,
    async runRound(input: RoundInput): Promise<RoundResult> {
      switch (options.behavior) {
        case 'ignore':
          return { verdict: 'ignored', replies: [] };
        case 'fail':
          return { verdict: 'failed', replies: [], detail: '脚本化 provider：本轮被设定为失败' };
        case 'delay':
          await delay(options.delayMs);
          return replyResult(input, options.replies);
        case 'reply':
          return replyResult(input, options.replies);
      }
    },
  };
}

function replyResult(input: RoundInput, replies: readonly string[] | undefined): RoundResult {
  // Without an explicit body the double answers with what it read through the
  // ordinary read path — the triggering seq — so the round is observably a
  // real round rather than a canned string.
  const bodies = replies ?? [defaultScriptedReply(input)];
  return { verdict: 'replied', replies: [...bodies] };
}
