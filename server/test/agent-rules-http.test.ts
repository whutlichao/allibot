import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
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
 * Agent 家目录、全局层 / 项目层与规则基座 (#43 / D2.2 / D2.3 / D5.1 / D5.2).
 *
 * Observed through the one process seam: a real backend, the scripted provider
 * reporting the prompt sections it was handed, the human REST face, SQLite
 * rows and the files on disk. Every fixture uses a temporary HOME; the real
 * `~/.allibot/` is never read or written.
 */

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

async function startFixture(
  prefix: string,
  options: { args?: readonly string[]; env?: NodeJS.ProcessEnv; home?: string } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = options.home ?? path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: options.args ?? [],
    env: { HOME: home, ...options.env },
  });
  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    running,
    base: `http://127.0.0.1:${running.port}`,
    // The test replaces `fixture.running` when it restarts the backend, so the
    // teardown must read the current server, not the one this closure saw.
    stop: async () => {
      await fixture.running.stop();
      await removeTempDir(tmp);
    },
  };
  return fixture;
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

async function createAgent(
  fixture: Fixture,
  body: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '规则成员',
    model: 'openai:gpt-5',
    ...body,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return await readJson(created);
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

function allDatabaseRows(
  dataDir: string,
  sql: string,
  params: unknown[] = [],
): Record<string, unknown>[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

test('POST /api/agents creates the Agent home and exposes the derived home_path', async () => {
  const fixture = await startFixture('allibot-agent-home-');
  try {
    const agent = await createAgent(fixture);
    const id = agent['id'] as string;
    const expectedHome = path.join(fixture.home, '.allibot', 'agents', id);

    assert.equal(agent['home_path'], expectedHome, 'the create response carries the derived home');
    assert.equal(existsSync(expectedHome), true, 'the Agent home directory exists');
    assert.equal(statSync(expectedHome).isDirectory(), true);
    assert.deepEqual(readdirSync(expectedHome), [], 'the home starts empty');
    assert.equal(
      existsSync(path.join(fixture.home, '.allibot', 'skills')),
      false,
      'startup / create never makes the global public skills directory',
    );

    const detail = await fetch(`${fixture.base}/api/agents/${id}`);
    assert.equal(detail.status, 200);
    assert.equal((await readJson(detail))['home_path'], expectedHome);

    const list = await fetch(`${fixture.base}/api/agents`);
    assert.equal(list.status, 200);
    const rows = (await readJson(list))['agents'] as Record<string, unknown>[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.['home_path'], expectedHome);

    const workspace = await fetch(`${fixture.base}/api/workspace`);
    assert.equal(workspace.status, 200);
    const workspaceAgents = (await readJson(workspace))['agents'] as Record<string, unknown>[];
    assert.equal(workspaceAgents[0]?.['home_path'], expectedHome);

    for (const table of ['member', 'agent_config']) {
      const columns = allDatabaseRows(fixture.dataDir, `PRAGMA table_info(${table})`).map(
        (column) => column['name'],
      );
      assert.equal(
        columns.some((name) => String(name).includes('home')),
        false,
        `${table} stores no home path column`,
      );
      const stored = JSON.stringify(
        allDatabaseRows(fixture.dataDir, `SELECT * FROM ${table}`),
      );
      assert.equal(
        stored.includes(expectedHome),
        false,
        `${table} stores no home path value`,
      );
    }
  } finally {
    await fixture.stop();
  }
});

function snapshotTree(root: string): Record<string, string> {
  const files: Record<string, string> = {};
  function walk(dir: string, prefix: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        files[`${relative}/`] = '<dir>';
        walk(full, relative);
      } else if (entry.isFile()) {
        files[relative] = readFileSync(full, 'utf8');
      } else {
        files[relative] = `<${entry.isSymbolicLink() ? 'symlink' : 'other'}>`;
      }
    }
  }
  walk(root, '');
  return files;
}

