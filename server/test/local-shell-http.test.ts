import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
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
 * 本地 shell (#46 / D5.3 / D5.4 / D5.5 / D5.6), observed through the one process
 * seam: a real backend, the scripted `shell` double calling the production
 * shell face, the human REST endpoints and the live SSE stream.
 *
 * The suite never calls a private function. The scripted double only chooses
 * which production face a model would have called and reports the digest of the
 * output (never the output); every gate, cwd, environment and approval fact is
 * the production code's answer.
 */

const PROVIDER_SENTINEL = 'sk-ant-shell-SECRET';
const OPENAI_SENTINEL = 'sk-openai-shell-SECRET';
const WEB_SENTINEL = 'web-credential-SECRET';
const DECLARED_NAME = 'MCP_DECLARED_SENTINEL';
const DECLARED_VALUE = 'declared-value-123';
const LANG_VALUE = 'C.UTF-8';
const TERM_VALUE = 'xterm-256color';

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  root: string;
  running: RunningServer;
  base: string;
  channelId: string;
  agentId: string;
  stop: () => Promise<void>;
}

interface StartOptions {
  args?: readonly string[];
  configureWorkspace?: boolean;
  permissionMode?: string;
  commands?: readonly string[];
  allowLocalShell?: 0 | 1;
  env?: NodeJS.ProcessEnv;
}

async function startFixture(prefix: string, options: StartOptions = {}): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const root = path.join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(path.join(root, 'notes.txt'), 'NEEDLE-ONE\n', 'utf8');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  const commands = options.commands ?? ['pwd -P'];
  const args = [
    '--scripted-provider',
    'shell',
    ...commands.flatMap((command) => ['--scripted-shell-command', command]),
    '--shell-env-name',
    DECLARED_NAME,
    ...(options.args ?? []),
  ];
  const running = await startServer(dataDir, {
    args,
    env: {
      HOME: home,
      LANG: LANG_VALUE,
      TERM: TERM_VALUE,
      ANTHROPIC_API_KEY: PROVIDER_SENTINEL,
      OPENAI_API_KEY: OPENAI_SENTINEL,
      ALLIBOT_WEB_CREDENTIAL: WEB_SENTINEL,
      [DECLARED_NAME]: DECLARED_VALUE,
      ...(options.env ?? {}),
    },
  });
  const base = `http://127.0.0.1:${running.port}`;
  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    root,
    running,
    base,
    channelId: '',
    agentId: '',
    stop: async () => {
      await fixture.running.stop();
      await removeTempDir(tmp);
    },
  };
  fixture.agentId = await createAgent(fixture, '本地成员');
  fixture.channelId = await createChannel(fixture, '本地频道');
  await joinChannel(fixture, fixture.channelId, fixture.agentId);
  if (options.configureWorkspace !== false) {
    const response = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      workspace_root: root,
      allow_local_shell: options.allowLocalShell ?? 1,
      ...(options.permissionMode === undefined
        ? {}
        : { permission_mode: options.permissionMode }),
    });
    assert.equal(response.status, 200, await response.clone().text());
  }
  return fixture;
}

