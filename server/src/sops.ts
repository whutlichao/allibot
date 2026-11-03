import { randomUUID } from 'node:crypto';
import {
  SOP_MAX_ATTEMPTS,
  SOP_MAX_STEPS,
  SOP_MIN_STEPS,
  type SopDefinitionView,
  type SopRunPhase,
  type SopRunStateSnapshot,
  type SopRunView,
  type SopRunWaitingOn,
  type SopStepDefinition,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { readChannelLiveness } from './channels.js';
import { nowIso } from './clock.js';
import { publishSopUpdate } from './events.js';

/**
 * SOP 定义与启动 (#41 / D4.2): an owner-started multi-step process. It is not a
 * workflow engine, a task template or a team pipeline: a definition is one
 * immutable ordered step list on one channel, and a run is the five-phase
 * progress record of one explicit start.
 *
 * The module is the one place that validates, creates, reads and starts the two
 * tables. A definition write checks the channel lifecycle and the step members;
 * a start re-checks the stored definition (members can leave after creation),
 * refuses a second active run (`pending` / `running` / `awaiting`) and writes
 * one `pending` run. It writes no message, task, target, budget, wake or team
 * run — execution belongs to #45.
 */

const DEFINITION_SELECT = `
SELECT d.id, d.channel_id, d.name, d.steps, d.created_at
FROM sop_definition d
JOIN channel c ON c.id = d.channel_id`;

const DEFINITION_KEYS = new Set(['channel_id', 'name', 'steps']);
const STEP_KEYS = new Set([
  'title',
  'description',
  'executor_member_id',
  'verifier_member_id',
  'max_attempts',
]);

/** The one active-run predicate (D4.2): any of these three phases blocks a start. */
const ACTIVE_RUN_PHASES = "('pending', 'running', 'awaiting')";

/** The initial `state` snapshot a pending run stores; the executor extends it. */
function initialRunState(now: string): SopRunStateSnapshot {
  return {
    current_step: 0,
    attempt: 0,
    steps: [],
    waiting_on: null,
    error: null,
    started_at: now,
    updated_at: now,
    finished_at: null,
  };
}

export const SOP_DEFAULT_RUN_LIMIT = 20;
export const SOP_MAX_RUN_LIMIT = 50;

/** Retention (D4.2): the latest 50 runs or 90 days, whichever is shorter. */
export const SOP_RUN_RETENTION = 50;
export const SOP_RUN_RETENTION_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Retention runs when a new run is created, not on startup (D4.2). A run is
 * kept only when it is both among the definition's newest 50 and younger than
 * 90 days; the definition itself is never deleted. This is a read-model cleanup
 * of forensics rows, not a message delete.
 */
function pruneSopRuns(db: Database.Database, definitionId: string, now: string): void {
  const cutoff = new Date(Date.parse(now) - SOP_RUN_RETENTION_DAYS * DAY_MS).toISOString();
  db.prepare(
    `DELETE FROM sop_run
      WHERE definition_id = ?
        AND (
          started_at < ?
          OR id NOT IN (
            SELECT id FROM sop_run
             WHERE definition_id = ?
             ORDER BY started_at DESC, rowid DESC
             LIMIT ?
          )
        )`,
  ).run(definitionId, cutoff, definitionId, SOP_RUN_RETENTION);
}

interface DefinitionRow {
  id: string;
  channel_id: string;
  name: string;
  steps: string;
  created_at: string;
}

interface RunRow {
  id: string;
  definition_id: string;
  channel_id: string;
  phase: string;
  state: string;
  current_step: number;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** A create returns whether it landed a new row: the same-shape replay is a 200. */
export interface CreatedSopDefinition {
  created: boolean;
  definition: SopDefinitionView;
}

/**
 * `POST /api/sops` (D2.3 / D2.4): one immutable definition per
 * `(channel_id, name)`. A same-shape replay returns the stored definition with
 * `created=false`; a different shape is a 409. An archived channel is a 400, a
 * deleted channel a 404, and an invalid step / member / channel a 400 — none of
 * them writes a row.
 */
export function createSopDefinition(
  db: Database.Database,
  body: unknown,
): CreatedSopDefinition {
  const input = parseCreateInput(body);
  const create = db.transaction((): CreatedSopDefinition => {
    requireWritableChannel(db, input.channelId);

    // The identity check comes before member validation: a replay of the same
    // shape is a 200 even after one of its members left the channel, and a
    // same-name different shape is the documented 409 (D2.4).
    const existing = readDefinitionRowByName(db, input.channelId, input.name);
    if (existing !== undefined) {
      if (!stepsEqual(existing.steps, input.steps)) {
        throw ApiFailure.conflict(
          `a SOP definition named "${input.name}" already exists on this channel with different steps`,
          { definition_id: existing.id },
        );
      }
      return { created: false, definition: definitionView(existing) };
    }

    assertStepMembers(db, input.channelId, input.steps);
    const id = randomUUID();
    db.prepare(
      `INSERT INTO sop_definition (id, channel_id, name, steps, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(id, input.channelId, input.name, JSON.stringify(input.steps), nowIso());
    const row = readDefinitionRow(db, id);
    if (row === undefined) {
      throw new Error('created SOP definition could not be read back');
    }
    return { created: true, definition: definitionView(row) };
  });
  return create();
}

/**
 * `GET /api/sops?channel_id=` (D2.3): definitions in creation order, optionally
 * narrowed to one channel. An archived channel keeps its definitions readable;
 * a deleted (or unknown) channel names no scope and is a 404.
 */
export function listSopDefinitions(
  db: Database.Database,
  channelId?: string,
): SopDefinitionView[] {
  if (channelId !== undefined) {
    const liveness = readChannelLiveness(db, channelId);
    if (liveness === undefined || liveness.deleted_at !== null) {
      throw ApiFailure.notFound(`channel not found: ${channelId}`);
    }
    const rows = db
      .prepare(`${DEFINITION_SELECT} WHERE d.channel_id = ? ORDER BY d.created_at, d.rowid`)
      .all(channelId) as DefinitionRow[];
    return rows.map(definitionView);
  }
  const rows = db
    .prepare(`${DEFINITION_SELECT} WHERE c.deleted_at IS NULL ORDER BY d.created_at, d.rowid`)
    .all() as DefinitionRow[];
  return rows.map(definitionView);
}

/** `GET /api/sops/{id}`: a definition on a deleted channel reads as 404. */
export function getSopDefinition(db: Database.Database, id: string): SopDefinitionView {
  return definitionView(requireDefinition(db, id));
}

/**
 * `POST /api/sops/{id}/runs` (D4.2): the only start entry. It returns the
 * `pending` run, re-checks the stored definition (a member may have left
 * since creation) and refuses a second active run with a 409. A deleted
 * channel or unknown definition is a 404; an archived channel or an invalid
 * definition is a 400.
 */
export function startSopRun(db: Database.Database, definitionId: string): SopRunView {
  const runId = db.transaction((): string => {
    const definition = requireDefinition(db, definitionId);
    const liveness = readChannelLiveness(db, definition.channel_id);
    if (liveness === undefined) {
      throw ApiFailure.notFound(`channel not found: ${definition.channel_id}`);
    }
    if (liveness.deleted_at !== null) {
      throw ApiFailure.notFound(`channel not found: ${definition.channel_id}`);
    }
    if (liveness.archived_at !== null) {
      throw ApiFailure.validation(`channel is archived: ${definition.channel_id}`);
    }

    // A definition is immutable, but its members can leave / be deleted: a
    // start re-validates the stored snapshot before any run row is written.
    const steps = parseStoredSteps(definition.steps);
    assertStepMembers(db, definition.channel_id, steps);

    const active = db
      .prepare(
        `SELECT id FROM sop_run
          WHERE definition_id = ? AND phase IN ${ACTIVE_RUN_PHASES}
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(definitionId) as { id: string } | undefined;
    if (active !== undefined) {
      throw ApiFailure.conflict('this SOP definition already has an active run', {
        sop_run_id: active.id,
      });
    }

    const id = randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO sop_run
         (id, definition_id, channel_id, phase, state, current_step, started_at, updated_at,
          finished_at)
       VALUES (?, ?, ?, 'pending', ?, 0, ?, ?, NULL)`,
    ).run(id, definitionId, definition.channel_id, JSON.stringify(initialRunState(now)), now, now);
    // The start is the privacy / retention point for the definition's old runs.
    pruneSopRuns(db, definitionId, now);
    return id;
  });
  const view = getSopRun(db, runId());
  publishSopUpdate({
    sopRunId: view.id,
    definitionId: view.definition_id,
    phase: view.phase,
    currentStep: view.current_step,
    attempt: view.attempt,
    occurredAt: view.updated_at,
  });
  return view;
}

export interface SopRunQuery {
  limit: number;
  /** The opaque cursor: the id of the last run on the previous page. */
  before?: string;
}

/** `limit` 1–50 with a default of 20, matching the other run snapshots. */
export function parseSopRunQuery(searchParams: URLSearchParams): SopRunQuery {
  const rawLimit = searchParams.get('limit');
  let limit = SOP_DEFAULT_RUN_LIMIT;
  if (rawLimit !== null) {
    if (
      !/^\d+$/.test(rawLimit) ||
      Number(rawLimit) < 1 ||
      Number(rawLimit) > SOP_MAX_RUN_LIMIT
    ) {
      throw ApiFailure.validation('limit must be an integer between 1 and 50', {
        field: 'limit',
        value: rawLimit,
      });
    }
    limit = Number(rawLimit);
  }

  const rawBefore = searchParams.get('before');
  if (rawBefore === null) {
    return { limit };
  }
  if (rawBefore.trim().length === 0) {
    throw ApiFailure.validation('before must be a non-empty SOP run id', {
      field: 'before',
      value: rawBefore,
    });
  }
  return { limit, before: rawBefore.trim() };
}

/**
 * `GET /api/sops/{id}/runs?limit=&before=` (D2.3): newest runs first, each with
 * its stored `state` snapshot. An unknown definition is a 404; an unknown
 * cursor is a 400. Runs of a definition on a deleted channel are not readable.
 */
export function listSopRuns(
  db: Database.Database,
  definitionId: string,
  query: SopRunQuery,
): SopRunView[] {
  requireDefinition(db, definitionId);

  const params: unknown[] = [definitionId];
  let cursorClause = '';
  if (query.before !== undefined) {
    const cursor = db
      .prepare('SELECT rowid AS rid, started_at FROM sop_run WHERE id = ? AND definition_id = ?')
      .get(query.before, definitionId) as { rid: number; started_at: string } | undefined;
    if (cursor === undefined) {
      throw ApiFailure.validation('before must name a run of this SOP definition', {
        field: 'before',
        value: query.before,
      });
    }
    cursorClause = 'AND (started_at < ? OR (started_at = ? AND rowid < ?))';
    params.push(cursor.started_at, cursor.started_at, cursor.rid);
  }
  params.push(query.limit);

  const rows = db
    .prepare(
      `SELECT id, definition_id, channel_id, phase, state, current_step, started_at,
              updated_at, finished_at
         FROM sop_run
        WHERE definition_id = ? ${cursorClause}
        ORDER BY started_at DESC, rowid DESC
        LIMIT ?`,
    )
    .all(...(params as never[])) as RunRow[];
  return rows.map(runView);
}

/** `GET /api/sop-runs/{id}`: one run's phase and state snapshot; unknown is 404. */
export function getSopRun(db: Database.Database, id: string): SopRunView {
  const row = db
    .prepare(
      `SELECT r.id, r.definition_id, r.channel_id, r.phase, r.state, r.current_step,
              r.started_at, r.updated_at, r.finished_at
         FROM sop_run r
         JOIN sop_definition d ON d.id = r.definition_id
         JOIN channel c ON c.id = d.channel_id
        WHERE r.id = ? AND c.deleted_at IS NULL`,
    )
    .get(id) as RunRow | undefined;
  if (row === undefined) {
    throw ApiFailure.notFound(`SOP run not found: ${id}`);
  }
  return runView(row);
}

interface ParsedDefinitionInput {
  channelId: string;
  name: string;
  steps: SopStepDefinition[];
}

function parseCreateInput(body: unknown): ParsedDefinitionInput {
  const record = asObject(body);
  for (const key of Object.keys(record)) {
    if (!DEFINITION_KEYS.has(key)) {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const channelId = requireId(record['channel_id'], 'channel_id');
  const name = requireName(record['name']);
  const steps = parseRequestSteps(record['steps']);
  return { channelId, name, steps };
}

function parseRequestSteps(value: unknown): SopStepDefinition[] {
  if (!Array.isArray(value)) {
    throw ApiFailure.validation('steps must be an array of steps', { field: 'steps' });
  }
  if (value.length < SOP_MIN_STEPS || value.length > SOP_MAX_STEPS) {
    throw ApiFailure.validation(
      `steps must contain between ${SOP_MIN_STEPS} and ${SOP_MAX_STEPS} steps`,
      { field: 'steps', value: value.length },
    );
  }
  return value.map((entry, index) => parseStep(entry, index));
}

function parseStoredSteps(raw: string): SopStepDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = null;
  }
  if (!Array.isArray(parsed)) {
    throw ApiFailure.validation('the SOP definition no longer carries a valid step list');
  }
  try {
    return parseRequestSteps(parsed);
  } catch (error) {
    throw ApiFailure.validation(
      `the SOP definition is no longer valid: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseStep(value: unknown, index: number): SopStepDefinition {
  const record = asObject(value, `steps[${index}]`);
  for (const key of Object.keys(record)) {
    if (!STEP_KEYS.has(key)) {
      throw ApiFailure.validation(`unknown step field: ${key}`, {
        field: `steps[${index}].${key}`,
      });
    }
  }
  const title = requireName(record['title'], `steps[${index}].title`);
  const description = optionalDescription(record['description'], index);
  const executorMemberId = requireId(
    record['executor_member_id'],
    `steps[${index}].executor_member_id`,
  );
  const verifierMemberId = requireId(
    record['verifier_member_id'],
    `steps[${index}].verifier_member_id`,
  );
  if (executorMemberId === verifierMemberId) {
    throw ApiFailure.validation('a step verifier must differ from its executor', {
      field: `steps[${index}].verifier_member_id`,
    });
  }
  const maxAttempts = record['max_attempts'];
  if (
    typeof maxAttempts !== 'number' ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1 ||
    maxAttempts > SOP_MAX_ATTEMPTS
  ) {
    throw ApiFailure.validation(
      `max_attempts must be an integer between 1 and ${SOP_MAX_ATTEMPTS}`,
      { field: `steps[${index}].max_attempts`, value: maxAttempts },
    );
  }
  return {
    title,
    description,
    executor_member_id: executorMemberId,
    verifier_member_id: verifierMemberId,
    max_attempts: maxAttempts,
  };
}

function optionalDescription(value: unknown, index: number): string {
  if (value === undefined) {
    return '';
  }
  if (typeof value !== 'string') {
    throw ApiFailure.validation(`steps[${index}].description must be a string`, {
      field: `steps[${index}].description`,
    });
  }
  return value;
}

/**
 * The one channel-lifecycle guard of the definition write: a never-existing
 * channel is an invalid reference (400), an archived channel takes no write
 * (400) and a deleted channel is absent (404).
 */
function requireWritableChannel(db: Database.Database, channelId: string): void {
  const liveness = readChannelLiveness(db, channelId);
  if (liveness === undefined) {
    throw ApiFailure.validation(`channel not found: ${channelId}`, { field: 'channel_id' });
  }
  if (liveness.deleted_at !== null) {
    throw ApiFailure.notFound(`channel not found: ${channelId}`);
  }
  if (liveness.archived_at !== null) {
    throw ApiFailure.validation(`channel is archived: ${channelId}`);
  }
}

/** Both step roles must be live Agent members of the definition's channel. */
function assertStepMembers(
  db: Database.Database,
  channelId: string,
  steps: readonly SopStepDefinition[],
): void {
  const readMember = db.prepare(
    `SELECT m.kind, m.deleted_at
       FROM member m
       JOIN target_member tm ON tm.member_id = m.id AND tm.target_id = ?
      WHERE m.id = ?`,
  );
  const ids = new Set(steps.flatMap((step) => [step.executor_member_id, step.verifier_member_id]));
  for (const memberId of ids) {
    const member = readMember.get(channelId, memberId) as
      | { kind: string; deleted_at: string | null }
      | undefined;
    if (member === undefined || member.kind !== 'agent' || member.deleted_at !== null) {
      throw ApiFailure.validation(
        `each step executor and verifier must be a live Agent member of the channel: ${memberId}`,
        { field: 'members', value: memberId },
      );
    }
  }
}

function readDefinitionRow(db: Database.Database, id: string): DefinitionRow | undefined {
  return db
    .prepare(`${DEFINITION_SELECT} WHERE d.id = ? AND c.deleted_at IS NULL`)
    .get(id) as DefinitionRow | undefined;
}

function readDefinitionRowByName(
  db: Database.Database,
  channelId: string,
  name: string,
): DefinitionRow | undefined {
  return db
    .prepare('SELECT id, channel_id, name, steps, created_at FROM sop_definition WHERE channel_id = ? AND name = ?')
    .get(channelId, name) as DefinitionRow | undefined;
}

function requireDefinition(db: Database.Database, id: string): DefinitionRow {
  const row = readDefinitionRow(db, id);
  if (row === undefined) {
    throw ApiFailure.notFound(`SOP definition not found: ${id}`);
  }
  return row;
}

function definitionView(row: DefinitionRow): SopDefinitionView {
  return {
    id: row.id,
    channel_id: row.channel_id,
    name: row.name,
    steps: parseStoredStepsForView(row.steps),
    created_at: row.created_at,
  };
}

/** A stored definition was validated at write time; a malformed row is an internal error. */
function parseStoredStepsForView(raw: string): SopStepDefinition[] {
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('sop_definition.steps is not a JSON array');
  }
  return parsed.map((entry) => {
    const record = entry as Record<string, unknown>;
    return {
      title: String(record['title']),
      description: String(record['description'] ?? ''),
      executor_member_id: String(record['executor_member_id']),
      verifier_member_id: String(record['verifier_member_id']),
      max_attempts: Number(record['max_attempts']),
    };
  });
}

function runView(row: RunRow): SopRunView {
  const state = JSON.parse(row.state) as unknown;
  if (typeof state !== 'object' || state === null || Array.isArray(state)) {
    throw new Error(`sop_run ${row.id} carries a non-object state snapshot`);
  }
  const snapshot = state as SopRunStateSnapshot;
  return {
    id: row.id,
    definition_id: row.definition_id,
    channel_id: row.channel_id,
    phase: parseRunPhase(row.phase),
    state: snapshot,
    current_step: row.current_step,
    attempt: typeof snapshot['attempt'] === 'number' ? snapshot['attempt'] : 0,
    waiting_on: readWaitingOn(snapshot['waiting_on']),
    started_at: row.started_at,
    updated_at: row.updated_at,
    finished_at: row.finished_at,
  };
}

function readWaitingOn(value: unknown): SopRunWaitingOn | null {
  return value === 'verifier' || value === 'approval' ? value : null;
}

function parseRunPhase(value: string): SopRunPhase {
  switch (value) {
    case 'pending':
    case 'running':
    case 'awaiting':
    case 'completed':
    case 'failed':
      return value;
    default:
      throw new Error(`sop_run row carries an unknown phase: ${value}`);
  }
}

function stepsEqual(storedJson: string, requested: readonly SopStepDefinition[]): boolean {
  let stored: unknown;
  try {
    stored = JSON.parse(storedJson);
  } catch {
    return false;
  }
  if (!Array.isArray(stored) || stored.length !== requested.length) {
    return false;
  }
  return stored.every((entry, index) => {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return false;
    }
    const step = entry as Record<string, unknown>;
    const want = requested[index]!;
    return (
      step['title'] === want.title &&
      step['description'] === want.description &&
      step['executor_member_id'] === want.executor_member_id &&
      step['verifier_member_id'] === want.verifier_member_id &&
      step['max_attempts'] === want.max_attempts
    );
  });
}

function asObject(body: unknown, field = 'request body'): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation(`${field} must be a JSON object`);
  }
  return body as Record<string, unknown>;
}

function requireName(value: unknown, field = 'name'): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation(`${field} must be a non-empty string`, { field });
  }
  return value.trim();
}

function requireId(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation(`${field} must be a non-empty id`, { field, value });
  }
  return value.trim();
}

