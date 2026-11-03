import {
  t,
  type ApprovalContextKind,
  type ApprovalStatus,
  type ApprovalView,
  type Locale,
} from '@allibot/shared';

/**
 * 审批面板的数据契约 (#44 / D5.6). An approval is a reply-scoped record, never
 * a message: the panel renders the batches and decisions of one `approval_request`
 * and submits one decision at a time. The global SSE frames only tell the shell
 * to re-read the list (live-only), so this module also parses the frame.
 */

export function approvalStatusLabel(locale: Locale, status: ApprovalStatus): string {
  switch (status) {
    case 'pending':
      return t(locale, 'workspace.approval.status.pending');
    case 'confirmed':
      return t(locale, 'workspace.approval.status.confirmed');
    case 'denied':
      return t(locale, 'workspace.approval.status.denied');
    case 'failed':
      return t(locale, 'workspace.approval.status.failed');
    case 'expired':
      return t(locale, 'workspace.approval.status.expired');
  }
}

export function approvalContextLabel(locale: Locale, kind: ApprovalContextKind): string {
  switch (kind) {
    case 'round':
      return t(locale, 'workspace.approval.context.round');
    case 'team-assignment':
      return t(locale, 'workspace.approval.context.teamAssignment');
    case 'sop':
      return t(locale, 'workspace.approval.context.sop');
  }
}

export function approvalBatchLabel(locale: Locale, index: number): string {
  return t(locale, 'workspace.approval.batch', { index });
}

/** The batch's decisions by tool_call_id, for the detail view. */
export function decisionForCall(
  approval: ApprovalView,
  toolCallId: string,
): { confirmed: boolean; decided_at: string } | null {
  return approval.decisions.find((decision) => decision.tool_call_id === toolCallId) ?? null;
}

/** Whether a tool call still waits for a decision in the current pending batch. */
export function callNeedsDecision(approval: ApprovalView, toolCallId: string): boolean {
  if (approval.status !== 'pending') {
    return false;
  }
  return decisionForCall(approval, toolCallId) === null;
}

/** The D2.5 approval frame payload; it carries no tool arguments. */
export interface ApprovalFrame {
  reply_id: string;
  context_kind: ApprovalContextKind;
  context_id: string | null;
  target_id: string | null;
  status: ApprovalStatus;
  tool_call_ids: string[];
}

const APPROVAL_STATUSES: readonly string[] = [
  'pending',
  'confirmed',
  'denied',
  'failed',
  'expired',
];
const APPROVAL_CONTEXT_KINDS: readonly string[] = ['round', 'team-assignment', 'sop'];

export function readApprovalFrame(data: Record<string, unknown>): ApprovalFrame | null {
  const replyId = data['reply_id'];
  const contextKind = data['context_kind'];
  const status = data['status'];
  const toolCallIds = data['tool_call_ids'];
  if (
    typeof replyId !== 'string' ||
    typeof contextKind !== 'string' ||
    !APPROVAL_CONTEXT_KINDS.includes(contextKind) ||
    typeof status !== 'string' ||
    !APPROVAL_STATUSES.includes(status) ||
    !Array.isArray(toolCallIds) ||
    !toolCallIds.every((id) => typeof id === 'string')
  ) {
    return null;
  }
  const contextId = data['context_id'];
  const targetId = data['target_id'];
  return {
    reply_id: replyId,
    context_kind: contextKind as ApprovalContextKind,
    context_id: typeof contextId === 'string' ? contextId : null,
    target_id: typeof targetId === 'string' ? targetId : null,
    status: status as ApprovalStatus,
    tool_call_ids: toolCallIds,
  };
}
