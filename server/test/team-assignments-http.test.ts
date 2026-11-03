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
 * TeamAssign / 分派 (#39 / D3.4): the leader round calls a member sub-round and
 * the assignment is a run record, never a message. The scripted double is the
 * member-face adapter; its `team-assign` / `team-budget` behaviours drive the
 * real production write path (the tool face is part of the round input), and
 * its `--scripted-report-team` capability reports the prompt / tool set a
 * round was handed through the ordinary reply body.
 */

type AssignmentBehavior = 'reply' | 'team-assign' | 'team-budget';

interface TeamFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  channelId: string;
  leaderId: string;
  memberIds: readonly string[];
  task: { id: string; targetId: string } | null;
  stop: () => Promise<void>;
}

interface FixtureOptions {
  behavior: AssignmentBehavior;
  /** Which created members the leader double assigns, in call order. */
  assign?: readonly ('a' | 'b')[];
  extraArgs?: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** Create a task before the team opt-in; `assignee` selects a member index. */
  task?: { assignee?: 'a' | 'b' } | null;
  channelBudgetLimit?: number;
  agentModels?: { leader?: string; a?: string; b?: string };
  disable?: readonly ('a' | 'b')[];
  consentProviders?: readonly string[];
}

async function postJson(
  base: string,
  route: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, `${route} -> ${response.status}: ${text}`);
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function patchJson(
  base: string,
  route: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  assert.ok(response.status >= 200 && response.status < 300, `${route} -> ${response.status}: ${text}`);
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>);
}

async function getJson(base: string, route: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${base}${route}`);
  const text = await response.text();
  assert.equal(response.status, 200, `${route} -> ${response.status}: ${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * One fixture: a first (setup) process creates the channel / agents / team
 * configuration through the HTTP face, then stops; the second process runs the
 * assignment behaviour with the member ids injected as startup arguments,
 * because the double is selected before those rows exist.
 */
async function startTeamFixture(prefix: string, options: FixtureOptions): Promise<TeamFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const setup = await startServer(dataDir, { args: ['--scripted-provider', 'reply'] });
  const setupBase = `http://127.0.0.1:${setup.port}`;
  try {
    const channel = await postJson(setupBase, '/api/channels', {
      name: '分派频道',
      description: '',
      mode: 'autonomous',
      response_budget_limit: options.channelBudgetLimit ?? 10,
    });
    const channelId = channel['id'] as string;
    const leader = await postJson(setupBase, '/api/agents', {
      display_name: '队长',
      model: options.agentModels?.leader ?? 'openai:gpt-5',
    });
    const memberA = await postJson(setupBase, '/api/agents', {
      display_name: '成员甲',
      model: options.agentModels?.a ?? 'openai:gpt-5',
    });
    const memberB = await postJson(setupBase, '/api/agents', {
      display_name: '成员乙',
      model: options.agentModels?.b ?? 'openai:gpt-5',
    });
    const leaderId = leader['id'] as string;
    const memberIds = [memberA['id'] as string, memberB['id'] as string];
    // The stored second rule piece must be present for the composition-order
    // report; the global / project pieces stay absent until #43.
    await patchJson(setupBase, `/api/agents/${leaderId}`, {
      system_prompt: '遵守项目规则。',
    });
    for (const memberId of [leaderId, ...memberIds]) {
      await postJson(setupBase, `/api/channels/${channelId}/members`, { member_id: memberId });
    }

    let task: { id: string; targetId: string } | null = null;
    if (options.task !== undefined && options.task !== null) {
      const created = await postJson(setupBase, '/api/tasks', {
        channel_id: channelId,
        title: '协作任务',
      });
      task = { id: created['id'] as string, targetId: created['target_id'] as string };
      if (options.task.assignee !== undefined) {
        await patchJson(setupBase, `/api/tasks/${task.id}`, {
          assignee_member_id: memberIds[options.task.assignee === 'a' ? 0 : 1],
        });
      }
    }

    await patchJson(setupBase, `/api/channels/${channelId}`, {
      mode: 'team',
      team_leader_member_id: leaderId,
    });
    for (const disabled of options.disable ?? []) {
      await patchJson(setupBase, `/api/agents/${memberIds[disabled === 'a' ? 0 : 1]}`, {
        enabled: 0,
      });
    }
  } finally {
    await setup.stop();
  }

  // The member ids are only known after the setup process created the rows;
  // the final process reads them from the same data directory and receives
  // them as startup arguments, because the double is selected before the rows
  // exist.
  const ids = readIds(dataDir);
  const resolvedAssign = (options.assign ?? []).flatMap((key) => [
    '--scripted-team-assign-member',
    ids.memberIds[key === 'a' ? 0 : 1] ?? '',
  ]);

  const running = await startServer(dataDir, {
    env: options.env ?? { OPENAI_API_KEY: 'sk-team-assign-test' },
    args: [
      '--scripted-provider',
      options.behavior,
      ...resolvedAssign,
      ...(options.extraArgs ?? []),
    ],
  });
  const base = `http://127.0.0.1:${running.port}`;
  for (const provider of options.consentProviders ?? ['openai']) {
    await postJson(base, `/api/remote-data-flow/${provider}/consent`, {});
  }

  const stop = async (): Promise<void> => {
    await running.stop();
    await removeTempDir(dataDir);
  };
  return {
    dataDir,
    running,
    base,
    channelId: ids.channelId,
    leaderId: ids.leaderId,
    memberIds: ids.memberIds,
    task: ids.task,
    stop,
  };
}

function readIds(dataDir: string): {
  channelId: string;
  leaderId: string;
  memberIds: string[];
  task: { id: string; targetId: string } | null;
} {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const channel = db.prepare("SELECT id FROM channel ORDER BY rowid LIMIT 1").get() as {
      id: string;
    };
    const members = db
      .prepare("SELECT id FROM member WHERE kind = 'agent' ORDER BY rowid")
      .all() as { id: string }[];
    const task = db
      .prepare('SELECT id, target_id FROM task ORDER BY rowid LIMIT 1')
      .get() as { id: string; target_id: string } | undefined;
    return {
      channelId: channel.id,
      leaderId: members[0]?.id ?? '',
      memberIds: members.slice(1).map((member) => member.id),
      task: task === undefined ? null : { id: task.id, targetId: task.target_id },
    };
  } finally {
    db.close();
  }
}

