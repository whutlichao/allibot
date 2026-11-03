import type { AgentMcpView, McpServerEntry, McpTransport } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { ApiFailure } from './api-error.js';
import { agentHomeRoot } from './workspace-root.js';

/**
 * 成员家目录 mcp.json — MCP 声明的唯一正本 (#47 / D6.1 / ADR-0008).
 *
 * One module owns the file shape, validation, canonical serialization and the
 * atomic replacement. Both the management endpoints and the runtime assembly
 * go through `readMcpFile`; the `mcp_server` table is never read here.
 *
 * The file is `{servers: [...]}`. An entry names a transport and either a
 * stdio command (+args) or an http / sse url; `env_names` holds variable names
 * only. Anything else — `headers`, `headers_env`, an inline `env` map or any
 * unknown field — makes the whole file invalid. One bad entry invalidates the
 * declaration: the caller assembles zero MCP, never half a set.
 */

export interface McpDocument {
  servers: McpServerEntry[];
}

interface McpProblem {
  message: string;
}

type ParseResult = { ok: true; document: McpDocument } | { ok: false; problem: McpProblem };

export interface McpFileReading {
  path: string;
  present: boolean;
  /** Exact bytes for the raw textarea; empty when the file is missing. */
  raw: string;
  /** Normalized entries; empty when missing or invalid. */
  entries: McpServerEntry[];
  /** Readable whole-file diagnostic; null when the declaration is usable. */
  diagnostic: string | null;
}

const TOP_LEVEL_KEYS = new Set(['servers']);
const ENTRY_KEYS = new Set(['name', 'transport', 'enabled', 'env_names']);
const STDIO_KEYS = new Set([...ENTRY_KEYS, 'command', 'args']);
const REMOTE_KEYS = new Set([...ENTRY_KEYS, 'url']);

/** The one path both the management face and the runtime assembly read. */
export function mcpFilePath(memberId: string, env: NodeJS.ProcessEnv = process.env): string {
  return path.join(agentHomeRoot(memberId, env), 'mcp.json');
}

/** Parse and validate one file body. A missing file is handled by the caller. */
export function parseMcpDocument(raw: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, problem: { message: 'mcp.json 不是合法 JSON' } };
  }
  if (!isPlainObject(body)) {
    return { ok: false, problem: { message: 'mcp.json 顶层必须是对象' } };
  }
  const unknownTop = Object.keys(body).find((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownTop !== undefined) {
    return { ok: false, problem: { message: `mcp.json 含未知字段：${unknownTop}` } };
  }
  if (!Array.isArray(body.servers)) {
    return { ok: false, problem: { message: 'mcp.json 必须含 servers 数组' } };
  }

  const servers: McpServerEntry[] = [];
  const names = new Set<string>();
  for (let index = 0; index < body.servers.length; index += 1) {
    const parsed = parseEntry(body.servers[index], index);
    if (!parsed.ok) {
      return parsed;
    }
    if (names.has(parsed.entry.name)) {
      return {
        ok: false,
        problem: { message: `mcp.json 条目名重复：${parsed.entry.name}` },
      };
    }
    names.add(parsed.entry.name);
    servers.push(parsed.entry);
  }
  return { ok: true, document: { servers } };
}

/** `PUT {entries}` validation: the same rules as the file, over a JS value. */
export function parseEntries(value: unknown): McpServerEntry[] {
  if (!Array.isArray(value)) {
    throw ApiFailure.validation('entries 必须是数组', { field: 'entries' });
  }
  const entries: McpServerEntry[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseEntry(value[index], index);
    if (!parsed.ok) {
      throw ApiFailure.validation(parsed.problem.message, { field: 'entries', index });
    }
    if (names.has(parsed.entry.name)) {
      throw ApiFailure.validation(`条目名重复：${parsed.entry.name}`, {
        field: 'entries',
        index,
        name: parsed.entry.name,
      });
    }
    names.add(parsed.entry.name);
    entries.push(parsed.entry);
  }
  return sortEntries(entries);
}

