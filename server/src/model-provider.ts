import type { AgentProvider } from '@allibot/shared';
import type Database from 'better-sqlite3';
import type { RoundInput, RoundProvider, RoundResult } from './agent-seam.js';
import { tFromDb } from './copy.js';
import {
  PROVIDER_CREDENTIAL_ENV,
  checkProviderAvailability,
  maskSecret,
  providerBaseUrl,
  readCredential,
} from './providers.js';
import { ApprovalTimeoutError } from './tool-gate.js';
import { createAnthropicConversation } from './tool-conversation-anthropic.js';
import { createOpenAiConversation } from './tool-conversation-openai.js';
import {
  createRoundToolExecutor,
  runToolLoop,
  type ToolConversation,
  type ToolLoopOutcome,
} from './tool-loop.js';
import { roundToolSpecs, type ToolCopy, type ToolFacts } from './tool-specs.js';

/**
 * The real provider adapters (D4.1): both provider lines run the same
 * round-level tool loop behind the same `RoundProvider` interface the scripted
 * double implements. Only the conversation — the provider's own wire shape —
 * differs between them.
 *
 * Two disciplines shape every call. First, no remote call happens before the
 * one-time remote-data-flow consent for the provider, and none happens without
 * a credential read from the environment — both cases close the round with a
 * readable reason and zero replies, without touching the network. Second, the
 * round's output shape stays the seam's: zero or more pending replies plus one
 * round result. The credential value travels only in the request header; it
 * never enters a reason, a message body or a log line.
 *
 * 轮内工具循环 (D1 / D7): a round may ask the model, run the tools it
 * requested and ask again, all inside this one `runRound` call. Only the text
 * of the turn that requests nothing lands, and a round whose tool set is empty
 * sends exactly the single completion it always did.
 */

/** The adapter's resolved inputs for one call. */
interface ProviderAvailability {
  provider: AgentProvider;
  model: string;
  /** The credential the request carries; never logged, never rendered. */
  credential: string;
  baseUrl: string;
}

type AvailabilityResult =
  | { ok: true; available: ProviderAvailability }
  | { ok: false; reason: string };

/**
 * Resolve whether this round may call the provider at all. The refusals are
 * deliberately different words — no model, unconfirmed remote provider, missing
 * credential — each with its own readable copy, and none opens a socket.
 */
function resolveAvailability(
  db: Database.Database,
  input: RoundInput,
  env: NodeJS.ProcessEnv,
): AvailabilityResult {
  const availability = checkProviderAvailability(db, input.member.model, env);
  if (!availability.ok) {
    switch (availability.reason) {
      case 'model-missing':
        return { ok: false, reason: tFromDb(db, 'round.model.missing') };
      case 'consent-missing':
        return {
          ok: false,
          reason: tFromDb(db, 'round.consent.missing', { provider: availability.provider }),
        };
      case 'credential-missing':
        return {
          ok: false,
          reason: tFromDb(db, 'round.credential.missing', {
            env: availability.credentialEnv,
          }),
        };
    }
  }
  // The check above proved the credential present; reading it again keeps the
  // availability answer free of the secret, because the status point reads the
  // same answer and must never hold a credential.
  const credential = readCredential(availability.provider, env);
  if (credential === null) {
    return {
      ok: false,
      reason: tFromDb(db, 'round.credential.missing', {
        env: PROVIDER_CREDENTIAL_ENV[availability.provider],
      }),
    };
  }
  return {
    ok: true,
    available: {
      provider: availability.provider,
      model: availability.model,
      credential,
      baseUrl: providerBaseUrl(availability.provider, env),
    },
  };
}

/** The user message a round sends: every message it read, in seq order. */
function userMessage(input: RoundInput): string {
  return input.messages
    .map((message) => `#${message.seq} ${message.author_display_name}：${message.body}`)
    .join('\n');
}

/**
 * The real adapter. `deferred` is false: one round awaits its model call and
 * settles before the message write returns, exactly like the scripted `reply`
 * behaviour.
 */
