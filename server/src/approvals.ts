import {
  type ApprovalBatchView,
  type ApprovalContextKind,
  type ApprovalDecisionInput,
  type ApprovalDecisionView,
  type ApprovalStatus,
  type ApprovalToolCallView,
  type ApprovalView,
  type PermissionRuleInput,
  type PermissionScopeKind,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { ApiFailure } from './api-error.js';
import { nowIso } from './clock.js';
import { publishApprovalRequested, publishApprovalResolved } from './events.js';
import {
  parsePermissionRuleSet,
  stableJson,
  writePermissionRules,
} from './permissions.js';
import { readTargetKind } from './sql.js';

/**
 * 审批 (Approval / HITL) (#44 / D5.6). One `approval_request` row per reply,
 * keyed by the reply's stable id. A reply may carry several batches: the Nth
 * ask reopens a resolved row (merge the new calls, clear `resolved_at`, move
 * `requested_at` to the new batch's start, keep the old decisions) and
 * publishes only the new calls. `failed` / `expired` are terminal.
 *
 * The wait itself is process-local, like the live SSE hub: a pending batch is
 * awaited by the round that asked, a human decision resolves it, and the
 * process restart write path (not this module) turns residual pending rows into
 * `expired`. There is no replay across restart.
 */

export const DEFAULT_APPROVAL_TIMEOUT_MS = 600_000;

/**
 * How long one batch waits for a human decision. Production is the spec's 600
 * seconds; a test injects a shorter value (`--approval-timeout-ms`) exactly
 * like the SSE lifetime / reminder tick injections. The stored timestamps still
 * use the process clock.
 */
let approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS;

export function setApprovalTimeoutMs(ms: number): void {
  approvalTimeoutMs = ms;
}

export function getApprovalTimeoutMs(): number {
  return approvalTimeoutMs;
}

/** The masked tool call as it is stored and read back. */
interface StoredToolCall extends ApprovalToolCallView {
  member_id: string;
}

interface ApprovalRow {
  reply_id: string;
  target_id: string | null;
  context_kind: ApprovalContextKind;
  context_id: string | null;
  tool_calls: string;
  decisions: string;
  status: ApprovalStatus;
  requested_at: string;
  resolved_at: string | null;
}

export interface RegisterApprovalInput {
  replyId: string;
  /**
   * The model / adapter tool-call id, when it has one. Re-registering the same
   * id is the idempotent duplicate-registration case; a call without an id is
   * always a distinct invocation.
   */
  toolCallId?: string;
  targetId: string;
  contextKind: ApprovalContextKind;
  contextId: string | null;
  memberId: string;
  toolName: string;
  /** The pattern subject (file path / command / stable MCP JSON). */
  pattern: string;
  /** Secret-shaped fields are masked before the row and the frame. */
  arguments: Record<string, unknown>;
}

type WaitOutcome = 'approved' | 'denied' | 'timeout';

interface ReplyWait {
  batch: number;
  timeout: NodeJS.Timeout;
  waiters: Map<string, (outcome: WaitOutcome) => void>;
}

/**
 * The process-local waiters of the batches that are currently pending. One
 * reply has at most one pending batch; a new batch replaces the entry only
 * after the previous one closed.
 */
const replyWaits = new Map<string, ReplyWait>();

/**
 * Register one tool call for approval and wait for the human decision.
 *
 * - a new reply / batch inserts a pending row and publishes it;
 * - a call already registered in the current pending batch just waits (the
 *   same registration is idempotent, it does not reopen);
 * - a resolved (`confirmed` / `denied`) row reopens as a new batch, keeping the
 *   old decisions, when the new call is not already in the history;
 * - `failed` / `expired` are terminal: a late call is denied and the row stays
 *   untouched.
 */
export async function requestApproval(
  db: Database.Database,
  input: RegisterApprovalInput,
): Promise<WaitOutcome> {
  const call: StoredToolCall = {
    tool_call_id: input.toolCallId ?? randomUUID(),
    tool_name: input.toolName,
    // An MCP subject is the stable argument JSON; mask it exactly like the
    // argument copy so a secret-shaped value never reaches the row or the API.
    pattern: maskApprovalPattern(input.toolName, input.pattern),
    batch: 1,
    arguments: maskToolArguments(input.arguments),
    requested_at: nowIso(),
    member_id: input.memberId,
  };

  const registered = db.transaction((): {
    outcome: 'wait' | 'terminal';
    batch: number;
    toolCallId: string;
    newCallIds: string[];
    decided?: boolean;
  } => {
    const row = readApprovalRow(db, input.replyId);
    if (row === undefined) {
      insertPendingRow(db, input, call);
      return { outcome: 'wait', batch: 1, toolCallId: call.tool_call_id, newCallIds: [call.tool_call_id] };
    }
    const calls = parseCalls(row);
    const existing = calls.find((entry) => entry.tool_call_id === call.tool_call_id);
    const decisions = parseDecisions(row);
    if (existing !== undefined) {
      const decision = decisions.find((entry) => entry.tool_call_id === existing.tool_call_id);
      if (decision !== undefined) {
        // The same decision is a replay: no new row fact and no reopen.
        return {
          outcome: 'wait',
          batch: existing.batch,
          toolCallId: existing.tool_call_id,
          newCallIds: [],
          decided: decision.confirmed,
        };
      }
      return {
        outcome: 'wait',
        batch: existing.batch,
        toolCallId: existing.tool_call_id,
        newCallIds: [],
      };
    }
    if (row.status === 'failed' || row.status === 'expired') {
      return { outcome: 'terminal', batch: 0, toolCallId: call.tool_call_id, newCallIds: [] };
    }
    const batch = row.status === 'pending' ? maxBatch(calls) : maxBatch(calls) + 1;
    call.batch = batch;
    calls.push(call);
    const reopened = row.status !== 'pending';
    db.prepare(
      `UPDATE approval_request
          SET tool_calls = ?, status = 'pending', resolved_at = NULL,
              requested_at = CASE WHEN ? = 1 THEN ? ELSE requested_at END
        WHERE reply_id = ?`,
    ).run(
      JSON.stringify(calls),
      reopened ? 1 : 0,
      reopened ? nowIso() : row.requested_at,
      input.replyId,
    );
    return { outcome: 'wait', batch, toolCallId: call.tool_call_id, newCallIds: [call.tool_call_id] };
  })();

  if (registered.outcome === 'terminal') {
    return 'denied';
  }

  const updated = readApprovalRow(db, input.replyId);
  if (updated === undefined) {
    throw new Error('approval row disappeared after registration');
  }
  if (registered.newCallIds.length > 0) {
    publishApprovalRequested(approvalSsePayload(updated, registered.newCallIds));
  }

  if (registered.decided !== undefined) {
    return registered.decided ? 'approved' : 'denied';
  }

  // Register the waiter and make sure the batch has one timeout. The row
  // timestamps use the process clock; the wait itself is a real timer whose
  // duration is the configured timeout (600s in production).
  const key = input.replyId;
  let wait = replyWaits.get(key);
  if (wait === undefined || wait.batch !== registered.batch) {
    const batch = registered.batch;
    const timeout = setTimeout(() => {
      failTimedOutBatch(db, key, batch);
    }, approvalTimeoutMs);
    timeout.unref();
    wait = { batch, timeout, waiters: new Map() };
    replyWaits.set(key, wait);
  }
  return await new Promise<WaitOutcome>((resolve) => {
    wait!.waiters.set(registered.toolCallId, resolve);
    // A decision may have landed between the read and the waiter registration
    // only if a synchronous write path ran in between, which is impossible in
    // this event loop; the replay branch above already handles decided calls.
  });
}

/** Apply one human decision to one tool call (D5.6 / D2.4). */
export function decideApproval(
  db: Database.Database,
  replyId: string,
  body: unknown,
): ApprovalView {
  const parsed = parseDecisionInput(body);
  const rules = parsed.rules === undefined ? undefined : parsePermissionRuleSet(parsed.rules);
  const outcome = db.transaction((): { closed: boolean; waited: string[] } => {
    const row = readApprovalRow(db, replyId);
    if (row === undefined) {
      throw ApiFailure.notFound(`approval not found: ${replyId}`);
    }
    const calls = parseCalls(row);
    const decisions = parseDecisions(row);
    const call = calls.find((entry) => entry.tool_call_id === parsed.tool_call_id);
    if (call === undefined) {
      throw ApiFailure.validation(`unknown tool_call_id: ${parsed.tool_call_id}`, {
        field: 'tool_call_id',
        value: parsed.tool_call_id,
      });
    }
    const existing = decisions.find((entry) => entry.tool_call_id === parsed.tool_call_id);
    if (existing !== undefined) {
      if (existing.confirmed !== parsed.confirmed) {
        throw ApiFailure.conflict(
          `tool call ${parsed.tool_call_id} was already ${existing.confirmed ? 'approved' : 'denied'}`,
          { tool_call_id: parsed.tool_call_id },
        );
      }
      // Same decision replay: 200. A provided rule set is still applied
      // atomically (a full replacement makes this idempotent).
      applyRulesIfPresent(db, row, rules);
      return { closed: false, waited: [] };
    }
    if (row.status !== 'pending') {
      throw ApiFailure.conflict(
        `approval ${replyId} is ${row.status}; it accepts no new decision`,
        { status: row.status },
      );
    }
    decisions.push({
      tool_call_id: parsed.tool_call_id,
      confirmed: parsed.confirmed,
      decided_at: nowIso(),
    });
    applyRulesIfPresent(db, row, rules);
    const decidedIds = new Set(decisions.map((entry) => entry.tool_call_id));
    const currentBatchCalls = calls.filter((entry) => entry.batch === call.batch);
    const batchClosed = currentBatchCalls.every((entry) => decidedIds.has(entry.tool_call_id));
    if (!batchClosed) {
      db.prepare('UPDATE approval_request SET decisions = ? WHERE reply_id = ?').run(
        JSON.stringify(decisions),
        replyId,
      );
      return { closed: false, waited: [parsed.tool_call_id] };
    }
    // 收口判据是全部历史决策：任一历史拒绝，最终 status 仍是 denied.
    const anyDenied = decisions.some((entry) => !entry.confirmed);
    db.prepare(
      `UPDATE approval_request
          SET decisions = ?, status = ?, resolved_at = ?
        WHERE reply_id = ?`,
    ).run(JSON.stringify(decisions), anyDenied ? 'denied' : 'confirmed', nowIso(), replyId);
    return {
      closed: true,
      waited: currentBatchCalls.map((entry) => entry.tool_call_id),
    };
  })();

  const updated = readApprovalRow(db, replyId);
  if (updated === undefined) {
    throw new Error('approval row disappeared after a decision');
  }
  resolveWaiters(replyId, updated, outcome.closed, outcome.waited);
  if (outcome.closed) {
    publishApprovalResolved(approvalSsePayload(updated, []));
  }
  return toApprovalView(updated);
}

/** Read one approval (including its batches) or 404. */
export function getApproval(db: Database.Database, replyId: string): ApprovalView {
  const row = readApprovalRow(db, replyId);
  if (row === undefined) {
    throw ApiFailure.notFound(`approval not found: ${replyId}`);
  }
  return toApprovalView(row);
}

export interface ApprovalQuery {
  status: ApprovalStatus | 'all';
  targetId?: string;
  limit: number;
}

/** Parse `GET /api/approvals?status=&target_id=&limit=`. */
export function parseApprovalQuery(params: URLSearchParams): ApprovalQuery {
  const rawStatus = params.get('status') ?? 'pending';
  const allowed: readonly string[] = ['pending', 'confirmed', 'denied', 'failed', 'expired', 'all'];
  if (!allowed.includes(rawStatus)) {
    throw ApiFailure.validation(`status must be one of: ${allowed.join(', ')}`, {
      field: 'status',
      value: rawStatus,
    });
  }
  const rawLimit = params.get('limit');
  let limit = 20;
  if (rawLimit !== null) {
    if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 50) {
      throw ApiFailure.validation('limit must be an integer between 1 and 50', {
        field: 'limit',
        value: rawLimit,
      });
    }
    limit = Number(rawLimit);
  }
  const targetId = params.get('target_id') ?? undefined;
  return { status: rawStatus as ApprovalQuery['status'], targetId, limit };
}

