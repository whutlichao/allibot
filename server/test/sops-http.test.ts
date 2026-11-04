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
 * SOP definition HTTP face (#41 / D2.3 / D2.4 / D4.2): one immutable,
 * channel-scoped ordered step list. The routes are exercised through the
 * product's public HTTP seam only; the stored row is read afterwards to prove
 * the JSON-array shape and the "a replay writes no row" fact.
 *
 * A definition is not a task and not a workflow: there is no edit / delete
 * route, and an invalid step, member or channel never creates a row.
 */

const AGENT_MODEL = 'openai:gpt-5';

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  channelId: string;
  otherChannelId: string;
  agentA: string;
  agentB: string;
  outsider: string;
  ownerId: string;
  stop: () => Promise<void>;
}

async function request(
  base: string,
  method: string,
  route: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${base}${route}`, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> = {};
  if (text.length > 0) {
    const value = JSON.parse(text) as unknown;
    parsed =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : { value };
  }
  return { status: response.status, body: parsed };
}

function postJson(base: string, route: string, body: unknown) {
  return request(base, 'POST', route, body);
}

function getJson(base: string, route: string) {
  return request(base, 'GET', route);
}

function errorCode(body: Record<string, unknown>): unknown {
  const error = body['error'];
  return typeof error === 'object' && error !== null
    ? (error as Record<string, unknown>)['code']
    : undefined;
}

function normalizeStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: '收集资料',
    description: '读规格与既有实现',
    executor_member_id: '',
    verifier_member_id: '',
    max_attempts: 2,
    ...overrides,
  };
}

function openReadOnly(dataDir: string): Database.Database {
  return new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
}

function definitionRows(dataDir: string): {
  id: string;
  channel_id: string;
  name: string;
  steps: string;
}[] {
  const db = openReadOnly(dataDir);
  try {
    return db
      .prepare('SELECT id, channel_id, name, steps FROM sop_definition ORDER BY rowid')
      .all() as { id: string; channel_id: string; name: string; steps: string }[];
  } finally {
    db.close();
  }
}

async function startFixture(): Promise<Fixture> {
  const dataDir = await makeTempDir('allibot-sops-http-');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const running = await startServer(dataDir, {
    env: { OPENAI_API_KEY: 'sk-sop-definitions-test' },
    args: ['--scripted-provider', 'reply'],
  });
  const base = `http://127.0.0.1:${running.port}`;
  const channelId = (await postJson(base, '/api/channels', { name: 'SOP 频道' })).body[
    'id'
  ] as string;
  const otherChannelId = (await postJson(base, '/api/channels', { name: '另一个频道' })).body[
    'id'
  ] as string;
  const agentA = (await postJson(base, '/api/agents', {
    display_name: '执行者甲',
    model: AGENT_MODEL,
  })).body['id'] as string;
  const agentB = (await postJson(base, '/api/agents', {
    display_name: '校验者乙',
    model: AGENT_MODEL,
  })).body['id'] as string;
  const outsider = (await postJson(base, '/api/agents', {
    display_name: '频道外成员',
    model: AGENT_MODEL,
  })).body['id'] as string;
  await postJson(base, `/api/channels/${channelId}/members`, { member_id: agentA });
  await postJson(base, `/api/channels/${channelId}/members`, { member_id: agentB });
  // The second channel holds the same two Agents: its (channel_id, name) pair
  // is independent from the first channel's.
  await postJson(base, `/api/channels/${otherChannelId}/members`, { member_id: agentA });
  await postJson(base, `/api/channels/${otherChannelId}/members`, { member_id: agentB });
  const workspace = (await getJson(base, '/api/workspace')).body;
  const owner = workspace['owner'] as { id: string };

  return {
    dataDir,
    running,
    base,
    channelId,
    otherChannelId,
    agentA,
    agentB,
    outsider,
    ownerId: owner.id,
    stop: async (): Promise<void> => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

test('a definition is created 201, reads back its ordered steps and stores a JSON array', async () => {
  const fixture = await startFixture();
  try {
    const steps = [
      normalizeStep({
        title: '第一步',
        description: '先收集',
        executor_member_id: fixture.agentA,
        verifier_member_id: fixture.agentB,
      }),
      normalizeStep({
        title: '第二步',
        description: '再校验',
        executor_member_id: fixture.agentB,
        verifier_member_id: fixture.agentA,
        max_attempts: 5,
      }),
    ];
    const created = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.channelId,
      name: '  周报流程  ',
      steps,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const definition = created.body;
    assert.equal(typeof definition['id'], 'string');
    assert.equal(definition['channel_id'], fixture.channelId);
    assert.equal(definition['name'], '周报流程', 'the name is stored trimmed');
    assert.deepEqual(definition['steps'], steps);
    assert.ok(Number.isFinite(Date.parse(String(definition['created_at']))));

    const rows = definitionRows(fixture.dataDir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.id, definition['id']);
    const storedSteps = JSON.parse(rows[0]?.steps ?? '') as unknown;
    assert.ok(Array.isArray(storedSteps), 'the column keeps a JSON array');
    assert.deepEqual(storedSteps, steps);

    const readBack = await getJson(fixture.base, `/api/sops/${String(definition['id'])}`);
    assert.equal(readBack.status, 200);
    assert.deepEqual(readBack.body, definition);

    const byChannel = await getJson(
      fixture.base,
      `/api/sops?channel_id=${encodeURIComponent(fixture.channelId)}`,
    );
    assert.equal(byChannel.status, 200);
    assert.deepEqual(
      (byChannel.body['sops'] as { id: string }[]).map((row) => row.id),
      [definition['id']],
      'the channel filter returns exactly that channel definitions',
    );

    const otherChannel = await getJson(
      fixture.base,
      `/api/sops?channel_id=${encodeURIComponent(fixture.otherChannelId)}`,
    );
    assert.equal(otherChannel.status, 200);
    assert.deepEqual(otherChannel.body['sops'], [], 'another channel reads none');

    const unknownDefinition = await getJson(fixture.base, '/api/sops/does-not-exist');
    assert.equal(unknownDefinition.status, 404);
    assert.equal(errorCode(unknownDefinition.body), 'not_found');

    const unknownChannel = await getJson(fixture.base, '/api/sops?channel_id=does-not-exist');
    assert.equal(unknownChannel.status, 404);
    assert.equal(errorCode(unknownChannel.body), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('a same-name same-shape replay returns 200 without a new row; a different shape is 409', async () => {
  const fixture = await startFixture();
  try {
    const body = {
      channel_id: fixture.channelId,
      name: '周报流程',
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    };
    const first = await postJson(fixture.base, '/api/sops', body);
    assert.equal(first.status, 201);

    const replay = await postJson(fixture.base, '/api/sops', body);
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, first.body, 'the replay returns the same reading');
    assert.equal(definitionRows(fixture.dataDir).length, 1, 'a replay writes no row');

    const changedStep = await postJson(fixture.base, '/api/sops', {
      ...body,
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
          max_attempts: 3,
        }),
      ],
    });
    assert.equal(changedStep.status, 409);
    assert.equal(errorCode(changedStep.body), 'conflict');
    assert.equal(definitionRows(fixture.dataDir).length, 1);

    const changedOrder = await postJson(fixture.base, '/api/sops', {
      ...body,
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentB,
          verifier_member_id: fixture.agentA,
        }),
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    });
    assert.equal(changedOrder.status, 409);

    const sameNameOtherChannel = await postJson(fixture.base, '/api/sops', {
      ...body,
      channel_id: fixture.otherChannelId,
    });
    assert.equal(
      sameNameOtherChannel.status,
      201,
      'the identity pair is (channel_id, name), so another channel is a new definition',
    );
  } finally {
    await fixture.stop();
  }
});

