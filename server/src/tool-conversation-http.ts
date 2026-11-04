import { maskSecret } from './providers.js';

/**
 * The wire half both provider conversations share (D3 / D5 / D9): one POST of
 * one JSON body, bounded by the call's own timeout, with a provider failure
 * stated as a readable reason and the credential masked out of it.
 *
 * A conversation adapter keeps only what differs — its tool definitions, its
 * response reading and its result echo. Two adapters that drift on the timeout
 * wording or on masking an error body would drift on the round's own failure
 * diagnostics; one helper keeps that impossible.
 */

/** One request, plus the facts the failure copy needs. */
export interface PostJsonRequest {
  fetch: typeof fetch;
  /** The round's resolved provider base URL: the only origin a call may reach. */
  baseUrl: string;
  /** The adapter's own endpoint path, appended to the base URL. */
  path: string;
  headers: Record<string, string>;
  body: unknown;
  /** The credential the request carries; masked out of any error body. */
  credential: string;
  timeoutMs: number;
  /** The provider's name in the failure copy (`anthropic`, `openai`). */
  provider: string;
}

/**
 * Send one JSON request and read the JSON answer. Every failure throws: the
 * timeout names the provider and the bound, a non-2xx answer names the status
 * and the masked body, and both are the round adapter's existing failure path.
 */
export async function postJson(request: PostJsonRequest): Promise<unknown> {
  const url = requestUrl(request.baseUrl, request.path);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await request
      .fetch(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(request.body),
        signal: controller.signal,
      })
      .catch((error: unknown) => {
        // The single call's own timeout is a provider-chain failure (D9): name
        // it, so the round reason says "timed out" rather than the platform's
        // bare abort wording.
        if (controller.signal.aborted) {
          throw new Error(`${request.provider} request timed out after ${request.timeoutMs}ms`);
        }
        throw error;
      });
    if (!response.ok) {
      // Mask before truncating: a 500-character cut could otherwise leave an
      // unmasked prefix of the credential in the reason.
      const body = await response.text().catch(() => '');
      const masked = maskSecret(body, request.credential);
      throw new Error(
        `${request.provider} responded ${response.status}${
          masked.length > 0 ? `: ${masked.slice(0, 500)}` : ''
        }`,
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The one outbound URL a call may use: the round's resolved base URL plus the
 * adapter's own fixed path. The credential travels in this request's header, so
 * a URL that leaves the base URL's origin is a programmer error, never a call.
 */
function requestUrl(baseUrl: string, path: string): string {
  const url = new URL(`${baseUrl}${path}`);
  if (url.origin !== new URL(baseUrl).origin) {
    throw new Error(`provider request must stay on the configured base URL: ${url.origin}`);
  }
  return url.toString();
}

/** The one record guard both adapters read a provider payload with. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
