import type { MessageKey, MessageValues, PlanTaskView } from '@allibot/shared';
import type {
  GlobFileRequest,
  GrepFileRequest,
  RoundFileToolResult,
  RoundFileTools,
  RoundInput,
  RoundPlanFace,
} from './agent-seam.js';
import { MAX_GREP_FILES } from './docker-files.js';
import { classifyToolName } from './permissions.js';
import { MAX_GREP_MATCHES } from './workspace-files.js';

/**
 * The backend's one natural-language renderer, injected by the caller that
 * holds the database: every word a tool result adds renders through `tFromDb`,
 * so the language preference is still read in exactly one place.
 */
export type ToolCopy = (key: MessageKey, values?: MessageValues) => string;

/**
 * The re-feed cap (D6): the most characters one tool result may feed back to
 * the model. A constant, not a schema field and not a per-Agent setting; the
 * file tools themselves are unchanged — only the copy the model sees is cut.
 */
export const MAX_TOOL_RESULT_CHARS = 20000;

/**
 * Cut one tool result down to the re-feed cap, keeping the head and naming the
 * scale that is missing: the model must see that what it read is not all of it.
 * A result already within the cap is returned untouched.
 */
export function capToolResultContent(content: string, t: ToolCopy): string {
  if (content.length <= MAX_TOOL_RESULT_CHARS) {
    return content;
  }
  const kept = content.slice(0, MAX_TOOL_RESULT_CHARS);
  return `${kept}\n${t('tool.result.truncated', {
    given: kept.length,
    total: content.length,
  })}`;
}

/**
 * 轮内工具规格 (D2 / D3): one internal description per tool the round's model
 * may call, serialized to each provider's own tool definition and used by the
 * loop to check the model's arguments.
 *
 * A tool name is the product's name, not a provider's: `Read` is the same word
 * as `permission_rule.tool_name`, the approval payload and the file tool the
 * round's own face exposes, and `TaskList` is the same word as the Plan face's
 * method. The offered set is this batch's scope — the `read` class plus the
 * read-only `internal` tools — intersected with the round's availability
 * calculation (`RoundInput.tools`), so a round that has no file face is offered
 * no file tool and a round with no Plan face is offered no Plan tool — those
 * names are absent from the provider request, not refused at call time.
 *
 * This is the first batch (#59): the read-only tools `Read` / `Glob` / `Grep`
 * over the round's file face and `TaskList` / `TaskGet` over its Plan face. The
 * write, execution and orchestration tools arrive with later batches; a name
 * without a spec here is not offered, even when `RoundInput.tools` lists it.
 */

/** One argument a tool accepts, in the order the model sees it. */
export interface ToolArgument {
  name: string;
  description: string;
  required: boolean;
}

/**
 * The round faces a tool executes against — guaranteed present. A spec whose
 * `available` held has the face it needs, so the accessors answer with it and
 * state a missing one as the registry bug it would be: no spec and no loop
 * branch has to handle "offered but faceless".
 *
 * `copy` is the backend's one natural-language renderer, injected rather than
 * imported so this module never reads the language preference itself.
 */
export interface RoundToolContext {
  files(): RoundFileTools;
  plan(): RoundPlanFace;
  copy: ToolCopy;
}

/**
 * One tool call's answer, already shaped into the text the model receives: a
 * structured summary plus the body a read actually needs, never a JSON dump.
 * A failure states its stable code (`outside-root`, `not-found`, `denied`, …)
 * on its content's first line — the model is the one reader of that code, so
 * the answer carries no second, structured copy of it.
 */
export interface ToolAnswer {
  ok: boolean;
  content: string;
}

/** One tool as this round may offer it. */
export interface RoundToolSpec {
  name: string;
  description: string;
  arguments: readonly ToolArgument[];
  /**
   * Whether this round has the face the tool runs against (D2). `Read` / `Glob`
   * / `Grep` need the project file face, `TaskList` / `TaskGet` need the Plan
   * face: no face, no tool.
   */
  available(input: RoundInput): boolean;
  /**
   * Run one call whose arguments the shape check accepted. This spec's
   * `available` already held for this round, so the context carries the face.
   */
  execute(
    input: Readonly<Record<string, string>>,
    context: RoundToolContext,
  ): Promise<ToolAnswer>;
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
  async execute(input, context) {
    // The shape check proved the required argument present.
    const requested = input['path']!;
    return shapeRead(requested, await context.files().Read({ path: requested }));
  },
};

