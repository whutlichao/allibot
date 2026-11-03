import {
  t,
  type ApprovalDecisionInput,
  type ApprovalView,
  type Locale,
} from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import {
  approvalBatchLabel,
  approvalContextLabel,
  approvalStatusLabel,
  callNeedsDecision,
  decisionForCall,
} from './approvals.ts';

export interface ApprovalPanelProps {
  /** The list reading; undefined means it has not been read yet. */
  approvals: readonly ApprovalView[] | undefined;
  /** The reply id whose detail is open; null renders the list. */
  selectedReplyId?: string | null;
  locale: Locale;
  onSelect?: (replyId: string | null) => void;
  onDecision?: (replyId: string, input: ApprovalDecisionInput) => void | Promise<void>;
}

/**
 * 审批面板 (#44 / D5.6): 列表、单条与多批历史。审批是 reply 级记录，不是消息；
 * 面板只读 `GET /api/approvals` 的读数，决策交给宿主发 `POST`，不在前端推测
 * 状态。多批历史逐批呈现调用与决策；`failed` / `expired` 是终止态，不再给
 * 决策按钮。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX。
 */
export function ApprovalPanel({
  approvals,
  selectedReplyId = null,
  locale,
  onSelect,
  onDecision,
}: ApprovalPanelProps) {
  if (approvals === undefined) {
    return createElement(
      'p',
      { className: 'workspace-panel__pending', 'data-approval-loading': 'true' },
      t(locale, 'workspace.status.loading'),
    );
  }
  const selected =
    selectedReplyId === null
      ? undefined
      : approvals.find((approval) => approval.reply_id === selectedReplyId);
  if (selectedReplyId !== null && selected === undefined) {
    return createElement(
      'div',
      { className: 'approval-panel', 'data-approval-detail': 'missing' },
      createElement(
        'button',
        {
          type: 'button',
          className: 'approval-panel__back',
          'data-action': 'approval-back',
          onClick: () => onSelect?.(null),
        },
        t(locale, 'workspace.approval.back'),
      ),
      createElement(
        'p',
        { className: 'workspace-panel__pending' },
        t(locale, 'workspace.approval.empty'),
      ),
    );
  }
  if (selected !== undefined) {
    return renderDetail(selected, locale, onSelect, onDecision);
  }
  return renderList(approvals, locale, onSelect);
}

function renderList(
  approvals: readonly ApprovalView[],
  locale: Locale,
  onSelect: ((replyId: string | null) => void) | undefined,
): ReactNode {
  if (approvals.length === 0) {
    return createElement(
      'p',
      { className: 'approval-panel__empty', 'data-approval-empty': 'true' },
      t(locale, 'workspace.approval.empty'),
    );
  }
  return createElement(
    'ul',
    { className: 'approval-panel__list', 'data-approval-list': 'true' },
    ...approvals.map((approval) =>
      createElement(
        'li',
        {
          key: approval.reply_id,
          className: 'approval-panel__row',
          'data-approval-row': 'true',
          'data-approval-reply': approval.reply_id,
          'data-approval-status': approval.status,
        },
        createElement(
          'button',
          {
            type: 'button',
            className: 'approval-panel__entry',
            'data-action': 'approval-open',
            onClick: () => onSelect?.(approval.reply_id),
          },
          createElement(
            'span',
            { className: 'approval-panel__entry-title' },
            approvalContextLabel(locale, approval.context_kind),
          ),
          createElement(
            'span',
            { className: 'approval-panel__entry-status' },
            approvalStatusLabel(locale, approval.status),
          ),
          createElement(
            'span',
            { className: 'approval-panel__entry-meta' },
            `${approval.batches.length} / ${approval.tool_calls.length}`,
          ),
        ),
      ),
    ),
  );
}

