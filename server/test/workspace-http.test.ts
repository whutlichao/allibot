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
 * 工作台读数 (#27), observed at the process-level HTTP seam.
 *
 * `GET /api/workspace` is the app shell's only backend reading: the owner,
 * every live local Agent, channels (archived included), DMs, the task board,
 * the unread totals, the settings and the status points. Every test starts a
 * real backend with a temp data directory and the scripted provider, so the
 * assertions only read HTTP responses and the database's row counts.
 */

interface WorkspaceFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startWorkspaceFixture(
  prefix: string,
  options: { env?: NodeJS.ProcessEnv } = {},
): Promise<WorkspaceFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'reply'],
    env: options.env,
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

async function getWorkspace(fixture: WorkspaceFixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/workspace`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function postJson(
  fixture: WorkspaceFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(
  fixture: WorkspaceFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(fixture: WorkspaceFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createChannel(fixture: WorkspaceFixture, name: string): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: WorkspaceFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: WorkspaceFixture,
  targetId: string,
  body: string,
): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

async function createTask(
  fixture: WorkspaceFixture,
  channelId: string,
  title: string,
): Promise<Record<string, unknown>> {
  const created = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(created.status, 201, await created.clone().text());
  return await readJson(created);
}

function queryDatabase<T>(
  dataDir: string,
  sql: string,
  params: unknown[] = [],
): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

test('GET /api/workspace returns the complete reading in a fresh workspace', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-fresh-');
  try {
    const workspace = await getWorkspace(fixture);

    assert.deepEqual(
      Object.keys(workspace).sort(),
      [
        'owner',
        'agents',
        'channels',
        'dms',
        'tasks',
        'unread_total',
        'unread_by_target',
        'settings',
        'status_points',
      ].sort(),
    );

    const owner = workspace['owner'] as Record<string, unknown>;
    assert.equal(owner['kind'], 'owner', 'the owner is one row, not a list');
    assert.equal(owner['display_name'], '我');
    assert.equal(owner['avatar_slot'], 0);

    assert.deepEqual(workspace['agents'], [], 'a fresh workspace has no local Agents');
    assert.deepEqual(workspace['channels'], []);
    assert.deepEqual(workspace['dms'], []);
    assert.deepEqual(workspace['tasks'], []);
    assert.equal(workspace['unread_total'], 0);
    assert.deepEqual(workspace['unread_by_target'], {});
    assert.deepEqual(workspace['settings'], {
      locale: 'zh-CN',
      density: 'comfortable',
      theme: 'system',
    });
    assert.deepEqual(workspace['status_points'], {});
  } finally {
    await fixture.stop();
  }
});

test('the reading carries every live Agent, archived channels, DMs and the task board', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-shape-');
  try {
    const first = await createAgent(fixture, '甲');
    const second = await createAgent(fixture, '乙');
    const activeChannel = await createChannel(fixture, '活跃频道');
    const archivedChannel = await createChannel(fixture, '归档频道');
    await joinChannel(fixture, activeChannel, first);
    await joinChannel(fixture, activeChannel, second);

    const dmCreated = await postJson(fixture, '/api/dms', { agent_id: first });
    assert.equal(dmCreated.status, 201, await dmCreated.clone().text());
    const dmId = (await readJson(dmCreated))['id'] as string;

    const activeTask = await createTask(fixture, activeChannel, '活跃任务');
    const archivedTask = await createTask(fixture, archivedChannel, '归档任务');

    const archived = await postJson(fixture, `/api/channels/${archivedChannel}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());

    const workspace = await getWorkspace(fixture);

    const agents = workspace['agents'] as Record<string, unknown>[];
    assert.deepEqual(
      agents.map((agent) => agent['id']),
      [first, second],
      'the local Agent list is every live Agent, independent of channel membership',
    );
    for (const agent of agents) {
      assert.equal(agent['kind'], 'agent');
      assert.equal(typeof agent['display_name'], 'string');
      assert.equal(typeof agent['avatar_slot'], 'number');
      assert.equal(typeof agent['status'], 'string');
      assert.equal(agent['credential_status'], 'missing');
    }

    const channels = workspace['channels'] as Record<string, unknown>[];
    assert.deepEqual(
      channels.map((channel) => channel['id']),
      [activeChannel, archivedChannel],
      'archived channels stay in the reading and deleted ones do not',
    );
    assert.equal(channels[0]!['archived_at'], null);
    assert.equal(typeof channels[1]!['archived_at'], 'string');
    assert.equal(channels[1]!['deleted_at'], null);

    const dms = workspace['dms'] as Record<string, unknown>[];
    assert.equal(dms.length, 1);
    assert.equal(dms[0]!['id'], dmId);
    const peer = dms[0]!['peer'] as Record<string, unknown>;
    assert.equal(peer['id'], first);
    assert.equal(peer['deleted_at'], null);

    const tasks = workspace['tasks'] as Record<string, unknown>[];
    assert.deepEqual(
      tasks.map((task) => task['id']),
      [activeTask['id'], archivedTask['id']],
      'an archived channel keeps its tasks on the board',
    );
    for (const task of tasks) {
      assert.deepEqual(task['allowed_transitions'], ['in_progress']);
      assert.equal(task['unread_count'], 0);
      assert.equal(task['message_count'], 1, 'the opening system record is the thread’s only row');
    }

    const points = workspace['status_points'] as Record<string, Record<string, unknown>>;
    assert.deepEqual(Object.keys(points).sort(), [first, second].sort());
    for (const agent of agents) {
      assert.deepEqual(points[agent['id'] as string], {
        status: agent['status'],
        offline_reason: agent['offline_reason'],
      });
    }
  } finally {
    await fixture.stop();
  }
});

