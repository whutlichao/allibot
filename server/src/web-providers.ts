import {
  WEB_PROVIDERS,
  type CredentialStatus,
  type WebProvider,
  type WebProviderCredentialView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import type { RoundWebSearchHit } from './agent-seam.js';
import { ApiFailure } from './api-error.js';
// `providers.ts` owns the shared primitives (the one consent row and the mask)
// and imports this module back for the reading. The two use each other only
// inside function bodies, so the module cycle has no initializer dependency.
import { confirmRemoteConsent, maskKey } from './providers.js';

/**
 * 联网 provider 凭据 (D6 / D7 / D11, ADR 0010): the five credential providers,
 * the two human-face write paths, the masked reading, the one per-provider wire
 * table and the one resolution order T4's tool assembly consumes.
 *
 * This is the one place in the repository that stores a plaintext secret. The
 * boundary ADR 0010 draws is kept by shape: nothing here hands a credential
 * value to a reading — `api_key_mask` is `maskKey`'s form, and the value only
 * leaves through the resolution result the round adapter uses.
 */

/** The provider named first in the resolution order (D6). */
export const WEB_SEARCH_PROVIDER_ENV = 'allibot_WEB_SEARCH_PROVIDER';

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function textField(value: unknown, key: string): string {
  const raw = asRecord(value)?.[key];
  return typeof raw === 'string' ? raw : '';
}

/** One provider's search request, as the provider's own wire shape expects it. */
export interface WebProviderCall {
  url: string;
  init: RequestInit;
}

/**
 * One provider's facts (D6 / D7, ADR 0010 §4) gathered on one row: where its
 * search endpoint is, which environment variables override the endpoint and
 * carry the key, what request its wire shape expects, and how its answer reads
 * back as hits. This table is the whole per-provider surface — a provider is
 * one row here — so the five below can never drift out of step with each other.
 */
interface WebProviderWire {
  /** The endpoint override's environment variable (D7). */
  baseUrlEnv: string;
  /** The endpoint used when no override is set (D7). */
  defaultBaseUrl: string;
  /** The credential's environment fallback (ADR 0010 §4). */
  credentialEnv: string;
  search(baseUrl: string, query: string, apiKey: string): WebProviderCall;
  hits(payload: unknown): RoundWebSearchHit[];
}

const WEB_PROVIDER_WIRE: Readonly<Record<WebProvider, WebProviderWire>> = {
  brave: {
    baseUrlEnv: 'allibot_WEB_BRAVE_BASE_URL',
    defaultBaseUrl: 'https://api.search.brave.com',
    credentialEnv: 'allibot_WEB_BRAVE_API_KEY',
    search: (baseUrl, query, apiKey) => ({
      url: `${baseUrl}/res/v1/web/search?q=${encodeURIComponent(query)}`,
      init: {
        method: 'GET',
        headers: { accept: 'application/json', 'x-subscription-token': apiKey },
      },
    }),
    hits: (payload) =>
      asArray(asRecord(asRecord(payload)?.['web'])?.['results']).map((entry) => ({
        title: textField(entry, 'title'),
        url: textField(entry, 'url'),
        snippet: textField(entry, 'description'),
      })),
  },
  tavily: {
    baseUrlEnv: 'allibot_WEB_TAVILY_BASE_URL',
    defaultBaseUrl: 'https://api.tavily.com',
    credentialEnv: 'allibot_WEB_TAVILY_API_KEY',
    search: (baseUrl, query, apiKey) => ({
      url: `${baseUrl}/search`,
      init: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ query }),
      },
    }),
    hits: (payload) =>
      asArray(asRecord(payload)?.['results']).map((entry) => ({
        title: textField(entry, 'title'),
        url: textField(entry, 'url'),
        snippet: textField(entry, 'content'),
      })),
  },
  perplexity: {
    baseUrlEnv: 'allibot_WEB_PERPLEXITY_BASE_URL',
    defaultBaseUrl: 'https://api.perplexity.ai',
    credentialEnv: 'allibot_WEB_PERPLEXITY_API_KEY',
    search: (baseUrl, query, apiKey) => ({
      url: `${baseUrl}/chat/completions`,
      init: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: 'sonar', messages: [{ role: 'user', content: query }] }),
      },
    }),
    // Perplexity answers with one synthesized completion, not a hit list: the
    // first choice's content is the answer and the first citation its url.
    hits: (payload) => {
      const root = asRecord(payload) ?? {};
      const answer = asRecord(asArray(root['choices'])[0]);
      const content = textField(asRecord(answer?.['message']), 'content');
      if (content.length === 0) {
        return [];
      }
      const citation = asArray(root['citations'])[0];
      return [{
        title: 'perplexity',
        url: typeof citation === 'string' ? citation : '',
        snippet: content,
      }];
    },
  },
  jina: {
    baseUrlEnv: 'allibot_WEB_JINA_BASE_URL',
    defaultBaseUrl: 'https://api.jina.ai',
    credentialEnv: 'allibot_WEB_JINA_API_KEY',
    search: (baseUrl, query, apiKey) => ({
      url: `${baseUrl}/search?q=${encodeURIComponent(query)}`,
      init: {
        method: 'GET',
        headers: { accept: 'application/json', authorization: `Bearer ${apiKey}` },
      },
    }),
    hits: (payload) =>
      asArray(asRecord(payload)?.['data']).map((entry) => ({
        title: textField(entry, 'title'),
        url: textField(entry, 'url'),
        snippet: textField(entry, 'description') || textField(entry, 'content'),
      })),
  },
  exa: {
    baseUrlEnv: 'allibot_WEB_EXA_BASE_URL',
    defaultBaseUrl: 'https://api.exa.ai',
    credentialEnv: 'allibot_WEB_EXA_API_KEY',
    search: (baseUrl, query, apiKey) => ({
      url: `${baseUrl}/search`,
      init: {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({ query }),
      },
    }),
    hits: (payload) =>
      asArray(asRecord(payload)?.['results']).map((entry) => ({
        title: textField(entry, 'title'),
        url: textField(entry, 'url'),
        snippet: textField(entry, 'text'),
      })),
  },
};

