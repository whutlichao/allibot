import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import { ZH_CN } from '@allibot/shared';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  REPO_ROOT,
  type RunningServer,
} from './support.ts';

/**
 * 上下文窗口 (Context Window)、轮次结束原因 (Round Finished Reason) 与消费游标
 * (Agent Read Cursor) at the one seam: a real backend process, a temporary data
 * directory and the scripted double injected through startup arguments. The
 * double reports what the round actually read (`ctx` / `reread`) through the
 * ordinary reply message, so no test reaches into the orchestration module.
 */

const WAKE_ROUND_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'wake-round.mjs');
const AGENT_MESSAGE_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'agent-message.mjs');

type ProviderBehavior =
  | 'reply'
  | 'ignore'
  | 'fail'
  | 'delay'
  | 'silent'
  | 'no-body'
  | 'iteration-limit';

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface RoundOutcomeRow {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
  finished_reason: string | null;
  budget_consumed: number;
  merged: number;
}

async function startFixture(
  prefix: string,
  provider: ProviderBehavior,
  extraArgs: readonly string[] = [],
): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', provider, ...extraArgs],
  });
  return {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: Fixture, name = '上下文频道'): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: Fixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(fixture: Fixture, channelId: string, memberId: string): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: Fixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

function runFixture(script: string, input: Record<string, unknown>): Record<string, unknown> {
  const result = spawnSync(process.execPath, [script, JSON.stringify(input)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `fixture ${path.basename(script)} should exit 0; ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(typeof parsed === 'object' && parsed !== null, 'the fixture answers JSON');
  const record = parsed as Record<string, unknown>;
  assert.equal(record['ok'], true, `fixture ${path.basename(script)} failed: ${result.stdout}`);
  return record;
}

function queryRows<T>(fixture: Fixture, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

function roundOutcomes(fixture: Fixture): RoundOutcomeRow[] {
  return queryRows<RoundOutcomeRow>(
    fixture,
    `SELECT member_id, target_id, base_seq, status, reason, finished_reason,
            budget_consumed, merged
       FROM round_outcome ORDER BY rowid`,
  );
}

/**
 * The statuses the fixture has stored, read through the sqlite3 CLI itself —
 * the same reading the acceptance criteria names.
 */
function distinctStatuses(fixture: Fixture): string[] {
  const result = spawnSync(
    'sqlite3',
    [
      '-cmd',
      '.timeout 5000',
      path.join(fixture.dataDir, 'allibot.db'),
      'select distinct status from round_outcome',
    ],
    { encoding: 'utf8' },
  );
  assert.equal(result.status, 0, `sqlite3 should read the outcomes: ${result.stderr}`);
  return result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function countRoundOutcomes(fixture: Fixture): number {
  const rows = queryRows<{ total: number }>(fixture, 'SELECT count(*) AS total FROM round_outcome');
  return rows[0]?.total ?? 0;
}

function readPosition(fixture: Fixture, memberId: string, targetId: string): number | null {
  const rows = queryRows<{ last_read_seq: number }>(
    fixture,
    'SELECT last_read_seq FROM read_position WHERE member_id = ? AND target_id = ?',
    [memberId, targetId],
  );
  assert.ok(rows.length <= 1, 'read_position keeps one row per member and target');
  return rows[0]?.last_read_seq ?? null;
}

/** The double's context report, read off the reply body it landed. */
interface ContextReport {
  ctx: number;
  ctxfirst: number;
  ctxlast: number;
  reread: boolean;
}

function contextReport(body: string): ContextReport {
  const read = (name: string): number => {
    const match = new RegExp(`${name}:(\\d+)`).exec(body);
    assert.ok(match !== null, `the reply should report ${name}: ${body}`);
    return Number(match[1]);
  };
  const reread = /reread:(true|false)/.exec(body);
  assert.ok(reread !== null, `the reply should report reread: ${body}`);
  return {
    ctx: read('ctx'),
    ctxfirst: read('ctxfirst'),
    ctxlast: read('ctxlast'),
    reread: reread[1] === 'true',
  };
}

/** The latest Agent reply's body in one target; replies are the double's report face. */
function latestAgentBody(fixture: Fixture, targetId: string): string {
  const rows = queryRows<{ body: string }>(
    fixture,
    "SELECT body FROM message WHERE target_id = ? AND kind = 'agent' ORDER BY seq DESC LIMIT 1",
    [targetId],
  );
  assert.ok(rows.length === 1, `no agent reply in target ${targetId}`);
  return rows[0]!.body;
}

async function waitFor(
  predicate: () => boolean,
  describe: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      assert.fail(`${describe} did not settle in ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('a normal round reads the most recent 40 messages: the earliest ten are outside the window', async () => {
  const fixture = await startFixture('allibot-context-window-', 'reply', [
    '--scripted-report-context',
  ]);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    // Forty-nine messages land before the Agent is a member, so none of them
    // wakes anyone; the fiftieth message is the one that triggers the round.
    for (let seq = 1; seq <= 49; seq += 1) {
      const posted = await postMessage(fixture, channelId, { body: `准备第 ${seq} 条` });
      assert.equal(posted['seq'], seq);
    }
    await joinChannel(fixture, channelId, agent);
    const trigger = await postMessage(fixture, channelId, { body: '请回应' });
    assert.equal(trigger['seq'], 50);

    const reply = latestAgentBody(fixture, channelId);
    const report = contextReport(reply);
    assert.equal(report.ctx, 40, 'the normal round window is the most recent 40 messages');
    assert.equal(report.ctxfirst, 11, 'the window starts at the eleventh-newest message');
    assert.equal(report.ctxlast, 50, 'the window ends at the triggering message');
    assert.ok(report.ctxfirst > 10, 'the earliest ten messages are outside the window');
  } finally {
    await fixture.stop();
  }
});

test('a replied round consumes its trigger and reads it back from the window', async () => {
  const fixture = await startFixture('allibot-cursor-replied-', 'reply', [
    '--scripted-report-context',
  ]);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    // No cursor row exists before the first round: nothing has been consumed.
    assert.equal(readPosition(fixture, agent, channelId), null);

    const first = await postMessage(fixture, channelId, { body: '第一句' });
    assert.equal(first['seq'], 1);
    assert.equal(
      readPosition(fixture, agent, channelId),
      1,
      'a replied round advances the consumption cursor to the triggering seq',
    );

    const report = contextReport(latestAgentBody(fixture, channelId));
    assert.equal(report.ctx, 1, 'the first round reads the one message that woke it');
    assert.equal(report.ctxfirst, 1);
    assert.equal(report.ctxlast, 1);
    assert.equal(report.reread, false, 'the cursor is behind the trigger, not ahead of it');
  } finally {
    await fixture.stop();
  }
});

test('an ignored round consumes its trigger, and the cursor moves only on replied / ignored', async () => {
  // An Agent-authored message with no mention is the non-definite round the
  // `ignore` behaviour closes as `ignored`; the listener is its only reader.
  const fixture = await startFixture('allibot-cursor-ignored-', 'ignore', [
    '--scripted-report-context',
  ]);
  try {
    const speaker = await createAgent(fixture, '甲');
    const listener = await createAgent(fixture, '乙');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, speaker);
    await joinChannel(fixture, channelId, listener);

    runFixture(AGENT_MESSAGE_FIXTURE, {
      dataDir: fixture.dataDir,
      targetId: channelId,
      authorMemberId: speaker,
      body: '说给另一个成员听的一句',
      behavior: 'ignore',
    });

    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1, 'only the listener was woken');
    assert.equal(outcomes[0]?.status, 'ignored');
    assert.equal(
      readPosition(fixture, listener, channelId),
      1,
      'an ignored round advances the consumption cursor to the triggering seq',
    );
    assert.equal(
      readPosition(fixture, speaker, channelId),
      null,
      'the author never reads its own message: no cursor row for it',
    );
  } finally {
    await fixture.stop();
  }
});