test('unread_total counts channel and dm turns, never the owner, system records or a task thread', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-unread-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channel = await createChannel(fixture, '有 Agent 的频道');
    const ownerOnly = await createChannel(fixture, '只有我的频道');
    await joinChannel(fixture, channel, agent);

    // The owner's own message is not its own unread.
    await postMessage(fixture, ownerOnly, '只是我说');
    let workspace = await getWorkspace(fixture);
    assert.equal(workspace['unread_total'], 0);
    assert.deepEqual(workspace['unread_by_target'], { [ownerOnly]: 0, [channel]: 0 });

    // The Agent's reply is the turn that raises the badge.
    await postMessage(fixture, channel, '频道里的一句');
    workspace = await getWorkspace(fixture);
    assert.equal(workspace['unread_total'], 1);
    assert.deepEqual(workspace['unread_by_target'], { [ownerOnly]: 0, [channel]: 1 });

    // Task creation writes two system records (thread opening + channel
    // pointer); system records never raise the badge.
    const task = await createTask(fixture, channel, '任务读数');
    workspace = await getWorkspace(fixture);
    assert.equal(workspace['unread_total'], 1);
    assert.equal((workspace['unread_by_target'] as Record<string, number>)[channel], 1);

    const assigned = await patchJson(fixture, `/api/tasks/${task['id'] as string}`, {
      assignee_member_id: agent,
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());

    // A task-thread turn belongs to the task payload's unread_count; it never
    // enters unread_total or unread_by_target.
    await postMessage(fixture, task['target_id'] as string, '任务线程里的一句');
    workspace = await getWorkspace(fixture);
    const tasks = workspace['tasks'] as Record<string, unknown>[];
    const taskReading = tasks.find((row) => row['id'] === task['id']);
    assert.equal(taskReading?.['unread_count'], 1);
    assert.equal(workspace['unread_total'], 1);
    assert.equal(
      Object.hasOwn(
        workspace['unread_by_target'] as Record<string, number>,
        task['target_id'] as string,
      ),
      false,
      'a task target is not part of the channel + dm totals',
    );
  } finally {
    await fixture.stop();
  }
});