test('one step / twenty steps and max_attempts 1 / 5 are the inclusive bounds', async () => {
  const fixture = await startFixture();
  try {
    const shortest = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.channelId,
      name: '最短流程',
      steps: [
        {
          title: '唯一一步',
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
          max_attempts: 1,
        },
      ],
    });
    assert.equal(shortest.status, 201, JSON.stringify(shortest.body));
    assert.deepEqual((shortest.body['steps'] as Record<string, unknown>[])[0], {
      title: '唯一一步',
      description: '',
      executor_member_id: fixture.agentA,
      verifier_member_id: fixture.agentB,
      max_attempts: 1,
    });

    const longest = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.channelId,
      name: '最长流程',
      steps: Array.from({ length: 20 }, (_value, index) => ({
        title: `步骤 ${index + 1}`,
        description: '',
        executor_member_id: index % 2 === 0 ? fixture.agentA : fixture.agentB,
        verifier_member_id: index % 2 === 0 ? fixture.agentB : fixture.agentA,
        max_attempts: 5,
      })),
    });
    assert.equal(longest.status, 201, JSON.stringify(longest.body));
    assert.equal((longest.body['steps'] as unknown[]).length, 20);
    assert.equal(definitionRows(fixture.dataDir).length, 2);
  } finally {
    await fixture.stop();
  }
});

