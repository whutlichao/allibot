import type {
  McpTransport,
  PermissionMode,
  PlanTaskStatus,
  PlanTaskView,
  TeamAssignmentState,
  WorkspaceBackend,
} from '@allibot/shared';

/**
 * The member-face adapter seam (成员面适配接缝): one member round in, zero or
 * more pending replies plus one round conclusion out.
 *
 * The shape is fixed by the glossary and the spec (D4.3): the scripted adapter
 * injected through `--scripted-provider` is the only implementation this
 * ticket ships, and the real provider adapter arrives behind the same
 * interface without changing it. Nothing here knows about HTTP, SQLite or the
 * scripted double's chosen behaviour.
 *
 * Long-term memory (#17) and response judgment (#15) both extend the input
 * side only: a round now also carries the memory cards recalled for it and the
 * assembled system prompt, the same way a task-thread round carries task
 * context. The output shape — zero or more pending replies plus one round
 * result — is unchanged.
 */

/**
 * Why a member was woken. The signal carries the reason for readable
 * diagnostics only; it is never the discipline that decides whether the Agent
 * must answer.
 */
export const WAKE_REASONS = [
  'channel-message',
  'mention',
  'claim',
  'continue',
  'team-change',
] as const;
export type WakeReason = (typeof WAKE_REASONS)[number];

/** The three target kinds; a DM round reads its own one-to-one prompt. */
export type RoundTargetKind = 'channel' | 'dm' | 'task';

/**
 * 上下文窗口 (Context Window): a normal round reads the most recent 40 target
 * messages. An auto-continue round reads the whole task thread it keeps working
 * on instead, because that thread is the work item.
 */
export const ROUND_CONTEXT_WINDOW = 40;

/** How much history one round reads: the recent window, or the whole thread. */
export type ContextScope = 'window' | 'full';

/** What the round is allowed to know about the member it runs for. */
export interface RoundMember {
  id: string;
  display_name: string;
  avatar_slot: number;
  role: string;
  model: string | null;
  system_prompt: string;
}


/** One successful / failed file-tool call (D5.1). */
export type FileToolErrorCode =
  | 'invalid-path'
  | 'outside-root'
  | 'read-only'
  | 'not-found'
  | 'not-a-directory'
  | 'is-directory'
  | 'invalid-pattern'
  | 'old-string-not-found'
  | 'denied'
  | 'io-error';

/** One grep hit: a path relative to the searched root, its 1-based line and the line text. */
export interface RoundGrepMatch {
  path: string;
  line: number;
  text: string;
}

/** The project / skills scope a result path belongs to. */
export type RoundFileScope = 'project' | 'skills';

/**
 * The member-face file-tool result. A failure is a tool error (`ok:false` with
 * a stable code and readable message), never an approval and never a rule
 * bypass candidate: root escapes are hard errors (D5.1).
 */
export interface RoundFileToolResult {
  ok: boolean;
  error?: FileToolErrorCode;
  message?: string;
  scope?: RoundFileScope;
  path?: string;
  content?: string;
  paths?: string[];
  matches?: RoundGrepMatch[];
  replacements?: number;
  bytes?: number;
}

export interface ReadFileRequest {
  path: string;
}

export interface GlobFileRequest {
  /** A root-relative glob; `*` stays inside one path segment, `**` crosses. */
  pattern: string;
  /** Optional directory (inside either root) to search from; default the project root. */
  path?: string;
}

export interface GrepFileRequest {
  /** A JavaScript regular expression source, applied line by line. */
  pattern: string;
  /** Optional file or directory (inside either root) to search; default the project root. */
  path?: string;
}

export interface WriteFileRequest {
  path: string;
  content: string;
}

export interface EditFileRequest {
  path: string;
  old_string: string;
  new_string: string;
}

/** One file-tool path the adapter may preview without executing the tool. */
export interface FilePreviewRequest {
  tool_name: 'Read' | 'Glob' | 'Grep' | 'Write' | 'Edit';
  path?: string;
  /** The Glob / Grep subject, when it is the pattern rather than the path. */
  pattern?: string;
}

