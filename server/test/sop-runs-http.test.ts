import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * SOP start and run snapshot (#41 / D2.3 / D4.2): `POST /api/sops/{id}/runs` is
 * the only start entry, returns 202 and one `pending` run, and allows at most
 * one active run (`pending` / `running` / `awaiting`) per definition. The run
 * reads serve the phase and the stored state snapshot.
 *
 * Execution, verifier rounds, `awaiting` approvals and retries are #45: this
 * suite only creates the pending row and reads it back. The "phase boundary"
 * cases advance the row directly with SQL because a completed / failed run has
 * no HTTP writer yet.
 */

const FIXED_NOW = '2026-11-04T12:00:00.000Z';
const AGENT_MODEL = 'openai:gpt-5';

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  channelId: string;
  secondChannelId: string;
  agentA: string;
  agentB: string;
  stop: () => Promise<void>;
}

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<HttpResult> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  const parsed = text.length === 0 ? {} : (JSON.parse(text) as unknown);
  return {
    status: response.status,
    body:
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : { value: parsed },
  };
}

function errorCode(body: Record<string, unknown>): unknown {
  const error = body['error'];
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)['code']
    : undefined;
}

function openDatabase(dataDir: string): Database.Database {
  const db = new Database(path.join(dataDir, 'allibot.db'));
  db.pragma('foreign_keys = ON');
  return db;
}

function count(db: Database.Database, table: string): number {
  return (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
}

function runRow(
  dataDir: string,
  id: string,
): {
  phase: string;
  current_step: number;
  finished_at: string | null;
  definition_id: string;
  channel_id: string;
  started_at: string;
  state: string;
} | undefined {
  const db = openDatabase(dataDir);
  try {
    return db
      .prepare(
        `SELECT phase, current_step, finished_at, definition_id, channel_id, started_at, state
           FROM sop_run WHERE id = ?`,
      )
      .get(id) as
      | {
          phase: string;
          current_step: number;
          finished_at: string | null;
          definition_id: string;
          channel_id: string;
          started_at: string;
          state: string;
        }
      | undefined;
  } finally {
    db.close();
  }
}

/** Advance a run's phase directly: execution is #45, the boundary is this ticket's. */
function setPhase(
  dataDir: string,
  id: string,
  phase: string,
  options: { currentStep?: number } = {},
): void {
  const db = openDatabase(dataDir);
  try {
    db.prepare(
      `UPDATE sop_run
          SET phase = ?, current_step = ?, state = ?, updated_at = ?,
              finished_at = CASE WHEN ? IN ('completed', 'failed') THEN ? ELSE NULL END
        WHERE id = ?`,
    ).run(
      phase,
      options.currentStep ?? 0,
      JSON.stringify({ current_step: options.currentStep ?? 0, attempt: 0, steps: [] }),
      FIXED_NOW,
      phase,
      FIXED_NOW,
      id,
    );
  } finally {
    db.close();
  }
}

function step(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '步骤',
    description: '',
    executor_member_id: '',
    verifier_member_id: '',
    max_attempts: 2,
    ...overrides,
  };
}

