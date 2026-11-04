import type { RoundInput } from './agent-seam.js';
import { checkToolArguments, capToolResultContent, roundToolFaces, roundToolSpecs } from './tool-specs.js';

/**
 * 轮内工具循环 (round-level tool loop, D1 / D7): inside one
 * `RoundProvider.runRound` call, keep asking the model until the turn requests
 * no tool, and hand back the text of that last turn.
 *
 * The loop knows nothing about a provider's wire shape. Everything
 * provider-specific — serializing the tool definitions, reading assistant text
 * and tool calls out of a response, appending the results back in the
 * provider's own result shape — sits behind `ToolConversation`, so a second
 * provider is a second implementation of that interface and never a change
 * here.
 *
 * Two disciplines shape it. First, only the final text is the round's answer:
 * whatever the model said before a tool call is discarded, and an empty final
 * text falls through to the adapter's existing empty-completion rule. Second, a
 * tool's own failure is a result the model reads and reacts to; only a provider
 * failure throws, which is what closes the round as failed.
 */

/** One tool call a model turn asked for. */
export interface ToolCall {
  /** The provider's call id; the result must answer under the same id. */
  id: string;
  /** The product's tool name (`Read` today). */
  name: string;
  /** The model's arguments, unvalidated. */
  input: unknown;
}

/**
 * One assistant turn as the conversation adapter read it: either the text that
 * ends the round, or the tool calls the round has to run first. A turn that asks
 * for tools still carries the text it said alongside them: it is not an answer,
 * but it is the partial conclusion a round that hits the iteration cap lands.
 */
export type AssistantTurn =
  | { kind: 'text'; text: string }
  | { kind: 'calls'; calls: readonly ToolCall[]; text: string };

/** One tool call's answer, in the provider's own result shape's terms. */
export interface ToolCallResult {
  /** The provider's call id this result answers. */
  id: string;
  ok: boolean;
  /** The stable tool error code; present exactly on a failed call. */
  error?: string;
  /** The text the model receives. */
  content: string;
}

/**
 * The provider-shaped half of the loop. The adapter owns the conversation it
 * sends, so the loop never assembles provider JSON.
 */
export interface ToolConversation {
  /** Send the conversation as it stands, bounded by one call's timeout. */
  send(timeoutMs: number): Promise<AssistantTurn>;
  /**
   * Append the assistant turn just read plus one result per call, in call
   * order, so the next `send` continues the same conversation.
   */
  appendToolResults(results: readonly ToolCallResult[]): void;
}

/** Run one tool call against the round's faces. Never throws for a tool failure. */
export type ToolExecutor = (call: ToolCall) => Promise<ToolCallResult>;

/** What the loop concluded: the round's one candidate reply. */
export interface ToolLoopOutcome {
  /**
   * The final turn's text; empty when the model stopped without saying anything.
   * A round that hits the iteration cap lands the text of the turn that asked
   * for the batch there was no budget left to run — its partial conclusion.
   */
  text: string;
  /**
   * `true` when the cap stopped the loop: the model asked for one more tool
   * batch than the round's `maxIterations` allowed, and that batch was **not**
   * executed.
   */
  exhausted: boolean;
}
/**
 * The round's tool executor: the batch's tool specs the round actually offers,
 * the faces they run against, and the argument shape check in front of them. A
 * call for a tool this round does not offer, or with arguments the tool's shape
 * refuses, never reaches the face.
 */
export function createRoundToolExecutor(input: RoundInput): ToolExecutor {
  const specs = roundToolSpecs(input);
  const faces = roundToolFaces(input);
  return async (call) => {
    const spec = specs.find((candidate) => candidate.name === call.name);
    if (spec === undefined) {
      // A tool this round does not offer at all.
      return failure(call, 'unknown-tool', `this round does not offer the tool: ${call.name}`);
    }
    const checked = checkToolArguments(spec, call.input);
    if (!checked.ok) {
      return failure(call, 'invalid-arguments', checked.message);
    }
    const outcome = await spec.execute(checked.values, faces);
    if (outcome === null) {
      // Offered but faceless: `available` already rules it out, and a stable
      // result is still better than an exception the round would die of.
      return failure(call, 'unknown-tool', `this round has no face for the tool: ${call.name}`);
    }
    return {
      id: call.id,
      ok: outcome.ok,
      error: outcome.error,
      // Only the copy the model reads is capped (D6); the tool's own result is
      // untouched, and a capped result still carries its state and request.
      content: capToolResultContent(outcome.content),
    };
  };
}

/**
 * Run the round's model ↔ tool round trips, bounded by the round's iteration
 * cap (迭代上限, D8). The loop stops either because the model answered without
 * requesting a tool, or because the budget ran out; a provider failure
 * (network, timeout, unparseable response) throws out of `send` and is the
 * round adapter's existing failure path, while no tool failure reaches here as
 * an exception.
 *
 * The cap counts 一次往返 — one batch: the model asks for tools and this round
 * runs that batch. `maxIterations = 1` therefore runs exactly one batch, `= 2`
 * runs two. The budget is only spent by a batch that actually runs, so the
 * model is told the budget is out exactly when it asks for a batch with none
 * left: that batch is **not** executed and its turn's text becomes the round's
 * partial conclusion. A round whose model never asks for a tool never touches
 * the cap.
 */
export async function runToolLoop(
  conversation: ToolConversation,
  execute: ToolExecutor,
  options: { timeoutMs: number; maxIterations: number },
): Promise<ToolLoopOutcome> {
  let batches = 0;
  for (;;) {
    const turn = await conversation.send(options.timeoutMs);
    if (turn.kind === 'text') {
      return { text: turn.text, exhausted: false };
    }
    if (batches >= options.maxIterations) {
      return { text: turn.text, exhausted: true };
    }
    batches += 1;
    const results: ToolCallResult[] = [];
    for (const call of turn.calls) {
      results.push(await execute(call));
    }
    conversation.appendToolResults(results);
  }
}

/** A failed call in the text shape the model reads, keeping its stable code. */
function failure(call: ToolCall, code: string, message: string): ToolCallResult {
  return {
    id: call.id,
    ok: false,
    error: code,
    content: `[${call.name}] error: ${code}\nmessage: ${message}`,
  };
}