/** The environment variable a provider's key falls back to (ADR 0010 §4). */
export function webProviderCredentialEnv(provider: WebProvider): string {
  return WEB_PROVIDER_WIRE[provider].credentialEnv;
}

/**
 * A web provider's endpoint: the override wins, trailing slashes stripped (D7).
 * The override exists so a test can point a call at an in-process fake provider;
 * production does not use it to switch providers.
 */
export function webProviderBaseUrl(provider: WebProvider, env: NodeJS.ProcessEnv): string {
  const wire = WEB_PROVIDER_WIRE[provider];
  const override = env[wire.baseUrlEnv];
  const base = override === undefined || override.trim().length === 0
    ? wire.defaultBaseUrl
    : override.trim();
  return base.replace(/\/+$/, '');
}

/** One provider's search request: the URL and the init its own wire shape expects (D6 / D7). */
export function webProviderSearchCall(
  provider: WebProvider,
  baseUrl: string,
  query: string,
  apiKey: string,
): WebProviderCall {
  return WEB_PROVIDER_WIRE[provider].search(baseUrl, query, apiKey);
}

/** One provider's answer as the three hit fields the model reads (D13). */
export function webProviderHits(
  provider: WebProvider,
  payload: unknown,
): RoundWebSearchHit[] {
  return WEB_PROVIDER_WIRE[provider].hits(payload);
}


/** 路径里的 web provider 参数；不在五家内是 400，不是 404。 */
export function parseWebProviderParam(value: string): WebProvider {
  const provider = WEB_PROVIDERS.find((candidate) => candidate === value);
  if (provider === undefined) {
    throw ApiFailure.validation(
      `provider 必须是五家之一：${WEB_PROVIDERS.join(' / ')}`,
      { field: 'provider', value },
    );
  }
  return provider;
}

/** `PUT /api/web-providers/{provider}/credential` 的请求体。 */
export interface WebProviderCredentialInput {
  apiKey: string;
  isDefault: 0 | 1;
}

/**
 * Parse the credential body `{api_key, is_default?}`. `api_key` and
 * `is_default` are the complete state of the row, so an absent `is_default`
 * reads as 0 rather than "keep whatever is stored".
 */