/**
 * The restricted file tools a local round with a project root gets (D5.1).
 * `Read` / `Glob` / `Grep` can read the project root and the member's
 * `skills/` second root; `Write` / `Edit` only accept the project root.
 */
export interface RoundFileTools {
  Read(request: ReadFileRequest): Promise<RoundFileToolResult>;
  Glob(request: GlobFileRequest): Promise<RoundFileToolResult>;
  Grep(request: GrepFileRequest): Promise<RoundFileToolResult>;
  Write(request: WriteFileRequest): Promise<RoundFileToolResult>;
  Edit(request: EditFileRequest): Promise<RoundFileToolResult>;
  /**
   * Preview the gate decision for a path. It runs the file tool's own resolver
   * first and passes the resolved root-internal fact to the gate, so a
   * symlink-escaped path cannot preview `allow` while the real call is denied.
   */
  Preview(request: FilePreviewRequest): Promise<RoundPermissionCheck>;
}

/** Why a local-shell call did not run (D5.4). */
export type ShellToolErrorCode =
  | 'invalid-command'
  | 'outside-root'
  | 'not-found'
  | 'not-a-directory'
  | 'denied'
  | 'spawn-failed';

/** One local-shell call: the command and its optional in-root cwd. */
export interface RunShellRequest {
  command: string;
  /**
   * A directory inside the project root to run from; absent means the root.
   * `..`, a root-outside absolute path and an escaping symlink are hard tool
   * errors, never an approval question (D5.1 / D5.4).
   */
  cwd?: string;
  /** A stable adapter / model call id; a retry is the same call (D5.6). */
  tool_call_id?: string;
}

/**
 * The local-shell tool result. A completed command is `ok:true` whatever its
 * exit code (the adapter reads `exit_code`); a denial is `ok:false` with
 * `error:'denied'` — `DENIED`, not a round error. Output travels to the
 * adapter only: the production round path never logs it or stores it (D5.4).
 */
export interface RoundShellResult {
  ok: boolean;
  error?: ShellToolErrorCode;
  message?: string;
  /** The absolute directory the process ran in (the project root by default). */
  cwd?: string;
  exit_code?: number | null;
  stdout?: string;
  stderr?: string;
  /** `true` when output exceeded the capture cap and was truncated. */
  output_truncated?: boolean;
}

/**
 * 本地 shell (#46 / D5.4): the only shell this ticket ships. It is present
 * exactly when a local round has a usable project root; `enabled` mirrors
 * `channel.allow_local_shell`. A call while the switch is off is `DENIED`
 * without an approval; every enabled call goes through the one tool gate and
 * therefore asks the human before it runs.
 */
export interface RoundShell {
  readonly root: string;
  readonly enabled: boolean;
  run(request: RunShellRequest): Promise<RoundShellResult>;
}

/** One gate decision as an adapter may preview it before calling a tool. */
export interface RoundPermissionCheck {
  decision: 'allow' | 'deny' | 'ask';
  reason: string;
}

/**
 * The permission gate's read-only preview face (D5.5). It exists so an adapter
 * (the scripted double today, the model adapter's tool loop later) can classify
 * a call — including the local-shell hook and MCP names — without executing it.
 * The file tools apply the same gate themselves; this face writes nothing and
 * never registers an approval.
 */
export interface RoundPermissionRequest {
  tool_name: string;
  pattern: string;
  /** A stable model / adapter call id; a retry re-registers the same call. */
  tool_call_id?: string;
  root_internal_write?: boolean;
  /** The (masked at write time) tool arguments an approval would carry. */
  arguments?: Record<string, unknown>;
}

export interface RoundPermissionFace {
  mode: PermissionMode;
  /** Classify a call without executing it or registering an approval. */
  check(request: RoundPermissionRequest): RoundPermissionCheck;
  /**
   * Apply the gate to one non-file-tool call (the local shell / MCP hooks).
   * An ask waits for the human decision; a denial is `denied`.
   */
  authorize(request: RoundPermissionRequest): Promise<'allow' | 'denied'>;
}

