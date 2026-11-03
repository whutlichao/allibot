import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
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
 * 运行期 MCP 装配 (#47 / D6.1 / D6.2), observed through the one process seam:
 * a real backend, the scripted `mcp` behaviour reporting the assembled round
 * input, the human REST face, the Agent-home file and test MCP servers injected
 * below the seam (a stdio child process / a localhost HTTP or SSE endpoint).
 *
 * No real network, no real `~/.allibot/`, no private-function calls.
 */

const MCP_SERVER = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'mcp-server.mjs');

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  project: string;
  running: RunningServer;
  base: string;
  agentId: string;
  agentHome: string;
  channelId: string;
  stop: () => Promise<void>;
}

function mcpPath(fixture: Fixture): string {
  return path.join(fixture.agentHome, 'mcp.json');
}

function writeMcp(fixture: Fixture, servers: unknown[]): void {
  writeFileSync(mcpPath(fixture), `${JSON.stringify({ servers }, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
}

async function postJson(
  fixture: Fixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function startFixture(prefix: string, options: { root?: boolean } = {}): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, 'README.md'), 'project marker\n', 'utf8');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'mcp'],
    env: {
      HOME: home,
      OPENAI_API_KEY: 'sk-test-mcp',
      MCP_TEST_TOKEN: 'named-token-value',
      MCP_TEST_SECRET: 'unnamed-secret-value',
    },
  });
  const base = `http://127.0.0.1:${running.port}`;
  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    project,
    running,
    base,
    agentId: '',
    agentHome: '',
    channelId: '',
    stop: async () => {
      await fixture.running.stop();
      await removeTempDir(tmp);
    },
  };

  const created = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: 'MCP 运行成员', model: 'openai:gpt-5' }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agent = (await created.json()) as Record<string, unknown>;
  fixture.agentId = agent['id'] as string;
  fixture.agentHome = agent['home_path'] as string;

  const channel = await postJson(fixture, '/api/channels', {
    name: 'MCP 运行频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 10,
  });
  assert.equal(channel.status, 201, await channel.clone().text());
  fixture.channelId = ((await channel.json()) as Record<string, unknown>)['id'] as string;
  const joined = await postJson(fixture, `/api/channels/${fixture.channelId}/members`, {
    member_id: fixture.agentId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());

  if (options.root === true) {
    const patched = await fetch(`${base}/api/channels/${fixture.channelId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ workspace_root: project }),
    });
    assert.equal(patched.status, 200, await patched.clone().text());
  }
  return fixture;
}

async function allowMcpRules(fixture: Fixture, serverNames: readonly string[]): Promise<void> {
  const rules = serverNames.map((name) => ({
    tool_name: `mcp:${name}/echo`,
    pattern: '',
    behavior: 'allow',
  }));
  const response = await fetch(`${fixture.base}/api/channels/${fixture.channelId}/permission-rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rules),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function allowAgentMcpRules(
  fixture: Fixture,
  serverNames: readonly string[],
): Promise<void> {
  const rules = serverNames.map((name) => ({
    tool_name: `mcp:${name}/echo`,
    pattern: '',
    behavior: 'allow',
  }));
  const response = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/permission-rules`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rules),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function setPermissionMode(fixture: Fixture, mode: string): Promise<void> {
  const response = await fetch(`${fixture.base}/api/channels/${fixture.channelId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ permission_mode: mode }),
  });
  assert.equal(response.status, 200, await response.clone().text());
}