async function restartFixture(fixture: Fixture, args: readonly string[]): Promise<void> {
  await fixture.running.crash();
  fixture.running = await startServer(fixture.dataDir, {
    args,
    env: { HOME: fixture.home },
  });
  fixture.base = `http://127.0.0.1:${fixture.running.port}`;
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

async function putJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createAgent(fixture: Fixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
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

async function sendMessage(fixture: Fixture, targetId: string, body: string): Promise<Response> {
  return await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
}

async function messages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages?limit=50`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

async function lastAgentBody(fixture: Fixture, targetId: string): Promise<string> {
  const rows = (await messages(fixture, targetId)).filter((row) => row['kind'] === 'agent');
  return String(rows.at(-1)?.['body'] ?? '');
}

interface ApprovalShape {
  reply_id: string;
  target_id: string | null;
  context_kind: string;
  context_id: string | null;
  status: string;
  requested_at: string;
  resolved_at: string | null;
  tool_calls: {
    tool_call_id: string;
    tool_name: string;
    pattern: string;
    batch: number;
    arguments: Record<string, unknown>;
  }[];
  decisions: { tool_call_id: string; confirmed: boolean; decided_at: string }[];
  batches: { batch: number; tool_calls: unknown[]; decisions: unknown[] }[];
}

async function listApprovals(fixture: Fixture, query = 'status=all'): Promise<ApprovalShape[]> {
  const response = await fetch(`${fixture.base}/api/approvals?${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['approvals'] as unknown as ApprovalShape[];
}

async function getApproval(fixture: Fixture, replyId: string): Promise<ApprovalShape> {
  const response = await fetch(`${fixture.base}/api/approvals/${replyId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response)) as unknown as ApprovalShape;
}

async function waitFor<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  label: string,
  timeoutMs = 8_000,
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

async function waitForPending(fixture: Fixture): Promise<ApprovalShape> {
  const rows = await waitFor(
    () => listApprovals(fixture, 'status=pending'),
    (value) => value.length > 0,
    'a pending approval',
  );
  return rows[0]!;
}

function queryDatabase<T>(dataDir: string, sql: string, params: unknown[] = []): T[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).all(...(params as never[])) as T[];
  } finally {
    db.close();
  }
}

function latestOutcome(fixture: Fixture, targetId: string): Record<string, unknown> | undefined {
  return queryDatabase<Record<string, unknown>>(
    fixture.dataDir,
    'SELECT status, reason FROM round_outcome WHERE target_id = ? ORDER BY rowid DESC LIMIT 1',
    [targetId],
  )[0];
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function shellRunLine(label: string, stdout: string, exitCode = 0): RegExp {
  const digest = sha256(stdout);
  return new RegExp(
    `\\[${label}\\] ok exit:${exitCode} cwd:.* stdout-bytes:${Buffer.byteLength(stdout)} ` +
      `stdout-sha256:${digest}`,
  );
}

async function channelWorkspace(fixture: Fixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/channels/${fixture.channelId}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['workspace'] as Record<string, unknown>;
}

async function workspaceChannel(fixture: Fixture): Promise<Record<string, unknown>> {
  const response = await fetch(`${fixture.base}/api/workspace`);
  assert.equal(response.status, 200, await response.clone().text());
  const reading = await readJson(response);
  return ((reading['channels'] as Record<string, unknown>[])[0] ?? {}) as Record<string, unknown>;
}

async function targetMemberRows(fixture: Fixture): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${fixture.channelId}/members`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['members'] as Record<string, unknown>[];
}

test('allow_local_shell=0: a round shell call is DENIED without an approval; channel / workspace / target readings agree', async () => {
  const fixture = await startFixture('allibot-shell-disabled-', {
    allowLocalShell: 0,
    commands: ['printf disabled > disabled.txt'],
  });
  try {
    const sent = await sendMessage(fixture, fixture.channelId, '关闭 shell 的轮次');
    assert.equal(sent.status, 201, await sent.clone().text());
    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, /\[shell\] enabled:false/);
    assert.match(body, /\[shell-run-1\] error:denied/);
    assert.match(body, /\[shell-tools\] Read,Glob,Grep,Write,Edit$/m);
    assert.equal(body.includes('Bash'), false, 'the disabled shell is not offered as a tool');
    assert.equal(existsSync(path.join(fixture.root, 'disabled.txt')), false);
    assert.deepEqual(await listApprovals(fixture), [], 'a disabled shell never asks');
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');

    const channel = await channelWorkspace(fixture);
    const workspaceChannelReading = await workspaceChannel(fixture);
    assert.deepEqual(workspaceChannelReading['workspace'], channel);
    assert.equal(channel['allow_local_shell'], 0);
    const rows = await targetMemberRows(fixture);
    assert.deepEqual(
      rows.map((row) => row['allow_local_shell']),
      [0, 0],
      'the target reading carries the channel switch for every member',
    );
  } finally {
    await fixture.stop();
  }
});

test('allow_local_shell=1: trusted-writes and a matching allow rule still ask; approval runs the command in the project root', async () => {
  const fixture = await startFixture('allibot-shell-approved-', {
    permissionMode: 'trusted-writes',
    commands: ['printf approved > shell-approved.txt'],
  });
  try {
    const rules = await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Bash', pattern: '*', behavior: 'allow' },
    ]);
    assert.equal(rules.status, 200, await rules.clone().text());

    const pendingReply = sendMessage(fixture, fixture.channelId, '批准 shell');
    const pending = await waitForPending(fixture);
    const call = pending.tool_calls[0]!;
    assert.equal(pending.context_kind, 'round');
    assert.equal(pending.target_id, fixture.channelId);
    assert.equal(call.tool_name, 'Bash');
    assert.equal(call.pattern, 'printf approved > shell-approved.txt');
    assert.deepEqual(call.arguments, {
      tool_name: 'Bash',
      command: 'printf approved > shell-approved.txt',
    });
    assert.equal(
      JSON.stringify(pending.tool_calls).includes(PROVIDER_SENTINEL),
      false,
      'the approval summary carries no tool environment',
    );
    const waitingBody = await lastAgentBody(fixture, fixture.channelId).catch(() => '');
    assert.equal(waitingBody.includes('[shell-run-1]'), false, 'the round waits for the decision');

    const approved = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: call.tool_call_id,
      confirmed: true,
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());

    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, /\[shell\] enabled:true root:/);
    assert.match(body, shellRunLine('shell-run-1', ''));
    assert.match(body, /\[shell-tools\] Read,Glob,Grep,Write,Edit,Bash$/m);
    assert.equal(readFileSync(path.join(fixture.root, 'shell-approved.txt'), 'utf8'), 'approved');
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');
    const row = await getApproval(fixture, pending.reply_id);
    assert.equal(row.status, 'confirmed');
    assert.equal((await channelWorkspace(fixture))['allow_local_shell'], 1);
    assert.equal((await targetMemberRows(fixture))[1]?.['allow_local_shell'], 1);
  } finally {
    await fixture.stop();
  }
});

