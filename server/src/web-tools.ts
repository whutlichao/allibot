import type { WebAccessTier } from '@allibot/shared';
import type Database from 'better-sqlite3';
import type {
  RoundMcpContext,
  RoundPermissionFace,
  RoundWebFace,
  RoundWebFetchResult,
  RoundWebSearchResult,
  WebFetchRequest,
  WebSearchRequest,
} from './agent-seam.js';
import { maskSecret } from './providers.js';
import type { ToolGate } from './tool-gate.js';
import {
  resolveWebSearch,
  webProviderHits,
  webProviderSearchCall,
  type WebSearchResolution,
} from './web-providers.js';

/**
 * 联网工具 (D5 / D8 / D10 / D13): the two calls a round's web face performs —
 * `web_search` through the one provider resolution and `fetch` as the host
 * process GETting the target URL — plus the one failure that is not a tool
 * result: `web_search` with no usable provider / consent throws, which is what
 * closes the round failed at the call point (D8).
 *
 * Two disciplines keep the boundaries from the spec:
 *
 * - both calls pass the one tool gate **before any socket** (ADR 0007): a
 *   `permission_rule` row on `web_search` or `fetch` is never inert, an `ask`
 *   waits for the human in the usual 600-second batch, and a denial is a tool
 *   result, not a round failure;
 * - `fetch` carries **no provider key and no credential header of any kind**: it
 *   is a plain GET of the scheme + host + path the model asked for. Only
 *   `web_search` resolves a provider.
 * - The credential is read per call and never kept: the resolution runs inside
 *   `search`, so a rotated key takes effect without a restart and the value
 *   lives no longer than the request that carries it. Provider echoes are masked
 *   before they land in a result, and a result never contains the key.
 *
 * Both gate subjects are the same spelling: `fetch` names the URL's bare
 * **hostname** (the host `permission_rule.pattern` and `readChannelEgressHosts`
 * read, never path, query or port), and `web_search` has no subject at all, so
 * it uses the empty pattern — the existing "every call of that tool" semantic
 * (D5 / D14).
 */

/** The hit-count cap: past it a result states `capped: 'hits'` (D13). */
export const MAX_WEB_SEARCH_HITS = 8;

/** One provider call's timeout; a timeout is a tool error, never a round failure. */
const WEB_REQUEST_TIMEOUT_MS = 20_000;

/** How many same-host redirects `fetch` follows before it gives up. */
const MAX_REDIRECTS = 5;

/** How much of a provider's error body reaches the model. */
const MAX_PROVIDER_ERROR_CHARS = 300;

/**
 * `web_search` with no usable provider. It is thrown, not returned: `runToolLoop`
 * does not catch a tool's throw, so the round closes failed with this readable
 * text. Naming the missing fact is the point — a provider's env variable, the
 * provider whose `('web', provider)` row is missing, or the missing `exa` MCP
 * server (D8).
 */
export class WebToolUnavailableError extends Error {
  constructor(readonly readable: string) {
    super(readable);
    this.name = 'WebToolUnavailableError';
  }
}

