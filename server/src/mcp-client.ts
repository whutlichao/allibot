import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/**
 * The minimal MCP client the host process uses (#47 / D6.1).
 *
 * The host connects to three transports:
 * - `stdio`: spawn the configured command as a host child process and speak
 *   newline-delimited JSON-RPC over stdin / stdout;
 * - `http`: streamable HTTP POSTs (JSON or SSE responses);
 * - `sse`: the legacy HTTP+SSE transport (one event stream for responses, a
 *   `endpoint` event naming the POST URL).
 *
 * Only the handshake, `tools/list` and `tools/call` are implemented: M2 does
 * not build a general MCP SDK, it assembles the tools of the explicitly
 * configured servers. Values of `env_names` are read from the host environment
 * by the caller and passed in the child environment; this module never writes
 * an env value anywhere.
 */

export interface McpToolDescription {
  name: string;
  description: string | null;
}

export interface McpToolCallResult {
  content: string;
  is_error: boolean;
}

export interface McpClient {
  readonly transport: 'stdio' | 'http' | 'sse';
  initialize(): Promise<void>;
  listTools(): Promise<McpToolDescription[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface McpClientOptions {
  /** How long one request may wait for its response. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 5_000;
const MCP_PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'allibot', version: '0.0.0' } as const;

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

class JsonRpcPeer {
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly timeoutMs: number;
  private closed = false;

  constructor(
    private readonly sendLine: (message: unknown) => void,
    options: McpClientOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error('MCP connection is closed'));
    }
    const id = this.nextId;
    this.nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.sendLine({ jsonrpc: '2.0', id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.sendLine({ jsonrpc: '2.0', method, params });
  }

  receive(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') {
      return;
    }
    const pending = this.pending.get(message.id);
    if (pending === undefined) {
      return;
    }
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error !== undefined) {
      pending.reject(new Error(message.error.message ?? 'MCP request failed'));
      return;
    }
    pending.resolve(message.result);
  }

  failAll(error: Error): void {
    this.closed = true;
    for (const [id, pending] of this.pending) {
      this.pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }
}

interface PeerLike {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>): void;
}

async function initializePeer(peer: PeerLike): Promise<void> {
  await peer.request('initialize', {
    protocolVersion: MCP_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: CLIENT_INFO,
  });
  peer.notify('notifications/initialized');
}

function parseToolList(result: unknown): McpToolDescription[] {
  if (typeof result !== 'object' || result === null) {
    return [];
  }
  const tools = (result as { tools?: unknown }).tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  const parsed: McpToolDescription[] = [];
  for (const tool of tools) {
    if (typeof tool !== 'object' || tool === null) {
      continue;
    }
    const record = tool as Record<string, unknown>;
    if (typeof record['name'] !== 'string' || record['name'].length === 0) {
      continue;
    }
    parsed.push({
      name: record['name'],
      description: typeof record['description'] === 'string' ? record['description'] : null,
    });
  }
  return parsed;
}

function parseToolCall(result: unknown): McpToolCallResult {
  if (typeof result !== 'object' || result === null) {
    return { content: '', is_error: false };
  }
  const record = result as Record<string, unknown>;
  const isError = record['isError'] === true;
  const content = record['content'];
  if (!Array.isArray(content)) {
    return { content: '', is_error: isError };
  }
  const texts: string[] = [];
  for (const item of content) {
    if (typeof item === 'object' && item !== null) {
      const part = item as Record<string, unknown>;
      if (part['type'] === 'text' && typeof part['text'] === 'string') {
        texts.push(part['text']);
      }
    }
  }
  return { content: texts.join('\n'), is_error: isError };
}

/** The child-process environment: an allowlist plus the named variables. */
export function mcpChildEnvironment(
  env: NodeJS.ProcessEnv,
  envNames: readonly string[] = [],
): Record<string, string> {
  const allowed = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'SHELL', 'TZ'];
  const child: Record<string, string> = {};
  for (const key of allowed) {
    const value = env[key];
    if (value !== undefined) {
      child[key] = value;
    }
  }
  for (const name of envNames) {
    const value = env[name];
    if (value !== undefined) {
      child[name] = value;
    }
  }
  return child;
}

/**
 * stdio transport. By default the configured command is a host child process;
 * in the Docker backend (#49) the caller injects `spawnProcess`, which starts
 * the same command inside the Agent container via `docker exec -i` with cwd
 * `/workspace`. The JSON-RPC framing is identical on both paths.
 */
export function createStdioMcpClient(options: {
  command: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  envNames?: readonly string[];
  timeoutMs?: number;
  /** A container exec process instead of a host child (Docker backend). */
  spawnProcess?: () => ChildProcessWithoutNullStreams;
  /** How diagnostics name the process; falls back to the command. */
  label?: string;
}): McpClient {
  const label = options.label ?? options.command;
  let child: ChildProcessWithoutNullStreams | null = null;
  let peer: JsonRpcPeer | null = null;
  let stderrTail = '';
  let stdoutBuffer = '';

  function ensureStarted(): void {
    if (child !== null) {
      return;
    }
    child =
      options.spawnProcess !== undefined
        ? options.spawnProcess()
        : spawn(options.command, [...options.args], {
            cwd: options.cwd,
            env: mcpChildEnvironment(options.env, options.envNames ?? []),
            stdio: ['pipe', 'pipe', 'pipe'],
          });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-1000);
    });
    child.on('error', (error) => {
      peer?.failAll(new Error(`MCP stdio server ${label} failed: ${error.message}`));
    });
    child.on('exit', (code, signal) => {
      peer?.failAll(
        new Error(
          `MCP stdio server ${label} exited (code=${String(code)}, signal=${String(signal)})${stderrTail.length > 0 ? `: ${stderrTail.trim()}` : ''}`,
        ),
      );
    });
    child.stdout.on('data', (chunk: string) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline !== -1) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        if (line.length > 0) {
          try {
            peer?.receive(JSON.parse(line) as JsonRpcResponse);
          } catch {
            // A non-JSON line on stdout is not a protocol message; keep reading.
          }
        }
        newline = stdoutBuffer.indexOf('\n');
      }
    });
    peer = new JsonRpcPeer((message) => {
      child?.stdin.write(`${JSON.stringify(message)}\n`);
    }, { timeoutMs: options.timeoutMs });
  }

  function requirePeer(): JsonRpcPeer {
    ensureStarted();
    if (peer === null) {
      throw new Error(`MCP stdio peer did not start: ${label}`);
    }
    return peer;
  }

  return {
    transport: 'stdio',
    async initialize() {
      await initializePeer(requirePeer());
    },
    async listTools() {
      return parseToolList(await requirePeer().request('tools/list', {}));
    },
    async callTool(name, args) {
      return parseToolCall(
        await requirePeer().request('tools/call', { name, arguments: args }),
      );
    },
    async close() {
      peer?.failAll(new Error('MCP stdio connection closed'));
      const running = child;
      child = null;
      peer = null;
      if (running === null || running.exitCode !== null || running.signalCode !== null) {
        return;
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          running.kill('SIGKILL');
          resolve();
        }, 500);
        timer.unref?.();
        running.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
        try {
          running.stdin.end();
          running.kill('SIGTERM');
        } catch {
          clearTimeout(timer);
          resolve();
        }
      });
    },
  };
}

