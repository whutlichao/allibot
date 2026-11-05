import type { RecordedReply } from './support.ts';

/**
 * The two provider wire shapes, as one matrix (spec US25): a tool call
 * requested, a text answer shaped, a no-text turn shaped, and the recorded
 * request read back. Every round-level tool loop case runs both rows against
 * the same replies and the same assertions, so a parsing fix on one side cannot
 * silently diverge from the other.
 *
 * This module holds the matrix and nothing else. Each `*-http` test keeps its
 * own fixture, its own `openRound` / `queueReplies` and its own assertions — the
 * repository's standard for these tests — and imports the rows from here.
 */

/** The sentinel credential every row's env carries. */
export const PROVIDER_KEY = 'sk-tool-loop-0123456789abcdefghij-wxyz';

/** One tool call a provider turn asks the round to run. */
export interface ToolCallShape {
  id: string;
  name: string;
  input: unknown;
}

/** One tool definition a recorded request carried, normalized across providers. */
export interface ToolDefinitionShape {
  name: string;
  description: string;
  /** The parameter schema, as the provider serialized it. */
  schema: Record<string, unknown>;
}

/** One tool result a recorded request fed back, normalized across providers. */
export interface ToolResultShape {
  /** The provider's call id the result answers. */
  id: string;
  content: string;
  isError: boolean;
}

/**
 * One provider's wire shape: how a tool call is requested, how a text answer is
 * shaped, and how the recorded request is read back. Nothing here reaches into
 * the adapter; the row exists so a second provider is a second row.
 */
export interface ProviderRow {
  label: 'anthropic' | 'openai';
  /** The `provider:model` the Agent is configured with. */
  model: string;
  /** The consent route segment, i.e. the provider the adapter reads. */
  provider: 'anthropic' | 'openai';
  /** The env that points this provider's adapter at the recording endpoint. */
  env: (baseUrl: string) => NodeJS.ProcessEnv;
  /** The path the adapter posts to. */
  path: string;
  /** One assistant turn that requests the given tool calls. */
  toolCalls: (calls: readonly ToolCallShape[], narration?: string) => RecordedReply;
  /** One assistant turn that carries text and asks for nothing. */
  text: (body: string) => RecordedReply;
  /** One assistant turn that carries no text at all: the empty completion. */
  emptyText: () => RecordedReply;
  /** The tool definitions the recorded request carried. */
  toolDefinitions: (payload: Record<string, unknown>) => ToolDefinitionShape[];
  /** The tool results the recorded request fed back. */
  toolResults: (payload: Record<string, unknown>) => ToolResultShape[];
  /** The assistant tool-call ids the recorded request echoed back. */
  echoedToolCalls: (payload: Record<string, unknown>) => string[];
  /**
   * A 200 answer that carries no readable turn: an assistant message this
   * provider's wire shape cannot read as either text or tool calls.
   */
  unparseable: () => RecordedReply;
  /**
   * The request body's keys for a round with no tool available, sorted: the
   * single completion the adapter always sent, and nothing added by the loop.
   */
  singleCompletionKeys: readonly string[];
}

export function messagesOf(payload: Record<string, unknown>): Record<string, unknown>[] {
  const messages = payload['messages'];
  return Array.isArray(messages) ? (messages as Record<string, unknown>[]) : [];
}

