import { apiError } from '@allibot/shared';
import type Database from 'better-sqlite3';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ApiFailure } from './api-error.js';
import {
  maxUploadEnvelopeBytes,
  readAttachment,
  uploadAttachment,
} from './attachments.js';
import {
  archiveChannel,
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
} from './channels.js';
import {
  createAgent,
  getAgent,
  listAgents,
  softDeleteAgent,
  updateAgent,
} from './members.js';
import { appendMessage, listMessages, parseMessageRequest, parsePageQuery } from './messages.js';
import {
  joinChannel,
  listChannelMembers,
  listTargetMembers,
} from './target-members.js';

export const HOST = '127.0.0.1';

/** Upper bound on a JSON request body; agent configs are tiny. */
const MAX_BODY_BYTES = 64 * 1024;

export interface StartedServer {
  server: Server;
  port: number;
}

interface HttpContext {
  db: Database.Database;
  dataDir: string;
}

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpContext,
  ...params: string[]
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handle: Handler;
}

export async function startHttpServer(
  port: number,
  db: Database.Database,
  dataDir: string,
  options: { writeError?: (message: string, error: unknown) => void } = {},
): Promise<StartedServer> {
  const context: HttpContext = { db, dataDir };
  const writeError = options.writeError ?? defaultWriteError;
  const server = createServer((request, response) => {
    handleRequest(request, response, context).catch((error: unknown) => {
      sendFailure(response, error, writeError);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onListenError);
    server.listen(port, HOST, () => {
      server.off('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('server did not bind to a TCP port');
  }

  return { server, port: address.port };
}

const AGENT_ID = '([^/]+)';
const CHANNEL_ID = '([^/]+)';
const ATTACHMENT_ID = '([^/]+)';

const ROUTES: readonly Route[] = [
  {
    method: 'POST',
    pattern: /^\/api\/attachments$/,
    handle: async (request, response, { db, dataDir }) => {
      const uploaded = await uploadAttachment(
        dataDir,
        db,
        request.headers['content-type'],
        await readBody(request, maxUploadEnvelopeBytes(), 'attachment'),
      );
      sendJson(response, 201, { id: uploaded.id });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/attachments/${ATTACHMENT_ID}$`),
    handle: async (_request, response, { db, dataDir }, ...params) => {
      const attachment = readAttachment(dataDir, db, decodeId(params[0]));
      sendAttachment(response, attachment);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/channels$/,
    handle: async (_request, response, { db }) => {
      sendJson(response, 200, { channels: listChannels(db) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/channels$/,
    handle: async (request, response, { db }) => {
      sendJson(response, 201, createChannel(db, await readJsonBody(request)));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, getChannel(db, decodeId(params[0])));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}$`),
    handle: async (request, response, { db }, ...params) => {
      sendJson(
        response,
        200,
        updateChannel(db, decodeId(params[0]), await readJsonBody(request)),
      );
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      deleteChannel(db, decodeId(params[0]));
      response.writeHead(204);
      response.end();
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/archive$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, archiveChannel(db, decodeId(params[0])));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/members$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, { members: listChannelMembers(db, decodeId(params[0])) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/members$`),
    handle: async (request, response, { db }, ...params) => {
      const result = joinChannel(db, decodeId(params[0]), await readJsonBody(request));
      sendJson(response, 200, result);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/targets/${CHANNEL_ID}/members$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, { members: listTargetMembers(db, decodeId(params[0])) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/targets/${CHANNEL_ID}/messages$`),
    handle: async (request, response, { db }, ...params) => {
      const query = parsePageQuery(new URL(request.url ?? '/', `http://${HOST}`).searchParams);
      sendJson(response, 200, { messages: listMessages(db, decodeId(params[0]), query) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/targets/${CHANNEL_ID}/messages$`),
    handle: async (request, response, { db }, ...params) => {
      const targetId = decodeId(params[0]);
      const result = appendMessage(db, parseMessageRequest(targetId, await readJsonBody(request)));
      sendJson(response, 201, result);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/agents$/,
    handle: async (request, response, { db }) => {
      const includeDeleted = parseIncludeDeleted(new URL(request.url ?? '/', 'http://allibot').searchParams);
      sendJson(response, 200, { agents: listAgents(db, { includeDeleted }) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/agents$/,
    handle: async (request, response, { db }) => {
      const agent = createAgent(db, await readJsonBody(request));
      sendJson(response, 201, agent);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      const id = decodeId(params[0]);
      const agent = getAgent(db, id);
      if (agent === null) {
        throw ApiFailure.notFound(`agent not found: ${id}`);
      }
      sendJson(response, 200, agent);
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}$`),
    handle: async (request, response, { db }, ...params) => {
      const agent = updateAgent(db, decodeId(params[0]), await readJsonBody(request));
      sendJson(response, 200, agent);
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      softDeleteAgent(db, decodeId(params[0]));
      response.writeHead(204);
      response.end();
    },
  },
];

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpContext,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', `http://${HOST}`).pathname;

  for (const route of ROUTES) {
    if (route.method !== (request.method ?? 'GET')) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    await route.handle(request, response, context, ...match.slice(1));
    return;
  }

  // A known path with an unsupported method is still an unknown route for the
  // unified envelope; the spec only fixes the not_found shape here.
  sendJson(
    response,
    404,
    apiError('not_found', `unknown route: ${request.method ?? 'GET'} ${pathname}`),
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(request, MAX_BODY_BYTES, 'request')).toString('utf8');
  if (raw.trim().length === 0) {
    throw ApiFailure.validation('request body must be JSON');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw ApiFailure.validation('request body is not valid JSON');
  }
}

/**
 * Read a request body up to `limit` bytes. Crossing the limit is a client
 * error, and the rest of the stream is drained rather than left half-read, so
 * the client reads the envelope instead of a reset connection.
 */
async function readBody(
  request: IncomingMessage,
  limit: number,
  what: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) {
      request.resume();
      throw ApiFailure.validation(`${what} body exceeds ${limit} bytes`, { limit });
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

/**
 * Soft-deleted members stay out of every read path (Agent list, channel
 * members, mention candidates, status points, search), so `include_deleted`
 * has no effect. The flag still has to parse: an unknown value is a client
 * error rather than silently meaning "false".
 */
function parseIncludeDeleted(searchParams: URLSearchParams): boolean {
  const raw = searchParams.get('include_deleted');
  if (raw === null || raw === 'false' || raw === 'true') {
    return false;
  }
  throw ApiFailure.validation('include_deleted must be true or false');
}

/**
 * Route captures are always present; the only real failure is a malformed
 * percent-encoding, which reads as "that id does not exist".
 */
function decodeId(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    throw ApiFailure.notFound(`malformed id: ${raw ?? ''}`);
  }
}

function sendFailure(
  response: ServerResponse,
  error: unknown,
  writeError: (message: string, error: unknown) => void,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof ApiFailure) {
    sendJson(response, error.status, apiError(error.code, error.message, error.details));
    return;
  }
  writeError('unhandled request failure', error);
  sendJson(response, 500, apiError('internal_error', 'internal server error'));
}

function defaultWriteError(message: string, error: unknown): void {
  console.error(`allibot: ${message}:`, error);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * Attachment bytes are served with the stored media type and an
 * `attachment` disposition. The filename is carried twice — the RFC 5987
 * `filename*` form for non-ASCII names and a quoted ASCII fallback — and both
 * are quoted/escaped so the header cannot be split.
 */
function sendAttachment(
  response: ServerResponse,
  attachment: { filename: string; mime: string; bytes: Buffer },
): void {
  const fallback = attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  response.writeHead(200, {
    'content-type': attachment.mime,
    'content-length': attachment.bytes.length,
    'content-disposition':
      `attachment; filename="${fallback}"; ` +
      `filename*=UTF-8''${encodeRfc5987(attachment.filename)}`,
    'x-content-type-options': 'nosniff',
  });
  response.end(attachment.bytes);
}

/**
 * RFC 5987 extended parameter value: percent-encode everything outside
 * `attr-char`. `encodeURIComponent` leaves `'()*` alone, and a raw `'` would
 * end the `UTF-8''` prefix early.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