async function sendMessage(fixture: Fixture, body = 'MCP 轮次'): Promise<string> {
  const response = await postJson(fixture, `/api/targets/${fixture.channelId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as Record<string, unknown>)['id'] as string;
}

async function latestReply(fixture: Fixture): Promise<string> {
  const response = await fetch(
    `${fixture.base}/api/targets/${fixture.channelId}/messages?limit=50`,
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { messages: Record<string, unknown>[] };
  const replies = body.messages.filter(
    (message) => message['kind'] === 'agent' && message['author_member_id'] === fixture.agentId,
  );
  const last = replies[replies.length - 1];
  assert.ok(last !== undefined, `the member should have replied; messages: ${JSON.stringify(body.messages)}`);
  return String(last['body']);
}

function latestOutcomeReason(fixture: Fixture): string {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db
      .prepare(
        `SELECT reason FROM round_outcome
          WHERE member_id = ? AND target_id = ?
          ORDER BY rowid DESC LIMIT 1`,
      )
      .get(fixture.agentId, fixture.channelId) as { reason: string } | undefined;
    return row?.reason ?? '';
  } finally {
    db.close();
  }
}

async function waitForFile(file: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(file) && readFileSync(file, 'utf8').trim().length > 0) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${file}`);
}

interface StartedMcpServer {
  child: ChildProcess;
  port: number;
  logPath: string;
  log: () => string;
  stop: () => Promise<void>;
}

async function startRemoteMcp(
  fixture: Fixture,
  mode: 'http' | 'sse',
): Promise<StartedMcpServer> {
  const portFile = path.join(fixture.tmp, `${mode}-port`);
  const logPath = path.join(fixture.tmp, `${mode}-requests.log`);
  const child = spawn(
    process.execPath,
    [MCP_SERVER, mode, '--port-file', portFile, '--log', logPath],
    { cwd: REPO_ROOT, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  await waitForFile(portFile);
  const port = Number(readFileSync(portFile, 'utf8').trim());
  return {
    child,
    port,
    logPath,
    log: () => readFileSync(logPath, 'utf8'),
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await new Promise<void>((resolve) => {
          child.once('exit', () => resolve());
          setTimeout(resolve, 1000).unref?.();
        });
      }
    },
  };
}

function stdioServer(
  fixture: Fixture,
  name: string,
  envNames: string[] = [],
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name,
    transport: 'stdio',
    enabled: true,
    command: process.execPath,
    args: [MCP_SERVER, 'stdio', '--log', path.join(fixture.tmp, `${name}.log`)],
    ...(envNames.length === 0 ? {} : { env_names: envNames }),
    ...extra,
  };
}

test('a missing mcp.json is zero MCP without an error; old mcp_server rows are never read', async () => {
  const fixture = await startFixture('allibot-mcp-missing-');
  try {
    // Old rows: both an Agent-scope and a channel-scope declaration exist, but
    // runtime must not read the table at all.
    const db = new Database(path.join(fixture.dataDir, 'allibot.db'));
    try {
      db.prepare(
        `INSERT INTO mcp_server
           (id, scope_kind, scope_id, name, transport, config, enabled, created_at)
         VALUES ('old-agent', 'agent', ?, 'legacy', 'stdio', ?, 1, ?)`,
      ).run(
        fixture.agentId,
        JSON.stringify({ command: process.execPath, args: [MCP_SERVER, 'stdio'] }),
        '2026-01-01T00:00:00.000Z',
      );
      db.prepare(
        `INSERT INTO mcp_server
           (id, scope_kind, scope_id, name, transport, config, enabled, created_at)
         VALUES ('old-channel', 'channel', ?, 'legacy-channel', 'http', ?, 1, ?)`,
      ).run(
        fixture.channelId,
        JSON.stringify({ url: 'http://127.0.0.1:9/mcp' }),
        '2026-01-01T00:00:00.000Z',
      );
    } finally {
      db.close();
    }

    await sendMessage(fixture);
    const reply = await latestReply(fixture);
    assert.match(reply, /\[mcp\] absent/);
    assert.match(reply, /\[mcp-tools\] -/);
    assert.doesNotMatch(reply, /legacy/);
    assert.doesNotMatch(latestOutcomeReason(fixture), /MCP/);
    assert.equal(existsSync(path.join(fixture.dataDir, 'mcp-hosts')), false);
  } finally {
    await fixture.stop();
  }
});