test('a failed round does not move the cursor and the next wake re-reads its message', async () => {
  // The human message lands while the Agent is not yet a member, so it wakes
  // nobody; the failed round is then delivered by the test fixture through the
  // same orchestration entry point, with the failing double. The server's own
  // double is the reporting reply: its next round is the face the window is
  // read from, and the cursor is the only state carried between the processes.
  const fixture = await startFixture('allibot-cursor-failed-', 'reply', [
    '--scripted-report-context',
  ]);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    const first = await postMessage(fixture, channelId, { body: '会失败的一句' });
    assert.equal(first['seq'], 1);
    await joinChannel(fixture, channelId, agent);

    runFixture(WAKE_ROUND_FIXTURE, {
      dataDir: fixture.dataDir,
      targetId: channelId,
      memberId: agent,
      fromSeq: 1,
      reason: 'channel-message',
      behavior: 'fail',
    });
    const failed = roundOutcomes(fixture);
    assert.equal(failed.length, 1);
    assert.equal(failed[0]?.status, 'failed');
    assert.equal(
      readPosition(fixture, agent, channelId),
      null,
      'a failed round never advances the consumption cursor',
    );

    // The next wake's window still carries the failed message, which the
    // double reports as `reread:true`: it was read before and never consumed.
    const second = await postMessage(fixture, channelId, { body: '再来一句' });
    assert.equal(second['seq'], 2);
    const report = contextReport(latestAgentBody(fixture, channelId));
    assert.equal(report.ctx, 2, 'the next round reads the failed message and its trigger');
    assert.equal(report.ctxfirst, 1);
    assert.equal(report.ctxlast, 2);
    assert.equal(report.reread, true, 'the failed message is read again');
    // The replied round that read it now consumes both messages: the cursor
    // advances to its own trigger, and the re-read message is finally passed.
    assert.equal(readPosition(fixture, agent, channelId), 2);
  } finally {
    await fixture.stop();
  }
});