/**
 * The round's workspace context (D3.7 / D5.1): the one project root, the
 * effective backend, the local-shell flag and the file / shell tool faces.
 * `null` on a DM or a local channel / task with no root: no project file tools
 * and no shell.
 */
export interface RoundWorkspaceContext {
  root: string;
  backend: WorkspaceBackend;
  /** The effective permission mode for this target context (D5.5). */
  permission_mode: PermissionMode;
  allow_local_shell: 0 | 1;
  /** The member's read-only skills second root, when it exists. */
  skills_root: string | null;
  /** The tool gate preview; the file tools apply the gate themselves. */
  permission: RoundPermissionFace;
  files: RoundFileTools;
  /**
   * The local-shell face (#46). It exists whenever the round has a project
   * root; `enabled` mirrors the channel switch, and a call while it is off is
   * `DENIED` without an approval. A round without a root has no face at all.
   */
  shell: RoundShell;
}

/**
 * One message the round reads through the same read path the human face uses.
 * Bodies travel here because the round understands the request; the wake
 * signal that started the round never carried them.
 */
export interface RoundMessage {
  seq: number;
  kind: 'human' | 'agent' | 'system';
  author_member_id: string;
  author_display_name: string;
  body: string;
}

/**
 * The ordered pieces the round's system prompt is assembled from. `systemPrompt`
 * is the joined text the adapter hands the model; this structure states the
 * composition order the seam used (D3.7 / D5.2): the global rules base →
 * `agent_config.system_prompt` → the project supplement. The first and third
 * pieces are absent until the workspace / Agent-home layer exists (#43); a
 * missing piece is `null`, not an empty section.
 *
 * The identity sentence is derived from `member.display_name` (never stored in
 * the prompt) and precedes the target discipline, exactly like M1.
 */
export interface RoundPromptSections {
  rulesBase: string | null;
  systemPrompt: string;
  projectSupplement: string | null;
  /* The assembled skills section (D5.2 / D6.3); null when none are assembled. */
  skills: string | null;
  identity: string;
  targetDiscipline: string;
  /* Every mandatory-answer sentence this round carries, in append order. */
  mandatory: readonly string[];
  /* The leader-duties paragraph; null unless this is the leader's round. */
  leaderDuties: string | null;
  /* The one assignment paragraph of a TeamAssign sub-round; null otherwise. */
  assignment: string | null;
  /* The recalled-memory section; null when nothing was recalled. */
  memory: string | null;
  /* The SOP step / role paragraph; null on every ordinary or team round. */
  sop: string | null;
}

/** One TeamAssign call: the tool's stable input shape (D3.4). */
export interface TeamAssignRequest {
  member_id: string;
  instruction: string;
}

/** Why a TeamAssign call did not run / finish the member sub-round. */
export type TeamAssignmentErrorCode =
  | 'not_leader'
  | 'target_self'
  | 'target_unavailable'
  | 'budget_exhausted'
  | 'member_failed';

/**
 * The tool result a leader round receives back from one TeamAssign call. The
 * result is a tool-call result, not an output field of the round (D3.7): the
 * full member output travels only here and is never persisted; the run record
 * keeps the truncated excerpt.
 */
export interface TeamAssignToolResult {
  ok: boolean;
  assignment_id: string | null;
  member_id: string;
  state: TeamAssignmentState | null;
  jump_consumed: 0 | 1;
  reply_excerpt: string | null;
  reason: string | null;
  code: TeamAssignmentErrorCode | null;
  /** The full member output returned to the leader; never persisted. */
  output: string | null;
}

/** One TeamAssign sub-round's own context inside the leader round. */
export interface RoundAssignmentContext {
  assignment_id: string;
  instruction: string;
}

/** `TaskCreate` input: a title; the item is appended at the end of the run. */
export interface PlanTaskCreateRequest {
  title: string;
}

/** `TaskGet` / `TaskUpdate` identify one item of the current run. */
export interface PlanTaskGetRequest {
  id: string;
}

/** `TaskUpdate` changes the title and / or the three-word status. */
export interface PlanTaskUpdateRequest {
  id: string;
  title?: string;
  status?: PlanTaskStatus;
}

