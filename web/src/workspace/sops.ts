import {
  t,
  type Locale,
  type SopDefinitionView,
  type SopRunPhase,
  type SopRunView,
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
