import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
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

const LISTENING_LINE = /allibot server listening on http:\/\/127\.0\.0\.1:(\d+)/;

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
}

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
  options: { env?: NodeJS.ProcessEnv; port?: number; args?: readonly string[] } = {},
): Promise<RunningServer> {
  const port = options.port ?? 0;
  const child = spawn(
    process.execPath,
    [CLI_ENTRY, 'serve', '--data-dir', dataDir, '--port', String(port), ...(options.args ?? [])],
    {
      cwd: REPO_ROOT,
      env: buildEnv(options.env),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

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
  };
}

export function readLedger(dataDir: string): Record<string, unknown>[] {
  const raw = readFileSync(path.join(dataDir, 'schema-migrations.jsonl'), 'utf8');
  return raw
    .split('\n')
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
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
