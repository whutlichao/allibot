import type {
  AgentSkillCandidatesView,
  SkillCandidateView,
  SkillImportAllView,
  SkillImportItemView,
  SkillInstallView,
  SkillSource,
  SkillView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { createHash, randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ApiFailure } from './api-error.js';
import { tFromDb } from './copy.js';
import {
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_BYTES,
  MAX_SKILL_ZIP_BYTES,
  SKILL_MANIFEST,
  SKILL_NAME_PATTERN,
} from './skill-limits.js';
import { agentSkillsRoot, isInsideOrEqual, workspaceHomeRoot } from './workspace-root.js';
import { readZipArchive } from './zip-archive.js';

/**
 * Skill 的安装、字节与元数据 (#48 / D6.3).
 *
 * The v21 `skill` table is metadata only: id, member, name, the normalized
 * content hash, enabled, source and timestamps. The bytes are a copied tree at
 * `~/.allibot/agents/<member_id>/skills/<name>/`; this module owns both the
 * validation kernel and the copy, so all three install sources produce the
 * same hash for the same bytes.
 *
 * The hash is the SHA-256 of the normalized manifest: files sorted by their
 * POSIX relative path, each contributing `path\0size\0bytes\0`. Permissions and
 * timestamps never enter it, so a directory, a zip and an import of the same
 * content compare equal.
 *
 * Limits: 200 files, 5 MiB of extracted bytes and 5 MiB of zip bytes. The
 * installer refuses the whole package rather than keeping a partial tree.
 */

export {
  MAX_SKILL_FILES,
  MAX_SKILL_TOTAL_BYTES,
  MAX_SKILL_ZIP_BYTES,
  SKILL_MANIFEST,
  SKILL_NAME_PATTERN,
} from './skill-limits.js';

interface SkillRow {
  id: string;
  member_id: string;
  name: string;
  content_hash: string;
  enabled: number;
  source: SkillSource;
  created_at: string;
  updated_at: string;
}

interface SkillFile {
  /** POSIX-style path relative to the skill root. */
  relative: string;
  bytes: Buffer;
}

interface SkillTree {
  files: SkillFile[];
  contentHash: string;
  manifest: string;
}

const SKILL_SELECT = `
SELECT id, member_id, name, content_hash, enabled, source, created_at, updated_at
FROM skill`;

/** The member's skills partition; the app writes here on install. */
export function memberSkillsRoot(
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return agentSkillsRoot(memberId, env);
}

/** The global public library (`~/.allibot/skills/`, D5.2); read-only assembly. */
export function globalPublicSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return path.join(workspaceHomeRoot(env), 'skills');
}

/** Read the Agent row or throw the unified 404 (D2.1). */
export function requireAgent(db: Database.Database, memberId: string): void {
  const row = db
    .prepare("SELECT id FROM member WHERE id = ? AND kind = 'agent' AND deleted_at IS NULL")
    .get(memberId) as { id: string } | undefined;
  if (row === undefined) {
    throw ApiFailure.notFound(`agent not found: ${memberId}`);
  }
}

/** The one slug rule shared by install, upload, import and DELETE. */
export function assertSkillName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string' || !SKILL_NAME_PATTERN.test(value)) {
    throw ApiFailure.validation(
      'skill name must be a safe slug: 1-64 characters, starting with a letter or digit, only A-Z a-z 0-9 . _ -',
      { field, value },
    );
  }
  return value;
}

