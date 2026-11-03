import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '@allibot/shared';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startRecordingEndpoint,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 远端数据流告知、凭证与真实 provider 适配器的进程级验收（D1.10 / D4）。
 *
 * 唯一 seam 仍是后端 HTTP 面：测试启动真实进程、用临时数据目录，把
 * OPENAI_BASE_URL / ANTHROPIC_BASE_URL 指向 127.0.0.1 上的本地记录端点——
 * 它不是互联网，因此「真实 provider 适配器」被完整走通，且自动化测试零联网、
 * 零费用。
 */

interface RemoteFlowFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

/**
 * The sentinel credential. Its middle run is unique in the fixture, so a leak
 * check can look for any fragment that is not part of the masked form —
 * `assertNoSecret` could not otherwise tell a leak from the mask itself.
 */
const SENTINEL_KEY = 'sk-test-0123456789abcdefghij-9876wxyz';
const SENTINEL_MIDDLE = '0123456789abcdefghij';
const SENTINEL_HEAD = 'sk-t';
const SENTINEL_TAIL = 'wxyz';

async function startRemoteFlowFixture(
  prefix: string,
  options: {
    provider?: 'scripted' | 'model';
    env?: NodeJS.ProcessEnv;
    args?: readonly string[];
  } = {},
): Promise<RemoteFlowFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    env: options.env,
    args: [
      ...(options.provider === undefined ? [] : ['--provider', options.provider]),
      ...(options.args ?? []),
    ],
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

async function postJson(
  fixture: RemoteFlowFixture,
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
  fixture: RemoteFlowFixture,
  displayName: string,
  model: string,
): Promise<Record<string, unknown>> {
  const created = await postJson(fixture, '/api/agents', { display_name: displayName, model });
  assert.equal(created.status, 201, await created.clone().text());
  return await readJson(created);
}

async function createChannelWith(
  fixture: RemoteFlowFixture,
  agentId: string,
): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '远端频道',
    description: '远端数据流告知的频道描述',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const channelId = (await readJson(created))['id'] as string;
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: agentId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
  return channelId;
}

async function postMessage(
  fixture: RemoteFlowFixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
}

async function listMessages(
  fixture: RemoteFlowFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function roundOutcomes(fixture: RemoteFlowFixture): {
  status: string;
  reason: string;
  finished_reason: string | null;
}[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT status, reason, finished_reason FROM round_outcome ORDER BY rowid')
      .all() as { status: string; reason: string; finished_reason: string | null }[];
  } finally {
    db.close();
  }
}

function consentRows(fixture: RemoteFlowFixture): { scope_kind: string; scope_id: string }[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT scope_kind, scope_id FROM remote_consent_scope ORDER BY scope_id')
      .all() as { scope_kind: string; scope_id: string }[];
  } finally {
    db.close();
  }
}

/**
 * Every response the human face produced must be free of the sentinel key, and
 * the process output must be too: only a masked form or a status enum may
 * appear (D1.10).
 */
function assertNoSecret(text: string, what: string): void {
  assert.ok(!text.includes(SENTINEL_KEY), `${what} must not contain the credential value`);
  assert.ok(
    !text.includes(SENTINEL_MIDDLE),
    `${what} must not contain the credential body — only a masked form may appear`,
  );
  assert.ok(!text.includes(SENTINEL_HEAD + SENTINEL_TAIL), `${what} must not reassemble the key`);
}

