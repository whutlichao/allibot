import path from 'node:path';
import type {
  EditFileRequest,
  FileToolErrorCode,
  GlobFileRequest,
  GrepFileRequest,
  ReadFileRequest,
  RoundFileScope,
  RoundFileToolResult,
  RoundFileTools,
  RoundGrepMatch,
  RoundShell,
  RoundShellResult,
  RunShellRequest,
  WriteFileRequest,
} from './agent-seam.js';
import {
  containerToolEnvironment,
  type DockerContainerHandle,
} from './docker-workspace.js';
import { globMatcher, type RoundFileGate } from './workspace-files.js';

/**
 * 容器内文件 / shell 工具 (#49 / D5.3 / ADR-0006 decision 4).
 *
 * In the Docker backend the same tool faces execute inside the Agent container:
 * every file operation is one `docker exec` (`cat`, `find`, `readlink`,
 * `sh`), and the shell runs `sh -c` with cwd `/workspace`. The host project
 * directory is only reachable through the bind mount; the data directory is
 * never mounted, so no tool path can resolve into it.
 *
 * Path policy mirrors the local backend: relative paths start at `/workspace`,
 * absolutes are accepted only inside `/workspace` or the read-only member
 * `skills/` root, any `..` segment is a hard error, and a symlink whose
 * container realpath leaves the roots is `outside-root`. The member home is
 * mounted whole at `/agent-home` (ro) but only its `skills/` directory is a
 * file-tool root — `AGENTS.md` stays outside every tool root.
 *
 * `Grep` keeps the same JavaScript regular-expression semantics as the local
 * backend by reading the candidate files through the container and matching on
 * the host; the Docker default image is small, and correctness is worth the
 * extra execs in M2.
 */

const PROJECT_ROOT = '/workspace';
const SKILLS_ROOT = '/agent-home/skills';
const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_GREP_MATCHES = 200;
const MAX_GREP_FILES = 2000;

interface ContainerRoot {
  containerPath: string;
  scope: RoundFileScope;
  writable: boolean;
}

interface ResolvedContainerPath {
  root: ContainerRoot;
  containerPath: string;
  relativePath: string;
}

type PathAction = 'read' | 'write' | 'edit';

export interface ContainerFileToolsOptions {
  handle: DockerContainerHandle;
  /** The host project root the container mounts at /workspace. */
  projectRoot: string;
  /** The host member `skills/` root, or null when the directory is absent. */
  skillsRoot: string | null;
  envNames?: readonly string[];
  gate?: RoundFileGate;
  hostEnv?: NodeJS.ProcessEnv;
}