/** A stable JSON-ish row view: enabled is a boolean on the human face. */
export function skillView(row: SkillRow): SkillView {
  return {
    id: row.id,
    member_id: row.member_id,
    name: row.name,
    content_hash: row.content_hash,
    enabled: row.enabled === 1,
    source: row.source,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listSkills(db: Database.Database, memberId: string): SkillView[] {
  const rows = db
    .prepare(`${SKILL_SELECT} WHERE member_id = ? ORDER BY name, id`)
    .all(memberId) as SkillRow[];
  return rows.map(skillView);
}

export function getSkill(
  db: Database.Database,
  memberId: string,
  name: string,
): SkillView | null {
  const row = db
    .prepare(`${SKILL_SELECT} WHERE member_id = ? AND name = ?`)
    .get(memberId, name) as SkillRow | undefined;
  return row === undefined ? null : skillView(row);
}

function rowByName(db: Database.Database, memberId: string, name: string): SkillRow | null {
  const row = db
    .prepare(`${SKILL_SELECT} WHERE member_id = ? AND name = ?`)
    .get(memberId, name) as SkillRow | undefined;
  return row ?? null;
}

/**
 * The manifest root: SKILL.md at the package root, or a package wrapped in one
 * single top-level directory (the common zip layout). Nothing else is accepted.
 */
function manifestRoot(directory: string): string {
  if (isFile(path.join(directory, SKILL_MANIFEST))) {
    return directory;
  }
  let children: string[] = [];
  try {
    children = readdirSync(directory).filter((child) => isDirectory(path.join(directory, child)));
  } catch {
    throw ApiFailure.validation(`skill source is not readable: ${directory}`, {
      field: 'source',
      path: directory,
    });
  }
  if (children.length === 1) {
    const wrapped = path.join(directory, children[0]!);
    if (isFile(path.join(wrapped, SKILL_MANIFEST))) {
      return wrapped;
    }
  }
  throw ApiFailure.validation(`${SKILL_MANIFEST} is missing from the skill root`, {
    field: 'source',
    path: directory,
  });
}

function isFile(filePath: string): boolean {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function isDirectory(filePath: string): boolean {
  try {
    return statSync(filePath).isDirectory();
  } catch {
    return false;
  }
}

function decodeUtf8(bytes: Buffer, field: string): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw ApiFailure.validation(`${SKILL_MANIFEST} must be valid UTF-8`, { field });
  }
}

/**
 * Validate and read one skill tree. Every file is read into memory (the total
 * is capped at 5 MiB) so the copy, the hash and the limits see the same bytes.
 * A symlink is accepted only when it resolves to a regular file still inside
 * the same tree; anything that leaves the package is refused (D6.3).
 */
function collectTree(directory: string): SkillTree {
  const root = realpathSync(directory);
  const files: SkillFile[] = [];
  let total = 0;

  const walk = (current: string, relativePrefix: string): void => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      throw ApiFailure.validation(`skill directory is not readable: ${current}`, {
        field: 'source',
      });
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const relative = relativePrefix.length === 0 ? entry.name : `${relativePrefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        const resolved = realpathSync(full);
        if (!isInsideOrEqual(resolved, root)) {
          throw ApiFailure.validation(
            `skill contains a symlink that escapes the package: ${relative}`,
            { field: 'source', path: relative },
          );
        }
        const resolvedStat = statSync(resolved);
        if (!resolvedStat.isFile()) {
          throw ApiFailure.validation(
            `skill contains a symlinked directory: ${relative}`,
            { field: 'source', path: relative },
          );
        }
        appendFile(relative, readFileSync(resolved), resolvedStat.size);
        continue;
      }
      if (entry.isDirectory()) {
        walk(full, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw ApiFailure.validation(`skill contains a non-regular entry: ${relative}`, {
          field: 'source',
          path: relative,
        });
      }
      appendFile(relative, readFileSync(full), statSync(full).size);
    }
  };

  function appendFile(relative: string, bytes: Buffer, size: number = bytes.length): void {
    if (relative.length === 0 || relative.startsWith('/')) {
      throw ApiFailure.validation(`skill contains an absolute path: ${relative}`, {
        field: 'source',
        path: relative,
      });
    }
    const parts = relative.split('/');
    if (parts.some((part) => part === '..' || part === '' || part === '.')) {
      throw ApiFailure.validation(`skill contains an unsafe path: ${relative}`, {
        field: 'source',
        path: relative,
      });
    }
    const nextTotal = total + size;
    if (nextTotal > MAX_SKILL_TOTAL_BYTES) {
      throw ApiFailure.validation(
        `skill exceeds the ${MAX_SKILL_TOTAL_BYTES} byte extracted limit`,
        { field: 'source', limit: MAX_SKILL_TOTAL_BYTES },
      );
    }
    total = nextTotal;
    files.push({ relative, bytes });
    if (files.length > MAX_SKILL_FILES) {
      throw ApiFailure.validation(`skill exceeds the ${MAX_SKILL_FILES} file limit`, {
        field: 'source',
        limit: MAX_SKILL_FILES,
      });
    }
  }

  walk(root, '');
  files.sort((left, right) => (left.relative < right.relative ? -1 : left.relative > right.relative ? 1 : 0));
  const manifestFile = files.find((file) => file.relative === SKILL_MANIFEST);
  if (manifestFile === undefined) {
    throw ApiFailure.validation(`${SKILL_MANIFEST} is missing from the skill root`, {
      field: 'source',
      path: directory,
    });
  }
  const manifest = decodeUtf8(manifestFile.bytes, 'source');
  return { files, contentHash: hashFiles(files), manifest };
}

/** SHA-256 over the normalized, sorted file manifest (D6.3). */
export function hashFiles(files: readonly { relative: string; bytes: Buffer }[]): string {
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(file.relative, 'utf8');
    digest.update('\0');
    digest.update(String(file.bytes.length), 'utf8');
    digest.update('\0');
    digest.update(file.bytes);
    digest.update('\0');
  }
  return digest.digest('hex');
}

function writeTree(root: string, files: readonly SkillFile[]): void {
  for (const file of files) {
    const target = path.join(root, ...file.relative.split('/'));
    mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
    writeFileSync(target, file.bytes, { mode: 0o600 });
  }
}

function removeTree(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

/**
 * The one installer shared by the directory, zip and `~/.agents/skills`
 * sources. `source` names the install origin; every other validation and the
 * hash are identical.
 */
function installTree(
  db: Database.Database,
  memberId: string,
  nameInput: unknown,
  tree: SkillTree,
  source: SkillSource,
  env: NodeJS.ProcessEnv,
): SkillInstallView {
  const name = assertSkillName(nameInput);
  const existing = rowByName(db, memberId, name);
  const destination = path.join(memberSkillsRoot(memberId, env), name);
  if (existing !== null) {
    if (existing.content_hash === tree.contentHash) {
      return { skill: skillView(existing), created: false };
    }
    throw ApiFailure.conflict(`skill ${name} is already installed with different bytes`, {
      field: 'name',
      name,
      installed_hash: existing.content_hash,
      incoming_hash: tree.contentHash,
    });
  }
  if (existsSync(destination)) {
    // Bytes without a row (an interrupted install or a hand copy): adopt them
    // only when they are exactly the bytes being installed; never overwrite.
    let current: SkillTree;
    try {
      current = collectTree(destination);
    } catch {
      throw ApiFailure.conflict(`skill ${name} already exists at ${destination}`, {
        field: 'name',
        name,
      });
    }
    if (current.contentHash !== tree.contentHash) {
      throw ApiFailure.conflict(`skill ${name} already exists with different bytes`, {
        field: 'name',
        name,
        installed_hash: current.contentHash,
        incoming_hash: tree.contentHash,
      });
    }
    const row = insertRow(db, memberId, name, tree.contentHash, source);
    return { skill: row, created: false };
  }

  const partition = memberSkillsRoot(memberId, env);
  mkdirSync(partition, { recursive: true, mode: 0o700 });
  const staging = path.join(partition, `.tmp-${randomUUID()}`);
  mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    writeTree(staging, tree.files);
    // The staging tree is the same bytes the hash was computed from; the copy
    // is renamed into place so a reader never sees a half-written skill.
    renameSync(staging, destination);
  } catch (error) {
    removeTree(staging);
    throw error;
  }
  try {
    const row = insertRow(db, memberId, name, tree.contentHash, source);
    return { skill: row, created: true };
  } catch (error) {
    removeTree(destination);
    throw error;
  }
}

function insertRow(
  db: Database.Database,
  memberId: string,
  name: string,
  contentHash: string,
  source: SkillSource,
): SkillView {
  const now = new Date().toISOString();
  const row: SkillRow = {
    id: randomUUID(),
    member_id: memberId,
    name,
    content_hash: contentHash,
    enabled: 1,
    source,
    created_at: now,
    updated_at: now,
  };
  db.prepare(
    `INSERT INTO skill
       (id, member_id, name, content_hash, enabled, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.id,
    row.member_id,
    row.name,
    row.content_hash,
    row.enabled,
    row.source,
    row.created_at,
    row.updated_at,
  );
  return skillView(row);
}

/** Install from a local directory (D6.3 source 1). */
export function installSkillFromDirectory(
  db: Database.Database,
  memberId: string,
  sourcePath: unknown,
  options: { name?: unknown; source?: SkillSource; env?: NodeJS.ProcessEnv } = {},
): SkillInstallView {
  requireAgent(db, memberId);
  if (typeof sourcePath !== 'string' || sourcePath.length === 0 || !path.isAbsolute(sourcePath)) {
    throw ApiFailure.validation('path must be an absolute directory path', {
      field: 'path',
      value: sourcePath,
    });
  }
  let resolved: string;
  try {
    resolved = realpathSync(sourcePath);
  } catch {
    throw ApiFailure.validation('path does not exist', { field: 'path', value: sourcePath });
  }
  if (!isDirectory(resolved)) {
    throw ApiFailure.validation('path is not a directory', { field: 'path', value: sourcePath });
  }
  const root = manifestRoot(resolved);
  // Never copy the destination partition into itself (a source ancestor of the
  // partition would recurse as the copy grows).
  const env = options.env ?? process.env;
  const partition = realpathOrSelf(memberSkillsRoot(memberId, env));
  if (isInsideOrEqual(partition, root)) {
    throw ApiFailure.validation('path must not contain the member skills directory', {
      field: 'path',
      value: sourcePath,
    });
  }
  const tree = collectTree(root);
  const name =
    options.name ??
    frontMatterFields(tree.manifest).name ??
    path.basename(root);
  return installTree(db, memberId, name, tree, options.source ?? 'directory', env);
}

/** The optional YAML front matter the prompt / candidates read name + description from. */
export function frontMatterFields(markdown: string): {
  name: string | null;
  description: string | null;
} {
  const lines = markdown.split(/\r?\n/);
  if (lines[0]?.trim() !== '---') {
    return { name: null, description: null };
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === '---');
  if (end === -1) {
    return { name: null, description: null };
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (match === null) {
      continue;
    }
    fields[match[1]!] = match[2]!.trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  const name = fields['name'] ?? null;
  const description = fields['description'] ?? null;
  return {
    name: name !== null && SKILL_NAME_PATTERN.test(name) ? name : null,
    description: description !== null && description.length > 0 ? description : null,
  };
}

function realpathOrSelf(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
}

/** Read one installed SKILL.md for the detail endpoint (read-only). */
export function readSkillMarkdown(
  db: Database.Database,
  memberId: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): { skill: SkillView; markdown: string } {
  const skill = getSkill(db, memberId, name);
  if (skill === null) {
    throw ApiFailure.notFound(`skill not found: ${name}`);
  }
  const directory = path.join(memberSkillsRoot(memberId, env), name);
  const manifest = path.join(directory, SKILL_MANIFEST);
  try {
    const resolved = realpathSync(manifest);
    if (!isInsideOrEqual(resolved, realpathSync(directory))) {
      throw new Error('manifest escapes the skill directory');
    }
    return { skill, markdown: readFileSync(resolved, 'utf8') };
  } catch {
    throw ApiFailure.notFound(`skill files not found: ${name}`);
  }
}

/** `PATCH {enabled}`: a same-value replay keeps `updated_at` stable (D2.4). */
export function setSkillEnabled(
  db: Database.Database,
  memberId: string,
  name: string,
  body: unknown,
): SkillView {
  requireAgent(db, memberId);
  const input = parseEnabledBody(body);
  const existing = rowByName(db, memberId, name);
  if (existing === null) {
    throw ApiFailure.notFound(`skill not found: ${name}`);
  }
  const next = input ? 1 : 0;
  if (existing.enabled !== next) {
    const updatedAt = new Date().toISOString();
    db.prepare('UPDATE skill SET enabled = ?, updated_at = ? WHERE id = ?').run(
      next,
      updatedAt,
      existing.id,
    );
    return skillView({ ...existing, enabled: next, updated_at: updatedAt });
  }
  return skillView(existing);
}

function parseEnabledBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be an object', { field: 'body' });
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  const unknown = keys.find((key) => key !== 'enabled');
  if (unknown !== undefined) {
    throw ApiFailure.validation(`unknown field: ${unknown}`, { field: unknown });
  }
  if (typeof record['enabled'] !== 'boolean') {
    throw ApiFailure.validation('enabled must be a boolean', { field: 'enabled' });
  }
  return record['enabled'];
}

/** `DELETE`: removes the row and the member copy; a repeat is still 204. */
export function deleteSkill(
  db: Database.Database,
  memberId: string,
  name: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  requireAgent(db, memberId);
  const existing = rowByName(db, memberId, name);
  if (existing === null) {
    return;
  }
  const directory = path.join(memberSkillsRoot(memberId, env), name);
  removeTree(directory);
  db.prepare('DELETE FROM skill WHERE id = ?').run(existing.id);
}

/** `~/.agents/skills/` is the external CLI's landing directory (D6.3); read-only. */
export function importSkillsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME;
  const base = home !== undefined && home.length > 0 ? home : homedir();
  return path.join(base, '.agents', 'skills');
}

