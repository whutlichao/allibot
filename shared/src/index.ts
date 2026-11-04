import type { WorkspaceSettingsView } from './settings.js';

export type ApiErrorCode =
  | 'validation_failed'
  | 'not_found'
  | 'conflict'
  | 'version_mismatch'
  | 'internal_error';

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    details?: unknown;
  };
}

export function apiError(
  code: ApiErrorCode,
  message: string,
  details?: unknown,
): ApiErrorBody {
  return details === undefined
    ? { error: { code, message } }
    : { error: { code, message, details } };
}

/** Providers the M1 `provider:model` identifier accepts. */
export const AGENT_PROVIDERS = ['anthropic', 'openai'] as const;
export type AgentProvider = (typeof AGENT_PROVIDERS)[number];

/**
 * Whether the provider credential the Agent needs is readable from the
 * environment right now. It is a status enum, never a credential: the value
 * of the environment variable never reaches the human face.
 */
export const CREDENTIAL_STATUSES = ['present', 'missing'] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * The four status point states (D1.12 / R1 词条 26). `working` is a
 * process-local in-flight fact, `error` is the latest stored non-merged round
 * outcome being failed, and `offline` is derived from availability.
 */
export const AGENT_STATUSES = ['online', 'working', 'error', 'offline'] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

/**
 * The availability facts that make an Agent 未启用 (offline): its own enabled
 * switch is off, no model is configured, the provider's remote-data-flow
 * consent is missing, or the provider's credential is missing from the
 * environment. They are enum values, never credential values.
 */
export const OFFLINE_REASONS = [
  'disabled',
  'model-missing',
  'consent-missing',
  'credential-missing',
] as const;
export type OfflineReason = (typeof OFFLINE_REASONS)[number];

/**
 * One status point as the human face returns it. `offline_reason` is the
 * availability fact that keeps the Agent offline and is `null` in every other
 * state; it never carries a credential.
 */
export interface StatusPointView {
  status: AgentStatus;
  offline_reason: OfflineReason | null;
}

/**
 * The Agent configuration as the human face returns it. `member` holds the
 * identity; `agent_config` holds everything below `created_at`.
 *
 * `credential_status` reports whether the environment variable the model's
 * provider reads is set — "present" or "missing" — and never carries the key
 * itself: the database is not a secret store (D1.10). `status` and
 * `offline_reason` are the status point, computed from backend facts only; the
 * visual avatar slot is a separate contract and status never moves it.
 */
export interface AgentView extends StatusPointView {
  id: string;
  kind: 'agent';
  display_name: string;
  avatar_slot: number;
  deleted_at: string | null;
  created_at: string;
  role: string;
  model: string | null;
  credential_status: CredentialStatus;
  system_prompt: string;
  enabled: number;
  context_window: number;
  compression_threshold: number;
  max_iterations: number;
  auto_claim: number;
  /**
   * The raw Agent-level workspace backend override (D5.3). `null` means follow
   * the channel's backend; it is never resolved into the channel value here.
   */
  workspace_backend: WorkspaceBackend | null;
  /**
   * The raw Agent-level permission-mode override (D5.5). `null` means follow
   * the channel; a DM has no channel, so the default `ask-writes` applies.
   */
  permission_mode: PermissionMode | null;
  /**
   * The mode this Agent resolves to without a channel context: its override or
   * the product default. A targeted context reads the per-target effective
   * mode from `TargetMemberView.permission_mode` instead.
   */
  effective_permission_mode: PermissionMode;
  /**
   * The Agent home path, derived from `member_id` and the process-level global
   * layer root (D5.2). It is read-only: no database column stores it, so a
   * restart with the same home root returns the same value.
   */
  home_path: string;
}

/**
 * The three prompt sections of the rules base (D5.2 / D3.7), in assembly
 * order. The first and third are files the host reads; the middle one is the
 * stored `agent_config.system_prompt`.
 */
export const AGENT_RULE_SECTIONS = ['global', 'system_prompt', 'project'] as const;
export type AgentRuleSectionKind = (typeof AGENT_RULE_SECTIONS)[number];