export function createContainerFileTools(options: ContainerFileToolsOptions): RoundFileTools {
  const roots: ContainerRoot[] = [{ containerPath: PROJECT_ROOT, scope: 'project', writable: true }];
  if (options.skillsRoot !== null) {
    roots.push({ containerPath: SKILLS_ROOT, scope: 'skills', writable: false });
  }
  const gate = options.gate;
  const hostEnv = options.hostEnv ?? process.env;
  const envNames = options.envNames ?? [];

  async function run(
    argv: readonly string[],
    input?: string,
    maxOutputBytes?: number,
  ): Promise<{
    exitCode: number | null;
    stdout: string;
    stderr: string;
    truncated: boolean;
  }> {
    return await options.handle.exec(argv, {
      workdir: PROJECT_ROOT,
      env: containerToolEnvironment(hostEnv, envNames, PROJECT_ROOT),
      ...(input === undefined ? {} : { input }),
      ...(maxOutputBytes === undefined ? {} : { maxOutputBytes }),
    });
  }

  async function statKind(containerPath: string): Promise<'file' | 'dir' | 'none'> {
    const result = await run([
      'sh',
      '-c',
      'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo none; fi',
      'sh',
      containerPath,
    ]);
    const text = result.stdout.trim();
    return text === 'dir' ? 'dir' : text === 'file' ? 'file' : 'none';
  }

  async function realPath(containerPath: string): Promise<string | null> {
    const result = await run(['sh', '-c', 'readlink -f -- "$1"', 'sh', containerPath]);
    if (result.exitCode !== 0) {
      return null;
    }
    const text = result.stdout.trim();
    return text.length === 0 ? null : text;
  }

  async function resolve(
    requested: unknown,
    action: PathAction,
  ): Promise<ResolvedContainerPath | RoundFileToolResult> {
    if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0')) {
      return failure('invalid-path', 'path must be a non-empty string');
    }
    if (hasParentSegment(requested)) {
      return failure('outside-root', 'path must not contain ".."');
    }
    const mapped = mapToContainer(requested, options.projectRoot, options.skillsRoot);
    if ('error' in mapped) {
      return mapped.error;
    }
    let containerPath = mapped.containerPath;
    const root = roots.find((entry) => isContainerInside(containerPath, entry.containerPath));
    if (root === undefined) {
      return failure('outside-root', `path escapes the workspace root: ${requested}`);
    }

    const kind = await statKind(containerPath);
    if (kind === 'none') {
      if (action !== 'write') {
        return failure('not-found', `path does not exist: ${requested}`);
      }
      const parent = path.posix.dirname(containerPath);
      if ((await statKind(parent)) !== 'dir') {
        return failure('not-found', `parent directory does not exist: ${requested}`);
      }
      const parentReal = await realPath(parent);
      if (parentReal === null || !roots.some((entry) => isContainerInside(parentReal, entry.containerPath))) {
        return failure('outside-root', `path escapes the workspace root: ${requested}`);
      }
      containerPath = path.posix.join(parentReal, path.posix.basename(containerPath));
    } else {
      const resolved = await realPath(containerPath);
      if (resolved === null) {
        return failure('invalid-path', `path cannot be resolved: ${requested}`);
      }
      containerPath = resolved;
    }

    const finalRoot = roots.find((entry) => isContainerInside(containerPath, entry.containerPath));
    if (finalRoot === undefined) {
      return failure('outside-root', `path escapes the workspace root: ${requested}`);
    }
    if ((action === 'write' || action === 'edit') && !finalRoot.writable) {
      return failure('read-only', 'the member skills directory is read-only');
    }
    return {
      root: finalRoot,
      containerPath,
      relativePath: path.posix.relative(finalRoot.containerPath, containerPath) || '.',
    };
  }

  async function authorize(
    toolName: string,
    subject: string,
    args: Record<string, unknown>,
    rootInternalWrite = false,
  ): Promise<RoundFileToolResult | null> {
    if (gate === undefined) {
      return null;
    }
    const decision = await gate.authorize({
      tool_name: toolName,
      pattern: subject,
      arguments: args,
      root_internal_write: rootInternalWrite,
    });
    return decision === 'denied' ? failure('denied', 'DENIED') : null;
  }

  async function Read(request: ReadFileRequest): Promise<RoundFileToolResult> {
    const resolved = await resolve(request?.path, 'read');
    if (!('containerPath' in resolved)) {
      return resolved;
    }
    const denied = await authorize('Read', resolved.relativePath, { path: request.path });
    if (denied !== null) {
      return denied;
    }
    const result = await run(
      [
        'sh',
        '-c',
        'size=$(wc -c < "$1") || exit 2; [ "$size" -le 2097152 ] || exit 3; cat -- "$1"',
        'sh',
        resolved.containerPath,
      ],
      undefined,
      MAX_READ_BYTES + 1024,
    );
    if (result.exitCode === 3 || result.truncated) {
      return failure('io-error', 'file is too large to read');
    }
    if (result.exitCode !== 0) {
      return failure('io-error', `file cannot be read: ${request.path}`);
    }
    return {
      ok: true,
      scope: resolved.root.scope,
      path: resolved.relativePath,
      content: result.stdout,
      bytes: Buffer.byteLength(result.stdout, 'utf8'),
    };
  }

  async function Glob(request: GlobFileRequest): Promise<RoundFileToolResult> {
    const pattern = request?.pattern;
    if (
      typeof pattern !== 'string' ||
      pattern.length === 0 ||
      path.posix.isAbsolute(pattern) ||
      hasParentSegment(pattern)
    ) {
      return failure('invalid-pattern', 'glob pattern must be a relative path pattern');
    }
    const base = await resolve(request?.path ?? '.', 'read');
    if (!('containerPath' in base)) {
      return base;
    }
    if ((await statKind(base.containerPath)) !== 'dir') {
      return failure('not-a-directory', 'glob base is not a directory');
    }
    const denied = await authorize('Glob', pattern, {
      pattern,
      ...(request.path === undefined ? {} : { path: request.path }),
    });
    if (denied !== null) {
      return denied;
    }
    const matcher = globMatcher(pattern);
    const paths: string[] = [];
    for (const found of await listFiles(base.containerPath)) {
      const relative = path.posix.relative(base.containerPath, found);
      if (relative.length > 0 && matcher(relative)) {
        paths.push(relative);
      }
    }
    paths.sort();
    return { ok: true, scope: base.root.scope, paths };
  }

  async function Grep(request: GrepFileRequest): Promise<RoundFileToolResult> {
    const source = request?.pattern;
    if (typeof source !== 'string' || source.length === 0) {
      return failure('invalid-pattern', 'grep pattern must be a non-empty regular expression');
    }
    let expression: RegExp;
    try {
      expression = new RegExp(source);
    } catch {
      return failure('invalid-pattern', 'grep pattern is not a valid regular expression');
    }
    const base = await resolve(request?.path ?? '.', 'read');
    if (!('containerPath' in base)) {
      return base;
    }
    const denied = await authorize('Grep', base.relativePath, {
      pattern: source,
      ...(request.path === undefined ? {} : { path: request.path }),
    });
    if (denied !== null) {
      return denied;
    }
    const kind = await statKind(base.containerPath);
    const files =
      kind === 'dir' ? await listFiles(base.containerPath) : kind === 'file' ? [base.containerPath] : [];
    const matches: RoundGrepMatch[] = [];
    let scanned = 0;
    for (const file of files) {
      if (matches.length >= MAX_GREP_MATCHES || scanned >= MAX_GREP_FILES) {
        break;
      }
      scanned += 1;
      const result = await run(
        [
          'sh',
          '-c',
          'size=$(wc -c < "$1") || exit 2; [ "$size" -le 2097152 ] || exit 3; cat -- "$1"',
          'sh',
          file,
        ],
        undefined,
        MAX_READ_BYTES + 1024,
      );
      if (result.exitCode !== 0 || result.truncated) {
        continue;
      }
      const text = result.stdout;
      if (text.includes('\0')) {
        continue;
      }
      const lines = text.split('\n');
      for (let index = 0; index < lines.length; index += 1) {
        if (matches.length >= MAX_GREP_MATCHES) {
          break;
        }
        const line = lines[index]!;
        if (expression.test(line)) {
          matches.push({
            path: path.posix.relative(base.containerPath, file) || path.posix.basename(file),
            line: index + 1,
            text: line.length > 300 ? `${line.slice(0, 300)}…` : line,
          });
        }
      }
    }
    return { ok: true, scope: base.root.scope, matches };
  }

  async function Write(request: WriteFileRequest): Promise<RoundFileToolResult> {
    if (typeof request?.content !== 'string') {
      return failure('invalid-path', 'write content must be a string');
    }
    const resolved = await resolve(request?.path, 'write');
    if (!('containerPath' in resolved)) {
      return resolved;
    }
    const denied = await authorize(
      'Write',
      resolved.relativePath,
      { path: request.path, content: request.content },
      resolved.root.scope === 'project',
    );
    if (denied !== null) {
      return denied;
    }
    const result = await run(
      ['sh', '-c', 'cat > "$1"', 'sh', resolved.containerPath],
      request.content,
    );
    if (result.exitCode !== 0) {
      return failure('io-error', `file cannot be written: ${request.path}`);
    }
    return {
      ok: true,
      scope: resolved.root.scope,
      path: resolved.relativePath,
      bytes: Buffer.byteLength(request.content, 'utf8'),
    };
  }

  async function Edit(request: EditFileRequest): Promise<RoundFileToolResult> {
    if (
      typeof request?.old_string !== 'string' ||
      request.old_string.length === 0 ||
      typeof request.new_string !== 'string'
    ) {
      return failure('invalid-path', 'edit needs a non-empty old_string and a new_string');
    }
    const resolved = await resolve(request?.path, 'edit');
    if (!('containerPath' in resolved)) {
      return resolved;
    }
    if ((await statKind(resolved.containerPath)) === 'dir') {
      return failure('is-directory', `path is a directory: ${request.path}`);
    }
    const denied = await authorize(
      'Edit',
      resolved.relativePath,
      {
        path: request.path,
        old_string: request.old_string,
        new_string: request.new_string,
      },
      resolved.root.scope === 'project',
    );
    if (denied !== null) {
      return denied;
    }
    const read = await run(
      [
        'sh',
        '-c',
        'size=$(wc -c < "$1") || exit 2; [ "$size" -le 2097152 ] || exit 3; cat -- "$1"',
        'sh',
        resolved.containerPath,
      ],
      undefined,
      MAX_READ_BYTES + 1024,
    );
    if (read.exitCode !== 0 || read.truncated) {
      return failure('io-error', `file cannot be edited: ${request.path}`);
    }
    const parts = read.stdout.split(request.old_string);
    if (parts.length === 1) {
      return failure('old-string-not-found', 'old_string does not occur in the file');
    }
    const written = await run(
      ['sh', '-c', 'cat > "$1"', 'sh', resolved.containerPath],
      parts.join(request.new_string),
    );
    if (written.exitCode !== 0) {
      return failure('io-error', `file cannot be edited: ${request.path}`);
    }
    return {
      ok: true,
      scope: resolved.root.scope,
      path: resolved.relativePath,
      replacements: parts.length - 1,
    };
  }

  async function listFiles(base: string): Promise<string[]> {
    // `-H` follows the command-line mount symlink; Docker bind mounts are real
    // directories, and the flag keeps the same command working under both.
    const result = await run(['sh', '-c', 'find -H "$1" -type f -print', 'sh', base]);
    if (result.exitCode !== 0) {
      return [];
    }
    return result.stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && isContainerInside(line, base))
      .sort();
  }

  return { Read, Glob, Grep, Write, Edit };
}