/** The readable reason for an unusable resolution: what the human has to add (D8). */
function unavailableReason(
  resolution: Extract<WebSearchResolution, { kind: 'unusable' }>,
): string {
  switch (resolution.reason) {
    case 'credential-missing':
      return (
        `联网搜索不可用：provider ${resolution.provider} 没有凭据` +
        `（设置 ${resolution.credential_env} 或为该 provider 保存 key）`
      );
    case 'consent-missing':
      return (
        `联网搜索不可用：provider ${resolution.provider} 缺少一次性的 ` +
        `('web','${resolution.provider}') 远端数据流确认`
      );
    case 'provider-missing':
      return (
        '联网搜索不可用：五家 web provider 都没有凭据，' +
        '也没有已连接且带搜索工具的 exa MCP server'
      );
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One provider search: the key travels only in this request's auth header. */
async function searchViaProvider(
  resolution: Extract<WebSearchResolution, { kind: 'provider' }>,
  query: string,
  doFetch: typeof fetch,
): Promise<RoundWebSearchResult> {
  const provider = resolution.provider;
  const call = webProviderSearchCall(provider, resolution.base_url, query, resolution.api_key);
  let response: Response;
  try {
    response = await doFetch(call.url, {
      ...call.init,
      signal: AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return {
      ok: false,
      source: provider,
      error: 'provider-error',
      message: maskSecret(errorMessage(error), resolution.api_key),
    };
  }
  const body = await response.text().catch(() => '');
  if (!response.ok) {
    // A provider may echo the request — including its credential — in an error
    // body, so the excerpt is masked before it becomes a tool result.
    const excerpt = maskSecret(body.slice(0, MAX_PROVIDER_ERROR_CHARS), resolution.api_key);
    return {
      ok: false,
      source: provider,
      error: 'provider-error',
      message: `${provider} HTTP ${response.status}: ${excerpt}`,
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(body) as unknown;
  } catch {
    return {
      ok: false,
      source: provider,
      error: 'provider-error',
      message: `${provider} answered a body that is not JSON`,
    };
  }
  const hits = webProviderHits(provider, payload);
  const capped = hits.length > MAX_WEB_SEARCH_HITS;
  return {
    ok: true,
    source: provider,
    hits: capped ? hits.slice(0, MAX_WEB_SEARCH_HITS) : hits,
    ...(capped ? { capped: 'hits' as const } : {}),
  };
}

/** The credential-free `exa` MCP fallback (D9): one existing MCP call. */
async function searchViaMcp(
  mcp: RoundMcpContext,
  resolution: Extract<WebSearchResolution, { kind: 'mcp' }>,
  query: string,
): Promise<RoundWebSearchResult> {
  const source = `exa-mcp:${resolution.call}`;
  const result = await mcp.callTool(resolution.server, resolution.tool, { query });
  if (!result.ok) {
    return {
      ok: false,
      source,
      error: 'mcp-error',
      message: result.message ?? `${resolution.call} failed: ${result.error ?? 'tool-error'}`,
    };
  }
  return { ok: true, source, content: result.content ?? '' };
}

/**
 * The URL `fetch` may GET: absolute `http` / `https` only, and never one that
 * carries its own user info — `http://user:pass@host/` would send an
 * `Authorization` header the host-only gate never saw, which is exactly the
 * "no credential header of any kind" boundary this call keeps. Anything refused
 * here is a tool error before the gate and before a socket.
 */
function httpUrl(raw: string): URL | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return null;
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return null;
  }
  return url.host.length === 0 ? null : url;
}

/** The `Location` of a redirect response, or null when this response is final. */
function redirectLocation(response: Response): string | null {
  if (![301, 302, 303, 307, 308].includes(response.status)) {
    return null;
  }
  const location = response.headers.get('location');
  return location === null || location.length === 0 ? null : location;
}

/**
 * One `fetch`: gate on the host, then GET it from the host process with no
 * credential of any kind.
 *
 * A redirect whose bare hostname is the one the gate approved is followed (at
 * most `MAX_REDIRECTS`), after the same URL guard the initial target passed; a
 * redirect to a different host is a failure result and is **not** followed
 * (2026-11-05 decision): the approved subject was the host in the gate, so
 * silently reading another one would widen it. A completed response is a result
 * whatever its status code.
 */
async function fetchPage(
  request: WebFetchRequest,
  gate: ToolGate,
  doFetch: typeof fetch,
): Promise<RoundWebFetchResult> {
  const target = httpUrl(request.url);
  if (target === null) {
    return {
      ok: false,
      error: 'invalid-url',
      message: 'fetch takes an absolute http or https URL',
    };
  }
  // D5 / D14: the subject is the bare hostname — the same spelling #71's
  // container allowlist reads off the same rule rows — so neither the port nor
  // a path / query reaches an approval record.
  const host = target.hostname;
  const authorized = await gate.authorize({
    tool_name: 'fetch',
    pattern: host,
    arguments: { host },
  });
  if (authorized === 'denied') {
    return {
      ok: false,
      error: 'denied',
      host,
      message: 'the tool gate denied this fetch; nothing was requested',
    };
  }
  let current = target;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let response: Response;
    try {
      response = await doFetch(current, {
        method: 'GET',
        redirect: 'manual',
        headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.8' },
        signal: AbortSignal.timeout(WEB_REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      return { ok: false, error: 'request-failed', host, message: errorMessage(error) };
    }
    const location = redirectLocation(response);
    if (location !== null) {
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return {
          ok: false,
          error: 'request-failed',
          host,
          status: response.status,
          message: 'the redirect names a URL this process cannot parse',
        };
      }
      // Every redirect target passes the same guard as the initial URL before
      // it is followed: `Location: http://user:pw@same-host/` would otherwise
      // make `fetch` send a credential header for a host the gate never
      // approved one for, and the host comparison alone would let it through.
      const guarded = httpUrl(next.href);
      if (guarded === null) {
        return {
          ok: false,
          error: 'invalid-url',
          host,
          status: response.status,
          message:
            'the redirect names a URL this call never requests: only absolute http / https URLs without user info are fetched',
        };
      }
      // The comparison is the spelling the gate authorized — the bare hostname
      // — so a redirect can never carry the call to a host the approval did not
      // name (D5 / D14).
      if (guarded.hostname !== host) {
        return {
          ok: false,
          error: 'cross-host-redirect',
          host,
          status: response.status,
          message: `redirected to another host (${guarded.hostname}); a cross-host redirect is never followed`,
        };
      }
      current = guarded;
      continue;
    }
    try {
      return { ok: true, host, status: response.status, content: await response.text() };
    } catch (error) {
      return { ok: false, error: 'request-failed', host, message: errorMessage(error) };
    }
  }
  return {
    ok: false,
    error: 'request-failed',
    host,
    message: `more than ${MAX_REDIRECTS} redirects`,
  };
}

export interface RoundWebOptions {
  db: Database.Database;
  env: NodeJS.ProcessEnv;
  /** The effective 联网档 the assembly resolved (D1). */
  tier: WebAccessTier;
  /** The round's tool gate, built from the same target context as the workspace's. */
  gate: ToolGate;
  /** The round's MCP assembly; the `exa` fallback reads it and nothing else. */
  mcp: RoundMcpContext | null;
  /** The HTTP client; the production default is the process's own `fetch`. */
  fetch?: typeof fetch;
}

/**
 * The round's web face. Both calls ask the round's tool gate first; `search`
 * then resolves the one provider order per call (an unusable resolution throws
 * `WebToolUnavailableError`, D8) and an unusable `fetch` is impossible by
 * construction — it needs no provider at all.
 */
export function createRoundWebFace(options: RoundWebOptions): RoundWebFace {
  const doFetch = options.fetch ?? fetch;
  const permission: RoundPermissionFace = {
    mode: options.gate.mode,
    check: (request) => options.gate.check(request),
    authorize: (request) => options.gate.authorize(request),
  };
  return {
    tier: options.tier,
    permission,
    async search(request: WebSearchRequest): Promise<RoundWebSearchResult> {
      // D3 / D5.5: `web_search` is a tool like every other one, so it asks the
      // same gate before anything leaves this process. An `ask` blocks here for
      // the human exactly like a file or shell call; a denial is a result and
      // never reaches the resolution at all.
      const authorized = await options.gate.authorize({
        tool_name: 'web_search',
        pattern: '',
        arguments: { query: request.query },
      });
      if (authorized === 'denied') {
        return {
          ok: false,
          source: 'tool-gate',
          error: 'denied',
          message: 'the tool gate denied this web_search; nothing was requested',
        };
      }
      const resolution = resolveWebSearch(options.db, options.env, options.mcp);
      if (resolution.kind === 'unusable') {
        throw new WebToolUnavailableError(unavailableReason(resolution));
      }
      if (resolution.kind === 'mcp') {
        if (options.mcp === null) {
          // `exaMcpFallback` only answers `mcp` for a non-null face; stating it
          // is a guard, not a state the assembly can produce.
          throw new WebToolUnavailableError(
            '联网搜索不可用：解析出 exa MCP 回退，但本轮没有 MCP face',
          );
        }
        return await searchViaMcp(options.mcp, resolution, request.query);
      }
      return await searchViaProvider(resolution, request.query, doFetch);
    },
    async fetch(request: WebFetchRequest): Promise<RoundWebFetchResult> {
      return await fetchPage(request, options.gate, doFetch);
    },
  };
}
