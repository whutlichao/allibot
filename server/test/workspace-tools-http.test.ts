import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
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
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * 成员面文件工具 (#42 / D5.1 / D5.2 / D5.3), observed through the one process
 * seam: a real backend, the scripted provider calling the round's file-tool
 * face, and the reply message / SQLite rows / files on disk as the evidence.
 *
 * The project root is the only writable root; `..`, outside absolute paths and
 * symlinks resolving outside are tool errors, never approvals. The member
 * `skills/` directory is a read-only second root. A DM and a no-root round have
 * neither project file tools nor a shell. A vanished root or the docker backend
 * fails the round with a readable reason and zero tool calls.
 */

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startFixture(prefix: string): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'workspace'],
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

async function postJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(fixture: Fixture, displayName = '文件工具成员'): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createChannel(fixture: Fixture, name = '文件工具频道'): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(fixture: Fixture, channelId: string, memberId: string): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function configureRoot(fixture: Fixture, channelId: string, root: string): Promise<void> {
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    workspace_root: root,
  });
  assert.equal(patched.status, 200, await patched.clone().text());
}

async function sendMessage(fixture: Fixture, targetId: string, body: string): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

async function messages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages?limit=50`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

function roundOutcome(
  dataDir: string,
  memberId: string,
  targetId: string,
): Record<string, unknown> | undefined {
  return queryDatabase<Record<string, unknown>>(
    dataDir,
    `SELECT status, reason FROM round_outcome
      WHERE member_id = ? AND target_id = ?
      ORDER BY rowid DESC LIMIT 1`,
    [memberId, targetId],
  );
}

test('a local round with a project root reads, writes and edits inside the root and rejects escapes', async () => {
  const fixture = await startFixture('allibot-workspace-tools-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(path.join(project, 'sub'), { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'NEEDLE-ONE\nsecond line\n');
    writeFileSync(path.join(project, 'sub', 'second.txt'), 'NEEDLE-TWO\n');
    const outsideDir = path.join(fixture.tmp, 'outside-dir');
    mkdirSync(outsideDir, { recursive: true });
    writeFileSync(path.join(fixture.tmp, 'outside.txt'), 'OUTSIDE-SECRET\n');
    writeFileSync(path.join(outsideDir, 'outside.txt'), 'SYMLINK-SECRET\n');
    symlinkSync(outsideDir, path.join(project, 'escape'));
    const skills = path.join(fixture.home, '.allibot', 'agents', agentId, 'skills', 'demo');
    mkdirSync(skills, { recursive: true });
    const skillFile = path.join(skills, 'SKILL.md');
    writeFileSync(skillFile, 'SKILL-NEEDLE\nskill body\n');

    await configureRoot(fixture, channelId, project);
    await sendMessage(fixture, channelId, '请检查工作区');

    const rows = await messages(fixture, channelId);
    const reply = rows.find((row) => row['kind'] === 'agent');
    assert.ok(reply !== undefined, 'the scripted round should answer');
    const body = reply['body'] as string;
    const canonical = realpathSync(project);

    assert.match(body, new RegExp(`\\[workspace\\] root:${escapeRegExp(canonical)} backend:local shell:0`));
    assert.match(body, /\[workspace-tools\] Read,Glob,Grep,Write,Edit/);
    assert.doesNotMatch(body, /Bash|shell:1/);
    assert.match(body, /\[workspace-read\] ok path:notes\.txt content:NEEDLE-ONE/);
    assert.match(body, /\[workspace-glob\] ok paths:notes\.txt,sub\/second\.txt/);
    assert.match(body, /\[workspace-grep\] ok matches:2/);
    assert.match(body, /\[workspace-absolute-inside\] ok path:notes\.txt content:NEEDLE-ONE/);
    assert.match(body, /\[workspace-write\] ok path:written\.txt/);
    assert.match(body, /\[workspace-edit\] ok path:written\.txt replacements:1/);
    assert.match(body, /\[workspace-reread\] ok path:written\.txt content:edited-by-tool/);
    assert.match(body, /\[workspace-dotdot\] error:outside-root/);
    assert.match(body, /\[workspace-absolute\] error:outside-root/);
    assert.match(body, /\[workspace-symlink\] error:outside-root/);
    assert.match(body, /\[workspace-skills-read\] ok path:demo\/SKILL\.md content:SKILL-NEEDLE/);
    assert.match(body, /\[workspace-skills-glob\] ok paths:demo\/SKILL\.md/);
    assert.match(body, /\[workspace-skills-grep\] ok matches:1/);
    assert.match(body, /\[workspace-skills-write\] error:read-only/);
    assert.match(body, /\[workspace-skills-edit\] error:read-only/);

    assert.equal(
      readFileSync(path.join(project, 'written.txt'), 'utf8'),
      'edited-by-tool',
      'Write then Edit changed the file inside the root',
    );
    assert.equal(readFileSync(skillFile, 'utf8'), 'SKILL-NEEDLE\nskill body\n', 'skills are read-only');
    assert.equal(
      readFileSync(path.join(outsideDir, 'outside.txt'), 'utf8'),
      'SYMLINK-SECRET\n',
      'the escaping symlink target was not read or written',
    );
    assert.equal(existsSync(path.join(project, '..', 'outside.txt')), true);

    assert.deepEqual(
      roundOutcome(fixture.dataDir, agentId, channelId)?.['status'],
      'replied',
      'tool errors do not fail the round',
    );
    const approvalTable = queryDatabase<{ name: string }>(
      fixture.dataDir,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'approval_request'",
    );
    const approvalRows =
      approvalTable === undefined
        ? 0
        : (queryDatabase<{ total: number }>(
            fixture.dataDir,
            'SELECT count(*) AS total FROM approval_request',
          )?.total ?? 0);
    assert.equal(
      approvalRows,
      0,
      'no approval request exists for a root escape (approvals arrive in #44)',
    );
    assert.equal(
      rows.length,
      2,
      'only the human message and the round reply are messages',
    );
  } finally {
    await fixture.stop();
  }
});

test('a DM and a channel with no project root have no project file tools and no shell', async () => {
  const fixture = await startFixture('allibot-workspace-tools-noroot-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, '无根频道');
    await joinChannel(fixture, channelId, agentId);
    await sendMessage(fixture, channelId, '没有项目根');
    const channelReply = (await messages(fixture, channelId)).find(
      (row) => row['kind'] === 'agent',
    );
    assert.ok(channelReply !== undefined);
    const channelBody = channelReply['body'] as string;
    assert.match(channelBody, /\[workspace\] available:false/);
    assert.match(channelBody, /\[workspace-tools\] -/);
    assert.doesNotMatch(channelBody, /Read|Glob|Grep|Write|Edit|Bash/);

    const dm = await postJson(fixture, '/api/dms', { agent_id: agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmId = (await readJson(dm))['id'] as string;
    await sendMessage(fixture, dmId, '私信没有项目根');
    const dmReply = (await messages(fixture, dmId)).find((row) => row['kind'] === 'agent');
    assert.ok(dmReply !== undefined);
    const dmBody = dmReply['body'] as string;
    assert.match(dmBody, /\[workspace\] available:false/);
    assert.match(dmBody, /\[workspace-tools\] -/);
    assert.doesNotMatch(dmBody, /Read|Glob|Grep|Write|Edit|Bash/);
  } finally {
    await fixture.stop();
  }
});

test('a vanished root fails the round with a readable reason, zero tool calls and no fallback', async () => {
  const fixture = await startFixture('allibot-workspace-tools-missing-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'PROJECT-BEFORE-DELETE\n');
    writeFileSync(path.join(fixture.dataDir, 'notes.txt'), 'DATA-DIR-SENTINEL\n');
    await configureRoot(fixture, channelId, project);
    rmSync(project, { recursive: true, force: true });

    await sendMessage(fixture, channelId, '根已经消失');

    const rows = await messages(fixture, channelId);
    assert.equal(rows.length, 1, 'the human message lands; no reply and no tool result');
    assert.equal(
      rows.some((row) => (row['body'] as string).includes('[workspace]')),
      false,
      'the provider never ran, so no tool call happened',
    );
    const outcome = roundOutcome(fixture.dataDir, agentId, channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(outcome?.['reason'] as string, /workspace-root-missing/);
    assert.match(outcome?.['reason'] as string, /工作区不可用/);
    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'notes.txt'), 'utf8'),
      'DATA-DIR-SENTINEL\n',
      'the round did not fall back to the data directory',
    );

    const membersResponse = await fetch(`${fixture.base}/api/targets/${channelId}/members`);
    assert.equal(membersResponse.status, 200);
    const members = (await readJson(membersResponse))['members'] as Record<string, unknown>[];
    for (const member of members) {
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

test('an unreadable runtime root also reads workspace-root-missing and fails the round', async () => {
  const fixture = await startFixture('allibot-workspace-tools-unreadable-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'UNREADABLE-ROOT\n');
    await configureRoot(fixture, channelId, project);
    chmodSync(project, 0o000);

    const membersResponse = await fetch(`${fixture.base}/api/targets/${channelId}/members`);
    const members = (await readJson(membersResponse))['members'] as Record<string, unknown>[];
    for (const member of members) {
      assert.deepEqual(member['workspace_status'], {
        backend: 'local',
        available: false,
        reason: 'workspace-root-missing',
      });
    }

    await sendMessage(fixture, channelId, '根不可读');
    const rows = await messages(fixture, channelId);
    assert.equal(rows.length, 1, 'the round failed before the provider produced a reply');
    const outcome = roundOutcome(fixture.dataDir, agentId, channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(outcome?.['reason'] as string, /workspace-root-missing/);
  } finally {
    // Restore the mode so the temp-directory cleanup can remove the tree.
    const project = path.join(fixture.tmp, 'project');
    if (existsSync(project)) {
      chmodSync(project, 0o700);
    }
    await fixture.stop();
  }
});

test('the docker backend fails the round with docker-unavailable and never falls back to local tools', async () => {
  const fixture = await startFixture('allibot-workspace-tools-docker-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'LOCAL-TOOLS-MUST-NOT-RUN\n');
    await configureRoot(fixture, channelId, project);
    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      workspace_backend: 'docker',
    });
    assert.equal(patched.status, 200, await patched.clone().text());

    await sendMessage(fixture, channelId, 'Docker 不可用');

    const rows = await messages(fixture, channelId);
    assert.equal(rows.length, 1, 'the round failed before the provider: no reply');
    assert.equal(
      rows.some((row) => (row['body'] as string).includes('LOCAL-TOOLS')),
      false,
    );
    const outcome = roundOutcome(fixture.dataDir, agentId, channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(outcome?.['reason'] as string, /docker-unavailable/);
    assert.equal(
      readFileSync(path.join(project, 'notes.txt'), 'utf8'),
      'LOCAL-TOOLS-MUST-NOT-RUN\n',
    );
    assert.equal(
      existsSync(path.join(project, 'written.txt')),
      false,
      'the local file tools did not run',
    );
    const membersResponse = await fetch(`${fixture.base}/api/targets/${channelId}/members`);
    const members = (await readJson(membersResponse))['members'] as Record<string, unknown>[];
    for (const member of members) {
      assert.deepEqual(member['workspace_status'], {
        backend: 'docker',
        available: false,
        reason: 'docker-unavailable',
      });
    }
  } finally {
    await fixture.stop();
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