test('POST /api/agents accepts provider:model and reports credential_status without the key', async () => {
  const fixture = await startRemoteFlowFixture('allibot-remote-agent-', {
    env: { ANTHROPIC_API_KEY: SENTINEL_KEY },
  });
  try {
    const withKey = await createAgent(fixture, '有凭证', 'anthropic:claude-sonnet-4-5');
    assert.equal(withKey['model'], 'anthropic:claude-sonnet-4-5');
    assert.equal(withKey['credential_status'], 'present', 'the key is readable from the environment');
    assertNoSecret(JSON.stringify(withKey), 'the create response');

    const missing = await createAgent(fixture, '缺凭证', 'openai:gpt-5');
    assert.equal(missing['model'], 'openai:gpt-5');
    assert.equal(missing['credential_status'], 'missing', 'OPENAI_API_KEY is not set');
    assertNoSecret(JSON.stringify(missing), 'the create response');

    const detail = await fetch(`${fixture.base}/api/agents/${String(withKey['id'])}`);
    assert.equal(detail.status, 200);
    const detailBody = await detail.text();
    assert.equal(JSON.parse(detailBody)['credential_status'], 'present');
    assertNoSecret(detailBody, 'GET /api/agents/{id}');

    const list = await (await fetch(`${fixture.base}/api/agents`)).text();
    assertNoSecret(list, 'GET /api/agents');

    const stored = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
    try {
      const columns = (stored.pragma('table_info(agent_config)') as { name: string }[]).map(
        (row) => row.name,
      );
      assert.deepEqual(
        columns.some((column) => /key|secret|token|credential/i.test(column)),
        false,
        `agent_config must not carry a credential column: ${columns.join(', ')}`,
      );
      const model = stored
        .prepare('SELECT model FROM agent_config WHERE member_id = ?')
        .get(withKey['id']) as { model: string };
      assert.equal(model.model, 'anthropic:claude-sonnet-4-5');
    } finally {
      stored.close();
    }

    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
  } finally {
    await fixture.stop();
  }
});

test('an unknown provider in provider:model is refused with 400 validation_failed', async () => {
  const fixture = await startRemoteFlowFixture('allibot-remote-invalid-');
  try {
    for (const model of ['gemini:pro', 'openai', ':gpt-5', 'openai:']) {
      const created = await postJson(fixture, '/api/agents', {
        display_name: 'Bad Provider',
        model,
      });
      assert.equal(created.status, 400, `model ${model} should be refused`);
      const error = (await readJson(created))['error'] as Record<string, unknown>;
      assert.equal(error['code'], 'validation_failed');
    }
  } finally {
    await fixture.stop();
  }
});

test('GET /api/remote-data-flow lists both providers unconfirmed and the data surfaces', async () => {
  const endpoint = await startRecordingEndpoint();
  const fixture = await startRemoteFlowFixture('allibot-remote-read-', {
    env: { OPENAI_BASE_URL: endpoint.baseUrl },
  });
  try {
    const response = await fetch(`${fixture.base}/api/remote-data-flow`);
    assert.equal(response.status, 200);
    const body = await readJson(response);
    const providers = body['providers'] as Record<string, unknown>[];
    assert.deepEqual(
      providers.map((provider) => [provider['provider'], provider['confirmed_at']]),
      [
        ['anthropic', null],
        ['openai', null],
      ],
      'nothing is confirmed on a fresh data dir',
    );
    assert.equal(providers[0]?.['credential_env'], 'ANTHROPIC_API_KEY');
    assert.equal(providers[1]?.['credential_env'], 'OPENAI_API_KEY');
    assert.equal(providers[0]?.['credential_status'], 'missing');
    assert.equal(
      providers[0]?.['receiver'],
      'https://api.anthropic.com',
      'OPENAI_BASE_URL never redirects the anthropic provider',
    );
    assert.equal(
      providers[1]?.['receiver'],
      endpoint.baseUrl,
      'the OpenAI-compatible override is the receiver it belongs to',
    );

    const surfaces = body['data_surfaces'] as string[];
    assert.deepEqual(surfaces, [
      ZH_CN['remoteFlow.surface.messageBody'].text,
      ZH_CN['remoteFlow.surface.authorName'].text,
      ZH_CN['remoteFlow.surface.targetName'].text,
      ZH_CN['remoteFlow.surface.mentionedNames'].text,
      ZH_CN['remoteFlow.surface.receiver'].text,
    ]);
    const serialized = JSON.stringify(body);
    for (const surface of ['消息正文', '发送者显示名', '频道名称与描述', '被点名成员的显示名', '接收方']) {
      assert.ok(serialized.includes(surface), `the consent list names the surface: ${surface}`);
    }
    assert.ok(!serialized.includes('E2EE'), 'the copy never claims end-to-end encryption');
  } finally {
    await fixture.stop();
    await endpoint.stop();
  }
});

