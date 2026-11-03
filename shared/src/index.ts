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
 * The Agent configuration as the human face returns it. `member` holds the
 * identity; `agent_config` holds everything below `created_at`.
 */
export interface AgentView {
  id: string;
  kind: 'agent';
  display_name: string;
  avatar_slot: number;
  deleted_at: string | null;
  created_at: string;
  role: string;
  model: string | null;
  system_prompt: string;
  enabled: number;
  context_window: number;
  compression_threshold: number;
  max_iterations: number;
  auto_claim: number;
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

/**
 * The workspace settings as the human face returns them. All three are config
 * values (never usage facts), and the backend database is the single source of
 * truth: the frontend reads the same `locale` the backend renders with.
 */
export interface WorkspaceSettingsView {
  locale: 'zh-CN';
  density: 'comfortable' | 'compact';
  theme: 'light' | 'dark' | 'system';
}

/** A member of a channel (or any target), as the completion and panel views read it. */
export interface TargetMemberView {
  id: string;
  kind: 'owner' | 'agent';
  display_name: string;
  avatar_slot: number;
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
 * A message as the human face returns it. `author_display_name` and
 * `author_avatar_slot` are write-time snapshots, so a renamed or soft-deleted
 * author still renders. `attachments` is always empty until the attachments
 * ticket binds drafts; the storage path of an attachment never reaches here.
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
  attachments: unknown[];
}
