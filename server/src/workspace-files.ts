import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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
  WriteFileRequest,
} from './agent-seam.js';
import { isInsideOrEqual } from './workspace-root.js';

/**
 * 受限文件工具 (#42 / D5.1). The project root is the only writable root; the
 * member's `skills/` directory is a read-only second root.
 *
 * Path rules, in one place:
 * - a relative path starts at the project root; an absolute path is accepted
 *   only when its realpath is inside one of the two roots;
 * - any `..` segment is a hard error, even when it would normalize back inside
 *   the root;
 * - a symlink is followed for reading, but its realpath must stay inside a
 *   root; an escaping symlink is `outside-root`;
 * - `Write` / `Edit` resolve into the read-only skills root as `read-only`.
 *
 * Every failure is a tool result, not an exception: the round continues, no
 * approval is requested and no permission rule can turn it into success.
 */

interface FileRoot {
  path: string;
  scope: RoundFileScope;
  writable: boolean;
}

interface ResolvedPath {
  root: FileRoot;
  realPath: string;
  relativePath: string;
}

type PathAction = 'read' | 'write' | 'edit';

const MAX_READ_BYTES = 2 * 1024 * 1024;
const MAX_GREP_MATCHES = 200;

export function createRoundFileTools(options: {
  root: string;
  skillsRoot: string | null;
}): RoundFileTools {
  const roots: FileRoot[] = [
    { path: realpathSync(options.root), scope: 'project', writable: true },
  ];
  if (options.skillsRoot !== null) {
    roots.push({ path: options.skillsRoot, scope: 'skills', writable: false });
  }

  function resolve(requested: unknown, action: PathAction): ResolvedPath | RoundFileToolResult {
    if (typeof requested !== 'string' || requested.length === 0 || requested.includes('\0')) {
      return failure('invalid-path', 'path must be a non-empty string');
    }
    if (hasParentSegment(requested)) {
      return failure('outside-root', 'path must not contain ".."');
    }
    const candidate = path.isAbsolute(requested)
      ? path.resolve(requested)
      : path.resolve(roots[0]!.path, requested);
    let realPath: string;
    if (existsSync(candidate)) {
      try {
        realPath = realpathSync(candidate);
      } catch {
        return failure('invalid-path', `path cannot be resolved: ${requested}`);
      }
    } else {
      if (action !== 'write') {
        return failure('not-found', `path does not exist: ${requested}`);
      }
      // A new file may only be created below an existing, in-root directory.
      const parent = path.dirname(candidate);
      if (!existsSync(parent)) {
        return failure('not-found', `parent directory does not exist: ${requested}`);
      }
      let parentReal: string;
      try {
        parentReal = realpathSync(parent);
      } catch {
        return failure('invalid-path', `path cannot be resolved: ${requested}`);
      }
      realPath = path.join(parentReal, path.basename(candidate));
    }

    const root = roots.find((entry) => isInsideOrEqual(realPath, entry.path));
    if (root === undefined) {
      return failure('outside-root', `path escapes the workspace root: ${requested}`);
    }
    if ((action === 'write' || action === 'edit') && !root.writable) {
      return failure('read-only', 'the member skills directory is read-only');
    }
    return {
      root,
      realPath,
      relativePath: path.relative(root.path, realPath).split(path.sep).join('/'),
    };
  }

  function Read(request: ReadFileRequest): RoundFileToolResult {
    const resolved = resolve(request?.path, 'read');
    if (!('realPath' in resolved)) {
      return resolved;
    }
    try {
      if (statSync(resolved.realPath).isDirectory()) {
        return failure('is-directory', `path is a directory: ${request.path}`);
      }
      const bytes = readFileSync(resolved.realPath);
      if (bytes.byteLength > MAX_READ_BYTES) {
        return failure('io-error', 'file is too large to read');
      }
      return {
        ok: true,
        scope: resolved.root.scope,
        path: resolved.relativePath,
        content: bytes.toString('utf8'),
        bytes: bytes.byteLength,
      };
    } catch {
      return failure('io-error', `file cannot be read: ${request.path}`);
    }
  }

  function Glob(request: GlobFileRequest): RoundFileToolResult {
    const pattern = request?.pattern;
    if (
      typeof pattern !== 'string' ||
      pattern.length === 0 ||
      path.isAbsolute(pattern) ||
      hasParentSegment(pattern)
    ) {
      return failure('invalid-pattern', 'glob pattern must be a relative path pattern');
    }
    const base = resolve(request?.path ?? '.', 'read');
    if (!('realPath' in base)) {
      return base;
    }
    if (!statSync(base.realPath).isDirectory()) {
      return failure('not-a-directory', 'glob base is not a directory');
    }
    const matcher = globMatcher(pattern);
    const paths: string[] = [];
    for (const found of walkFiles(base.realPath)) {
      const relative = path.relative(base.realPath, found).split(path.sep).join('/');
      if (matcher(relative)) {
        paths.push(relative);
      }
    }
    paths.sort();
    return { ok: true, scope: base.root.scope, paths };
  }

  function Grep(request: GrepFileRequest): RoundFileToolResult {
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
    const base = resolve(request?.path ?? '.', 'read');
    if (!('realPath' in base)) {
      return base;
    }
    let files: string[];
    try {
      files = statSync(base.realPath).isDirectory()
        ? walkFiles(base.realPath)
        : [base.realPath];
    } catch {
      return failure('io-error', 'grep path cannot be read');
    }

    const matches: RoundGrepMatch[] = [];
    for (const file of files) {
      if (matches.length >= MAX_GREP_MATCHES) {
        break;
      }
      let text: string;
      try {
        const stat = statSync(file);
        if (!stat.isFile() || stat.size > MAX_READ_BYTES) {
          continue;
        }
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
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
            path: path.relative(base.realPath, file).split(path.sep).join('/') || path.basename(file),
            line: index + 1,
            text: line.length > 300 ? `${line.slice(0, 300)}…` : line,
          });
        }
      }
    }
    return { ok: true, scope: base.root.scope, matches };
  }

  function Write(request: WriteFileRequest): RoundFileToolResult {
    if (typeof request?.content !== 'string') {
      return failure('invalid-path', 'write content must be a string');
    }
    const resolved = resolve(request?.path, 'write');
    if (!('realPath' in resolved)) {
      return resolved;
    }
    try {
      writeFileSync(resolved.realPath, request.content, 'utf8');
      return {
        ok: true,
        scope: resolved.root.scope,
        path: resolved.relativePath,
        bytes: Buffer.byteLength(request.content, 'utf8'),
      };
    } catch {
      return failure('io-error', `file cannot be written: ${request.path}`);
    }
  }

  function Edit(request: EditFileRequest): RoundFileToolResult {
    if (
      typeof request?.old_string !== 'string' ||
      request.old_string.length === 0 ||
      typeof request.new_string !== 'string'
    ) {
      return failure('invalid-path', 'edit needs a non-empty old_string and a new_string');
    }
    const resolved = resolve(request?.path, 'edit');
    if (!('realPath' in resolved)) {
      return resolved;
    }
    try {
      if (statSync(resolved.realPath).isDirectory()) {
        return failure('is-directory', `path is a directory: ${request.path}`);
      }
      const content = readFileSync(resolved.realPath, 'utf8');
      const parts = content.split(request.old_string);
      if (parts.length === 1) {
        return failure('old-string-not-found', 'old_string does not occur in the file');
      }
      writeFileSync(resolved.realPath, parts.join(request.new_string), 'utf8');
      return {
        ok: true,
        scope: resolved.root.scope,
        path: resolved.relativePath,
        replacements: parts.length - 1,
      };
    } catch {
      return failure('io-error', `file cannot be edited: ${request.path}`);
    }
  }

  return { Read, Glob, Grep, Write, Edit };
}

function failure(error: FileToolErrorCode, message: string): RoundFileToolResult {
  return { ok: false, error, message };
}

function hasParentSegment(value: string): boolean {
  return value.split(/[\\/]+/).some((segment) => segment === '..');
}

/** Recursively list regular files below `dir`; symlinks are never followed here. */
function walkFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(full));
    } else if (entry.isFile()) {
      files.push(full);
    }
  }
  return files;
}

/**
 * Convert the product's glob dialect to a regular expression: `*` never crosses
 * `/`, `**` crosses directories, `?` is one non-slash character. A trailing
 * `**` matches everything below.
 */
function globMatcher(pattern: string): (relative: string) => boolean {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:.*/)?';
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else if (character === '/') {
      source += '/';
    } else {
      source += character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  const expression = new RegExp(`^${source}$`);
  return (relative) => expression.test(relative);
}

/** `true` when the path exists and the process may list it (the runtime root check). */
export function isReadableDirectory(candidate: string): boolean {
  try {
    accessSync(candidate, constants.R_OK | constants.X_OK);
    return statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}