test('startup and restart create no skills / mcp.json / memory and soft delete keeps the home', async () => {
  const fixture = await startFixture('allibot-agent-home-delete-');
  try {
    const layerRoot = path.join(fixture.home, '.allibot');
    assert.equal(existsSync(layerRoot), false, 'startup creates nothing under the global layer');

    const agent = await createAgent(fixture);
    const id = agent['id'] as string;
    const agentHome = agent['home_path'] as string;
    assert.equal(existsSync(path.join(agentHome, 'skills')), false, 'create makes no skills/');
    assert.equal(existsSync(path.join(agentHome, 'mcp.json')), false, 'create makes no mcp.json');

    // A human-maintained rules file and a member skill (the app writes skills in
    // #48; #43 must preserve both).
    writeFileSync(path.join(agentHome, 'AGENTS.md'), 'HUMAN-RULES\n', 'utf8');
    mkdirSync(path.join(agentHome, 'skills', 'demo'), { recursive: true });
    writeFileSync(path.join(agentHome, 'skills', 'demo', 'SKILL.md'), 'SKILL-BODY\n', 'utf8');
    const before = snapshotTree(agentHome);

    await fixture.running.stop();
    fixture.running = await startServer(fixture.dataDir, { env: { HOME: fixture.home } });
    fixture.base = `http://127.0.0.1:${fixture.running.port}`;
    assert.deepEqual(snapshotTree(agentHome), before, 'startup leaves the existing home untouched');
    const restarted = await fetch(`${fixture.base}/api/agents/${id}`);
    assert.equal(restarted.status, 200);
    assert.equal((await readJson(restarted))['home_path'], agentHome, 'home_path is stable across restarts');

    const deleted = await fetch(`${fixture.base}/api/agents/${id}`, { method: 'DELETE' });
    assert.equal(deleted.status, 204);
    assert.equal(existsSync(agentHome), true, 'soft delete keeps the home');
    assert.deepEqual(snapshotTree(agentHome), before, 'soft delete changes no byte in the home');
    const list = await fetch(`${fixture.base}/api/agents`);
    assert.deepEqual((await readJson(list))['agents'], [], 'the soft-deleted Agent leaves the list');
    const gone = await fetch(`${fixture.base}/api/agents/${id}`);
    assert.equal(gone.status, 404, 'a soft-deleted Agent is not a readable Agent');

    await fixture.running.stop();
    fixture.running = await startServer(fixture.dataDir, { env: { HOME: fixture.home } });
    fixture.base = `http://127.0.0.1:${fixture.running.port}`;
    assert.deepEqual(snapshotTree(agentHome), before, 'restart neither recreates nor removes the home');
  } finally {
    await fixture.stop();
  }
});

