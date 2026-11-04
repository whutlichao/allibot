import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
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
 * Docker 工作区后端 (#49 / D5.3 / ADR-0006), observed through the one process
 * seam: a real backend process, the scripted provider, and an injected fake
 * container runtime (a fake `docker` CLI) selected by `--docker-command`.
 *
 * The production side only speaks the Docker CLI; the fixture records every
 * create / exec / stop / remove / inspect invocation and materializes the
 * declared bind mounts as symlinks, so `exec` really runs the command against
 * the mounted project root. Real Docker is never touched by this suite.
 */

const FAKE_DOCKER = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'fake-docker.mjs');
const MCP_SERVER = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'mcp-server.mjs');
const IMAGE = 'node:22-bookworm-slim';

interface FakeContainer {
  name: string;
  image: string;
  labels: Record<string, string>;
  mounts: { source: string; target: string; read_only: boolean }[];
  command: string[];
}

interface FakeState {
  daemon: 'ok' | 'absent';
  images: string[];
  pull: 'ok' | 'fail' | 'noop';
  create: 'ok' | 'fail';
  containers: Record<string, FakeContainer>;
  seq: number;
}

interface FakeLogEntry {
  op: string;
  [key: string]: unknown;
}

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  project: string;
  statePath: string;
  logPath: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
  crash: () => Promise<void>;
  restart: () => Promise<void>;
  log: () => FakeLogEntry[];
  state: () => FakeState;
}

function defaultState(): FakeState {
  return {
    daemon: 'ok',
    images: [IMAGE],
    pull: 'ok',
    create: 'ok',
    containers: {},
    seq: 0,
  };
}

async function startFixture(
  prefix: string,
  options: {
    state?: Partial<FakeState>;
    args?: readonly string[];
    env?: NodeJS.ProcessEnv;
    scriptedProvider?: string;
  } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  const statePath = path.join(tmp, 'fake-docker-state.json');
  const logPath = path.join(tmp, 'fake-docker.log');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  // The per-application marker is derived from the data directory, so a
  // residual-container cleanup can be seeded only through a real crash.
  writeFileSync(statePath, JSON.stringify({ ...defaultState(), ...options.state }, null, 2));
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    project,
    statePath,
    logPath,
    // Assigned by restart below.
    running: undefined as unknown as RunningServer,
    base: '',
    stop: async () => {
      await fixture.running.stop();
      await removeTempDir(tmp);
    },
    crash: async () => {
      await fixture.running.crash();
    },
    restart: async () => {
      fixture.running = await startServer(dataDir, {
        args: [
          '--scripted-provider',
          options.scriptedProvider ?? 'workspace',
          '--docker-command',
          FAKE_DOCKER,
          ...(options.args ?? []),
        ],
        env: {
          HOME: home,
          allibot_DOCKER_IMAGE: IMAGE,
          ALLIBOT_FAKE_DOCKER_STATE: statePath,
          ALLIBOT_FAKE_DOCKER_LOG: logPath,
          ...(options.env ?? {}),
        },
      });
      fixture.base = `http://127.0.0.1:${fixture.running.port}`;
    },
    log: () => {
      if (!existsSync(logPath)) {
        return [];
      }
      return readFileSync(logPath, 'utf8')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as FakeLogEntry);
    },
    state: () => JSON.parse(readFileSync(statePath, 'utf8')) as FakeState,
  };
  await fixture.restart();
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

async function patchJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(fixture: Fixture): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: 'Docker Agent',
    model: 'openai:gpt-5',
    auto_claim: 1,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createChannel(fixture: Fixture, name: string): Promise<string> {
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

async function configureChannel(
  fixture: Fixture,
  channelId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await patchJson(fixture, `/api/channels/${channelId}`, patch);
  assert.equal(response.status, 200, await response.clone().text());
}

async function configureDockerChannel(
  fixture: Fixture,
  channelId: string,
  project: string,
): Promise<void> {
  await configureChannel(fixture, channelId, {
    workspace_root: project,
    workspace_backend: 'docker',
    // The file-tool behaviour writes freely; choose the mode that auto-allows
    // root-internal writes (the approval modes have their own suites).
    permission_mode: 'trusted-writes',
  });
}

async function sendMessage(fixture: Fixture, targetId: string, body: string): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

async function messages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

async function targetMembers(
  fixture: Fixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/members`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['members'] as Record<string, unknown>[];
}

function roundOutcome(
  dataDir: string,
  memberId: string,
  targetId: string,
): Record<string, unknown> | undefined {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT status, reason FROM round_outcome
          WHERE member_id = ? AND target_id = ?
          ORDER BY finished_at DESC LIMIT 1`,
      )
      .get(memberId, targetId) as Record<string, unknown> | undefined;
  } finally {
    db.close();
  }
}

/**
 * Seed the project fixture the scripted `workspace` behaviour reads: notes,
 * a subdirectory, an escaping symlink, an outside file and the member
 * `skills/` second root.
 */