function readDatabase<T>(
  fixture: TeamFixture,
  sql: string,
  params: unknown[] = [],
): T[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

interface MessageRow {
  seq: number;
  kind: string;
  author_member_id: string;
  body: string;
}

function channelMessages(fixture: TeamFixture): MessageRow[] {
  return readDatabase<MessageRow>(
    fixture,
    'SELECT seq, kind, author_member_id, body FROM message WHERE target_id = ? ORDER BY seq',
    [fixture.channelId],
  );
}

async function postChannelMessage(fixture: TeamFixture, body: string): Promise<void> {
  await postJson(fixture.base, `/api/targets/${fixture.channelId}/messages`, { body });
}

function capturedPrompt(body: string): string {
  const index = body.indexOf('[system-prompt]');
  assert.notEqual(index, -1, `the reply should carry the captured system prompt: ${body}`);
  return body.slice(index + '[system-prompt]'.length).trim();
}

function reportLine(body: string, label: string): string {
  const line = body.split('\n').find((candidate) => candidate.startsWith(`[${label}]`));
  assert.ok(line !== undefined, `the reply should carry the [${label}] report: ${body}`);
  return line;
}

test('a leader round carries the three-part rule order, the leader duties and only the eligible tools', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-prompt-', {
    behavior: 'reply',
    extraArgs: ['--scripted-report-team', '--scripted-echo-prompt', '--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请安排工作');

  const messages = channelMessages(fixture);
  const leaderReply = messages.find(
    (message) => message.kind === 'agent' && message.author_member_id === fixture.leaderId,
  );
  assert.ok(leaderReply !== undefined, 'the leader answers in the team channel');

  const teamLine = reportLine(leaderReply.body, 'team');
  assert.match(teamLine, /leader:true/, 'the round is the leader round');

  // 三段规则顺序: the rules base and the project supplement are absent until
  // the workspace layer exists, but the order is stated by the same seam that
  // assembles the prompt.
  assert.equal(
    reportLine(leaderReply.body, 'rules'),
    '[rules] global:absent > system:present > project:absent',
  );
  assert.equal(reportLine(leaderReply.body, 'leader'), '[leader] duties:present');
  const toolsLine = reportLine(leaderReply.body, 'tools');
  assert.ok(toolsLine.startsWith('[tools] TeamAssign'), `the leader tool set: ${toolsLine}`);
  assert.ok(!toolsLine.includes('transfer_task'), `a non-assignee leader has no transfer: ${toolsLine}`);

  const prompt = capturedPrompt(leaderReply.body);
  assert.ok(prompt.includes('用 TeamAssign'), `the prompt names TeamAssign: ${prompt}`);
  assert.ok(prompt.includes('同一轮'), 'the prompt says the member runs in the same round');
  assert.ok(prompt.includes('工具结果'), 'the prompt says the result comes back as a tool result');
  assert.ok(prompt.includes('不会落成频道消息'), 'the prompt says member output is not a channel message');
  assert.ok(prompt.includes('transfer_task'), 'the prompt names the transfer tool');
  assert.ok(prompt.includes('受派者'), 'the prompt limits transfer_task to the assignee');
  assert.ok(
    prompt.includes('你的名字是 队长。'),
    `the identity sentence is derived from member.display_name: ${prompt}`,
  );
});

