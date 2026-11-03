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
 * The three availability facts that make an Agent 未启用 (offline): no model is
 * configured, the provider's remote-data-flow consent is missing, or the
 * provider's credential is missing from the environment. They are enum values,
 * never credential values.
 */
export const OFFLINE_REASONS = [
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

/** `GET /api/remote-data-flow`'s body. */
export interface RemoteDataFlowReadView {
  /** The data surfaces that leave the machine on a remote model call (D4.2). */
  data_surfaces: string[];
  providers: RemoteDataFlowView[];
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
 * A channel as the human face returns it. `archived_at` lets the client split
 * the active segment from the archived one; a deleted channel never appears.
 */
export interface ChannelView {
  id: string;
  name: string;
  description: string;
  mode: string;
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
  allowed_transitions: TaskStatus[];
  message_count: number;
  unread_count: number;
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
