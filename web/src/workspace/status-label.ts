import {
  AGENT_PROVIDERS,
  t,
  type AgentProvider,
  type AgentStatus,
  type Locale,
  type OfflineReason,
  type RemoteDataFlowReadView,
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
 * The provider prefix of a `provider:model` identifier. The web only parses
 * the shared identifier shape; the credential variable name itself always
 * comes from `/api/remote-data-flow`, never from a frontend table.
 */
export function providerFromModel(model: string | null): AgentProvider | null {
  if (model === null) {
    return null;
  }
  const separator = model.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const provider = model.slice(0, separator);
  return AGENT_PROVIDERS.find((candidate) => candidate === provider) ?? null;
}

/** The provider's credential variable, read from the backend's flow reading. */
export function credentialEnvFor(
  model: string | null,
  remoteDataFlow: RemoteDataFlowReadView | undefined,
): string | null {
  const provider = providerFromModel(model);
  if (provider === null || remoteDataFlow === undefined) {
    return null;
  }
  return (
    remoteDataFlow.providers.find((entry) => entry.provider === provider)
      ?.credential_env ?? null
  );
}

/**
 * 「模型密钥从环境变量读」这条点名事实。{env} 只来自 `/api/remote-data-flow`
 * 的 providers[].credential_env（与后端 round.credential.missing 同源）；
 * 未配置模型或读数未到时，只说密钥从哪里来，不编造 provider 与变量名。
 */
export function credentialEnvFact(
  locale: Locale,
  model: string | null,
  remoteDataFlow: RemoteDataFlowReadView | undefined,
): string {
  const credentialEnv = credentialEnvFor(model, remoteDataFlow);
  return credentialEnv === null
    ? t(locale, 'workspace.agentDetail.credential.envUnknown')
    : t(locale, 'workspace.agentDetail.credential.env', { credential_env: credentialEnv });
}

/**
 * 「为什么未启用」的可读原因。原因本身是后端给的可用性事实
 * （model-missing / consent-missing / credential-missing），前端只按取值
 * 取词条，不从状态点反推。缺凭证时点名 `/api/remote-data-flow` 给出的环境
 * 变量；未确认告知时指向 Agent 详情里的确认入口。
 */
export function offlineReasonLabel(
  locale: Locale,
  reason: OfflineReason,
  model: string | null = null,
  remoteDataFlow: RemoteDataFlowReadView | undefined = undefined,
): string {
  switch (reason) {
    case 'disabled':
      return t(locale, 'workspace.member.reason.disabled');
    case 'model-missing':
      return t(locale, 'workspace.member.reason.modelMissing');
    case 'consent-missing':
      return t(locale, 'workspace.member.reason.consentMissing');
    case 'credential-missing': {
      const credentialEnv = credentialEnvFor(model, remoteDataFlow);
      return credentialEnv === null
        ? t(locale, 'workspace.member.reason.credentialMissingNoEnv')
        : t(locale, 'workspace.member.reason.credentialMissing', {
            credential_env: credentialEnv,
          });
    }
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