test('status points and settings match their dedicated reads, and no secret reaches the snapshot', async () => {
  const credential = 'sk-workspace-secret-value';
  const fixture = await startWorkspaceFixture('allibot-workspace-consistency-', {
    env: { OPENAI_API_KEY: credential },
  });
  try {
    const modelAgent = await createAgent(fixture, '有模型');
    const bareCreated = await postJson(fixture, '/api/agents', { display_name: '无模型' });
    assert.equal(bareCreated.status, 201, await bareCreated.clone().text());
    const bareAgent = (await readJson(bareCreated))['id'] as string;

    // The per-Agent read is the reference: the workspace status point must
    // answer the same four-state fact for the same member.
    for (const agentId of [modelAgent, bareAgent]) {
      const detailResponse = await fetch(`${fixture.base}/api/agents/${agentId}`);
      assert.equal(detailResponse.status, 200, await detailResponse.clone().text());
      const detail = await readJson(detailResponse);
      const workspace = await getWorkspace(fixture);
      const points = workspace['status_points'] as Record<string, Record<string, unknown>>;
      assert.deepEqual(points[agentId], {
        status: detail['status'],
        offline_reason: detail['offline_reason'],
      });
    }

    const workspaceWithAgents = await getWorkspace(fixture);
    const points = workspaceWithAgents['status_points'] as Record<string, Record<string, unknown>>;
    assert.equal(points[modelAgent]?.['status'], 'offline');
    assert.equal(points[modelAgent]?.['offline_reason'], 'consent-missing');
    assert.equal(points[bareAgent]?.['status'], 'offline');
    assert.equal(points[bareAgent]?.['offline_reason'], 'model-missing');

    // Settings are the same body `GET /api/settings` returns.
    const patched = await patchJson(fixture, '/api/settings', {
      density: 'compact',
      theme: 'dark',
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    const settingsResponse = await fetch(`${fixture.base}/api/settings`);
    assert.equal(settingsResponse.status, 200, await settingsResponse.clone().text());
    const settings = await readJson(settingsResponse);
    const workspace = await getWorkspace(fixture);
    assert.deepEqual(workspace['settings'], settings);
    assert.deepEqual(workspace['settings'], {
      locale: 'zh-CN',
      density: 'compact',
      theme: 'dark',
    });

    // The owner is one row: an object, not a list, and exactly one such row
    // exists in the store.
    const owner = workspace['owner'] as Record<string, unknown>;
    assert.equal(Array.isArray(workspace['owner']), false);
    const stored = queryDatabase<{ id: string; total: number }>(
      fixture.dataDir,
      "SELECT id, (SELECT count(*) FROM member WHERE kind = 'owner') AS total FROM member WHERE kind = 'owner'",
    );
    assert.equal(stored?.total, 1);
    assert.equal(owner['id'], stored?.id);

    // The credential's value and any attachment storage path must never reach
    // the human face; only status enums do.
    const serialized = JSON.stringify(workspace);
    assert.equal(serialized.includes(credential), false, 'the credential value must not leak');
    assert.equal(serialized.includes('storage_path'), false);
    assert.equal(serialized.includes('ANTHROPIC_API_KEY'), false);
    const agents = workspace['agents'] as Record<string, unknown>[];
    assert.equal(
      agents.find((agent) => agent['id'] === modelAgent)?.['credential_status'],
      'present',
      'only the credential status travels, never the value',
    );
  } finally {
    await fixture.stop();
  }
});

test('two readings with no write in between are identical and leave the usage tables untouched', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-readonly-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channel = await createChannel(fixture, '只读频道');
    await joinChannel(fixture, channel, agent);
    await postMessage(fixture, channel, '会触发一轮');
    const dmCreated = await postJson(fixture, '/api/dms', { agent_id: agent });
    assert.equal(dmCreated.status, 201, await dmCreated.clone().text());
    await postMessage(fixture, (await readJson(dmCreated))['id'] as string, '私信一轮');
    const task = await createTask(fixture, channel, '只读任务');
    await patchJson(fixture, `/api/tasks/${task['id'] as string}`, {
      assignee_member_id: agent,
    });
    await postMessage(fixture, task['target_id'] as string, '任务一轮');

    const countRows = (table: string): number =>
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        `SELECT count(*) AS total FROM ${table}`,
      )?.total ?? -1;
    const before = {
      message: countRows('message'),
      round_outcome: countRows('round_outcome'),
      target_budget: countRows('target_budget'),
    };
    assert.ok(before.message > 0, 'the fixture should have written messages');
    assert.ok(before.round_outcome > 0, 'the fixture should have closed rounds');

    const first = await getWorkspace(fixture);
    const second = await getWorkspace(fixture);
    assert.deepEqual(second, first, 'the reading is a pure read of the same facts');

    assert.deepEqual(
      {
        message: countRows('message'),
        round_outcome: countRows('round_outcome'),
        target_budget: countRows('target_budget'),
      },
      before,
      'reading the workspace writes no message, round outcome or budget row',
    );
  } finally {
    await fixture.stop();
  }
});

test('an archived channel keeps its own reading but leaves the total; a deleted channel leaves the reading', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-archive-');
  try {
    const agent = await createAgent(fixture, '甲');
    const archivedChannel = await createChannel(fixture, '归档频道');
    const deletedChannel = await createChannel(fixture, '删除频道');
    await joinChannel(fixture, archivedChannel, agent);
    await joinChannel(fixture, deletedChannel, agent);
    await postMessage(fixture, archivedChannel, '归档里的一句');
    await postMessage(fixture, deletedChannel, '删除前的一句');
    const deletedTask = await createTask(fixture, deletedChannel, '随频道删除的任务');

    const archived = await postJson(fixture, `/api/channels/${archivedChannel}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());
    const deleted = await fetch(`${fixture.base}/api/channels/${deletedChannel}`, {
      method: 'DELETE',
    });
    assert.equal(deleted.status, 204);

    // A soft-deleted Agent leaves the local Agent list and the status points.
    const removedAgent = await createAgent(fixture, '被删除的 Agent');
    const removed = await fetch(`${fixture.base}/api/agents/${removedAgent}`, {
      method: 'DELETE',
    });
    assert.equal(removed.status, 204);

    const workspace = await getWorkspace(fixture);

    const channels = workspace['channels'] as Record<string, unknown>[];
    assert.deepEqual(
      channels.map((channel) => channel['id']),
      [archivedChannel],
      'the archived channel stays; the deleted one is absent',
    );
    assert.equal(typeof channels[0]!['archived_at'], 'string');

    // The archived channel keeps its own unread reading but is out of the
    // badge total; the deleted channel is out of both.
    assert.equal(workspace['unread_total'], 0);
    assert.deepEqual(workspace['unread_by_target'], { [archivedChannel]: 1 });

    const tasks = workspace['tasks'] as Record<string, unknown>[];
    assert.equal(
      tasks.some((task) => task['id'] === deletedTask['id']),
      false,
      'a deleted channel’s task is not part of the board reading',
    );

    const agents = workspace['agents'] as Record<string, unknown>[];
    assert.equal(agents.some((row) => row['id'] === removedAgent), false);
    const points = workspace['status_points'] as Record<string, unknown>;
    assert.equal(Object.hasOwn(points, removedAgent), false);
  } finally {
    await fixture.stop();
  }
});