interface AssignmentRow {
  id: string;
  team_run_id: string;
  target_id: string;
  task_id: string | null;
  member_id: string;
  state: string;
  jump_consumed: number;
  reply_excerpt: string | null;
  reason: string | null;
  started_at: string;
  finished_at: string | null;
}

function assignmentRows(fixture: TeamFixture): AssignmentRow[] {
  return readDatabase<AssignmentRow>(
    fixture,
    `SELECT id, team_run_id, target_id, task_id, member_id, state, jump_consumed,
            reply_excerpt, reason, started_at, finished_at
       FROM team_assignment ORDER BY rowid`,
  );
}

interface BudgetRow {
  target_id: string;
  epoch_seq: number;
  used: number;
  limit_value: number;
}

function budgetRows(fixture: TeamFixture): BudgetRow[] {
  return readDatabase<BudgetRow>(
    fixture,
    'SELECT target_id, epoch_seq, used, limit_value FROM target_budget ORDER BY target_id',
  );
}

function outcomeRows(fixture: TeamFixture): { member_id: string; status: string }[] {
  return readDatabase<{ member_id: string; status: string }>(
    fixture,
    'SELECT member_id, status FROM round_outcome ORDER BY rowid',
  );
}

test('a TeamAssign call runs the member inside the leader round and records one completed assignment', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-success-', {
    behavior: 'team-assign',
    assign: ['a'],
    extraArgs: [
      '--scripted-reply',
      'MEMBER-OUTPUT-ONLY-IN-THE-TOOL-RESULT',
      '--scripted-report-calls',
    ],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请把资料整理一下');

  const messages = channelMessages(fixture);
  assert.equal(messages.length, 2, 'only the human message and the leader final reply land');
  assert.equal(messages[0]?.kind, 'human');
  assert.equal(messages[1]?.kind, 'agent');
  assert.equal(messages[1]?.author_member_id, fixture.leaderId, 'the final reply is the leader');
  assert.ok(
    messages.every((message) => !message.body.includes('MEMBER-OUTPUT-ONLY-IN-THE-TOOL-RESULT')),
    'the member body never becomes a target message',
  );

  const assignments = assignmentRows(fixture);
  assert.equal(assignments.length, 1);
  const assignment = assignments[0];
  assert.ok(assignment !== undefined);
  assert.equal(assignment.state, 'completed');
  assert.equal(assignment.jump_consumed, 1, 'one call costs one jump');
  assert.equal(assignment.target_id, fixture.channelId);
  assert.equal(assignment.task_id, null);
  assert.equal(assignment.member_id, fixture.memberIds[0]);
  assert.ok((assignment.reply_excerpt ?? '').length > 0, 'the excerpt is readable');
  assert.match(assignment.reply_excerpt ?? '', /MEMBER-OUTPUT-ONLY-IN-THE-TOOL-RESULT/);
  assert.match(assignment.reply_excerpt ?? '', /calls:2/, 'the member sub-round was a real round');
  assert.equal(assignment.reason, null);
  assert.ok(assignment.started_at.length > 0);
  assert.ok(assignment.finished_at !== null, 'the assignment is closed');

  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.ok(channelBudget !== undefined, 'the human message opened the channel epoch');
  assert.equal(channelBudget.used, 1, 'the assignment advances the channel budget by one jump');

  const outcomes = outcomeRows(fixture);
  assert.deepEqual(
    outcomes.map((row) => row.member_id),
    [fixture.leaderId],
    'the member sub-round writes no round_outcome',
  );

  const unread = (await getJson(fixture.base, '/api/workspace'))['unread_by_target'] as Record<
    string,
    number
  >;
  assert.equal(unread[fixture.channelId], 1, 'only the leader final reply is unread');

  const search = await getJson(
    fixture.base,
    `/api/search?q=${encodeURIComponent('MEMBER-OUTPUT-ONLY-IN-THE-TOOL-RESULT')}`,
  );
  assert.deepEqual(search['hits'], [], 'the member body is not a search hit');

  const leaderReply = messages[1]?.body ?? '';
  assert.match(leaderReply, /calls:1/, 'only the leader provider call happened before the reply');
  assert.match(leaderReply, /jump=1/, 'the tool result reports the consumed jump');
  assert.match(leaderReply, /output=[1-9]\d*/, 'the full member output is returned in the tool result');
});

