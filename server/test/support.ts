import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const CLI_ENTRY = path.join(REPO_ROOT, 'dist', 'cli.js');
export const MIGRATION_FIXTURE = path.join(
  REPO_ROOT,
  'server',
  'test',
  'fixtures',
  'migrate-steps.mjs',
);
/**
 * Every server a test starts gets the fake Docker CLI (#49) unless it injects
 * its own: with no state file the fake reports a missing daemon, so automation
 * never touches a real Docker daemon and the default workspace reading is
 * deterministic.
 */
export const FAKE_DOCKER_FIXTURE = path.join(
  REPO_ROOT,
  'server',
  'test',
  'fixtures',
  'fake-docker.mjs',
);

const STARTUP_TIMEOUT_MS = 10_000;
const EXIT_TIMEOUT_MS = 10_000;
const COMMAND_TIMEOUT_MS = 30_000;

/**
 * HOME used when a test does not provide its own. Keeping it inside the OS
 * temp directory guarantees a test can never touch the real ~/.allibot.
 */
const FALLBACK_HOME = mkdtempSync(path.join(tmpdir(), 'allibot-test-home-'));
process.once('exit', () => {
  rmSync(FALLBACK_HOME, { recursive: true, force: true });
});

const LISTENING_LINE = /allibot 已监听 http:\/\/127\.0\.0\.1:(\d+)。/;

export interface CliResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  output: string;
}

export interface RunCliOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

export interface RunningServer {
  child: ChildProcess;
  port: number;
  stop: () => Promise<void>;
  crash: () => Promise<void>;
  /** Everything the process wrote to stdout / stderr so far. */
  logs: () => { stdout: string; stderr: string };
}

/**
 * The environment variables that could point a round at a real model provider.
 * They are stripped from every spawned process unless a test sets them
 * explicitly, so an automation run never spends money or touches the network
 * because of the developer's own shell.
 */
const PROVIDER_ENV_KEYS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_BASE_URL',
] as const;

export async function makeTempDir(prefix: string): Promise<string> {
  return await mkdtemp(path.join(tmpdir(), prefix));
}

export async function removeTempDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export function runCli(
  args: readonly string[],
  options: RunCliOptions = {},
): CliResult {
  return runNodeScript(CLI_ENTRY, args, options);
}

export function runNodeScript(
  script: string,
  args: readonly string[],
  options: RunCliOptions = {},
): CliResult {
  const result = spawnSync(process.execPath, [script, ...args], {
    cwd: options.cwd ?? REPO_ROOT,
    env: buildEnv(options.env),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? COMMAND_TIMEOUT_MS,
  });
  if (result.error !== undefined && !isTimeoutError(result.error)) {
    throw result.error;
  }
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    exitCode: result.status,
    signal: result.signal,
    stdout,
    stderr,
    output: stdout + stderr,
  };
}

export async function startServer(
  dataDir: string,
  options: {
    env?: NodeJS.ProcessEnv;
    port?: number;
    args?: readonly string[];
    /** Start without injecting the test double (the production default). */
    useProductionProvider?: boolean;
  } = {},
): Promise<RunningServer> {
  const port = options.port ?? 0;
  // Tests inject the scripted double explicitly (D4.3). The production default
  // is the real model adapter, so a test that wants the double — or any
  // `--scripted-*` option — gets `--provider scripted` unless it selected a
  // provider itself.
  const requested = options.args ?? [];
  const withProvider =
    options.useProductionProvider === true || requested.includes('--provider')
      ? requested
      : ['--provider', 'scripted', ...requested];
  const args = withProvider.includes('--docker-command')
    ? withProvider
    : ['--docker-command', FAKE_DOCKER_FIXTURE, ...withProvider];
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, 'serve', '--data-dir', dataDir, '--port', String(port), ...args],
    {
      cwd: REPO_ROOT,
      env: buildEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  let stdout = '';
  let stderr = '';
  child.stdout?.setEncoding('utf8');
  child.stderr?.setEncoding('utf8');
  child.stdout?.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });

  let boundPort: number;
  try {
    boundPort = await waitForListeningPort(child);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child).catch(() => undefined);
    throw error;
  }

  return {
    child,
    port: boundPort,
    stop: async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGTERM');
      try {
        await waitForExit(child);
      } catch {
        child.kill('SIGKILL');
        await waitForExit(child);
      }
    },
    crash: async (): Promise<void> => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }
      child.kill('SIGKILL');
      await waitForExit(child);
    },
    logs: () => ({ stdout, stderr }),
  };
}