/** Canonical JSON for `PUT {entries}`: stable key order, sorted by name. */
export function canonicalMcpJson(entries: readonly McpServerEntry[]): string {
  const servers = sortEntries(entries).map((entry) => {
    const canonical: Record<string, unknown> = {
      name: entry.name,
      transport: entry.transport,
      enabled: entry.enabled,
    };
    if (entry.transport === 'stdio') {
      canonical['command'] = entry.command;
      canonical['args'] = entry.args ?? [];
    } else {
      canonical['url'] = entry.url;
    }
    if (entry.env_names !== undefined && entry.env_names.length > 0) {
      canonical['env_names'] = entry.env_names;
    }
    return canonical;
  });
  return `${JSON.stringify({ servers }, null, 2)}\n`;
}

/** Read the one file; a missing file is a normal zero-MCP fact, not an error. */
export function readMcpFile(filePath: string): McpFileReading {
  if (!existsSync(filePath)) {
    return { path: filePath, present: false, raw: '', entries: [], diagnostic: null };
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8');
  } catch {
    return {
      path: filePath,
      present: true,
      raw: '',
      entries: [],
      diagnostic: `mcp.json 不可读：${filePath}`,
    };
  }
  const parsed = parseMcpDocument(raw);
  if (!parsed.ok) {
    return {
      path: filePath,
      present: true,
      raw,
      entries: [],
      diagnostic: parsed.problem.message,
    };
  }
  return {
    path: filePath,
    present: true,
    raw,
    entries: parsed.document.servers,
    diagnostic: null,
  };
}

/**
 * The management reading (D2.3): the same file, normalized entries for the
 * structured form, exact bytes for the raw textarea, and the readable
 * diagnostic for an externally edited invalid file. Enabled remote servers
 * without a confirmation are named too, because runtime will not connect to
 * them.
 */
