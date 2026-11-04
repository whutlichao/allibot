import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import {
  MIGRATION_FIXTURE,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 工作区项目根、工作区后端与目标上下文 workspace_status (#42 / D2.2 / D5.1 /
 * D5.3 / D5.7), observed at the process-level HTTP seam and from the data
 * directory the process wrote.
 *
 * The write path validates the root (absolute, existing, directory, realpath
 * outside the data directory and Agent homes), stores its realpath, and stays
 * a configuration write: no message, wake, budget or history/task row. The read
 * models add `workspace` to the channel, `workspace_backend` to the Agent and
 * the per-target `workspace_status` to the member readings.
 */

interface WorkspaceFixture {
  tmp: string;
  dataDir: string;
  home: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startWorkspaceFixture(prefix: string): Promise<WorkspaceFixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'reply'],
    env: { HOME: home },
  });
  return {
    tmp,
    dataDir,
    home,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await removeTempDir(tmp);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
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

function errorCode(body: Record<string, unknown>): unknown {
  return (body['error'] as Record<string, unknown> | undefined)?.['code'];
}

async function createAgent(
  fixture: WorkspaceFixture,
  displayName = '工作区成员',
): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createChannel(
  fixture: WorkspaceFixture,
  name = '工作区频道',
): Promise<string> {
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

async function getChannel(fixture: WorkspaceFixture, channelId: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/channels/${channelId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function getTargetMembers(
  fixture: WorkspaceFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/members`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await readJson(response);
  return body['members'] as Record<string, unknown>[];
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

function countRows(dataDir: string, table: string): number {
  return (
    queryDatabase<{ total: number }>(dataDir, `SELECT count(*) AS total FROM ${table}`)?.total ?? -1
  );
}

test('PATCH validates the workspace root and stores its canonical path', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-root-validation-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture);
    const project = path.join(fixture.tmp, 'project');
    const second = path.join(fixture.tmp, 'second');
    const nestedDataDir = path.join(fixture.dataDir, 'nested');
    const agentHome = path.join(fixture.home, '.allibot', 'agents', agentId, 'project');
    mkdirSync(project, { recursive: true });
    mkdirSync(second, { recursive: true });
    mkdirSync(nestedDataDir, { recursive: true });
    mkdirSync(agentHome, { recursive: true });
    const file = path.join(fixture.tmp, 'a-file.txt');
    writeFileSync(file, 'not a directory');

    const invalid: [string, unknown][] = [
      ['relative path', 'relative/project'],
      ['missing path', path.join(fixture.tmp, 'missing')],
      ['a file', file],
      ['the data directory', fixture.dataDir],
      ['inside the data directory', nestedDataDir],
      ['an Agent home', agentHome],
      ['a symlink into the data directory', path.join(fixture.tmp, 'data-link')],
      ['a non-string', 42],
      ['an empty string', ''],
    ];
    symlinkSync(fixture.dataDir, path.join(fixture.tmp, 'data-link'));

    for (const [label, root] of invalid) {
      const response = await patchJson(fixture, `/api/channels/${channelId}`, {
        workspace_root: root,
      });
      const body = await readJson(response);
      assert.equal(response.status, 400, `${label} should be 400: ${JSON.stringify(body)}`);
      assert.equal(errorCode(body), 'validation_failed', `${label} should be validation_failed`);
      assert.deepEqual(
        (await getChannel(fixture, channelId))['workspace'],
        { root: null, backend: 'local', allow_local_shell: 0 },
        'no invalid write reached the reading',
      );
    }
    assert.equal(
      queryDatabase<{ workspace_root: unknown }>(
        fixture.dataDir,
        'SELECT workspace_root FROM channel WHERE id = ?',
        [channelId],
      )?.workspace_root,
      null,
      'every rejected root left the column NULL',
    );

    const valid = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: project,
    });
    assert.equal(valid.status, 200, await valid.clone().text());
    const canonical = realpathSync(project);
    assert.deepEqual((await readJson(valid))['workspace'], {
      root: canonical,
      backend: 'local',
      allow_local_shell: 0,
    });

    // A valid symlink is accepted and stored as its realpath.
    const link = path.join(fixture.tmp, 'project-link');
    symlinkSync(project, link);
    const linked = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: link,
    });
    assert.equal(linked.status, 200, await linked.clone().text());
    assert.equal(
      ((await readJson(linked))['workspace'] as Record<string, unknown>)['root'],
      canonical,
    );

    const detail = await getChannel(fixture, channelId);
    assert.deepEqual(detail['workspace'], {
      root: canonical,
      backend: 'local',
      allow_local_shell: 0,
    });

    const cleared = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: null,
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    assert.deepEqual((await readJson(cleared))['workspace'], {
      root: null,
      backend: 'local',
      allow_local_shell: 0,
    });

    const badBackend = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_backend: 'podman',
    });
    assert.equal(badBackend.status, 400);
    assert.equal(errorCode(await readJson(badBackend)), 'validation_failed');
    const nullBackend = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_backend: null,
    });
    assert.equal(nullBackend.status, 400, 'only the root may be cleared with null');
    const docker = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_backend: 'docker',
    });
    assert.equal(docker.status, 200, await docker.clone().text());
    assert.deepEqual((await readJson(docker))['workspace'], {
      root: null,
      backend: 'docker',
      allow_local_shell: 0,
    });
    assert.equal(
      (await getChannel(fixture, channelId))['workspace_backend'],
      undefined,
      'the backend lives inside workspace, not at the channel top level',
    );
  } finally {
    await fixture.stop();
  }
});

test('workspace configuration writes no message, wake, budget or history row and replays idempotently', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-root-side-effects-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture);
    await joinChannel(fixture, channelId, agentId);
    const task = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '配置期间保持原样',
    });
    assert.equal(task.status, 201, await task.clone().text());
    const taskId = (await readJson(task))['id'] as string;
    const beforeTask = queryDatabase<Record<string, unknown>>(
      fixture.dataDir,
      'SELECT * FROM task WHERE id = ?',
      [taskId],
    );
    const before = {
      message: countRows(fixture.dataDir, 'message'),
      channelMessage:
        queryDatabase<{ total: number }>(
          fixture.dataDir,
          'SELECT count(*) AS total FROM message WHERE target_id = ?',
          [channelId],
        )?.total ?? -1,
      round_outcome: countRows(fixture.dataDir, 'round_outcome'),
      target_budget: countRows(fixture.dataDir, 'target_budget'),
      task: countRows(fixture.dataDir, 'task'),
    };
    const first = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: fixture.tmp,
      workspace_backend: 'local',
    });
    assert.equal(first.status, 200, await first.clone().text());
    const firstBody = await readJson(first);

    const same = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: firstBody['workspace'] && (firstBody['workspace'] as Record<string, unknown>)['root'],
      workspace_backend: 'local',
    });
    assert.equal(same.status, 200, await same.clone().text());
    assert.deepEqual(
      await readJson(same),
      firstBody,
      'a same-value replay returns the same reading including updated_at',
    );

    assert.deepEqual(
      {
        message: countRows(fixture.dataDir, 'message'),
        channelMessage:
          queryDatabase<{ total: number }>(
            fixture.dataDir,
            'SELECT count(*) AS total FROM message WHERE target_id = ?',
            [channelId],
          )?.total ?? -1,
        round_outcome: countRows(fixture.dataDir, 'round_outcome'),
        target_budget: countRows(fixture.dataDir, 'target_budget'),
        task: countRows(fixture.dataDir, 'task'),
      },
      before,
      'the configuration write lands no message, wake, budget or task row',
    );
    assert.deepEqual(
      queryDatabase<Record<string, unknown>>(
        fixture.dataDir,
        'SELECT * FROM task WHERE id = ?',
        [taskId],
      ),
      beforeTask,
      'the task row is unchanged',
    );
    assert.equal(
      queryDatabase<{ total: number }>(
        fixture.dataDir,
        'SELECT count(*) AS total FROM message WHERE target_id = ?',
        [channelId],
      )?.total,
      before.channelMessage,
    );
  } finally {
    await fixture.stop();
  }
});

test('archived channels reject a workspace write with 400 and deleted channels with 404', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-root-lifecycle-');
  try {
    const archived = await createChannel(fixture, '归档频道');
    const archive = await postJson(fixture, `/api/channels/${archived}/archive`, {});
    assert.equal(archive.status, 200, await archive.clone().text());
    const archivedWrite = await patchJson(fixture, `/api/channels/${archived}`, {
      workspace_root: fixture.tmp,
    });
    assert.equal(archivedWrite.status, 400);
    assert.equal(errorCode(await readJson(archivedWrite)), 'validation_failed');
    assert.deepEqual((await getChannel(fixture, archived))['workspace'], {
      root: null,
      backend: 'local',
      allow_local_shell: 0,
    });

    const deleted = await createChannel(fixture, '删除频道');
    const remove = await fetch(`${fixture.base}/api/channels/${deleted}`, { method: 'DELETE' });
    assert.equal(remove.status, 204);
    const deletedWrite = await patchJson(fixture, `/api/channels/${deleted}`, {
      workspace_root: fixture.tmp,
    });
    assert.equal(deletedWrite.status, 404);
    assert.equal(errorCode(await readJson(deletedWrite)), 'not_found');
  } finally {
    await fixture.stop();
  }
});

test('the workspace reading carries the channel workspace, Agent override and target workspace_status', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-root-read-models-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture);
    await joinChannel(fixture, channelId, agentId);
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(project, { recursive: true });
    const canonical = realpathSync(project);

    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: project,
    });
    assert.equal(patched.status, 200, await patched.clone().text());

    const channel = await getChannel(fixture, channelId);
    const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
    const channelReading = (workspace['channels'] as Record<string, unknown>[]).find(
      (row) => row['id'] === channelId,
    );
    assert.ok(channelReading !== undefined);
    assert.deepEqual(
      channelReading['workspace'],
      channel['workspace'],
      'GET /api/workspace and GET /api/channels/{id} carry the same workspace reading',
    );
    assert.deepEqual(channel['workspace'], {
      root: canonical,
      backend: 'local',
      allow_local_shell: 0,
    });

    const agent = await readJson(await fetch(`${fixture.base}/api/agents/${agentId}`));
    assert.equal(agent['workspace_backend'], null);
    const agentReading = (workspace['agents'] as Record<string, unknown>[]).find(
      (row) => row['id'] === agentId,
    );
    assert.equal(agentReading?.['workspace_backend'], null);
    assert.deepEqual(
      agentReading?.['workspace_backend'],
      agent['workspace_backend'],
      'GET /api/workspace and GET /api/agents/{id} carry the same override',
    );

    let members = await getTargetMembers(fixture, channelId);
    assert.equal(members.length, 2, 'the owner and the Agent are channel members');
    for (const member of members) {
      assert.deepEqual(member['workspace_status'], {
        backend: 'local',
        available: true,
        reason: null,
      });
    }

    const override = await patchJson(fixture, `/api/agents/${agentId}`, {
      workspace_backend: 'docker',
    });
    assert.equal(override.status, 200, await override.clone().text());
    assert.equal((await readJson(override))['workspace_backend'], 'docker');
    members = await getTargetMembers(fixture, channelId);
    const ownerRow = members.find((member) => member['kind'] === 'owner');
    const agentRow = members.find((member) => member['id'] === agentId);
    assert.deepEqual(ownerRow?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });
    assert.deepEqual(agentRow?.['workspace_status'], {
      backend: 'docker',
      available: false,
      reason: 'docker-unavailable',
    });

    const invalidOverride = await patchJson(fixture, `/api/agents/${agentId}`, {
      workspace_backend: 'podman',
    });
    assert.equal(invalidOverride.status, 400);
    assert.equal(errorCode(await readJson(invalidOverride)), 'validation_failed');

    const clearedOverride = await patchJson(fixture, `/api/agents/${agentId}`, {
      workspace_backend: null,
    });
    assert.equal(clearedOverride.status, 200, await clearedOverride.clone().text());
    assert.equal((await readJson(clearedOverride))['workspace_backend'], null);
    members = await getTargetMembers(fixture, channelId);
    assert.deepEqual(members.find((member) => member['id'] === agentId)?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });

    const dockerChannel = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_backend: 'docker',
    });
    assert.equal(dockerChannel.status, 200, await dockerChannel.clone().text());
    members = await getTargetMembers(fixture, channelId);
    assert.deepEqual(members.find((member) => member['kind'] === 'owner')?.['workspace_status'], {
      backend: 'docker',
      available: false,
      reason: 'docker-unavailable',
    });
    assert.deepEqual(members.find((member) => member['id'] === agentId)?.['workspace_status'], {
      backend: 'docker',
      available: false,
      reason: 'docker-unavailable',
    });

    const localOverride = await patchJson(fixture, `/api/agents/${agentId}`, {
      workspace_backend: 'local',
    });
    assert.equal(localOverride.status, 200, await localOverride.clone().text());
    members = await getTargetMembers(fixture, channelId);
    assert.deepEqual(members.find((member) => member['kind'] === 'owner')?.['workspace_status'], {
      backend: 'docker',
      available: false,
      reason: 'docker-unavailable',
    });
    assert.deepEqual(members.find((member) => member['id'] === agentId)?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });

    const tasks = await fetch(`${fixture.base}/api/tasks`);
    assert.equal(tasks.status, 200, 'the M1 task reading is untouched');
    assert.deepEqual(await readJson(tasks), { tasks: [] });
  } finally {
    await fixture.stop();
  }
});

test('a missing runtime root reads workspace-root-missing on the target members', async () => {
  const fixture = await startWorkspaceFixture('allibot-workspace-root-missing-read-');
  try {
    const channelId = await createChannel(fixture);
    const agentId = await createAgent(fixture);
    await joinChannel(fixture, channelId, agentId);
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(project, { recursive: true });
    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_root: project,
    });
    assert.equal(patched.status, 200, await patched.clone().text());
    rmSync(project, { recursive: true, force: true });

    const members = await getTargetMembers(fixture, channelId);
    for (const member of members) {
      assert.deepEqual(member['workspace_status'], {
        backend: 'local',
        available: false,
        reason: 'workspace-root-missing',
      });
    }
    const noRootChannel = await createChannel(fixture, '无根频道');
    const noRootMembers = await getTargetMembers(fixture, noRootChannel);
    assert.equal(noRootMembers.length, 1);
    assert.deepEqual(noRootMembers[0]!['workspace_status'], {
      backend: 'local',
      available: false,
      reason: 'workspace-root-missing',
    });

    const dm = await postJson(fixture, '/api/dms', { agent_id: agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmId = (await readJson(dm))['id'] as string;
    const dmMembers = await getTargetMembers(fixture, dmId);
    assert.equal(dmMembers.length, 2);
    for (const member of dmMembers) {
      assert.deepEqual(member['workspace_status'], {
        backend: 'local',
        available: false,
        reason: 'workspace-root-missing',
      });
    }
  } finally {
    await fixture.stop();
  }
});

test('the whole-directory backup does not copy the project root', async () => {
  const tmp = mkdtempSync(path.join(tmpdir(), 'allibot-workspace-root-backup-'));
  const dataDir = path.join(tmp, 'data');
  const project = path.join(tmp, 'project');
  try {
    const fixture = spawnSync(process.execPath, [MIGRATION_FIXTURE, 'v17', dataDir], {
      encoding: 'utf8',
    });
    assert.equal(fixture.status, 0, fixture.stderr);
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'PROJECT-SENTINEL.txt'), 'project bytes');
    writeFileSync(path.join(project, 'allibot.db'), 'not the database');

    const migrated = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migrated.exitCode, 0, migrated.output);
    const backups = readdirSyncSafe(tmp).filter((entry) => entry.startsWith('data.backup-'));
    assert.equal(backups.length, 1);
    const backup = path.join(tmp, backups[0]!);
    assert.equal(
      existsInTree(backup, 'PROJECT-SENTINEL.txt'),
      false,
      'the backup copies the data directory, never the project root',
    );
    assert.equal(
      existsInTree(project, 'schema-migrations.jsonl'),
      false,
      'the migration writes only its data directory, never the project root',
    );
    assert.equal(existsInTree(project, 'allibot.db'), true, 'the project sentinel stays put');
    assert.equal(
      existsInTree(dataDir, 'PROJECT-SENTINEL.txt'),
      false,
      'the data directory does not absorb project files',
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir);
}

function existsInTree(dir: string, name: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === name) {
      return true;
    }
    if (entry.isDirectory() && existsInTree(path.join(dir, entry.name), name)) {
      return true;
    }
  }
  return false;
}
