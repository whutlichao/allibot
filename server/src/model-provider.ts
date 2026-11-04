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
import { createAnthropicConversation } from './tool-conversation-anthropic.js';
import { createRoundToolExecutor, runToolLoop } from './tool-loop.js';
import { roundToolSpecs } from './tool-specs.js';

/**
 * The real provider adapters (D4.1): a round-level tool loop for Anthropic and
 * a minimal chat completion for OpenAI-compatible endpoints (#58 brings that
 * line the same loop), behind the same `RoundProvider` interface the scripted
 * double implements.
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
export interface ProviderAvailability {
  provider: AgentProvider;
  model: string;
  /** The credential the request carries; never logged, never rendered. */
  credential: string;
  baseUrl: string;
}

export type AvailabilityResult =
  | { ok: true; available: ProviderAvailability }
  | { ok: false; reason: string };

/**
 * Resolve whether this round may call the provider at all. The refusals are
 * deliberately different words — no model, unconfirmed remote provider, missing
 * credential — each with its own readable copy, and none opens a socket.
 */
export function resolveAvailability(
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
        const text = await callModel(doFetch, available, input, timeoutMs);
        if (text.trim().length === 0) {
          return {
            verdict: 'failed',
            replies: [],
            detail: failureReason(db, 'empty completion', available.credential),
          };
        }
        return { verdict: 'replied', replies: [text] };
      } catch (error) {
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
 * One round's model text. The Anthropic line runs the round-level tool loop:
 * the loop's final turn is the round's answer. The OpenAI-compatible line is
 * still the single completion it always was (#58 brings it the same loop).
 */
async function callModel(
  doFetch: typeof fetch,
  available: ProviderAvailability,
  input: RoundInput,
  timeoutMs: number,
): Promise<string> {
  if (available.provider === 'anthropic') {
    const conversation = createAnthropicConversation({
      fetch: doFetch,
      baseUrl: available.baseUrl,
      credential: available.credential,
      model: available.model,
      system: input.systemPrompt,
      user: userMessage(input),
      // The round's own availability calculation decides the tool set (D2); an
      // empty list means the request carries no tool definitions at all.
      tools: roundToolSpecs(input),
    });
    return await runToolLoop(conversation, createRoundToolExecutor(input), { timeoutMs });
  }
  return await callProvider(doFetch, available, input.systemPrompt, userMessage(input), timeoutMs);
}

/**
 * One minimal chat completion: a system prompt and one user message in, a text
 * answer out.
 */
async function callProvider(
  doFetch: typeof fetch,
  available: ProviderAvailability,
  system: string,
  user: string,
  timeoutMs: number,
): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await doFetch(`${available.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${available.credential}`,
      },
      body: JSON.stringify({
        model: available.model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      // Mask before truncating: a 500-character cut could otherwise leave an
      // unmasked prefix of the credential in the reason.
      const body = await response.text().catch(() => '');
      const masked = maskSecret(body, available.credential);
      throw new Error(
        `${available.provider} responded ${response.status}${masked.length > 0 ? `: ${masked.slice(0, 500)}` : ''}`,
      );
    }
    const payload: unknown = await response.json();
    return readOpenAiText(payload);
  } finally {
    clearTimeout(timer);
  }
}

function readOpenAiText(payload: unknown): string {
  const choices = isRecord(payload) ? payload['choices'] : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('openai response carried no choices array');
  }
  const message = isRecord(choices[0]) ? choices[0]['message'] : undefined;
  const content = isRecord(message) ? message['content'] : undefined;
  if (typeof content !== 'string') {
    throw new Error('openai response carried no message content');
  }
  return content;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