/** Install from `~/.agents/skills/<name>/` (D6.3 source 3). */
export function installSkillFromAgentsSkills(
  db: Database.Database,
  memberId: string,
  nameInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SkillInstallView {
  requireAgent(db, memberId);
  const name = assertSkillName(nameInput);
  const root = realpathOrSelf(importSkillsRoot(env));
  const candidate = path.join(root, name);
  let resolved: string;
  try {
    resolved = realpathSync(candidate);
  } catch {
    throw ApiFailure.validation(`skill candidate not found: ${name}`, { field: 'name', value: name });
  }
  if (!isDirectory(resolved) || !isInsideOrEqual(resolved, root) || resolved === root) {
    throw ApiFailure.validation(`skill candidate is not a directory inside the import root: ${name}`, {
      field: 'name',
      value: name,
    });
  }
  return installSkillFromDirectory(db, memberId, resolved, {
    name,
    source: 'agents-skills',
    env,
  });
}

/**
 * `POST /api/agents/{id}/skills` body: exactly one of the two JSON sources.
 * The directory source takes `path` (and an optional explicit `name`);
 * `agents-skills` takes `name` and reads the external CLI's landing directory.
 */
export function installSkillFromRequest(
  db: Database.Database,
  memberId: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SkillInstallView {
  requireAgent(db, memberId);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be an object', { field: 'body' });
  }
  const record = body as Record<string, unknown>;
  const source = record['source'];
  const allowed =
    source === 'directory'
      ? new Set(['source', 'path', 'name'])
      : source === 'agents-skills'
        ? new Set(['source', 'name'])
        : null;
  if (allowed === null) {
    throw ApiFailure.validation('source must be directory or agents-skills', {
      field: 'source',
      value: source,
    });
  }
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    throw ApiFailure.validation(`unknown field: ${unknown}`, { field: unknown });
  }
  if (source === 'directory') {
    return installSkillFromDirectory(db, memberId, record['path'], {
      ...(record['name'] === undefined ? {} : { name: record['name'] }),
      source: 'directory',
      env,
    });
  }
  return installSkillFromAgentsSkills(db, memberId, record['name'], env);
}

