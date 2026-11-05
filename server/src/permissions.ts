import {
  PERMISSION_BEHAVIORS,
  PERMISSION_MODES,
  WEB_ACCESS_TIERS,
  type PermissionBehavior,
  type PermissionMode,
  type PermissionReading,
  type PermissionRuleInput,
  type PermissionRuleView,
  type PermissionScopeKind,
  type WebAccessTier,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { readTargetKind } from './sql.js';

/**
 * 权限档与权限规则 (#44 / D5.5). This module is the single decision point for
 * the tool gate: the five file tools, the local-shell hook and the MCP hook all
 * ask `checkPermission` rather than each carrying its own comparison.
 *
 * The fixed order (ADR 0007):
 *
 * 1. hard boundaries — read-only denies writes / execution before any rule;
 *    `allow_local_shell=0` denies the shell; a root escape never reaches this
 *    module (the file tools return a hard tool error first);
 * 2. rule merge — for one call, a same-key Agent row replaces the channel row,
 *    different keys coexist, and every matching row merges `deny > ask > allow`;
 * 3. mode default — read-only reads; ask-writes asks writes / execution;
 *    trusted-writes auto-allows a root-internal write and asks the rest;
 * 4. hard approval — the local shell always asks once it is enabled, unless a
 *    deny rule matches.
 *
 * Tool classification: Read / Glob / Grep read, Write / Edit write, Bash
 * execute, `mcp:<server>/<tool>` execute. TeamAssign / transfer_task / the four
 * Plan tools / SopVerdict are orchestration-internal and never pass through
 * this gate.
 */

export const DEFAULT_PERMISSION_MODE: PermissionMode = 'ask-writes';

/** The tier an unconfigured (`NULL`) web-access value resolves to (D1). */
export const DEFAULT_WEB_ACCESS_TIER: WebAccessTier = 'search';

export type ToolClass = 'read' | 'write' | 'execute' | 'internal';

/** The known built-in tool names, with the class the gate assigns them. */
const BUILTIN_TOOL_CLASSES: Readonly<Record<string, ToolClass>> = {
  Read: 'read',
  Glob: 'read',
  Grep: 'read',
  web_search: 'read',
  Write: 'write',
  Edit: 'write',
  Bash: 'execute',
  fetch: 'execute',
  TeamAssign: 'internal',
  transfer_task: 'internal',
  TaskCreate: 'internal',
  TaskGet: 'internal',
  TaskList: 'internal',
  TaskUpdate: 'internal',
  SopVerdict: 'internal',
};

/** MCP tools are `mcp:<server>/<tool>`; both halves must be non-empty. */
const MCP_TOOL_PATTERN = /^mcp:[^/\s]+\/[^/\s]+$/;

export interface ToolNameReading {
  tool_name: string;
  tool_class: ToolClass;
}

/**
 * Classify a tool name. `null` is the one invalid answer the write path turns
 * into `400 validation_failed`: an unknown built-in name (a typo) and a
 * malformed MCP name are both refused. An `mcp:` name is always execute
 * because there is no trustworthy read-only metadata for a remote tool.
 */
export function classifyToolName(raw: string): ToolNameReading | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const toolName = raw.trim();
  if (toolName.length === 0) {
    return null;
  }
  const builtin = BUILTIN_TOOL_CLASSES[toolName];
  if (builtin !== undefined) {
    return { tool_name: toolName, tool_class: builtin };
  }
  if (MCP_TOOL_PATTERN.test(toolName)) {
    return { tool_name: toolName, tool_class: 'execute' };
  }
  return null;
}

/**
 * The stable JSON an MCP tool's pattern matches: object keys sorted
 * recursively, so the same arguments always serialize the same way (D5.5).
 */
export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (typeof value === 'object' && value !== null) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      sorted[key] = sortJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

/** A file tool's pattern subject is a root-relative POSIX path. */
export function isPathTool(toolName: string): boolean {
  return classifyToolName(toolName)?.tool_class === 'read' ||
    classifyToolName(toolName)?.tool_class === 'write';
}