export function readAgentMcp(
  db: Database.Database,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentMcpView {
  const file = readMcpFile(mcpFilePath(memberId, env));
  const diagnostic =
    file.diagnostic ?? unconfirmedRemoteDiagnostic(db, file.entries);
  return {
    agent_id: memberId,
    path: file.path,
    present: file.present,
    entries: file.entries,
    raw: file.raw,
    diagnostic,
  };
}

/**
 * Replace the file from exactly one of `entries` / `raw` (D2.3 / D6.1).
 * Same-content replay returns 200 without touching mtime; the write itself is
 * a 0600 temp file plus rename.
 */
export function replaceAgentMcp(
  db: Database.Database,
  memberId: string,
  body: unknown,
  env: NodeJS.ProcessEnv = process.env,
): AgentMcpView {
  if (!isPlainObject(body)) {
    throw ApiFailure.validation('请求体必须是对象');
  }
  const keys = Object.keys(body);
  const hasEntries = Object.hasOwn(body, 'entries');
  const hasRaw = Object.hasOwn(body, 'raw');
  if (hasEntries === hasRaw) {
    throw ApiFailure.validation('请求体必须恰好给 entries 或 raw 之一');
  }
  const unknown = keys.find((key) => key !== 'entries' && key !== 'raw');
  if (unknown !== undefined) {
    throw ApiFailure.validation(`未知字段：${unknown}`, { field: unknown });
  }

  const filePath = mcpFilePath(memberId, env);
  if (hasEntries) {
    const entries = parseEntries(body.entries);
    const current = readMcpFile(filePath);
    if (current.diagnostic === null && sameEntries(current.entries, entries)) {
      return readAgentMcp(db, memberId, env);
    }
    writeMcpFileAtomically(filePath, canonicalMcpJson(entries));
  } else {
    const raw = body.raw;
    if (typeof raw !== 'string') {
      throw ApiFailure.validation('raw 必须是字符串', { field: 'raw' });
    }
    const parsed = parseMcpDocument(raw);
    if (!parsed.ok) {
      throw ApiFailure.validation(parsed.problem.message, { field: 'raw' });
    }
    if (existsSync(filePath) && readFileSync(filePath, 'utf8') === raw) {
      return readAgentMcp(db, memberId, env);
    }
    writeMcpFileAtomically(filePath, raw);
  }
  return readAgentMcp(db, memberId, env);
}

/** 0600 temp file in the same directory, then a rename over the target. */
export function writeMcpFileAtomically(filePath: string, text: string): void {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.mcp.json.${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, text, { encoding: 'utf8', mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, filePath);
    chmodSync(filePath, 0o600);
  } catch (error) {
    try {
      if (existsSync(temporary)) {
        chmodSync(temporary, 0o600);
      }
    } catch {
      // The temporary file is best-effort cleanup; the write error is the fact.
    }
    throw error;
  }
}

/** Whether a remote entry has a confirmation row (scope + time only). */
export function hasMcpConsent(
  db: Database.Database,
  serverName: string,
): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM remote_consent_scope
        WHERE scope_kind = 'mcp' AND scope_id = ?`,
    )
    .get(serverName) as { ok: number } | undefined;
  return row !== undefined;
}

/** The readable management diagnostic for enabled, unconfirmed remote servers. */
export function unconfirmedRemoteDiagnostic(
  db: Database.Database,
  entries: readonly McpServerEntry[],
): string | null {
  const unconfirmed = entries
    .filter(
      (entry) =>
        entry.enabled &&
        entry.transport !== 'stdio' &&
        !hasMcpConsent(db, entry.name),
    )
    .map((entry) => entry.name);
  if (unconfirmed.length === 0) {
    return null;
  }
  return `远端 MCP 未确认数据面，运行期不会连接：${unconfirmed.join(', ')}`;
}

function parseEntry(
  value: unknown,
  index: number,
): { ok: true; entry: McpServerEntry } | { ok: false; problem: McpProblem } {
  const label = `第 ${index + 1} 个条目`;
  if (!isPlainObject(value)) {
    return { ok: false, problem: { message: `${label}必须是对象` } };
  }
  const transport = value.transport;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return {
      ok: false,
      problem: { message: `${label}的 transport 必须是 stdio / http / sse` },
    };
  }
  const allowed = transport === 'stdio' ? STDIO_KEYS : REMOTE_KEYS;
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    if (transport === 'stdio' && unknown === 'url') {
      return {
        ok: false,
        problem: { message: `${label}是 stdio，不能带 url` },
      };
    }
    if (transport !== 'stdio' && (unknown === 'command' || unknown === 'args')) {
      return {
        ok: false,
        problem: { message: `${label}是 ${transport}，不能带 ${unknown}` },
      };
    }
    return { ok: false, problem: { message: `${label}含未知字段：${unknown}` } };
  }

  const name = value.name;
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, problem: { message: `${label}缺少条目名` } };
  }
  if (/[\s/]/.test(name)) {
    return {
      ok: false,
      problem: { message: `${label}的条目名不能含空白或 /：${name}` },
    };
  }
  if (typeof value.enabled !== 'boolean') {
    return { ok: false, problem: { message: `${label}（${name}）的 enabled 必须是布尔值` } };
  }

  const entry: McpServerEntry = {
    name,
    transport: transport as McpTransport,
    enabled: value.enabled,
  };

  if (transport === 'stdio') {
    if (typeof value.command !== 'string' || value.command.length === 0) {
      return { ok: false, problem: { message: `${label}（${name}）缺少 command` } };
    }
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) {
      return {
        ok: false,
        problem: { message: `${label}（${name}）的 args 必须是字符串数组` },
      };
    }
    entry.command = value.command;
    entry.args = value.args as string[];
  } else {
    if (typeof value.url !== 'string' || value.url.length === 0) {
      return { ok: false, problem: { message: `${label}（${name}）缺少 url` } };
    }
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      return { ok: false, problem: { message: `${label}（${name}）的 url 不是合法 URL` } };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        problem: { message: `${label}（${name}）的 url 必须是 http / https` },
      };
    }
    entry.url = value.url;
  }

  if (Object.hasOwn(value, 'env_names')) {
    const envNames = value.env_names;
    if (
      !Array.isArray(envNames) ||
      envNames.some(
        (envName) => typeof envName !== 'string' || envName.length === 0 || envName.includes('='),
      )
    ) {
      return {
        ok: false,
        problem: { message: `${label}（${name}）的 env_names 必须是变量名数组` },
      };
    }
    if (envNames.length > 0) {
      entry.env_names = [...(envNames as string[])];
    }
  }

  return { ok: true, entry };
}

function sortEntries(entries: readonly McpServerEntry[]): McpServerEntry[] {
  return [...entries].sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

export function sameEntries(
  left: readonly McpServerEntry[],
  right: readonly McpServerEntry[],
): boolean {
  return JSON.stringify(sortEntries(left)) === JSON.stringify(sortEntries(right));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
