import { randomUUID } from 'node:crypto';
import type { SopRunPhase, SopRunStepSnapshot, SopStepDefinition } from '@allibot/shared';
import type Database from 'better-sqlite3';
import type { RoundProvider, RoundResult } from './agent-seam.js';
import { nowIso } from './clock.js';
import { tFromDb } from './copy.js';
import { publishSopUpdate } from './events.js';
import { closeRoundMcp } from './mcp-runtime.js';
import { readSopRoundInput, type SopRoundStep } from './rounds.js';
import { ApprovalTimeoutError } from './tool-gate.js';

/**
 * SOP 执行器与校验者 (#45 / D4.3): the process-local driver of one run. It
 * walks the immutable step list in order, one step at a time, and runs the
 * executor member round followed by the verifier member round. Both rounds go
 * through the ordinary member-face seam; they are not target rounds, so this
 * module writes only `sop_run.state` and (through the tool gate) approval rows —
 * never a message, target, task, round outcome, unread, wake, memory card or
 * budget fact.
 *
 * The phase machine is `pending -> running -> awaiting(verifier) -> running ->
 * completed`; `awaiting(approval)` is entered through the gate's wait hook and
 * returns to `running` when the batch settles. A `fail` verdict retries the
 * same step within `max_attempts`; exhausting it closes the run `failed` with
 * the last verifier's readable text.
 */

/** How much of each executor / verifier output the state snapshot keeps. */
export const SOP_EXCERPT_LIMIT = 2000;

/** A run-level failure with a readable reason, distinct from an adapter throw. */
class SopRunFailure extends Error {
  constructor(readonly readable: string) {
    super(readable);
    this.name = 'SopRunFailure';
  }
}

interface RunRow {
  id: string;
  definition_id: string;
  channel_id: string;
  phase: SopRunPhase;
  state: string;
  steps: string;
}

interface SopState extends Record<string, unknown> {
  current_step: number;
  attempt: number;
  steps: SopRunStepSnapshot[];
  waiting_on: 'verifier' | 'approval' | null;
  error: string | null;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
}

/** One run that has a process-local worker; scheduling the same run twice is a no-op. */
const scheduled = new Set<string>();

/**
 * Start one run after the HTTP start response has been produced. The pending row
 * already exists; the worker's first act is the `pending -> running`
 * transition. A failure inside the worker closes the run `failed` itself; the
 * extra catch here only reports a storage-level problem.
 */
export function scheduleSopRun(
  db: Database.Database,
  provider: RoundProvider,
  runId: string,
): void {
  if (scheduled.has(runId)) {
    return;
  }
  scheduled.add(runId);
  setImmediate(() => {
    void executeSopRun(db, provider, runId)
      .catch((error: unknown) => {
        console.error(`allibot: SOP run ${runId} failed outside its write path:`, error);
      })
      .finally(() => {
        scheduled.delete(runId);
      });
  });
}

/**
 * The startup closure (D4.2 / D5.6): a `running` / `awaiting` run belongs to a
 * process that never concluded it. Nothing is replayed across a restart, so it
 * closes `failed` with the readable `interrupted` reason. `pending` is an
 * active phase too: its scheduled worker is gone with the old process, so it
 * would otherwise block every later start forever.
 */
export function closeInterruptedSopRuns(db: Database.Database): number {
  const rows = db
    .prepare("SELECT id, state FROM sop_run WHERE phase IN ('pending', 'running', 'awaiting')")
    .all() as { id: string; state: string }[];
  if (rows.length === 0) {
    return 0;
  }
  const now = nowIso();
  const reason = tFromDb(db, 'sop.run.interrupted');
  const update = db.transaction((): void => {
    for (const row of rows) {
      const state = parseState(row.state, row.id, now);
      state.error = reason;
      state.waiting_on = null;
      state.finished_at = now;
      state.updated_at = now;
      db.prepare(
        `UPDATE sop_run
            SET phase = 'failed', state = ?, updated_at = ?, finished_at = ?
          WHERE id = ?`,
      ).run(JSON.stringify(state), now, now, row.id);
    }
  });
  update();
  return rows.length;
}

