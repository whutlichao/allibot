import {
  t,
  type Locale,
  type SopDefinitionView,
  type SopRunPhase,
  type SopRunView,
  type SopRunWaitingOn,
  type SopUpdateFrame,
} from '@allibot/shared';

/**
 * SOP 的呈现层读取 (#41 / D4.2): definitions come from `GET /api/sops`, the run
 * snapshot from `GET /api/sops/{id}/runs` or `GET /api/sop-runs/{id}`, and the
 * two writes are the owner-only `POST /api/sops` and
 * `POST /api/sops/{id}/runs`. A SOP is a channel-scoped flow, never a message,
 * a task row or a second target; this module only reads and formats it.
 */

/** How many newest runs the panel shows per definition. */
export const SOP_RUNS_PAGE_LIMIT = 5;

/** The active-run predicate (D4.2): any of these three phases blocks a start. */
const ACTIVE_PHASES: readonly SopRunPhase[] = ['pending', 'running', 'awaiting'];

async function failure(response: Response, what: string): Promise<Error> {
  let detail = '';
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    detail = body.error?.message ?? '';
  } catch {
    detail = '';
  }
  return new Error(`${what} failed with ${response.status}${detail === '' ? '' : `: ${detail}`}`);
}

export async function readSopDefinitions(
  fetchImpl: typeof fetch,
  channelId: string,
): Promise<SopDefinitionView[]> {
  const response = await fetchImpl(
    `/api/sops?channel_id=${encodeURIComponent(channelId)}`,
  );
  if (!response.ok) {
    throw await failure(response, `GET channel ${channelId} SOP definitions`);
  }
  const body = (await response.json()) as { sops?: SopDefinitionView[] };
  return body.sops ?? [];
}

export async function readSopRuns(
  fetchImpl: typeof fetch,
  definitionId: string,
  options: { limit?: number; before?: string } = {},
): Promise<SopRunView[]> {
  const params = new URLSearchParams({
    limit: String(options.limit ?? SOP_RUNS_PAGE_LIMIT),
  });
  if (options.before !== undefined) {
    params.set('before', options.before);
  }
  const response = await fetchImpl(
    `/api/sops/${encodeURIComponent(definitionId)}/runs?${params.toString()}`,
  );
  if (!response.ok) {
    throw await failure(response, `GET SOP ${definitionId} runs`);
  }
  const body = (await response.json()) as { runs?: SopRunView[] };
  return body.runs ?? [];
}

export async function readSopRun(
  fetchImpl: typeof fetch,
  runId: string,
): Promise<SopRunView> {
  const response = await fetchImpl(`/api/sop-runs/${encodeURIComponent(runId)}`);
  if (!response.ok) {
    throw await failure(response, `GET SOP run ${runId}`);
  }
  return (await response.json()) as SopRunView;
}

export function sopPhaseLabel(locale: Locale, phase: SopRunPhase): string {
  switch (phase) {
    case 'pending':
      return t(locale, 'workspace.sop.phase.pending');
    case 'running':
      return t(locale, 'workspace.sop.phase.running');
    case 'awaiting':
      return t(locale, 'workspace.sop.phase.awaiting');
    case 'completed':
      return t(locale, 'workspace.sop.phase.completed');
    case 'failed':
      return t(locale, 'workspace.sop.phase.failed');
  }
}

/** Whether a definition currently has an active run, as the backend defines it. */
export function hasActiveSopRun(runs: readonly SopRunView[]): boolean {
  return runs.some((run) => ACTIVE_PHASES.includes(run.phase));
}

/** The newest active run, or `null`; the list is newest first. */
export function activeSopRun(runs: readonly SopRunView[]): SopRunView | null {
  return runs.find((run) => ACTIVE_PHASES.includes(run.phase)) ?? null;
}

/** One step excerpt as the run panel reads it from the opaque state snapshot. */
export interface SopRunStepView {
  index: number;
  title: string;
  attempts: number;
  executor_excerpt: string | null;
  verifier_excerpt: string | null;
  verifier_verdict: 'pass' | 'fail' | null;
}

/** The subset of `SOPRunState` the run panel renders. */
export interface SopRunStateView {
  current_step: number;
  attempt: number;
  steps: SopRunStepView[];
  waiting_on: SopRunWaitingOn | null;
  error: string | null;
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
}

/**
 * Read the run's state snapshot defensively. The backend is the source of
 * truth; a missing / malformed field renders as its neutral default rather
 * than throwing the panel away.
 */