/**
 * Match one permission pattern against one call subject. The glob is
 * case-sensitive and has no regex / implicit prefix semantics:
 *
 * - a file tool's subject is a root-relative POSIX path; `*` never crosses
 *   `/` and `**` crosses directories;
 * - Bash's subject is the command string and `*` matches anything;
 * - MCP's subject is the stable JSON of the arguments and `*` matches
 *   anything;
 * - the empty pattern matches every call of the tool.
 */
export function matchPermissionPattern(
  toolName: string,
  pattern: string,
  subject: string,
): boolean {
  if (pattern === '') {
    return true;
  }
  const reading = classifyToolName(toolName);
  const expression = new RegExp(
    reading !== null && reading.tool_class !== 'execute'
      ? pathGlobSource(pattern)
      : anyGlobSource(pattern),
  );
  return expression.test(subject);
}

function pathGlobSource(pattern: string): string {
  let source = '^';
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        index += 1;
        if (pattern[index + 1] === '/') {
          index += 1;
          source += '(?:[\\s\\S]*/)?';
        } else {
          source += '[\\s\\S]*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (character === '?') {
      source += '[^/]';
    } else {
      source += escapeRegExp(character);
    }
  }
  return `${source}$`;
}

function anyGlobSource(pattern: string): string {
  let source = '^';
  for (const character of pattern) {
    if (character === '*') {
      source += '[\\s\\S]*';
    } else if (character === '?') {
      source += '[\\s\\S]';
    } else {
      source += escapeRegExp(character);
    }
  }
  return `${source}$`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPermissionMode(value: unknown): value is PermissionMode {
  return typeof value === 'string' && (PERMISSION_MODES as readonly string[]).includes(value);
}

export function isPermissionBehavior(value: unknown): value is PermissionBehavior {
  return (
    typeof value === 'string' && (PERMISSION_BEHAVIORS as readonly string[]).includes(value)
  );
}

/** The write-path gate for a mode value; BYPASS / DONT_ASK / unknown is a 400. */
export function requirePermissionMode(value: unknown): PermissionMode {
  if (!isPermissionMode(value)) {
    throw ApiFailure.validation(
      `permission_mode must be one of: ${PERMISSION_MODES.join(', ')}`,
      { field: 'permission_mode', value },
    );
  }
  return value;
}

export function isWebAccessTier(value: unknown): value is WebAccessTier {
  return typeof value === 'string' && (WEB_ACCESS_TIERS as readonly string[]).includes(value);
}

/**
 * The write-path gate for 联网档 (#68 / D1): exactly the three stored tiers, so
 * `'all'`, a number, `'SEARCH'` and a padded `'search '` are all 400s. `null` is
 * not a tier — the nullable column is the caller's `optional` wrapper's
 * business, which keeps "clear back to unconfigured" distinguishable from "a
 * value that is not a tier".
 */
export function requireWebAccessTier(value: unknown): WebAccessTier {
  if (!isWebAccessTier(value)) {
    throw ApiFailure.validation(
      `web_access must be one of: ${WEB_ACCESS_TIERS.join(', ')}`,
      { field: 'web_access', value },
    );
  }
  return value;
}

/**
 * The effective 联网档 of one target context (D1): the Agent override wins when
 * it is set, then the channel value, then the `search` default. A DM has no
 * channel, so its caller passes `null` there and the Agent level plus the
 * default is the whole chain. Pure on purpose: no database access, so the tool
 * assembly (T4) and the human-face readings resolve the tier the same way.
 */
export function resolveWebAccessTier(
  agentOverride: WebAccessTier | null,
  channelWebAccess: WebAccessTier | null,
): WebAccessTier {
  return agentOverride ?? channelWebAccess ?? DEFAULT_WEB_ACCESS_TIER;
}

/** A target context's permission facts (D5.5). */
export interface TargetPermissionContext {
  targetId: string;
  /** The member this round runs for; the Agent rule scope. */
  memberId: string;
  targetKind: 'channel' | 'task' | 'dm';
  channelId: string | null;
  /** The channel default, or null for a DM (there is no channel). */
  channelMode: PermissionMode | null;
  /** The Agent's raw override; null means follow the channel / default. */
  agentOverride: PermissionMode | null;
  /** The mode this target context resolves to. */
  effective: PermissionMode;
  allowLocalShell: 0 | 1;
  /**
   * The shell runs inside the Docker workspace container (#49 / D5.3) rather
   * than on the host. It is the same `Bash` tool and still needs the hard
   * approval, but the host-local shell switch does not gate it: that switch is
   * the explicit opt-in for the unsandboxed local shell. A local context leaves
   * this absent / false, so the switch semantics are unchanged.
   */
  containerShell?: boolean;
}

/**
 * Resolve one member's permission context on one target: a DM has no channel,
 * so the Agent override or the product default applies; a task follows its
 * channel; a channel reads its own default.
 */
export function readTargetPermissionContext(
  db: Database.Database,
  memberId: string,
  targetId: string,
): TargetPermissionContext | null {
  const kind = readTargetKind(db, targetId);
  if (kind === null) {
    return null;
  }
  if (kind === 'dm') {
    const override = readAgentPermissionOverride(db, memberId);
    return {
      targetId,
      memberId,
      targetKind: 'dm',
      channelId: null,
      channelMode: null,
      agentOverride: override,
      effective: override ?? DEFAULT_PERMISSION_MODE,
      allowLocalShell: 0,
    };
  }
  const row =
    kind === 'channel'
      ? (db
          .prepare('SELECT id, permission_mode, allow_local_shell FROM channel WHERE id = ?')
          .get(targetId) as ChannelPermissionRow | undefined)
      : (db
          .prepare(
            `SELECT c.id, c.permission_mode, c.allow_local_shell
               FROM task t JOIN channel c ON c.id = t.channel_id
              WHERE t.target_id = ?`,
          )
          .get(targetId) as ChannelPermissionRow | undefined);
  if (row === undefined) {
    return null;
  }
  const override = readAgentPermissionOverride(db, memberId);
  const channelMode = isPermissionMode(row.permission_mode)
    ? row.permission_mode
    : DEFAULT_PERMISSION_MODE;
  return {
    targetId,
    memberId,
    targetKind: kind === 'task' ? 'task' : 'channel',
    channelId: row.id,
    channelMode,
    agentOverride: override,
    effective: override ?? channelMode,
    allowLocalShell: row.allow_local_shell === 1 ? 1 : 0,
  };
}

interface ChannelPermissionRow {
  id: string;
  permission_mode: string;
  allow_local_shell: number;
}

/** The raw Agent override (NULL = follow the channel / default). */
export function readAgentPermissionOverride(
  db: Database.Database,
  memberId: string,
): PermissionMode | null {
  const row = db
    .prepare('SELECT permission_mode FROM agent_config WHERE member_id = ?')
    .get(memberId) as { permission_mode: string | null } | undefined;
  return isPermissionMode(row?.permission_mode) ? row.permission_mode : null;
}

/** The two permission readings a channel / Agent / member view returns. */
export function readPermissionReading(
  db: Database.Database,
  memberId: string,
  targetId: string,
): PermissionReading {
  const context = readTargetPermissionContext(db, memberId, targetId);
  return {
    permission_mode: context?.effective ?? DEFAULT_PERMISSION_MODE,
    permission_mode_override: context?.agentOverride ?? readAgentPermissionOverride(db, memberId),
  };
}

/** One tool invocation as the gate sees it. */
export interface PermissionRequest {
  tool_name: string;
  /** A stable adapter / model tool-call id; a retry is the same call. */
  tool_call_id?: string;
  /**
   * The pattern subject: a root-relative file path, the Bash command string,
   * or the stable JSON of the MCP arguments. The empty string is a call with
   * no path (Glob / Grep on the root).
   */
  pattern: string;
  /**
   * `true` when the call is a file write whose path is inside the project root
   * (trusted-writes may auto-allow exactly these). The file tools set it after
   * their own root check; it is never inferred from the pattern text.
   */
  root_internal_write?: boolean;
  /** The masked arguments the approval row / human face may show. */
  arguments?: Record<string, unknown>;
}

export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'ask';
  /**
   * The reason code that produced the decision:
   * `read-only` / `shell-disabled` / `rule-deny` / `rule-ask` / `mode-ask` /
   * `mode-allow` / `trusted-root-write` / `shell-approval`.
   */
  reason:
    | 'read-only'
    | 'shell-disabled'
    | 'rule-deny'
    | 'rule-ask'
    | 'mode-ask'
    | 'mode-allow'
    | 'trusted-root-write'
    | 'shell-approval';
}