function renderDetail(
  approval: ApprovalView,
  locale: Locale,
  onSelect: ((replyId: string | null) => void) | undefined,
  onDecision:
    | ((replyId: string, input: ApprovalDecisionInput) => void | Promise<void>)
    | undefined,
): ReactNode {
  return createElement(
    'section',
    {
      className: 'approval-panel__detail',
      'data-approval-detail': approval.reply_id,
      'data-approval-status': approval.status,
    },
    createElement(
      'button',
      {
        type: 'button',
        className: 'approval-panel__back',
        'data-action': 'approval-back',
        onClick: () => onSelect?.(null),
      },
      t(locale, 'workspace.approval.back'),
    ),
    createElement(
      'h3',
      { className: 'approval-panel__title' },
      t(locale, 'workspace.approval.detail'),
    ),
    createElement(
      'dl',
      { className: 'approval-panel__facts' },
      fact('context', approvalContextLabel(locale, approval.context_kind)),
      fact('status', approvalStatusLabel(locale, approval.status)),
      fact(t(locale, 'workspace.approval.target'), approval.target_id ?? '-'),
    ),
    ...approval.batches.map((batch, index) =>
      createElement(
        'section',
        {
          key: batch.batch,
          className: 'approval-panel__batch',
          'data-approval-batch': batch.batch,
        },
        createElement(
          'h4',
          { className: 'approval-panel__batch-title' },
          approvalBatchLabel(locale, index + 1),
        ),
        ...batch.tool_calls.map((call) => {
          const isShell = call.tool_name === 'Bash';
          const decision = decisionForCall(approval, call.tool_call_id);
          const needsDecision = callNeedsDecision(approval, call.tool_call_id);
          return createElement(
            'div',
            {
              key: call.tool_call_id,
              className: 'approval-panel__call',
              'data-approval-call': call.tool_call_id,
              'data-tool-name': call.tool_name,
            },
            createElement(
              'p',
              { className: 'approval-panel__call-title' },
              createElement('strong', null, call.tool_name),
              createElement('code', { className: 'approval-panel__pattern' }, call.pattern),
            ),
            isShell
              ? createElement(
                  'div',
                  { className: 'approval-panel__shell', 'data-approval-shell': 'true' },
                  createElement(
                    'span',
                    { className: 'approval-panel__shell-label' },
                    t(locale, 'workspace.approval.shell.command'),
                  ),
                  createElement(
                    'code',
                    { className: 'approval-panel__shell-command' },
                    String(call.arguments['command'] ?? call.pattern),
                  ),
                  typeof call.arguments['cwd'] === 'string'
                    ? createElement(
                        'span',
                        { className: 'approval-panel__shell-cwd' },
                        `${t(locale, 'workspace.approval.shell.cwd')}：${call.arguments['cwd']}`,
                      )
                    : null,
                )
              : createElement(
                  'pre',
                  { className: 'approval-panel__args' },
                  JSON.stringify(call.arguments, null, 2),
                ),
            decision === null
              ? needsDecision
                ? createElement(
                    'div',
                    { className: 'approval-panel__actions' },
                    createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'approval-panel__approve',
                        'data-action': 'approval-approve',
                        'data-tool-call': call.tool_call_id,
                        onClick: () =>
                          void onDecision?.(approval.reply_id, {
                            tool_call_id: call.tool_call_id,
                            confirmed: true,
                          }),
                      },
                      t(locale, 'workspace.approval.approve'),
                    ),
                    createElement(
                      'button',
                      {
                        type: 'button',
                        className: 'approval-panel__deny',
                        'data-action': 'approval-deny',
                        'data-tool-call': call.tool_call_id,
                        onClick: () =>
                          void onDecision?.(approval.reply_id, {
                            tool_call_id: call.tool_call_id,
                            confirmed: false,
                          }),
                      },
                      t(locale, 'workspace.approval.deny'),
                    ),
                  )
                : createElement(
                    'p',
                    { className: 'approval-panel__decided' },
                    t(locale, 'workspace.approval.decided'),
                  )
              : createElement(
                  'p',
                  {
                    className: 'approval-panel__decision',
                    'data-decision': decision.confirmed ? 'approved' : 'denied',
                  },
                  decision.confirmed
                    ? t(locale, 'workspace.approval.approve')
                    : t(locale, 'workspace.approval.deny'),
                ),
          );
        }),
      ),
    ),
    approval.decisions.length > 0
      ? createElement(
          'p',
          { className: 'approval-panel__history', 'data-approval-decisions': approval.decisions.length },
          `${t(locale, 'workspace.approval.decided')}：${approval.decisions.length}`,
        )
      : null,
  );
}

function fact(field: string, value: string): ReactNode {
  return createElement(
    'div',
    { className: 'approval-panel__fact', 'data-field': field },
    createElement('dt', null, field),
    createElement('dd', null, value),
  );
}