test('a denied shell call is DENIED and the round continues; a deny rule blocks without asking; read-only is a hard boundary', async () => {
  const fixture = await startFixture('allibot-shell-denied-', {
    permissionMode: 'trusted-writes',
    commands: ['printf one > one.txt', 'printf two > two.txt'],
  });
  try {
    const deniedReply = sendMessage(fixture, fixture.channelId, '拒绝第一个 shell');
    const first = await waitForPending(fixture);
    const firstCall = first.tool_calls[0]!;
    const denied = await postJson(fixture, `/api/approvals/${first.reply_id}`, {
      tool_call_id: firstCall.tool_call_id,
      confirmed: false,
    });
    assert.equal(denied.status, 200, await denied.clone().text());

    // The round continues with the second call and asks again (batch 2).
    const second = await waitFor(
      () => getApproval(fixture, first.reply_id),
      (value) => value.batches.some((batch) => batch.batch === 2),
      'the second shell batch',
    );
    const secondCall = second.tool_calls.find((call) => call.tool_call_id !== firstCall.tool_call_id)!;
    assert.equal(secondCall.pattern, 'printf two > two.txt');
    const approved = await postJson(fixture, `/api/approvals/${first.reply_id}`, {
      tool_call_id: secondCall.tool_call_id,
      confirmed: true,
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const sent = await deniedReply;
    assert.equal(sent.status, 201, await sent.clone().text());

    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, /\[shell-run-1\] error:denied/);
    assert.match(body, shellRunLine('shell-run-2', ''));
    assert.equal(existsSync(path.join(fixture.root, 'one.txt')), false);
    assert.equal(readFileSync(path.join(fixture.root, 'two.txt'), 'utf8'), 'two');
    assert.equal((await getApproval(fixture, first.reply_id)).status, 'denied');
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');

    // A deny rule wins even with the switch on: no approval, tool result DENIED.
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, { allow_local_shell: 1 });
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Bash', pattern: '*', behavior: 'deny' },
    ]);
    const denySent = await sendMessage(fixture, fixture.channelId, '规则拒绝 shell');
    assert.equal(denySent.status, 201, await denySent.clone().text());
    const denyBody = await lastAgentBody(fixture, fixture.channelId);
    assert.match(denyBody, /\[shell-run-1\] error:denied/);
    assert.equal(existsSync(path.join(fixture.root, 'one.txt')), false);

    // read-only is a hard ceiling: an allow rule cannot widen execution.
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      permission_mode: 'read-only',
      allow_local_shell: 1,
    });
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Bash', pattern: '*', behavior: 'allow' },
    ]);
    const before = (await listApprovals(fixture)).length;
    const readOnlySent = await sendMessage(fixture, fixture.channelId, '只读 shell');
    assert.equal(readOnlySent.status, 201, await readOnlySent.clone().text());
    const readOnlyBody = await lastAgentBody(fixture, fixture.channelId);
    assert.match(readOnlyBody, /\[shell-run-1\] error:denied/);
    assert.equal((await listApprovals(fixture)).length, before, 'a hard boundary never asks');
  } finally {
    await fixture.stop();
  }
});

