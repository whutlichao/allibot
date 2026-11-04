import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * 容器运行时接缝 (#49 / D5.3 / ADR-0006). The production implementation is a
 * thin adapter over the Docker CLI (`docker version` / `image inspect` /
 * `pull` / `create` / `exec` / `stop` / `rm` / `ps`); automation injects a fake
 * CLI through `--docker-command`, so the tests observe create / exec / stop /
 * remove / inspect without a real daemon and production has no fake branch.
 *
 * The runtime never receives credentials: the manager builds the exec
 * environment from the tool allowlist plus declared `env_names` only. An
 * image reference is the only registry-shaped value that passes through, and
 * it is never a credential.
 */

/** One bind mount the container is created with. */
export interface DockerMount {
  source: string;
  target: string;
  readOnly: boolean;
}

/** The container creation request; the manager owns the mount list. */
export interface DockerContainerSpec {
  name: string;
  image: string;
  labels: Record<string, string>;
  mounts: readonly DockerMount[];
  /** The keep-alive command; the container is not a persistent workspace. */
  command: readonly string[];
}

export interface DockerExecRequest {
  containerId: string;
  argv: readonly string[];
  workdir?: string;
  /** Only the tool allowlist plus declared `env_names`; never a model key. */
  env?: Record<string, string>;
  /** Buffered stdin for one exec (file writes); absent means no input. */
  input?: string;
}

export interface DockerExecResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export interface DockerRuntime {
  /** `docker version`: is the daemon reachable at all? */
  ping(): Promise<{ ok: boolean; detail: string | null }>;
  /** `docker image inspect <ref>`: is the image already local? */
  inspectImage(ref: string): Promise<{ present: boolean; detail: string | null }>;
  pullImage(ref: string): Promise<{ ok: boolean; detail: string | null }>;
  createContainer(
    spec: DockerContainerSpec,
  ): Promise<{ ok: boolean; id: string | null; detail: string | null }>;
  /** One buffered exec (file tools / shell); output is capped like the shell. */
  exec(request: DockerExecRequest): Promise<DockerExecResult>;
  /** One interactive exec (stdio MCP): the child process speaks JSON-RPC. */
  spawnExec(request: DockerExecRequest): ChildProcessWithoutNullStreams;
  stopContainer(id: string): Promise<{ ok: boolean; detail: string | null }>;
  removeContainer(id: string): Promise<{ ok: boolean; detail: string | null }>;
  /** Containers carrying this application's marker (startup cleanup). */
  listMarkedContainers(marker: string): Promise<{ id: string }[]>;
}

/** One call's output cap; larger output is truncated (D5.4 uses the same cap). */
export const MAX_DOCKER_OUTPUT_BYTES = 1024 * 1024;

const CONTROL_TIMEOUT_MS = 20_000;
const PULL_TIMEOUT_MS = 15 * 60_000;

export interface DockerCliRuntimeOptions {
  /** The Docker CLI executable; `docker` by default, a fake in automation. */
  command: string;
  env?: NodeJS.ProcessEnv;
}

/** The production runtime: every operation is one Docker CLI invocation. */
export function createDockerCliRuntime(options: DockerCliRuntimeOptions): DockerRuntime {
  const command = options.command;
  const env = options.env ?? process.env;

  async function run(
    args: readonly string[],
    runOptions: { input?: string; timeoutMs?: number } = {},
  ): Promise<{
    code: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
    spawnError: string | null;
  }> {
    return await new Promise((resolve) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, [...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (error) {
        resolve({
          code: null,
          stdout: '',
          stderr: '',
          truncated: false,
          spawnError: messageOf(error),
        });
        return;
      }
      let stdout = '';
      let stderr = '';
      let truncated = false;
      const append = (current: string, chunk: Buffer): string => {
        if (current.length >= MAX_DOCKER_OUTPUT_BYTES) {
          truncated = true;
          return current;
        }
        const text = chunk.toString('utf8');
        if (current.length + text.length > MAX_DOCKER_OUTPUT_BYTES) {
          truncated = true;
          return current + text.slice(0, MAX_DOCKER_OUTPUT_BYTES - current.length);
        }
        return current + text;
      };
      const timer =
        runOptions.timeoutMs === undefined
          ? null
          : setTimeout(() => {
              child.kill('SIGKILL');
            }, runOptions.timeoutMs);
      timer?.unref?.();
      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.once('error', (error: Error) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve({
          code: null,
          stdout,
          stderr,
          truncated,
          spawnError: error.message,
        });
      });
      child.once('close', (code: number | null) => {
        if (timer !== null) {
          clearTimeout(timer);
        }
        resolve({ code, stdout, stderr, truncated, spawnError: null });
      });
      if (runOptions.input !== undefined) {
        child.stdin.end(runOptions.input);
      } else {
        child.stdin.end();
      }
    });
  }

  return {
    async ping() {
      const result = await run(['version', '--format', '{{.Server.Version}}'], {
        timeoutMs: CONTROL_TIMEOUT_MS,
      });
      if (result.spawnError !== null) {
        return { ok: false, detail: result.spawnError };
      }
      if (result.code !== 0) {
        return { ok: false, detail: shortDetail(result.stderr) };
      }
      return { ok: true, detail: null };
    },
    async inspectImage(ref) {
      const result = await run(['image', 'inspect', ref], { timeoutMs: CONTROL_TIMEOUT_MS });
      if (result.spawnError !== null) {
        return { present: false, detail: result.spawnError };
      }
      if (result.code === 0) {
        return { present: true, detail: null };
      }
      if (/no such image|not found/i.test(result.stderr)) {
        return { present: false, detail: null };
      }
      return { present: false, detail: shortDetail(result.stderr) };
    },
    async pullImage(ref) {
      const result = await run(['pull', ref], { timeoutMs: PULL_TIMEOUT_MS });
      if (result.spawnError !== null) {
        return { ok: false, detail: result.spawnError };
      }
      if (result.code !== 0) {
        return { ok: false, detail: shortDetail(result.stderr) };
      }
      return { ok: true, detail: null };
    },
    async createContainer(spec) {
      const args = ['create', '--name', spec.name];
      for (const [key, value] of Object.entries(spec.labels)) {
        args.push('--label', `${key}=${value}`);
      }
      for (const mount of spec.mounts) {
        args.push(
          '--mount',
          `type=bind,source=${mount.source},target=${mount.target}${
            mount.readOnly ? ',readonly' : ''
          }`,
        );
      }
      args.push('--workdir', '/workspace', spec.image, ...spec.command);
      const result = await run(args, { timeoutMs: CONTROL_TIMEOUT_MS });
      if (result.spawnError !== null) {
        return { ok: false, id: null, detail: result.spawnError };
      }
      if (result.code !== 0) {
        return { ok: false, id: null, detail: shortDetail(result.stderr) };
      }
      const id = result.stdout.trim().split('\n').pop() ?? '';
      if (id.length === 0) {
        return { ok: false, id: null, detail: 'docker create returned no container id' };
      }
      return { ok: true, id, detail: null };
    },
    async exec(request) {
      const result = await run(
        ['exec', '-i', ...execArguments(request)],
        { input: request.input },
      );
      return {
        exitCode: result.code,
        stdout: result.stdout,
        stderr: result.stderr,
        truncated: result.truncated,
      };
    },
    spawnExec(request) {
      return spawn(command, ['exec', '-i', ...execArguments(request)], {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    },
    async stopContainer(id) {
      const result = await run(['stop', id], { timeoutMs: CONTROL_TIMEOUT_MS });
      return {
        ok: result.spawnError === null && result.code === 0,
        detail: result.spawnError ?? (result.code === 0 ? null : shortDetail(result.stderr)),
      };
    },
    async removeContainer(id) {
      const result = await run(['rm', '-f', id], { timeoutMs: CONTROL_TIMEOUT_MS });
      return {
        ok: result.spawnError === null && result.code === 0,
        detail: result.spawnError ?? (result.code === 0 ? null : shortDetail(result.stderr)),
      };
    },
    async listMarkedContainers(marker) {
      const result = await run(
        ['ps', '-a', '--filter', `label=${marker}`, '--format', '{{.ID}}'],
        { timeoutMs: CONTROL_TIMEOUT_MS },
      );
      if (result.spawnError !== null || result.code !== 0) {
        return [];
      }
      return result.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((id) => ({ id }));
    },
  };
}

function execArguments(request: DockerExecRequest): string[] {
  const args: string[] = [];
  if (request.workdir !== undefined) {
    args.push('-w', request.workdir);
  }
  for (const [key, value] of Object.entries(request.env ?? {})) {
    args.push('-e', `${key}=${value}`);
  }
  args.push(request.containerId, ...request.argv);
  return args;
}

function shortDetail(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