async function createChannel(fixture: Fixture, name = '规则频道'): Promise<string> {
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
  const patched = await fetch(`${fixture.base}/api/channels/${channelId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    // #44: every file write passes the tool gate. This suite observes the
    // home boundary, so it selects the mode that auto-allows root writes.
    body: JSON.stringify({ workspace_root: root, permission_mode: 'trusted-writes' }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());
}

function ruleSection(
  body: Record<string, unknown>,
  kind: string,
): Record<string, unknown> {
  const sections = body['sections'] as Record<string, unknown>[];
  const section = sections.find((row) => row['kind'] === kind);
  assert.ok(section !== undefined, `the rules response has the ${kind} section`);
  return section;
}

test('GET /api/agents/{id}/rules returns the three ordered sections with read status', async () => {
  const fixture = await startFixture('allibot-agent-rules-endpoint-');
  try {
    const agent = await createAgent(fixture, { system_prompt: 'SYSTEM-RULES' });
    const agentId = agent['id'] as string;
    const home = agent['home_path'] as string;
    const globalPath = path.join(home, 'AGENTS.md');
    writeFileSync(globalPath, 'GLOBAL-RULES\n', 'utf8');
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(path.join(project, '.allibot', 'agents', agentId), { recursive: true });
    // The stored root is the canonical realpath (`/private/var` on macOS), so
    // the project layer path is derived from that canonical root.
    const projectPath = path.join(
      realpathSync(project),
      '.allibot',
      'agents',
      agentId,
      'AGENTS.md',
    );
    writeFileSync(projectPath, 'PROJECT-RULES\n', 'utf8');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    await configureRoot(fixture, channelId, project);

    const response = await fetch(
      `${fixture.base}/api/agents/${agentId}/rules?channel_id=${channelId}`,
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await readJson(response);
    assert.equal(body['agent_id'], agentId);
    assert.equal(body['channel_id'], channelId);
    assert.equal(body['home_path'], home);
    assert.deepEqual(body['order'], ['global', 'system_prompt', 'project']);

    const sections = body['sections'] as Record<string, unknown>[];
    assert.deepEqual(
      sections.map((section) => section['kind']),
      ['global', 'system_prompt', 'project'],
      'the sections follow the assembly order',
    );
    assert.deepEqual(ruleSection(body, 'global'), {
      kind: 'global',
      path: globalPath,
      present: true,
      readable: true,
      content: 'GLOBAL-RULES\n',
    });
    assert.deepEqual(ruleSection(body, 'system_prompt'), {
      kind: 'system_prompt',
      path: null,
      present: true,
      readable: true,
      content: 'SYSTEM-RULES',
    });
    assert.deepEqual(ruleSection(body, 'project'), {
      kind: 'project',
      path: projectPath,
      present: true,
      readable: true,
      content: 'PROJECT-RULES\n',
    });
    assert.equal(
      JSON.stringify(body).includes(fixture.dataDir),
      false,
      'the rules reading carries no storage path',
    );

    const rootless = await createChannel(fixture, '无根规则频道');
    const rootlessResponse = await fetch(
      `${fixture.base}/api/agents/${agentId}/rules?channel_id=${rootless}`,
    );
    assert.equal(rootlessResponse.status, 200);
    const rootlessBody = await readJson(rootlessResponse);
    assert.deepEqual(ruleSection(rootlessBody, 'project'), {
      kind: 'project',
      path: null,
      present: false,
      readable: false,
      content: null,
    });
    assert.equal(ruleSection(rootlessBody, 'global')['present'], true, 'the global section still reads');

    const noChannel = await fetch(`${fixture.base}/api/agents/${agentId}/rules`);
    assert.equal(noChannel.status, 200);
    assert.deepEqual(ruleSection(await readJson(noChannel), 'project'), {
      kind: 'project',
      path: null,
      present: false,
      readable: false,
      content: null,
    });

    const unknown = await fetch(
      `${fixture.base}/api/agents/00000000-0000-4000-8000-000000000000/rules`,
    );
    assert.equal(unknown.status, 404);
    const errorBody = await readJson(unknown);
    assert.equal((errorBody['error'] as Record<string, unknown>)['code'], 'not_found');

    for (const method of ['PUT', 'PATCH', 'POST', 'DELETE']) {
      const write = await fetch(`${fixture.base}/api/agents/${agentId}/rules`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      assert.ok(
        write.status === 404 || write.status === 405,
        `${method} has no rules write entry (got ${write.status})`,
      );
    }

    chmodSync(globalPath, 0o000);
    try {
      const unreadable = await readJson(
        await fetch(`${fixture.base}/api/agents/${agentId}/rules`),
      );
      assert.deepEqual(ruleSection(unreadable, 'global'), {
        kind: 'global',
        path: globalPath,
        present: true,
        readable: false,
        content: null,
      });
    } finally {
      chmodSync(globalPath, 0o644);
    }

    const missing = await createAgent(fixture, { display_name: '无规则成员' });
    const missingHome = missing['home_path'] as string;
    const missingBody = await readJson(
      await fetch(`${fixture.base}/api/agents/${missing['id'] as string}/rules`),
    );
    assert.deepEqual(ruleSection(missingBody, 'global'), {
      kind: 'global',
      path: path.join(missingHome, 'AGENTS.md'),
      present: false,
      readable: false,
      content: null,
    });
    assert.deepEqual(ruleSection(missingBody, 'system_prompt'), {
      kind: 'system_prompt',
      path: null,
      present: false,
      readable: true,
      content: '',
    });
  } finally {
    await fixture.stop();
  }
});

const RECORDING_ARGS = [
  '--scripted-provider',
  'reply',
  '--scripted-report-team',
  '--scripted-echo-prompt',
] as const;

async function messages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages?limit=50`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function replyBody(rows: Record<string, unknown>[]): string {
  const replies = rows.filter((row) => row['kind'] === 'agent');
  const reply = replies[replies.length - 1];
  assert.ok(reply !== undefined, 'the scripted round should answer');
  return reply['body'] as string;
}

function rulesContent(body: string): Record<string, unknown> {
  const match = /\[rules-content\] (\{.*\})/.exec(body);
  assert.ok(match !== null, 'the scripted report carries the rule section content');
  return JSON.parse(match[1]!) as Record<string, unknown>;
}

test('a round assembles global rules → system prompt → project supplement, project last', async () => {
  const fixture = await startFixture('allibot-agent-rules-prompt-', {
    args: RECORDING_ARGS,
  });
  try {
    const agent = await createAgent(fixture, { system_prompt: 'SYSTEM-SECTION' });
    const agentId = agent['id'] as string;
    const home = agent['home_path'] as string;
    const globalPath = path.join(home, 'AGENTS.md');
    writeFileSync(globalPath, 'GLOBAL-SECTION\n共用冲突句：全局版本\n', 'utf8');

    const project = path.join(fixture.tmp, 'project');
    mkdirSync(path.join(project, '.allibot', 'agents', agentId), { recursive: true });
    const projectPath = path.join(project, '.allibot', 'agents', agentId, 'AGENTS.md');
    writeFileSync(projectPath, 'PROJECT-SECTION\n共用冲突句：项目版本\n', 'utf8');

    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    await configureRoot(fixture, channelId, project);

    const globalBefore = readFileSync(globalPath, 'utf8');
    const projectBefore = readFileSync(projectPath, 'utf8');
    await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '请按规则回答' });
    const body = replyBody(await messages(fixture, channelId));

    assert.match(body, /\[rules\] global:present > system:present > project:present/);
    assert.deepEqual(rulesContent(body), {
      global: 'GLOBAL-SECTION\n共用冲突句：全局版本',
      system: 'SYSTEM-SECTION',
      project: 'PROJECT-SECTION\n共用冲突句：项目版本',
    });

    const prompt = body.slice(body.indexOf('[system-prompt] '));
    const globalAt = prompt.indexOf('GLOBAL-SECTION');
    const systemAt = prompt.indexOf('SYSTEM-SECTION');
    const projectAt = prompt.indexOf('PROJECT-SECTION');
    assert.ok(globalAt > -1 && systemAt > -1 && projectAt > -1, 'all three sections reach the prompt');
    assert.ok(globalAt < systemAt, 'the global rules base precedes the stored system prompt');
    assert.ok(systemAt < projectAt, 'the project supplement comes last and wins a conflict');
    assert.ok(
      prompt.indexOf('共用冲突句：项目版本') > prompt.indexOf('共用冲突句：全局版本'),
      'the project supplement is the later, winning copy',
    );

    assert.equal(readFileSync(globalPath, 'utf8'), globalBefore, 'the host never writes the global rules');
    assert.equal(readFileSync(projectPath, 'utf8'), projectBefore, 'the host never writes the project supplement');
  } finally {
    await fixture.stop();
  }
});

