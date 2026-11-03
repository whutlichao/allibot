import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVER_ENTRY = fileURLToPath(new URL('../dist/main.js', import.meta.url));
const LISTENING_LINE = /allibot server listening on http:\/\/127\.0\.0\.1:(\d+)/;
const STARTUP_TIMEOUT_MS = 10_000;
const SHUTDOWN_TIMEOUT_MS = 5_000;

interface RunningServer {
  port: number;
  stop: () => Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
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
      reject(new Error(`server did not stop within ${SHUTDOWN_TIMEOUT_MS}ms`));
    }, SHUTDOWN_TIMEOUT_MS);
    const onExit = (): void => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
  });
}

async function startServer(dataDir: string): Promise<RunningServer> {
  const child = spawn(
    process.execPath,
    [SERVER_ENTRY, '--data-dir', dataDir, '--port', '0'],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let port: number;
  try {
    port = await waitForListeningPort(child);
  } catch (error) {
    child.kill('SIGKILL');
    await waitForExit(child);
    throw error;
  }

  return {
    port,
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
  };
}

test('unknown API path returns the unified not_found error envelope', async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'allibot-server-test-'));
  let running: RunningServer | undefined;

  try {
    running = await startServer(dataDir);
    assert.equal(existsSync(dataDir), true, 'the server data dir should exist while running');

    const response = await fetch(`http://127.0.0.1:${running.port}/api/__unknown__`);
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type') ?? '', /^application\/json/);

    const body: unknown = await response.json();
    assert.ok(isRecord(body), 'response body should be a JSON object');
    assert.deepEqual(Object.keys(body), ['error']);
    assert.ok(isRecord(body.error), 'response body should contain an error object');
    assert.deepEqual(Object.keys(body.error).sort(), ['code', 'message']);
    assert.equal(body.error.code, 'not_found');
    assert.ok(
      typeof body.error.message === 'string' && body.error.message.length > 0,
      'error message should be a non-empty string',
    );
  } finally {
    await running?.stop();
    await rm(dataDir, { recursive: true, force: true });
  }

  assert.equal(existsSync(dataDir), false, 'the temporary data dir should be removed');
});