test('cwd is the project root; .. and root-outside absolute cwds are hard errors before any approval', async () => {
  const fixture = await startFixture('allibot-shell-cwd-', {
    commands: ['pwd -P'],
  });
  try {
    const pendingReply = sendMessage(fixture, fixture.channelId, '工作目录');
    const pending = await waitForPending(fixture);
    assert.equal(pending.tool_calls.length, 1, 'the boundary probes never register an approval');
    assert.equal(pending.tool_calls[0]!.pattern, 'pwd -P');
    const approved = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());

    const root = realpathSync(fixture.root);
    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, new RegExp(`\\[shell-run-1\\] ok exit:0 cwd:${escapeRegExp(root)} `));
    assert.match(body, /\[shell-cwd-dotdot\] error:outside-root/);
    assert.match(body, /\[shell-cwd-absolute\] error:outside-root/);

  } finally {
    await fixture.stop();
  }
});

test('the shell environment is the allowlist plus declared env_names; provider keys and web credentials are absent', async () => {
  const command =
    "printf '%s|%s|%s|%s|%s|%s|%s' \"$MCP_DECLARED_SENTINEL\" " +
    "\"${ANTHROPIC_API_KEY-ABSENT}\" \"${OPENAI_API_KEY-ABSENT}\" " +
    "\"${ALLIBOT_WEB_CREDENTIAL-ABSENT}\" \"$LANG\" \"$TERM\" \"$HOME\"";
  const fixture = await startFixture('allibot-shell-env-', { commands: [command] });
  try {
    // `HOME` in the child must be the server's temp home, not the test process
    // home; compute it from the fixture after startup.
    const expectedEnv =
      `${DECLARED_VALUE}|ABSENT|ABSENT|ABSENT|${LANG_VALUE}|${TERM_VALUE}|${fixture.home}`;
    const pendingReply = sendMessage(fixture, fixture.channelId, '环境');
    const pending = await waitForPending(fixture);
    const call = pending.tool_calls[0]!;
    assert.equal(call.tool_name, 'Bash');
    assert.equal(call.pattern, command);
    assert.deepEqual(Object.keys(call.arguments).sort(), ['command', 'tool_name']);
    assert.equal(JSON.stringify(call.arguments).includes(DECLARED_VALUE), false);
    assert.equal(JSON.stringify(call.arguments).includes(PROVIDER_SENTINEL), false);
    const approved = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: call.tool_call_id,
      confirmed: true,
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());

    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, shellRunLine('shell-run-1', expectedEnv));
    assert.equal(body.includes(DECLARED_VALUE), false, 'values stay out of the reply');
    assert.equal(body.includes(PROVIDER_SENTINEL), false);
    assert.equal(body.includes(WEB_SENTINEL), false);
  } finally {
    await fixture.stop();
  }
});