const GLOB: RoundToolSpec = {
  name: 'Glob',
  description:
    "List the files this round's member may read whose path matches a glob. `pattern` is a " +
    'root-relative pattern: `*` stays inside one path segment and `**` crosses directories. ' +
    "`path` is an optional directory to search from, inside the project root or the member's " +
    'read-only skills directory; it defaults to the project root. A path outside those roots, ' +
    'an invalid pattern or a base that is not a directory comes back as an error result.',
  arguments: [
    {
      name: 'pattern',
      description: 'The root-relative glob pattern to match file paths against.',
      required: true,
    },
    {
      name: 'path',
      description: 'The directory to search from; the project root by default.',
      required: false,
    },
  ],
  available: (input) => input.workspace !== null,
  async execute(input, context) {
    const pattern = input['pattern']!;
    const base = input['path'];
    const request: GlobFileRequest = { pattern, ...(base === undefined ? {} : { path: base }) };
    return shapeGlob(request, await context.files().Glob(request));
  },
};

const GREP: RoundToolSpec = {
  name: 'Grep',
  description:
    "Search the files this round's member may read for lines matching a regular expression, " +
    'and answer one `path:line: text` line per hit. `pattern` is a JavaScript regular ' +
    "expression source applied line by line. `path` is an optional file or directory to search, " +
    "inside the project root or the member's read-only skills directory; it defaults to the " +
    'project root. A path outside those roots or an invalid expression comes back as an error ' +
    'result.',
  arguments: [
    {
      name: 'pattern',
      description: 'The JavaScript regular expression source to match lines with.',
      required: true,
    },
    {
      name: 'path',
      description: 'The file or directory to search; the project root by default.',
      required: false,
    },
  ],
  available: (input) => input.workspace !== null,
  async execute(input, context) {
    const pattern = input['pattern']!;
    const base = input['path'];
    const request: GrepFileRequest = { pattern, ...(base === undefined ? {} : { path: base }) };
    return shapeGrep(request, await context.files().Grep(request), context.copy);
  },
};

const TASK_LIST: RoundToolSpec = {
  name: 'TaskList',
  description:
    "List the items of this round's own Plan run — the work list this member keeps in this " +
    "target — in append order, one `- [status] title (id)` line per item. It reads the current " +
    'run only; it creates and changes nothing.',
  arguments: [],
  available: (input) => input.plan !== null,
  async execute(_input, context) {
    return shapeTaskList(context.plan().TaskList());
  },
};

const TASK_GET: RoundToolSpec = {
  name: 'TaskGet',
  description:
    "Read one item of this round's own Plan run by id, with its title, status and position. An " +
    'id the current run does not hold comes back as a `not-found` error result; it never ends ' +
    'the round.',
  arguments: [{ name: 'id', description: 'The Plan item id.', required: true }],
  available: (input) => input.plan !== null,
  async execute(input, context) {
    const requested = input['id']!;
    return shapeTaskGet(requested, context.plan().TaskGet({ id: requested }));
  },
};

/** The tools this batch puts in the loop, in the order the model sees them. */
const BATCH_TOOLS: readonly RoundToolSpec[] = [READ, GLOB, GREP, TASK_LIST, TASK_GET];

/**
 * The `internal` tools this batch offers although their class is not `read`:
 * the two Plan tools that only read the current run.
 */
const READ_ONLY_INTERNAL_TOOLS: readonly string[] = ['TaskList', 'TaskGet'];

/**
 * Whether a tool belongs to this batch's scope by its own class (D2): the `read`
 * class, plus the read-only internal tools, read off the product's one
 * classification (`classifyToolName`). This is a scope filter, not a permission
 * decision: it decides what the round's request offers, and the tool gate still
 * decides every call that reaches a face.
 */
function inBatchScope(name: string): boolean {
  const reading = classifyToolName(name);
  if (reading === null) {
    return false;
  }
  return (
    reading.tool_class === 'read' ||
    (reading.tool_class === 'internal' && READ_ONLY_INTERNAL_TOOLS.includes(reading.tool_name))
  );
}

/**
 * The tool specs this round's model may call: this batch's registry, filtered to
 * the names the round's own availability calculation offers (`RoundInput.tools`)
 * and to the batch's classes, in the registry's order. An empty list is a round
 * with no tool face at all — a DM or a rootless autonomous round — and its
 * provider request carries no tool definitions.
 */
export function roundToolSpecs(input: RoundInput): RoundToolSpec[] {
  return BATCH_TOOLS.filter(
    (spec) => input.tools.includes(spec.name) && inBatchScope(spec.name) && spec.available(input),
  );
}

/**
 * The round's tool context. Each accessor reads the face the round input
 * carries; a spec reaches one only after its own `available` held, so a missing
 * face here is a registry bug rather than a round state.
 */