test('a missing or unreadable rule section only omits itself and the round continues', async () => {
  const fixture = await startFixture('allibot-agent-rules-missing-', {
    args: RECORDING_ARGS,
  });
  try {
    const agent = await createAgent(fixture, { system_prompt: 'SYSTEM-ONLY' });
    const agentId = agent['id'] as string;
    const home = agent['home_path'] as string;
    const globalPath = path.join(home, 'AGENTS.md');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '没有规则文件' });
    let body = replyBody(await messages(fixture, channelId));
    assert.match(body, /\[rules\] global:absent > system:present > project:absent/);
    assert.deepEqual(rulesContent(body), { global: null, system: 'SYSTEM-ONLY', project: null });

    const project = path.join(fixture.tmp, 'project');
    mkdirSync(path.join(project, '.allibot', 'agents', agentId), { recursive: true });
    await configureRoot(fixture, channelId, project);
    writeFileSync(path.join(project, '.allibot', 'agents', agentId, 'AGENTS.md'), 'PROJECT-ONLY\n', 'utf8');

    writeFileSync(globalPath, 'UNREADABLE\n', 'utf8');
    chmodSync(globalPath, 0o000);
    try {
      await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '全局规则不可读' });
      body = replyBody(await messages(fixture, channelId));
      assert.match(body, /\[rules\] global:absent > system:present > project:present/);
      assert.deepEqual(rulesContent(body), { global: null, system: 'SYSTEM-ONLY', project: 'PROJECT-ONLY' });
      const outcome = queryDatabase<{ status: string }>(
        fixture.dataDir,
        'SELECT status FROM round_outcome WHERE member_id = ? AND target_id = ? ORDER BY rowid DESC LIMIT 1',
        [agentId, channelId],
      );
      assert.equal(outcome?.status, 'replied', 'the round still answers');
    } finally {
      chmodSync(globalPath, 0o644);
    }
  } finally {
    await fixture.stop();
  }
});