test('invalid steps, attempts, members, names and bodies are 400 validation_failed and write nothing', async () => {
  const fixture = await startFixture();
  try {
    const baseSteps = [
      normalizeStep({
        executor_member_id: fixture.agentA,
        verifier_member_id: fixture.agentB,
      }),
    ];
    const body = (overrides: Record<string, unknown> = {}) => ({
      channel_id: fixture.channelId,
      name: '周报流程',
      steps: baseSteps,
      ...overrides,
    });
    const step = (overrides: Record<string, unknown>) => [
      normalizeStep({
        executor_member_id: fixture.agentA,
        verifier_member_id: fixture.agentB,
        ...overrides,
      }),
    ];

    const invalid: [string, Record<string, unknown>][] = [
      ['zero steps', body({ steps: [] })],
      ['twenty-one steps', body({ steps: Array.from({ length: 21 }, () => baseSteps[0]) })],
      ['max_attempts 0', body({ steps: step({ max_attempts: 0 }) })],
      ['max_attempts 6', body({ steps: step({ max_attempts: 6 }) })],
      ['max_attempts not an integer', body({ steps: step({ max_attempts: 1.5 }) })],
      [
        'verifier equals executor',
        body({ steps: step({ verifier_member_id: fixture.agentA }) }),
      ],
      [
        'executor is not a channel member',
        body({ steps: step({ executor_member_id: fixture.outsider }) }),
      ],
      [
        'verifier is not a channel member',
        body({ steps: step({ verifier_member_id: fixture.outsider }) }),
      ],
      [
        'executor is the owner, not an Agent',
        body({ steps: step({ executor_member_id: fixture.ownerId }) }),
      ],
      ['steps is not an array', body({ steps: { title: 'x' } })],
      ['a step is not an object', body({ steps: ['step'] })],
      ['title is empty', body({ steps: step({ title: '   ' }) })],
      ['an unknown step field', body({ steps: step({ extra: true }) })],
      ['an unknown top-level field', body({ extra: true })],
      ['name is empty', body({ name: '   ' })],
      ['channel_id is missing', { name: '周报流程', steps: baseSteps }],
      ['the channel does not exist', body({ channel_id: 'does-not-exist' })],
      ['the body is not an object', [] as unknown as Record<string, unknown>],
    ];

    for (const [label, requestBody] of invalid) {
      const response = await postJson(fixture.base, '/api/sops', requestBody);
      assert.equal(response.status, 400, `${label}: ${JSON.stringify(response.body)}`);
      assert.equal(errorCode(response.body), 'validation_failed', label);
    }
    assert.equal(definitionRows(fixture.dataDir).length, 0, 'no invalid body creates a row');
  } finally {
    await fixture.stop();
  }
});

test('an archived channel is 400, a deleted channel is 404 and the definition stays readable', async () => {
  const fixture = await startFixture();
  try {
    const definition = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.channelId,
      name: '周报流程',
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    });
    assert.equal(definition.status, 201);
    const definitionId = definition.body['id'] as string;

    await postJson(fixture.base, `/api/channels/${fixture.channelId}/archive`, {});
    const archivedCreate = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.channelId,
      name: '归档后的新流程',
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    });
    assert.equal(archivedCreate.status, 400);
    assert.equal(errorCode(archivedCreate.body), 'validation_failed');
    const archivedReplay = await postJson(fixture.base, '/api/sops', {
      channel_id: definition.body['channel_id'],
      name: definition.body['name'],
      steps: definition.body['steps'],
    });
    assert.equal(archivedReplay.status, 400, 'an archived channel takes no definition write');

    const archivedRead = await getJson(fixture.base, `/api/sops/${definitionId}`);
    assert.equal(archivedRead.status, 200, 'an archived channel definition stays readable');

    const second = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.otherChannelId,
      name: '待删除频道的流程',
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    });
    assert.equal(second.status, 201);
    const secondId = second.body['id'] as string;
    await request(fixture.base, 'DELETE', `/api/channels/${fixture.otherChannelId}`);

    const deletedCreate = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.otherChannelId,
      name: '删除后的新流程',
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    });
    assert.equal(deletedCreate.status, 404);
    assert.equal(errorCode(deletedCreate.body), 'not_found');

    assert.equal((await getJson(fixture.base, `/api/sops/${secondId}`)).status, 404);
    assert.equal(
      (await getJson(fixture.base, `/api/sops?channel_id=${fixture.otherChannelId}`)).status,
      404,
    );
    assert.equal(definitionRows(fixture.dataDir).length, 2, 'no rejected write added a row');
  } finally {
    await fixture.stop();
  }
});

test('the definition has no edit or delete endpoint', async () => {
  const fixture = await startFixture();
  try {
    const created = await postJson(fixture.base, '/api/sops', {
      channel_id: fixture.channelId,
      name: '周报流程',
      steps: [
        normalizeStep({
          executor_member_id: fixture.agentA,
          verifier_member_id: fixture.agentB,
        }),
      ],
    });
    const id = created.body['id'] as string;
    for (const method of ['PATCH', 'PUT', 'DELETE']) {
      const response = await request(fixture.base, method, `/api/sops/${id}`, {
        name: '改名',
      });
      assert.equal(response.status, 404, `${method} must not be a definition route`);
      assert.equal(errorCode(response.body), 'not_found');
    }
    const readBack = await getJson(fixture.base, `/api/sops/${id}`);
    assert.deepEqual(readBack.body, created.body, 'the definition is unchanged');
  } finally {
    await fixture.stop();
  }
});