export function createModelProvider(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  options: { fetch?: typeof fetch; timeoutMs?: number } = {},
): RoundProvider {
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? 60_000;
  return {
    deferred: false,
    name: 'model',
    async runRound(input: RoundInput): Promise<RoundResult> {
      // The same availability rule the claim gate reads: no model, no consent
      // or no credential closes the round without a socket being opened.
      const availability = resolveAvailability(db, input, env);
      if (!availability.ok) {
        // Refusals are stated, not judged: both are readable and neither calls.
        return { verdict: 'failed', replies: [], detail: availability.reason };
      }
      const { available } = availability;
      try {
        const outcome = await callModel(db, doFetch, available, input, timeoutMs);
        // 结构化通道 (D11 / D12): the facts the round's dedicated tools stated map
        // onto the seam's existing fields, on every way the round ends — an
        // answer, the iteration cap, or a round that stated its conclusion and
        // then landed no text. The field set is the seam's own; nothing new is
        // added to `RoundResult`.
        const stated = structuredFields(outcome.facts);
        if (outcome.text.trim().length === 0) {
          // A round with no conclusion — including one that hit the cap before
          // producing anything — is the existing empty-completion failure. Only
          // the SOP verdict travels with it: that conclusion *is* the verifier's
          // whole protocol (`sop-executor.ts` reads nothing else), while a task
          // action must not survive a round that produced no conclusion. The
          // write path commits a task action without re-checking the verdict
          // (`rounds.ts` `commitTaskAction` / `commitTransferAction`), and a
          // `failed` round does not advance the cursor, so a transfer carried by
          // one would run again on the next wake of the same triggering message.
          // The team-assignment path already guards on `verdict !== 'replied'`;
          // this is the same invariant, kept by not stating the action at all.
          return {
            verdict: 'failed',
            replies: [],
            detail: failureReason(db, 'empty completion', available.credential),
            ...(outcome.facts.sopVerdict === undefined
              ? {}
              : { sopVerdict: outcome.facts.sopVerdict }),
          };
        }
        if (outcome.exhausted) {
          // The budget ran out, not the model's answer: the partial conclusion
          // still lands, and the round states how it ended (D8).
          return {
            verdict: 'replied',
            replies: [outcome.text],
            finishedReason: 'iteration-limit',
            ...stated,
          };
        }
        return { verdict: 'replied', replies: [outcome.text], ...stated };
      } catch (error) {
        if (error instanceof ApprovalTimeoutError) {
          // An approval wait that timed out came from the tool face but is the
          // one case that closes the round failed (D10): the batch's own
          // readable copy is the reason, not a model-call failure.
          return { verdict: 'failed', replies: [], detail: error.readable };
        }
        const message = error instanceof Error ? error.message : String(error);
        return {
          verdict: 'failed',
          replies: [],
          detail: failureReason(db, message, available.credential),
        };
      }
    },
  };
}

function failureReason(db: Database.Database, message: string, secret: string): string {
  return tFromDb(db, 'provider.call.failed', { message: maskSecret(message, secret) });
}

/**
 * The structured facts a round's dedicated tools stated, as the seam's existing
 * `RoundResult` fields (D11). `ToolFacts` carries exactly the names and types of
 * the `RoundResult` fields it feeds, so the spread is the whole mapping: a fact
 * the round did not state stays absent, not empty — `taskTransferMemberId` only
 * travels with the `transfer_task` action that names it, and an absent
 * `sopVerdict` still means "the verifier answered no protocol", which is what
 * fails a SOP run.
 */
function structuredFields(
  facts: ToolFacts,
): Pick<RoundResult, 'sopVerdict' | 'taskAction' | 'taskTransferMemberId'> {
  return { ...facts };
}

/**
 * One round's model text, whether the iteration cap stopped it and the facts its
 * dedicated tools stated (D11), through the round-level tool loop: the loop's
 * final turn is the round's answer. Each provider line supplies its own
 * conversation, i.e. its own tool-definition, response and result shapes. The
 * loop is bounded by the Agent's `max_iterations`; a round whose tool set is
 * empty never reaches the bound.
 */
async function callModel(
  db: Database.Database,
  doFetch: typeof fetch,
  available: ProviderAvailability,
  input: RoundInput,
  timeoutMs: number,
): Promise<ToolLoopOutcome> {
  // The round's own availability calculation decides the tool set (D2); an
  // empty list means the request carries no tool definitions at all, and the
  // round stays the single completion it always was. Computed once: the
  // conversation serializes this list and the executor runs against it.
  const tools = roundToolSpecs(input);
  // The same one entry point every other backend string uses, so a tool result
  // never renders its copy by a second route.
  const copy: ToolCopy = (key, values) => tFromDb(db, key, values);
  const common = {
    fetch: doFetch,
    baseUrl: available.baseUrl,
    credential: available.credential,
    model: available.model,
    system: input.systemPrompt,
    user: userMessage(input),
    tools,
  };
  const conversation: ToolConversation =
    available.provider === 'anthropic'
      ? createAnthropicConversation(common)
      : createOpenAiConversation(common);
  return await runToolLoop(conversation, createRoundToolExecutor(input, tools, copy), {
    timeoutMs,
    maxIterations: input.maxIterations,
  });
}