/**
 * Install from an uploaded zip (D6.3 source 2). The archive's size ceiling is
 * checked before extraction; paths, symlinks, file count and the extracted
 * size are checked by the reader before anything is written to the home.
 */
export function installSkillFromZip(
  db: Database.Database,
  memberId: string,
  bytes: Buffer,
  nameInput: unknown,
  env: NodeJS.ProcessEnv = process.env,
): SkillInstallView {
  requireAgent(db, memberId);
  const name = assertSkillName(nameInput);
  if (bytes.length > MAX_SKILL_ZIP_BYTES) {
    throw ApiFailure.validation(`zip exceeds the ${MAX_SKILL_ZIP_BYTES} byte limit`, {
      field: 'upload',
      limit: MAX_SKILL_ZIP_BYTES,
    });
  }
  const entries = readZipArchive(bytes);
  const partition = memberSkillsRoot(memberId, env);
  mkdirSync(partition, { recursive: true, mode: 0o700 });
  const stagingRoot = path.join(partition, `.tmp-${randomUUID()}`);
  const extracted = path.join(stagingRoot, 'extracted');
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  try {
    for (const entry of entries) {
      const target = path.join(extracted, ...entry.name.split('/'));
      mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      writeFileSync(target, entry.bytes, { mode: 0o600 });
    }
    const root = manifestRoot(extracted);
    const tree = collectTree(root);
    return installTree(db, memberId, name, tree, 'zip', env);
  } finally {
    removeTree(stagingRoot);
  }
}