interface SseEvent {
  event: string;
  data: string;
}

function feedSseBuffer(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  let rest = buffer;
  let boundary = rest.indexOf('\n\n');
  while (boundary !== -1) {
    const block = rest.slice(0, boundary);
    rest = rest.slice(boundary + 2);
    let event = 'message';
    const data: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('event:')) {
        event = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        data.push(line.slice('data:'.length).trimStart());
      }
    }
    if (data.length > 0) {
      events.push({ event, data: data.join('\n') });
    }
    boundary = rest.indexOf('\n\n');
  }
  return { events, rest };
}

async function readJsonResponse(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  if (text.trim().length === 0) {
    return {};
  }
  return JSON.parse(text) as JsonRpcResponse;
}

/** The host-side streamable HTTP transport. */
export function createHttpMcpClient(options: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): McpClient {
  const baseHeaders: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(options.headers ?? {}),
  };
  let sessionId: string | null = null;
  const pending = new Map<number, PendingRequest>();
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let nextId = 1;
  const abort = new AbortController();

  function dispatch(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(new Error(message.error.message ?? 'MCP request failed'));
      return;
    }
    entry.resolve(message.result);
  }

  async function post(body: unknown): Promise<void> {
    const headers: Record<string, string> = { ...baseHeaders };
    if (sessionId !== null) {
      headers['mcp-session-id'] = sessionId;
    }
    let response: Response;
    try {
      response = await fetch(options.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    const session = response.headers.get('mcp-session-id');
    if (session !== null && session.length > 0) {
      sessionId = session;
    }
    if (!response.ok) {
      throw new Error(`MCP HTTP ${response.status} from ${options.url}`);
    }
    const type = response.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      await readSseResponse(response, dispatch, abort.signal);
      return;
    }
    const message = await readJsonResponse(response);
    if (Object.keys(message).length > 0) {
      dispatch(message);
    }
  }

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      post({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const entry = pending.get(id);
        if (entry !== undefined) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  const peer: PeerLike = {
    request,
    notify: (method, params = {}) => {
      void post({ jsonrpc: '2.0', method, params });
    },
  };

  return {
    transport: 'http',
    async initialize() {
      await initializePeer(peer);
    },
    async listTools() {
      return parseToolList(await request('tools/list', {}));
    },
    async callTool(name, args) {
      return parseToolCall(await request('tools/call', { name, arguments: args }));
    },
    async close() {
      abort.abort();
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error('MCP HTTP connection closed'));
      }
    },
  };
}