function seedProject(fixture: Fixture, memberId: string): void {
  writeFileSync(path.join(fixture.project, 'notes.txt'), 'NEEDLE-ONE\nsecond line\n');
  mkdirSync(path.join(fixture.project, 'sub'), { recursive: true });
  writeFileSync(path.join(fixture.project, 'sub', 'second.txt'), 'NEEDLE-TWO\n');
  writeFileSync(path.join(fixture.tmp, 'outside.txt'), 'OUTSIDE\n');
  const outsideDir = path.join(fixture.tmp, 'outside-dir');
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(path.join(outsideDir, 'outside.txt'), 'SYMLINK-OUTSIDE\n');
  symlinkSync(outsideDir, path.join(fixture.project, 'escape'));
  const skills = path.join(fixture.home, '.allibot', 'agents', memberId, 'skills', 'demo');
  mkdirSync(skills, { recursive: true });
  writeFileSync(path.join(skills, 'SKILL.md'), 'SKILL-NEEDLE skill body\n');
  const globalSkills = path.join(fixture.home, '.allibot', 'skills');
  mkdirSync(globalSkills, { recursive: true });
}

// ---------------------------------------------------------------------------
// Slice 1 — workspace_runtime and the Docker target reading (D2.2 / D5.7)
// ---------------------------------------------------------------------------

test('workspace_runtime reports Docker availability and the image reference without credentials', async () => {
  const fixture = await startFixture('allibot-docker-runtime-');
  try {
    const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
    const runtime = workspace['workspace_runtime'] as Record<string, unknown> | undefined;
    assert.ok(runtime !== undefined, 'GET /api/workspace carries workspace_runtime');
    assert.deepEqual(runtime['docker'], {
      available: true,
      image: IMAGE,
      reason: null,
    });
    const serialized = JSON.stringify(runtime);
    for (const forbidden of ['credential', 'api_key', 'token', 'password']) {
      assert.equal(
        serialized.toLowerCase().includes(forbidden),
        false,
        `the runtime reading carries no ${forbidden}`,
      );
    }
    assert.deepEqual(
      Object.keys(runtime['docker'] as Record<string, unknown>).sort(),
      ['available', 'image', 'reason'],
    );
  } finally {
    await fixture.stop();
  }
});

test('a docker channel with a project root reads an available workspace once Docker and the image are present', async () => {
  const fixture = await startFixture('allibot-docker-status-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, 'Docker 频道');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);

    const members = await targetMembers(fixture, channelId);
    const agentRow = members.find((member) => member['id'] === agentId);
    assert.deepEqual(agentRow?.['workspace_status'], {
      backend: 'docker',
      available: true,
      reason: null,
    });
    const ownerRow = members.find((member) => member['kind'] === 'owner');
    assert.deepEqual(ownerRow?.['workspace_status'], {
      backend: 'docker',
      available: true,
      reason: null,
    });
  } finally {
    await fixture.stop();
  }
});