test('shell output and env values are not written to the database, approval rows, SSE or logs', async () => {
  const command = `node -e "process.stdout.write('SHELL'+'-OUTPUT-'+'SENTINEL')"`;
  const fixture = await startFixture('allibot-shell-output-', { commands: [command] });
  try {
    const pendingReply = sendMessage(fixture, fixture.channelId, '输出不落库');
    const pending = await waitForPending(fixture);
    const approved = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(approved.status, 200, await approved.clone().text());
    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());

    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, shellRunLine('shell-run-1', 'SHELL-OUTPUT-SENTINEL'));

    const messageRows = queryDatabase<{ body: string }>(
      fixture.dataDir,
      'SELECT body FROM message',
    );
    const outcomeRows = queryDatabase<{ reason: string }>(
      fixture.dataDir,
      'SELECT reason FROM round_outcome',
    );
    const approvalRows = queryDatabase<{ tool_calls: string; decisions: string }>(
      fixture.dataDir,
      'SELECT tool_calls, decisions FROM approval_request',
    );
    const searchable = [
      ...messageRows.map((row) => row.body),
      ...outcomeRows.map((row) => row.reason),
      ...approvalRows.map((row) => row.tool_calls),
      ...approvalRows.map((row) => row.decisions),
    ].join('\n');
    assert.equal(searchable.includes('SHELL-OUTPUT-SENTINEL'), false);
    assert.equal(searchable.includes(DECLARED_VALUE), false);
    assert.equal(searchable.includes(PROVIDER_SENTINEL), false);
    const logs = fixture.running.logs();
    assert.equal((logs.stdout + logs.stderr).includes('SHELL-OUTPUT-SENTINEL'), false);
  } finally {
    await fixture.stop();
  }
});

test('a shell approval that waits past the timeout closes failed and the round fails with a readable reason', async () => {
  const fixture = await startFixture('allibot-shell-timeout-', {
    args: ['--approval-timeout-ms', '200', '--fixed-clock', '2026-11-04T00:00:00.000Z'],
    commands: ['printf timeout > timeout.txt'],
  });
  try {
    const sent = await sendMessage(fixture, fixture.channelId, 'shell 超时');
    assert.equal(sent.status, 201, await sent.clone().text());
    const rows = await waitFor(
      () => listApprovals(fixture, 'status=all'),
      (value) => value.length > 0 && value[0]!.status === 'failed',
      'the timed-out shell approval',
    );
    assert.equal(rows[0]!.status, 'failed');
    assert.equal(rows[0]!.tool_calls[0]!.tool_name, 'Bash');
    assert.equal(rows[0]!.requested_at, '2026-11-04T00:00:00.000Z');
    assert.equal(rows[0]!.resolved_at, '2026-11-04T00:00:00.000Z');
    assert.equal(rows[0]!.decisions.length, 0);
    const outcome = latestOutcome(fixture, fixture.channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(String(outcome?.['reason']), /审批等待超时/);
    assert.equal(existsSync(path.join(fixture.root, 'timeout.txt')), false);
  } finally {
    await fixture.stop();
  }
});

test('a pending shell approval becomes expired on restart and is never replayed', async () => {
  const fixture = await startFixture('allibot-shell-restart-', {
    commands: ['printf restart > restart.txt'],
  });
  try {
    const pendingReply = sendMessage(fixture, fixture.channelId, '重启前 shell');
    void pendingReply.catch(() => undefined);
    const pending = await waitForPending(fixture);
    assert.equal(pending.tool_calls[0]!.tool_name, 'Bash');
    await restartFixture(fixture, ['--scripted-provider', 'shell']);
    const rows = await waitFor(
      () => listApprovals(fixture, 'status=all'),
      (value) => value.length > 0 && value[0]!.status === 'expired',
      'the expired shell approval',
    );
    assert.equal(rows[0]!.reply_id, pending.reply_id);
    assert.equal(rows[0]!.status, 'expired');
    assert.ok(rows[0]!.resolved_at !== null);
    const workspace = await fetch(`${fixture.base}/api/workspace`);
    assert.equal((await readJson(workspace))['pending_approvals'], 0);
    const late = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(late.status, 409);
    assert.equal(existsSync(path.join(fixture.root, 'restart.txt')), false);
  } finally {
    await fixture.stop();
  }
});

test('no project root means no shell; a configured root that disappears fails the round before the provider', async () => {
  const fixture = await startFixture('allibot-shell-noroot-', {
    configureWorkspace: false,
    commands: ['printf noroot > noroot.txt'],
  });
  try {
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, { allow_local_shell: 1 });
    const sent = await sendMessage(fixture, fixture.channelId, '没有项目根');
    assert.equal(sent.status, 201, await sent.clone().text());
    const body = await lastAgentBody(fixture, fixture.channelId);
    assert.match(body, /\[shell\] available:false/);
    assert.match(body, /\[shell-tools\] -/);
    assert.equal(existsSync(path.join(fixture.root, 'noroot.txt')), false);
    assert.deepEqual(await listApprovals(fixture), []);

    // A configured root that vanished fails the round before the adapter runs:
    // zero tool calls, zero approvals, a readable workspace-root-missing.
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      workspace_root: fixture.root,
      allow_local_shell: 1,
    });
    rmSync(fixture.root, { recursive: true, force: true });
    const before = (await messages(fixture, fixture.channelId)).length;
    const failed = await sendMessage(fixture, fixture.channelId, '根不见了');
    assert.equal(failed.status, 201, await failed.clone().text());
    const outcome = latestOutcome(fixture, fixture.channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(String(outcome?.['reason']), /workspace-root-missing/);
    const after = await messages(fixture, fixture.channelId);
    assert.equal(after.length, before + 1, 'only the human message lands');
    assert.equal(
      after.slice(before).some((row) => String(row['body']).includes('[shell')),
      false,
      'the failed round lands no provider reply',
    );
    assert.deepEqual(await listApprovals(fixture), []);
    const rows = await targetMemberRows(fixture);
    assert.deepEqual(rows[0]?.['workspace_status'], {
      backend: 'local',
      available: false,
      reason: 'workspace-root-missing',
    });
  } finally {
    await fixture.stop();
  }
});