export function readLedger(dataDir: string): Record<string, unknown>[] {
  const raw = readFileSync(path.join(dataDir, 'schema-migrations.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** 一次 HTTP 面的原始回答：状态码、正文与解析后的信封。 */
export interface HttpResult {
  status: number;
  text: string;
  body: Record<string, unknown>;
}

/** 发一个请求并把正文解析成 JSON 信封；空正文读成 `{}`。 */
export async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return { status: response.status, text, body: parsed as Record<string, unknown> };
}

/** 同 `request`，但 2xx 之外直接失败；返回的是信封本身。 */
export async function ok(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const result = await request(base, method, route, body);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${method} ${route} -> ${result.status}: ${result.text}`,
  );
  return result.body;
}

export async function getJson(base: string, route: string): Promise<Record<string, unknown>> {
  return await ok(base, 'GET', route);
}

/** 轮询到 `done` 为真为止；超时抛出的错误带着最后一次读到的值。 */
export async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${what} 超时；最后一次读到：${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** One request a recording endpoint saw, kept verbatim for assertions. */
export interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

/** What a recording endpoint answers with; the default is a provider-shaped reply. */
export interface RecordedReply {
  status: number;
  body: unknown;
}

/**
 * A local provider endpoint on 127.0.0.1 (not the internet): it records every
 * request it receives and answers in the shape of the path it was called on.
 * Tests point `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` at it, so a real provider
 * adapter can be exercised without any network access or model spend.
 */
export interface RecordingEndpoint {
  port: number;
  baseUrl: string;
  requests: RecordedRequest[];
  /** Replace the canned answer for later requests. */
  respondWith: (responder: (request: RecordedRequest) => RecordedReply) => void;
  stop: () => Promise<void>;
}

export async function startRecordingEndpoint(
  options: { replyText?: string } = {},
): Promise<RecordingEndpoint> {
  const requests: RecordedRequest[] = [];
  const replyText = options.replyText ?? '记录端点的回复';
  let responder: ((request: RecordedRequest) => RecordedReply) | null = null;

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const recorded: RecordedRequest = {
        method: request.method ?? 'GET',
        path: request.url ?? '/',
        headers: request.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const reply = responder?.(recorded) ?? defaultProviderReply(recorded.path, replyText);
      const payload = typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body);
      response.writeHead(reply.status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(payload),
      });
      response.end(payload);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('recording endpoint did not bind to a TCP port');
  }

  return {
    port: address.port,
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    respondWith: (next) => {
      responder = next;
    },
    stop: async (): Promise<void> => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error === undefined ? resolve() : reject(error)));
      });
    },
  };
}

/** The provider-shaped answer: OpenAI under /v1/chat/completions, Anthropic under /v1/messages. */
function defaultProviderReply(path: string, text: string): RecordedReply {
  if (path.endsWith('/v1/messages')) {
    return { status: 200, body: { content: [{ type: 'text', text }] } };
  }
  return { status: 200, body: { choices: [{ message: { role: 'assistant', content: text } }] } };
}

function isTimeoutError(error: Error): boolean {
  return (error as NodeJS.ErrnoException).code === 'ETIMEDOUT';
}

function buildEnv(overrides: NodeJS.ProcessEnv | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: FALLBACK_HOME,
    ...overrides,
  };
  if (overrides?.allibot_DATA_DIR === undefined) {
    delete env.allibot_DATA_DIR;
  }
  // Automation never calls a real provider: the developer's own credentials
  // must not leak into a test process that deliberately leaves them unset.
  for (const key of PROVIDER_ENV_KEYS) {
    if (overrides?.[key] === undefined) {
      delete env[key];
    }
  }
  return env;
}

function waitForListeningPort(child: ChildProcess): Promise<number> {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      finish();
      reject(
        new Error(
          `server did not listen within ${STARTUP_TIMEOUT_MS}ms; stderr: ${stderr.trim()}`,
        ),
      );
    }, STARTUP_TIMEOUT_MS);

    const finish = (): void => {
      clearTimeout(timer);
      child.stdout?.off('data', onStdout);
      child.stderr?.off('data', onStderr);
      child.off('exit', onExit);
    };

    const onStdout = (chunk: Buffer): void => {
      stdout += chunk.toString('utf8');
      const match = LISTENING_LINE.exec(stdout);
      if (match !== null) {
        finish();
        resolve(Number(match[1]));
      }
    };

    const onStderr = (chunk: Buffer): void => {
      stderr += chunk.toString('utf8');
    };

    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      finish();
      reject(
        new Error(
          `server exited before listening (code=${String(code)}, signal=${String(signal)}); stderr: ${stderr.trim()}`,
        ),
      );
    };

    child.stdout?.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.once('exit', onExit);
  });
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      reject(new Error(`process did not exit within ${EXIT_TIMEOUT_MS}ms`));
    }, EXIT_TIMEOUT_MS);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}
