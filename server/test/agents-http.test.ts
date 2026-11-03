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

interface AgentFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

const CREATE_BODY = {
  display_name: 'Researcher',
  role: '研究助理',
  model: 'anthropic:claude-sonnet-4-5',
  system_prompt: 'Answer with sources.',
  context_window: 24,
  compression_threshold: 0.75,
  max_iterations: 6,
};

async function startAgentFixture(prefix: string): Promise<AgentFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir);
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

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

async function createAgent(fixture: AgentFixture, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

test('POST /api/agents creates an Agent listed by GET /api/agents with its config', async () => {
  const fixture = await startAgentFixture('allibot-agents-create-');
  try {
    const created = await createAgent(fixture, CREATE_BODY);
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await readJson(created);
    const id = createdBody['id'];
    assert.equal(typeof id, 'string');
    assert.ok((id as string).length > 0, 'the backend generates the member id');

    const owner = queryDatabase<{ id: string }>(
      fixture.dataDir,
      "SELECT id FROM member WHERE kind = 'owner'",
    );
    assert.ok(owner !== undefined, 'the migration seeds the owner row');
    assert.notEqual(id, owner.id, 'the Agent id is its own opaque id, not the owner id');

    const list = await fetch(`${fixture.base}/api/agents`);
    assert.equal(list.status, 200);
    const listBody = await readJson(list);
    const agents = listBody['agents'];
    assert.ok(Array.isArray(agents), 'GET /api/agents returns an agents array');
    assert.deepEqual(
      (agents as Record<string, unknown>[]).map((agent) => agent['id']),
      [id],
      'the created Agent is the only Agent (the owner is not in the Agent list)',
    );

    const ownerDetail = await fetch(`${fixture.base}/api/agents/${owner.id}`);
    assert.equal(ownerDetail.status, 404, 'the owner is not an Agent');

    const detail = await fetch(`${fixture.base}/api/agents/${String(id)}`);
    assert.equal(detail.status, 200);
    const agent = await readJson(detail);
    assert.equal(agent['id'], id);
    assert.equal(agent['display_name'], CREATE_BODY.display_name);
    assert.equal(agent['role'], CREATE_BODY.role);
    assert.equal(agent['model'], CREATE_BODY.model);
    assert.equal(agent['system_prompt'], CREATE_BODY.system_prompt);
    assert.equal(agent['enabled'], 1);
    assert.equal(agent['context_window'], CREATE_BODY.context_window);
    assert.equal(agent['compression_threshold'], CREATE_BODY.compression_threshold);
    assert.equal(agent['max_iterations'], CREATE_BODY.max_iterations);
    assert.equal(agent['auto_claim'], 1, 'auto_claim defaults to 1 when omitted');

    const row = queryDatabase<{ kind: string; avatar_slot: number; deleted_at: string | null }>(
      fixture.dataDir,
      'SELECT kind, avatar_slot, deleted_at FROM member WHERE id = ?',
      [id],
    );
    assert.equal(row?.kind, 'agent');
    assert.equal(row?.deleted_at, null);
    assert.ok(
      Number.isInteger(row?.avatar_slot) && (row?.avatar_slot ?? -1) >= 0 && (row?.avatar_slot ?? 9) <= 4,
      `avatar_slot must be 0..4, got ${String(row?.avatar_slot)}`,
    );

    const stored = queryDatabase<{ auto_claim: number; model: string }>(
      fixture.dataDir,
      'SELECT auto_claim, model FROM agent_config WHERE member_id = ?',
      [id],
    );
    assert.equal(stored?.auto_claim, 1);
    assert.equal(stored?.model, CREATE_BODY.model);
  } finally {
    await fixture.stop();
  }
});

test('display names do not have to be unique and ids are distinct', async () => {
  const fixture = await startAgentFixture('allibot-agents-display-name-');
  try {
    const first = await createAgent(fixture, { display_name: '同名', model: 'anthropic:claude-sonnet-4-5' });
    const second = await createAgent(fixture, { display_name: '同名', model: 'openai:gpt-5' });
    assert.equal(first.status, 201, await first.clone().text());
    assert.equal(second.status, 201, await second.clone().text());

    const firstId = (await readJson(first))['id'];
    const secondId = (await readJson(second))['id'];
    assert.notEqual(firstId, secondId, 'each Agent gets its own generated id');

    const list = await readJson(await fetch(`${fixture.base}/api/agents`));
    assert.equal(
      (list['agents'] as Record<string, unknown>[]).length,
      2,
      'two Agents may share a display name',
    );
  } finally {
    await fixture.stop();
  }
});

test('auto_claim is omitted to 1 and an explicit 0 persists as 0', async () => {
  const fixture = await startAgentFixture('allibot-agents-auto-claim-');
  try {
    const defaulted = await createAgent(fixture, { display_name: '默认认领', model: 'openai:gpt-5' });
    assert.equal(defaulted.status, 201, await defaulted.clone().text());
    const defaultedId = (await readJson(defaulted))['id'];

    const disabled = await createAgent(fixture, {
      display_name: '不认领',
      model: 'openai:gpt-5',
      auto_claim: 0,
    });
    assert.equal(disabled.status, 201, await disabled.clone().text());
    const disabledId = (await readJson(disabled))['id'];

    assert.equal(
      queryDatabase<{ auto_claim: number }>(
        fixture.dataDir,
        'SELECT auto_claim FROM agent_config WHERE member_id = ?',
        [defaultedId],
      )?.auto_claim,
      1,
      'omitting auto_claim stores the default 1',
    );
    assert.equal(
      queryDatabase<{ auto_claim: number }>(
        fixture.dataDir,
        'SELECT auto_claim FROM agent_config WHERE member_id = ?',
        [disabledId],
      )?.auto_claim,
      0,
      'an explicit 0 is not overwritten by the default',
    );
  } finally {
    await fixture.stop();
  }
});

test('PATCH /api/agents/{id} updates role, system prompt and auto_claim', async () => {
  const fixture = await startAgentFixture('allibot-agents-patch-');
  try {
    const created = await createAgent(fixture, CREATE_BODY);
    assert.equal(created.status, 201, await created.clone().text());
    const id = (await readJson(created))['id'];

    const patched = await fetch(`${fixture.base}/api/agents/${String(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        role: '审稿人',
        system_prompt: 'Review carefully.',
        auto_claim: 0,
      }),
    });
    assert.equal(patched.status, 200, await patched.clone().text());

    const detail = await readJson(await fetch(`${fixture.base}/api/agents/${String(id)}`));
    assert.equal(detail['role'], '审稿人');
    assert.equal(detail['system_prompt'], 'Review carefully.');
    assert.equal(detail['auto_claim'], 0);
    assert.equal(detail['display_name'], CREATE_BODY.display_name, 'PATCH leaves other fields alone');
  } finally {
    await fixture.stop();
  }
});

test('an invalid provider:model is rejected with 400 validation_failed on create and patch', async () => {
  const fixture = await startAgentFixture('allibot-agents-invalid-model-');
  try {
    for (const model of ['gemini:pro', 'anthropic', 'anthropic:', ':claude', 'ANTHROPIC:claude']) {
      const response = await createAgent(fixture, { display_name: 'Bad Model', model });
      assert.equal(response.status, 400, `model ${model} should be rejected`);
      const body = await readJson(response);
      const error = body['error'] as Record<string, unknown>;
      assert.equal(error['code'], 'validation_failed');
      assert.equal(typeof error['message'], 'string');
    }

    const created = await createAgent(fixture, CREATE_BODY);
    assert.equal(created.status, 201);
    const id = (await readJson(created))['id'];

    const patched = await fetch(`${fixture.base}/api/agents/${String(id)}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'anthropic:' }),
    });
    assert.equal(patched.status, 400, await patched.clone().text());
    assert.equal(((await readJson(patched))['error'] as Record<string, unknown>)['code'], 'validation_failed');

    assert.equal(
      queryDatabase<{ model: string }>(
        fixture.dataDir,
        'SELECT model FROM agent_config WHERE member_id = ?',
        [id],
      )?.model,
      CREATE_BODY.model,
      'a rejected PATCH writes nothing',
    );
  } finally {
    await fixture.stop();
  }
});