test('stdio MCP runs as a host child in the project root, gets env_names by name only, and tools pass the gate', async () => {
  const fixture = await startFixture('allibot-mcp-stdio-', { root: true });
  try {
    writeMcp(fixture, [
      stdioServer(fixture, 'demo', ['MCP_TEST_TOKEN']),
      {
        ...stdioServer(fixture, 'off'),
        enabled: false,
      },
    ]);
    await allowMcpRules(fixture, ['demo']);

    await sendMessage(fixture);
    const reply = await latestReply(fixture);
    const canonicalProject = realpathSync(fixture.project);
    assert.match(reply, /\[mcp\] servers:1/);
    assert.match(reply, /\[mcp-server\] demo:stdio:echo,boom/);
    assert.match(reply, /\[tools\] Read,Glob,Grep,Write,Edit,mcp:demo\/echo,mcp:demo\/boom/);
    assert.match(reply, /\[mcp-call\] demo\/echo:ok::/);

    const payload = JSON.parse(
      reply.match(/\[mcp-call\] demo\/echo:ok::(\{.*\})/)?.[1] ?? '{}',
    ) as Record<string, unknown>;
    assert.equal(payload['cwd'], canonicalProject, 'stdio cwd is the project root');
    assert.equal(payload['probe'], 'ping');
    assert.equal(payload['token'], 'named-token-value', 'the named env value is passed');
    assert.equal(payload['unnamed'], null, 'an unnamed env variable is not passed');
    assert.equal(reply.includes('unnamed-secret-value'), false, 'no env value leaks into the reply');
    assert.equal(reply.includes('named-token-value"'), true);
    assert.equal(latestOutcomeReason(fixture).includes('MCP'), false, 'a clean assembly adds no diagnostic');
  } finally {
    await fixture.stop();
  }
});