export interface ContainerShellOptions {
  handle: DockerContainerHandle;
  /** The host project root; relative / host-absolute cwds map to /workspace. */
  projectRoot: string;
  envNames?: readonly string[];
  gate: RoundFileGate;
  hostEnv?: NodeJS.ProcessEnv;
}

/**
 * The container shell face (D5.3): a Docker round always has `Bash` because the
 * shell executes inside the container, not on the host. Every enabled call
 * still goes through the one tool gate and its hard approval (the same `Bash`
 * rule D5.5 applies to the shell), so a deny rule or a human denial is `DENIED`
 * and nothing runs.
 */
export function createContainerShell(options: ContainerShellOptions): RoundShell {
  const hostEnv = options.hostEnv ?? process.env;
  const envNames = options.envNames ?? [];
  return {
    root: options.projectRoot,
    enabled: true,
    async run(request: RunShellRequest): Promise<RoundShellResult> {
      const command = request?.command;
      if (typeof command !== 'string' || command.trim().length === 0 || command.includes('\0')) {
        return shellFailure('invalid-command', 'command must be a non-empty string');
      }
      const resolved = await resolveContainerCwd(
        options.handle,
        options.projectRoot,
        request?.cwd,
      );
      if (!('cwd' in resolved)) {
        return resolved;
      }
      const outcome = await options.gate.authorize({
        tool_name: 'Bash',
        pattern: command,
        tool_call_id: request.tool_call_id,
        arguments: {
          command,
          ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
        },
      });
      if (outcome === 'denied') {
        return shellFailure('denied', 'DENIED');
      }
      const result = await options.handle.exec(['sh', '-c', command], {
        workdir: resolved.cwd,
        env: containerToolEnvironment(hostEnv, envNames, resolved.cwd),
      });
      if (result.exitCode === null) {
        return shellFailure(
          'spawn-failed',
          result.stderr.trim().length > 0 ? result.stderr.trim() : 'docker exec failed',
        );
      }
      return {
        ok: true,
        cwd: resolved.cwd,
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        output_truncated: result.truncated,
      };
    },
  };
}