async function startFixture(): Promise<Fixture> {
  const dataDir = await makeTempDir('allibot-sop-runs-');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-sop-runs-test' },
    args: ['--scripted-provider', 'reply', '--fixed-clock', FIXED_NOW],
  });
  const base = `http://127.0.0.1:${running.port}`;
  const channelId = (await request(base, 'POST', '/api/channels', { name: 'SOP 频道' })).body[
    'id'
  ] as string;
  const secondChannelId = (await request(base, 'POST', '/api/channels', { name: '第二个频道' }))
    .body['id'] as string;
  const agentA = (await request(base, 'POST', '/api/agents', {
    display_name: '执行者甲',
    model: AGENT_MODEL,
  })).body['id'] as string;
  const agentB = (await request(base, 'POST', '/api/agents', {
    display_name: '校验者乙',
    model: AGENT_MODEL,
  })).body['id'] as string;
  for (const channel of [channelId, secondChannelId]) {
    await request(base, 'POST', `/api/channels/${channel}/members`, { member_id: agentA });
    await request(base, 'POST', `/api/channels/${channel}/members`, { member_id: agentB });
  }

  return {
    dataDir,
    running,
    base,
    channelId,
    secondChannelId,
    agentA,
    agentB,
    stop: async (): Promise<void> => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

async function waitForRun(
  fixture: Fixture,
  id: string,
  predicate: (run: Record<string, unknown>) => boolean,
  label: string,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 8_000;
  let last: Record<string, unknown> | undefined;
  for (;;) {
    const response = await request(fixture.base, 'GET', `/api/sop-runs/${id}`);
    assert.equal(response.status, 200, JSON.stringify(response.body));
    last = response.body;
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function waitForClosed(fixture: Fixture, id: string): Promise<Record<string, unknown>> {
  return await waitForRun(
    fixture,
    id,
    (run) => run['phase'] === 'completed' || run['phase'] === 'failed',
    'the run to close',
  );
}

async function createDefinition(
  fixture: Fixture,
  channelId: string = fixture.channelId,
  name = '周报流程',
): Promise<string> {
  const created = await request(fixture.base, 'POST', '/api/sops', {
    channel_id: channelId,
    name,
    steps: [
      step({
        title: '收集',
        executor_member_id: fixture.agentA,
        verifier_member_id: fixture.agentB,
      }),
      step({
        title: '汇总',
        executor_member_id: fixture.agentB,
        verifier_member_id: fixture.agentA,
        max_attempts: 5,
      }),
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body['id'] as string;
}

test('start returns 202 with a pending run and writes one run row without side effects', async () => {
  const fixture = await startFixture();
  try {
    const definitionId = await createDefinition(fixture);
    const before = (() => {
      const db = openDatabase(fixture.dataDir);
      try {
        return {
          messages: count(db, 'message'),
          tasks: count(db, 'task'),
          targets: count(db, 'target'),
          teamRuns: count(db, 'team_run'),
          assignments: count(db, 'team_assignment'),
          roundOutcomes: count(db, 'round_outcome'),
          budgets: count(db, 'target_budget'),
        };
      } finally {
        db.close();
      }
    })();

    const started = await request(
      fixture.base,
      'POST',
      `/api/sops/${definitionId}/runs`,
    );
    assert.equal(started.status, 202, JSON.stringify(started.body));
    const run = started.body;
    assert.equal(run['definition_id'], definitionId);
    assert.equal(run['channel_id'], fixture.channelId);
    assert.equal(run['phase'], 'pending');
    assert.equal(run['current_step'], 0);
    assert.equal(run['finished_at'], null);
    assert.equal(run['started_at'], FIXED_NOW);
    assert.equal(run['updated_at'], FIXED_NOW);
    assert.equal(typeof run['id'], 'string');
    const state = run['state'] as Record<string, unknown>;
    assert.equal(state['current_step'], 0);
    assert.equal(state['attempt'], 0);
    assert.deepEqual(state['steps'], []);
    assert.equal(state['waiting_on'], null);
    assert.equal(state['error'], null);

    // Execution starts after the 202; the scripted `reply` double carries no
    // structured sopVerdict, so this run closes failed. The row survives with
    // the same identity and the same started_at the start response returned.
    const closed = await waitForClosed(fixture, String(run['id']));
    const row = runRow(fixture.dataDir, String(run['id']));
    assert.ok(row !== undefined, 'the run is a sqlite row');
    assert.equal(row.phase, 'failed');
    assert.equal(row.definition_id, definitionId);
    assert.equal(row.channel_id, fixture.channelId);
    assert.equal(row.started_at, FIXED_NOW);
    assert.ok(Array.isArray(Object.keys(JSON.parse(row.state))));
    const db = openDatabase(fixture.dataDir);
    try {
      assert.equal(
        (db.prepare("SELECT json_type(state) AS kind FROM sop_run WHERE id = ?").get(run['id']) as {
          kind: string;
        }).kind,
        'object',
        'the state column holds a JSON object',
      );
      assert.equal(count(db, 'message'), before.messages);
      assert.equal(count(db, 'task'), before.tasks);
      assert.equal(count(db, 'target'), before.targets);
      assert.equal(count(db, 'team_run'), before.teamRuns);
      assert.equal(count(db, 'team_assignment'), before.assignments);
      assert.equal(count(db, 'round_outcome'), before.roundOutcomes);
      assert.equal(count(db, 'target_budget'), before.budgets);
    } finally {
      db.close();
    }

    const single = await request(fixture.base, 'GET', `/api/sop-runs/${String(run['id'])}`);
    assert.equal(single.status, 200);
    assert.equal(single.body['id'], run['id']);
    assert.equal(single.body['phase'], closed['phase']);
    assert.equal(single.body['started_at'], run['started_at']);

    const listed = await request(fixture.base, 'GET', `/api/sops/${definitionId}/runs`);
    assert.equal(listed.status, 200);
    const listedRuns = listed.body['runs'] as Record<string, unknown>[];
    assert.equal(listedRuns.length, 1);
    assert.equal(listedRuns[0]?.['id'], run['id']);
  } finally {
    await fixture.stop();
  }
});

test('a second start is 409 while a run is pending, running or awaiting; a closed run allows another start', async () => {
  const fixture = await startFixture();
  try {
    const definitionId = await createDefinition(fixture);
    const first = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(first.status, 202);
    const firstId = first.body['id'] as string;
    // The worker may finish before the next request; the active-run boundary is
    // therefore exercised by advancing the stored row to each active phase.
    await waitForClosed(fixture, firstId);

    setPhase(fixture.dataDir, firstId, 'pending');
    const whilePending = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(whilePending.status, 409);
    assert.equal(errorCode(whilePending.body), 'conflict');

    setPhase(fixture.dataDir, firstId, 'running');
    const whileRunning = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(whileRunning.status, 409);

    setPhase(fixture.dataDir, firstId, 'awaiting', { currentStep: 1 });
    const whileAwaiting = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(whileAwaiting.status, 409);

    setPhase(fixture.dataDir, firstId, 'completed', { currentStep: 2 });
    const afterCompleted = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(afterCompleted.status, 202, JSON.stringify(afterCompleted.body));
    const secondId = afterCompleted.body['id'] as string;
    assert.notEqual(secondId, firstId);
    await waitForClosed(fixture, secondId);

    setPhase(fixture.dataDir, secondId, 'failed');
    const afterFailed = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    assert.equal(afterFailed.status, 202, JSON.stringify(afterFailed.body));
    await waitForClosed(fixture, String(afterFailed.body['id']));

    const listed = await request(fixture.base, 'GET', `/api/sops/${definitionId}/runs`);
    assert.deepEqual(
      (listed.body['runs'] as { id: string }[]).map((row) => row.id),
      [afterFailed.body['id'], secondId, firstId],
      'runs are newest first; the tie on started_at falls back to rowid',
    );
  } finally {
    await fixture.stop();
  }
});

test('the run snapshot pages newest first with the before cursor and a 1–50 limit', async () => {
  const fixture = await startFixture();
  try {
    const definitionId = await createDefinition(fixture);
    const first = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    await waitForClosed(fixture, String(first.body['id']));
    setPhase(fixture.dataDir, String(first.body['id']), 'completed');
    const second = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);
    await waitForClosed(fixture, String(second.body['id']));
    setPhase(fixture.dataDir, String(second.body['id']), 'failed');
    const third = await request(fixture.base, 'POST', `/api/sops/${definitionId}/runs`);

    const all = await request(fixture.base, 'GET', `/api/sops/${definitionId}/runs`);
    const ids = (all.body['runs'] as { id: string }[]).map((row) => row.id);
    assert.deepEqual(ids, [third.body['id'], second.body['id'], first.body['id']]);

    const page = await request(
      fixture.base,
      'GET',
      `/api/sops/${definitionId}/runs?limit=2`,
    );
    assert.deepEqual(
      (page.body['runs'] as { id: string }[]).map((row) => row.id),
      [third.body['id'], second.body['id']],
    );
    const nextPage = await request(
      fixture.base,
      'GET',
      `/api/sops/${definitionId}/runs?limit=2&before=${String(second.body['id'])}`,
    );
    assert.deepEqual(
      (nextPage.body['runs'] as { id: string }[]).map((row) => row.id),
      [first.body['id']],
    );

    for (const limit of ['0', '51', 'abc']) {
      const response = await request(
        fixture.base,
        'GET',
        `/api/sops/${definitionId}/runs?limit=${limit}`,
      );
      assert.equal(response.status, 400, `limit=${limit}`);
      assert.equal(errorCode(response.body), 'validation_failed');
    }
    const unknownCursor = await request(
      fixture.base,
      'GET',
      `/api/sops/${definitionId}/runs?before=does-not-exist`,
    );
    assert.equal(unknownCursor.status, 400);
    assert.equal(errorCode(unknownCursor.body), 'validation_failed');

    const otherDefinition = await createDefinition(fixture, fixture.secondChannelId, '另一个流程');
    const foreignCursor = await request(
      fixture.base,
      'GET',
      `/api/sops/${definitionId}/runs?before=${otherDefinition}`,
    );
    assert.equal(foreignCursor.status, 400, 'the cursor must belong to this definition');

    assert.equal(
      (await request(fixture.base, 'GET', '/api/sops/does-not-exist/runs')).status,
      404,
    );
    assert.equal(
      (await request(fixture.base, 'GET', '/api/sop-runs/does-not-exist')).status,
      404,
    );
  } finally {
    await fixture.stop();
  }
});

test('start refuses archived, deleted and invalidated definitions with the documented errors', async () => {
  const fixture = await startFixture();
  try {
    // Unknown definition.
    const unknown = await request(fixture.base, 'POST', '/api/sops/does-not-exist/runs');
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(unknown.body), 'not_found');

    // Archived channel definition.
    const archived = await createDefinition(fixture, fixture.channelId, '归档流程');
    await request(fixture.base, 'POST', `/api/channels/${fixture.channelId}/archive`, {});
    const archivedStart = await request(fixture.base, 'POST', `/api/sops/${archived}/runs`);
    assert.equal(archivedStart.status, 400);
    assert.equal(errorCode(archivedStart.body), 'validation_failed');

    // Deleted channel definition.
    const deleted = await createDefinition(fixture, fixture.secondChannelId, '删除流程');
    await request(fixture.base, 'DELETE', `/api/channels/${fixture.secondChannelId}`);
    const deletedStart = await request(fixture.base, 'POST', `/api/sops/${deleted}/runs`);
    assert.equal(deletedStart.status, 404);
    assert.equal(errorCode(deletedStart.body), 'not_found');

    // A member that soft-deletes after the definition was created makes the
    // stored definition invalid; the start is refused and writes no run.
    const thirdChannel = (await request(fixture.base, 'POST', '/api/channels', {
      name: '失效流程频道',
    })).body['id'] as string;
    await request(fixture.base, 'POST', `/api/channels/${thirdChannel}/members`, {
      member_id: fixture.agentA,
    });
    await request(fixture.base, 'POST', `/api/channels/${thirdChannel}/members`, {
      member_id: fixture.agentB,
    });
    const invalidated = await createDefinition(fixture, thirdChannel, '失效流程');
    await request(fixture.base, 'DELETE', `/api/agents/${fixture.agentB}`);
    const invalidStart = await request(fixture.base, 'POST', `/api/sops/${invalidated}/runs`);
    assert.equal(invalidStart.status, 400);
    assert.equal(errorCode(invalidStart.body), 'validation_failed');

    const db = openDatabase(fixture.dataDir);
    try {
      assert.equal(
        count(db, 'sop_run'),
        0,
        'a refused start writes no run (the archived / deleted / invalid cases)',
      );
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
  }
});
