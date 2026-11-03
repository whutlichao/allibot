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