test('--home-dir and allibot_HOME_DIR override the global layer root; the flag wins', async () => {
  // The first server only creates the temp root / migrated database; the two
  // restart permutations below are the actual readings.
  const fixture = await startFixture('allibot-agent-home-dir-');
  await fixture.running.stop();
  const flagLayer = path.join(fixture.tmp, 'flag-layer');
  const envLayer = path.join(fixture.tmp, 'env-layer');
  try {
    fixture.running = await startServer(fixture.dataDir, {
      args: ['--home-dir', flagLayer],
      env: { HOME: fixture.home, allibot_HOME_DIR: envLayer },
    });
    fixture.base = `http://127.0.0.1:${fixture.running.port}`;
    const agent = await createAgent(fixture);
    const homePath = agent['home_path'] as string;
    assert.equal(
      homePath,
      path.join(flagLayer, 'agents', agent['id'] as string),
      'the flag names the global layer root and wins over the environment',
    );
    assert.equal(existsSync(homePath), true);
    assert.equal(existsSync(path.join(envLayer, 'agents', agent['id'] as string)), false);
    assert.equal(
      existsSync(path.join(fixture.home, '.allibot', 'agents', agent['id'] as string)),
      false,
      'the default HOME layer is not used when the flag is present',
    );
    for (const table of ['member', 'agent_config']) {
      const stored = JSON.stringify(allDatabaseRows(fixture.dataDir, `SELECT * FROM ${table}`));
      assert.equal(stored.includes(flagLayer), false, `the override is not stored in ${table}`);
    }

    await fixture.running.stop();
    const envOnly = await startServer(fixture.dataDir, {
      env: { HOME: fixture.home, allibot_HOME_DIR: envLayer },
    });
    try {
      const listed = await fetch(`http://127.0.0.1:${envOnly.port}/api/agents`);
      const rows = (await readJson(listed))['agents'] as Record<string, unknown>[];
      assert.equal(
        rows[0]?.['home_path'],
        path.join(envLayer, 'agents', agent['id'] as string),
        'allibot_HOME_DIR overrides the default ~/.allibot root',
      );
      assert.equal(
        existsSync(path.join(envLayer, 'agents', agent['id'] as string)),
        false,
        'the reading is derived, not created by a restart',
      );
      const created = await postJson(
        { ...fixture, base: `http://127.0.0.1:${envOnly.port}` } as Fixture,
        '/api/agents',
        { display_name: '环境层成员', model: 'openai:gpt-5' },
      );
      assert.equal(created.status, 201);
      const createdBody = await readJson(created);
      assert.equal(
        createdBody['home_path'],
        path.join(envLayer, 'agents', createdBody['id'] as string),
        'a new Agent is created under the environment overridden root',
      );
      assert.equal(existsSync(createdBody['home_path'] as string), true);
    } finally {
      await envOnly.stop();
    }
  } finally {
    await fixture.running.stop();
    await removeTempDir(fixture.tmp);
  }
});

