import type { RoundFileToolResult, RoundFileTools, RoundInput } from './agent-seam.js';

/**
 * 轮内工具规格 (D2 / D3): one internal description per tool the round's model
 * may call, serialized to each provider's own tool definition and used by the
 * loop to check the model's arguments.
 *
 * A tool name is the product's name, not a provider's: `Read` is the same word
 * as `permission_rule.tool_name`, the approval payload and the file tool the
 * round's own face exposes. The offered set is the round's availability
 * calculation (`RoundInput.tools`) intersected with this batch's tools, so a
 * round that has no file face is offered no file tool.
 *
 * This ticket ships `Read` only (#57); the rest of the first batch arrives with
 * #59. A name without a spec here is not offered, even when `RoundInput.tools`
 * lists it.
 */

/** One argument a tool accepts, in the order the model sees it. */
export interface ToolArgument {
  name: string;
  description: string;
  required: boolean;
}

/** The round faces a tool executes against; this batch reads files only. */
export interface RoundToolFaces {
  files: RoundFileTools;
}

/**
 * One tool call's outcome, already shaped into the text the model receives:
 * a structured summary plus the body a read actually needs, never a JSON dump.
 * A failure keeps its stable code (`outside-root`, `not-found`, `denied`, …) so
 * the model can tell "the path left the root" from "the file is missing".
 */
export interface ToolCallOutcome {
  ok: boolean;
  error?: string;
  content: string;
}

/** One tool as this round may offer it. */
export interface RoundToolSpec {
  name: string;
  description: string;
  arguments: readonly ToolArgument[];
  /**
   * Whether this round has the face the tool runs against (D2). `Read` needs
   * the project file face: no project root means no file tool at all.
   */
  available(input: RoundInput): boolean;
  execute(input: Readonly<Record<string, string>>, faces: RoundToolFaces): Promise<ToolCallOutcome>;
}

const READ: RoundToolSpec = {
  name: 'Read',
  description:
    "Read one UTF-8 text file this round's member may read. `path` is relative to the project " +
    "root, or an absolute path inside one of the readable roots: the project root and the " +
    "member's own read-only skills directory. A path outside those roots, a missing file or an " +
    'unreadable file comes back as an error result; none of them ends the round.',
  arguments: [{ name: 'path', description: 'The file to read.', required: true }],
  available: (input) => input.workspace !== null,
  async execute(input, faces) {
    // The shape check proved the required argument present.
    const requested = input['path']!;
    return shapeRead(requested, await faces.files.Read({ path: requested }));
  },
};

/** The tools this batch puts in the loop, in the order the model sees them. */
const BATCH_TOOLS: readonly RoundToolSpec[] = [READ];

/**
 * The tool specs this round's model may call: the batch's tools in the round's
 * own availability order. An empty list is the ordinary rootless round, and its
 * provider request carries no tool definitions at all.
 */
export function roundToolSpecs(input: RoundInput): RoundToolSpec[] {
  return BATCH_TOOLS.filter((spec) => input.tools.includes(spec.name) && spec.available(input));
}

/** The round's tool faces; `null` when the round has no workspace at all. */
export function roundToolFaces(input: RoundInput): RoundToolFaces | null {
  return input.workspace === null ? null : { files: input.workspace.files };
}

/**
 * The tool's parameter schema, as both providers express a JSON-schema object
 * (Anthropic `input_schema`, OpenAI-compatible `function.parameters`).
 */
export function toolInputSchema(spec: RoundToolSpec): Record<string, unknown> {
  return {
    type: 'object',
    properties: Object.fromEntries(
      spec.arguments.map((argument) => [
        argument.name,
        { type: 'string', description: argument.description },
      ]),
    ),
    required: spec.arguments.filter((argument) => argument.required).map((argument) => argument.name),
    additionalProperties: false,
  };
}

/** The argument shape check's answer: the values the face accepts, or why not. */
export type ToolArgumentCheck =
  | { ok: true; values: Readonly<Record<string, string>> }
  | { ok: false; message: string };

/**
 * Check the model's arguments against the tool's declared shape (D4) before the
 * face runs: a missing required argument, a wrong type and an extra argument are
 * all refusals the model receives as a tool result, never a round error.
 */
export function checkToolArguments(spec: RoundToolSpec, input: unknown): ToolArgumentCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'arguments must be a JSON object' };
  }
  const supplied = input as Record<string, unknown>;
  const values: Record<string, string> = {};
  for (const argument of spec.arguments) {
    const value = supplied[argument.name];
    if (value === undefined) {
      if (argument.required) {
        return { ok: false, message: `missing required argument: ${argument.name}` };
      }
      continue;
    }
    if (typeof value !== 'string') {
      return { ok: false, message: `argument ${argument.name} must be a string` };
    }
    values[argument.name] = value;
  }
  for (const name of Object.keys(supplied)) {
    if (!spec.arguments.some((argument) => argument.name === name)) {
      return { ok: false, message: `unexpected argument: ${name}` };
    }
  }
  return { ok: true, values };
}

/** One `Read` result as the model reads it: summary first, body after it. */
function shapeRead(requested: string, result: RoundFileToolResult): ToolCallOutcome {
  if (!result.ok) {
    // `io-error` is the file face's own catch-all code, so a failed result that
    // somehow carries none still reports a code the model can act on.
    const code = result.error ?? 'io-error';
    const lines = [`[Read] error: ${code}`, `path: ${requested}`];
    if (result.message !== undefined) {
      lines.push(`message: ${result.message}`);
    }
    return { ok: false, error: code, content: lines.join('\n') };
  }
  const lines = ['[Read] ok', `path: ${result.path ?? requested}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.bytes !== undefined) {
    lines.push(`bytes: ${result.bytes}`);
  }
  lines.push('content:', result.content ?? '');
  return { ok: true, content: lines.join('\n') };
}
