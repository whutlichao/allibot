import type { MessageKey, MessageValues, PlanTaskView } from '@allibot/shared';
import type {
  EditFileRequest,
  GlobFileRequest,
  GrepFileRequest,
  RoundFileToolResult,
  RoundFileTools,
  RoundInput,
  RoundMcpCallResult,
  RoundMcpContext,
  RoundMcpTool,
  RoundPlanFace,
  RoundShell,
  RoundShellResult,
  WriteFileRequest,
} from './agent-seam.js';
import { MAX_GREP_FILES } from './docker-files.js';
import { MAX_SHELL_OUTPUT_BYTES } from './local-shell.js';
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
 * The batch's scope grew with its tickets: `Read` / `Glob` / `Grep` over the
 * round's file face and `TaskList` / `TaskGet` over its Plan face (#59);
 * `Write` / `Edit` over the same file face, behind the tool gate that face
 * itself applies (#74); `Bash` over the round's shell face (#75); and the
 * dynamic `mcp:<server>/<tool>` set of every server this round connected
 * (#76), which is the one part of the registry that is not a constant: it is
 * derived per round from the tools those servers actually listed, so a server
 * that is missing, invalid, unconfirmed or unreachable contributes no spec at
 * all. The orchestration tools arrive with a later batch; a name without a spec
 * here is not offered, even when `RoundInput.tools` lists it.
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
  shell(): RoundShell;
  /**
   * The round's MCP assembly (D6.1): the servers it connected and the one gated
   * tool-call face. A spec reaches this only for a tool this round's own
   * context listed, so an empty assembly is a registry bug here, not a state.
   */
  mcp(): RoundMcpContext;
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

/**
 * The arguments a spec's own shape check accepted, as `execute` receives them.
 * A declared-shape tool proves every argument is a string and narrows to that
 * proof; an MCP tool ships a schema this process does not hold, so its check
 * proves only "one JSON object" and hands the whole object over. The weaker
 * type states the part both paths share.
 */
export type ToolArguments = Readonly<Record<string, unknown>>;

/** One tool as this round may offer it. */
export interface RoundToolSpec {
  name: string;
  description: string;
  arguments: readonly ToolArgument[];
  /**
   * `true` for a tool whose arguments the round does not shape: an MCP tool is
   * described by its own server, so the offered schema stays open and the shape
   * check proves only that the model sent one JSON object. Absent (false) for
   * every tool declared here, which keeps their strict check.
   */
  rawArguments?: boolean;
  /**
   * Whether this round has the face the tool runs against (D2). `Read` / `Glob`
   * / `Grep` need the project file face, `TaskList` / `TaskGet` need the Plan
   * face, `Bash` needs the shell face: no face, no tool. Which rounds are handed
   * `Bash` at all is the round assembly's rule (`RoundInput.tools`), not this
   * accessor's: this only states that the face it would call exists.
   */
  available(input: RoundInput): boolean;
  /**
   * Run one call whose arguments the shape check accepted. This spec's
   * `available` already held for this round, so the context carries the face.
   */
  execute(input: ToolArguments, context: RoundToolContext): Promise<ToolAnswer>;
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
    // The shape check proved the required argument present and a string.
    const requested = input['path'] as string;
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
    const pattern = input['pattern'] as string;
    const base = input['path'] as string | undefined;
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
    const pattern = input['pattern'] as string;
    const base = input['path'] as string | undefined;
    const request: GrepFileRequest = { pattern, ...(base === undefined ? {} : { path: base }) };
    return shapeGrep(request, await context.files().Grep(request), context.copy);
  },
};

const WRITE: RoundToolSpec = {
  name: 'Write',
  description:
    "Write one UTF-8 text file inside this round's project root, creating it when it does not " +
    'exist. `path` is relative to the project root; an absolute path is accepted only when it ' +
    'resolves inside that root, and `..` is always refused. A path outside the root, a missing ' +
    'parent directory and a failed write each come back as an error result. The call passes the ' +
    "round's permission gate first, so a mode or rule that asks waits for the human decision and " +
    'a denial comes back as a `denied` result; none of those ends the round.',
  arguments: [
    { name: 'path', description: 'The project-root-relative file to write.', required: true },
    { name: 'content', description: 'The UTF-8 text to write, replacing the file.', required: true },
  ],
  available: (input) => input.workspace !== null,
  async execute(input, context) {
    // The shape check proved both required arguments present and strings.
    const request: WriteFileRequest = {
      path: input['path'] as string,
      content: input['content'] as string,
    };
    return shapeWrite(request, await context.files().Write(request));
  },
};

const EDIT: RoundToolSpec = {
  name: 'Edit',
  description:
    "Replace every occurrence of `old_string` with `new_string` in one UTF-8 text file inside " +
    "this round's project root. `path` is relative to the project root; an absolute path is " +
    'accepted only when it resolves inside that root, and `..` is always refused. The file must ' +
    'already exist and `old_string` must occur in it. A path outside the root, a missing file and ' +
    "an `old_string` that does not occur each come back as an error result. The call passes the " +
    "round's permission gate first, so a mode or rule that asks waits for the human decision and " +
    'a denial comes back as a `denied` result; none of those ends the round.',
  arguments: [
    { name: 'path', description: 'The project-root-relative file to edit.', required: true },
    {
      name: 'old_string',
      description: 'The exact text to replace; every occurrence is replaced.',
      required: true,
    },
    { name: 'new_string', description: 'The text to replace it with.', required: true },
  ],
  available: (input) => input.workspace !== null,
  async execute(input, context) {
    const request: EditFileRequest = {
      path: input['path'] as string,
      old_string: input['old_string'] as string,
      new_string: input['new_string'] as string,
    };
    return shapeEdit(request, await context.files().Edit(request));
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
    const requested = input['id'] as string;
    return shapeTaskGet(requested, context.plan().TaskGet({ id: requested }));
  },
};

const BASH: RoundToolSpec = {
  name: 'Bash',
  description:
    'Run one shell command with `/bin/bash -c`. `command` is the whole command line, and the ' +
    'working directory is always the project root: it is not an argument and cannot be chosen. ' +
    'Every call waits for a human decision before it runs; a refusal comes back as `denied` and ' +
    'the command does not run. A non-zero exit code, a command that does not exist, an empty ' +
    "stdout and a stderr body are all results of this call, never reasons to stop the round, and " +
    'an output cut at the size cap says so before the output it shows.',
  arguments: [
    {
      name: 'command',
      description: 'The shell command line to run in the project root.',
      required: true,
    },
  ],
  available: (input) => input.workspace !== null,
  async execute(input, context) {
    const command = input['command'] as string;
    return shapeShell(command, await context.shell().run({ command }), context.copy);
  },
};

/** The tools this batch puts in the loop, in the order the model sees them. */
const BATCH_TOOLS: readonly RoundToolSpec[] = [
  READ,
  GLOB,
  GREP,
  WRITE,
  EDIT,
  TASK_LIST,
  TASK_GET,
  BASH,
];

/**
 * One MCP tool as this round may offer it (D3). The name is the product's own
 * `mcp:<server>/<tool>` — the same string as the `permission_rule.tool_name`,
 * the approval payload and this round's `RoundInput.tools` — and the
 * description is the server's, taken from the list the round's connection
 * actually returned rather than from anything declared here.
 *
 * MCP carries its own input schema, which `RoundMcpTool` does not hand over, so
 * the round offers an open object and passes the model's arguments through
 * untouched: the server that declared the tool is the one that checks them.
 * Every call still goes through the round's MCP face, i.e. the #44 gate
 * (execution class, stable-JSON pattern): an `ask` blocks inside the round and
 * a `deny` comes back as a `DENIED` result, never as a round error.
 */
function mcpToolSpec(server: string, tool: RoundMcpTool): RoundToolSpec {
  const name = `mcp:${server}/${tool.name}`;
  return {
    name,
    description:
      tool.description ??
      `The MCP tool ${tool.name} of the connected server ${server}; that server defines its arguments.`,
    arguments: [],
    rawArguments: true,
    // The spec exists only while this round's assembly lists the tool, so the
    // face it calls is always there: an unavailable server contributes no spec
    // at all (no `mcp.json`, an invalid file, an unconfirmed remote, a failed
    // connection), which is the assembly's answer, not this accessor's.
    available: (input) => input.mcp !== null,
    async execute(args, context) {
      return shapeMcpCall(server, tool.name, await context.mcp().callTool(server, tool.name, args));
    },
  };
}

/**
 * The MCP specs this round may offer, in `RoundInput.tools`' own order: the
 * servers it actually connected, each followed by the tools that server listed.
 * Every one of them is dynamic — a server contributes only what it answered
 * with this round — so an empty assembly is zero specs and zero tools, never a
 * round error.
 */
function mcpToolSpecs(input: RoundInput): RoundToolSpec[] {
  const mcp = input.mcp;
  if (mcp === null) {
    return [];
  }
  return mcp.servers.flatMap((server) =>
    server.tools.map((tool) => mcpToolSpec(server.name, tool)),
  );
}

/**
 * The `internal` tools this batch offers although their class is not `read`:
 * the two Plan tools that only read the current run.
 */
const READ_ONLY_INTERNAL_TOOLS: readonly string[] = ['TaskList', 'TaskGet'];

/**
 * The `execute` tools this batch offers as constants. `Bash` is the one built-in
 * execution tool here; the `mcp:` namespace is execution class too and is
 * offered per round, through the dynamic specs the round's own assembly
 * produced.
 */
const BATCH_EXECUTE_TOOLS: readonly string[] = ['Bash'];

/** The one namespace whose tools this batch offers dynamically (D3). */
const MCP_TOOL_PREFIX = 'mcp:';

/**
 * Whether a tool belongs to this batch's scope by its own class (D2): the `read`
 * class, the `write` class (#74), plus the read-only internal tools, read off
 * the product's one classification (`classifyToolName`). This is a scope filter,
 * not a permission decision: it decides what the round's request offers, and the
 * tool gate still decides every call that reaches a face — which is where an
 * `ask` becomes a 600-second approval batch and a `deny` becomes `DENIED`.
 */
function inBatchScope(name: string): boolean {
  const reading = classifyToolName(name);
  if (reading === null) {
    return false;
  }
  return (
    reading.tool_class === 'read' ||
    reading.tool_class === 'write' ||
    (reading.tool_class === 'internal' && READ_ONLY_INTERNAL_TOOLS.includes(reading.tool_name)) ||
    (reading.tool_class === 'execute' &&
      (BATCH_EXECUTE_TOOLS.includes(reading.tool_name) ||
        reading.tool_name.startsWith(MCP_TOOL_PREFIX)))
  );
}

/**
 * The tool specs this round's model may call: this batch's registry, then the
 * MCP specs this round's assembly produced, filtered to the names the round's
 * own availability calculation offers (`RoundInput.tools`) and to the batch's
 * classes, in that order — which is the same built-ins-then-MCP order
 * `RoundInput.tools` already states. An empty list is a round with no tool face
 * at all — a DM or a rootless autonomous round, or one whose `mcp.json`
 * assembled nothing — and its provider request carries no tool definitions.
 */
export function roundToolSpecs(input: RoundInput): RoundToolSpec[] {
  return [...BATCH_TOOLS, ...mcpToolSpecs(input)].filter(
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
    shell(): RoundShell {
      const shell = input.workspace?.shell;
      if (shell === undefined) {
        throw new Error('tool face missing: this round has no local shell face');
      }
      return shell;
    },
    mcp(): RoundMcpContext {
      if (input.mcp === null) {
        throw new Error('tool face missing: this round assembled no MCP context');
      }
      return input.mcp;
    },
    copy,
  };
}

/**
 * The tool's parameter schema, as both providers express a JSON-schema object
 * (Anthropic `input_schema`, OpenAI-compatible `function.parameters`).
 */
export function toolInputSchema(spec: RoundToolSpec): Record<string, unknown> {
  if (spec.rawArguments === true) {
    // The tool's own server declares its schema; this round holds no copy of
    // it, so the offered object stays open. The server rejects what it cannot
    // accept, and that refusal is a tool result like any other.
    return { type: 'object', properties: {}, additionalProperties: true };
  }
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
  | { ok: true; values: ToolArguments }
  | { ok: false; message: string };

/**
 * Check the model's arguments against the tool's declared shape (D4) before the
 * face runs: a missing required argument, a wrong type and an extra argument are
 * all refusals the model receives as a tool result, never a round error.
 *
 * A tool that declares no shape here (an MCP tool) is checked only for being
 * one JSON object: the server that declared it is the one that validates its
 * arguments, and this process mirroring that schema would be a second source of
 * truth for it.
 */
export function checkToolArguments(spec: RoundToolSpec, input: unknown): ToolArgumentCheck {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return { ok: false, message: 'arguments must be a JSON object' };
  }
  const supplied = input as Record<string, unknown>;
  if (spec.rawArguments === true) {
    return { ok: true, values: supplied };
  }
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

/**
 * One `Write` result: the request, then how much landed. The face's own result
 * carries no content echo, so a write of a huge file never doubles the re-feed.
 */
function shapeWrite(requested: WriteFileRequest, result: RoundFileToolResult): ToolAnswer {
  const request = [`path: ${requested.path}`];
  if (!result.ok) {
    return shapeFileFailure('Write', request, result);
  }
  const lines = [statusLine('Write', result), `path: ${result.path ?? requested.path}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.bytes !== undefined) {
    lines.push(`bytes: ${result.bytes}`);
  }
  return { ok: true, content: lines.join('\n') };
}

/** One `Edit` result: the request, then how many occurrences were replaced. */
function shapeEdit(requested: EditFileRequest, result: RoundFileToolResult): ToolAnswer {
  const request = [`path: ${requested.path}`];
  if (!result.ok) {
    return shapeFileFailure('Edit', request, result);
  }
  const lines = [statusLine('Edit', result), `path: ${result.path ?? requested.path}`];
  if (result.scope !== undefined) {
    lines.push(`root: ${result.scope}`);
  }
  if (result.replacements !== undefined) {
    lines.push(`replacements: ${result.replacements}`);
  }
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

/**
 * One MCP tool result as the model reads it: the tool's product name, the call
 * it answers, and — when the call failed — the stable code the round's own face
 * produced (`denied`, `tool-error`, `connection`, `unavailable`, …).
 *
 * A denial is a result here, exactly as it is for every other tool: the round
 * continues with what the model makes of `DENIED`. The server's own body is
 * kept whole rather than summarized — it is the tool's answer, and the re-feed
 * cap is what bounds its size (D6).
 */
function shapeMcpCall(
  server: string,
  tool: string,
  result: RoundMcpCallResult,
): ToolAnswer {
  const name = `mcp:${server}/${tool}`;
  const call = [`server: ${server}`, `tool: ${tool}`];
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[${name}] error: ${result.error ?? 'tool-error'}`,
        ...call,
        ...(result.message === undefined ? [] : [`message: ${result.message}`]),
        ...(result.content === undefined ? [] : ['content:', result.content]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [`[${name}] ok`, ...call, 'content:', result.content ?? ''].join('\n'),
  };
}

/**
 * One `Bash` result as the model reads it: the command, the directory it ran in,
 * its exit code, and — **before either stream** — the one fact that would
 * otherwise be lost: the output was cut at the shell's own cap.
 *
 * The order is the point. A long output is cut by the re-feed cap at its head,
 * so a truncation notice printed after the body is the first thing the model
 * never reads (D6); stating it above the bodies is what makes it survive. The
 * same discipline as `Grep`'s cap: the model must not read a cut result as a
 * complete one.
 *
 * A completed command is a successful call whatever its exit code — the code is
 * stated rather than folded into an error — so a non-zero exit and a missing
 * binary reach the model as this one result.
 */
function shapeShell(command: string, result: RoundShellResult, t: ToolCopy): ToolAnswer {
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[Bash] error: ${result.error ?? 'spawn-failed'}`,
        `command: ${command}`,
        ...(result.message === undefined ? [] : [`message: ${result.message}`]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      '[Bash] ok',
      `command: ${command}`,
      ...(result.cwd === undefined ? [] : [`cwd: ${result.cwd}`]),
      `exit-code: ${result.exit_code ?? 'none'}`,
      ...(result.output_truncated === true
        ? [t('tool.bash.output.truncated', { limit: MAX_SHELL_OUTPUT_BYTES })]
        : []),
      'stdout:',
      result.stdout ?? '',
      'stderr:',
      result.stderr ?? '',
    ].join('\n'),
  };
}