export function readSopRunState(snapshot: Record<string, unknown>): SopRunStateView {
  const waiting = snapshot['waiting_on'];
  const rawSteps = snapshot['steps'];
  const steps: SopRunStepView[] = Array.isArray(rawSteps)
    ? rawSteps.flatMap((entry, position) => {
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
          return [];
        }
        const step = entry as Record<string, unknown>;
        return [
          {
            index: typeof step['index'] === 'number' ? step['index'] : position,
            title: typeof step['title'] === 'string' ? step['title'] : '',
            attempts: typeof step['attempts'] === 'number' ? step['attempts'] : 0,
            executor_excerpt:
              typeof step['executor_excerpt'] === 'string' ? step['executor_excerpt'] : null,
            verifier_excerpt:
              typeof step['verifier_excerpt'] === 'string' ? step['verifier_excerpt'] : null,
            verifier_verdict:
              step['verifier_verdict'] === 'pass' || step['verifier_verdict'] === 'fail'
                ? step['verifier_verdict']
                : null,
          },
        ];
      })
    : [];
  return {
    current_step:
      typeof snapshot['current_step'] === 'number' ? snapshot['current_step'] : 0,
    attempt: typeof snapshot['attempt'] === 'number' ? snapshot['attempt'] : 0,
    steps,
    waiting_on: waiting === 'verifier' || waiting === 'approval' ? waiting : null,
    error: typeof snapshot['error'] === 'string' ? snapshot['error'] : null,
    started_at: typeof snapshot['started_at'] === 'string' ? snapshot['started_at'] : null,
    updated_at: typeof snapshot['updated_at'] === 'string' ? snapshot['updated_at'] : null,
    finished_at: typeof snapshot['finished_at'] === 'string' ? snapshot['finished_at'] : null,
  };
}

/** The readable `waiting_on` copy; `null` renders the neutral dash. */
export function sopWaitingOnLabel(locale: Locale, waiting: SopRunWaitingOn | null): string {
  switch (waiting) {
    case 'verifier':
      return t(locale, 'workspace.sop.waiting.verifier');
    case 'approval':
      return t(locale, 'workspace.sop.waiting.approval');
    case null:
      return '—';
  }
}

/** Narrow one `sop_update` frame; a malformed frame is ignored, never guessed. */
export function readSopUpdateFrame(data: Record<string, unknown>): SopUpdateFrame | null {
  const runId = data['sop_run_id'];
  const definitionId = data['definition_id'];
  const phase = data['phase'];
  const currentStep = data['current_step'];
  const attempt = data['attempt'];
  const occurredAt = data['occurred_at'];
  if (
    typeof runId !== 'string' ||
    typeof definitionId !== 'string' ||
    (phase !== 'pending' &&
      phase !== 'running' &&
      phase !== 'awaiting' &&
      phase !== 'completed' &&
      phase !== 'failed') ||
    typeof currentStep !== 'number' ||
    typeof attempt !== 'number' ||
    typeof occurredAt !== 'string'
  ) {
    return null;
  }
  return {
    sop_run_id: runId,
    definition_id: definitionId,
    phase,
    current_step: currentStep,
    attempt,
    occurred_at: occurredAt,
  };
}

/**
 * Apply one live frame to the run snapshots the shell already holds. The frame
 * is provisional (it carries no excerpts / `waiting_on`); the host follows it
 * with a `GET /api/sop-runs/{id}` catch-up read, never a poll loop.
 */
export function applySopUpdateFrame(
  runsByDefinition: Readonly<Record<string, readonly SopRunView[]>>,
  frame: SopUpdateFrame,
): Record<string, readonly SopRunView[]> {
  const runs = runsByDefinition[frame.definition_id];
  if (runs === undefined) {
    return { ...runsByDefinition };
  }
  const index = runs.findIndex((run) => run.id === frame.sop_run_id);
  if (index === -1) {
    return { ...runsByDefinition };
  }
  const current = runs[index]!;
  const next: SopRunView = {
    ...current,
    phase: frame.phase,
    current_step: frame.current_step,
    attempt: frame.attempt,
    waiting_on: frame.phase === 'awaiting' ? current.waiting_on : null,
    updated_at: frame.occurred_at,
  };
  return {
    ...runsByDefinition,
    [frame.definition_id]: runs.map((run, runIndex) => (runIndex === index ? next : run)),
  };
}

/** Merge one re-read run into the snapshots, keeping the newest-first order. */
export function mergeSopRun(
  runsByDefinition: Readonly<Record<string, readonly SopRunView[]>>,
  run: SopRunView,
): Record<string, readonly SopRunView[]> {
  const runs = runsByDefinition[run.definition_id] ?? [];
  const next = [run, ...runs.filter((entry) => entry.id !== run.id)].sort((left, right) =>
    right.started_at.localeCompare(left.started_at),
  );
  return { ...runsByDefinition, [run.definition_id]: next };
}
