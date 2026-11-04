import type { AssistantTurn, ToolCall, ToolCallResult, ToolConversation } from './tool-loop.js';
import { isRecord, postJson } from './tool-conversation-http.js';
import { toolInputSchema, type RoundToolSpec } from './tool-specs.js';

/**
 * The Anthropic half of the 轮内工具循环's conversation (D3 / D5): it owns
 * `/v1/messages`'s own shapes, so the loop never assembles provider JSON.
 *
 * The `tools` array carries the round's tool definitions as `input_schema`; a
 * response is read for its text blocks and its `tool_use` blocks; the next
 * request continues the same conversation with the assistant turn echoed back
 * verbatim and one `tool_result` block per call under the same `tool_use` id,
 * `is_error` stating a failed call. A round with no tools sends no `tools` key
 * at all, which is exactly the single completion it always was.
 *
 * The credential travels only in the request header; a provider error body is
 * masked before it becomes a readable reason. Both belong to `postJson`, shared
 * with the OpenAI line, so the timeout and the masking cannot drift apart.
 */

const ANTHROPIC_VERSION = '2023-06-01';
const MAX_TOKENS = 1024;

/** One conversation message; the assistant half echoes the response blocks verbatim. */
interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | readonly Record<string, unknown>[];
}

export interface AnthropicConversationOptions {
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

export function createAnthropicConversation(
  options: AnthropicConversationOptions,
): ToolConversation {
  const messages: AnthropicMessage[] = [{ role: 'user', content: options.user }];
  // The assistant blocks of the turn just read, echoed back as the assistant
  // message when the tool results are appended.
  let assistantContent: readonly Record<string, unknown>[] = [];

  return {
    async send(timeoutMs: number): Promise<AssistantTurn> {
      const payload = await postJson({
        fetch: options.fetch,
        baseUrl: options.baseUrl,
        path: '/v1/messages',
        headers: {
          'content-type': 'application/json',
          'x-api-key': options.credential,
          'anthropic-version': ANTHROPIC_VERSION,
        },
        body: {
          model: options.model,
          max_tokens: MAX_TOKENS,
          system: options.system,
          messages,
          ...(options.tools.length === 0 ? {} : { tools: options.tools.map(toolDefinition) }),
        },
        credential: options.credential,
        timeoutMs,
        provider: 'anthropic',
      });
      const turn = readTurn(payload);
      assistantContent = turn.content;
      return turn.turn;
    },
    appendToolResults(results: readonly ToolCallResult[]): void {
      messages.push({ role: 'assistant', content: assistantContent });
      messages.push({
        role: 'user',
        content: results.map((result) => ({
          type: 'tool_result',
          tool_use_id: result.id,
          content: result.content,
          is_error: !result.ok,
        })),
      });
    },
  };
}

/** One tool definition: the internal spec as Anthropic's `tools[]` entry. */
function toolDefinition(spec: RoundToolSpec): Record<string, unknown> {
  return { name: spec.name, description: spec.description, input_schema: toolInputSchema(spec) };
}

/**
 * Read one response into a turn and the assistant blocks to echo back. A
 * response without a content array is unparseable, which is a provider failure.
 */
function readTurn(payload: unknown): {
  turn: AssistantTurn;
  content: readonly Record<string, unknown>[];
} {
  const content = isRecord(payload) ? payload['content'] : undefined;
  if (!Array.isArray(content)) {
    throw new Error('anthropic response carried no content array');
  }
  const blocks = content.filter(isRecord);
  const calls: ToolCall[] = blocks
    .filter((block) => block['type'] === 'tool_use')
    .map((block) => ({
      id: String(block['id']),
      name: String(block['name']),
      input: block['input'] ?? {},
    }));
  if (calls.length > 0) {
    // The narration of a turn that asked for tools is not the round's answer; it
    // travels with the turn because a round that hits the iteration cap lands it
    // as the partial conclusion (D7 / D8).
    return { turn: { kind: 'calls', calls, text: readText(blocks) }, content: blocks };
  }
  return { turn: { kind: 'text', text: readText(blocks) }, content: blocks };
}

/** The assistant text blocks of one response, joined in block order. */
function readText(blocks: readonly Record<string, unknown>[]): string {
  return blocks
    .map((block) => (block['type'] === 'text' && typeof block['text'] === 'string' ? block['text'] : ''))
    .join('');
}