async function readSseResponse(
  response: Response,
  dispatch: (message: JsonRpcResponse) => void,
  signal: AbortSignal,
): Promise<void> {
  if (response.body === null) {
    return;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!signal.aborted) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = feedSseBuffer(buffer);
      buffer = parsed.rest;
      for (const event of parsed.events) {
        try {
          dispatch(JSON.parse(event.data) as JsonRpcResponse);
        } catch {
          // Ignore keep-alives / non-JSON events.
        }
      }
    }
  } catch {
    // A closed stream ends the response read; pending timers report the rest.
  } finally {
    reader.releaseLock();
  }
}

/** The legacy HTTP+SSE transport: event stream for responses, POST endpoint. */
export function createSseMcpClient(options: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): McpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const abort = new AbortController();
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let endpoint: string | null = null;
  let endpointWaiter: ((url: string) => void) | null = null;
  let endpointRejecter: ((error: Error) => void) | null = null;
  let streamError: Error | null = null;
  let closed = false;

  function dispatch(message: JsonRpcResponse): void {
    if (typeof message.id !== 'number') {
      return;
    }
    const entry = pending.get(message.id);
    if (entry === undefined) {
      return;
    }
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined) {
      entry.reject(new Error(message.error.message ?? 'MCP request failed'));
      return;
    }
    entry.resolve(message.result);
  }

  async function readLoop(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(options.url, {
        headers: { accept: 'text/event-stream', ...(options.headers ?? {}) },
        signal: abort.signal,
      });
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      streamError = failure;
      endpointRejecter?.(failure);
      return;
    }
    if (response.body === null) {
      const failure = new Error(`MCP SSE ${options.url} returned no body`);
      streamError = failure;
      endpointRejecter?.(failure);
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (!abort.signal.aborted) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = feedSseBuffer(buffer);
        buffer = parsed.rest;
        for (const event of parsed.events) {
          if (event.event === 'endpoint') {
            endpoint = new URL(event.data, options.url).toString();
            endpointWaiter?.(endpoint);
            endpointWaiter = null;
            continue;
          }
          try {
            dispatch(JSON.parse(event.data) as JsonRpcResponse);
          } catch {
            // Ignore keep-alives / non-JSON events.
          }
        }
      }
    } catch (error) {
      if (!abort.signal.aborted) {
        streamError = error instanceof Error ? error : new Error(String(error));
      }
    } finally {
      reader.releaseLock();
    }
    const failure = streamError ?? new Error('MCP SSE stream closed');
    for (const [id, entry] of pending) {
      pending.delete(id);
      clearTimeout(entry.timer);
      entry.reject(failure);
    }
  }

  const ready = readLoop();

  async function waitForEndpoint(): Promise<string> {
    if (endpoint !== null) {
      return endpoint;
    }
    if (streamError !== null) {
      throw streamError;
    }
    return await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        endpointWaiter = null;
        endpointRejecter = null;
        reject(new Error(`MCP SSE endpoint timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      endpointWaiter = (url) => {
        clearTimeout(timer);
        endpointRejecter = null;
        resolve(url);
      };
      endpointRejecter = (error) => {
        clearTimeout(timer);
        endpointWaiter = null;
        reject(error);
      };
    });
  }

  async function post(body: unknown): Promise<void> {
    const target = await waitForEndpoint();
    let response: Response;
    try {
      response = await fetch(target, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
        body: JSON.stringify(body),
        signal: abort.signal,
      });
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error));
    }
    if (!response.ok) {
      throw new Error(`MCP SSE POST ${response.status} from ${target}`);
    }
    await response.arrayBuffer().catch(() => undefined);
  }

  function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    if (closed) {
      return Promise.reject(new Error('MCP SSE connection is closed'));
    }
    const id = nextId;
    nextId += 1;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`MCP ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer });
      post({ jsonrpc: '2.0', id, method, params }).catch((error: unknown) => {
        const entry = pending.get(id);
        if (entry !== undefined) {
          pending.delete(id);
          clearTimeout(entry.timer);
          entry.reject(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
  }

  const peer: PeerLike = {
    request,
    notify: (method, params = {}) => {
      void post({ jsonrpc: '2.0', method, params });
    },
  };

  return {
    transport: 'sse',
    async initialize() {
      await initializePeer(peer);
    },
    async listTools() {
      return parseToolList(await request('tools/list', {}));
    },
    async callTool(name, args) {
      return parseToolCall(await request('tools/call', { name, arguments: args }));
    },
    async close() {
      closed = true;
      abort.abort();
      for (const [id, entry] of pending) {
        pending.delete(id);
        clearTimeout(entry.timer);
        entry.reject(new Error('MCP SSE connection closed'));
      }
      await ready.catch(() => undefined);
    },
  };
}

/** A UUID for a tool-call approval identity; stable for the call it names. */
export function newMcpToolCallId(): string {
  return randomUUID();
}