test('without a project root the MCP host is the disposable data-dir directory and gains no project tools', async () => {
  const fixture = await startFixture('allibot-mcp-host-');
  try {
    writeMcp(fixture, [stdioServer(fixture, 'demo')]);
    // A DM has no channel rules: its permission context is the Agent override,
    // so the allow rule is written on the Agent scope.
    await allowAgentMcpRules(fixture, ['demo']);
    // A DM is the clearest no-root context; the same Agent's channel is used
    // for the reply read, so send the DM through its own target and read it.
    const dm = await postJson(fixture, '/api/dms', { agent_id: fixture.agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmId = ((await dm.json()) as Record<string, unknown>)['id'] as string;
    const sent = await postJson(fixture, `/api/targets/${dmId}/messages`, { body: 'DM MCP' });
    assert.equal(sent.status, 201, await sent.clone().text());

    const response = await fetch(`${fixture.base}/api/targets/${dmId}/messages?limit=50`);
    const body = (await response.json()) as { messages: Record<string, unknown>[] };
    const replies = body.messages.filter(
      (message) => message['kind'] === 'agent' && message['author_member_id'] === fixture.agentId,
    );
    const last = replies[replies.length - 1];
    assert.ok(last !== undefined, 'the DM round should reply');
    const reply = String(last['body']);
    assert.match(reply, /\[mcp\] servers:1/);
    assert.match(reply, /\[tools\] mcp:demo\/echo,mcp:demo\/boom/, 'no project file tools in a DM');
    const payload = JSON.parse(
      reply.match(/\[mcp-call\] demo\/echo:ok::(\{.*\})/)?.[1] ?? '{}',
    ) as Record<string, unknown>;
    const cwd = String(payload['cwd']);
    assert.ok(
      cwd.startsWith(realpathSync(path.join(fixture.dataDir, 'mcp-hosts')) + path.sep),
      `the disposable host is under <data_dir>/mcp-hosts, got ${cwd}`,
    );
    assert.notEqual(cwd, realpathSync(fixture.project));
  } finally {
    await fixture.stop();
  }
});

test('an invalid mcp.json is whole-file zero MCP, starts no server, and lands in RoundOutcome.reason', async () => {
  const fixture = await startFixture('allibot-mcp-invalid-', { root: true });
  try {
    const logPath = path.join(fixture.tmp, 'broken.log');
    writeMcp(fixture, [
      {
        name: 'broken',
        transport: 'stdio',
        enabled: true,
        command: process.execPath,
        args: [MCP_SERVER, 'stdio', '--log', logPath],
        url: 'http://127.0.0.1:9/mcp',
      },
    ]);
    await sendMessage(fixture);
    const reply = await latestReply(fixture);
    assert.match(reply, /\[mcp\] servers:0/);
    assert.match(reply, /\[mcp\] diagnostic:.*stdio.*url/);
    assert.match(reply, /\[mcp-tools\] -/);
    assert.equal(existsSync(logPath), false, 'no half set was started');
    assert.match(latestOutcomeReason(fixture), /mcp\.json|stdio.*url/);
    assert.equal(existsSync(path.join(fixture.dataDir, 'mcp-hosts')), false);
  } finally {
    await fixture.stop();
  }
});

test('http and sse servers stay disconnected until their per-name consent; stdio needs none', async () => {
  const fixture = await startFixture('allibot-mcp-consent-', { root: true });
  const http = await startRemoteMcp(fixture, 'http');
  const sse = await startRemoteMcp(fixture, 'sse');
  try {
    writeMcp(fixture, [
      stdioServer(fixture, 'local-one'),
      {
        name: 'remote-http',
        transport: 'http',
        enabled: true,
        url: `http://127.0.0.1:${http.port}/mcp`,
      },
      {
        name: 'remote-sse',
        transport: 'sse',
        enabled: true,
        url: `http://127.0.0.1:${sse.port}/sse`,
      },
    ]);
    await allowMcpRules(fixture, ['local-one', 'remote-http', 'remote-sse']);

    await sendMessage(fixture);
    const before = await latestReply(fixture);
    assert.match(before, /\[mcp\] servers:1/, 'only the stdio server is assembled before consent');
    assert.match(before, /\[mcp\] diagnostic:.*remote-http.*未确认/);
    assert.match(before, /\[mcp\] diagnostic:.*remote-sse.*未确认/);
    assert.doesNotMatch(http.log(), /http (initialize|tools\/list|tools\/call)/);
    assert.doesNotMatch(sse.log(), /sse (connect|post)/);

    const consent = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'mcp',
      scope_id: 'remote-http',
    });
    assert.equal(consent.status, 200, await consent.clone().text());
    const consentBody = (await consent.json()) as Record<string, unknown>;
    assert.equal(consentBody['scope_kind'], 'mcp');
    assert.equal(consentBody['scope_id'], 'remote-http');
    assert.equal(typeof consentBody['confirmed_at'], 'string');
    const firstConfirmedAt = consentBody['confirmed_at'];
    const replay = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'mcp',
      scope_id: 'remote-http',
    });
    assert.equal(replay.status, 200);
    assert.equal(
      ((await replay.json()) as Record<string, unknown>)['confirmed_at'],
      firstConfirmedAt,
      'same-scope replay keeps the first confirmation time',
    );
    const sseConsent = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'mcp',
      scope_id: 'remote-sse',
    });
    assert.equal(sseConsent.status, 200);

    const flow = await fetch(`${fixture.base}/api/remote-data-flow`);
    assert.equal(flow.status, 200);
    const flowText = await flow.text();
    const flowBody = JSON.parse(flowText) as Record<string, unknown>;
    const mcpConsents = flowBody['mcp_consents'] as Record<string, unknown>[];
    assert.deepEqual(
      mcpConsents.map((row) => [row['scope_kind'], row['scope_id']]),
      [
        ['mcp', 'remote-http'],
        ['mcp', 'remote-sse'],
      ],
    );
    assert.ok(Array.isArray(flowBody['docker_consents']));
    assert.equal(flowText.includes(String(http.port)), false, 'the consent reading has no URL');
    assert.equal(flowText.includes(MCP_SERVER), false, 'the consent reading has no command');

    await sendMessage(fixture);
    const after = await latestReply(fixture);
    assert.match(after, /\[mcp\] servers:3/);
    assert.match(after, /\[mcp-server\] remote-http:http:echo,boom/);
    assert.match(after, /\[mcp-server\] remote-sse:sse:echo,boom/);
    assert.match(after, /\[mcp-call\] remote-http\/echo:ok::/);
    assert.match(after, /\[mcp-call\] remote-sse\/echo:ok::/);
    assert.match(http.log(), /http initialize/);
    assert.match(sse.log(), /sse connect/);
  } finally {
    await http.stop();
    await sse.stop();
    await fixture.stop();
  }
});