export function parseWebProviderCredential(body: unknown): WebProviderCredentialInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('请求体必须是对象');
  }
  const record = body as Record<string, unknown>;
  const unknown = Object.keys(record).find(
    (key) => key !== 'api_key' && key !== 'is_default',
  );
  if (unknown !== undefined) {
    throw ApiFailure.validation(`未知字段：${unknown}`, { field: unknown });
  }
  const apiKey = record['api_key'];
  if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
    throw ApiFailure.validation('api_key 必须是非空字符串', { field: 'api_key' });
  }
  const rawDefault = record['is_default'];
  if (rawDefault !== undefined && rawDefault !== 0 && rawDefault !== 1) {
    throw ApiFailure.validation('is_default 必须是 0 或 1', { field: 'is_default' });
  }
  return { apiKey, isDefault: rawDefault === 1 ? 1 : 0 };
}

interface StoredCredential {
  api_key: string;
  is_default: number;
}

function readStoredCredential(
  db: Database.Database,
  provider: WebProvider,
): StoredCredential | null {
  const row = db
    .prepare('SELECT api_key, is_default FROM web_provider_credential WHERE provider = ?')
    .get(provider) as StoredCredential | undefined;
  return row ?? null;
}

/** 一个 provider 的确认行；返回时间戳，未确认返回 null。 */
export function readWebProviderConsent(
  db: Database.Database,
  provider: WebProvider,
): string | null {
  const row = db
    .prepare(
      `SELECT confirmed_at FROM remote_consent_scope
        WHERE scope_kind = 'web' AND scope_id = ?`,
    )
    .get(provider) as { confirmed_at: string } | undefined;
  return row?.confirmed_at ?? null;
}

/** The human-face form of one provider's stored credential: mask only. */
function credentialView(
  db: Database.Database,
  provider: WebProvider,
  env: NodeJS.ProcessEnv,
): WebProviderCredentialView {
  // One row read per provider: the row is the mask's source, the default flag
  // and — when it exists — the reason the status is `present`; only a provider
  // with no row needs the environment fallback looked at.
  const stored = readStoredCredential(db, provider);
  const status: CredentialStatus =
    stored !== null || credentialFromEnv(provider, env) !== null ? 'present' : 'missing';
  return {
    provider,
    credential_env: webProviderCredentialEnv(provider),
    credential_status: status,
    // The one mask formatter, so the reading and `maskSecret`'s masking inside
    // arbitrary text can never disagree about what a masked key looks like.
    api_key_mask: stored === null ? null : maskKey(stored.api_key),
    is_default: stored?.is_default === 1 ? 1 : 0,
    receiver: webProviderBaseUrl(provider, env),
    confirmed_at: readWebProviderConsent(db, provider),
  };
}

/** The five providers in the fixed order, each with its masked reading. */
export function webProviderCredentialViews(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
): WebProviderCredentialView[] {
  return WEB_PROVIDERS.map((provider) => credentialView(db, provider, env));
}

/**
 * Save one provider's key and, in the same transaction, the `('web', provider)`
 * consent row (D11). Repeating the call is the same fact: the credential row is
 * updated in place and the first confirmation instant is kept.
 *
 * `is_default = 1` clears every other default first, inside this same
 * transaction, so the partial unique index never trips.
 */