/** The approval list: default pending, `status=all` reads every state. */
export function listApprovals(db: Database.Database, query: ApprovalQuery): ApprovalView[] {
  const conditions: string[] = [];
  const values: unknown[] = [];
  if (query.status !== 'all') {
    conditions.push('status = ?');
    values.push(query.status);
  }
  if (query.targetId !== undefined) {
    conditions.push('target_id = ?');
    values.push(query.targetId);
  }
  const where = conditions.length === 0 ? '' : `WHERE ${conditions.join(' AND ')}`;
  const rows = db
    .prepare(
      `SELECT reply_id, target_id, context_kind, context_id, tool_calls, decisions,
              status, requested_at, resolved_at
         FROM approval_request
         ${where}
         ORDER BY requested_at DESC, rowid DESC
         LIMIT ?`,
    )
    .all(...(values as never[]), query.limit) as ApprovalRow[];
  return rows.map(toApprovalView);
}

/** The workspace reading's `pending_approvals` count. */
export function countPendingApprovals(db: Database.Database): number {
  const row = db
    .prepare("SELECT COUNT(*) AS count FROM approval_request WHERE status = 'pending'")
    .get() as { count: number };
  return row.count;
}

/**
 * The startup closure (D5.6): a pending approval belongs to a round the
 * previous process never concluded. It closes `expired`; nothing is replayed
 * and no waiter survives the restart.
 */