test('round_outcome records all six statuses through the production write paths', async () => {
  // replied / ignored / failed / merged / budget-exhausted / silent, each
  // produced by the path that owns it: the CLI-injected double, the relay of an
  // Agent message, two messages inside one delayed round, the epoch ceiling,
  // and the structured silence of a non-definite round.
  const repliedFixture = await startFixture('allibot-status-replied-', 'reply');
  try {
    const agent = await createAgent(repliedFixture, '甲');
    const channelId = await createChannel(repliedFixture);
    await joinChannel(repliedFixture, channelId, agent);
    await postMessage(repliedFixture, channelId, { body: '请回应' });
    assert.deepEqual(
      distinctStatuses(repliedFixture).sort(),
      ['replied'],
      'the reply behaviour closes as replied',
    );
  } finally {
    await repliedFixture.stop();
  }

  const ignoredFixture = await startFixture('allibot-status-ignored-', 'ignore');
  try {
    const speaker = await createAgent(ignoredFixture, '甲');
    const listener = await createAgent(ignoredFixture, '乙');
    const channelId = await createChannel(ignoredFixture);
    await joinChannel(ignoredFixture, channelId, speaker);
    await joinChannel(ignoredFixture, channelId, listener);
    runFixture(AGENT_MESSAGE_FIXTURE, {
      dataDir: ignoredFixture.dataDir,
      targetId: channelId,
      authorMemberId: speaker,
      body: '没有点名的一句',
      behavior: 'ignore',
    });
    assert.deepEqual(distinctStatuses(ignoredFixture).sort(), ['ignored']);
  } finally {
    await ignoredFixture.stop();
  }

  const failedFixture = await startFixture('allibot-status-failed-', 'fail');
  try {
    const agent = await createAgent(failedFixture, '甲');
    const channelId = await createChannel(failedFixture);
    await joinChannel(failedFixture, channelId, agent);
    await postMessage(failedFixture, channelId, { body: '请回应' });
    assert.deepEqual(distinctStatuses(failedFixture).sort(), ['failed']);
  } finally {
    await failedFixture.stop();
  }

  const mergedFixture = await startFixture('allibot-status-merged-', 'delay', [
    '--scripted-delay-ms',
    '1500',
  ]);
  try {
    const agent = await createAgent(mergedFixture, '慢工');
    const channelId = await createChannel(mergedFixture);
    await joinChannel(mergedFixture, channelId, agent);
    await postMessage(mergedFixture, channelId, { body: '第一句' });
    await postMessage(mergedFixture, channelId, { body: '第二句' });
    await waitFor(
      () => distinctStatuses(mergedFixture).includes('merged'),
      'the repeated wake to fold into the delayed round',
    );
    assert.deepEqual(distinctStatuses(mergedFixture).sort(), ['merged', 'replied']);
  } finally {
    await mergedFixture.stop();
  }

  // Budget exhaustion: the channel ceiling is 3 jumps, each Agent message
  // relays one jump, and the fourth Agent message is suppressed. The `reply`
  // chain is depth first, so the fourth Agent message is the second member's
  // answer to the first member's answer and starts no round of its own.
  const exhaustedFixture = await startFixture('allibot-status-exhausted-', 'reply');
  try {
    const first = await createAgent(exhaustedFixture, '甲');
    const second = await createAgent(exhaustedFixture, '乙');
    const channelId = await createChannel(exhaustedFixture);
    await joinChannel(exhaustedFixture, channelId, first);
    await joinChannel(exhaustedFixture, channelId, second);
    await postMessage(exhaustedFixture, channelId, { body: '大家好' });
    const statuses = distinctStatuses(exhaustedFixture);
    assert.ok(
      statuses.includes('budget-exhausted'),
      `the exhausted epoch writes the suppressed row: ${statuses.join(', ')}`,
    );
  } finally {
    await exhaustedFixture.stop();
  }

  const silentFixture = await startFixture('allibot-status-silent-', 'ignore');
  try {
    const speaker = await createAgent(silentFixture, '甲');
    const listener = await createAgent(silentFixture, '乙');
    const channelId = await createChannel(silentFixture);
    await joinChannel(silentFixture, channelId, speaker);
    await joinChannel(silentFixture, channelId, listener);
    runFixture(AGENT_MESSAGE_FIXTURE, {
      dataDir: silentFixture.dataDir,
      targetId: channelId,
      authorMemberId: speaker,
      body: '没有点名、显式沉默的一句',
      behavior: 'silent',
    });
    assert.deepEqual(distinctStatuses(silentFixture).sort(), ['silent']);
  } finally {
    await silentFixture.stop();
  }
});