/**
 * Decide one tool call. This is synchronous and writes nothing: the caller
 * either executes the tool, returns DENIED, or registers an approval batch.
 */
export function checkPermission(
  db: Database.Database,
  context: TargetPermissionContext,
  request: PermissionRequest,
): PermissionDecision {
  const reading = classifyToolName(request.tool_name);
  if (reading === null) {
    // The adapter only offers known tools; an unknown name is a hard refusal,
    // never an approval question.
    return { decision: 'deny', reason: 'rule-deny' };
  }
  // Orchestration-internal actions never pass through the gate (D5.5).
  if (reading.tool_class === 'internal') {
    return { decision: 'allow', reason: 'mode-allow' };
  }

  // 1. Hard boundaries, before any rule can speak.
  if (reading.tool_class === 'execute' && request.tool_name === 'Bash') {
    if (context.allowLocalShell !== 1 && context.containerShell !== true) {
      return { decision: 'deny', reason: 'shell-disabled' };
    }
  }
  if (context.effective === 'read-only' && reading.tool_class !== 'read') {
    return { decision: 'deny', reason: 'read-only' };
  }

  // 2. Rule merge: same-key Agent rows replace channel rows, then every
  //    matching row merges deny > ask > allow.
  const merged = mergeMatchingRules(db, context, request);
  if (merged === 'deny') {
    return { decision: 'deny', reason: 'rule-deny' };
  }
  if (request.tool_name === 'Bash') {
    // 4. Hard approval: an enabled shell (local host or Docker workspace)
    //    always asks, except that a deny rule above already won. allow rules
    //    and the mode cannot make it automatic.
    return { decision: 'ask', reason: 'shell-approval' };
  }
  if (merged === 'ask') {
    return { decision: 'ask', reason: 'rule-ask' };
  }
  if (merged === 'allow') {
    return { decision: 'allow', reason: 'mode-allow' };
  }

  // 3. Mode default.
  if (reading.tool_class === 'read') {
    return { decision: 'allow', reason: 'mode-allow' };
  }
  if (context.effective === 'trusted-writes' && reading.tool_class === 'write') {
    if (request.root_internal_write === true) {
      return { decision: 'allow', reason: 'trusted-root-write' };
    }
    return { decision: 'ask', reason: 'mode-ask' };
  }
  return { decision: 'ask', reason: 'mode-ask' };
}