/** One prompt section as the read-only rules face reports it. */
export interface AgentRuleSectionView {
  kind: AgentRuleSectionKind;
  /** The file the host reads; null for the stored prompt and an absent project. */
  path: string | null;
  /** Whether anything exists at the path / in the stored field. */
  present: boolean;
  /** Whether the host could read it as text. */
  readable: boolean;
  /** The section text the round would receive; null when missing / unreadable. */
  content: string | null;
}

/** `GET /api/agents/{id}/rules` — the effective rules, read-only (D2.3). */
export interface AgentRulesView {
  agent_id: string;
  channel_id: string | null;
  home_path: string;
  order: readonly AgentRuleSectionKind[];
  /** The three sections, exactly in `order`. */
  sections: AgentRuleSectionView[];
}

/**
 * One remote provider's consent state plus the data surfaces that leave the
 * machine when an Agent on it answers. The list is the consent copy itself: it
 * names what leaves, never a connection parameter or a credential.
 */
export interface RemoteDataFlowView {
  provider: AgentProvider;
  /** The environment variable this provider reads its credential from. */
  credential_env: string;
  credential_status: CredentialStatus;
  /** The receiving end of the model call. */
  receiver: string;
  confirmed_at: string | null;
}

/**
 * The three remote data-flow consent kinds (#47 / v21). `model` is M1's
 * provider consent; `mcp` confirms one remote MCP server by name; `docker`
 * confirms one image reference before a pull. All three store only the scope
 * and when it was confirmed — never a URL, command, env value or credential.
 */
export const REMOTE_CONSENT_SCOPE_KINDS = ['model', 'mcp', 'docker'] as const;
export type RemoteConsentScopeKind = (typeof REMOTE_CONSENT_SCOPE_KINDS)[number];

/** One consent row as the human face reads it: scope and time only. */
export interface RemoteConsentScopeView {
  scope_kind: RemoteConsentScopeKind;
  scope_id: string;
  confirmed_at: string;
}

/** `GET /api/remote-data-flow`'s body. */
export interface RemoteDataFlowReadView {
  /** The data surfaces that leave the machine on a remote model call (D4.2). */
  data_surfaces: string[];
  providers: RemoteDataFlowView[];
  /** Confirmed remote MCP servers (name + time only; D6.1). */
  mcp_consents: RemoteConsentScopeView[];
  /** Confirmed Docker image references (reference + time only; D5.3). */
  docker_consents: RemoteConsentScopeView[];
}

/**
 * `POST /api/remote-data-flow/{provider}/consent`'s body. Confirming twice is
 * the same fact, so `confirmed_at` keeps the first confirmation.
 */
export interface RemoteConsentView {
  provider: AgentProvider;
  confirmed_at: string;
}

/**
 * MCP 声明 (MCP Server) entry: one server inside the Agent-home `mcp.json`
 * (D6.1). `env_names` holds environment variable names only — the values are
 * read from the host process environment at spawn time and never stored in
 * the file or the database.
 */
export const MCP_TRANSPORTS = ['stdio', 'http', 'sse'] as const;
export type McpTransport = (typeof MCP_TRANSPORTS)[number];

export interface McpServerEntry {
  name: string;
  transport: McpTransport;
  enabled: boolean;
  /** stdio only: the executable and its arguments. */
  command?: string;
  args?: string[];
  /** http / sse only: the endpoint the host process connects to. */
  url?: string;
  /** Environment variable names to pass to the server process (never values). */
  env_names?: string[];
}

/** `GET` / `PUT /api/agents/{id}/mcp`'s body. */
export interface AgentMcpView {
  agent_id: string;
  /** The one file both management blocks and runtime assembly read. */
  path: string;
  present: boolean;
  /** Normalized entries; empty when the file is missing or invalid. */
  entries: McpServerEntry[];
  /** The exact file text (empty when missing) for the raw textarea. */
  raw: string;
  /** Readable whole-file diagnostic; null when the declaration is usable. */
  diagnostic: string | null;
}

/**
 * Skill 安装来源 (D6.3): a local directory, an uploaded zip, or an import from
 * the external CLI's `~/.agents/skills/` landing directory. All three go
 * through the same installer and store the same metadata shape.
 */