test('the Agent home is not a project work root: file tools reject its AGENTS.md', async () => {
  const fixture = await startFixture('allibot-agent-home-boundary-', {
    args: ['--scripted-provider', 'workspace'],
  });
  try {
    const agent = await createAgent(fixture);
    const agentId = agent['id'] as string;
    const home = agent['home_path'] as string;
    const homeRules = path.join(home, 'AGENTS.md');
    writeFileSync(homeRules, 'HUMAN-HOME-RULES\n', 'utf8');
    const project = path.join(fixture.tmp, 'project');
    mkdirSync(project, { recursive: true });
    writeFileSync(path.join(project, 'notes.txt'), 'NEEDLE-ONE\n', 'utf8');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agentId);
    await configureRoot(fixture, channelId, project);

    await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '写家目录试试' });
    const body = replyBody(await messages(fixture, channelId));
    assert.match(body, /\[workspace-home-write\] error:outside-root/);
    assert.equal(readFileSync(homeRules, 'utf8'), 'HUMAN-HOME-RULES\n', 'the rule file is untouched');

    const dm = await postJson(fixture, '/api/dms', { agent_id: agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmId = (await readJson(dm))['id'] as string;
    await postJson(fixture, `/api/targets/${dmId}/messages`, { body: '私信没有项目根' });
    const dmBody = replyBody(await messages(fixture, dmId));
    assert.match(dmBody, /\[workspace\] available:false/);
    assert.match(dmBody, /\[workspace-tools\] -/);
    assert.doesNotMatch(dmBody, /\[workspace-home-write\]/);

    const rootless = await createChannel(fixture, '无根频道');
    await joinChannel(fixture, rootless, agentId);
    await postJson(fixture, `/api/targets/${rootless}/messages`, { body: '无根轮次' });
    const rootlessBody = replyBody(await messages(fixture, rootless));
    assert.match(rootlessBody, /\[workspace\] available:false/);
    assert.match(rootlessBody, /\[workspace-tools\] -/);
  } finally {
    await fixture.stop();
  }
});

test('long-term memory stays in agent_memory and old home memory files are neither created nor read', async () => {
  const fixture = await startFixture('allibot-agent-memory-', { args: RECORDING_ARGS });
  try {
    const fresh = await createAgent(fixture, { display_name: '记忆成员' });
    const freshId = fresh['id'] as string;
    const freshHome = fresh['home_path'] as string;
    assert.deepEqual(readdirSync(freshHome), [], 'a new home is empty');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, freshId);
    await postJson(fixture, `/api/targets/${channelId}/messages`, { body: '记住这次对话' });
    const freshReply = replyBody(await messages(fixture, channelId));
    assert.match(freshReply, /memcount:0/);
    assert.deepEqual(
      readdirSync(freshHome),
      [],
      'a round creates no reme/, MEMORY.md or <topic>.md in the home',
    );
    const memoryRows = allDatabaseRows(
      fixture.dataDir,
      'SELECT member_id, content FROM agent_memory WHERE member_id = ?',
      [freshId],
    );
    assert.equal(memoryRows.length, 1, 'the round writes one agent_memory card');
    assert.equal(memoryRows[0]?.['member_id'], freshId);

    const seeded = await createAgent(fixture, { display_name: '旧记忆成员' });
    const seededId = seeded['id'] as string;
    const seededHome = seeded['home_path'] as string;
    const oldMemory = path.join(seededHome, 'MEMORY.md');
    const oldTopic = path.join(seededHome, 'topic-notes.md');
    writeFileSync(oldMemory, 'OLD-MEMORY-NEEDLE\n', 'utf8');
    writeFileSync(oldTopic, 'OLD-TOPIC-NEEDLE\n', 'utf8');
    const seededChannel = await createChannel(fixture, '旧记忆频道');
    await joinChannel(fixture, seededChannel, seededId);
    await postJson(fixture, `/api/targets/${seededChannel}/messages`, { body: '读取旧记忆' });
    const seededReply = replyBody(await messages(fixture, seededChannel));
    assert.equal(
      seededReply.includes('OLD-MEMORY-NEEDLE'),
      false,
      'the old MEMORY.md is never read into the prompt',
    );
    assert.equal(
      seededReply.includes('OLD-TOPIC-NEEDLE'),
      false,
      'an old <topic>.md is never read into the prompt',
    );
    assert.equal(readFileSync(oldMemory, 'utf8'), 'OLD-MEMORY-NEEDLE\n');
    assert.equal(readFileSync(oldTopic, 'utf8'), 'OLD-TOPIC-NEEDLE\n');
    assert.deepEqual(
      readdirSync(seededHome).sort(),
      ['MEMORY.md', 'topic-notes.md'],
      'the app neither deletes nor creates memory files',
    );
    assert.equal(existsSync(path.join(seededHome, 'reme')), false);
  } finally {
    await fixture.stop();
  }
});
