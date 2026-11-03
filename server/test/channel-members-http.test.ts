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

interface ChannelFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

const CHANNEL_BODY = {
  name: '研究频道',
  description: '讨论论文与实验',
  mode: 'autonomous',
  response_budget_limit: 5,
};

async function startChannelFixture(prefix: string): Promise<ChannelFixture> {
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

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: ChannelFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

test('joining a channel with an Agent is idempotent and reports joined true then false once', async () => {
  const fixture = await startChannelFixture('allibot-channel-join-');
  try {
    const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
    assert.equal(created.status, 201, await created.clone().text());
    const channelId = (await readJson(created))['id'] as string;

    const createdAgent = await postJson(fixture, '/api/agents', {
      display_name: 'Joiner',
      model: 'openai:gpt-5',
    });
    assert.equal(createdAgent.status, 201, await createdAgent.clone().text());
    const agentId = (await readJson(createdAgent))['id'] as string;

    const first = await postJson(fixture, `/api/channels/${channelId}/members`, { member_id: agentId });
    assert.equal(first.status, 200, await first.clone().text());
    assert.deepEqual(await readJson(first), { joined: true });

    const second = await postJson(fixture, `/api/channels/${channelId}/members`, { member_id: agentId });
    assert.equal(second.status, 200, await second.clone().text());
    assert.deepEqual(await readJson(second), { joined: false }, 'the second join is idempotent');

    const members = await fetch(`${fixture.base}/api/channels/${channelId}/members`);
    assert.equal(members.status, 200);
    const memberList = (await readJson(members))['members'] as Record<string, unknown>[];
    const owner = queryDatabase<{ id: string; display_name: string; avatar_slot: number }>(
      fixture.dataDir,
      "SELECT id, display_name, avatar_slot FROM member WHERE kind = 'owner'",
    );
    assert.ok(owner !== undefined);
    assert.deepEqual(
      memberList.map((member) => member['id']).sort(),
      [owner.id, agentId].sort(),
      'owner and Agent each appear exactly once',
    );
    const ownerView = memberList.find((member) => member['id'] === owner.id);
    assert.equal(ownerView?.['kind'], 'owner');
    assert.equal(ownerView?.['display_name'], owner.display_name);
    assert.equal(ownerView?.['avatar_slot'], owner.avatar_slot);
    const agentView = memberList.find((member) => member['id'] === agentId);
    assert.equal(agentView?.['kind'], 'agent');
    assert.equal(agentView?.['display_name'], 'Joiner');

    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ?',
        [channelId],
      )?.total,
      2,
      'owner and Agent give exactly two target_member rows',
    );

    const byTarget = await fetch(`${fixture.base}/api/targets/${channelId}/members`);
    assert.equal(byTarget.status, 200);
    const targetMembers = (await readJson(byTarget))['members'] as Record<string, unknown>[];
    assert.deepEqual(
      targetMembers.map((member) => member['id']).sort(),
      [owner.id, agentId].sort(),
      'GET /api/targets/{id}/members reads the channel target members',
    );

    const unknownChannel = await postJson(fixture, '/api/channels/does-not-exist/members', {
      member_id: agentId,
    });
    assert.equal(unknownChannel.status, 404);
    assert.equal(errorCode(await readJson(unknownChannel)), 'not_found');

    const unknownMember = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: 'does-not-exist',
    });
    assert.equal(unknownMember.status, 404, 'joining an unknown Agent is not_found');
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ?',
        [channelId],
      )?.total,
      2,
      'a rejected join writes no row',
    );

    const ownerJoin = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: owner.id,
    });
    assert.equal(ownerJoin.status, 400, 'joining only accepts Agents; the owner is in by creation');
    assert.equal(errorCode(await readJson(ownerJoin)), 'validation_failed');

    const deletedAgent = await postJson(fixture, '/api/agents', {
      display_name: 'Leaving',
      model: 'openai:gpt-5',
    });
    const deletedAgentId = (await readJson(deletedAgent))['id'] as string;
    const deleteResponse = await fetch(`${fixture.base}/api/agents/${deletedAgentId}`, {
      method: 'DELETE',
    });
    assert.equal(deleteResponse.status, 204);
    const joinDeleted = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: deletedAgentId,
    });
    assert.equal(joinDeleted.status, 404, 'a soft-deleted Agent cannot join');
  } finally {
    await fixture.stop();
  }
});

test('soft-deleting an Agent removes it from channel members and every target_member row', async () => {
  const fixture = await startChannelFixture('allibot-channel-member-cleanup-');
  try {
    const created = await postJson(fixture, '/api/channels', CHANNEL_BODY);
    const channelId = (await readJson(created))['id'] as string;
    const agent = await postJson(fixture, '/api/agents', {
      display_name: 'Leaver',
      model: 'openai:gpt-5',
    });
    const agentId = (await readJson(agent))['id'] as string;

    // A second channel and a task thread prove the cleanup spans every target
    // kind, not just the channel under test. The task thread's Agent membership
    // is written by the ordinary assignment path.
    const other = await postJson(fixture, '/api/channels', { ...CHANNEL_BODY, name: '另一个频道' });
    const otherChannelId = (await readJson(other))['id'] as string;
    const task = await postJson(fixture, '/api/tasks', {
      channel_id: otherChannelId,
      title: '清理用的任务',
    });
    assert.equal(task.status, 201, await task.clone().text());
    const taskBody = await readJson(task);
    const taskTargetId = taskBody['target_id'] as string;
    const assigned = await fetch(`${fixture.base}/api/tasks/${String(taskBody['id'])}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assignee_member_id: agentId }),
    });
    assert.equal(assigned.status, 200, await assigned.clone().text());
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ? AND member_id = ?',
        [taskTargetId, agentId],
      )?.total,
      1,
      'the assignment put the Agent on the task thread',
    );
    const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
      member_id: agentId,
    });
    assert.deepEqual(await readJson(joined), { joined: true });
    const joinedOther = await postJson(fixture, `/api/channels/${otherChannelId}/members`, {
      member_id: agentId,
    });
    assert.deepEqual(await readJson(joinedOther), { joined: true });
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE member_id = ?',
        [agentId],
      )?.total,
      3,
      'the Agent sits on two channels and one task thread before deletion',
    );

    const deleted = await fetch(`${fixture.base}/api/agents/${agentId}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);

    const members = (await readJson(await fetch(`${fixture.base}/api/channels/${channelId}/members`)))[
      'members'
    ] as Record<string, unknown>[];
    assert.deepEqual(
      members.map((member) => member['id']).filter((id) => id === agentId),
      [],
      'the deleted Agent is gone from the channel member list',
    );

    const targetMembers = (
      await readJson(await fetch(`${fixture.base}/api/targets/${channelId}/members`))
    )['members'] as Record<string, unknown>[];
    assert.deepEqual(
      targetMembers.map((member) => member['id']).filter((id) => id === agentId),
      [],
      'the deleted Agent is gone from the target member list',
    );

    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE member_id = ?',
        [agentId],
      )?.total,
      0,
      'no target_member row survives the Agent soft delete',
    );
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM member WHERE id = ?',
        [agentId],
      )?.total,
      1,
      'the member row itself is retained',
    );
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM target_member WHERE target_id = ?',
        [channelId],
      )?.total,
      1,
      'the owner is still a channel member',
    );
  } finally {
    await fixture.stop();
  }
});
