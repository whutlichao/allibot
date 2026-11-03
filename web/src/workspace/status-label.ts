import {
  t,
  type AgentStatus,
  type Locale,
  type OfflineReason,
  type TaskStatus,
} from '@allibot/shared';

/** 状态点的可读文案；状态本身是后端事实，前端只按取值取词条。 */
export function statusLabel(locale: Locale, status: AgentStatus): string {
  switch (status) {
    case 'online':
      return t(locale, 'workspace.status.online');
    case 'working':
      return t(locale, 'workspace.status.working');
    case 'error':
      return t(locale, 'workspace.status.error');
    case 'offline':
      return t(locale, 'workspace.status.offline');
  }
}

/**
 * 「为什么未启用」的可读原因。原因本身是后端给的可用性事实
 * （model-missing / consent-missing / credential-missing），前端只按取值
 * 取词条，不从状态点反推。
 */
export function offlineReasonLabel(locale: Locale, reason: OfflineReason): string {
  switch (reason) {
    case 'model-missing':
      return t(locale, 'workspace.member.reason.modelMissing');
    case 'consent-missing':
      return t(locale, 'workspace.member.reason.consentMissing');
    case 'credential-missing':
      return t(locale, 'workspace.member.reason.credentialMissing');
  }
}

/** 任务状态的可读文案；状态机与迁移集合仍由后端持有。 */
export function taskStatusLabel(locale: Locale, status: TaskStatus): string {
  switch (status) {
    case 'todo':
      return t(locale, 'task.status.todo');
    case 'in_progress':
      return t(locale, 'task.status.inProgress');
    case 'in_review':
      return t(locale, 'task.status.inReview');
    case 'done':
      return t(locale, 'task.status.done');
    case 'closed':
      return t(locale, 'task.status.closed');
  }
}