/**
 * The four Plan tools as one tool face on the round input (D3.7 / D4.1). The
 * names are kept verbatim because they are the product's tool names. The face
 * is `null` on a round that does not get Plan tools (a DM or an autonomous
 * channel's ordinary round); a task target and any team target — including a
 * TeamAssign sub-round — gets it.
 *
 * The first call lazily creates the `plan_run` for this (target, member) pair;
 * the run is reused by later rounds while it is current. A tool call never
 * writes a message, an unread count, a search hit, a wake or budget.
 */
export interface RoundPlanFace {
  TaskCreate(request: PlanTaskCreateRequest): PlanTaskView;
  TaskGet(request: PlanTaskGetRequest): PlanTaskView | null;
  TaskList(): PlanTaskView[];
  TaskUpdate(request: PlanTaskUpdateRequest): PlanTaskView | null;
}

/**
 * The team reading of one round (D3.7 / D3.9). It is `null` on an ordinary
 * autonomous / DM round. `assign` is the TeamAssign tool face and exists only
 * in the leader's own round; a member sub-round sees its assignment context and
 * no way to assign further.
 */
export interface RoundTeamContext {
  leader_member_id: string | null;
  is_leader: boolean;
  task_id: string | null;
  team_run_id: string | null;
  assignment: RoundAssignmentContext | null;
  assign: ((request: TeamAssignRequest) => Promise<TeamAssignToolResult>) | null;
}

/**
 * The response discipline (回应判断) computed from the triggering message, not
 * from the wake reason: the reason is readable diagnostics only, and a merged
 * wake keeps the reason of whichever arrived first.
 *
 * `definite` is true for the M1 definite signals: a personal mention, a claim
 * wake, a human message the round is woken by, and an auto-continue wake. It
 * is the stored rule the adapter reads from its input, never something the
 * adapter infers back from the reason's text.
 */
export interface RoundDiscipline {
  definite: boolean;
  /** The definite signal that fired; `null` when `definite` is false. */
  signal: 'mention' | 'claim' | 'human-message' | 'continue' | 'team-change' | null;
}

/** One MCP tool the host listed from a connected server. */
export interface RoundMcpTool {
  name: string;
  description: string | null;
}

/** One connected MCP server of this round. */
export interface RoundMcpServer {
  name: string;
  transport: McpTransport;
  tools: readonly RoundMcpTool[];
}

/** One MCP tool-call result. A denial is a result, never a round error. */
export interface RoundMcpCallResult {
  ok: boolean;
  error?: 'denied' | 'unavailable' | 'unknown-server' | 'tool-error' | 'connection';
  message?: string;
  content?: string;
}

/**
 * The round's MCP assembly (D6.1): the servers declared by the Agent-home
 * `mcp.json` that the host actually connected for this round, the readable
 * diagnostics (invalid file, unconfirmed remote, connection failure) and the
 * one gated tool-call face a model tool loop would use. `null` means the file
 * is missing — zero MCP, no error. An invalid file is a context with zero
 * servers and one diagnostic, never a half set.
 */
