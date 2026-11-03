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