test('DELETE /api/agents/{id} soft-deletes: 204, then 404, config and history rows survive', async () => {
  const fixture = await startAgentFixture('allibot-agents-delete-');
  try {
    const created = await createAgent(fixture, CREATE_BODY);
    assert.equal(created.status, 201);
    const id = (await readJson(created))['id'] as string;

    const deleted = await fetch(`${fixture.base}/api/agents/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(await deleted.text(), '', '204 carries no body');

    const row = queryDatabase<{ deleted_at: string | null }>(
      fixture.dataDir,
      'SELECT deleted_at FROM member WHERE id = ?',
      [id],
    );
    assert.ok(typeof row?.deleted_at === 'string' && row.deleted_at.length > 0, 'deleted_at is set');

    const config = queryDatabase<{ total: number }>(
      fixture.dataDir,
      'SELECT count(*) AS total FROM agent_config WHERE member_id = ?',
      [id],
    );
    assert.equal(config?.total, 1, 'agent_config is retained after a soft delete');
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM member WHERE id = ?',
        [id],
      )?.total,
      1,
      'the member row is retained',
    );

    const list = await readJson(await fetch(`${fixture.base}/api/agents`));
    assert.deepEqual(list['agents'], [], 'the deleted Agent is not listed by default');
    const listExplicit = await readJson(await fetch(`${fixture.base}/api/agents?include_deleted=false`));
    assert.deepEqual(listExplicit['agents'], [], 'include_deleted=false also hides it');

    const detail = await fetch(`${fixture.base}/api/agents/${id}`);
    assert.equal(detail.status, 404);
    const error = (await readJson(detail))['error'] as Record<string, unknown>;
    assert.equal(error['code'], 'not_found');

    const second = await fetch(`${fixture.base}/api/agents/${id}`, { method: 'DELETE' });
    assert.equal(second.status, 404, 'a second DELETE is not idempotent');

    const secondList = await readJson(await fetch(`${fixture.base}/api/agents?include_deleted=false`));
    assert.deepEqual(secondList['agents'], []);
  } finally {
    await fixture.stop();
  }
});

test('include_deleted=true is rejected instead of being silently read as false', async () => {
  const fixture = await startAgentFixture('allibot-agents-include-deleted-');
  try {
    const created = await createAgent(fixture, { display_name: '已删除', model: 'openai:gpt-5' });
    assert.equal(created.status, 201);
    const id = (await readJson(created))['id'] as string;

    const deleted = await fetch(`${fixture.base}/api/agents/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);

    const response = await fetch(`${fixture.base}/api/agents?include_deleted=true`);
    assert.equal(response.status, 400, 'the unsupported flag is a client error, not a no-op');
    assert.equal(
      ((await readJson(response))['error'] as Record<string, unknown>)['code'],
      'validation_failed',
    );

    const malformed = await fetch(`${fixture.base}/api/agents?include_deleted=maybe`);
    assert.equal(malformed.status, 400);
    assert.equal(((await readJson(malformed))['error'] as Record<string, unknown>)['code'], 'validation_failed');
  } finally {
    await fixture.stop();
  }
});