export function writeWebProviderCredential(
  db: Database.Database,
  provider: WebProvider,
  input: WebProviderCredentialInput,
  env: NodeJS.ProcessEnv,
): WebProviderCredentialView {
  const write = db.transaction((): void => {
    if (input.isDefault === 1) {
      db.prepare(
        `UPDATE web_provider_credential SET is_default = 0
          WHERE is_default = 1 AND provider <> ?`,
      ).run(provider);
    }
    const existing = db
      .prepare('SELECT created_at FROM web_provider_credential WHERE provider = ?')
      .get(provider) as { created_at: string } | undefined;
    const now = new Date().toISOString();
    if (existing === undefined) {
      db.prepare(
        `INSERT INTO web_provider_credential
           (provider, api_key, is_default, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      ).run(provider, input.apiKey, input.isDefault, now, now);
    } else {
      // `created_at` is the first write of this provider and never moves; the
      // demoted previous default keeps its own timestamps.
      db.prepare(
        `UPDATE web_provider_credential SET api_key = ?, is_default = ?, updated_at = ?
          WHERE provider = ?`,
      ).run(input.apiKey, input.isDefault, now, provider);
    }
    // Saving a key is also the tell-once row: one call, both facts.
    confirmRemoteConsent(db, 'web', provider);
  });
  write();
  return credentialView(db, provider, env);
}

/** 单独确认：没换 key 也能补 `('web', provider)` 行，重复调用保留首次时间。 */
export function confirmWebProviderConsent(
  db: Database.Database,
  provider: WebProvider,
  env: NodeJS.ProcessEnv,
): WebProviderCredentialView {
  confirmRemoteConsent(db, 'web', provider);
  return credentialView(db, provider, env);
}

/** One provider's key and where it came from (ADR 0010 §4). */
export interface WebProviderCredential {
  value: string;
  source: 'db' | 'env';
}

/** A provider's key from the process environment, or null when unset / blank. */
function credentialFromEnv(provider: WebProvider, env: NodeJS.ProcessEnv): string | null {
  const raw = env[webProviderCredentialEnv(provider)];
  return raw === undefined || raw.trim().length === 0 ? null : raw;
}

/**
 * A provider's credential value: the stored row first, the environment
 * variable as the fallback (ADR 0010 §4). The value is for the round adapter
 * only — no reading path calls this and renders the value.
 */
export function webProviderCredentialValue(
  db: Database.Database,
  provider: WebProvider,
  env: NodeJS.ProcessEnv,
): WebProviderCredential | null {
  const stored = readStoredCredential(db, provider);
  if (stored !== null) {
    return { value: stored.api_key, source: 'db' };
  }
  const value = credentialFromEnv(provider, env);
  return value === null ? null : { value, source: 'env' };
}

/**
 * The slice of the round's MCP face the fallback reads (D9): the servers the
 * round actually connected and their tool names. `RoundMcpContext` is
 * assignable to it, so the round code passes its own face without a cast.
 */
export interface WebSearchMcpFace {
  readonly servers: readonly {
    readonly name: string;
    readonly tools: readonly { readonly name: string }[];
  }[];
}

/** The one MCP server name the credential-free fallback accepts (D9). */
const EXA_MCP_SERVER = 'exa';

/**
 * `exa` MCP 回退 (D9): a server named **exactly** `exa`, connected for this
 * round, with a search-ish tool in its list (the first match by name). Near
 * misses (`exa-search`, `exa2`, `my-exa`) never count, and no `('web','exa')`
 * row is needed — the round's `('mcp', server)` consent already governs it.
 */
export function exaMcpFallback(mcp: WebSearchMcpFace | null): {
  server: 'exa';
  tool: string;
  call: string;
} | null {
  const server = mcp?.servers.find((candidate) => candidate.name === EXA_MCP_SERVER);
  const tool = server?.tools.find((candidate) => /search/i.test(candidate.name));
  if (tool === undefined) {
    return null;
  }
  return { server: EXA_MCP_SERVER, tool: tool.name, call: `mcp:${EXA_MCP_SERVER}/${tool.name}` };
}

/** The three verdicts of the one resolution order (D6 / D9): 「能否用、用哪家」. */
export type WebSearchResolution =
  | {
      kind: 'provider';
      provider: WebProvider;
      /** For the round adapter only: never logged, never rendered. */
      api_key: string;
      api_key_source: 'db' | 'env';
      base_url: string;
      chosen_by: 'env-provider' | 'default' | 'order';
    }
  | { kind: 'mcp'; server: 'exa'; tool: string; call: string }
  | {
      kind: 'unusable';
      reason: 'provider-missing' | 'credential-missing' | 'consent-missing';
      /** The provider a step stopped at, or null when none was configured. */
      provider: WebProvider | null;
      credential_env: string | null;
    };

function unusable(
  reason: 'provider-missing' | 'credential-missing' | 'consent-missing',
  provider: WebProvider | null,
): WebSearchResolution {
  return {
    kind: 'unusable',
    reason,
    provider,
    credential_env: provider === null ? null : webProviderCredentialEnv(provider),
  };
}

/** The provider the process environment names, or null when it names none of the five. */
function namedWebProvider(env: NodeJS.ProcessEnv): WebProvider | null {
  const raw = env[WEB_SEARCH_PROVIDER_ENV];
  const name = raw?.trim() ?? '';
  return WEB_PROVIDERS.find((candidate) => candidate === name) ?? null;
}

/** The provider holding the one stored default, if any. */
function defaultWebProvider(db: Database.Database): WebProvider | null {
  const row = db
    .prepare('SELECT provider FROM web_provider_credential WHERE is_default = 1')
    .get() as { provider: string } | undefined;
  return WEB_PROVIDERS.find((candidate) => candidate === row?.provider) ?? null;
}

/** The fact that stopped one candidate: what an unusable resolution reports. */
interface WebProviderStop {
  reason: 'credential-missing' | 'consent-missing';
  provider: WebProvider;
}

/**
 * The one resolution order (D6), whose only caller is T4's tool assembly:
 *
 * 1. the provider named by `allibot_WEB_SEARCH_PROVIDER`;
 * 2. the stored default row;
 * 3. the configured providers in the fixed order `brave` → `tavily` →
 *    `perplexity` → `jina` → `exa`;
 * 4. the credential-free `exa` MCP fallback (D9).
 *
 * A provider is usable only when it has a credential (stored row first,
 * environment fallback) **and** its `('web', provider)` row exists; an
 * unconfirmed provider is unusable, not silently skipped into a working call
 * (D8). A step that names or holds a provider without a usable credential
 * falls through to the next step — the name is a preference, not a hard
 * failure — and an unusable resolution reports the first fact that stopped a
 * candidate, so the reason names what is missing.
 */
export function resolveWebSearch(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  mcp: WebSearchMcpFace | null,
): WebSearchResolution {
  let stop: WebProviderStop | null = null;

  /** This candidate's verdict: either the chosen provider or why it stopped. */
  const attempt = (
    provider: WebProvider,
    chosenBy: 'env-provider' | 'default' | 'order',
  ): { chosen: WebSearchResolution } | WebProviderStop => {
    const credential = webProviderCredentialValue(db, provider, env);
    if (credential === null) {
      return { reason: 'credential-missing', provider };
    }
    if (readWebProviderConsent(db, provider) === null) {
      return { reason: 'consent-missing', provider };
    }
    return {
      chosen: {
        kind: 'provider',
        provider,
        api_key: credential.value,
        api_key_source: credential.source,
        base_url: webProviderBaseUrl(provider, env),
        chosen_by: chosenBy,
      },
    };
  };

  // 1. The provider the process environment names. An unknown name is not a
  // provider and is read as "none named": a process env value cannot be
  // refused at a request, and failing every web call over a typo would be a
  // worse trade than falling back to the stored facts.
  const named = namedWebProvider(env);
  if (named !== null) {
    const tried = attempt(named, 'env-provider');
    if ('chosen' in tried) {
      return tried.chosen;
    }
    stop = tried;
  }

  // 2. The stored default row (at most one, by the partial unique index).
  const storedDefault = defaultWebProvider(db);
  if (storedDefault !== null && storedDefault !== named) {
    const tried = attempt(storedDefault, 'default');
    if ('chosen' in tried) {
      return tried.chosen;
    }
    stop ??= tried;
  }

  // 3. The configured providers, in the fixed order that is also the reading
  // order: brave → tavily → perplexity → jina → exa.
  for (const provider of WEB_PROVIDERS) {
    if (provider === named || provider === storedDefault) {
      continue;
    }
    if (webProviderCredentialValue(db, provider, env) === null) {
      continue;
    }
    const tried = attempt(provider, 'order');
    if ('chosen' in tried) {
      return tried.chosen;
    }
    stop ??= tried;
  }

  // 4. The credential-free fallback.
  const fallback = exaMcpFallback(mcp);
  if (fallback !== null) {
    return { kind: 'mcp', ...fallback };
  }

  // 5. Nothing usable: report the first fact that stopped a candidate.
  return stop === null ? unusable('provider-missing', null) : unusable(stop.reason, stop.provider);
}