export function expirePendingApprovals(db: Database.Database): number {
  return db
    .prepare(
      `UPDATE approval_request
          SET status = 'expired', resolved_at = ?
        WHERE status = 'pending'`,
    )
    .run(nowIso()).changes;
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function readApprovalRow(db: Database.Database, replyId: string): ApprovalRow | undefined {
  return db
    .prepare(
      `SELECT reply_id, target_id, context_kind, context_id, tool_calls, decisions,
              status, requested_at, resolved_at
         FROM approval_request
        WHERE reply_id = ?`,
    )
    .get(replyId) as ApprovalRow | undefined;
}

function insertPendingRow(
  db: Database.Database,
  input: RegisterApprovalInput,
  call: StoredToolCall,
): void {
  db.prepare(
    `INSERT INTO approval_request
       (reply_id, target_id, context_kind, context_id, tool_calls, decisions,
        status, requested_at, resolved_at)
     VALUES (?, ?, ?, ?, ?, '[]', 'pending', ?, NULL)`,
  ).run(
    input.replyId,
    input.targetId,
    input.contextKind,
    input.contextId,
    JSON.stringify([call]),
    nowIso(),
  );
}

function parseCalls(row: ApprovalRow): StoredToolCall[] {
  const parsed: unknown = JSON.parse(row.tool_calls);
  if (!Array.isArray(parsed)) {
    throw new Error('approval_request.tool_calls is not a JSON array');
  }
  return parsed as StoredToolCall[];
}

function parseDecisions(row: ApprovalRow): ApprovalDecisionView[] {
  const parsed: unknown = JSON.parse(row.decisions);
  if (!Array.isArray(parsed)) {
    throw new Error('approval_request.decisions is not a JSON array');
  }
  return parsed as ApprovalDecisionView[];
}

function maxBatch(calls: readonly StoredToolCall[]): number {
  return calls.reduce((max, entry) => Math.max(max, entry.batch), 1);
}

function toApprovalView(row: ApprovalRow): ApprovalView {
  const calls = parseCalls(row);
  const decisions = parseDecisions(row);
  const batches = new Map<number, ApprovalBatchView>();
  for (const call of calls) {
    let batch = batches.get(call.batch);
    if (batch === undefined) {
      batch = {
        batch: call.batch,
        requested_at: call.requested_at,
        tool_calls: [],
        decisions: [],
      };
      batches.set(call.batch, batch);
    }
    batch.requested_at = batch.requested_at < call.requested_at ? batch.requested_at : call.requested_at;
    batch.tool_calls.push(withoutMember(call));
  }
  for (const decision of decisions) {
    const call = calls.find((entry) => entry.tool_call_id === decision.tool_call_id);
    const batch = call === undefined ? undefined : batches.get(call.batch);
    batch?.decisions.push(decision);
  }
  return {
    reply_id: row.reply_id,
    target_id: row.target_id,
    context_kind: row.context_kind,
    context_id: row.context_id,
    status: row.status,
    requested_at: row.requested_at,
    resolved_at: row.resolved_at,
    tool_calls: calls.map(withoutMember),
    decisions,
    batches: [...batches.values()].sort((left, right) => left.batch - right.batch),
  };
}

function withoutMember(call: StoredToolCall): ApprovalToolCallView {
  const { member_id: _memberId, ...view } = call;
  return view;
}

function parseDecisionInput(body: unknown): ApprovalDecisionInput {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'tool_call_id' && key !== 'confirmed' && key !== 'rules') {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const toolCallId = record['tool_call_id'];
  if (typeof toolCallId !== 'string' || toolCallId.trim().length === 0) {
    throw ApiFailure.validation('tool_call_id must be a non-empty string');
  }
  const confirmed = record['confirmed'];
  if (typeof confirmed !== 'boolean') {
    throw ApiFailure.validation('confirmed must be a boolean', { field: 'confirmed' });
  }
  if (record['rules'] !== undefined && !Array.isArray(record['rules'])) {
    throw ApiFailure.validation('rules must be a JSON array', { field: 'rules' });
  }
  return {
    tool_call_id: toolCallId.trim(),
    confirmed,
    rules: record['rules'] as PermissionRuleInput[] | undefined,
  };
}

/**
 * `rules?` is the complete replacement of the approval's rule scope. The scope
 * is the target's channel (a task follows its channel); a DM has no channel, so
 * the rules replace the calling Agent's set. A SOP approval has no target and
 * therefore no rule scope (its wiring belongs to #45).
 */
function applyRulesIfPresent(
  db: Database.Database,
  row: ApprovalRow,
  rules: PermissionRuleInput[] | undefined,
): void {
  if (rules === undefined) {
    return;
  }
  const scope = approvalRuleScope(db, row);
  if (scope === null) {
    throw ApiFailure.validation('this approval context has no rule scope', {
      field: 'rules',
      context_kind: row.context_kind,
    });
  }
  writePermissionRules(db, scope.kind, scope.id, rules);
}

function approvalRuleScope(
  db: Database.Database,
  row: ApprovalRow,
): { kind: PermissionScopeKind; id: string } | null {
  if (row.target_id === null) {
    return null;
  }
  const kind = readTargetKind(db, row.target_id);
  if (kind === 'channel') {
    return { kind: 'channel', id: row.target_id };
  }
  if (kind === 'task') {
    const task = db
      .prepare('SELECT channel_id FROM task WHERE target_id = ?')
      .get(row.target_id) as { channel_id: string } | undefined;
    return task === undefined ? null : { kind: 'channel', id: task.channel_id };
  }
  if (kind === 'dm') {
    const call = parseCalls(row)[0];
    const memberId = call?.member_id;
    return memberId === undefined ? null : { kind: 'agent', id: memberId };
  }
  return null;
}

function approvalSsePayload(
  row: ApprovalRow,
  toolCallIds: string[],
): {
  reply_id: string;
  context_kind: string;
  context_id: string | null;
  target_id: string | null;
  status: string;
  tool_call_ids: string[];
} {
  return {
    reply_id: row.reply_id,
    context_kind: row.context_kind,
    context_id: row.context_id,
    target_id: row.target_id,
    status: row.status,
    tool_call_ids: toolCallIds,
  };
}

/** Resolve the waiters whose call was just decided (or whose batch closed). */
function resolveWaiters(
  replyId: string,
  row: ApprovalRow,
  closed: boolean,
  decidedCallIds: readonly string[],
): void {
  const wait = replyWaits.get(replyId);
  if (wait === undefined) {
    return;
  }
  const decisions = parseDecisions(row);
  const ids = closed
    ? [...wait.waiters.keys()]
    : decidedCallIds.filter((id) => wait.waiters.has(id));
  for (const id of ids) {
    const decision = decisions.find((entry) => entry.tool_call_id === id);
    if (decision === undefined) {
      continue;
    }
    const resolve = wait.waiters.get(id);
    wait.waiters.delete(id);
    resolve?.(decision.confirmed ? 'approved' : 'denied');
  }
  if (closed) {
    clearTimeout(wait.timeout);
    for (const resolve of wait.waiters.values()) {
      resolve('denied');
    }
    wait.waiters.clear();
    replyWaits.delete(replyId);
  }
}

/**
 * The batch timeout: only the batch that is still current may fail. A reopened
 * batch has its own timer; the old timer sees a different batch and does
 * nothing.
 */
function failTimedOutBatch(db: Database.Database, replyId: string, batch: number): void {
  const row = readApprovalRow(db, replyId);
  if (row === undefined || row.status !== 'pending') {
    return;
  }
  const calls = parseCalls(row);
  if (maxBatch(calls) !== batch) {
    return;
  }
  db.prepare(
    `UPDATE approval_request
        SET status = 'failed', resolved_at = ?
      WHERE reply_id = ? AND status = 'pending'`,
  ).run(nowIso(), replyId);
  const updated = readApprovalRow(db, replyId);
  if (updated !== undefined) {
    publishApprovalResolved(approvalSsePayload(updated, []));
  }
  const wait = replyWaits.get(replyId);
  if (wait !== undefined && wait.batch === batch) {
    clearTimeout(wait.timeout);
    for (const resolve of wait.waiters.values()) {
      resolve('timeout');
    }
    wait.waiters.clear();
    replyWaits.delete(replyId);
  }
}

/** Mask secret-shaped fields inside an MCP JSON subject before storing it. */
function maskApprovalPattern(toolName: string, pattern: string): string {
  if (!toolName.startsWith('mcp:')) {
    return pattern;
  }
  try {
    return stableJson(maskValue(JSON.parse(pattern)));
  } catch {
    return '***';
  }
}

const SECRET_KEY_PATTERN =
  /(api[-_]?key|secret|token|password|passwd|credential|authorization|cookie|bearer)/i;

/**
 * Mask secret-shaped argument fields before the row insert and the SSE frame.
 * Masking is by field name, recursively; the raw value never reaches SQLite,
 * the frame or the human face.
 */
export function maskToolArguments(value: unknown): Record<string, unknown> {
  const masked = maskValue(value);
  return typeof masked === 'object' && masked !== null && !Array.isArray(masked)
    ? (masked as Record<string, unknown>)
    : {};
}

function maskValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(maskValue);
  }
  if (typeof value === 'object' && value !== null) {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = SECRET_KEY_PATTERN.test(key) ? '***' : maskValue(entry);
    }
    return output;
  }
  return value;
}