test('finished_reason reads as completed / iteration limit / error, and stays unknown where no round finished', async () => {
  const completedFixture = await startFixture('allibot-finish-completed-', 'reply');
  try {
    const agent = await createAgent(completedFixture, '甲');
    const channelId = await createChannel(completedFixture);
    await joinChannel(completedFixture, channelId, agent);
    await postMessage(completedFixture, channelId, { body: '请回应' });
    assert.equal(
      roundOutcomes(completedFixture)[0]?.finished_reason,
      ZH_CN['round.finished.completed'].text,
    );
  } finally {
    await completedFixture.stop();
  }

  const limitedFixture = await startFixture('allibot-finish-iteration-limit-', 'iteration-limit');
  try {
    const agent = await createAgent(limitedFixture, '甲');
    const channelId = await createChannel(limitedFixture);
    await joinChannel(limitedFixture, channelId, agent);
    await postMessage(limitedFixture, channelId, { body: '请回应' });
    const outcomes = roundOutcomes(limitedFixture);
    assert.equal(outcomes[0]?.status, 'replied', 'the partial conclusion is still landed');
    assert.equal(
      outcomes[0]?.finished_reason,
      ZH_CN['round.finished.iterationLimit'].text,
      'the iteration cap is a readable finished reason, not a normal completion',
    );
  } finally {
    await limitedFixture.stop();
  }

  const failedFixture = await startFixture('allibot-finish-error-', 'fail');
  try {
    const agent = await createAgent(failedFixture, '甲');
    const channelId = await createChannel(failedFixture);
    await joinChannel(failedFixture, channelId, agent);
    await postMessage(failedFixture, channelId, { body: '请回应' });
    assert.equal(roundOutcomes(failedFixture)[0]?.finished_reason, ZH_CN['round.finished.error'].text);
  } finally {
    await failedFixture.stop();
  }

  // No round of its own to finish: a merged row and a suppressed wake both
  // keep the unknown reading.
  const mergedFixture = await startFixture('allibot-finish-merged-', 'delay', [
    '--scripted-delay-ms',
    '1500',
  ]);
  try {
    const agent = await createAgent(mergedFixture, '慢工');
    const channelId = await createChannel(mergedFixture);
    await joinChannel(mergedFixture, channelId, agent);
    await postMessage(mergedFixture, channelId, { body: '第一句' });
    await postMessage(mergedFixture, channelId, { body: '第二句' });
    await waitFor(
      () => distinctStatuses(mergedFixture).includes('merged'),
      'the repeated wake to fold into the delayed round',
    );
    const merged = roundOutcomes(mergedFixture).find((row) => row.status === 'merged');
    assert.equal(merged?.finished_reason, null, 'a merged row has no round of its own to finish');
  } finally {
    await mergedFixture.stop();
  }

  const exhaustedFixture = await startFixture('allibot-finish-suppressed-', 'reply');
  try {
    const first = await createAgent(exhaustedFixture, '甲');
    const second = await createAgent(exhaustedFixture, '乙');
    const channelId = await createChannel(exhaustedFixture);
    await joinChannel(exhaustedFixture, channelId, first);
    await joinChannel(exhaustedFixture, channelId, second);
    await postMessage(exhaustedFixture, channelId, { body: '大家好' });
    const suppressed = roundOutcomes(exhaustedFixture).find(
      (row) => row.status === 'budget-exhausted',
    );
    assert.equal(suppressed?.finished_reason, null, 'a suppressed wake runs no round at all');
  } finally {
    await exhaustedFixture.stop();
  }
});

