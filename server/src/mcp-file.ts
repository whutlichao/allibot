import type {
  AgentMcpView,
  McpServerEntry,
  McpTransport,
  MessageKey,
  MessageValues,
} from '@allibot/shared';
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
import { tFromDb } from './copy.js';
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
  key: MessageKey;
  values?: MessageValues;
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
    return { ok: false, problem: { key: 'mcp.file.invalidJson' } };
  }
  if (!isPlainObject(body)) {
    return { ok: false, problem: { key: 'mcp.file.topNotObject' } };
  }
  const unknownTop = Object.keys(body).find((key) => !TOP_LEVEL_KEYS.has(key));
  if (unknownTop !== undefined) {
    return {
      ok: false,
      problem: { key: 'mcp.file.unknownTop', values: { field: unknownTop } },
    };
  }
  if (!Array.isArray(body.servers)) {
    return { ok: false, problem: { key: 'mcp.file.serversRequired' } };
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
        problem: { key: 'mcp.file.duplicateName', values: { name: parsed.entry.name } },
      };
    }
    names.add(parsed.entry.name);
    servers.push(parsed.entry);
  }
  return { ok: true, document: { servers } };
}

/** `PUT {entries}` validation: the same rules as the file, over a JS value. */
export function parseEntries(value: unknown, db: Database.Database): McpServerEntry[] {
  if (!Array.isArray(value)) {
    throw ApiFailure.validation(tFromDb(db, 'mcp.file.entriesArray'), { field: 'entries' });
  }
  const entries: McpServerEntry[] = [];
  const names = new Set<string>();
  for (let index = 0; index < value.length; index += 1) {
    const parsed = parseEntry(value[index], index);
    if (!parsed.ok) {
      throw ApiFailure.validation(renderMcpProblem(db, parsed.problem), {
        field: 'entries',
        index,
      });
    }
    if (names.has(parsed.entry.name)) {
      throw ApiFailure.validation(
        tFromDb(db, 'mcp.file.duplicateEntry', { name: parsed.entry.name }),
        {
          field: 'entries',
          index,
          name: parsed.entry.name,
        },
      );
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
export function readMcpFile(
  filePath: string,
  db: Database.Database,
): McpFileReading {
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
      diagnostic: tFromDb(db, 'mcp.file.unreadable', { path: filePath }),
    };
  }
  const parsed = parseMcpDocument(raw);
  if (!parsed.ok) {
    return {
      path: filePath,
      present: true,
      raw,
      entries: [],
      diagnostic: renderMcpProblem(db, parsed.problem),
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
  const file = readMcpFile(mcpFilePath(memberId, env), db);
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
    throw ApiFailure.validation(tFromDb(db, 'mcp.file.bodyObject'));
  }
  const keys = Object.keys(body);
  const hasEntries = Object.hasOwn(body, 'entries');
  const hasRaw = Object.hasOwn(body, 'raw');
  if (hasEntries === hasRaw) {
    throw ApiFailure.validation(tFromDb(db, 'mcp.file.entriesOrRaw'));
  }
  const unknown = keys.find((key) => key !== 'entries' && key !== 'raw');
  if (unknown !== undefined) {
    throw ApiFailure.validation(tFromDb(db, 'mcp.file.unknownField', { field: unknown }), {
      field: unknown,
    });
  }

  const filePath = mcpFilePath(memberId, env);
  if (hasEntries) {
    const entries = parseEntries(body.entries, db);
    const current = readMcpFile(filePath, db);
    if (current.diagnostic === null && sameEntries(current.entries, entries)) {
      return readAgentMcp(db, memberId, env);
    }
    writeMcpFileAtomically(filePath, canonicalMcpJson(entries));
  } else {
    const raw = body.raw;
    if (typeof raw !== 'string') {
      throw ApiFailure.validation(tFromDb(db, 'mcp.file.rawString'), { field: 'raw' });
    }
    const parsed = parseMcpDocument(raw);
    if (!parsed.ok) {
      throw ApiFailure.validation(renderMcpProblem(db, parsed.problem), { field: 'raw' });
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
  return tFromDb(db, 'mcp.file.remoteUnconfirmed', { names: unconfirmed.join(', ') });
}

function parseEntry(
  value: unknown,
  index: number,
): { ok: true; entry: McpServerEntry } | { ok: false; problem: McpProblem } {
  const entryIndex = index + 1;
  if (!isPlainObject(value)) {
    return {
      ok: false,
      problem: { key: 'mcp.file.entryNotObject', values: { index: entryIndex } },
    };
  }
  const transport = value.transport;
  if (transport !== 'stdio' && transport !== 'http' && transport !== 'sse') {
    return {
      ok: false,
      problem: { key: 'mcp.file.entryTransport', values: { index: entryIndex } },
    };
  }
  const allowed = transport === 'stdio' ? STDIO_KEYS : REMOTE_KEYS;
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) {
    if (transport === 'stdio' && unknown === 'url') {
      return {
        ok: false,
        problem: { key: 'mcp.file.entryStdioUrl', values: { index: entryIndex } },
      };
    }
    if (transport !== 'stdio' && (unknown === 'command' || unknown === 'args')) {
      return {
        ok: false,
        problem: {
          key: 'mcp.file.entryRemoteCommand',
          values: { index: entryIndex, transport, field: unknown },
        },
      };
    }
    return {
      ok: false,
      problem: {
        key: 'mcp.file.entryUnknownField',
        values: { index: entryIndex, field: unknown },
      },
    };
  }

  const name = value.name;
  if (typeof name !== 'string' || name.length === 0) {
    return {
      ok: false,
      problem: { key: 'mcp.file.entryNameMissing', values: { index: entryIndex } },
    };
  }
  if (/[\s/]/.test(name)) {
    return {
      ok: false,
      problem: {
        key: 'mcp.file.entryNameChars',
        values: { index: entryIndex, name },
      },
    };
  }
  if (typeof value.enabled !== 'boolean') {
    return {
      ok: false,
      problem: {
        key: 'mcp.file.entryEnabledBoolean',
        values: { index: entryIndex, name },
      },
    };
  }

  const entry: McpServerEntry = {
    name,
    transport: transport as McpTransport,
    enabled: value.enabled,
  };

  if (transport === 'stdio') {
    if (typeof value.command !== 'string' || value.command.length === 0) {
      return {
        ok: false,
        problem: {
          key: 'mcp.file.entryCommandMissing',
          values: { index: entryIndex, name },
        },
      };
    }
    if (!Array.isArray(value.args) || value.args.some((arg) => typeof arg !== 'string')) {
      return {
        ok: false,
        problem: { key: 'mcp.file.entryArgsArray', values: { index: entryIndex, name } },
      };
    }
    entry.command = value.command;
    entry.args = value.args as string[];
  } else {
    if (typeof value.url !== 'string' || value.url.length === 0) {
      return {
        ok: false,
        problem: { key: 'mcp.file.entryUrlMissing', values: { index: entryIndex, name } },
      };
    }
    let url: URL;
    try {
      url = new URL(value.url);
    } catch {
      return {
        ok: false,
        problem: { key: 'mcp.file.entryUrlInvalid', values: { index: entryIndex, name } },
      };
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return {
        ok: false,
        problem: { key: 'mcp.file.entryUrlProtocol', values: { index: entryIndex, name } },
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
        problem: { key: 'mcp.file.entryEnvNames', values: { index: entryIndex, name } },
      };
    }
    if (envNames.length > 0) {
      entry.env_names = [...(envNames as string[])];
    }
  }

  return { ok: true, entry };
}

/** Render one structured problem through the stored language preference. */
function renderMcpProblem(db: Database.Database, problem: McpProblem): string {
  const values = problem.values ?? {};
  switch (problem.key) {
    case 'mcp.file.invalidJson':
      return tFromDb(db, 'mcp.file.invalidJson');
    case 'mcp.file.topNotObject':
      return tFromDb(db, 'mcp.file.topNotObject');
    case 'mcp.file.unknownTop':
      return tFromDb(db, 'mcp.file.unknownTop', values);
    case 'mcp.file.serversRequired':
      return tFromDb(db, 'mcp.file.serversRequired');
    case 'mcp.file.duplicateName':
      return tFromDb(db, 'mcp.file.duplicateName', values);
    case 'mcp.file.entryNotObject':
      return tFromDb(db, 'mcp.file.entryNotObject', values);
    case 'mcp.file.entryTransport':
      return tFromDb(db, 'mcp.file.entryTransport', values);
    case 'mcp.file.entryStdioUrl':
      return tFromDb(db, 'mcp.file.entryStdioUrl', values);
    case 'mcp.file.entryRemoteCommand':
      return tFromDb(db, 'mcp.file.entryRemoteCommand', values);
    case 'mcp.file.entryUnknownField':
      return tFromDb(db, 'mcp.file.entryUnknownField', values);
    case 'mcp.file.entryNameMissing':
      return tFromDb(db, 'mcp.file.entryNameMissing', values);
    case 'mcp.file.entryNameChars':
      return tFromDb(db, 'mcp.file.entryNameChars', values);
    case 'mcp.file.entryEnabledBoolean':
      return tFromDb(db, 'mcp.file.entryEnabledBoolean', values);
    case 'mcp.file.entryCommandMissing':
      return tFromDb(db, 'mcp.file.entryCommandMissing', values);
    case 'mcp.file.entryArgsArray':
      return tFromDb(db, 'mcp.file.entryArgsArray', values);
    case 'mcp.file.entryUrlMissing':
      return tFromDb(db, 'mcp.file.entryUrlMissing', values);
    case 'mcp.file.entryUrlInvalid':
      return tFromDb(db, 'mcp.file.entryUrlInvalid', values);
    case 'mcp.file.entryUrlProtocol':
      return tFromDb(db, 'mcp.file.entryUrlProtocol', values);
    case 'mcp.file.entryEnvNames':
      return tFromDb(db, 'mcp.file.entryEnvNames', values);
    default:
      return tFromDb(db, problem.key, values);
  }
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