test('allow_local_shell is channel-only: agent PATCH rejects it, invalid values are 400, readings stay consistent', async () => {
  const fixture = await startFixture('allibot-shell-channel-only-', {
    configureWorkspace: false,
  });
  try {
    const agentPatch = await patchJson(fixture, `/api/agents/${fixture.agentId}`, {
      allow_local_shell: 1,
    });
    assert.equal(agentPatch.status, 400, await agentPatch.clone().text());
    assert.equal(
      ((await readJson(agentPatch))['error'] as Record<string, unknown>)['code'],
      'validation_failed',
    );
    const agentView = await fetch(`${fixture.base}/api/agents/${fixture.agentId}`);
    assert.equal(Object.hasOwn(await readJson(agentView), 'allow_local_shell'), false);

    for (const invalid of [2, '1', true, null, -1]) {
      const patch = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
        allow_local_shell: invalid,
      });
      assert.equal(patch.status, 400, `invalid switch ${JSON.stringify(invalid)}`);
      assert.equal((await channelWorkspace(fixture))['allow_local_shell'], 0);
    }

    const enabled = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      allow_local_shell: 1,
    });
    assert.equal(enabled.status, 200, await enabled.clone().text());
    const channel = await channelWorkspace(fixture);
    assert.equal(channel['allow_local_shell'], 1);
    assert.deepEqual((await workspaceChannel(fixture))['workspace'], channel);
    const targetRows = await targetMemberRows(fixture);
    assert.deepEqual(
      targetRows.map((row) => row['allow_local_shell']),
      [1, 1],
    );
    const channelMemberRows = await fetch(
      `${fixture.base}/api/channels/${fixture.channelId}/members`,
    );
    const channelRows = (await readJson(channelMemberRows))['members'] as Record<string, unknown>[];
    assert.deepEqual(
      channelRows.map((row) => row['allow_local_shell']),
      [1, 1],
      'the channel member read and the target member read agree',
    );

    // Same-value replay is a stable 200 and does not move the reading.
    const replay = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      allow_local_shell: 1,
    });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await channelWorkspace(fixture))['allow_local_shell'], 1);
  } finally {
    await fixture.stop();
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