async function executeSopRun(
  db: Database.Database,
  provider: RoundProvider,
  runId: string,
): Promise<void> {
  const row = readRunRow(db, runId);
  if (row === undefined || row.phase !== 'pending') {
    return;
  }
  const steps = parseDefinitionSteps(row.steps, runId);
  if (steps.length === 0) {
    markFailed(db, row, tFromDb(db, 'sop.run.round.failed', { reason: 'empty definition' }));
    return;
  }

  const startedAt = nowIso();
  const state = parseState(row.state, runId, startedAt);
  state.current_step = 0;
  state.attempt = 0;
  state.waiting_on = null;
  state.error = null;

  const transition = (phase: SopRunPhase): void => {
    writeTransition(db, row, phase, state);
  };

  // The approval wait is process-local and stays inside the provider call. The
  // hooks move the run to `awaiting` / back to `running` while the adapter is
  // still running, so the human read model and `sop_update` tell the truth.
  const onApprovalWait = (): void => {
    if (state.waiting_on === 'approval') {
      return;
    }
    state.waiting_on = 'approval';
    transition('awaiting');
  };
  const onApprovalSettled = (): void => {
    if (state.waiting_on !== 'approval') {
      return;
    }
    state.waiting_on = null;
    transition('running');
  };

  try {
    for (let index = 0; index < steps.length; index += 1) {
      const step = steps[index]!;
      let record = state.steps.find((entry) => entry.index === index);
      if (record === undefined) {
        record = newStepRecord(index, step, startedAt);
        state.steps.push(record);
      }
      for (let attempt = 1; attempt <= step.max_attempts; attempt += 1) {
        state.current_step = index;
        state.attempt = attempt;
        state.waiting_on = null;
        state.error = null;
        record.attempts = attempt;
        record.finished_at = null;
        transition('running');

        const executor = await runInternalRound(db, provider, {
          memberId: step.executor_member_id,
          run: row,
          step,
          index,
          attempt,
          role: 'executor',
          executorText: null,
          onApprovalWait,
          onApprovalSettled,
        });
        record.executor_excerpt = excerpt(repliesText(executor));
        if (executor.verdict === 'failed') {
          throw new SopRunFailure(roundFailureReason(db, executor));
        }

        state.waiting_on = 'verifier';
        transition('awaiting');
        const verifier = await runInternalRound(db, provider, {
          memberId: step.verifier_member_id,
          run: row,
          step,
          index,
          attempt,
          role: 'verifier',
          executorText: repliesText(executor),
          onApprovalWait,
          onApprovalSettled,
        });
        record.verifier_excerpt = excerpt(repliesText(verifier));
        const verdict = verifier.sopVerdict;
        record.verifier_verdict = verdict === 'pass' ? 'pass' : 'fail';

        if (verdict === 'pass') {
          record.finished_at = nowIso();
          state.waiting_on = null;
          state.attempt = attempt;
          if (index === steps.length - 1) {
            state.current_step = steps.length;
            transition('completed');
            return;
          }
          break;
        }

        const reason = verifierFailureReason(db, verifier, verdict);
        if (attempt < step.max_attempts) {
          continue;
        }
        throw new SopRunFailure(reason);
      }
    }
  } catch (error) {
    const reason =
      error instanceof SopRunFailure
        ? error.readable
        : error instanceof ApprovalTimeoutError
          ? error.readable
          : tFromDb(db, 'sop.run.round.failed', { reason: errorMessage(error) });
    state.error = reason;
    state.waiting_on = null;
    transition('failed');
  }
}

interface InternalRoundParams {
  memberId: string;
  run: RunRow;
  step: SopStepDefinition;
  index: number;
  attempt: number;
  role: 'executor' | 'verifier';
  executorText: string | null;
  onApprovalWait: () => void;
  onApprovalSettled: () => void;
}

/**
 * One internal member round. The stable reply id is allocated here; a tool ask
 * inside the round names it and the run (`context_kind='sop'`, target null).
 */
async function runInternalRound(
  db: Database.Database,
  provider: RoundProvider,
  params: InternalRoundParams,
): Promise<RoundResult> {
  const input = await readSopRoundInput(db, {
    memberId: params.memberId,
    runId: params.run.id,
    definitionId: params.run.definition_id,
    channelId: params.run.channel_id,
    replyId: randomUUID(),
    step: params.step as SopRoundStep,
    stepIndex: params.index,
    attempt: params.attempt,
    role: params.role,
    executorText: params.executorText,
    onApprovalWait: params.onApprovalWait,
    onApprovalSettled: params.onApprovalSettled,
  });
  try {
    return await provider.runRound(input);
  } finally {
    await closeRoundMcp(input.mcp);
  }
}

function newStepRecord(
  index: number,
  step: SopStepDefinition,
  now: string,
): SopRunStepSnapshot {
  return {
    index,
    title: step.title,
    executor_member_id: step.executor_member_id,
    verifier_member_id: step.verifier_member_id,
    attempts: 0,
    executor_excerpt: null,
    verifier_excerpt: null,
    verifier_verdict: null,
    started_at: now,
    finished_at: null,
  };
}