export function roundToolContext(input: RoundInput, copy: ToolCopy): RoundToolContext {
  return {
    files(): RoundFileTools {
      const files = input.workspace?.files;
      if (files === undefined) {
        throw new Error('tool face missing: this round has no project file face');
      }
      return files;
    },
    plan(): RoundPlanFace {
      if (input.plan === null) {
        throw new Error('tool face missing: this round has no Plan face');
      }
      return input.plan;
    },
    copy,
  };
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

/**
 * The result's own state on its first line. `io-error` is the file face's own
 * catch-all code, so a failed result that somehow carries none still reports a
 * code the model can act on.
 */
function statusLine(name: string, result: RoundFileToolResult): string {
  return result.ok ? `[${name}] ok` : `[${name}] error: ${result.error ?? 'io-error'}`;
}

/** A failed file-tool result: state, the request it answers, then the face's message. */
function shapeFileFailure(
  name: string,
  request: readonly string[],
  result: RoundFileToolResult,
): ToolAnswer {
  const lines = [statusLine(name, result), ...request];
  if (result.message !== undefined) {
    lines.push(`message: ${result.message}`);
  }
  return { ok: false, content: lines.join('\n') };
}

/** One `Read` result as the model reads it: summary first, body after it. */
function shapeRead(requested: string, result: RoundFileToolResult): ToolAnswer {
  if (!result.ok) {
    return shapeFileFailure('Read', [`path: ${requested}`], result);
  }
  const lines = [statusLine('Read', result), `path: ${result.path ?? requested}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.bytes !== undefined) {
    lines.push(`bytes: ${result.bytes}`);
  }
  lines.push('content:', result.content ?? '');
  return { ok: true, content: lines.join('\n') };
}

/** One `Glob` result: the request, then one path per line. */
function shapeGlob(requested: GlobFileRequest, result: RoundFileToolResult): ToolAnswer {
  const request = [
    `pattern: ${requested.pattern}`,
    ...(requested.path === undefined ? [] : [`base: ${requested.path}`]),
  ];
  if (!result.ok) {
    return shapeFileFailure('Glob', request, result);
  }
  const lines = [statusLine('Glob', result), ...request];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  const paths = result.paths ?? [];
  lines.push(`files: ${paths.length}`);
  lines.push(...(paths.length === 0 ? ['(no file matched)'] : paths));
  return { ok: true, content: lines.join('\n') };
}

/**
 * One `Grep` result: the request, then one `path:line: text` line per hit.
 *
 * `t` is the round's translation function — the same entry point every backend
 * string uses, bound from `tFromDb` by the caller that holds the database —
 * passed in rather than imported so this module never reads the language
 * preference itself. Exported so a test can pin the model-visible capped copy
 * without a provider round trip.
 */
export function shapeGrep(
  requested: GrepFileRequest,
  result: RoundFileToolResult,
  t: ToolCopy,
): ToolAnswer {
  const request = [
    `pattern: ${requested.pattern}`,
    ...(requested.path === undefined ? [] : [`base: ${requested.path}`]),
  ];
  if (!result.ok) {
    return shapeFileFailure('Grep', request, result);
  }
  const lines = [statusLine('Grep', result), ...request];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  const matches = result.matches ?? [];
  lines.push(`matches: ${matches.length}`);
  if (result.capped === 'matches') {
    lines.push(t('tool.grep.capped.matches', { limit: MAX_GREP_MATCHES }));
  } else if (result.capped === 'files') {
    lines.push(t('tool.grep.capped.files', { limit: MAX_GREP_FILES }));
  }
  lines.push(
    ...(matches.length === 0
      ? ['(no line matched)']
      : matches.map((match) => `${match.path}:${match.line}: ${match.text}`)),
  );
  return { ok: true, content: lines.join('\n') };
}

/** One `TaskList` result: the run's size, then one `- [status] title (id)` per item. */
function shapeTaskList(tasks: readonly PlanTaskView[]): ToolAnswer {
  const lines = ['[TaskList] ok', `tasks: ${tasks.length}`];
  if (tasks.length === 0) {
    lines.push("(this run's plan has no items)");
  } else {
    lines.push(...tasks.map((task) => `- [${task.status}] ${task.title} (${task.id})`));
  }
  return { ok: true, content: lines.join('\n') };
}

/** One `TaskGet` result: the item's fields, or the stable `not-found` code. */
function shapeTaskGet(requested: string, task: PlanTaskView | null): ToolAnswer {
  if (task === null) {
    return {
      ok: false,
      content: [
        '[TaskGet] error: not-found',
        `id: ${requested}`,
        "message: this id is not an item of this round's plan run",
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      '[TaskGet] ok',
      `id: ${task.id}`,
      `title: ${task.title}`,
      `status: ${task.status}`,
      `position: ${task.position}`,
    ].join('\n'),
  };
}
