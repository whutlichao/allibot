import type { PermissionMode } from '@allibot/shared';
import type Database from 'better-sqlite3';
import {
  requestApproval,
  type RegisterApprovalInput,
} from './approvals.js';
import { tFromDb } from './copy.js';
import {
  checkPermission,
  classifyToolName,
  type PermissionDecision,
  type PermissionRequest,
  type TargetPermissionContext,
} from './permissions.js';

/**
 * 工具闸门 (#44 / D5.5 / D5.6): the one object the file tools (and the later
 * shell / MCP adapters) ask before executing. `check` is the pure decision
 * preview; `authorize` applies it and waits for a human decision when the
 * answer is `ask`.
 *
 * A denied call is a `DENIED` tool result, not a round error: the adapter
 * continues. A timed-out batch throws so the round closes failed with a
 * readable reason (the approval row has already been closed `failed`).
 */
export interface ToolGate {
  readonly mode: PermissionMode;
  check(request: PermissionRequest): PermissionDecision;
  authorize(request: PermissionRequest): Promise<'allow' | 'denied'>;
}

export interface ToolGateOptions {
  db: Database.Database;
  /** The target-context permission facts. */
  permission: TargetPermissionContext;
  replyId: string;
  /** `round` for an ordinary round, `team-assignment` for a sub-round. */
  contextKind: 'round' | 'team-assignment' | 'sop';
  /** The assignment / SOP run id; null for an ordinary round. */
  contextId: string | null;
}

export function createToolGate(options: ToolGateOptions): ToolGate {
  const { db, permission, replyId, contextKind, contextId } = options;
  return {
    mode: permission.effective,
    check: (request) => checkPermission(db, permission, previewRequest(request)),
    authorize: async (request) => {
      const decided = checkPermission(db, permission, request);
      if (decided.decision === 'allow') {
        return 'allow';
      }
      if (decided.decision === 'deny') {
        return 'denied';
      }
      const registration: RegisterApprovalInput = {
        replyId,
        toolCallId: request.tool_call_id,
        targetId: permission.targetId,
        contextKind,
        contextId,
        memberId: permission.memberId,
        toolName: request.tool_name,
        pattern: request.pattern,
        arguments: {
          tool_name: request.tool_name,
          ...(request.arguments ?? {}),
        },
      };
      const outcome = await requestApproval(db, registration);
      if (outcome === 'timeout') {
        throw new ApprovalTimeoutError(tFromDb(db, 'permission.approval.timeout'));
      }
      return outcome === 'approved' ? 'allow' : 'denied';
    },
  };
}

/**
 * The preview has no resolved real path: a file tool's subject is already a
 * root-relative path (the file tools enforce the root hard boundary first), so
 * `trusted-writes` may classify it as a root-internal write. The executable
 * path passes the resolver's own flag instead.
 */
function previewRequest(request: PermissionRequest): PermissionRequest {
  if (request.root_internal_write !== undefined) {
    return request;
  }
  const reading = classifyToolName(request.tool_name);
  if (reading?.tool_class !== 'write') {
    return request;
  }
  const segments = request.pattern.split('/');
  if (request.pattern.startsWith('/') || segments.includes('..')) {
    return { ...request, root_internal_write: false };
  }
  return { ...request, root_internal_write: true };
}

/** The readable round failure for a batch that timed out (already stored failed). */
export class ApprovalTimeoutError extends Error {
  constructor(readonly readable: string) {
    super(readable);
    this.name = 'ApprovalTimeoutError';
  }
}
