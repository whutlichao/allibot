import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  REPO_ROOT,
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

interface TaskFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

const MEMBER_FACE_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'task-member-face.mjs');

const CHANNEL_BODY = {
  name: '任务频道',
  description: '任务与任务线程',
  mode: 'autonomous',
  response_budget_limit: 3,
};

async function startTaskFixture(prefix: string): Promise<TaskFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  let running = await startServer(dataDir);
  return {
    dataDir,
    get running() {
      return running;
    },
    get base() {
      return `http://127.0.0.1:${running.port}`;
    },
    restart: async () => {
      await running.stop();
      running = await startServer(dataDir);
    },
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

function queryAll<T>(dataDir: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: TaskFixture,
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
  fixture: TaskFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(
  fixture: TaskFixture,
  body: Record<string, unknown> = CHANNEL_BODY,
): Promise<string> {
  const created = await postJson(fixture, '/api/channels', body);
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: TaskFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createTask(
  fixture: TaskFixture,
  channelId: string,
  title: string,
): Promise<Record<string, unknown>> {
  const created = await postJson(fixture, '/api/tasks', { channel_id: channelId, title });
  assert.equal(created.status, 201, await created.clone().text());
  return await readJson(created);
}

async function getTask(fixture: TaskFixture, id: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/tasks/${id}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function listMessages(
  fixture: TaskFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

test('POST /api/tasks creates the task row, the task target and exactly one channel pointer in one transaction', async () => {
  const fixture = await startTaskFixture('allibot-tasks-create-');
  try {
    const channelId = await createChannel(fixture);
    const created = await createTask(fixture, channelId, '整理需求文档');

    assert.equal(created['channel_id'], channelId);
    assert.equal(created['title'], '整理需求文档');
    assert.equal(created['status'], 'todo');
    assert.equal(created['assignee_member_id'], null);
    assert.deepEqual(created['allowed_transitions'], ['in_progress']);
    assert.equal(created['message_count'], 1, 'the task thread starts with one system message');
    assert.equal(created['unread_count'], 0, 'a system message never counts as unread');

    const taskId = created['id'] as string;
    const targetId = created['target_id'] as string;
    assert.ok(targetId.length > 0);

    const stored = queryDatabase<{ status: string; assignee_member_id: string | null; channel_id: string }>(
      fixture.dataDir,
      'SELECT status, assignee_member_id, channel_id FROM task WHERE id = ?',
      [taskId],
    );
    assert.deepEqual(stored, {
      status: 'todo',
      assignee_member_id: null,
      channel_id: channelId,
    });
    assert.equal(
      queryDatabase<{ kind: string }>(fixture.dataDir, 'SELECT kind FROM target WHERE id = ?', [
        targetId,
      ])?.kind,
      'task',
      'the task owns a target of kind task',
    );

    const pointers = queryAll<{ id: string; kind: string; target_id: string; task_pointer: string }>(
      fixture.dataDir,
      'SELECT id, kind, target_id, task_pointer FROM message WHERE task_pointer IS NOT NULL',
    );
    assert.equal(pointers.length, 1, 'a task has exactly one pointer message');
    assert.deepEqual(pointers[0], {
      id: pointers[0]?.id,
      kind: 'system',
      target_id: channelId,
      task_pointer: taskId,
    });
    assert.equal(
      queryAll(fixture.dataDir, 'SELECT id FROM message WHERE task_pointer = ?', [taskId]).length,
      1,
      'the pointer points at this task',
    );

    // The channel feed carries the pointer and the task thread carries its own
    // creation event; the two targets never share a message.
    const channelMessages = await listMessages(fixture, channelId);
    assert.deepEqual(channelMessages.map((message) => message['seq']), [1]);
    assert.equal(channelMessages[0]?.['task_pointer'], taskId);
    assert.equal(channelMessages[0]?.['kind'], 'system');

    const threadMessages = await listMessages(fixture, targetId);
    assert.deepEqual(threadMessages.map((message) => message['seq']), [1]);
    assert.equal(threadMessages[0]?.['kind'], 'system');
    assert.equal(threadMessages[0]?.['task_pointer'], null);
    assert.match(String(threadMessages[0]?.['body']), /整理需求文档/);

    // The pointer is a system event: it neither wakes nor counts as unread on
    // the channel, and the task thread has no human or agent message yet.
    const detail = await getTask(fixture, taskId);
    assert.equal(detail['unread_count'], 0);
  } finally {
    await fixture.stop();
  }
});

test('POST /api/tasks validates the channel, the title and the body shape without writing rows', async () => {
  const fixture = await startTaskFixture('allibot-tasks-create-guards-');
  try {
    const channelId = await createChannel(fixture);

    const unknownChannel = await postJson(fixture, '/api/tasks', {
      channel_id: 'does-not-exist',
      title: '任务',
    });
    assert.equal(unknownChannel.status, 404);
    assert.equal(errorCode(await readJson(unknownChannel)), 'not_found');

    const emptyTitle = await postJson(fixture, '/api/tasks', { channel_id: channelId, title: '   ' });
    assert.equal(emptyTitle.status, 400);
    assert.equal(errorCode(await readJson(emptyTitle)), 'validation_failed');

    const missingTitle = await postJson(fixture, '/api/tasks', { channel_id: channelId });
    assert.equal(missingTitle.status, 400);
    assert.equal(errorCode(await readJson(missingTitle)), 'validation_failed');

    const pointerField = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '任务',
      task_pointer: 'task-1',
    });
    assert.equal(pointerField.status, 400, 'the pointer is a backend fact, not a client field');
    assert.equal(errorCode(await readJson(pointerField)), 'validation_failed');

    assert.equal(
      queryAll(fixture.dataDir, 'SELECT id FROM task').length,
      0,
      'a rejected create writes no task row',
    );
    assert.equal(
      queryAll(fixture.dataDir, "SELECT id FROM target WHERE kind = 'task'").length,
      0,
      'a rejected create writes no task target',
    );
    assert.equal(
      queryAll(fixture.dataDir, 'SELECT id FROM message WHERE task_pointer IS NOT NULL').length,
      0,
      'a rejected create writes no pointer message',
    );
  } finally {
    await fixture.stop();
  }
});

test('GET /api/tasks lists the board payload and filters by channel; GET /api/tasks/{id} reads the detail', async () => {
  const fixture = await startTaskFixture('allibot-tasks-read-');
  try {
    const firstChannel = await createChannel(fixture);
    const secondChannel = await createChannel(fixture, {
      name: '另一个频道',
      mode: 'autonomous',
      response_budget_limit: 3,
    });
    const first = await createTask(fixture, firstChannel, '第一个任务');
    const second = await createTask(fixture, firstChannel, '第二个任务');
    const third = await createTask(fixture, secondChannel, '第三个任务');

    const listed = await fetch(`${fixture.base}/api/tasks`);
    assert.equal(listed.status, 200, await listed.clone().text());
    const tasks = (await readJson(listed))['tasks'] as Record<string, unknown>[];
    assert.deepEqual(
      tasks.map((task) => task['id']),
      [first['id'], second['id'], third['id']],
      'the board lists every live task in creation order',
    );
    for (const task of tasks) {
      assert.deepEqual(Object.keys(task).sort(), [
        'allowed_transitions',
        'assignee_member_id',
        'channel_id',
        'claimed_at',
        'created_at',
        'id',
        'message_count',
        'status',
        'target_id',
        'title',
        'unread_count',
        'updated_at',
      ]);
    }

    const filtered = await fetch(`${fixture.base}/api/tasks?channel_id=${secondChannel}`);
    assert.equal(filtered.status, 200, await filtered.clone().text());
    const filteredTasks = (await readJson(filtered))['tasks'] as Record<string, unknown>[];
    assert.deepEqual(filteredTasks.map((task) => task['id']), [third['id']]);

    const badFilter = await fetch(`${fixture.base}/api/tasks?channel_id=`);
    assert.equal(badFilter.status, 400);

    const detail = await getTask(fixture, first['id'] as string);
    assert.equal(detail['title'], '第一个任务');
    assert.equal(detail['target_id'], first['target_id']);

    const missing = await fetch(`${fixture.base}/api/tasks/does-not-exist`);
    assert.equal(missing.status, 404);
    assert.equal(errorCode(await readJson(missing)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/tasks/{id} changes the title and appends one system message to the task thread only', async () => {
  const fixture = await startTaskFixture('allibot-tasks-title-');
  try {
    const channelId = await createChannel(fixture);
    const task = await createTask(fixture, channelId, '旧标题');
    const taskId = task['id'] as string;
    const targetId = task['target_id'] as string;

    const renamed = await patchJson(fixture, `/api/tasks/${taskId}`, { title: '新标题' });
    assert.equal(renamed.status, 200, await renamed.clone().text());
    const view = await readJson(renamed);
    assert.equal(view['title'], '新标题');
    assert.equal(view['message_count'], 2, 'the change appends one system message');
    assert.equal(view['status'], 'todo', 'a title change does not move the status');

    const thread = await listMessages(fixture, targetId);
    assert.equal(thread.length, 2);
    assert.equal(thread[1]?.['kind'], 'system');
    assert.match(String(thread[1]?.['body']), /新标题/);
    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['seq']),
      [1],
      'the channel feed is untouched by a task change',
    );

    const emptyTitle = await patchJson(fixture, `/api/tasks/${taskId}`, { title: ' ' });
    assert.equal(emptyTitle.status, 400);
    assert.equal(errorCode(await readJson(emptyTitle)), 'validation_failed');

    const unknownField = await patchJson(fixture, `/api/tasks/${taskId}`, { channel_id: channelId });
    assert.equal(unknownField.status, 400);
    assert.equal(errorCode(await readJson(unknownField)), 'validation_failed');

    const noFields = await patchJson(fixture, `/api/tasks/${taskId}`, {});
    assert.equal(noFields.status, 400);

    const missing = await patchJson(fixture, '/api/tasks/does-not-exist', { title: 'x' });
    assert.equal(missing.status, 404);
    assert.equal(errorCode(await readJson(missing)), 'not_found');

    const afterRejected = await getTask(fixture, taskId);
    assert.equal(afterRejected['message_count'], 2, 'a rejected patch appends no message');
  } finally {
    await fixture.stop();
  }
});

test('the five-state machine is backend-fixed, reports allowed_transitions and refuses illegal moves', async () => {
  const fixture = await startTaskFixture('allibot-tasks-status-');
  try {
    const channelId = await createChannel(fixture);
    const task = await createTask(fixture, channelId, '状态机');
    const taskId = task['id'] as string;

    const skip = await patchJson(fixture, `/api/tasks/${taskId}`, { status: 'done' });
    assert.equal(skip.status, 400, 'todo -> done is not in the transition table');
    assert.equal(errorCode(await readJson(skip)), 'validation_failed');

    const unknown = await patchJson(fixture, `/api/tasks/${taskId}`, { status: 'doing' });
    assert.equal(unknown.status, 400);

    const expected: { from: string; to: string; allowed: string[] }[] = [
      { from: 'todo', to: 'in_progress', allowed: ['in_review'] },
      { from: 'in_progress', to: 'in_review', allowed: ['done'] },
      { from: 'in_review', to: 'done', allowed: ['closed'] },
      { from: 'done', to: 'closed', allowed: [] },
    ];
    for (const step of expected) {
      const moved = await patchJson(fixture, `/api/tasks/${taskId}`, { status: step.to });
      assert.equal(moved.status, 200, `${step.from} -> ${step.to}: ${await moved.clone().text()}`);
      const view = await readJson(moved);
      assert.equal(view['status'], step.to);
      assert.deepEqual(view['allowed_transitions'], step.allowed, `allowed_transitions at ${step.to}`);
    }

    const afterClosed = await patchJson(fixture, `/api/tasks/${taskId}`, { status: 'todo' });
    assert.equal(afterClosed.status, 400, 'closed is terminal');
    assert.equal(errorCode(await readJson(afterClosed)), 'validation_failed');

    const closedView = await getTask(fixture, taskId);
    assert.equal(closedView['status'], 'closed');
    assert.deepEqual(closedView['allowed_transitions'], []);
    assert.equal(closedView['message_count'], 5, 'creation plus four status events');

    // Every status change wrote one system message into the task thread.
    const thread = await listMessages(fixture, task['target_id'] as string);
    assert.equal(thread.length, 5);
    for (const message of thread) {
      assert.equal(message['kind'], 'system');
    }
  } finally {
    await fixture.stop();
  }
});

test('the assignee cannot approve its own in_review work; the owner and a non-assignee member can', async () => {
  const fixture = await startTaskFixture('allibot-tasks-review-');
  try {
    const channelId = await createChannel(fixture);
    const assigneeId = await createAgent(fixture, '受派 Agent');
    const reviewerId = await createAgent(fixture, '审阅 Agent');
    const task = await createTask(fixture, channelId, '需要审阅');
    const taskId = task['id'] as string;

    const assigned = await patchJson(fixture, `/api/tasks/${taskId}`, {
      assignee_member_id: assigneeId,
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());
    assert.equal((await readJson(assigned))['assignee_member_id'], assigneeId);

    const assignedMembers = queryAll<{ member_id: string }>(
      fixture.dataDir,
      'SELECT member_id FROM target_member WHERE target_id = ? ORDER BY rowid',
      [task['target_id']],
    );
    assert.ok(
      assignedMembers.some((row) => row.member_id === assigneeId),
      'the assignee is a member of the task target',
    );

    for (const status of ['in_progress', 'in_review']) {
      assert.equal(
        (await patchJson(fixture, `/api/tasks/${taskId}`, { status })).status,
        200,
        `owner moves the task to ${status}`,
      );
    }

    await fixture.restart();
    const input = {
      dataDir: fixture.dataDir,
      taskId,
      status: 'done',
    };
    const selfApproval = spawnSync(process.execPath, [MEMBER_FACE_FIXTURE, JSON.stringify({ ...input, memberId: assigneeId })], {
      encoding: 'utf8',
    });
    assert.equal(selfApproval.status, 0, `the fixture should run; ${selfApproval.stderr}`);
    assert.deepEqual(JSON.parse(selfApproval.stdout) as unknown, {
      ok: false,
      status: 409,
      code: 'conflict',
    });
    assert.equal((await getTask(fixture, taskId))['status'], 'in_review', 'the refused approval writes nothing');

    const nonAssignee = spawnSync(process.execPath, [MEMBER_FACE_FIXTURE, JSON.stringify({ ...input, memberId: reviewerId })], {
      encoding: 'utf8',
    });
    assert.equal(nonAssignee.status, 0, `the fixture should run; ${nonAssignee.stderr}`);
    assert.deepEqual(JSON.parse(nonAssignee.stdout) as unknown, { ok: true, status: 'done' });
    const approved = await getTask(fixture, taskId);
    assert.equal(approved['status'], 'done');
    assert.equal(
      approved['message_count'],
      5,
      'creation, assignment, two status moves and the member approval each wrote one system message',
    );

    const ownerApproval = await createTask(fixture, channelId, 'owner 自批');
    const ownerTaskId = ownerApproval['id'] as string;
    await patchJson(fixture, `/api/tasks/${ownerTaskId}`, { assignee_member_id: assigneeId });
    for (const status of ['in_progress', 'in_review', 'done']) {
      const response = await patchJson(fixture, `/api/tasks/${ownerTaskId}`, { status });
      assert.equal(response.status, 200, `the owner may approve ${status}`);
    }
  } finally {
    await fixture.stop();
  }
});

test('task thread speech stays in the task target and the channel feed keeps only its pointer', async () => {
  const fixture = await startTaskFixture('allibot-tasks-thread-');
  try {
    const channelId = await createChannel(fixture);
    const task = await createTask(fixture, channelId, '任务线程');
    const targetId = task['target_id'] as string;

    const spoken = await postJson(fixture, `/api/targets/${targetId}/messages`, {
      body: '任务线程里的发言',
    });
    assert.equal(spoken.status, 201, await spoken.clone().text());

    const thread = await listMessages(fixture, targetId);
    assert.deepEqual(thread.map((message) => message['kind']), ['system', 'human']);
    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['seq']),
      [1],
      'the channel never receives the thread message',
    );

    const detail = await getTask(fixture, task['id'] as string);
    assert.equal(detail['message_count'], 2);
    assert.equal(detail['unread_count'], 0, 'the owner’s own message is not unread for the owner');

    // A system message written by another member would count; the owner's own
    // human message does not.
    const agent = await createAgent(fixture, '线程 Agent');
    const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
    try {
      db.prepare(
        `INSERT INTO message
           (id, target_id, seq, kind, author_member_id, author_display_name, author_avatar_slot,
            body, created_at, task_ref, task_pointer, client_message_id)
         VALUES ('agent-message', ?,
                 (SELECT coalesce(MAX(seq), 0) + 1 FROM message WHERE target_id = ?),
                 'agent', ?, '线程 Agent', 1, 'Agent 的回复', ?, NULL, NULL, NULL)`,
      ).run(targetId, targetId, agent, new Date().toISOString());
    } finally {
      db.close();
    }
    assert.equal(
      (await getTask(fixture, task['id'] as string))['unread_count'],
      1,
      'unread counts human and agent messages the owner did not author',
    );
  } finally {
    await fixture.stop();
  }
});

test('an archived channel refuses new tasks but keeps existing tasks readable, mutable and writable in their thread', async () => {
  const fixture = await startTaskFixture('allibot-tasks-archived-');
  try {
    const channelId = await createChannel(fixture);
    const task = await createTask(fixture, channelId, '归档前的任务');
    const taskId = task['id'] as string;

    const archived = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());

    const createOnArchived = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '归档后的任务',
    });
    assert.equal(createOnArchived.status, 400);
    assert.equal(errorCode(await readJson(createOnArchived)), 'validation_failed');
    assert.equal(
      queryAll(fixture.dataDir, 'SELECT id FROM task').length,
      1,
      'the refused create writes no task row',
    );

    assert.equal((await getTask(fixture, taskId))['status'], 'todo');
    const moved = await patchJson(fixture, `/api/tasks/${taskId}`, { status: 'in_progress' });
    assert.equal(moved.status, 200, 'an archived channel still lets its tasks move');
    assert.equal(
      (await postJson(fixture, `/api/targets/${task['target_id']}/messages`, { body: '归档后仍可发言' }))
        .status,
      201,
      'the task thread stays writable',
    );

    const listed = await fetch(`${fixture.base}/api/tasks`);
    const tasks = (await readJson(listed))['tasks'] as Record<string, unknown>[];
    assert.deepEqual(tasks.map((entry) => entry['id']), [taskId], 'archived tasks stay on the board');
  } finally {
    await fixture.stop();
  }
});

