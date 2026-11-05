import {
  AGENT_PROVIDERS,
  type AgentProvider,
  type CredentialStatus,
  type RemoteConsentScopeKind,
  type RemoteConsentScopeView,
  type RemoteConsentView,
  type RemoteDataFlowReadView,
  type RemoteDataFlowView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { tFromDb } from './copy.js';

/**
 * 模型 provider 的完整口径（D1.10 / D4）：`provider:model` 解析、缺凭证时读哪个
 * 环境变量、远端数据流告知的落点与读数。
 *
 * 库内不存模型密钥：凭证只在进程环境里读，进 HTTP、进程输出或事件的只有
 * 掩码或 `credential_status` 这个状态枚举。告知按 provider 写
 * `remote_consent_scope` 的 `('model', provider)` 行，只记何时确认过，不存
 * 连接参数。
 */

/** 每个 provider 读取凭证的环境变量。 */
export const PROVIDER_CREDENTIAL_ENV: Readonly<Record<AgentProvider, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
};

/**
 * 每个 provider 覆盖 API 端点的环境变量。OpenAI 兼容端点靠它改指别处（仍归
 * `openai` provider）；Anthropic 的同名覆盖不是规格条文，是实现注记里记下的
 * 测试与自托管入口。
 */
const PROVIDER_BASE_URL_ENV: Readonly<Record<AgentProvider, string>> = {
  anthropic: 'ANTHROPIC_BASE_URL',
  openai: 'OPENAI_BASE_URL',
};

/** 未覆盖端点时 provider 的默认接收方。 */
const PROVIDER_DEFAULT_BASE_URL: Readonly<Record<AgentProvider, string>> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
};

/** 解析一个 `provider:model` 标识；不合口径时返回 null。 */
export function parseModelIdentifier(
  value: string | null,
): { provider: AgentProvider; model: string } | null {
  if (value === null) {
    return null;
  }
  const separator = value.indexOf(':');
  if (separator <= 0) {
    return null;
  }
  const provider = AGENT_PROVIDERS.find((candidate) => candidate === value.slice(0, separator));
  const model = value.slice(separator + 1);
  if (provider === undefined || model.trim().length === 0) {
    return null;
  }
  return { provider, model };
}

/** 路径里的 provider 参数；不在 `{anthropic, openai}` 内是 400，不是 404。 */
export function parseProviderParam(value: string): AgentProvider {
  const provider = AGENT_PROVIDERS.find((candidate) => candidate === value);
  if (provider === undefined) {
    throw ApiFailure.validation(
      `provider must be one of: ${AGENT_PROVIDERS.join(', ')}`,
      { field: 'provider', value },
    );
  }
  return provider;
}

/**
 * 一个 provider 的凭证状态。读到的凭证值本身不离开这个进程：状态枚举是
 * 人类面唯一能看到的凭证事实。
 */
export function credentialStatus(
  provider: AgentProvider,
  env: NodeJS.ProcessEnv,
): CredentialStatus {
  return readCredential(provider, env) === null ? 'missing' : 'present';
}

/** 进程环境里的凭证值；未设置或空白视为缺凭证。 */
export function readCredential(provider: AgentProvider, env: NodeJS.ProcessEnv): string | null {
  const raw = env[PROVIDER_CREDENTIAL_ENV[provider]];
  return raw === undefined || raw.trim().length === 0 ? null : raw;
}

/** 一个 provider 实际调用的端点：环境变量覆盖优先，否则是默认接收方。 */
export function providerBaseUrl(provider: AgentProvider, env: NodeJS.ProcessEnv): string {
  const override = env[PROVIDER_BASE_URL_ENV[provider]];
  const base = override === undefined || override.trim().length === 0
    ? PROVIDER_DEFAULT_BASE_URL[provider]
    : override.trim();
  return base.replace(/\/+$/, '');
}

/**
 * Mask a credential inside arbitrary text: only the head and tail survive, so
 * a provider echoing the key back in an error cannot leak it into a round
 * reason, an HTTP response or a log line.
 */
export function maskSecret(text: string, secret: string): string {
  return secret.length === 0 ? text : text.split(secret).join(maskKey(secret));
}

/** The human-face form of a credential: a head, an ellipsis and a tail. */
function maskKey(secret: string): string {
  return secret.length <= 8 ? '…' : `${secret.slice(0, 3)}…${secret.slice(-4)}`;
}

/** 按 provider 的确认行；返回时间戳，未确认返回 null。 */
export function readProviderConsent(
  db: Database.Database,
  provider: AgentProvider,
): string | null {
  const row = db
    .prepare(
      `SELECT confirmed_at FROM remote_consent_scope
        WHERE scope_kind = 'model' AND scope_id = ?`,
    )
    .get(provider) as { confirmed_at: string } | undefined;
  return row?.confirmed_at ?? null;
}

/**
 * The first availability fact that stops a provider call. This one function is
 * read by both the real adapter (which refuses the round) and the status point
 * (which reads offline), so "the Agent is offline because X" and "the round was
 * refused because X" can never name different facts. The order is the order the
 * adapter refuses in: no model, then no consent, then no credential.
 */
export type ProviderAvailability =
  | { ok: true; provider: AgentProvider; model: string }
  | { ok: false; reason: 'model-missing' }
  | { ok: false; reason: 'consent-missing'; provider: AgentProvider }
  | {
      ok: false;
      reason: 'credential-missing';
      provider: AgentProvider;
      credentialEnv: string;
    };

