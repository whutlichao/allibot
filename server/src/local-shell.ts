import { spawn } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { RoundShell, RoundShellResult, RunShellRequest } from './agent-seam.js';
import { isInsideOrEqual } from './workspace-root.js';

/**
 * 本地 shell (#46 / D5.4). The one production shell face: a local round with a
 * usable project root exposes it on `RoundInput.workspace.shell`; a round with
 * no root has no shell at all.
 *
 * The hard rules live here, before any approval can be asked:
 * - a command must be a non-empty string;
 * - the working directory defaults to the project root; `..`, a root-outside
 *   absolute path and a symlink escaping the root are tool errors (D5.1), not
 *   approval questions;
 * - the switch off, read-only, a matching deny rule and every other gate fact
 *   are the one tool gate's answer, so a call while disabled is `DENIED`
 *   without an approval row (D5.5).
 *
 * Every enabled call goes through `gate.authorize`, which always asks (the
 * local-shell hard approval). The child process only receives the environment
 * allowlist plus the declared `env_names`; the model provider keys, web
 * credentials and every other secret never enter it. The output is returned to
 * the adapter and is never logged or persisted by this module.
 */

/**
 * The variables a shell process needs to run (D5.4: "PATH、HOME、LANG、TERM
 * 等运行必需项"). Anything else is absent unless declared.
 */
export const SHELL_ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'TERM',
  'TMPDIR',
  'LC_ALL',
  'LC_CTYPE',
  'SHELL',
  'USER',
  'LOGNAME',
] as const;

/** The output cap one call returns to the adapter; larger output is truncated. */
export const MAX_SHELL_OUTPUT_BYTES = 1024 * 1024;

/**
 * The declared `env_names` merged into every shell environment. #47 owns
 * reading the member's `mcp.json`; it replaces the source of this list with the
 * enabled servers' `env_names`. The startup injection (`--shell-env-name`) is
 * the documented merge point until then: a name is a variable name only, its
 * value is read from the process environment at spawn time.
 */
let declaredEnvNames: readonly string[] = [];

export function setShellEnvNames(names: readonly string[]): void {
  declaredEnvNames = [...new Set(names)];
}

export function getShellEnvNames(): readonly string[] {
  return declaredEnvNames;
}

/** The gate face the shell asks; the one tool gate implements it. */
export interface LocalShellGate {
  authorize(request: {
    tool_name: string;
    pattern: string;
    tool_call_id?: string;
    arguments: Record<string, unknown>;
  }): Promise<'allow' | 'denied'>;
}

export interface LocalShellOptions {
  /** The canonical project root the round already validated. */
  root: string;
  /** The channel's explicit switch. */
  allowLocalShell: 0 | 1;
  /**
   * The declared `env_names` for this round. #47 passes the enabled MCP
   * servers' names here; the current round assembly passes the startup-declared
   * list, which is why the injection exists at all.
   */
  envNames?: readonly string[];
  gate: LocalShellGate;
}

export function createLocalShell(options: LocalShellOptions): RoundShell {
  const root = realpathSync(options.root);
  const envNames = options.envNames ?? [];
  return {
    root,
    enabled: options.allowLocalShell === 1,
    async run(request: RunShellRequest): Promise<RoundShellResult> {
      const command = request?.command;
      if (typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
        return failure('invalid-command', 'command must be a non-empty string');
      }
      const resolved = resolveCwd(root, request?.cwd);
      if (!('resolvedCwd' in resolved)) {
        return resolved;
      }
      const outcome = await options.gate.authorize({
        tool_name: 'Bash',
        pattern: command,
        tool_call_id: request.tool_call_id,
        // The approval summary keeps the tool name and the readable arguments
        // only: the command and its in-root cwd, never the tool environment.
        arguments: {
          command,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        },
      });
      if (outcome === 'denied') {
        return failure('denied', 'DENIED');
      }
      return await execute(command, resolved.resolvedCwd, envNames);
    },
  };
}

type ResolvedCwd = { resolvedCwd: string } | RoundShellResult;

/**
 * The working directory is inside the one project root. The lexical check runs
 * before the existence check so an outside absolute path is `outside-root`
 * rather than `not-found`; a symlink inside the root is accepted only when its
 * realpath still resolves inside.
 */
function resolveCwd(root: string, requested: unknown): ResolvedCwd {
  if (requested === undefined) {
    return { resolvedCwd: root };
  }
  if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0')) {
    return failure('invalid-command', 'cwd must be a non-empty string');
  }
  const segments = requested.split(/[\\/]+/);
  if (segments.includes('..')) {
    return failure('outside-root', 'cwd must not contain ".."');
  }
  const candidate = path.isAbsolute(requested)
    ? path.resolve(requested)
    : path.resolve(root, requested);
  if (!isInsideOrEqual(candidate, root)) {
    return failure('outside-root', `cwd escapes the workspace root: ${requested}`);
  }
  if (!existsSync(candidate)) {
    return failure('not-found', `cwd does not exist: ${requested}`);
  }
  let realCwd: string;
  try {
    realCwd = realpathSync(candidate);
  } catch {
    return failure('invalid-command', `cwd cannot be resolved: ${requested}`);
  }
  if (!isInsideOrEqual(realCwd, root)) {
    return failure('outside-root', `cwd escapes the workspace root: ${requested}`);
  }
  try {
    if (!statSync(realCwd).isDirectory()) {
      return failure('not-a-directory', `cwd is not a directory: ${requested}`);
    }
  } catch {
    return failure('not-found', `cwd does not exist: ${requested}`);
  }
  return { resolvedCwd: realCwd };
}

/** The child environment: allowlist + declared names, never the whole process env. */
export function buildShellEnv(
  base: NodeJS.ProcessEnv,
  names: readonly string[],
  cwd: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { PWD: cwd };
  for (const name of SHELL_ENV_ALLOWLIST) {
    const value = base[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  for (const name of names) {
    const value = base[name];
    if (value !== undefined) {
      env[name] = value;
    }
  }
  // A shell without PATH is unusable; the allowlist value is used when the
  // host process has one, and this fixed default only keeps a stripped test
  // process runnable.
  env.PATH ??= '/usr/local/bin:/usr/bin:/bin';
  return env;
}

async function execute(
  command: string,
  cwd: string,
  envNames: readonly string[],
): Promise<RoundShellResult> {
  return await new Promise<RoundShellResult>((resolve) => {
    const child = spawn('/bin/bash', ['-c', command], {
      cwd,
      env: buildShellEnv(process.env, envNames, cwd),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes <= MAX_SHELL_OUTPUT_BYTES) {
        stdout += chunk.toString('utf8');
      } else {
        truncated = true;
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_SHELL_OUTPUT_BYTES) {
        stderr += chunk.toString('utf8');
      } else {
        truncated = true;
      }
    });
    child.once('error', (error: Error) => {
      resolve(failure('spawn-failed', error.message));
    });
    child.once('close', (code: number | null) => {
      resolve({
        ok: true,
        cwd,
        exit_code: code,
        stdout,
        stderr,
        output_truncated: truncated,
      });
    });
  });
}

function failure(error: RoundShellResult['error'], message: string): RoundShellResult {
  return { ok: false, error, message };
}