test('channel backend and the Agent override are effective per target context', async () => {
  const fixture = await startFixture('allibot-docker-override-');
  try {
    const agentId = await createAgent(fixture);
    const localChannel = await createChannel(fixture, '本地频道');
    const dockerChannel = await createChannel(fixture, 'Docker 频道');
    await joinChannel(fixture, localChannel, agentId);
    await joinChannel(fixture, dockerChannel, agentId);
    await configureChannel(fixture, localChannel, { workspace_root: fixture.project });
    await configureDockerChannel(fixture, dockerChannel, fixture.project);

    // The Agent follows the channel by default: local in the local channel,
    // Docker in the Docker channel — one Agent, two independent readings.
    let localMembers = await targetMembers(fixture, localChannel);
    let dockerMembers = await targetMembers(fixture, dockerChannel);
    assert.deepEqual(localMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });
    assert.deepEqual(dockerMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'docker',
      available: true,
      reason: null,
    });

    // An explicit local override on the Docker channel is independent of the
    // local channel: the channel default stays Docker for the owner.
    const overridden = await patchJson(fixture, `/api/agents/${agentId}`, {
      workspace_backend: 'local',
    });
    assert.equal(overridden.status, 200, await overridden.clone().text());
    dockerMembers = await targetMembers(fixture, dockerChannel);
    assert.deepEqual(dockerMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });
    assert.deepEqual(dockerMembers.find((m) => m['kind'] === 'owner')?.['workspace_status'], {
      backend: 'docker',
      available: true,
      reason: null,
    });

    // A NULL override follows the channel again.
    const cleared = await patchJson(fixture, `/api/agents/${agentId}`, {
      workspace_backend: null,
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    localMembers = await targetMembers(fixture, localChannel);
    dockerMembers = await targetMembers(fixture, dockerChannel);
    assert.deepEqual(localMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });
    assert.deepEqual(dockerMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'docker',
      available: true,
      reason: null,
    });
  } finally {
    await fixture.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 2 — container lifecycle, mounts and execution location (D5.3)
// ---------------------------------------------------------------------------

function createEntries(fixture: Fixture): FakeLogEntry[] {
  return fixture.log().filter((entry) => entry['op'] === 'create');
}

function execEntries(fixture: Fixture): FakeLogEntry[] {
  return fixture.log().filter((entry) => entry['op'] === 'exec');
}

test('the first Docker round creates one container per (member, target) with the three fixed mounts and reuses it', async () => {
  const fixture = await startFixture('allibot-docker-lifecycle-');
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    const channelId = await createChannel(fixture, 'Docker 生命周期');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);

    await sendMessage(fixture, channelId, '第一次');
    const rows = await messages(fixture, channelId);
    const reply = rows.find((row) => row['kind'] === 'agent');
    assert.ok(reply !== undefined, 'the Docker round replied');
    const body = reply['body'] as string;
    assert.match(body, /\[workspace\] root:.+ backend:docker/);
    assert.match(body, /\[workspace-read\] ok path:notes\.txt content:NEEDLE-ONE/);
    assert.match(body, /\[workspace-glob\] ok paths:notes\.txt,sub\/second\.txt/);
    assert.match(body, /\[workspace-grep\] ok matches:2/);
    assert.match(body, /\[workspace-write\] ok path:written\.txt/);
    assert.match(body, /\[workspace-edit\] ok path:written\.txt replacements:1/);
    assert.match(body, /\[workspace-reread\] ok path:written\.txt content:edited-by-tool/);
    assert.match(body, /\[workspace-dotdot\] error:outside-root/);
    assert.match(body, /\[workspace-absolute\] error:outside-root/);
    assert.match(body, /\[workspace-symlink\] error:outside-root/);
    assert.match(body, /\[workspace-home-write\] error:(outside-root|read-only)/);
    assert.match(body, /\[workspace-tools\] Read,Glob,Grep,Write,Edit,Bash/);
    // The bind mount is real: the write landed in the host project root.
    assert.equal(
      readFileSync(path.join(fixture.project, 'written.txt'), 'utf8'),
      'edited-by-tool',
    );

    const creates = createEntries(fixture);
    assert.equal(creates.length, 1, 'one container for the first use of the context');
    const created = creates[0]!;
    assert.equal(created['image'], IMAGE);
    const labels = created['labels'] as Record<string, string>;
    assert.equal(typeof labels['allibot.workspace'], 'string');
    assert.equal(labels['allibot.member'], agentId);
    assert.equal(labels['allibot.target'], channelId);
    assert.deepEqual(created['mounts'], [
      { source: realpathSync(fixture.project), target: '/workspace', read_only: false },
      {
        source: path.join(realpathSync(fixture.home), '.allibot', 'agents', agentId),
        target: '/agent-home',
        read_only: true,
      },
      {
        source: path.join(realpathSync(fixture.home), '.allibot', 'skills'),
        target: '/skills',
        read_only: true,
      },
    ]);
    for (const mount of created['mounts'] as { source: string; target: string }[]) {
      assert.equal(
        mount.source.startsWith(realpathSync(fixture.dataDir)),
        false,
        'the data directory is never mounted',
      );
      assert.notEqual(mount.target, fixture.dataDir);
    }

    // Every tool call ran through `docker exec` with cwd /workspace; nothing
    // read the host project directory directly.
    const execs = execEntries(fixture);
    assert.ok(execs.length >= 8, `file tools exec inside the container (${execs.length})`);
    for (const entry of execs) {
      assert.equal(entry['cwd'], '/workspace');
      assert.equal(entry['container'], 'fake-1');
    }
    assert.ok(
      execs.some((entry) =>
        (entry['argv'] as string[]).some((value) => value.includes('/workspace/notes.txt')),
      ),
      'the read targets the container path',
    );

    // The second round reuses the same container: no second create.
    await sendMessage(fixture, channelId, '第二次');
    assert.equal(createEntries(fixture).length, 1, 'the in-process context is reused');
    assert.ok(execEntries(fixture).length > execs.length, 'the second round executed tools');
  } finally {
    await fixture.stop();
  }
});

test('different targets never share a container and a restarted process creates its own', async () => {
  const fixture = await startFixture('allibot-docker-targets-');
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    const first = await createChannel(fixture, 'Docker 一');
    const second = await createChannel(fixture, 'Docker 二');
    await joinChannel(fixture, first, agentId);
    await joinChannel(fixture, second, agentId);
    await configureDockerChannel(fixture, first, fixture.project);
    await configureDockerChannel(fixture, second, fixture.project);

    await sendMessage(fixture, first, '一');
    await sendMessage(fixture, second, '二');
    const creates = createEntries(fixture);
    assert.equal(creates.length, 2, 'one container per (member, target)');
    const targets = creates.map(
      (entry) => (entry['labels'] as Record<string, string>)['allibot.target'],
    );
    assert.deepEqual([...targets].sort(), [first, second].sort());
    const ids = creates.map((entry) => `${entry['name']}`);
    assert.notEqual(ids[0], ids[1]);

    // Crash leaves the containers behind; the next process cleans the ones
    // carrying this application's marker before it serves a round.
    const leaked = Object.keys(fixture.state().containers);
    assert.equal(leaked.length, 2);
    await fixture.crash();
    await fixture.restart();
    const afterStartup = fixture.log();
    const removals = afterStartup.filter((entry) => entry['op'] === 'rm').map((entry) => entry['container']);
    for (const id of leaked) {
      assert.ok(removals.includes(id), `startup cleanup removed the residual ${id}`);
    }
    assert.equal(Object.keys(fixture.state().containers).length, 0);

    await sendMessage(fixture, first, '重启后');
    const restartedCreates = createEntries(fixture);
    assert.equal(restartedCreates.length, 3, 'a restarted process never reuses an old container');
    const newId = restartedCreates[2]!['name'];
    assert.equal(ids.includes(`${newId}`), false);
    assert.equal(Object.keys(fixture.state().containers).length, 1);
  } finally {
    await fixture.stop();
  }
});