/** The merged rule behaviour for one call, or null when nothing matched. */
function mergeMatchingRules(
  db: Database.Database,
  context: TargetPermissionContext,
  request: PermissionRequest,
): PermissionBehavior | null {
  const agentRows = readMatchingRows(
    db,
    'agent',
    context.memberId,
    request.tool_name,
    request.pattern,
  );
  const agentKeys = new Set(agentRows.map((row) => row.pattern));
  // A DM has no channel scope: only the Agent's own rows can match.
  const channelRows =
    context.channelId === null
      ? []
      : readMatchingRows(db, 'channel', context.channelId, request.tool_name, request.pattern);
  // A same-key Agent row replaces the channel row of that key; different keys
  // coexist.
  const rows = [...channelRows.filter((row) => !agentKeys.has(row.pattern)), ...agentRows];
  const matching = rows.filter((row) => row.matches);
  if (matching.some((row) => row.behavior === 'deny')) {
    return 'deny';
  }
  if (matching.some((row) => row.behavior === 'ask')) {
    return 'ask';
  }
  if (matching.some((row) => row.behavior === 'allow')) {
    return 'allow';
  }
  return null;
}

interface MatchingRuleRow {
  pattern: string;
  behavior: PermissionBehavior;
  matches: boolean;
}

/**
 * The rules of one scope for one tool that match this call's subject. The
 * Agent scope reads the round member's id; for a channel-less DM the caller
 * passes the member id as the "agent" scope.
 */