test('POST /api/remote-data-flow/{provider}/consent writes one row and is idempotent', async () => {
  const fixture = await startRemoteFlowFixture('allibot-remote-consent-');
  try {
    const first = await postJson(fixture, '/api/remote-data-flow/anthropic/consent', {});
    assert.equal(first.status, 200, await first.clone().text());
    const confirmedAt = (await readJson(first))['confirmed_at'];
    assert.equal(typeof confirmedAt, 'string');
    assert.ok(Number.isFinite(Date.parse(confirmedAt as string)));

    const second = await postJson(fixture, '/api/remote-data-flow/anthropic/consent', {});
    assert.equal(second.status, 200);
    assert.equal(
      (await readJson(second))['confirmed_at'],
      confirmedAt,
      'a second confirmation does not refresh the first one',
    );

    assert.deepEqual(consentRows(fixture), [{ scope_kind: 'model', scope_id: 'anthropic' }]);

    // The acceptance command: the row is readable through the sqlite3 CLI,
    // which is the database's own face and not a server read path.
    const listed = spawnSync(
      'sqlite3',
      [
        path.join(fixture.dataDir, 'allibot.db'),
        'select scope_kind, scope_id from remote_consent_scope',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(listed.status, 0, `sqlite3 should exit 0; stderr: ${listed.stderr}`);
    assert.equal(listed.stdout.trim(), 'model|anthropic');

    const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
    try {
      const columns = (db.pragma('table_info(remote_consent_scope)') as { name: string }[]).map(
        (row) => row.name,
      );
      assert.deepEqual(columns, ['scope_kind', 'scope_id', 'confirmed_at']);
      const row = db.prepare('SELECT * FROM remote_consent_scope').get() as Record<string, unknown>;
      assert.deepEqual(Object.keys(row).sort(), ['confirmed_at', 'scope_id', 'scope_kind']);
      assert.equal(
        Object.values(row).some((value) => typeof value === 'string' && value.includes('http')),
        false,
        'the consent row stores no connection parameter',
      );
    } finally {
      db.close();
    }

    const read = await readJson(await fetch(`${fixture.base}/api/remote-data-flow`));
    const anthropic = (read['providers'] as Record<string, unknown>[]).find(
      (provider) => provider['provider'] === 'anthropic',
    );
    assert.equal(anthropic?.['confirmed_at'], confirmedAt);
    assert.equal(
      ((read['providers'] as Record<string, unknown>[]).find(
        (provider) => provider['provider'] === 'openai',
      ) ?? {})['confirmed_at'],
      null,
      'confirming one provider never confirms the other',
    );

    const unknown = await postJson(fixture, '/api/remote-data-flow/gemini/consent', {});
    assert.equal(unknown.status, 400);
    assert.equal(((await readJson(unknown))['error'] as Record<string, unknown>)['code'], 'validation_failed');
    assert.deepEqual(consentRows(fixture), [{ scope_kind: 'model', scope_id: 'anthropic' }]);
  } finally {
    await fixture.stop();
  }
});

test('an unconfirmed provider makes no remote call and closes the round with a consent reason', async () => {
  const endpoint = await startRecordingEndpoint();
  const fixture = await startRemoteFlowFixture('allibot-remote-unconfirmed-', {
    provider: 'model',
    env: { OPENAI_API_KEY: SENTINEL_KEY, OPENAI_BASE_URL: endpoint.baseUrl },
  });
  try {
    const agent = await createAgent(fixture, '未确认', 'openai:gpt-5');
    const channelId = await createChannelWith(fixture, String(agent['id']));

    await postMessage(fixture, channelId, { body: '@未确认 请回应' });

    assert.equal(endpoint.requests.length, 0, 'no remote call before the consent');
    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['kind']),
      ['human'],
      'no Agent message is written',
    );
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'failed');
    assert.ok(
      (outcomes[0]?.reason ?? '').includes('consent'),
      `the reason carries the consent key: ${outcomes[0]?.reason ?? ''}`,
    );
    assert.ok(
      (outcomes[0]?.reason ?? '').includes('未确认远端数据流告知'),
      'the reason is readable zh-CN copy',
    );
    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
    assert.deepEqual(consentRows(fixture), [], 'the refused round writes no consent row');
  } finally {
    await fixture.stop();
    await endpoint.stop();
  }
});