type ResolvedContainerCwd = { cwd: string } | RoundShellResult;

async function resolveContainerCwd(
  handle: DockerContainerHandle,
  projectRoot: string,
  requested: unknown,
): Promise<ResolvedContainerCwd> {
  let cwd = PROJECT_ROOT;
  if (requested !== undefined) {
    if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0')) {
      return shellFailure('invalid-command', 'cwd must be a non-empty string');
    }
    if (hasParentSegment(requested)) {
      return shellFailure('outside-root', 'cwd must not contain ".."');
    }
    if (path.posix.isAbsolute(requested)) {
      if (isContainerInside(requested, PROJECT_ROOT)) {
        cwd = requested;
      } else if (isInsideHostRoot(requested, projectRoot)) {
        cwd = path.posix.join(PROJECT_ROOT, path.posix.relative(projectRoot, requested));
      } else {
        return shellFailure('outside-root', `cwd escapes the workspace root: ${requested}`);
      }
    } else {
      cwd = path.posix.join(PROJECT_ROOT, requested);
    }
  }
  const result = await handle.exec([
    'sh',
    '-c',
    'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo none; fi',
    'sh',
    cwd,
  ], { workdir: PROJECT_ROOT });
  const kind = result.stdout.trim();
  if (kind === 'none') {
    return shellFailure('not-found', `cwd does not exist: ${requested ?? cwd}`);
  }
  if (kind !== 'dir') {
    return shellFailure('not-a-directory', `cwd is not a directory: ${requested ?? cwd}`);
  }
  if (!isContainerInside(cwd, PROJECT_ROOT)) {
    return shellFailure('outside-root', `cwd escapes the workspace root: ${requested ?? cwd}`);
  }
  return { cwd };
}