function readMatchingRows(
  db: Database.Database,
  scopeKind: PermissionScopeKind,
  scopeId: string | null,
  toolName: string,
  subject: string,
): MatchingRuleRow[] {
  if (scopeKind === 'agent' && scopeId === null) {
    return [];
  }
  const id = scopeId;
  if (id === null) {
    return [];
  }
  const rows = readPermissionRules(db, scopeKind, id);
  const matching: MatchingRuleRow[] = [];
  for (const row of rows) {
    if (row.tool_name !== toolName) {
      continue;
    }
    if (matchPermissionPattern(toolName, row.pattern, subject)) {
      matching.push({ pattern: row.pattern, behavior: row.behavior, matches: true });
    }
  }
  return matching;
}

/**
 * The Agent override and channel default as one readable context. A member
 * may be a DM peer whose Agent scope is the DM's agent; the caller passes the
 * member id that runs the round.
 */
export function readMemberPermissionMode(
  db: Database.Database,
  member: { id: string; kind: string },
  targetContext: TargetPermissionContext,
): PermissionMode {
  if (member.kind !== 'agent') {
    return targetContext.channelMode ?? DEFAULT_PERMISSION_MODE;
  }
  return readAgentPermissionOverride(db, member.id) ?? targetContext.channelMode ??
    DEFAULT_PERMISSION_MODE;
}

// ---------------------------------------------------------------------------
// Rule storage / human face
// ---------------------------------------------------------------------------

let ruleSequence = 0;

/** The rules of one scope in stable insertion order. */
export function readPermissionRules(
  db: Database.Database,
  scopeKind: PermissionScopeKind,
  scopeId: string,
): PermissionRuleView[] {
  const rows = db
    .prepare(
      `SELECT id, scope_kind, scope_id, tool_name, pattern, behavior, created_at, updated_at
         FROM permission_rule
        WHERE scope_kind = ? AND scope_id = ?
        ORDER BY created_at, rowid`,
    )
    .all(scopeKind, scopeId) as PermissionRuleView[];
  return rows.map((row) => ({
    ...row,
    behavior: row.behavior as PermissionBehavior,
    scope_kind: row.scope_kind as PermissionScopeKind,
  }));
}

export interface ParsedRuleSet {
  rules: PermissionRuleInput[];
}

/** Parse the body of `PUT .../permission-rules` (a complete replacement). */
export function parsePermissionRuleSet(body: unknown): PermissionRuleInput[] {
  if (!Array.isArray(body)) {
    throw ApiFailure.validation('permission rules must be a JSON array');
  }
  const seen = new Set<string>();
  const rules: PermissionRuleInput[] = [];
  for (const entry of body) {
    const rule = parsePermissionRule(entry);
    const key = `${rule.tool_name}\u0000${rule.pattern}`;
    if (seen.has(key)) {
      throw ApiFailure.validation(
        `duplicate permission rule for tool ${rule.tool_name} and pattern ${JSON.stringify(rule.pattern)}`,
        { field: 'rules', value: rule },
      );
    }
    seen.add(key);
    rules.push(rule);
  }
  return rules;
}

