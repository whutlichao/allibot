import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
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

interface MessageFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
  stopServer: () => Promise<void>;
}

const CHANNEL_BODY = {
  name: '消息频道',
  description: '消息写读路径',
  mode: 'autonomous',
  response_budget_limit: 3,
};

async function startMessageFixture(prefix: string): Promise<MessageFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir);
  return {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stopServer: async () => {
      await running.stop();
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
  fixture: MessageFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: MessageFixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: MessageFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function listMessages(
  fixture: MessageFixture,
  targetId: string,
  query = '',
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

test('POST messages allocates 1, 2, 3 per target and repeats the same id for one client_message_id', async () => {
  const fixture = await startMessageFixture('allibot-messages-seq-');
  try {
    const channelId = await createChannel(fixture);

    for (const [index, body] of ['第一条', '第二条', '第三条'].entries()) {
      const response = await postJson(fixture, `/api/targets/${channelId}/messages`, { body });
      assert.equal(response.status, 201, await response.clone().text());
      const created = await readJson(response);
      assert.deepEqual(Object.keys(created).sort(), ['id', 'seq'], 'the write answers id and seq');
      assert.equal(created['seq'], index + 1, 'seq starts at 1 and grows by one inside the target');
    }

    const repeated = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '第一条',
      client_message_id: 'client-1',
    });
    assert.equal(repeated.status, 201, await repeated.clone().text());
    const first = await readJson(repeated);
    const replay = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '第一条（重发）',
      client_message_id: 'client-1',
    });
    assert.equal(replay.status, 201, await replay.clone().text());
    const second = await readJson(replay);
    assert.equal(second['id'], first['id'], 'the same client_message_id resolves to the same message');
    assert.equal(second['seq'], first['seq']);
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM message WHERE client_message_id = ?',
        ['client-1'],
      )?.total,
      1,
      'a replayed client_message_id inserts exactly one row',
    );

    // A second target numbers its own messages from 1: seq is target scoped.
    const otherChannelId = await createChannel(fixture);
    const otherFirst = await postJson(fixture, `/api/targets/${otherChannelId}/messages`, {
      body: '另一个频道的第一条',
    });
    assert.equal((await readJson(otherFirst))['seq'], 1);

    const owner = queryDatabase<{ id: string; display_name: string; avatar_slot: number }>(
      fixture.dataDir,
      "SELECT id, display_name, avatar_slot FROM member WHERE kind = 'owner'",
    );
    assert.ok(owner !== undefined);
    const stored = queryDatabase<{
      kind: string;
      author_member_id: string;
      author_display_name: string;
      author_avatar_slot: number;
      target_id: string;
    }>(
      fixture.dataDir,
      'SELECT kind, author_member_id, author_display_name, author_avatar_slot, target_id FROM message WHERE id = ?',
      [first['id']],
    );
    assert.deepEqual(stored, {
      kind: 'human',
      author_member_id: owner.id,
      author_display_name: owner.display_name,
      author_avatar_slot: owner.avatar_slot,
      target_id: channelId,
    });

    const unknown = await postJson(fixture, '/api/targets/does-not-exist/messages', { body: 'x' });
    assert.equal(unknown.status, 404);
    assert.equal(errorCode(await readJson(unknown)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('GET messages pages by after_seq and returns mention ranges that survive a member rename', async () => {
  const fixture = await startMessageFixture('allibot-messages-read-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture, '李四');

    const first = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '@李四 请看一下',
    });
    assert.equal(first.status, 201, await first.clone().text());
    for (const body of ['第二条', '第三条']) {
      assert.equal((await postJson(fixture, `/api/targets/${channelId}/messages`, { body })).status, 201);
    }

    const page = await listMessages(fixture, channelId, '?after_seq=1&limit=10');
    assert.deepEqual(
      page.map((message) => message['seq']),
      [2, 3],
      'after_seq is exclusive and the list is ordered by seq',
    );

    const all = await listMessages(fixture, channelId);
    assert.deepEqual(all.map((message) => message['seq']), [1, 2, 3]);
    const withMention = all[0];
    assert.ok(withMention !== undefined);
    assert.deepEqual(withMention['mentions'], [{ member_id: agentId, start: 0, end: 3 }]);
    assert.deepEqual(withMention['attachments'], [], 'the attachment metadata is an empty array');
    assert.equal(withMention['kind'], 'human');
    assert.equal(withMention['author_display_name'], '我');
    assert.equal(withMention['task_ref'], null);
    assert.equal(withMention['task_pointer'], null);
    assert.equal(withMention['client_message_id'], null);
    assert.ok(!JSON.stringify(all).includes('storage_path'), 'the read path never exposes storage_path');

    const limited = await listMessages(fixture, channelId, '?limit=2');
    assert.deepEqual(limited.map((message) => message['seq']), [1, 2], 'limit caps the page');

    const renamed = await fetch(`${fixture.base}/api/agents/${agentId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ display_name: '李四改名' }),
    });
    assert.equal(renamed.status, 200, await renamed.clone().text());

    const afterRename = await listMessages(fixture, channelId, '?after_seq=0');
    const mention = (afterRename[0]?.['mentions'] as Record<string, unknown>[])[0];
    assert.deepEqual(
      mention,
      { member_id: agentId, start: 0, end: 3 },
      'renaming a member neither rewrites the range nor the member id',
    );

    const badAfter = await fetch(`${fixture.base}/api/targets/${channelId}/messages?after_seq=-1`);
    assert.equal(badAfter.status, 400);
    assert.equal(errorCode(await readJson(badAfter)), 'validation_failed');
    const badLimit = await fetch(`${fixture.base}/api/targets/${channelId}/messages?limit=0`);
    assert.equal(badLimit.status, 400);
    assert.equal(errorCode(await readJson(badLimit)), 'validation_failed');

    const unknownTarget = await fetch(`${fixture.base}/api/targets/does-not-exist/messages`);
    assert.equal(unknownTarget.status, 404);
    assert.equal(errorCode(await readJson(unknownTarget)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('mention parsing is leftmost-longest, exact-name and ASCII left-boundary aware', async () => {
  const fixture = await startMessageFixture('allibot-messages-mentions-');
  try {
    const channelId = await createChannel(fixture);
    const zhangSan = await createAgent(fixture, '张三');
    const zhangSanFeng = await createAgent(fixture, '张三丰');
    const designer = await createAgent(fixture, '前端 设计师');
    const owner = queryDatabase<{ id: string }>(
      fixture.dataDir,
      "SELECT id FROM member WHERE kind = 'owner'",
    );
    assert.ok(owner !== undefined);

    const cases: { body: string; expected: { member_id: string; start: number; end: number }[] }[] = [
      {
        body: '@张三 你好',
        expected: [{ member_id: zhangSan, start: 0, end: 3 }],
      },
      {
        body: '  @张三 前有空白',
        expected: [{ member_id: zhangSan, start: 0, end: 3 }],
      },
      {
        body: 'x@张三 不算提及',
        expected: [],
      },
      {
        body: '你好@张三',
        expected: [{ member_id: zhangSan, start: 2, end: 5 }],
      },
      {
        body: '@张三丰 最左最长',
        expected: [{ member_id: zhangSanFeng, start: 0, end: 4 }],
      },
      {
        body: '@"前端设计师" 名字不相等',
        expected: [],
      },
      {
        body: '@前端 设计师 裸形式遇空格即止',
        expected: [],
      },
      {
        body: '@"前端 设计师" 在吗',
        expected: [{ member_id: designer, start: 0, end: 9 }],
      },
      {
        body: '@“前端 设计师” 也要认',
        expected: [{ member_id: designer, start: 0, end: 9 }],
      },
      {
        body: '@‘前端 设计师’ 也要认',
        expected: [{ member_id: designer, start: 0, end: 9 }],
      },
      {
        body: '@我 是 owner',
        expected: [{ member_id: owner.id, start: 0, end: 2 }],
      },
      {
        body: '@不存在的人 不是提及',
        expected: [],
      },
    ];

    for (const { body, expected } of cases) {
      const response = await postJson(fixture, `/api/targets/${channelId}/messages`, { body });
      assert.equal(response.status, 201, `${body}: ${await response.clone().text()}`);
      const id = (await readJson(response))['id'];
      assert.deepEqual(
        queryAll<{ member_id: string; start: number; end: number }>(
          fixture.dataDir,
          'SELECT member_id, start, "end" FROM message_mention WHERE message_id = ? ORDER BY start',
          [id],
        ),
        expected,
        `mentions for ${body}`,
      );
    }

    // A candidate token longer than every member name is not a prefix match.
    const longer = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '@张三丰茂 不是提及',
    });
    assert.deepEqual(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM message_mention WHERE message_id = ?',
        [(await readJson(longer))['id']],
      )?.total,
      0,
    );

    await fetch(`${fixture.base}/api/agents/${zhangSan}`, { method: 'DELETE' });
    const deleted = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '@张三 还会命中吗',
    });
    assert.deepEqual(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM message_mention WHERE message_id = ?',
        [(await readJson(deleted))['id']],
      )?.total,
      0,
      'a soft-deleted member is not an mention candidate',
    );
  } finally {
    await fixture.stop();
  }
});

test('archived channels refuse message writes, deleted channels read as not found, system kind is refused', async () => {
  const fixture = await startMessageFixture('allibot-messages-guards-');
  try {
    const channelId = await createChannel(fixture);
    assert.equal(
      (await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '归档前' })).status,
      201,
    );

    const system = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '系统事件',
      kind: 'system',
    });
    assert.equal(system.status, 400, 'the human face cannot write a system event message');
    assert.equal(errorCode(await readJson(system)), 'validation_failed');

    const agentKind = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '冒充 Agent',
      kind: 'agent',
    });
    assert.equal(agentKind.status, 400, 'the human face cannot write an agent message');
    assert.equal(errorCode(await readJson(agentKind)), 'validation_failed');

    const backendField = await postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '带指针',
      task_pointer: 'task-1',
    });
    assert.equal(backendField.status, 400, 'task references are backend facts');
    assert.equal(errorCode(await readJson(backendField)), 'validation_failed');

    const empty = await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '   ' });
    assert.equal(empty.status, 400);
    assert.equal(errorCode(await readJson(empty)), 'validation_failed');

    assert.equal((await postJson(fixture, `/api/channels/${channelId}/archive`, {})).status, 200);
    const archived = await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '归档后' });
    assert.equal(archived.status, 400);
    assert.equal(errorCode(await readJson(archived)), 'validation_failed');
    const archivedRead = await listMessages(fixture, channelId);
    assert.deepEqual(archivedRead.map((message) => message['seq']), [1], 'history stays readable');
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM message WHERE target_id = ?',
        [channelId],
      )?.total,
      1,
      'a refused write leaves the message count alone',
    );

    assert.equal((await fetch(`${fixture.base}/api/channels/${channelId}`, { method: 'DELETE' })).status, 204);
    const deletedWrite = await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '删除后' });
    assert.equal(deletedWrite.status, 404);
    assert.equal(errorCode(await readJson(deletedWrite)), 'not_found');
    const deletedRead = await fetch(`${fixture.base}/api/targets/${channelId}/messages`);
    assert.equal(deletedRead.status, 404);
    assert.equal(errorCode(await readJson(deletedRead)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('the message table rejects UPDATE and DELETE and backstops duplicate seq with the unique index', async () => {
  const fixture = await startMessageFixture('allibot-messages-append-only-');
  try {
    const channelId = await createChannel(fixture);
    assert.equal(
      (await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '不可改' })).status,
      201,
    );
    await fixture.stopServer();

    const dbPath = path.join(fixture.dataDir, 'allibot.db');
    const sql = (statement: string): { status: number | null; stderr: string } => {
      const result = spawnSync('sqlite3', [dbPath, statement], { encoding: 'utf8' });
      return { status: result.status, stderr: `${result.stdout}${result.stderr}` };
    };

    const update = sql(`update message set body="x"`);
    assert.notEqual(update.status, 0, 'the update trigger aborts');
    assert.match(update.stderr, /append-only/i);

    const remove = sql('delete from message');
    assert.notEqual(remove.status, 0, 'the delete trigger aborts');
    assert.match(remove.stderr, /append-only/i);

    const duplicate = sql(
      `INSERT INTO message
         (id, target_id, seq, kind, author_member_id, author_display_name, author_avatar_slot,
          body, created_at, task_ref, task_pointer, client_message_id)
       SELECT 'duplicate', target_id, seq, kind, author_member_id, author_display_name,
              author_avatar_slot, body, created_at, task_ref, task_pointer, NULL
         FROM message LIMIT 1`,
    );
    assert.notEqual(duplicate.status, 0, 'a duplicate (target_id, seq) is rejected');
    assert.match(duplicate.stderr, /UNIQUE|constraint/i);

    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM message WHERE target_id = ?',
        [channelId],
      )?.total,
      1,
      'the message row count is unchanged',
    );
  } finally {
    await fixture.stop();
  }
});