export function blocksOf(message: Record<string, unknown>): Record<string, unknown>[] {
  const content = message['content'];
  return Array.isArray(content) ? (content as Record<string, unknown>[]) : [];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

const ANTHROPIC: ProviderRow = {
  label: 'anthropic',
  model: 'anthropic:claude-sonnet-4-5',
  provider: 'anthropic',
  env: (baseUrl) => ({ ANTHROPIC_API_KEY: PROVIDER_KEY, ANTHROPIC_BASE_URL: baseUrl }),
  path: '/v1/messages',
  toolCalls: (calls, narration) => ({
    status: 200,
    body: {
      content: [
        ...(narration === undefined ? [] : [{ type: 'text', text: narration }]),
        ...calls.map((call) => ({
          type: 'tool_use',
          id: call.id,
          name: call.name,
          input: call.input,
        })),
      ],
    },
  }),
  text: (body) => ({ status: 200, body: { content: [{ type: 'text', text: body }] } }),
  emptyText: () => ({ status: 200, body: { content: [{ type: 'text', text: '' }] } }),
  toolDefinitions: (payload) => {
    const tools = payload['tools'];
    if (!Array.isArray(tools)) {
      return [];
    }
    return (tools as Record<string, unknown>[]).map((tool) => ({
      name: String(tool['name']),
      description: String(tool['description'] ?? ''),
      schema: (tool['input_schema'] ?? {}) as Record<string, unknown>,
    }));
  },
  toolResults: (payload) => {
    const results: ToolResultShape[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'user') {
        continue;
      }
      for (const block of blocksOf(message)) {
        if (block['type'] !== 'tool_result') {
          continue;
        }
        results.push({
          id: String(block['tool_use_id']),
          content:
            typeof block['content'] === 'string'
              ? block['content']
              : JSON.stringify(block['content']),
          isError: block['is_error'] === true,
        });
      }
    }
    return results;
  },
  echoedToolCalls: (payload) => {
    const ids: string[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'assistant') {
        continue;
      }
      for (const block of blocksOf(message)) {
        if (block['type'] === 'tool_use') {
          ids.push(String(block['id']));
        }
      }
    }
    return ids;
  },
  unparseable: () => ({ status: 200, body: { content: 'not-a-block-array' } }),
  singleCompletionKeys: ['max_tokens', 'messages', 'model', 'system'],
};

/**
 * The OpenAI-compatible wire shape: `tools[].function.parameters` out,
 * `choices[0].message.{content,tool_calls}` in, `role: "tool"` results back.
 *
 * OpenAI carries no `is_error` flag, so a failed call states its stable error
 * code on the result's first line (`[Read] error: outside-root`); that first
 * line is what this row reads back as the result being an error.
 */
const OPENAI: ProviderRow = {
  label: 'openai',
  model: 'openai:gpt-5',
  provider: 'openai',
  env: (baseUrl) => ({ OPENAI_API_KEY: PROVIDER_KEY, OPENAI_BASE_URL: baseUrl }),
  path: '/chat/completions',
  toolCalls: (calls, narration) => ({
    status: 200,
    body: {
      choices: [
        {
          message: {
            role: 'assistant',
            content: narration ?? null,
            tool_calls: calls.map((call) => ({
              id: call.id,
              type: 'function',
              function: { name: call.name, arguments: JSON.stringify(call.input) },
            })),
          },
        },
      ],
    },
  }),
  text: (body) => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: body } }] },
  }),
  emptyText: () => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: '' } }] },
  }),
  toolDefinitions: (payload) => {
    const tools = payload['tools'];
    if (!Array.isArray(tools)) {
      return [];
    }
    return (tools as Record<string, unknown>[]).map((tool) => {
      const fn = isRecord(tool['function']) ? tool['function'] : {};
      return {
        name: String(fn['name']),
        description: String(fn['description'] ?? ''),
        schema: (fn['parameters'] ?? {}) as Record<string, unknown>,
      };
    });
  },
  toolResults: (payload) => {
    const results: ToolResultShape[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'tool') {
        continue;
      }
      const content =
        typeof message['content'] === 'string'
          ? message['content']
          : JSON.stringify(message['content']);
      results.push({
        id: String(message['tool_call_id']),
        content,
        isError: /^\[[^\]]+\] error: /.test(content),
      });
    }
    return results;
  },
  echoedToolCalls: (payload) => {
    const ids: string[] = [];
    for (const message of messagesOf(payload)) {
      if (message['role'] !== 'assistant' || !Array.isArray(message['tool_calls'])) {
        continue;
      }
      for (const call of message['tool_calls'] as Record<string, unknown>[]) {
        ids.push(String(call['id']));
      }
    }
    return ids;
  },
  unparseable: () => ({
    status: 200,
    body: { choices: [{ message: { role: 'assistant', content: null } }] },
  }),
  singleCompletionKeys: ['messages', 'model'],
};

/** Both rows run the same cases; this list is the matrix's only source. */
export const PROVIDER_ROWS: readonly ProviderRow[] = [ANTHROPIC, OPENAI];