export function parsePermissionRule(entry: unknown): PermissionRuleInput {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw ApiFailure.validation('a permission rule must be a JSON object');
  }
  const record = entry as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'tool_name' && key !== 'pattern' && key !== 'behavior') {
      throw ApiFailure.validation(`unknown permission rule field: ${key}`);
    }
  }
  const toolName = record['tool_name'];
  if (typeof toolName !== 'string') {
    throw ApiFailure.validation('permission rule tool_name must be a string');
  }
  const classified = classifyToolName(toolName);
  if (classified === null) {
    throw ApiFailure.validation(
      `unknown tool name: ${toolName}; MCP tools are written mcp:<server>/<tool>`,
      { field: 'tool_name', value: toolName },
    );
  }
  const pattern = record['pattern'];
  if (typeof pattern !== 'string') {
    throw ApiFailure.validation('permission rule pattern must be a string');
  }
  const behavior = record['behavior'];
  if (!isPermissionBehavior(behavior)) {
    throw ApiFailure.validation(
      `permission rule behavior must be one of: ${PERMISSION_BEHAVIORS.join(', ')}`,
      { field: 'behavior', value: behavior },
    );
  }
  return { tool_name: classified.tool_name, pattern, behavior };
}

/**
 * Write a complete rule set atomically. A same-content replay writes nothing
 * (so timestamps and ids stay stable); any invalid row aborts the whole call
 * with the old set intact because parsing happens before the transaction and
 * the delete + insert shares one transaction.
 */
export function writePermissionRules(
  db: Database.Database,
  scopeKind: PermissionScopeKind,
  scopeId: string,
  rules: readonly PermissionRuleInput[],
): PermissionRuleView[] {
  const existing = readPermissionRules(db, scopeKind, scopeId);
  // "Same content" is order-insensitive: a replay (including a reordered one)
  // writes nothing, so ids and timestamps stay stable.
  const existingKeys = new Set(existing.map((row) => `${row.tool_name}\u0000${row.pattern}`));
  const sameSet =
    existing.length === rules.length &&
    existingKeys.size === rules.length &&
    rules.every(
      (rule) =>
        existingKeys.has(`${rule.tool_name}\u0000${rule.pattern}`) &&
        existing.some(
          (row) =>
            row.tool_name === rule.tool_name &&
            row.pattern === rule.pattern &&
            row.behavior === rule.behavior,
        ),
    );
  if (sameSet) {
    return existing;
  }
  const now = new Date().toISOString();
  const write = db.transaction((): void => {
    db.prepare('DELETE FROM permission_rule WHERE scope_kind = ? AND scope_id = ?').run(
      scopeKind,
      scopeId,
    );
    const insert = db.prepare(
      `INSERT INTO permission_rule
         (id, scope_kind, scope_id, tool_name, pattern, behavior, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const rule of rules) {
      // A local id generator avoids sharing the approvals module's id seam.
      ruleSequence += 1;
      insert.run(
        `rule-${Date.now().toString(36)}-${ruleSequence}`,
        scopeKind,
        scopeId,
        rule.tool_name,
        rule.pattern,
        rule.behavior,
        now,
        now,
      );
    }
  });
  write();
  return readPermissionRules(db, scopeKind, scopeId);
}

/** The channel / Agent must exist before a rule set can be replaced. */
export function assertRuleScopeExists(
  db: Database.Database,
  scopeKind: PermissionScopeKind,
  scopeId: string,
): void {
  if (scopeKind === 'channel') {
    const row = db.prepare('SELECT id FROM channel WHERE id = ?').get(scopeId);
    if (row === undefined) {
      throw ApiFailure.notFound(`channel not found: ${scopeId}`);
    }
    return;
  }
  const row = db
    .prepare("SELECT id FROM member WHERE id = ? AND kind = 'agent' AND deleted_at IS NULL")
    .get(scopeId);
  if (row === undefined) {
    throw ApiFailure.notFound(`agent not found: ${scopeId}`);
  }
}