export const SKILL_SOURCES = ['directory', 'zip', 'agents-skills'] as const;
export type SkillSource = (typeof SKILL_SOURCES)[number];

/**
 * One installed Agent-level skill (v21 `skill` row). Bytes never live in the
 * database: they are at `~/.allibot/agents/<member_id>/skills/<name>/`.
 * `content_hash` is the lowercase SHA-256 of the normalized file manifest.
 */
export interface SkillView {
  id: string;
  member_id: string;
  name: string;
  content_hash: string;
  enabled: boolean;
  source: SkillSource;
  created_at: string;
  updated_at: string;
}

/** `GET /api/agents/{id}/skills` — the member's installed skills, by name. */
export interface AgentSkillsView {
  agent_id: string;
  /** The derived Agent home the bytes live under (D5.2). */
  home_path: string;
  skills: SkillView[];
}

/** `GET /api/agents/{id}/skills/{name}` — metadata plus the SKILL.md text. */
export interface AgentSkillDetailView {
  agent_id: string;
  skill: SkillView;
  /** The exact SKILL.md UTF-8 text, for the config-text presentation. */
  markdown: string;
}

/** One `~/.agents/skills/<name>/` entry as the read-only candidate scan sees it. */
export interface SkillCandidateView {
  name: string;
  path: string;
  importable: boolean;
  /** The member already has a row with this name (enabled or disabled). */
  installed: boolean;
  /** Readable reason when `importable` is false; null otherwise. */
  reason: string | null;
}

/** `GET /api/agents/{id}/skill-candidates` — the candidate landing directory. */
export interface AgentSkillCandidatesView {
  agent_id: string;
  source: string;
  /** False when `~/.agents/skills/` is absent; the app never creates it. */
  available: boolean;
  candidates: SkillCandidateView[];
}

/** One item of `POST /api/agents/{id}/skills/import-all`. */
export interface SkillImportItemView {
  name: string;
  status: 'imported' | 'skipped' | 'failed';
  reason: string | null;
  skill: SkillView | null;
}

/** `POST /api/agents/{id}/skills/import-all` — one failure never blocks the rest. */
export interface SkillImportAllView {
  agent_id: string;
  results: SkillImportItemView[];
  imported: number;
  skipped: number;
  failed: number;
}

/** A successful install: first create vs same-hash replay (D2.4). */
export interface SkillInstallView {
  skill: SkillView;
  created: boolean;
}

/**
 * The two channel topologies. `team` is an explicit opt-in (D3.1): a DM has no
 * mode field and is always autonomous.
 */
export const CHANNEL_MODES = ['autonomous', 'team'] as const;
export type ChannelMode = (typeof CHANNEL_MODES)[number];

/**
 * The two workspace backends (D5.3). `local` opens the restricted file tools;
 * `docker` is the per-target container backend. The channel carries the
 * default and an Agent may override it (NULL = follow the channel).
 */
export const WORKSPACE_BACKENDS = ['local', 'docker'] as const;
export type WorkspaceBackend = (typeof WORKSPACE_BACKENDS)[number];

/**
 * Why a target context's workspace is unavailable. The reason is a stable code
 * the human face can render; the readable copy is the catalog's job.
 */
export const WORKSPACE_STATUS_REASONS = [
  'workspace-root-missing',
  'docker-unavailable',
  'docker-image-missing',
  'docker-consent-missing',
] as const;
export type WorkspaceStatusReason = (typeof WORKSPACE_STATUS_REASONS)[number];

/**
 * The channel's workspace configuration (D5.1 / D5.3 / D5.4): the one shared
 * project root, the default backend and the explicit local-shell switch. The
 * root is the canonical realpath the write path stored.
 */
export interface ChannelWorkspaceView {
  root: string | null;
  backend: WorkspaceBackend;
  allow_local_shell: 0 | 1;
}

/**
 * The workspace availability of one target context (D5.7). It is a target
 * fact, not a global status point: the same Agent can be available in one
 * channel and unavailable in another. `reason` is `null` exactly when the
 * workspace is available.
 */
export interface WorkspaceStatusView {
  backend: WorkspaceBackend;
  available: boolean;
  reason: WorkspaceStatusReason | null;
}