test('a deleted channel answers 404 for new tasks and the board, while the task and its thread remain reachable by id', async () => {
  const fixture = await startTaskFixture('allibot-tasks-deleted-');
  try {
    const channelId = await createChannel(fixture);
    const task = await createTask(fixture, channelId, '删除频道前的任务');
    const taskId = task['id'] as string;

    assert.equal((await fetch(`${fixture.base}/api/channels/${channelId}`, { method: 'DELETE' })).status, 204);

    const createOnDeleted = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '删除后的任务',
    });
    assert.equal(createOnDeleted.status, 404);
    assert.equal(errorCode(await readJson(createOnDeleted)), 'not_found');

    const detail = await getTask(fixture, taskId);
    assert.equal(detail['title'], '删除频道前的任务');
    assert.equal(
      (await patchJson(fixture, `/api/tasks/${taskId}`, { status: 'in_progress' })).status,
      200,
      'the task keeps its own lifecycle after the channel is deleted',
    );
    assert.equal(
      (await postJson(fixture, `/api/targets/${task['target_id']}/messages`, { body: '线程仍可写' })).status,
      201,
    );

    const listed = await fetch(`${fixture.base}/api/tasks`);
    const tasks = (await readJson(listed))['tasks'] as Record<string, unknown>[];
    assert.deepEqual(tasks, [], 'a deleted channel leaves the task board');
    const filtered = await fetch(`${fixture.base}/api/tasks?channel_id=${channelId}`);
    assert.deepEqual((await readJson(filtered))['tasks'], []);
  } finally {
    await fixture.stop();
  }
});