export interface RoundMcpContext {
  /** The project root or the disposable `<data_dir>/mcp-hosts/<id>/` host. */
  host_root: string | null;
  servers: readonly RoundMcpServer[];
  /** Readable, whole-round diagnostics; also appended to RoundOutcome.reason. */
  diagnostics: readonly string[];
  /**
   * Execute one tool through the #44 tool gate (`mcp:<server>/<tool>`,
   * execution class, stable JSON arguments). A denied / failed call returns a
   * result; it never throws to the round.
   */
  callTool(
    server: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<RoundMcpCallResult>;
  close(): Promise<void>;
}

/**
 * The SOP context of one internal member round (D4.3). It is `null` on every
 * ordinary / team round. Both roles use the same member-face seam; the
 * verifier receives the executor's text as part of its input.
 */
export interface RoundSopContext {
  run_id: string;
  definition_id: string;
  step_index: number;
  step_title: string;
  step_description: string;
  role: 'executor' | 'verifier';
  attempt: number;
  max_attempts: number;
  /** The executor's text; `null` in an executor round. */
  executor_text: string | null;
}

/** The round's input: the member, the context it reads, and its discipline. */
export interface RoundInput {
  member: RoundMember;
  targetId: string;
  /** The kind of target this round runs in; a DM reads a one-to-one prompt. */
  targetKind: RoundTargetKind;
  /**
   * The collaboration topology (D3.1): a task / channel target resolves it
   * through its channel; a DM is always autonomous.
   */
  channelMode: 'autonomous' | 'team';
  /**
   * The stable reply identity allocated before the adapter runs (D5.6). A
   * landed ordinary round message uses it as its message id; a TeamAssign
   * sub-round / SOP round never lands a message, so it only names approvals.
   */
  replyId: string;
  /**
   * The SOP context of this internal round (D4.3); `null` unless this round is
   * an SOP executor / verifier round.
   */
  sop: RoundSopContext | null;
  /**
   * The tools this round may call, in stable order (D3.7). `TeamAssign` is the
   * leader's own tool; `transfer_task` is available only to the task's current
   * assignee. Plan tools arrive with #40.
   */
  tools: readonly string[];
  /**
   * 迭代上限 (Iteration Cap): the cap on model ↔ tool round trips inside this
   * one round, read from `agent_config.max_iterations` (default 10). It bounds
   * the round's loop, not the number of rounds — the generation and
   * `target_budget` already bound those.
   */
  maxIterations: number;
  /** The team reading of this round; null on an autonomous / DM round. */
  team: RoundTeamContext | null;
  /**
   * The Plan tool face (D4.1). It is `null` on a DM or an autonomous channel's
   * ordinary round; a task target and a team target always carry it, and a
   * TeamAssign sub-round carries it too.
   */
  plan: RoundPlanFace | null;
  /**
   * The local workspace face (D5.1): `null` when the round has no project root
   * (a DM, or a channel / task that never configured one), so no project file
   * tools and no shell. A configured root that vanished or the docker backend
   * fails the round before the adapter runs.
   */
  workspace: RoundWorkspaceContext | null;
  /**
   * The round's MCP assembly (D6.1): `null` when the Agent home has no
   * mcp.json. Assembly is independent of the project workspace, so a DM / no
   * root round can still use MCP; it never gains project file tools.
   */
  mcp: RoundMcpContext | null;
  /** The seq of the message that triggered this wake. */
  baseSeq: number;
  reason: WakeReason;
  discipline: RoundDiscipline;
  /**
   * How much history this round reads. A normal round reads the window; an
   * auto-continue round reads the whole task thread. The scope is stated here
   * so the adapter never has to infer it from the wake reason's text.
   */
  contextScope: ContextScope;
  /**
   * The target's context window (上下文窗口) for this round, oldest first: the
   * most recent messages — human, other members and this member's own history
   * replies alike — plus the triggering message, which is always part of the
   * window. An auto-continue round reads the whole thread it keeps working on
   * instead of the recent window.
   *
   * History is for understanding only: the wake, the response discipline and
   * the consumption cursor are computed from the new message, never from what
   * the window happens to reach back to.
   */
  messages: readonly RoundMessage[];
  /**
   * How far this member had consumed the target before this round: the
   * consumption cursor's `last_read_seq` (0 when the member has never consumed
   * anything there). A message newer than it and older than `baseSeq` is a
   * message an earlier round read but did not consume, so this round reads it
   * again — the round input states the cursor, the adapter only reads it.
   */
  consumedSeq: number;
  /**
   * The member's long-term memory cards recalled for this round (D5.2), best
   * match first. They are assembled into the prompt's memory section by the
   * seam; recall only informs this round's understanding and changes nothing
   * else about it.
   */
  memories: readonly RoundMemory[];
  /**
   * The assembled system prompt the adapter hands the model: the stored
   * `agent_config.system_prompt`, the target's response discipline, the
   * mandatory answer sentence where the round must answer, and the memory
   * section when this round recalled cards. The round input carries it so the
   * seam stays the one prompt assembly path.
   */
  systemPrompt: string;
  /**
   * The ordered composition of `systemPrompt` (D3.7): rules base →
   * `agent_config.system_prompt` → project supplement, then identity, target
   * discipline, mandatory sentences, leader duties / assignment and memory.
   */
  promptSections: RoundPromptSections;
}

/** One recalled memory card as a round reads it. */
export interface RoundMemory {
  id: string;
  content: string;
  /** The card keywords this round's input matched. */
  matched_keywords: readonly string[];
}

/**
 * What one member round concluded. `silent` is the deliberate silence (沉默):
 * a structured verdict the adapter states, never a message kind and never
 * derived from the readable text. `ignored` is the ordinary self-judged skip.
 * Both are normal protocol results on their own; under a definite signal the
 * round closes as `failed` (回应判断), which is the round write path's rule,
 * not the adapter's.
 */
export type RoundVerdict = 'replied' | 'ignored' | 'silent' | 'failed';

/**
 * 自动续跑 (Auto-continue) as a structured task action: "this task is not done,
 * wake me again". Prose that says "I will continue" has no execution face;
 * only this action does. It is part of the one round result — the output shape
 * is still zero or more pending replies plus one round result — and the round
 * write path decides what to land (a continue record and one more wake) and
 * when the per-epoch round cap pauses it.
 */
export type RoundTaskAction = 'continue_task' | 'transfer_task';

/**
 * The structured transfer target. A `transfer_task` action names the member the
 * current assignee hands the task to; the write path validates that it is
 * another live Agent member of the same channel. Like `continue_task`, it is
 * part of the one round result, never a body sentence.
 */
export interface RoundTaskTransfer {
  member_id: string;
}

/**
 * How a round ended, when the adapter knows it was not an ordinary completion.
 * The iteration cap (迭代上限) is an adapter-side fact: the adapter stopped
 * because its iteration budget ran out, not because it had nothing more to say,
 * so the partial conclusion it produced is still a conclusion. It is a field of
 * the round result, not a second output: the seam still answers with zero or
 * more pending replies plus one round result.
 *
 * The human interrupt (人类中断) is not stated here — it belongs to the run's
 * cancellation, which is the orchestration's fact, not the adapter's.
 */
export type RoundFinishReason = 'iteration-limit';

/**
 * The seam's output. `replies` holds zero or more bodies the adapter wants
 * persisted; the round's write path lands at most one target message per
 * round (一轮 ↔ 至多一条 target 消息), so only the first pending reply is
 * committed here. Multi-reply streaming belongs to the AG-UI ticket.
 *
 * `detail` is the adapter's readable diagnostic for the round (a failure
 * reason today); it is folded into the round outcome's readable `reason` and
 * never replaces the status.
 *
 * `finishedReason` states how the round ended when it was not a normal
 * completion. Absent means the round ran to completion; a `failed` verdict
 * without it closes as the error finished reason.
 */
export interface RoundResult {
  verdict: RoundVerdict;
  replies: readonly string[];
  detail?: string;
  finishedReason?: RoundFinishReason;
  /**
   * The structured task action this round requests, if any. A body that merely
   * says "I will continue" or "please take over" never counts as one.
   */
  taskAction?: RoundTaskAction;
  /**
   * The target of a `transfer_task` action. It is ignored for every other
   * action; a missing / invalid id is a structured refusal, not a round failure.
   */
  taskTransferMemberId?: string;
  /**
   * The verifier round's structured conclusion (D4.3): `pass` advances to the
   * next SOP step, `fail` retries the same step within `max_attempts`. Prose in
   * `replies` never decides it; absent means the verifier did not answer the
   * protocol and the run fails with a readable reason.
   */
  sopVerdict?: 'pass' | 'fail';
}

export interface RoundProvider {
  /**
   * `true` when the adapter settles its round after the delivery call returns
   * (the scripted `delay` behaviour today, a long model call later). The write
   * path then returns without waiting; the round still closes exactly once.
   */
  readonly deferred: boolean;
  /** The adapter's name, for the one startup line that says which face is live. */
  readonly name: string;
  runRound(input: RoundInput): Promise<RoundResult>;
}