test('process exit stops and removes every container it created', async () => {
  const fixture = await startFixture('allibot-docker-exit-');
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    const channelId = await createChannel(fixture, 'Docker 退出');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);
    await sendMessage(fixture, channelId, '跑一轮');
    const created = createEntries(fixture)[0]!;
    assert.equal(Object.keys(fixture.state().containers).length, 1);

    await fixture.running.stop();
    const log = fixture.log();
    const stopped = log.filter((entry) => entry['op'] === 'stop').map((entry) => entry['container']);
    const removed = log.filter((entry) => entry['op'] === 'rm').map((entry) => entry['container']);
    assert.deepEqual(stopped, [created['id']]);
    assert.deepEqual(removed, [created['id']]);
    assert.equal(Object.keys(fixture.state().containers).length, 0);
  } finally {
    await removeTempDir(fixture.tmp);
  }
});

// ---------------------------------------------------------------------------
// Slice 3 — unavailability, image consent and zero local fallback (D5.3 / D5.7)
// ---------------------------------------------------------------------------

async function consentDockerImage(fixture: Fixture): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, '/api/remote-data-flow/consent', {
    scope_kind: 'docker',
    scope_id: IMAGE,
  });
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function remoteFlow(fixture: Fixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/remote-data-flow`);
  assert.equal(response.status, 200, await response.clone().text());
  return await readJson(response);
}

async function runtimeDocker(fixture: Fixture): Promise<Record<string, unknown>> {
  const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
  return (workspace['workspace_runtime'] as Record<string, unknown>)['docker'] as Record<
    string,
    unknown
  >;
}

async function expectUnavailableRound(
  fixture: Fixture,
  channelId: string,
  agentId: string,
  reason: string,
): Promise<void> {
  // A sentinel only a host-side tool could read; the Docker round never does.
  writeFileSync(path.join(fixture.project, 'sentinel.txt'), 'LOCAL-FALLBACK\n');
  await sendMessage(fixture, channelId, '不可用');
  const rows = await messages(fixture, channelId);
  assert.equal(rows.length, 1, 'the round failed before the adapter: the human message only');
  assert.equal(
    rows.some((row) => (row['body'] as string).includes('LOCAL-FALLBACK')),
    false,
  );
  const outcome = roundOutcome(fixture.dataDir, agentId, channelId);
  assert.equal(outcome?.['status'], 'failed');
  assert.match(outcome?.['reason'] as string, new RegExp(reason));
  assert.match(outcome?.['reason'] as string, /不回落/);
  assert.equal(
    existsSync(path.join(fixture.project, 'written.txt')),
    false,
    'no local file tool wrote into the project root',
  );
  assert.deepEqual(execEntries(fixture), [], 'zero tool executions');
  const members = await targetMembers(fixture, channelId);
  assert.deepEqual(members.find((m) => m['id'] === agentId)?.['workspace_status'], {
    backend: 'docker',
    available: false,
    reason,
  });
}

test('a missing daemon reads docker-unavailable and the round never falls back to local tools', async () => {
  const fixture = await startFixture('allibot-docker-nodaemon-', {
    state: { daemon: 'absent' },
  });
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, 'Docker 无 daemon');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);

    assert.deepEqual(await runtimeDocker(fixture), {
      available: false,
      image: IMAGE,
      reason: 'docker-unavailable',
    });
    await expectUnavailableRound(fixture, channelId, agentId, 'docker-unavailable');
    assert.equal(createEntries(fixture).length, 0, 'no container was attempted');
    const ops = fixture.log().map((entry) => entry['op']);
    assert.equal(ops.includes('pull'), false, 'no image pull without a daemon');
  } finally {
    await fixture.stop();
  }
});

test('an image that is not local needs the one-time docker consent before any pull', async () => {
  const fixture = await startFixture('allibot-docker-consent-', {
    state: { images: [] },
  });
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    const channelId = await createChannel(fixture, 'Docker 未确认');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);

    assert.deepEqual(await runtimeDocker(fixture), {
      available: false,
      image: IMAGE,
      reason: 'docker-consent-missing',
    });
    await expectUnavailableRound(fixture, channelId, agentId, 'docker-consent-missing');
    assert.equal(
      fixture.log().some((entry) => entry['op'] === 'pull'),
      false,
      'an unconfirmed image is never pulled',
    );
    assert.equal(createEntries(fixture).length, 0);
    assert.deepEqual((await remoteFlow(fixture))['docker_consents'], []);

    const confirmation = await consentDockerImage(fixture);
    assert.equal(confirmation['scope_kind'], 'docker');
    assert.equal(confirmation['scope_id'], IMAGE);
    assert.equal(typeof confirmation['confirmed_at'], 'string');
    const firstConfirmedAt = confirmation['confirmed_at'];
    const flow = await remoteFlow(fixture);
    const consents = flow['docker_consents'] as Record<string, unknown>[];
    assert.deepEqual(
      consents.map((row) => [row['scope_kind'], row['scope_id']]),
      [['docker', IMAGE]],
    );
    assert.equal(
      JSON.stringify(flow).includes('registry') || JSON.stringify(flow).includes('password'),
      false,
      'the consent reading stores scope and time only',
    );

    // A same-scope replay keeps the first time (D2.4).
    const replay = await consentDockerImage(fixture);
    assert.equal(replay['confirmed_at'], firstConfirmedAt);

    // The next round may pull, create and execute; status becomes available.
    await sendMessage(fixture, channelId, '确认后');
    const rows = await messages(fixture, channelId);
    const reply = rows.find((row) => row['kind'] === 'agent');
    assert.ok(reply !== undefined, 'the confirmed round replied');
    assert.match(reply['body'] as string, /\[workspace-read\] ok/);
    assert.equal(
      fixture.log().filter((entry) => entry['op'] === 'pull').length,
      1,
      'the consented pull ran once',
    );
    assert.equal(createEntries(fixture).length, 1);
    assert.ok(execEntries(fixture).length > 0);
    const members = await targetMembers(fixture, channelId);
    assert.deepEqual(members.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'docker',
      available: true,
      reason: null,
    });
    assert.deepEqual(await runtimeDocker(fixture), {
      available: true,
      image: IMAGE,
      reason: null,
    });
    // The confirmation is still the same one-time fact.
    const after = (await remoteFlow(fixture))['docker_consents'] as Record<string, unknown>[];
    assert.equal(after[0]?.['confirmed_at'], firstConfirmedAt);
  } finally {
    await fixture.stop();
  }
});

test('a failed pull reads docker-image-missing and never creates a container', async () => {
  const fixture = await startFixture('allibot-docker-pullfail-', {
    state: { images: [], pull: 'fail' },
  });
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, 'Docker 拉取失败');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);
    await consentDockerImage(fixture);

    await expectUnavailableRound(fixture, channelId, agentId, 'docker-image-missing');
    const pulls = fixture.log().filter((entry) => entry['op'] === 'pull');
    assert.equal(pulls.length, 1);
    assert.equal(pulls[0]?.['result'], 'fail');
    assert.equal(createEntries(fixture).length, 0);
    assert.deepEqual(await runtimeDocker(fixture), {
      available: false,
      image: IMAGE,
      reason: 'docker-image-missing',
    });
  } finally {
    await fixture.stop();
  }
});

test('a pull that leaves the image missing reads docker-image-missing', async () => {
  const fixture = await startFixture('allibot-docker-imagemissing-', {
    state: { images: [], pull: 'noop' },
  });
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, 'Docker 镜像缺失');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);
    await consentDockerImage(fixture);

    await expectUnavailableRound(fixture, channelId, agentId, 'docker-image-missing');
    assert.equal(createEntries(fixture).length, 0);
    assert.deepEqual((await fixture.state()).images, []);
  } finally {
    await fixture.stop();
  }
});

test('a failed container creation reads docker-unavailable on that target only', async () => {
  const fixture = await startFixture('allibot-docker-createfail-', {
    state: { create: 'fail' },
  });
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, 'Docker 创建失败');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);

    await expectUnavailableRound(fixture, channelId, agentId, 'docker-unavailable');
    const creates = createEntries(fixture);
    assert.equal(creates.length, 1, 'creation was attempted once');
    assert.equal(creates[0]?.['result'], 'fail');
    assert.deepEqual(execEntries(fixture), []);
    // The process-level reading stays "Docker + image are fine"; the failure is
    // the target context's fact, not a global status point.
    assert.deepEqual(await runtimeDocker(fixture), {
      available: true,
      image: IMAGE,
      reason: null,
    });
  } finally {
    await fixture.stop();
  }
});

test('the same Agent reads independently in a local and a Docker channel; Docker faults stay per target', async () => {
  const fixture = await startFixture('allibot-docker-independent-', {
    state: { daemon: 'absent' },
    // A present (fake) credential keeps the global status point online, so the
    // Docker fault is the only workspace fact under test.
    env: { OPENAI_API_KEY: 'test-openai-key-not-a-real-secret' },
  });
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    // The Agent's model provider consent is the M1 availability fact; with it
    // and the fake credential the status point starts online.
    const consent = await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    assert.equal(consent.status, 200, await consent.clone().text());
    const localChannel = await createChannel(fixture, '本地可用');
    const dockerChannel = await createChannel(fixture, 'Docker 不可用');
    await joinChannel(fixture, localChannel, agentId);
    await joinChannel(fixture, dockerChannel, agentId);
    await configureChannel(fixture, localChannel, {
      workspace_root: fixture.project,
      permission_mode: 'trusted-writes',
    });
    await configureDockerChannel(fixture, dockerChannel, fixture.project);

    // The Docker target is unavailable; the local target with the same Agent
    // and the same root is available.
    const dockerMembers = await targetMembers(fixture, dockerChannel);
    assert.deepEqual(dockerMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'docker',
      available: false,
      reason: 'docker-unavailable',
    });
    const localMembers = await targetMembers(fixture, localChannel);
    assert.deepEqual(localMembers.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'local',
      available: true,
      reason: null,
    });

    // The Docker failure is a readable round failure on its target.
    await sendMessage(fixture, dockerChannel, 'Docker 不可用');
    const dockerOutcome = roundOutcome(fixture.dataDir, agentId, dockerChannel);
    assert.equal(dockerOutcome?.['status'], 'failed');
    assert.match(dockerOutcome?.['reason'] as string, /docker-unavailable/);

    // The local round still runs and replies normally.
    await sendMessage(fixture, localChannel, '本地可用');
    const localReply = (await messages(fixture, localChannel)).find(
      (row) => row['kind'] === 'agent',
    );
    assert.ok(localReply !== undefined);
    assert.match(localReply['body'] as string, /backend:local/);
    assert.equal(roundOutcome(fixture.dataDir, agentId, localChannel)?.['status'], 'replied');

    // The Docker fault did not make the member's global status point "未启用":
    // no offline reason was written by the workspace fact.
    const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
    const statusPoints = workspace['status_points'] as Record<string, Record<string, unknown>>;
    assert.notEqual(statusPoints[agentId]?.['status'], 'offline');
    assert.equal(statusPoints[agentId]?.['offline_reason'], null);
  } finally {
    await fixture.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 4 — execution location, stdio MCP in the container and env isolation
// ---------------------------------------------------------------------------

interface ApprovalShape {
  reply_id: string;
  target_id: string | null;
  context_kind: string;
  status: string;
  tool_calls: {
    tool_call_id: string;
    tool_name: string;
    pattern: string;
    arguments: Record<string, unknown>;
  }[];
}

async function listApprovals(fixture: Fixture, query = 'status=all'): Promise<ApprovalShape[]> {
  const response = await fetch(`${fixture.base}/api/approvals?${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['approvals'] as unknown as ApprovalShape[];
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  for (;;) {
    last = await read();
    if (predicate(last)) {
      return last;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${label}; last: ${JSON.stringify(last)}`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function lastAgentBody(fixture: Fixture, targetId: string): Promise<string> {
  const rows = await waitFor(
    async () => (await messages(fixture, targetId)).filter((row) => row['kind'] === 'agent'),
    (value) => value.length > 0,
    'the Agent reply',
  );
  return String(rows.at(-1)?.['body'] ?? '');
}

async function approve(fixture: Fixture, replyId: string, toolCallId: string): Promise<void> {
  const response = await postJson(fixture, `/api/approvals/${replyId}`, {
    tool_call_id: toolCallId,
    confirmed: true,
  });
  assert.equal(response.status, 200, await response.clone().text());
}

function writeMcpFile(fixture: Fixture, memberId: string, servers: unknown[]): void {
  const home = path.join(fixture.home, '.allibot', 'agents', memberId);
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, 'mcp.json'), JSON.stringify({ servers }, null, 2));
}

interface HostMcpFixture {
  port: number;
  log: () => string;
  stop: () => Promise<void>;
}

async function startHostMcpServer(
  fixture: Fixture,
  mode: 'http' | 'sse',
): Promise<HostMcpFixture> {
  const portFile = path.join(fixture.tmp, `mcp-${mode}.port`);
  const logFile = path.join(fixture.tmp, `mcp-${mode}.log`);
  const child = spawn(
    process.execPath,
    [MCP_SERVER, mode, '--port-file', portFile, '--log', logFile],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  const port = await waitFor(
    async () => (existsSync(portFile) ? Number(readFileSync(portFile, 'utf8')) : 0),
    (value) => value > 0,
    `the ${mode} MCP server port`,
  );
  return {
    port,
    log: () => (existsSync(logFile) ? readFileSync(logFile, 'utf8') : ''),
    stop: async () => {
      child.kill('SIGKILL');
      await new Promise<void>((resolve) => child.once('exit', () => resolve()));
    },
  };
}

test('the container shell runs in /workspace with only the allowlist and declared env_names', async () => {
  const command =
    'printf "%s|%s|%s|%s|%s|%s" "$ANTHROPIC_API_KEY" "$OPENAI_API_KEY" ' +
    '"$ALLIBOT_WEB_CREDENTIAL" "$MCP_DECLARED_SENTINEL" "$HOME" "$LANG" > /workspace/env.txt';
  const fixture = await startFixture('allibot-docker-shell-', {
    scriptedProvider: 'shell',
    args: ['--scripted-shell-command', command],
    env: {
      ANTHROPIC_API_KEY: 'sk-ant-shell-SECRET',
      OPENAI_API_KEY: 'sk-openai-shell-SECRET',
      ALLIBOT_WEB_CREDENTIAL: 'web-credential-SECRET',
      MCP_DECLARED_SENTINEL: 'declared-value-123',
      LANG: 'C.UTF-8',
      TERM: 'xterm-256color',
    },
  });
  try {
    const agentId = await createAgent(fixture);
    copyFileSync(MCP_SERVER, path.join(fixture.project, 'mcp-server.mjs'));
    writeMcpFile(fixture, agentId, [
      {
        name: 'demo',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['/workspace/mcp-server.mjs', 'stdio', '--log', '/workspace/stdio.log'],
        env_names: ['MCP_DECLARED_SENTINEL'],
      },
    ]);
    const channelId = await createChannel(fixture, 'Docker shell');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);

    // The message POST settles the round, which waits for the human shell
    // approval: start it, answer the approval, then collect the write receipt.
    const sent = postJson(fixture, `/api/targets/${channelId}/messages`, {
      body: '跑一条容器命令',
    });
    const pending = await waitFor(
      () => listApprovals(fixture, 'status=pending'),
      (rows) => rows.length > 0,
      'the shell approval',
    );
    const approval = pending[0]!;
    assert.equal(approval.context_kind, 'round');
    assert.equal(approval.target_id, channelId);
    const call = approval.tool_calls[0]!;
    assert.equal(call.tool_name, 'Bash');
    assert.equal(call.pattern, command);
    assert.equal(call.arguments['command'], command);
    for (const value of [
      'sk-ant-shell-SECRET',
      'sk-openai-shell-SECRET',
      'web-credential-SECRET',
      'declared-value-123',
    ]) {
      assert.equal(
        JSON.stringify(approval.tool_calls).includes(value),
        false,
        'the approval frame carries no environment value',
      );
    }
    await approve(fixture, approval.reply_id, call.tool_call_id);
    const sentResponse = await sent;
    assert.equal(sentResponse.status, 201, await sentResponse.clone().text());

    const body = await lastAgentBody(fixture, channelId);
    assert.match(body, /\[shell\] enabled:true/);
    assert.match(body, /\[shell-cwd-dotdot\] error:outside-root/);
    assert.match(body, /\[shell-cwd-absolute\] error:outside-root/);
    assert.match(body, /\[shell-run-1\] ok exit:0 cwd:\/workspace/);
    assert.equal(
      readFileSync(path.join(fixture.project, 'env.txt'), 'utf8'),
      '|||declared-value-123|/agent-home|C.UTF-8',
      'only the allowlist and the declared MCP env_names reach the container process',
    );
    const shellExec = execEntries(fixture).find((entry) =>
      (entry['argv'] as string[]).includes(command),
    );
    assert.ok(shellExec !== undefined, 'the command ran through docker exec');
    assert.equal(shellExec['cwd'], '/workspace');
    const envKeys = shellExec['env_keys'] as string[];
    for (const key of ['HOME', 'PWD', 'LANG', 'TERM', 'MCP_DECLARED_SENTINEL']) {
      assert.ok(envKeys.includes(key), `${key} reaches the container process`);
    }
    for (const key of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'ALLIBOT_WEB_CREDENTIAL']) {
      assert.equal(envKeys.includes(key), false, `${key} is never passed`);
    }
  } finally {
    await fixture.stop();
  }
});

test('stdio MCP executes inside the container while http and sse MCP are connected by the host', async () => {
  const fixture = await startFixture('allibot-docker-mcp-', {
    scriptedProvider: 'mcp',
    env: {
      MCP_TEST_TOKEN: 'declared-value-123',
      ANTHROPIC_API_KEY: 'sk-ant-mcp-SECRET',
      OPENAI_API_KEY: 'sk-openai-mcp-SECRET',
    },
  });
  const httpMcp = await startHostMcpServer(fixture, 'http');
  const sseMcp = await startHostMcpServer(fixture, 'sse');
  try {
    const agentId = await createAgent(fixture);
    copyFileSync(MCP_SERVER, path.join(fixture.project, 'mcp-server.mjs'));
    writeMcpFile(fixture, agentId, [
      {
        name: 'demo',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['/workspace/mcp-server.mjs', 'stdio', '--log', '/workspace/stdio.log'],
        env_names: ['MCP_TEST_TOKEN'],
      },
      {
        name: 'remote-http',
        transport: 'http',
        enabled: true,
        url: `http://127.0.0.1:${httpMcp.port}`,
      },
      {
        name: 'remote-sse',
        transport: 'sse',
        enabled: true,
        url: `http://127.0.0.1:${sseMcp.port}`,
      },
    ]);
    for (const name of ['remote-http', 'remote-sse']) {
      const consent = await postJson(fixture, '/api/remote-data-flow/consent', {
        scope_kind: 'mcp',
        scope_id: name,
      });
      assert.equal(consent.status, 200, await consent.clone().text());
    }
    const channelId = await createChannel(fixture, 'Docker MCP');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);
    const rules = await fetch(`${fixture.base}/api/agents/${agentId}/permission-rules`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify([
        { tool_name: 'mcp:demo/echo', pattern: '', behavior: 'allow' },
        { tool_name: 'mcp:remote-http/echo', pattern: '', behavior: 'allow' },
        { tool_name: 'mcp:remote-sse/echo', pattern: '', behavior: 'allow' },
      ]),
    });
    assert.equal(rules.status, 200, await rules.clone().text());

    await sendMessage(fixture, channelId, 'MCP 轮次');
    const body = await lastAgentBody(fixture, channelId);
    assert.match(body, /\[mcp\] servers:3/);
    assert.match(body, /\[mcp-server\] demo:stdio:echo,boom/);
    assert.match(body, /\[mcp-server\] remote-http:http:echo,boom/);
    assert.match(body, /\[mcp-server\] remote-sse:sse:echo,boom/);
    assert.match(body, /\[mcp-call\] demo\/echo:ok:/);
    assert.match(body, /\[mcp-call\] remote-http\/echo:ok:/);
    assert.match(body, /\[mcp-call\] remote-sse\/echo:ok:/);
    assert.match(body, /"token":"declared-value-123"/);
    assert.match(body, /"unnamed":null/);

    // stdio ran inside the container: one docker exec with cwd /workspace and
    // the container mcp.json command.
    const stdioExec = execEntries(fixture).find((entry) =>
      (entry['argv'] as string[]).join(' ').includes('/workspace/mcp-server.mjs'),
    );
    assert.ok(stdioExec !== undefined, 'the stdio MCP server ran through docker exec');
    assert.equal(stdioExec['cwd'], '/workspace');
    const envKeys = stdioExec['env_keys'] as string[];
    assert.ok(envKeys.includes('MCP_TEST_TOKEN'));
    assert.equal(envKeys.includes('ANTHROPIC_API_KEY'), false);
    assert.equal(envKeys.includes('OPENAI_API_KEY'), false);
    // The stdio server really connected (its own log proves the handshake), and
    // its cwd is the container path, not a host directory.
    assert.match(readFileSync(path.join(fixture.project, 'stdio.log'), 'utf8'), /request initialize/);
    assert.match(readFileSync(path.join(fixture.project, 'stdio.log'), 'utf8'), /request tools\/call/);
    // http / sse were connected by the host process, with no docker exec.
    assert.match(httpMcp.log(), /http initialize/);
    assert.match(httpMcp.log(), /http tools\/call/);
    assert.match(sseMcp.log(), /sse connect/);
    assert.match(sseMcp.log(), /sse post/);
    for (const port of [httpMcp.port, sseMcp.port]) {
      assert.equal(
        JSON.stringify(execEntries(fixture)).includes(String(port)),
        false,
        'a remote MCP endpoint is never routed through the container',
      );
    }
  } finally {
    await httpMcp.stop();
    await sseMcp.stop();
    await fixture.stop();
  }
});