test('a missing credential makes no remote call and closes the round with a credential reason', async () => {
  const endpoint = await startRecordingEndpoint();
  const fixture = await startRemoteFlowFixture('allibot-remote-no-key-', {
    provider: 'model',
    env: { OPENAI_BASE_URL: endpoint.baseUrl },
  });
  try {
    const agent = await createAgent(fixture, '缺钥匙', 'openai:gpt-5');
    const confirmed = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    assert.equal(confirmed.status, 200);
    const channelId = await createChannelWith(fixture, String(agent['id']));

    await postMessage(fixture, channelId, { body: '@缺钥匙 请回应' });

    assert.equal(endpoint.requests.length, 0, 'no remote call without a credential');
    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['kind']),
      ['human'],
      'no Agent message is written',
    );
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    assert.ok(
      (outcomes[0]?.reason ?? '').includes('credential'),
      `the reason carries the credential key: ${outcomes[0]?.reason ?? ''}`,
    );
    assert.ok(
      (outcomes[0]?.reason ?? '').includes('OPENAI_API_KEY'),
      'the reason names the environment variable the provider reads',
    );

    const detail = await readJson(await fetch(`${fixture.base}/api/agents/${String(agent['id'])}`));
    assert.equal(detail['credential_status'], 'missing');
    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
  } finally {
    await fixture.stop();
    await endpoint.stop();
  }
});

test('a confirmed provider with a credential makes exactly one recorded call and lands its text', async () => {
  const endpoint = await startRecordingEndpoint({ replyText: '本地记录端点的回复' });
  const fixture = await startRemoteFlowFixture('allibot-remote-call-', {
    provider: 'model',
    env: { OPENAI_API_KEY: SENTINEL_KEY, OPENAI_BASE_URL: endpoint.baseUrl },
  });
  try {
    const agent = await createAgent(fixture, '远端代理', 'openai:gpt-5');
    const confirmed = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    assert.equal(confirmed.status, 200);
    const channelId = await createChannelWith(fixture, String(agent['id']));

    await postMessage(fixture, channelId, { body: '@远端代理 请回应' });

    assert.equal(endpoint.requests.length, 1, 'one round is one provider call');
    const call = endpoint.requests[0];
    assert.ok(call !== undefined);
    assert.equal(call.method, 'POST');
    assert.equal(call.path, '/chat/completions');
    assert.equal(call.headers.authorization, `Bearer ${SENTINEL_KEY}`);
    const payload = JSON.parse(call.body) as Record<string, unknown>;
    assert.equal(payload['model'], 'gpt-5');
    const sent = JSON.stringify(payload);
    assert.ok(sent.includes('@远端代理 请回应'), 'the message body is one of the data surfaces');
    assert.ok(sent.includes('我'), 'the sender display name is one of the data surfaces');

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['body']]),
      [
        ['human', '@远端代理 请回应'],
        ['agent', '本地记录端点的回复'],
      ],
      'the provider text is the round reply',
    );
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'replied');
    assert.equal(outcomes[0]?.finished_reason, ZH_CN['round.finished.completed'].text);

    const responses = JSON.stringify(messages) + JSON.stringify(outcomes);
    assertNoSecret(responses, 'the message read and the round reason');
    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
    assert.equal(
      fixture.running.logs().stdout.includes(SENTINEL_KEY.slice(3, 8)),
      false,
      'only a masked form or a status enum may appear in process output',
    );
  } finally {
    await fixture.stop();
    await endpoint.stop();
  }
});