test('MCP tools are execution class: read-only denies the call but the round still replies', async () => {
  const fixture = await startFixture('allibot-mcp-gate-', { root: true });
  try {
    writeMcp(fixture, [stdioServer(fixture, 'demo')]);
    await setPermissionMode(fixture, 'read-only');
    await sendMessage(fixture);
    const reply = await latestReply(fixture);
    assert.match(reply, /\[mcp\] servers:1/);
    assert.match(reply, /\[mcp-call\] demo\/echo:error:denied:DENIED/);
    const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
    try {
      const status = db
        .prepare(
          `SELECT status FROM round_outcome
            WHERE member_id = ? AND target_id = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(fixture.agentId, fixture.channelId) as { status: string };
      assert.equal(status.status, 'replied', 'DENIED is a tool result, not a round failure');
    } finally {
      db.close();
    }
  } finally {
    await fixture.stop();
  }
});

test('the generic consent endpoint validates scope kinds and writes the same row as the model entry', async () => {
  const fixture = await startFixture('allibot-mcp-consent-api-');
  try {
    for (const body of [
      { scope_kind: 'web', scope_id: 'x' },
      { scope_kind: 'mcp', scope_id: '' },
      { scope_kind: 'model', scope_id: 'unknown' },
      { scope_kind: 'mcp' },
      {},
    ]) {
      const response = await postJson(fixture, '/api/remote-data-flow/consent', body);
      assert.equal(response.status, 400, `invalid body should be 400: ${JSON.stringify(body)}`);
      assert.equal(
        ((await response.json()) as { error: { code: string } }).error.code,
        'validation_failed',
      );
    }

    const model = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'model',
      scope_id: 'anthropic',
    });
    assert.equal(model.status, 200);
    const docker = await postJson(fixture, '/api/remote-data-flow/consent', {
      scope_kind: 'docker',
      scope_id: 'node:22-bookworm-slim',
    });
    assert.equal(docker.status, 200);

    const flow = (await (
      await fetch(`${fixture.base}/api/remote-data-flow`)
    ).json()) as Record<string, unknown>;
    const providers = flow['providers'] as Record<string, unknown>[];
    assert.equal(
      providers.find((provider) => provider['provider'] === 'anthropic')?.['confirmed_at'],
      ((await (await postJson(fixture, '/api/remote-data-flow/anthropic/consent', {})).json()) as Record<string, unknown>)['confirmed_at'],
      'the model row is the same fact as the M1 provider entry',
    );
    const dockerConsents = flow['docker_consents'] as Record<string, unknown>[];
    assert.equal(dockerConsents.length, 1);
    assert.equal(dockerConsents[0]?.['scope_kind'], 'docker');
    assert.equal(dockerConsents[0]?.['scope_id'], 'node:22-bookworm-slim');
    assert.equal(typeof dockerConsents[0]?.['confirmed_at'], 'string');
  } finally {
    await fixture.stop();
  }
});