// ---------------------------------------------------------------------------
// Slice 5 — image configuration, root requirement and the explicit T12 boundary
// ---------------------------------------------------------------------------

test('allibot_DOCKER_IMAGE replaces the default image reference', async () => {
  const image = 'ghcr.example/custom-runtime@sha256:' + 'a'.repeat(64);
  const fixture = await startFixture('allibot-docker-image-', {
    state: { images: [image] },
    env: { allibot_DOCKER_IMAGE: image },
  });
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    const channelId = await createChannel(fixture, '自定义镜像');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);
    assert.deepEqual(await runtimeDocker(fixture), {
      available: true,
      image,
      reason: null,
    });
    await sendMessage(fixture, channelId, '自定义镜像轮次');
    assert.equal(createEntries(fixture)[0]?.['image'], image);
  } finally {
    await fixture.stop();
  }
});

test('a docker channel without a project root reads workspace-root-missing', async () => {
  const fixture = await startFixture('allibot-docker-noroot-');
  try {
    const agentId = await createAgent(fixture);
    const channelId = await createChannel(fixture, 'Docker 无根');
    await joinChannel(fixture, channelId, agentId);
    await configureChannel(fixture, channelId, { workspace_backend: 'docker' });
    const members = await targetMembers(fixture, channelId);
    assert.deepEqual(members.find((m) => m['id'] === agentId)?.['workspace_status'], {
      backend: 'docker',
      available: false,
      reason: 'workspace-root-missing',
    });
    await sendMessage(fixture, channelId, '无项目根');
    const rows = await messages(fixture, channelId);
    assert.equal(rows.length, 1, 'the round failed before the adapter');
    const outcome = roundOutcome(fixture.dataDir, agentId, channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(outcome?.['reason'] as string, /workspace-root-missing/);
  } finally {
    await fixture.stop();
  }
});

test('M2 ships no container egress policy: no docker_egress field, route or network flag', async () => {
  const fixture = await startFixture('allibot-docker-egress-');
  try {
    const agentId = await createAgent(fixture);
    seedProject(fixture, agentId);
    const channelId = await createChannel(fixture, 'Docker 网络边界');
    await joinChannel(fixture, channelId, agentId);
    await configureDockerChannel(fixture, channelId, fixture.project);
    await sendMessage(fixture, channelId, '跑一轮');
    const created = createEntries(fixture)[0]!;
    assert.equal(
      JSON.stringify(created).includes('--network'),
      false,
      'no network flag is set on the container (T12 owns the policy)',
    );
    const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
      docker_egress: 'none',
    });
    assert.equal(patched.status, 400);
    const errorBody = (await readJson(patched))['error'] as Record<string, unknown> | undefined;
    assert.equal(errorBody?.['code'] ?? 'unknown', 'validation_failed');
    const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
    assert.equal('docker_egress' in workspace, false);
    const route = await fetch(`${fixture.base}/api/docker-egress`);
    assert.equal(route.status, 404);
  } finally {
    await fixture.stop();
  }
});
