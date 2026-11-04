import { maskSecret } from './providers.js';
import type { AssistantTurn, ToolCall, ToolCallResult, ToolConversation } from './tool-loop.js';
import { toolInputSchema, type RoundToolSpec } from './tool-specs.js';

/**
 * The OpenAI-compatible half of the 轮内工具循环's conversation (D3 / D5): it
 * owns `/chat/completions`'s own shapes, so the loop never assembles provider
 * JSON.
 *
 * The `tools` array carries the round's tool definitions as
 * `function.parameters`; a response is read for `choices[0].message.content`
 * and its `tool_calls[].function.{name,arguments}`; the next request continues
 * the same conversation with the assistant message echoed back and one
 * `role: "tool"` message per call under the same `tool_call_id`. This wire
 * shape has no `is_error` field, so a failed call states its stable code in the
 * result's own content. A round with no tools sends no `tools` key at all and
 * exactly the system + user messages it always sent, which is the single
 * completion it always was.
 *
 * The credential travels only in the request header; a provider error body is
 * masked before it becomes a readable reason.
 */

/** One conversation message; the assistant half echoes the response message. */
type OpenAiMessage = Record<string, unknown>;

export interface OpenAiConversationOptions {
  fetch: typeof fetch;
  baseUrl: string;
  /** The credential the request carries; never logged, never rendered. */
  credential: string;
  model: string;
  system: string;
  /** The round's first user message: every message the round read. */
  user: string;
  tools: readonly RoundToolSpec[];
}

export function createOpenAiConversation(options: OpenAiConversationOptions): ToolConversation {
  const messages: OpenAiMessage[] = [
    { role: 'system', content: options.system },
    { role: 'user', content: options.user },
  ];
  // The assistant message of the turn just read, echoed back as the assistant
  // turn when the tool results are appended.
  let assistantMessage: OpenAiMessage = { role: 'assistant' };

  return {
    async send(timeoutMs: number): Promise<AssistantTurn> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await options.fetch(`${options.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.credential}`,
          },
          body: JSON.stringify({
            model: options.model,
            messages,
            ...(options.tools.length === 0
              ? {}
              : { tools: options.tools.map(toolDefinition) }),
          }),
          signal: controller.signal,
        }).catch((error: unknown) => {
          // The single call's own timeout is a provider-chain failure (D9):
          // name it, so the round reason says "timed out" rather than the
          // platform's bare abort wording.
          if (controller.signal.aborted) {
            throw new Error(`openai request timed out after ${timeoutMs}ms`);
          }
          throw error;
        });
        if (!response.ok) {
          // Mask before truncating: a 500-character cut could otherwise leave an
          // unmasked prefix of the credential in the reason.
          const body = await response.text().catch(() => '');
          const masked = maskSecret(body, options.credential);
          throw new Error(
            `openai responded ${response.status}${masked.length > 0 ? `: ${masked.slice(0, 500)}` : ''}`,
          );
        }
        const payload: unknown = await response.json();
        const turn = readTurn(payload);
        assistantMessage = turn.message;
        return turn.turn;
      } finally {
        clearTimeout(timer);
      }
    },
    appendToolResults(results: readonly ToolCallResult[]): void {
      messages.push(assistantMessage);
      for (const result of results) {
        messages.push({ role: 'tool', tool_call_id: result.id, content: result.content });
      }
    },
  };
}

/** One tool definition: the internal spec as OpenAI's `tools[]` entry. */
function toolDefinition(spec: RoundToolSpec): Record<string, unknown> {
  return {
    type: 'function',
    function: {
      name: spec.name,
      description: spec.description,
      parameters: toolInputSchema(spec),
    },
  };
}

/**
 * Read one response into a turn and the assistant message to echo back. A
 * response without a readable turn — no `choices`, no message, or neither
 * tool calls nor text — is unparseable, which is a provider failure.
 */
function readTurn(payload: unknown): { turn: AssistantTurn; message: OpenAiMessage } {
  const choices = isRecord(payload) ? payload['choices'] : undefined;
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error('openai response carried no choices array');
  }
  const first = choices[0];
  const message = isRecord(first) ? first['message'] : undefined;
  if (!isRecord(message)) {
    throw new Error('openai response carried no message');
  }
  const rawCalls = message['tool_calls'];
  const calls = Array.isArray(rawCalls) ? rawCalls.filter(isRecord).map(readCall) : [];
  const content = message['content'];
  if (calls.length > 0) {
    // The narration of a turn that asked for tools is not the round's answer,
    // but a round stopped by the iteration cap lands it as the partial
    // conclusion (D7 / D8), so the turn carries it too.
    return {
      turn: {
        kind: 'calls',
        calls,
        text: typeof content === 'string' ? content : '',
      },
      // Echo only the three fields this shape's next request needs: a
      // compatible endpoint may have added its own to the answer.
      message: { role: 'assistant', content: message['content'] ?? null, tool_calls: rawCalls },
    };
  }
  if (typeof content !== 'string') {
    throw new Error('openai response carried no message content');
  }
  return {
    turn: { kind: 'text', text: content },
    message: { role: 'assistant', content },
  };
}

function readCall(call: Record<string, unknown>): ToolCall {
  const fn = isRecord(call['function']) ? call['function'] : {};
  const raw = fn['arguments'];
  // `arguments` is a JSON string on this wire shape. A string this adapter
  // cannot parse is handed on unchanged, so the tool's shape check refuses it
  // as an `invalid-arguments` result the model can correct — never a round
  // failure.
  let input: ToolCall['input'] = raw;
  if (typeof raw === 'string') {
    try {
      input = JSON.parse(raw) as ToolCall['input'];
    } catch {
      input = raw;
    }
  }
  return { id: String(call['id']), name: String(fn['name']), input };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