/**
 * The process-level Docker reading (#49 / D2.2): whether the daemon is
 * reachable and the configured image is local, and the image reference. It is
 * not a credential reading — registry credentials are out of M2 scope — and it
 * is not a per-target fact.
 */
export interface DockerRuntimeView {
  available: boolean;
  image: string;
  reason: WorkspaceStatusReason | null;
}

/** `GET /api/workspace.workspace_runtime` (D2.2). */
export interface WorkspaceRuntimeView {
  docker: DockerRuntimeView;
}

/**
 * The three product permission modes (D5.5). There is no bypass / "don't ask"
 * level: those names are refused at the write path, not stored.
 */
export const PERMISSION_MODES = ['read-only', 'ask-writes', 'trusted-writes'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/** The rule behaviour; merged as deny > ask > allow. */
export const PERMISSION_BEHAVIORS = ['allow', 'deny', 'ask'] as const;
export type PermissionBehavior = (typeof PERMISSION_BEHAVIORS)[number];

/** The two rule scopes: a channel's set or one Agent's set. */
export const PERMISSION_SCOPE_KINDS = ['channel', 'agent'] as const;
export type PermissionScopeKind = (typeof PERMISSION_SCOPE_KINDS)[number];

/** One stored permission rule as the human face reads it. */
export interface PermissionRuleView {
  id: string;
  scope_kind: PermissionScopeKind;
  scope_id: string;
  tool_name: string;
  /** Case-sensitive glob; the empty string matches every call of the tool. */
  pattern: string;
  behavior: PermissionBehavior;
  created_at: string;
  updated_at: string;
}

/**
 * One rule in a full replacement (`PUT .../permission-rules`) or in an
 * approval decision's `rules?`. The scope comes from the URL / the approval's
 * target context, so a row never repeats it.
 */
export interface PermissionRuleInput {
  tool_name: string;
  pattern: string;
  behavior: PermissionBehavior;
}

/** The effective mode in one target context plus the raw Agent override. */
export interface PermissionReading {
  /** The mode this target context resolves to: override or channel default. */
  permission_mode: PermissionMode;
  /** The raw Agent override; `null` means follow the channel / default. */
  permission_mode_override: PermissionMode | null;
}

/** One tool call inside an approval request (arguments already masked). */
export interface ApprovalToolCallView {
  tool_call_id: string;
  tool_name: string;
  /** The pattern subject: file path / command / stable MCP argument JSON. */
  pattern: string;
  /** The batch ordinal this call joined. */
  batch: number;
  /** Masked readable arguments; secret-shaped fields are `***`. */
  arguments: Record<string, unknown>;
  requested_at: string;
}

/** One human decision on one tool call. */
export interface ApprovalDecisionView {
  tool_call_id: string;
  confirmed: boolean;
  decided_at: string;
}

export type ApprovalStatus = 'pending' | 'confirmed' | 'denied' | 'failed' | 'expired';
export type ApprovalContextKind = 'round' | 'team-assignment' | 'sop';

/** One batch of calls: the Nth ask reopens a resolved reply as a new batch. */
export interface ApprovalBatchView {
  batch: number;
  requested_at: string;
  tool_calls: ApprovalToolCallView[];
  decisions: ApprovalDecisionView[];
}

/** One approval request as the human face reads it. */
export interface ApprovalView {
  reply_id: string;
  target_id: string | null;
  context_kind: ApprovalContextKind;
  context_id: string | null;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
  tool_calls: ApprovalToolCallView[];
  decisions: ApprovalDecisionView[];
  /** The same calls grouped by batch, oldest first. */
  batches: ApprovalBatchView[];
}

/** The approval decision request body. */
export interface ApprovalDecisionInput {
  tool_call_id: string;
  confirmed: boolean;
  /** A complete replacement of the rules for the approval's scope. */
  rules?: PermissionRuleInput[];
}

/**
 * The team reading of a channel: the configured leader and whether that
 * configuration is currently usable. `reason` is the same readable reason the
 * round side would use; `status='invalid'` never falls back to autonomous.
 * Autonomous channels carry `leader_member_id: null` and a valid status.
 */
export interface ChannelTeamView {
  leader_member_id: string | null;
  status: 'valid' | 'invalid';
  reason: string | null;
}

/**
 * The team configuration write body. Omitted fields mean "unchanged"; an
 * explicit `null` leader is the only nullable value and only clears the leader.
 */
export interface ChannelConfigPatch {
  mode?: ChannelMode;
  team_leader_member_id?: string | null;
  /** `null` clears the project root; a string is validated and canonicalized. */
  workspace_root?: string | null;
  workspace_backend?: WorkspaceBackend;
  /** The explicit local-shell switch (#46 / D5.4): exactly 0 or 1. */
  allow_local_shell?: 0 | 1;
  /** The channel's permission default; it has no override (rules do). */
  permission_mode?: PermissionMode;
}

/**
 * A channel as the human face returns it. `archived_at` lets the client split
 * the active segment from the archived one; a deleted channel never appears.
 */
export interface ChannelView {
  id: string;
  name: string;
  description: string;
  mode: ChannelMode;
  /** The team reading; present on autonomous channels too (with no leader). */
  team: ChannelTeamView;
  /** The one shared project root and the channel's workspace defaults. */
  workspace: ChannelWorkspaceView;
  /**
   * The channel's permission default. A member's effective mode is this value
   * unless the Agent carries an override.
   */
  permission_mode: PermissionMode;
  response_budget_limit: number;
  archived_at: string | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A member of a channel (or any target), as the completion and panel views read it. */
export interface TargetMemberView {
  id: string;
  kind: 'owner' | 'agent';
  display_name: string;
  avatar_slot: number;
  /**
   * The target context's workspace availability. It is a target-level fact
   * repeated on each member reading (D5.7); an Agent's own backend override
   * still decides that row's `backend`.
   */
  workspace_status: WorkspaceStatusView;
  /**
   * The channel's explicit local-shell switch in this target context (#46).
   * It is channel-only (no Agent override); a DM / no-channel target reads 0.
   */
  allow_local_shell: 0 | 1;
  /** The member's effective mode in this target context (D5.5). */
  permission_mode: PermissionMode;
}

/**
 * The Agent side of a DM, as the left column reads it. `deleted_at` is the
 * whole archived-DM rule: a non-null value moves the DM into the archived
 * segment and makes it read-only, and the backend still serves its history.
 */
export interface DmPeerView {
  id: string;
  display_name: string;
  avatar_slot: number;
  deleted_at: string | null;
}

/**
 * A DM as `GET /api/dms` returns it: the target id (the thread id) and its one
 * Agent. The list is the DM face's whole read model — there is no per-DM
 * endpoint, because a DM is a target and its history reads through
 * `GET /api/targets/{id}/messages`.
 */
export interface DmView {
  id: string;
  peer: DmPeerView;
}

/**
 * The message kinds. `system` records a fact no conversation participant said
 * (join-through, task create/change, reminder due, auto-continue, task
 * pointer) and is written by backend paths only.
 */
export const MESSAGE_KINDS = ['human', 'agent', 'system'] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/**
 * One mention range as the write path recorded it. `start` / `end` are UTF-16
 * code-unit offsets into the message body, and `member_id` is the member the
 * parser resolved at write time — neither is recomputed after a rename.
 */
export interface MessageMentionView {
  member_id: string;
  start: number;
  end: number;
}

/**
 * One attachment as a message read returns it. The bytes live in the data
 * directory; the storage path that names them inside it never reaches the
 * human face, so this view carries metadata only.
 */
export interface AttachmentView {
  id: string;
  filename: string;
  mime: string;
  size: number;
}

/**
 * A message as the human face returns it. `author_display_name` and
 * `author_avatar_slot` are write-time snapshots, so a renamed or soft-deleted
 * author still renders. `attachments` lists what the message write bound; an
 * unbound upload draft never appears here.
 */
export interface MessageView {
  id: string;
  target_id: string;
  seq: number;
  kind: MessageKind;
  author_member_id: string;
  author_display_name: string;
  author_avatar_slot: number;
  body: string;
  created_at: string;
  task_ref: string | null;
  task_pointer: string | null;
  client_message_id: string | null;
  mentions: MessageMentionView[];
  attachments: AttachmentView[];
}

/**
 * The five task statuses. The legal move set is backend-fixed (the server's
 * `TASK_STATUS_TRANSITIONS`) and travels with every task payload as
 * `allowed_transitions`; the frontend never keeps a copy of the table.
 */
export const TASK_STATUSES = ['todo', 'in_progress', 'in_review', 'done', 'closed'] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

/**
 * A task as the board and the detail read return it. The row is mutable
 * (title / status / assignee); its thread messages stay append-only.
 * `allowed_transitions` is the backend's answer for the current status,
 * `message_count` counts every message in the task thread and `unread_count`
 * counts the thread messages the owner has not read (the pointer chip's N).
 */
export interface TaskView {
  id: string;
  channel_id: string;
  target_id: string;
  title: string;
  status: TaskStatus;
  assignee_member_id: string | null;
  claimed_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * The owning channel's mode, derived on read. `mode` is not copied into the
   * task row (D3.1); a task resolves its topology through its channel.
   */
  channel_mode: ChannelMode;
  allowed_transitions: TaskStatus[];
  message_count: number;
  unread_count: number;
}

/**
 * The four team_run statuses (D3.3): a leader round opens `running` and closes
 * `completed` / `failed`; a trigger that would have delivered to an unusable
 * leader lands `invalid-leader` with both timestamps written. These are field
 * values, not a new status vocabulary for rounds.
 */
export const TEAM_RUN_STATUSES = ['running', 'completed', 'failed', 'invalid-leader'] as const;
export type TeamRunStatus = (typeof TEAM_RUN_STATUSES)[number];

/** The four team_assignment states; `budget-exhausted` consumes no jump. */
export const TEAM_ASSIGNMENT_STATES = [
  'running',
  'completed',
  'failed',
  'budget-exhausted',
] as const;
export type TeamAssignmentState = (typeof TEAM_ASSIGNMENT_STATES)[number];

/**
 * One TeamAssign record (#39 writes these; #38 reads them as an empty nested
 * list). It is a run record, never a message.
 */
export interface TeamAssignmentView {
  id: string;
  team_run_id: string;
  target_id: string;
  task_id: string | null;
  member_id: string;
  state: TeamAssignmentState;
  jump_consumed: 0 | 1;
  reply_excerpt: string | null;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * The `team_assignment` SSE frame (#39 / D2.5): the final state of one
 * assignment, live-only. `occurred_at` is the assignment's `finished_at`; the
 * payload never carries the full member output, only the stored excerpt.
 */
export interface TeamAssignmentFrame {
  team_run_id: string;
  assignment_id: string;
  target_id: string;
  task_id: string | null;
  member_id: string;
  state: TeamAssignmentState;
  jump_consumed: 0 | 1;
  reply_excerpt: string | null;
  reason: string | null;
  occurred_at: string;
}

/**
 * One leader team round as `GET /api/targets/{id}/team-runs` returns it. A task
 * target's run carries `task_id`; a channel target's run carries NULL. The
 * nested assignments are the run's member work, never messages.
 */
export interface TeamRunView {
  id: string;
  target_id: string;
  channel_id: string;
  task_id: string | null;
  leader_member_id: string;
  status: TeamRunStatus;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
  assignments: TeamAssignmentView[];
}

/**
 * The three Plan item statuses (D4.1). They are a field vocabulary of
 * `plan_task`, not the task five-state and not a new object: a Plan item never
 * appears on the task board.
 */
export const PLAN_TASK_STATUSES = ['pending', 'in_progress', 'completed'] as const;
export type PlanTaskStatus = (typeof PLAN_TASK_STATUSES)[number];

/**
 * One item of a member's Plan work list. `position` is the append order inside
 * its run; it is never rendered as a task status.
 */
export interface PlanTaskView {
  id: string;
  plan_run_id: string;
  title: string;
  status: PlanTaskStatus;
  position: number;
  created_at: string;
  updated_at: string;
}

/**
 * One Plan run as `GET /api/targets/{id}/plans` returns it: one member's plan
 * in one target, with the complete current task list. A Plan is not a target
 * and not a message.
 */
export interface PlanRunView {
  id: string;
  target_id: string;
  member_id: string;
  created_at: string;
  updated_at: string;
  tasks: PlanTaskView[];
}

/**
 * The `plan_update` SSE frame (D2.5): `tasks` is the run's complete current
 * list, so a subscriber replaces its copy instead of applying a delta. The
 * stream is live-only and frames are never replayed.
 */
export interface PlanUpdateFrame {
  plan_run_id: string;
  target_id: string;
  member_id: string;
  tasks: PlanTaskView[];
  occurred_at: string;
}

/**
 * One step of an SOP definition (D4.2): the ordered executor -> verifier unit
 * with its retry ceiling. The definition is immutable in M2, so this shape is
 * never rewritten after the definition is created.
 */
export interface SopStepDefinition {
  title: string;
  description: string;
  executor_member_id: string;
  verifier_member_id: string;
  max_attempts: number;
}

/** The bounds the definition write enforces (D4.2). */
export const SOP_MIN_STEPS = 1;
export const SOP_MAX_STEPS = 20;
export const SOP_MAX_ATTEMPTS = 5;

/** The five SOP run phases (D4.2); `pending` is already created but not started. */
export const SOP_RUN_PHASES = ['pending', 'running', 'awaiting', 'completed', 'failed'] as const;
export type SopRunPhase = (typeof SOP_RUN_PHASES)[number];

/**
 * An SOP definition as `POST /api/sops` and the two reads return it. It is a
 * channel-scoped ordered step list named by `(channel_id, name)`; there is no
 * edit or delete face.
 */
export interface SopDefinitionView {
  id: string;
  channel_id: string;
  name: string;
  steps: SopStepDefinition[];
  created_at: string;
}

/** The `POST /api/sops` body: one immutable definition on one channel. */
export interface SopDefinitionCreate {
  channel_id: string;
  name: string;
  steps: SopStepDefinition[];
}

/**
 * The run's `state` column: an opaque JSON snapshot the executor maintains
 * (D4.2 / D4.3 names the current step, attempt, step excerpts, `waiting_on`
 * and error). #41 stores the initial empty snapshot; #45 owns the live shape.
 */
export type SopRunStateSnapshot = Record<string, unknown>;

/** What an `awaiting` run waits for (D4.2): the verifier verdict or an approval. */
export type SopRunWaitingOn = 'verifier' | 'approval';

/**
 * One step's recorded progress inside the run's `state` snapshot (D4.2): the
 * latest attempt's executor / verifier output excerpt plus the structured
 * verifier verdict. The run keeps one entry per step that has started.
 */
export interface SopRunStepSnapshot {
  index: number;
  title: string;
  executor_member_id: string;
  verifier_member_id: string;
  /** How many attempts this step has run (1-based; the latest one). */
  attempts: number;
  executor_excerpt: string | null;
  verifier_excerpt: string | null;
  verifier_verdict: 'pass' | 'fail' | null;
  started_at: string;
  finished_at: string | null;
}

/**
 * One SOP run as the start response and the run reads return it. `phase`,
 * `current_step`, `attempt` and `waiting_on` are the read-model projection of
 * the stored snapshot; `state` is the raw snapshot. It is not a task, a
 * message, a team run or a second target.
 */
export interface SopRunView {
  id: string;
  definition_id: string;
  channel_id: string;
  phase: SopRunPhase;
  state: SopRunStateSnapshot;
  current_step: number;
  attempt: number;
  waiting_on: SopRunWaitingOn | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

/**
 * The `sop_update` SSE frame (D2.5): published on every phase change and on
 * every step / attempt change. It names the run and its progress point; the
 * excerpt snapshot stays on `GET /api/sop-runs/{id}` (the stream is live-only).
 */
export interface SopUpdateFrame {
  sop_run_id: string;
  definition_id: string;
  phase: SopRunPhase;
  current_step: number;
  attempt: number;
  occurred_at: string;
}


/**
 * One highlight range inside a hit's text. `start` / `end` are UTF-16
 * code-unit offsets and half-open `[start, end)`, the same convention the
 * mention ranges use: the backend decides every range, the frontend only wraps
 * them.
 */
export interface SearchHighlight {
  start: number;
  end: number;
}

/**
 * A message hit: one message whose body contains the query, with the target it
 * belongs to and every occurrence of the query, not just the first.
 */
export interface MessageSearchHit {
  type: 'message';
  target_id: string;
  message_id: string;
  highlights: SearchHighlight[];
}

/**
 * A task hit: the title is the hit subject. There is no highlight range —
 * the frontend renders the hit as a whole rather than locating text itself.
 */
export interface TaskSearchHit {
  type: 'task';
  task_id: string;
  title: string;
}

/**
 * An Agent hit: the display name or the role is the hit subject. Like a task
 * hit it may carry no highlight range.
 */
export interface AgentSearchHit {
  type: 'agent';
  member_id: string;
  display_name: string;
  role: string;
}

/**
 * The three hit kinds are siblings; `type` is what the frontend renders by.
 */
export type SearchHit = MessageSearchHit | TaskSearchHit | AgentSearchHit;

/**
 * 未读 (Unread) as the workspace reads it. `unread_total` is the channel-type
 * plus dm-type sum; a task target is deliberately absent from both numbers and
 * kept in its own task payload's `unread_count`. `unread_by_target` carries
 * every visible channel and dm target, zero counts included.
 */
export interface WorkspaceUnreadView {
  unread_total: number;
  unread_by_target: Record<string, number>;
}

/**
 * 提醒 (Reminder) as the human face returns it. `due_at_local` is the fixed
 * `YYYY-MM-DDTHH:mm` wall time the owner set, interpreted in the machine's
 * local timezone; `created_at` is the UTC audit stamp. `delivered_at` is the
 * due marker (NULL = not due yet) and `missed` records a reminder the backend
 * found more than 24 hours late, which is marked but never delivered.
 */
export interface ReminderView {
  id: string;
  channel_id: string | null;
  due_at_local: string;
  text: string;
  delivered_at: string | null;
  missed: boolean;
  created_at: string;
}

/**
 * `GET /api/reminders` groups the rows by their due state: pending has no
 * delivered_at, delivered has one inside the 24-hour catch-up window, and
 * missed is a reminder found beyond that window.
 */
export interface ReminderListView {
  pending: ReminderView[];
  delivered: ReminderView[];
  missed: ReminderView[];
}

/**
 * The human row as the workspace returns it. The database holds exactly one
 * owner row (`member_single_owner`), so the reading is one object, never a
 * list.
 */
export interface OwnerView {
  id: string;
  kind: 'owner';
  display_name: string;
  avatar_slot: number;
}

/**
 * The app shell's one backend reading (D1.8 / ADR 0002). Every panel renders
 * from this same snapshot, so the frontend never keeps a second source of
 * truth.
 *
 * `agents` is the 本机 Agent list: every live Agent, not filtered by channel.
 * `channels` carries archived channels with their `archived_at`; a deleted
 * channel is absent, as are its tasks and messages. `status_points` is keyed
 * by Agent member id and answers exactly what the per-Agent read answers;
 * `settings` is the same body `GET /api/settings` returns.
 *
 * Unread is split in two: `unread_total` is the channel-type plus dm-type sum,
 * while a task-type target is counted only in its task payload's
 * `unread_count`. The reading is read-only: it writes no message, wakes no
 * member and spends no response budget.
 */
export interface WorkspaceView extends WorkspaceUnreadView {
  owner: OwnerView;
  agents: AgentView[];
  channels: ChannelView[];
  dms: DmView[];
  tasks: TaskView[];
  settings: WorkspaceSettingsView;
  status_points: Record<string, StatusPointView>;
  /** The number of `pending` approval requests (D5.6). */
  pending_approvals: number;
  /** The process-level Docker availability + image reference (D2.2 / D5.3). */
  workspace_runtime: WorkspaceRuntimeView;
}

export {
  MESSAGE_DENSITIES,
  SUPPORTED_LOCALES,
  THEMES,
  type Locale,
  type MessageDensity,
  type Theme,
  type WorkspaceSettingsView,
} from './settings.js';

export {
  RESERVED_LOCALES,
  ZH_CN,
  t,
  type Catalog,
  type CatalogEntry,
  type MessageKey,
  type MessageValues,
} from './strings/index.js';