test('two TeamAssign calls in one leader round each spend one jump', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-two-', {
    behavior: 'team-assign',
    assign: ['a', 'b'],
    extraArgs: ['--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请分头处理');

  const assignments = assignmentRows(fixture);
  assert.equal(assignments.length, 2, 'one assignment per TeamAssign call');
  assert.deepEqual(
    assignments.map((row) => row.member_id),
    fixture.memberIds,
    'each call names its own member',
  );
  assert.deepEqual(assignments.map((row) => row.state), ['completed', 'completed']);
  assert.deepEqual(assignments.map((row) => row.jump_consumed), [1, 1]);
  assert.match(assignments[0]?.reply_excerpt ?? '', /calls:2/);
  assert.match(assignments[1]?.reply_excerpt ?? '', /calls:3/);

  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.equal(channelBudget?.used, 2, 'two calls advance the channel budget twice, not once');

  assert.equal(channelMessages(fixture).length, 2, 'neither member output becomes a message');
  assert.deepEqual(
    outcomeRows(fixture).map((row) => row.member_id),
    [fixture.leaderId],
    'the member sub-rounds write no round_outcome',
  );
});

test('an unavailable member gets a failed assignment with no jump and no sub-round', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-unavailable-', {
    behavior: 'team-assign',
    assign: ['a'],
    disable: ['a'],
    extraArgs: ['--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请分派给成员甲');

  const assignment = assignmentRows(fixture)[0];
  assert.ok(assignment !== undefined);
  assert.equal(assignment.state, 'failed');
  assert.equal(assignment.jump_consumed, 0, 'an unusable target spends no jump');
  assert.equal(assignment.reply_excerpt, null);
  assert.match(assignment.reason ?? '', /禁用/);

  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.equal(channelBudget?.used, 0, 'the budget did not move');
  assert.equal(channelMessages(fixture).length, 2, 'the member never ran and wrote no message');
  assert.deepEqual(outcomeRows(fixture).map((row) => row.member_id), [fixture.leaderId]);

  const leaderReply = channelMessages(fixture)[1]?.body ?? '';
  assert.match(leaderReply, /calls:1/, 'no member provider call happened');
  assert.match(leaderReply, /jump=0/);
  assert.match(leaderReply, /error=target_unavailable/);
});

