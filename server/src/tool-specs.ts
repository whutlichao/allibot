import {
  PLAN_TASK_STATUSES,
  type MessageKey,
  type MessageValues,
  type PlanTaskStatus,
} from '@allibot/shared';
import type {
  EditFileRequest,
  GlobFileRequest,
  GrepFileRequest,
  PlanTaskUpdateRequest,
  RoundFileTools,
  RoundInput,
  RoundMcpContext,
  RoundMcpTool,
  RoundPlanFace,
  RoundShell,
  RoundWebFace,
  TeamAssignRequest,
  TeamAssignToolResult,
  WriteFileRequest,
} from './agent-seam.js';
import { classifyToolName } from './permissions.js';
import {
  shapeEdit,
  shapeFetch,
  shapeGlob,
  shapeGrep,
  shapeMcpCall,
  shapeRead,
  shapeShell,
  shapeTaskCreate,
  shapeTaskGet,
  shapeTaskList,
  shapeTaskUpdate,
  shapeTeamAssign,
  shapeWebSearch,
  shapeWrite,
} from './tool-result-shaping.js';

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
 * method. The offered set is this batch's scope — the `read` / `write` classes,
 * the `internal` tools it offers and the `execute` tools (`Bash` and the `mcp:`
 * namespace) — intersected with the round's availability
 * calculation (`RoundInput.tools`), so a round that has no file face is offered
 * no file tool and a round with no Plan face is offered no Plan tool — those
 * names are absent from the provider request, not refused at call time.
 *
 * This module owns the registry, the round's scope filter, the argument shape
 * check and the provider schema each spec is serialized to. What a tool hands
 * back to the model is shaped in `tool-result-shaping.ts`, one function per
 * tool, so a result's shape and a tool's availability are two separate
 * reasons to change.
 *
 * The batch's scope grew with its tickets: `Read` / `Glob` / `Grep` over the
 * round's file face and `TaskList` / `TaskGet` over its Plan face (#59);
 * `Write` / `Edit` over the same file face, behind the tool gate that face
 * itself applies (#74); `Bash` over the round's shell face (#75); and the
 * dynamic `mcp:<server>/<tool>` set of every server this round connected
 * (#76), which is the one part of the registry that is not a constant: it is
 * derived per round from the tools those servers actually listed, so a server
 * that is missing, invalid, unconfirmed or unreachable contributes no spec at
 * all; and the orchestration tools with the structured channel (#77):
 * `TaskCreate` / `TaskUpdate` over the Plan face, `TeamAssign` over the leader's
 * assignment face, `transfer_task` as the task action the write path already
 * honours, and `SopVerdict` as the verifier round's own conclusion. A name
 * without a spec here is not offered, even when `RoundInput.tools` lists it.
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
  /**
   * The round's MCP assembly (D6.1): the servers it connected and the one gated
   * tool-call face. A spec reaches this only for a tool this round's own
   * context listed, so an empty assembly is a registry bug here, not a state.
   */
  mcp(): RoundMcpContext;
  web(): RoundWebFace;
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
    return shapeTaskCreate(context.plan().TaskCreate({ title: input['title'] as string }));
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
      id: input['id'] as string,
      ...(title === undefined ? {} : { title: title as string }),
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
  available: (input) => input.team?.assign !== undefined,
  async execute(input, context) {
    const request: TeamAssignRequest = {
      member_id: input['member_id'] as string,
      instruction: input['instruction'] as string,
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
    const memberId = input['member_id'] as string;
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
    // The shape check proved the value is one of the two words (D11).
    const verdict = input['verdict'] as (typeof SOP_VERDICTS)[number];
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
    const command = input['command'] as string;
    return shapeShell(command, await context.shell().run({ command }), context.copy);
  },
};

/**
 * `web_search` (D2 / D8 / D13): the round's one remote read. It runs against the
 * round's web face, i.e. the one provider resolution, so the model never names a
 * provider, an endpoint or a credential. The spec exists only while this round
 * assembled the tool; a call that arrives with no usable provider — a stale
 * assembly or a rule-direct call — throws and closes the round failed with the
 * missing fact named. Results come back shaped like any other read.
 */
const WEB_SEARCH: RoundToolSpec = {
  name: 'web_search',
  description:
    'Search the web for one query. `query` is the search text. The round fixes which provider answers, ' +
    'so results come back as one source line, the hit count and one numbered title / url / snippet ' +
    'block per hit; a provider error is an error result and never ends the round. A round with no ' +
    'usable provider fails this call instead of silently answering nothing.',
  arguments: [
    { name: 'query', description: 'The search query.', required: true },
  ],
  available: (input) => input.web !== null,
  async execute(input, context) {
    // The shape check proved the required argument present and a string.
    const query = input['query'] as string;
    return shapeWebSearch(query, await context.web().search({ query }));
  },
};

/**
 * `fetch` (D2 / D5 / D10 / D14): the round's one remote read of a specific page.
 * The call passes the round's permission gate first, with the URL's **host** as
 * the subject — the query string never reaches an approval record. A denial is a
 * `DENIED` result, a cross-host redirect is a refusal result, and a completed
 * response is a result whatever its status code.
 */
const FETCH: RoundToolSpec = {
  name: 'fetch',
  description:
    'Fetch one web page this round may read. `url` must be an absolute http or https URL. The call ' +
    "passes this round's permission gate first: a denial comes back as `denied` and nothing is " +
    'requested, and the gate subject is the host, not the URL. A redirect to another host is ' +
    'refused rather than followed; a same-host redirect is followed. The response body comes back ' +
    'as the result body.',
  arguments: [
    { name: 'url', description: 'The absolute http or https URL to GET.', required: true },
  ],
  available: (input) => input.web !== null,
  async execute(input, context) {
    const url = input['url'] as string;
    return shapeFetch(await context.web().fetch({ url }));
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
  WEB_SEARCH,
  FETCH,
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
 * The MCP specs this round may offer, in the assembly's own server order (the
 * same order `RoundInput.tools` lists them in, since both are derived from one
 * `mcp.servers`): the servers it actually connected, each followed by the tools
 * that server listed. Every one of them is dynamic — a server contributes only
 * what it answered with this round — so an empty assembly is zero specs and zero
 * tools, never a round error.
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
 * The `execute` tools this batch offers as constants. `Bash` is the one built-in
 * execution tool here; the `mcp:` namespace is execution class too and is
 * offered per round, through the dynamic specs the round's own assembly
 * produced.
 */
const BATCH_EXECUTE_TOOLS: readonly string[] = ['Bash', 'fetch'];

/** The one namespace whose tools this batch offers dynamically (D3). */
const MCP_TOOL_PREFIX = 'mcp:';

/**
 * Whether a tool belongs to this batch's scope by its own class (D2): the `read`
 * class, the `write` class (#74), the `internal` tools this batch offers —
 * `BATCH_INTERNAL_TOOLS`: the four Plan tools over the current run and the two
 * team / task actions, none of them read-only — and, for the `execute` class,
 * `Bash` plus the whole `mcp:` namespace. Every class is read off the product's
 * one classification (`classifyToolName`). This is a scope filter, not a
 * permission decision: it decides what the round's request offers, and the tool
 * gate still decides every call that reaches a face — which is where an `ask`
 * becomes a 600-second approval batch and a `deny` becomes `DENIED`.
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
    (reading.tool_class === 'execute' &&
      (BATCH_EXECUTE_TOOLS.includes(reading.tool_name) ||
        reading.tool_name.startsWith(MCP_TOOL_PREFIX)))
  );
}

/**
 * Whether this round offers the tool (D2). The round's own availability
 * calculation — `RoundInput.tools`, narrowed to the batch's classes — is that
 * list for every tool but one: `SopVerdict` is the verifier round's own channel
 * (D11), and the round lists the SOP channel's role instead of the name
 * (`RoundInput.sop.role`), because a verifier round's tool set is not the
 * availability calculation's. The exception is about where the visibility comes
 * from, not about the name's class: `SopVerdict` is classified `internal` by the
 * one classification table like every other name this batch added.
 */
function offeredInRound(spec: RoundToolSpec, input: RoundInput): boolean {
  return spec.name === SOP_VERDICT.name
    ? input.sop?.role === 'verifier'
    : input.tools.includes(spec.name) && inBatchScope(spec.name);
}

/**
 * The tool specs this round's model may call: this batch's registry, then the
 * MCP specs this round's assembly produced, filtered to the tools this round
 * offers (`offeredInRound`) and to the faces it actually has, in that order —
 * which is the same built-ins-then-MCP order `RoundInput.tools` already states.
 * An empty list is a round with no tool face at all — a DM, a rootless
 * autonomous round, or one whose `mcp.json` assembled nothing — and its
 * provider request carries no tool definitions.
 */
export function roundToolSpecs(input: RoundInput): RoundToolSpec[] {
  return [...BATCH_TOOLS, ...mcpToolSpecs(input)].filter(
    (spec) => spec.available(input) && offeredInRound(spec, input),
  );
}

/**
 * The round's tool context. Each accessor reads the face the round input
 * carries; a spec reaches one only after its own `available` held, so a missing
 * face here is a registry bug rather than a round state.
 */
export function roundToolContext(input: RoundInput, copy: ToolCopy): RoundToolContext {
  return {
    files: () => requiredFace(input.workspace?.files, 'project file face'),
    plan: () => requiredFace(input.plan, 'Plan face'),
    shell: () => requiredFace(input.workspace?.shell, 'local shell face'),
    mcp: () => requiredFace(input.mcp, 'MCP context'),
    web: () => requiredFace(input.web, 'web face'),
    assign: () => requiredFace(input.team?.assign, 'TeamAssign face'),
    copy,
  };
}

/**
 * One face the round input carries, as the spec that reached it requires: an
 * absent one is the registry's own bug, stated as one.
 */
function requiredFace<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined) {
    throw new Error(`tool face missing: this round has no ${what}`);
  }
  return value;
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
  | { ok: true; values: ToolArguments }
  | { ok: false; message: string };

/**
 * Check the model's arguments against the tool's declared shape (D4) before the
 * face runs: a missing required argument, a wrong type, an extra argument and a
 * value outside a closed set are all refusals the model receives as a tool
 * result, never a round error.
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
