import {
  PLAN_TASK_STATUSES,
  type MessageKey,
  type MessageValues,
  type PlanTaskStatus,
  type PlanTaskView,
} from '@allibot/shared';
import type {
  EditFileRequest,
  GlobFileRequest,
  GrepFileRequest,
  PlanTaskUpdateRequest,
  RoundFileToolResult,
  RoundFileTools,
  RoundInput,
  RoundPlanFace,
  RoundShell,
  RoundShellResult,
  TeamAssignRequest,
  TeamAssignToolResult,
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
 * orchestration tools with the structured channel (#77): `TaskCreate` /
 * `TaskUpdate` over the Plan face, `TeamAssign` over the leader's assignment
 * face, `transfer_task` as the task action the write path already honours, and
 * `SopVerdict` as the verifier round's own conclusion. A name without a spec
 * here is not offered, even when `RoundInput.tools` lists it.
 */

/** One argument a tool accepts, in the order the model sees it. */
export interface ToolArgument {
  name: string;
  description: string;
  required: boolean;
  /**
   * The closed set of values the argument accepts (取值域), stated in the tool's
   * schema and checked before the face runs. An argument without it is any
   * string; one with it refuses every other value as an `invalid-arguments`
   * tool result, never as a round failure.
   */
  values?: readonly string[];
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
  assign(): (request: TeamAssignRequest) => Promise<TeamAssignToolResult>;
  copy: ToolCopy;
}

/**
 * The structured facts a dedicated tool call states (D11). They are the round's
 * own conclusion, not text for the model: the loop collects them off the
 * executed calls and the adapter maps them onto `RoundResult`'s existing fields
 * (`sopVerdict`, `taskAction`, `taskTransferMemberId`), never onto a new one
 * (D12). A tool that states nothing carries no facts.
 */
export interface ToolFacts {
  /** The verifier round's conclusion; `SopVerdict` is its only source. */
  sopVerdict?: 'pass' | 'fail';
  /**
   * The structured task action this round takes. `transfer_task` is the one
   * action with a tool name; `continue_task` has none yet and stays scripted.
   */
  taskAction?: 'transfer_task';
  /** The member a `transfer_task` action names. */
  taskTransferMemberId?: string;
}

/**
 * One tool call's answer, already shaped into the text the model receives: a
 * structured summary plus the body a read actually needs, never a JSON dump.
 * A failure states its stable code (`outside-root`, `not-found`, `denied`, …)
 * on its content's first line — the model is the one reader of that code, so
 * the answer carries no second, structured copy of it.
 *
 * `facts` is the round's channel, not the model's: a tool that states a
 * structured conclusion (D11) puts it here, and the loop hands it to the
 * adapter. Content and facts never duplicate each other.
 */
export interface ToolAnswer {
  ok: boolean;
  content: string;
  facts?: ToolFacts;
}

/** One tool as this round may offer it. */
export interface RoundToolSpec {
  name: string;
  description: string;
  arguments: readonly ToolArgument[];
  /**
   * Whether this round has the face the tool runs against (D2). `Read` / `Glob`
   * / `Grep` / `Write` / `Edit` need the project file face, the four Plan tools
   * need the Plan face, `Bash` needs the shell face, `TeamAssign` needs the
   * leader's assignment face: no face, no tool. Which rounds are handed `Bash`
   * at all is the round assembly's rule (`RoundInput.tools`), not this
   * accessor's: this only states that the face it would call exists.
   *
   * `transfer_task` and `SopVerdict` run against no face — the first is the
   * round write path's structured action, the second a conclusion the adapter
   * records — so nothing has to be present for them.
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
    // The shape check proved both required arguments present.
    const request: WriteFileRequest = { path: input['path']!, content: input['content']! };
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
      path: input['path']!,
      old_string: input['old_string']!,
      new_string: input['new_string']!,
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
    const requested = input['id']!;
    return shapeTaskGet(requested, context.plan().TaskGet({ id: requested }));
  },
};

const TASK_CREATE: RoundToolSpec = {
  name: 'TaskCreate',
  description:
    "Append one item to this round's own Plan run — the work list this member keeps in this " +
    'target — and answer with the item it created. `title` is the item title. It touches only ' +
    'the current run: it writes no message, unread count or budget.',
  arguments: [
    { name: 'title', description: 'The title of the new Plan item.', required: true },
  ],
  available: (input) => input.plan !== null,
  async execute(input, context) {
    return shapeTaskCreate(context.plan().TaskCreate({ title: input['title']! }));
  },
};

const TASK_UPDATE: RoundToolSpec = {
  name: 'TaskUpdate',
  description:
    "Change one item of this round's own Plan run: a new `title`, a new `status`, or both. " +
    `\`status\` is one of ${PLAN_TASK_STATUSES.join(' / ')}; any other value is refused before ` +
    'the Plan face runs. An id the current run does not hold comes back as a `not-found` error ' +
    'result; it never ends the round.',
  arguments: [
    { name: 'id', description: 'The Plan item id.', required: true },
    { name: 'title', description: 'The new title; omit it to keep the current one.', required: false },
    {
      name: 'status',
      description: `The new status: one of ${PLAN_TASK_STATUSES.join(' / ')}.`,
      required: false,
      values: PLAN_TASK_STATUSES,
    },
  ],
  available: (input) => input.plan !== null,
  async execute(input, context) {
    const title = input['title'];
    const status = input['status'];
    const request: PlanTaskUpdateRequest = {
      id: input['id']!,
      ...(title === undefined ? {} : { title }),
      // The shape check already proved the value is one of the three words.
      ...(status === undefined ? {} : { status: status as PlanTaskStatus }),
    };
    return shapeTaskUpdate(request, context.plan().TaskUpdate(request));
  },
};

const TEAM_ASSIGN: RoundToolSpec = {
  name: 'TeamAssign',
  description:
    "Assign one piece of work to a member of this team and read its answer as this call's " +
    'result. `member_id` is the member to assign the work to and `instruction` is what it has to ' +
    'do. The member runs inside this same round, so its output comes back here and never lands ' +
    'as a channel message. A member that cannot be assigned to — this round is not a leader ' +
    'round, the member is this round itself, the member is unavailable, the budget is used up — ' +
    'comes back as an error result with a stable code; the round continues.',
  arguments: [
    { name: 'member_id', description: 'The member to assign the work to.', required: true },
    { name: 'instruction', description: 'What that member has to do.', required: true },
  ],
  available: (input) => input.team?.assign != null,
  async execute(input, context) {
    const request: TeamAssignRequest = {
      member_id: input['member_id']!,
      instruction: input['instruction']!,
    };
    return shapeTeamAssign(request, await context.assign()(request));
  },
};

const TRANSFER_TASK: RoundToolSpec = {
  name: 'transfer_task',
  description:
    'Hand the task of this thread to another member: `member_id` becomes its assignee. The ' +
    "transfer is this round's structured task action, so the text you write does not move the " +
    'task. The write path validates the target (another live Agent member of this channel) and ' +
    'records the change itself; a refusal writes nothing and the round still ends with what you ' +
    'wrote.',
  arguments: [
    { name: 'member_id', description: 'The member to hand the task to.', required: true },
  ],
  available: () => true,
  async execute(input) {
    const memberId = input['member_id']!;
    return {
      ok: true,
      content: [
        '[transfer_task] ok',
        `member_id: ${memberId}`,
        'message: this round now reports the transfer as its structured task action',
      ].join('\n'),
      facts: { taskAction: 'transfer_task', taskTransferMemberId: memberId },
    };
  },
};

/** The verifier's two conclusions (D11): the tool's whole vocabulary. */
const SOP_VERDICTS = ['pass', 'fail'] as const;

const SOP_VERDICT: RoundToolSpec = {
  name: 'SopVerdict',
  description:
    "State this verifier round's conclusion: `pass` when the step's work is accepted, `fail` " +
    'when it has to be done again. The verdict is this call, not the text you write — a body ' +
    'that says pass decides nothing. Call it once, then write why the step is accepted or sent ' +
    'back.',
  arguments: [
    {
      name: 'verdict',
      description: 'pass accepts the step; fail sends it back to the executor.',
      required: true,
      values: SOP_VERDICTS,
    },
  ],
  available: () => true,
  async execute(input) {
    const verdict = input['verdict'] === 'pass' ? 'pass' : 'fail';
    return {
      ok: true,
      content: ['[SopVerdict] ok', `verdict: ${verdict}`].join('\n'),
      facts: { sopVerdict: verdict },
    };
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
    const command = input['command']!;
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
  TASK_CREATE,
  TASK_UPDATE,
  TEAM_ASSIGN,
  TRANSFER_TASK,
  SOP_VERDICT,
  BASH,
];

/**
 * The `internal` tools this batch offers although their class is not `read`:
 * the four Plan tools over the current run and the two team / task actions.
 */
const BATCH_INTERNAL_TOOLS: readonly string[] = [
  'TaskList',
  'TaskGet',
  'TaskCreate',
  'TaskUpdate',
  'TeamAssign',
  'transfer_task',
];

/**
 * The `execute` tools this batch offers. `Bash` is the one execution tool here;
 * MCP tools are `execute` too and are a later batch's subject.
 */
const BATCH_EXECUTE_TOOLS: readonly string[] = ['Bash'];

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
    (reading.tool_class === 'internal' && BATCH_INTERNAL_TOOLS.includes(reading.tool_name)) ||
    (reading.tool_class === 'execute' && BATCH_EXECUTE_TOOLS.includes(reading.tool_name))
  );
}

/**
 * Whether this round offers the tool (D2). The round's own availability
 * calculation — `RoundInput.tools`, narrowed to the batch's classes — is that
 * list for every tool but one: `SopVerdict` is the verifier round's own channel
 * (D11), and no round lists it in `RoundInput.tools` (the product's tool-name
 * vocabulary is the gate's, and an internal tool never passes the gate).
 */
function offeredInRound(spec: RoundToolSpec, input: RoundInput): boolean {
  return spec.name === SOP_VERDICT.name
    ? input.sop?.role === 'verifier'
    : input.tools.includes(spec.name) && inBatchScope(spec.name);
}

/**
 * The tool specs this round's model may call: this batch's registry, filtered to
 * the tools this round offers (`offeredInRound`) and to the faces it actually
 * has, in the registry's order. An empty list is a round with no tool face at
 * all — a DM or a rootless autonomous round — and its provider request carries
 * no tool definitions.
 */
export function roundToolSpecs(input: RoundInput): RoundToolSpec[] {
  return BATCH_TOOLS.filter((spec) => spec.available(input) && offeredInRound(spec, input));
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
    assign(): (request: TeamAssignRequest) => Promise<TeamAssignToolResult> {
      const assign = input.team?.assign;
      if (assign == null) {
        throw new Error('tool face missing: this round has no TeamAssign face');
      }
      return assign;
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
        {
          type: 'string',
          description: argument.description,
          ...(argument.values === undefined ? {} : { enum: [...argument.values] }),
        },
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
 * face runs: a missing required argument, a wrong type, an extra argument and a
 * value outside a closed set are all refusals the model receives as a tool
 * result, never a round error.
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
    if (argument.values !== undefined && !argument.values.includes(value)) {
      return {
        ok: false,
        message: `argument ${argument.name} must be one of: ${argument.values.join(', ')}`,
      };
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
  return { ok: true, content: planTaskLines('TaskGet', task) };
}

/** One `TaskCreate` result: the item the call appended at the end of the run. */
function shapeTaskCreate(task: PlanTaskView): ToolAnswer {
  return { ok: true, content: planTaskLines('TaskCreate', task) };
}

/** One `TaskUpdate` result: the item as it now reads, or the stable `not-found` code. */
function shapeTaskUpdate(requested: PlanTaskUpdateRequest, task: PlanTaskView | null): ToolAnswer {
  if (task === null) {
    return {
      ok: false,
      content: [
        '[TaskUpdate] error: not-found',
        `id: ${requested.id}`,
        "message: this id is not an item of this round's plan run",
      ].join('\n'),
    };
  }
  return { ok: true, content: planTaskLines('TaskUpdate', task) };
}

/** One Plan item as the model reads it: the call's own state line, then its fields. */
function planTaskLines(name: string, task: PlanTaskView): string {
  return [
    `[${name}] ok`,
    `id: ${task.id}`,
    `title: ${task.title}`,
    `status: ${task.status}`,
    `position: ${task.position}`,
  ].join('\n');
}

/**
 * One `TeamAssign` result: the request, then the assignment's own facts and the
 * member's output. The output is the only place a sub-round's answer reaches the
 * leader — it is never persisted as a message — so the re-feed cap applies to it
 * like to any other result.
 */
function shapeTeamAssign(requested: TeamAssignRequest, result: TeamAssignToolResult): ToolAnswer {
  const request = [
    `member_id: ${requested.member_id}`,
    `instruction: ${requested.instruction}`,
  ];
  if (!result.ok) {
    return {
      ok: false,
      content: [
        `[TeamAssign] error: ${result.code ?? 'member_failed'}`,
        ...request,
        `state: ${result.state ?? 'none'}`,
        ...(result.reason === null ? [] : [`message: ${result.reason}`]),
      ].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      '[TeamAssign] ok',
      ...request,
      `assignment-id: ${result.assignment_id ?? 'none'}`,
      `state: ${result.state ?? 'none'}`,
      `jump-consumed: ${result.jump_consumed}`,
      ...(result.reply_excerpt === null ? [] : [`excerpt: ${result.reply_excerpt}`]),
      'output:',
      result.output ?? '',
    ].join('\n'),
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