test('unsupported methods, missing fields and bad values keep the validation envelope', async () => {
  const fixture = await startAgentFixture('allibot-agents-validation-');
  try {
    const created = await createAgent(fixture, CREATE_BODY);
    assert.equal(created.status, 201, await created.clone().text());
    const id = (await readJson(created))['id'] as string;

    const invalidBodies: unknown[] = [
      { display_name: '', model: 'openai:gpt-5' },
      { display_name: 'Auto', model: 'openai:gpt-5', auto_claim: 2 },
      { display_name: 'Enabled', model: 'openai:gpt-5', enabled: 'yes' },
      { display_name: 'Window', model: 'openai:gpt-5', context_window: 0 },
      { display_name: 'Threshold', model: 'openai:gpt-5', compression_threshold: 1.5 },
      { display_name: 'Iterations', model: 'openai:gpt-5', max_iterations: -1 },
      { display_name: 'Unknown', model: 'openai:gpt-5', api_key: 'sk-secret' },
    ];
    for (const body of invalidBodies) {
      const response = await createAgent(fixture, body);
      assert.equal(response.status, 400, `body ${JSON.stringify(body)} should be rejected`);
      const error = (await readJson(response))['error'] as Record<string, unknown>;
      assert.equal(error['code'], 'validation_failed');
    }

    for (const model of ['gemini:pro', 'anthropic', 'anthropic:', ':claude', 'ANTHROPIC:claude']) {
      const response = await fetch(`${fixture.base}/api/agents/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      assert.equal(response.status, 400, `PATCH model ${model} should be rejected`);
      assert.equal(
        ((await readJson(response))['error'] as Record<string, unknown>)['code'],
        'validation_failed',
      );
    }

    const afterRejections = await readJson(await fetch(`${fixture.base}/api/agents/${id}`));
    assert.equal(afterRejections['model'], CREATE_BODY.model, 'rejected PATCHes write nothing');

    const put = await fetch(`${fixture.base}/api/agents/${id}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(CREATE_BODY),
    });
    assert.equal(put.status, 404, 'only the documented methods exist for /api/agents/{id}');
    assert.equal(((await readJson(put))['error'] as Record<string, unknown>)['code'], 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('malformed JSON and unknown routes keep the unified error envelope', async () => {
  const fixture = await startAgentFixture('allibot-agents-envelope-');
  try {
    const malformed = await fetch(`${fixture.base}/api/agents`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"display_name":',
    });
    assert.equal(malformed.status, 400);
    const error = (await readJson(malformed))['error'] as Record<string, unknown>;
    assert.equal(error['code'], 'validation_failed');

    const unknown = await fetch(`${fixture.base}/api/agents/does-not-exist`);
    assert.equal(unknown.status, 404);
    assert.equal(((await readJson(unknown))['error'] as Record<string, unknown>)['code'], 'not_found');

    const unknownRoute = await fetch(`${fixture.base}/api/agents/extra/segment`);
    assert.equal(unknownRoute.status, 404);
    assert.equal(((await readJson(unknownRoute))['error'] as Record<string, unknown>)['code'], 'not_found');

    const missingDisplayName = await createAgent(fixture, { model: 'anthropic:claude-sonnet-4-5' });
    assert.equal(missingDisplayName.status, 400, 'a display name is required');
    assert.equal(
      ((await readJson(missingDisplayName))['error'] as Record<string, unknown>)['code'],
      'validation_failed',
    );
  } finally {
    await fixture.stop();
  }
});