/**
 * The readable reason of a failed verifier round. A `fail` verdict uses the
 * verifier's own text (the last readable explanation); a missing structured
 * verdict is a protocol failure, never inferred from prose.
 */
function verifierFailureReason(
  db: Database.Database,
  result: RoundResult,
  verdict: 'pass' | 'fail' | undefined,
): string {
  const text = repliesText(result);
  if (verdict === 'fail') {
    return text.length > 0
      ? text
      : (result.detail ?? tFromDb(db, 'sop.run.verifier.noReason'));
  }
  const noVerdict = tFromDb(db, 'sop.run.verifier.noVerdict');
  if (text.length > 0) {
    return `${noVerdict} ${text}`;
  }
  return result.detail === undefined ? noVerdict : `${noVerdict} ${result.detail}`;
}

/** The readable reason of an executor round the adapter itself failed. */
function roundFailureReason(db: Database.Database, result: RoundResult): string {
  const text = repliesText(result);
  if (text.length > 0) {
    return text;
  }
  return result.detail ??
    tFromDb(db, 'sop.run.round.failed', { reason: String(result.verdict) });
}

function repliesText(result: RoundResult): string {
  return result.replies.join('\n\n').trim();
}

function excerpt(text: string): string | null {
  if (text.length === 0) {
    return null;
  }
  return Array.from(text).slice(0, SOP_EXCERPT_LIMIT).join('');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readRunRow(db: Database.Database, runId: string): RunRow | undefined {
  return db
    .prepare(
      `SELECT r.id, r.definition_id, r.channel_id, r.phase, r.state, d.steps
         FROM sop_run r JOIN sop_definition d ON d.id = r.definition_id
        WHERE r.id = ?`,
    )
    .get(runId) as RunRow | undefined;
}

function parseDefinitionSteps(raw: string, runId: string): SopStepDefinition[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SopRunFailure(`SOP definition of run ${runId} carries invalid steps`);
  }
  if (!Array.isArray(parsed)) {
    throw new SopRunFailure(`SOP definition of run ${runId} carries invalid steps`);
  }
  return parsed as SopStepDefinition[];
}

function parseState(raw: string, runId: string, now: string): SopState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`sop_run ${runId} carries invalid state JSON`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`sop_run ${runId} carries a non-object state snapshot`);
  }
  const record = parsed as Record<string, unknown>;
  const steps = Array.isArray(record['steps'])
    ? (record['steps'] as SopRunStepSnapshot[])
    : [];
  const waiting = record['waiting_on'];
  return {
    ...record,
    current_step: typeof record['current_step'] === 'number' ? record['current_step'] : 0,
    attempt: typeof record['attempt'] === 'number' ? record['attempt'] : 0,
    steps,
    waiting_on: waiting === 'verifier' || waiting === 'approval' ? waiting : null,
    error: typeof record['error'] === 'string' ? record['error'] : null,
    started_at: typeof record['started_at'] === 'string' ? record['started_at'] : now,
    updated_at: typeof record['updated_at'] === 'string' ? record['updated_at'] : now,
    finished_at: typeof record['finished_at'] === 'string' ? record['finished_at'] : null,
  };
}

/**
 * Persist one progress point and announce it. The stamp is the process clock;
 * the phase / finished_at binding is the table's own CHECK.
 */
function writeTransition(
  db: Database.Database,
  run: RunRow,
  phase: SopRunPhase,
  state: SopState,
): void {
  const now = nowIso();
  state.updated_at = now;
  state.finished_at = phase === 'completed' || phase === 'failed' ? now : null;
  if (phase === 'completed' || phase === 'failed') {
    state.waiting_on = null;
  }
  const snapshot = JSON.stringify(state);
  db.prepare(
    `UPDATE sop_run
        SET phase = ?, state = ?, current_step = ?, updated_at = ?, finished_at = ?
      WHERE id = ?`,
  ).run(phase, snapshot, state.current_step, now, state.finished_at, run.id);
  publishSopUpdate({
    sopRunId: run.id,
    definitionId: run.definition_id,
    phase,
    currentStep: state.current_step,
    attempt: state.attempt,
    occurredAt: now,
  });
}

/** Close an unrunnable row without a worker; used only for an invalid definition. */
function markFailed(db: Database.Database, run: RunRow, reason: string): void {
  const now = nowIso();
  const state = parseState(run.state, run.id, now);
  state.error = reason;
  state.waiting_on = null;
  writeTransition(db, run, 'failed', state);
}