test('the base URL override belongs to its own provider: OpenAI never redirects Anthropic', async () => {
  const endpoint = await startRecordingEndpoint({ replyText: 'anthropic 记录端点的回复' });
  const fixture = await startRemoteFlowFixture('allibot-remote-base-url-', {
    provider: 'model',
    env: {
      OPENAI_BASE_URL: endpoint.baseUrl,
      ANTHROPIC_API_KEY: SENTINEL_KEY,
      ANTHROPIC_BASE_URL: endpoint.baseUrl,
    },
  });
  try {
    const agent = await createAgent(fixture, '克劳德', 'anthropic:claude-sonnet-4-5');
    await postJson(fixture, '/api/remote-data-flow/anthropic/consent', {});
    const channelId = await createChannelWith(fixture, String(agent['id']));

    await postMessage(fixture, channelId, { body: '@克劳德 请回应' });

    assert.equal(endpoint.requests.length, 1);
    const call = endpoint.requests[0];
    assert.ok(call !== undefined);
    assert.equal(call.path, '/v1/messages', 'the Anthropic adapter uses its own path');
    assert.equal(call.headers['x-api-key'], SENTINEL_KEY);
    const payload = JSON.parse(call.body) as Record<string, unknown>;
    assert.equal(payload['model'], 'claude-sonnet-4-5');

    const messages = await listMessages(fixture, channelId);
    assert.equal(messages[1]?.['body'], 'anthropic 记录端点的回复');
    assert.equal(roundOutcomes(fixture)[0]?.status, 'replied');
  } finally {
    await fixture.stop();
    await endpoint.stop();
  }
});

test('a provider error echoing the credential lands only as a masked, readable reason', async () => {
  const endpoint = await startRecordingEndpoint();
  endpoint.respondWith(() => ({
    status: 401,
    body: { error: { message: `Incorrect API key provided: ${SENTINEL_KEY}` } },
  }));
  const fixture = await startRemoteFlowFixture('allibot-remote-error-mask-', {
    provider: 'model',
    env: { OPENAI_API_KEY: SENTINEL_KEY, OPENAI_BASE_URL: endpoint.baseUrl },
  });
  try {
    const agent = await createAgent(fixture, '回声', 'openai:gpt-5');
    await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    const channelId = await createChannelWith(fixture, String(agent['id']));

    await postMessage(fixture, channelId, { body: '@回声 请回应' });

    assert.equal(endpoint.requests.length, 1);
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'failed');
    const reason = outcomes[0]?.reason ?? '';
    assert.ok(reason.includes('401'), `the reason states the failure: ${reason}`);
    assert.ok(
      reason.includes('…') && reason.includes(SENTINEL_KEY.slice(-4)),
      `the reason shows only a masked credential: ${reason}`,
    );
    assertNoSecret(reason, 'the round reason');
    assertNoSecret(fixture.running.logs().stdout + fixture.running.logs().stderr, 'process output');
    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['kind']),
      ['human'],
      'a failed call writes no Agent message',
    );
  } finally {
    await fixture.stop();
    await endpoint.stop();
  }
});

test('an explicit --scripted-provider still injects the test double', async () => {
  const fixture = await startRemoteFlowFixture('allibot-remote-scripted-', {
    env: { OPENAI_API_KEY: SENTINEL_KEY },
    args: ['--scripted-provider', 'reply'],
  });
  try {
    const agent = await createAgent(fixture, '脚本化', 'openai:gpt-5');
    await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    const channelId = await createChannelWith(fixture, String(agent['id']));

    await postMessage(fixture, channelId, { body: '@脚本化 请回应' });

    const messages = await listMessages(fixture, channelId);
    assert.equal(messages[1]?.['kind'], 'agent', 'the scripted reply still lands');
    assert.ok(
      (messages[1]?.['body'] as string).startsWith('收到 #'),
      'the default scripted reply is the double, not a model call',
    );
    assert.equal(
      fixture.running.logs().stdout.includes('allibot 成员面适配器：scripted:reply'),
      true,
      'the option is an explicit injection of the double',
    );
    assert.equal(fixture.running.logs().stdout.includes('成员面适配器：model'), false);
  } finally {
    await fixture.stop();
  }
});