/** Whether this model may call its provider right now (D1.10 / D1.12). */
export function checkProviderAvailability(
  db: Database.Database,
  model: string | null,
  env: NodeJS.ProcessEnv,
): ProviderAvailability {
  const parsed = parseModelIdentifier(model);
  if (parsed === null) {
    return { ok: false, reason: 'model-missing' };
  }
  if (readProviderConsent(db, parsed.provider) === null) {
    return { ok: false, reason: 'consent-missing', provider: parsed.provider };
  }
  if (credentialStatus(parsed.provider, env) === 'missing') {
    return {
      ok: false,
      reason: 'credential-missing',
      provider: parsed.provider,
      credentialEnv: PROVIDER_CREDENTIAL_ENV[parsed.provider],
    };
  }
  return { ok: true, provider: parsed.provider, model: parsed.model };
}

/**
 * 一次性确认：同一 provider 再确认不刷新时间戳，也不写第二行。确认记录只
 * 含「何时确认过」，不含端点、密钥或任何连接参数。
 */
export function confirmProviderConsent(
  db: Database.Database,
  provider: AgentProvider,
): RemoteConsentView {
  const consent = confirmRemoteConsent(db, 'model', provider);
  return { provider, confirmed_at: consent.confirmed_at };
}

/**
 * 通用一次性确认 (#47 / D2.3): the same `remote_consent_scope` row M1's model
 * entry writes, for the three remote data-flow kinds. Repeating the same scope
 * is the same fact and keeps the first time. Only the scope and the instant
 * are stored — never a URL, command, env value or credential.
 */
export function confirmRemoteConsent(
  db: Database.Database,
  scopeKind: RemoteConsentScopeKind,
  scopeId: string,
): RemoteConsentScopeView {
  const confirm = db.transaction((): string => {
    const existing = db
      .prepare(
        `SELECT confirmed_at FROM remote_consent_scope
          WHERE scope_kind = ? AND scope_id = ?`,
      )
      .get(scopeKind, scopeId) as { confirmed_at: string } | undefined;
    if (existing !== undefined) {
      return existing.confirmed_at;
    }
    const confirmedAt = new Date().toISOString();
    db.prepare(
      `INSERT INTO remote_consent_scope (scope_kind, scope_id, confirmed_at)
       VALUES (?, ?, ?)`,
    ).run(scopeKind, scopeId, confirmedAt);
    return confirmedAt;
  });
  return { scope_kind: scopeKind, scope_id: scopeId, confirmed_at: confirm() };
}

/** Parse the generic consent body `{scope_kind, scope_id}` (D2.3). */
export function parseConsentScope(body: unknown): {
  scopeKind: RemoteConsentScopeKind;
  scopeId: string;
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('请求体必须是对象');
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => key !== 'scope_kind' && key !== 'scope_id',
  );
  if (unknown !== undefined) {
    throw ApiFailure.validation(`未知字段：${unknown}`, { field: unknown });
  }
  const scopeKind = record['scope_kind'];
  if (scopeKind !== 'model' && scopeKind !== 'mcp' && scopeKind !== 'docker') {
    throw ApiFailure.validation('scope_kind 必须是 model / mcp / docker', {
      field: 'scope_kind',
    });
  }
  const scopeId = record['scope_id'];
  if (typeof scopeId !== 'string' || scopeId.length === 0) {
    throw ApiFailure.validation('scope_id 必须是非空字符串', { field: 'scope_id' });
  }
  if (scopeKind === 'model' && !(AGENT_PROVIDERS as readonly string[]).includes(scopeId)) {
    throw ApiFailure.validation('model 的 scope_id 必须是 anthropic / openai', {
      field: 'scope_id',
    });
  }
  return { scopeKind, scopeId };
}

/**
 * One `('docker', image_ref)` confirmation (D5.3 / D6.1). The row is the only
 * fact that allows pulling an image that is not local; it stores the scope and
 * the confirmation time only, never a registry credential.
 */
export function hasDockerConsent(db: Database.Database, imageRef: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM remote_consent_scope
        WHERE scope_kind = 'docker' AND scope_id = ?`,
    )
    .get(imageRef) as { ok: number } | undefined;
  return row !== undefined;
}

/** Every confirmed row of one kind, scope + time only. */
export function readConsentScopes(
  db: Database.Database,
  scopeKind: RemoteConsentScopeKind,
): RemoteConsentScopeView[] {
  const rows = db
    .prepare(
      `SELECT scope_kind, scope_id, confirmed_at FROM remote_consent_scope
        WHERE scope_kind = ?
        ORDER BY scope_id`,
    )
    .all(scopeKind) as RemoteConsentScopeView[];
  return rows;
}

/**
 * `GET /api/remote-data-flow` 的读数：两个 provider 的确认状态、凭证环境变量
 * 与状态、接收方，以及会离开本机的数据面清单（D4.2）。清单是告知文案本身，
 * 按库内语言偏好渲染。
 */
export function remoteDataFlowView(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
): RemoteDataFlowReadView {
  const providers: RemoteDataFlowView[] = AGENT_PROVIDERS.map((provider) => ({
    provider,
    credential_env: PROVIDER_CREDENTIAL_ENV[provider],
    credential_status: credentialStatus(provider, env),
    receiver: providerBaseUrl(provider, env),
    confirmed_at: readProviderConsent(db, provider),
  }));
  return {
    data_surfaces: [
      tFromDb(db, 'remoteFlow.surface.messageBody'),
      tFromDb(db, 'remoteFlow.surface.authorName'),
      tFromDb(db, 'remoteFlow.surface.targetName'),
      tFromDb(db, 'remoteFlow.surface.mentionedNames'),
      tFromDb(db, 'remoteFlow.surface.receiver'),
    ],
    providers,
    mcp_consents: readConsentScopes(db, 'mcp'),
    docker_consents: readConsentScopes(db, 'docker'),
  };
}