/**
 * The read-only candidate scan of `~/.agents/skills/` (D6.3 source 3). It never
 * creates the landing directory and never copies; a broken / unsafe candidate
 * only marks that item unimportable, leaving the rest of the list intact.
 */
export function scanSkillCandidates(
  db: Database.Database,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentSkillCandidatesView {
  requireAgent(db, memberId);
  const source = importSkillsRoot(env);
  const installed = new Set(
    (db.prepare('SELECT name FROM skill WHERE member_id = ?').all(memberId) as { name: string }[]).map(
      (row) => row.name,
    ),
  );
  if (!existsSync(source) || !isDirectory(source)) {
    return { agent_id: memberId, source, available: false, candidates: [] };
  }
  let entries;
  try {
    entries = readdirSync(source, { withFileTypes: true });
  } catch {
    return { agent_id: memberId, source, available: true, candidates: [] };
  }
  entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  const root = realpathOrSelf(source);
  const candidates: SkillCandidateView[] = [];
  for (const entry of entries) {
    if (entry.isFile()) {
      continue;
    }
    const name = entry.name;
    const lexical = path.join(source, name);
    const candidate: SkillCandidateView = {
      name,
      path: lexical,
      importable: false,
      installed: installed.has(name),
      reason: null,
    };
    try {
      if (entry.isSymbolicLink()) {
        throw ApiFailure.validation(`candidate is a symlink: ${name}`, { field: 'name' });
      }
      if (!entry.isDirectory()) {
        continue;
      }
      if (!SKILL_NAME_PATTERN.test(name)) {
        throw ApiFailure.validation(`candidate name is not a safe slug: ${name}`, {
          field: 'name',
        });
      }
      const resolved = realpathSync(lexical);
      if (!isInsideOrEqual(resolved, root) || resolved === root) {
        throw ApiFailure.validation(`candidate escapes the import root: ${name}`, {
          field: 'name',
        });
      }
      candidate.path = resolved;
      collectTree(manifestRoot(resolved));
      candidate.importable = true;
      candidate.reason = null;
    } catch (error) {
      candidate.importable = false;
      candidate.reason = error instanceof ApiFailure ? error.message : String(error);
    }
    candidates.push(candidate);
  }
  return { agent_id: memberId, source, available: true, candidates };
}

/** `import-all`: every importable, not-yet-installed candidate, one by one. */
export function importAllSkillCandidates(
  db: Database.Database,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): SkillImportAllView {
  const scan = scanSkillCandidates(db, memberId, env);
  const results: SkillImportItemView[] = [];
  let imported = 0;
  let skipped = 0;
  let failed = 0;
  for (const candidate of scan.candidates) {
    if (candidate.installed) {
      skipped += 1;
      results.push({ name: candidate.name, status: 'skipped', reason: 'already installed', skill: null });
      continue;
    }
    if (!candidate.importable) {
      skipped += 1;
      results.push({
        name: candidate.name,
        status: 'skipped',
        reason: candidate.reason,
        skill: null,
      });
      continue;
    }
    try {
      // The single-entry installer is the only write path; import-all never
      // copies bytes itself.
      const installedNow = installSkillFromAgentsSkills(db, memberId, candidate.name, env);
      imported += 1;
      results.push({
        name: candidate.name,
        status: 'imported',
        reason: null,
        skill: installedNow.skill,
      });
    } catch (error) {
      failed += 1;
      results.push({
        name: candidate.name,
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        skill: null,
      });
    }
  }
  return { agent_id: memberId, results, imported, skipped, failed };
}

interface AssembledSkill {
  name: string;
  description: string;
  markdown: string;
}

/**
 * Read one skill tree for assembly. A missing / unreadable / tampered tree is
 * skipped, never a round failure: the skill body is prompt material, so a bad
 * copy only means that skill is absent from this round.
 */
function loadAssembledSkill(directory: string, expectedHash?: string): AssembledSkill | null {
  try {
    const tree = collectTree(directory);
    if (expectedHash !== undefined && tree.contentHash !== expectedHash) {
      return null;
    }
    const fields = frontMatterFields(tree.manifest);
    return {
      name: path.basename(directory),
      description: fields.description ?? '',
      markdown: tree.manifest,
    };
  } catch {
    return null;
  }
}

function sortedDirectories(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The two-layer assembly (D5.2 / D6.3): the member home first, the global
 * public library second, and a same-name member skill always wins. Assembly is
 * pure bytes + prompt text; it does not read the project layer, it does not
 * grant tools and it is independent of the workspace.
 */
export function assembleSkills(
  db: Database.Database,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): AssembledSkill[] {
  const rows = db
    .prepare('SELECT name, content_hash, enabled FROM skill WHERE member_id = ? ORDER BY name')
    .all(memberId) as { name: string; content_hash: string; enabled: number }[];
  const knownNames = new Set(rows.map((row) => row.name));
  const winners: AssembledSkill[] = [];
  const seen = new Set<string>();

  const add = (skill: AssembledSkill | null): void => {
    if (skill === null || seen.has(skill.name)) {
      return;
    }
    seen.add(skill.name);
    winners.push(skill);
  };

  // Layer 1a: enabled rows (the app-owned installs), in name order.
  for (const row of rows) {
    if (row.enabled !== 1) {
      continue;
    }
    add(
      loadAssembledSkill(
        path.join(memberSkillsRoot(memberId, env), row.name),
        row.content_hash,
      ),
    );
  }
  // Layer 1b: manual member-home directories with no row. A disabled / broken
  // row still owns its name, so its bytes never reappear as a manual entry.
  for (const name of sortedDirectories(memberSkillsRoot(memberId, env))) {
    if (knownNames.has(name) || !SKILL_NAME_PATTERN.test(name)) {
      continue;
    }
    add(loadAssembledSkill(path.join(memberSkillsRoot(memberId, env), name)));
  }
  // Layer 2: the global public library; same-name member entries already won.
  for (const name of sortedDirectories(globalPublicSkillsRoot(env))) {
    if (!SKILL_NAME_PATTERN.test(name)) {
      continue;
    }
    add(loadAssembledSkill(path.join(globalPublicSkillsRoot(env), name)));
  }
  return winners;
}

/**
 * The system-prompt section for this member's assembled skills. It exists on
 * every round, including a DM / no-project-root round: the text is prompt
 * material and never a tool. A round with zero assembled skills has no section.
 */
export function skillPromptSection(
  db: Database.Database,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const skills = assembleSkills(db, memberId, env);
  if (skills.length === 0) {
    return null;
  }
  const blocks = skills.map((skill) =>
    [
      '<skill>',
      `<name>${skill.name}</name>`,
      `<description>${skill.description}</description>`,
      '<content>',
      skill.markdown.replace(/\s+$/, ''),
      '</content>',
      '</skill>',
    ].join('\n'),
  );
  return tFromDb(db, 'prompt.skills', { skills: blocks.join('\n') });
}

/** Validate one skill tree without writing; used by `migrate-skills`. */
export function readSkillTreeStats(directory: string): {
  contentHash: string;
  fileCount: number;
  bytes: number;
} {
  const tree = collectTree(directory);
  return {
    contentHash: tree.contentHash,
    fileCount: tree.files.length,
    bytes: tree.files.reduce((total, file) => total + file.bytes.length, 0),
  };
}

/**
 * Record one already-copied Agent-level row (the migration path). It never
 * overwrites an existing row and never writes bytes; returns whether a row was
 * created.
 */
export function recordSkillRow(
  db: Database.Database,
  memberId: string,
  name: string,
  contentHash: string,
  source: SkillSource,
): boolean {
  if (rowByName(db, memberId, name) !== null) {
    return false;
  }
  insertRow(db, memberId, name, contentHash, source);
  return true;
}