/** Map an absolute host path / container path onto the container namespace. */
function mapToContainer(
  requested: string,
  projectRoot: string,
  skillsRoot: string | null,
): { containerPath: string } | { error: RoundFileToolResult } {
  if (path.posix.isAbsolute(requested)) {
    if (isContainerInside(requested, PROJECT_ROOT) || isContainerInside(requested, SKILLS_ROOT)) {
      return { containerPath: path.posix.normalize(requested) };
    }
    if (isInsideHostRoot(requested, projectRoot)) {
      return {
        containerPath: path.posix.join(PROJECT_ROOT, path.posix.relative(projectRoot, requested)),
      };
    }
    if (skillsRoot !== null && isInsideHostRoot(requested, skillsRoot)) {
      return {
        containerPath: path.posix.join(SKILLS_ROOT, path.posix.relative(skillsRoot, requested)),
      };
    }
    return {
      error: failure('outside-root', `path escapes the workspace root: ${requested}`),
    };
  }
  return { containerPath: path.posix.join(PROJECT_ROOT, requested) };
}

function isContainerInside(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function isInsideHostRoot(candidate: string, root: string): boolean {
  const normal = path.resolve(candidate);
  const base = path.resolve(root);
  return normal === base || normal.startsWith(`${base}${path.sep}`);
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

function failure(error: FileToolErrorCode, message: string): RoundFileToolResult {
  return { ok: false, error, message };
}

function shellFailure(error: RoundShellResult['error'], message: string): RoundShellResult {
  return { ok: false, error, message };
}
