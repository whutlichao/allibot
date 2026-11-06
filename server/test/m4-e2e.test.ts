import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  REPO_ROOT,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * M4 端到端验收 (T6 / #88)：从空数据目录到第一条消息，只走一次 `serve`。
 *
 * 流程只穿 HTTP 面 —— 建 Agent、建频道、加入成员、发消息都是 REST 调用；静态
 * 宿主的静态根是仓库真实的 `web/dist`，不是测试注入的临时目录，所以「打开就有
 * 工作台」这一条用的是真实构建产物。模型是脚本化 provider，Docker 是
 * support.ts 注入的假 CLI，因此不碰真实网络、真实密钥与真实守护进程。
 *
 * 落库的核对只读打开数据库（m2-e2e 先例）：测试从不通过内部模块调用或后门写入
 * 数据，断言读到的都是 HTTP 面已经做完的事实。
 */

const AGENT_MODEL = 'openai:gpt-5';
const SCRIPTED_REPLY = '第一条消息的回复';
/** 真实构建产物：`GET /` 必须回的正是这个文件。 */
const REAL_INDEX_HTML = path.join(REPO_ROOT, 'web', 'dist', 'index.html');

interface HttpResult {
  status: number;
  text: string;
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
  const parsed: unknown = text.length === 0 ? {} : JSON.parse(text);
  assert.ok(typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed));
  return { status: response.status, text, body: parsed as Record<string, unknown> };
}

async function ok(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<Record<string, unknown>> {
  const result = await request(base, method, route, body);
  assert.ok(
    result.status >= 200 && result.status < 300,
    `${method} ${route} -> ${result.status}: ${result.text}`,
  );
  return result.body;
}

async function getJson(base: string, route: string): Promise<Record<string, unknown>> {
  return await ok(base, 'GET', route);
}

async function waitFor<T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  what: string,
  timeoutMs = 8_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) {
      return value;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${what} 超时；最后一次读到：${JSON.stringify(value)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function openDatabase(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true, timeout: 2_000 });
}

function queryAll<T>(db: Database.Database, sql: string, params: unknown[] = []): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

function queryOne<T>(db: Database.Database, sql: string, params: unknown[] = []): T | undefined {
  return queryAll<T>(db, sql, params)[0];
}

test('空库到第一条消息：一次 serve 里建 Agent、建频道、加成员，脚本化 provider 的回复落库', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'allibot-m4-e2e-'));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  let running: RunningServer | undefined;
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate 应退出 0；输出：${migration.output}`);

    running = await startServer(dataDir, {
      env: { HOME: home },
      args: ['--scripted-provider', 'reply', '--scripted-reply', SCRIPTED_REPLY],
    });
    const base = `http://127.0.0.1:${running.port}`;

    // 真静态根：页面就是仓库的 web/dist/index.html，不是页壳替身或 API 错误。
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200, await page.clone().text());
    assert.equal(page.headers.get('content-type'), 'text/html; charset=utf-8');
    const shell = await page.text();
    assert.equal(
      shell,
      readFileSync(REAL_INDEX_HTML, 'utf8'),
      'GET / 回的应是真实构建产物 web/dist/index.html 本身',
    );
    assert.match(shell, /id="root"/);

    // 空状态引导（D9）的资料来源：三处空状态读的就是 workspace 的这几个列表，
    // 刚 migrate 完它们必须真的为空，否则引导会指向一个已经有内容的列表。
    const empty = await getJson(base, '/api/workspace');
    assert.deepEqual(empty['channels'], []);
    assert.deepEqual(empty['agents'], []);
    assert.deepEqual(empty['dms'], []);
    assert.deepEqual(empty['tasks'], []);

    // 建 Agent → 建频道 → 加入成员：全程 REST，没有任何内部调用。
    const agent = await ok(base, 'POST', '/api/agents', {
      display_name: '一号助手',
      model: AGENT_MODEL,
    });
    const agentId = agent['id'] as string;
    assert.equal(agent['model'], AGENT_MODEL);

    const channel = await ok(base, 'POST', '/api/channels', {
      name: '第一个频道',
      description: '',
      response_budget_limit: 10,
    });
    const channelId = channel['id'] as string;

    const joined = await ok(base, 'POST', `/api/channels/${channelId}/members`, {
      member_id: agentId,
    });
    assert.equal(joined['joined'], true);

    // 频道就是它自己的 target（M1 的地址约定），发消息走 target 的消息面。
    const posted = await ok(base, 'POST', `/api/targets/${channelId}/messages`, {
      body: '你好，这是第一条消息',
    });
    assert.ok(typeof posted['id'] === 'string');
    assert.equal(typeof posted['seq'], 'number');

    // 轮次跑完：消息面读到人 + Agent 两条，Agent 那条正文是脚本化回复。
    const messages = await waitFor(
      async () => (await getJson(base, `/api/targets/${channelId}/messages`))['messages'] as Record<
        string,
        unknown
      >[],
      (rows) => rows.filter((row) => row['kind'] === 'agent').length === 1,
      '第一条消息触发的轮次回复',
    );
    assert.deepEqual(
      messages.map((row) => [row['kind'], row['body']]),
      [
        ['human', '你好，这是第一条消息'],
        ['agent', SCRIPTED_REPLY],
      ],
    );
    assert.equal(messages[1]?.['author_member_id'], agentId);

    // 落库核对：消息行与轮次结果都在，轮次结论是 replied。
    const db = openDatabase(dataDir);
    try {
      assert.deepEqual(
        queryAll<{ kind: string; body: string }>(
          db,
          'SELECT kind, body FROM message WHERE target_id = ? ORDER BY seq',
          [channelId],
        ).map((row) => [row.kind, row.body]),
        [
          ['human', '你好，这是第一条消息'],
          ['agent', SCRIPTED_REPLY],
        ],
      );
      const outcome = queryOne<{ member_id: string; target_id: string; status: string }>(
        db,
        'SELECT member_id, target_id, status FROM round_outcome WHERE target_id = ?',
        [channelId],
      );
      assert.equal(outcome?.status, 'replied');
      assert.equal(outcome?.member_id, agentId);
      assert.equal(outcome?.target_id, channelId);
    } finally {
      db.close();
    }
  } finally {
    if (running !== undefined) {
      await running.stop();
    }
    await removeTempDir(tmp);
  }
});
