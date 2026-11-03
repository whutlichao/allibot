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
 * 状态点 (Status Point) 的进程级验收（D1.12 / R1 词条 26）。
 *
 * 唯一 seam 是后端进程的 HTTP 面：每个用例都经临时数据目录与临时端口启动
 * 真实后端，用 `curl` 等价请求读状态点；数据目录里的 `round_outcome` 行只
 * 作为同一个后端事实的交叉核对（规格允许读数据目录的对外产物）。状态点
 * 从不从浏览器连接推导，所以这里也不建立任何 SSE 订阅。
 */

interface StatusFixture {
  dataDir: string;
  base: string;
  running: RunningServer;
}

interface StartOptions {
  env?: NodeJS.ProcessEnv;
  args?: readonly string[];
}

async function migrate(dataDir: string): Promise<void> {
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
}

async function startOn(dataDir: string, options: StartOptions = {}): Promise<StatusFixture> {
  const running = await startServer(dataDir, options);
  return { dataDir, base: `http://127.0.0.1:${running.port}`, running };
}

async function startStatusFixture(
  prefix: string,
  options: StartOptions = {},
): Promise<StatusFixture> {
  const dataDir = await makeTempDir(prefix);
  await migrate(dataDir);
  return await startOn(dataDir, options);
}

async function close(fixture: StatusFixture): Promise<void> {
  await fixture.running.stop();
  await removeTempDir(fixture.dataDir);
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: StatusFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(
  fixture: StatusFixture,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, '/api/agents', body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function getAgent(
  fixture: StatusFixture,
  id: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/agents/${id}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function confirmConsent(
  fixture: StatusFixture,
  provider: 'anthropic' | 'openai',
): Promise<void> {
  const response = await postJson(fixture, `/api/remote-data-flow/${provider}/consent`, {});
  assert.equal(response.status, 200, await response.clone().text());
}

async function createChannel(fixture: StatusFixture): Promise<string> {
  const response = await postJson(fixture, '/api/channels', {
    name: '状态点频道',
    description: '',
    mode: 'autonomous',
  });
  assert.equal(response.status, 201, await response.clone().text());
  return (await readJson(response))['id'] as string;
}

async function joinChannel(
  fixture: StatusFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const response = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function postMessage(
  fixture: StatusFixture,
  targetId: string,
  body: string,
): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

/** The member's latest non-merged round outcome, read from the data directory. */
function latestOutcomeStatus(dataDir: string, memberId: string): string | null {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT status FROM round_outcome
          WHERE member_id = ? AND status <> 'merged'
          ORDER BY rowid DESC
          LIMIT 1`,
      )
      .get(memberId) as { status: string } | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

async function waitForStatus(
  fixture: StatusFixture,
  agentId: string,
  expected: string,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const detail = await getAgent(fixture, agentId);
    if (detail['status'] === expected) {
      return detail;
    }
    if (Date.now() >= deadline) {
      assert.fail(`status did not become ${expected} in ${timeoutMs}ms: ${JSON.stringify(detail)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test('an Agent without a model is offline for the model-missing reason', async () => {
  const fixture = await startStatusFixture('allibot-status-model-missing-');
  try {
    const created = await createAgent(fixture, { display_name: '无模型' });
    assert.equal(created['model'], null);

    const detail = await getAgent(fixture, String(created['id']));
    assert.equal(detail['status'], 'offline');
    assert.equal(detail['offline_reason'], 'model-missing');
  } finally {
    await close(fixture);
  }
});

test('a configured model with no credential is offline for credential-missing', async () => {
  // The test harness strips the developer's provider credentials, so this
  // process really has no ANTHROPIC_API_KEY.
  const fixture = await startStatusFixture('allibot-status-credential-missing-');
  try {
    const created = await createAgent(fixture, {
      display_name: '缺凭证',
      model: 'anthropic:claude-sonnet-4-5',
    });
    await confirmConsent(fixture, 'anthropic');

    const detail = await getAgent(fixture, String(created['id']));
    assert.equal(detail['status'], 'offline');
    assert.equal(detail['offline_reason'], 'credential-missing');
  } finally {
    await close(fixture);
  }
});

test('an unconfirmed remote data flow keeps the Agent offline without exposing the key', async () => {
  const secret = 'sk-status-consent-secret';
  const fixture = await startStatusFixture('allibot-status-consent-missing-', {
    env: { OPENAI_API_KEY: secret },
  });
  try {
    const created = await createAgent(fixture, {
      display_name: '未告知',
      model: 'openai:gpt-5',
    });

    // A plain curl-shaped GET, with no browser or subscription involved.
    const response = await fetch(`${fixture.base}/api/agents/${String(created['id'])}`);
    assert.equal(response.status, 200);
    const text = await response.text();
    const detail = JSON.parse(text) as Record<string, unknown>;
    assert.equal(detail['status'], 'offline');
    assert.equal(detail['offline_reason'], 'consent-missing');
    assert.ok(!text.includes(secret), 'the status point never carries the credential');
  } finally {
    await close(fixture);
  }
});

test('a configured, credentialed, consented Agent is online and the list agrees', async () => {
  const fixture = await startStatusFixture('allibot-status-online-', {
    env: { ANTHROPIC_API_KEY: 'sk-status-online-secret' },
  });
  try {
    const created = await createAgent(fixture, {
      display_name: '在线',
      model: 'anthropic:claude-sonnet-4-5',
    });
    await confirmConsent(fixture, 'anthropic');

    const detail = await getAgent(fixture, String(created['id']));
    assert.equal(detail['status'], 'online');
    assert.equal(detail['offline_reason'], null);
    assert.equal(
      detail['avatar_slot'],
      created['avatar_slot'],
      'the status point never moves the visual avatar slot',
    );

    const list = await readJson(await fetch(`${fixture.base}/api/agents`));
    const listed = (list['agents'] as Record<string, unknown>[]).find(
      (agent) => agent['id'] === created['id'],
    );
    assert.ok(listed !== undefined, 'the Agent is listed');
    assert.deepEqual(
      [listed['status'], listed['offline_reason']],
      ['online', null],
      'the Agent list reads the same status point fact as the detail',
    );
  } finally {
    await close(fixture);
  }
});

test('a delayed round reads working while in flight and online once it settles', async () => {
  const fixture = await startStatusFixture('allibot-status-working-', {
    env: { ANTHROPIC_API_KEY: 'sk-status-working-secret' },
    args: ['--scripted-provider', 'delay', '--scripted-delay-ms', '1500'],
  });
  try {
    const created = await createAgent(fixture, {
      display_name: '正在回复',
      model: 'anthropic:claude-sonnet-4-5',
    });
    const agentId = String(created['id']);
    await confirmConsent(fixture, 'anthropic');
    assert.equal((await getAgent(fixture, agentId))['status'], 'online');

    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    await postMessage(fixture, channelId, '请回答这一轮');

    // The deferred adapter holds the round; the write response has already
    // returned, so this GET runs inside the in-flight window.
    const working = await getAgent(fixture, agentId);
    assert.equal(working['status'], 'working');
    assert.equal(working['offline_reason'], null);

    const settled = await waitForStatus(fixture, agentId, 'online');
    assert.equal(settled['offline_reason'], null);
    assert.equal(
      latestOutcomeStatus(fixture.dataDir, agentId),
      'replied',
      'the settled status reads the round outcome that closed it',
    );
  } finally {
    await close(fixture);
  }
});

test('a failed round keeps error across a restart and a later reply returns online', async () => {
  const dataDir = await makeTempDir('allibot-status-error-');
  await migrate(dataDir);
  const env = { OPENAI_API_KEY: 'sk-status-error-secret' };
  let fixture = await startOn(dataDir, {
    env,
    args: ['--scripted-provider', 'fail'],
  });
  try {
    const created = await createAgent(fixture, {
      display_name: '先失败',
      model: 'openai:gpt-5',
    });
    const agentId = String(created['id']);
    await confirmConsent(fixture, 'openai');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);

    await postMessage(fixture, channelId, '第一轮');
    assert.equal(latestOutcomeStatus(dataDir, agentId), 'failed');
    const errored = await getAgent(fixture, agentId);
    assert.equal(errored['status'], 'error');
    assert.equal(errored['offline_reason'], null);

    // A restart replays nothing from process memory: the error state is the
    // stored round outcome, so it must survive.
    await fixture.running.stop();
    fixture = await startOn(dataDir, {
      env,
      args: ['--scripted-provider', 'reply'],
    });
    const afterRestart = await getAgent(fixture, agentId);
    assert.equal(afterRestart['status'], 'error', 'the failure fact survives a restart');
    assert.equal(
      latestOutcomeStatus(dataDir, agentId),
      'failed',
      'the status point reads the same latest non-merged round outcome the database holds',
    );

    // The next successful round becomes the latest non-merged outcome.
    await postMessage(fixture, channelId, '第二轮');
    const recovered = await getAgent(fixture, agentId);
    assert.equal(recovered['status'], 'online');
    assert.equal(latestOutcomeStatus(dataDir, agentId), 'replied');
  } finally {
    await fixture.running.stop().catch(() => undefined);
    await removeTempDir(dataDir);
  }
});

test('working is process state and does not survive a crash', async () => {
  const dataDir = await makeTempDir('allibot-status-working-crash-');
  await migrate(dataDir);
  const env = { OPENAI_API_KEY: 'sk-status-crash-secret' };
  let fixture = await startOn(dataDir, {
    env,
    args: ['--scripted-provider', 'delay', '--scripted-delay-ms', '5000'],
  });
  try {
    const created = await createAgent(fixture, {
      display_name: '崩溃中的轮次',
      model: 'openai:gpt-5',
    });
    const agentId = String(created['id']);
    await confirmConsent(fixture, 'openai');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    await postMessage(fixture, channelId, '慢轮');

    assert.equal((await getAgent(fixture, agentId))['status'], 'working');
    await fixture.running.crash();
    assert.equal(latestOutcomeStatus(dataDir, agentId), null, 'a crashed round wrote no outcome');

    fixture = await startOn(dataDir, {
      env,
      args: ['--scripted-provider', 'reply'],
    });
    const afterRestart = await getAgent(fixture, agentId);
    assert.equal(afterRestart['status'], 'online', 'no in-flight fact survived the process');
  } finally {
    await fixture.running.stop().catch(() => undefined);
    await removeTempDir(dataDir);
  }
});

test('an Agent with enabled=0 is offline, is never woken and never claims a task', async () => {
  const fixture = await startStatusFixture('allibot-status-disabled-', {
    env: { OPENAI_API_KEY: 'sk-disabled-test' },
  });
  try {
    const created = await createAgent(fixture, {
      display_name: '已停用的 Agent',
      model: 'openai:gpt-5',
      enabled: 0,
    });
    const agentId = String(created['id']);
    await confirmConsent(fixture, 'openai');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);

    const read = await getAgent(fixture, agentId);
    assert.equal(read['status'], 'offline', 'the enabled switch is the first status fact');
    assert.equal(read['offline_reason'], 'disabled', 'the reason is readable and stable');

    // The wake surface excludes the switched-off Agent: the message lands but
    // no round runs for it.
    await postMessage(fixture, channelId, '叫一下已停用的 Agent');
    assert.equal(latestOutcomeStatus(fixture.dataDir, agentId), null);
    const messages = await fetch(`${fixture.base}/api/targets/${channelId}/messages`);
    const body = (await readJson(messages))['messages'] as Record<string, unknown>[];
    assert.deepEqual(
      body.map((message) => message['kind']),
      ['human'],
      'no Agent reply was produced by a switched-off member',
    );

    // The claim surface reads the same column.
    const taskResponse = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '不应被认领',
    });
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const task = await readJson(taskResponse);
    assert.equal(task['status'], 'todo');
    assert.equal(task['assignee_member_id'], null);
  } finally {
    await close(fixture);
  }
});