test('sqlite3 refuses UPDATE and DELETE on round_outcome and the row count stays put', async () => {
  const fixture = await startFixture('allibot-round-outcome-append-only-', 'reply');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    await postMessage(fixture, channelId, { body: '不可改' });
    const before = countRoundOutcomes(fixture);
    assert.ok(before > 0, 'the fixture wrote at least one outcome row');
    await fixture.running.stop();

    const sql = (statement: string): { status: number | null; output: string } => {
      const result = spawnSync('sqlite3', [path.join(fixture.dataDir, 'allibot.db'), statement], {
        encoding: 'utf8',
      });
      return { status: result.status, output: `${result.stdout}${result.stderr}` };
    };

    const update = sql("update round_outcome set status = 'failed'");
    assert.notEqual(update.status, 0, 'the update trigger aborts');
    assert.match(update.output, /append-only/i);

    const remove = sql('delete from round_outcome');
    assert.notEqual(remove.status, 0, 'the delete trigger aborts');
    assert.match(remove.output, /append-only/i);

    assert.equal(countRoundOutcomes(fixture), before, 'both refused statements leave the rows');
  } finally {
    await fixture.stop();
  }
});

test('the round outcome row carries the ten acceptance fields, and the cursor the trigger seq', async () => {
  const fixture = await startFixture('allibot-outcome-fields-', 'reply');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    const posted = await postMessage(fixture, channelId, { body: '请回应' });
    const seq = posted['seq'] as number;

    const rows = queryRows<Record<string, unknown>>(fixture, 'SELECT * FROM round_outcome');
    assert.equal(rows.length, 1);
    const row = rows[0]!;
    assert.deepEqual(Object.keys(row).sort(), [
      'base_seq',
      'budget_consumed',
      'finished_at',
      'finished_reason',
      'id',
      'member_id',
      'merged',
      'reason',
      'started_at',
      'status',
      'target_id',
    ]);
    assert.equal(row['member_id'], agent);
    assert.equal(row['target_id'], channelId);
    assert.equal(row['base_seq'], seq);
    assert.equal(row['status'], 'replied');
    assert.equal(row['budget_consumed'], 0, 'a human message wake is not a budgeted jump');
    assert.equal(row['merged'], 0);
    assert.ok(typeof row['reason'] === 'string' && (row['reason'] as string).length > 0);
    assert.equal(row['finished_reason'], ZH_CN['round.finished.completed'].text);
    assert.ok(typeof row['started_at'] === 'string' && (row['started_at'] as string).length > 0);
    assert.ok(typeof row['finished_at'] === 'string' && (row['finished_at'] as string).length > 0);
  } finally {
    await fixture.stop();
  }
});