test('a missing provider credential is an unavailable member, not a spent jump', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-credential-', {
    behavior: 'team-assign',
    assign: ['a'],
    agentModels: { a: 'anthropic:claude-sonnet-4' },
    consentProviders: ['openai', 'anthropic'],
    extraArgs: ['--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请分派给成员甲');

  const assignment = assignmentRows(fixture)[0];
  assert.ok(assignment !== undefined);
  assert.equal(assignment.state, 'failed');
  assert.equal(assignment.jump_consumed, 0);
  assert.match(assignment.reason ?? '', /ANTHROPIC_API_KEY/);
  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.equal(channelBudget?.used, 0);
  assert.match(channelMessages(fixture)[1]?.body ?? '', /error=target_unavailable/);
});

test('a member without remote-data-flow consent is unavailable', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-consent-', {
    behavior: 'team-assign',
    assign: ['a'],
    agentModels: { leader: 'anthropic:claude-sonnet-4', a: 'openai:gpt-5' },
    env: { ANTHROPIC_API_KEY: 'sk-team-assign-anthropic' },
    consentProviders: ['anthropic'],
    extraArgs: ['--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请分派给成员甲');

  const assignment = assignmentRows(fixture)[0];
  assert.ok(assignment !== undefined);
  assert.equal(assignment.state, 'failed');
  assert.equal(assignment.jump_consumed, 0);
  assert.match(assignment.reason ?? '', /告知/);
  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.equal(channelBudget?.used, 0);
});

test('an exhausted budget writes budget-exhausted with zero jump and runs no member', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-budget-', {
    behavior: 'team-budget',
    assign: ['a'],
    channelBudgetLimit: 3,
    extraArgs: ['--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请一直分派');

  const assignments = assignmentRows(fixture);
  assert.equal(assignments.length, 4, 'three completed calls reach the ceiling, the fourth is suppressed');
  assert.deepEqual(
    assignments.map((row) => row.state),
    ['completed', 'completed', 'completed', 'budget-exhausted'],
  );
  assert.deepEqual(assignments.map((row) => row.jump_consumed), [1, 1, 1, 0]);
  const exhausted = assignments[3];
  assert.ok(exhausted !== undefined);
  assert.equal(exhausted.reply_excerpt, null, 'the member never ran for the exhausted call');
  assert.match(exhausted.reason ?? '', /预算耗尽/);
  assert.match(exhausted.reason ?? '', /3\/3/);

  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.equal(channelBudget?.used, 3, 'the exhausted call does not advance the used count');

  assert.equal(channelMessages(fixture).length, 2, 'the leader still lands its final reply');
  const leaderReply = channelMessages(fixture)[1]?.body ?? '';
  assert.match(leaderReply, /error=budget_exhausted/);
  assert.match(leaderReply, /jump=0/);
  assert.match(leaderReply, /calls:1/);
});

test('a failed member sub-round closes the assignment failed without a refund', async (t) => {
  const fixture = await startTeamFixture('allibot-team-assign-member-fail-', {
    behavior: 'team-assign',
    assign: ['a'],
    extraArgs: ['--scripted-team-member-fail', '--scripted-report-calls'],
  });
  t.after(async () => fixture.stop());

  await postChannelMessage(fixture, '请分派给成员甲');

  const assignment = assignmentRows(fixture)[0];
  assert.ok(assignment !== undefined);
  assert.equal(assignment.state, 'failed');
  assert.equal(assignment.jump_consumed, 1, 'the jump is not refunded');
  assert.equal(assignment.reply_excerpt, null);
  assert.match(assignment.reason ?? '', /成员子轮次失败/);

  const channelBudget = budgetRows(fixture).find((row) => row.target_id === fixture.channelId);
  assert.equal(channelBudget?.used, 1, 'a failed member keeps the consumed jump');

  assert.equal(channelMessages(fixture).length, 2, 'the member failure lands no message');
  assert.deepEqual(outcomeRows(fixture).map((row) => row.member_id), [fixture.leaderId]);
  const leaderReply = channelMessages(fixture)[1]?.body ?? '';
  assert.match(leaderReply, /error=member_failed/);
  assert.match(leaderReply, /jump=1/);
});
