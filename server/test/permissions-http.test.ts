import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
 * 权限档、权限规则与审批 (#44 / D5.5 / D5.6 / D2.3), observed through the one
 * process seam: a real backend, the scripted provider calling the production
 * gate / file-tool face, the human REST endpoints and the live SSE stream.
 *
 * The suite is one seam: it never calls a private function. The scripted
 * `permission` / `mcp-approval` / `team-approval` behaviours only choose which
 * production face the round calls, exactly like a model would.
 */

const ROOT_FILES: Record<string, string> = {
  'notes.txt': 'NEEDLE-ONE second line\n',
  'sub/second.txt': 'NEEDLE-TWO\n',
};

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
  behavior?: string;
  args?: readonly string[];
  configureWorkspace?: boolean;
  permissionMode?: string;
}

async function startFixture(prefix: string, options: StartOptions = {}): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const root = path.join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(path.join(root, 'sub'), { recursive: true });
  for (const [name, body] of Object.entries(ROOT_FILES)) {
    writeFileSync(path.join(root, name), body, 'utf8');
  }
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', options.behavior ?? 'permission', ...(options.args ?? [])],
    env: { HOME: home, OPENAI_API_KEY: 'sk-permissions-test' },
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
  fixture.agentId = await createAgent(fixture, '权限成员');
  fixture.channelId = await createChannel(fixture, '权限频道');
  await joinChannel(fixture, fixture.channelId, fixture.agentId);
  if (options.configureWorkspace !== false) {
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      workspace_root: root,
      ...(options.permissionMode === undefined
        ? {}
        : { permission_mode: options.permissionMode }),
    });
  }
  return fixture;
}

async function restartFixture(fixture: Fixture, args: readonly string[]): Promise<void> {
  await fixture.running.crash();
  fixture.running = await startServer(fixture.dataDir, {
    args,
    env: { HOME: fixture.home, OPENAI_API_KEY: 'sk-permissions-test' },
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

async function listApprovals(
  fixture: Fixture,
  query = 'status=all',
): Promise<ApprovalShape[]> {
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

async function waitForBatch(fixture: Fixture, replyId: string, batch: number): Promise<ApprovalShape> {
  return await waitFor(
    () => getApproval(fixture, replyId),
    (value) => value.batches.some((entry) => entry.batch === batch),
    `approval batch ${batch}`,
  );
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

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
  raw: string;
}

interface SseStream {
  next(predicate: (frame: SseFrame) => boolean, timeoutMs: number): Promise<SseFrame | null>;
  close(): void;
}

async function connectEvents(base: string): Promise<SseStream> {
  const controller = new AbortController();
  const response = await fetch(`${base}/api/events`, {
    headers: { accept: 'text/event-stream' },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  const body = response.body;
  assert.ok(body !== null);
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const frames: SseFrame[] = [];
  let buffer = '';
  let closed = false;
  const pump = (async (): Promise<void> => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          boundary = buffer.indexOf('\n\n');
          const event = /^event:\s*(.+)$/m.exec(block)?.[1];
          const data = /^data:\s*(.+)$/m.exec(block)?.[1];
          if (event !== undefined && data !== undefined) {
            frames.push({ event, data: JSON.parse(data) as Record<string, unknown>, raw: block });
          }
        }
      }
    } catch {
      // The test closes the connection; that abort is not a failure.
    } finally {
      closed = true;
    }
  })();
  return {
    async next(predicate, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const index = frames.findIndex(predicate);
        if (index !== -1) {
          return frames.splice(index, 1)[0] ?? null;
        }
        if (closed || Date.now() >= deadline) {
          return null;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }
    },
    close() {
      controller.abort();
      void pump;
    },
  };
}

test('PATCH accepts exactly three modes and refuses BYPASS / DONT_ASK / unknown; overrides resolve per target', async () => {
  const fixture = await startFixture('allibot-permissions-mode-');
  try {
    for (const mode of ['read-only', 'ask-writes', 'trusted-writes']) {
      const patched = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
        permission_mode: mode,
      });
      assert.equal(patched.status, 200, await patched.clone().text());
      assert.equal((await readJson(patched))['permission_mode'], mode);
      const channel = await fetch(`${fixture.base}/api/channels/${fixture.channelId}`);
      assert.equal((await readJson(channel))['permission_mode'], mode);
    }
    for (const invalid of ['BYPASS', 'DONT_ASK', 'bypass', 'readonly', '', null, 3]) {
      const patched = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
        permission_mode: invalid,
      });
      assert.equal(patched.status, 400, `invalid mode ${JSON.stringify(invalid)}`);
      const body = await readJson(patched);
      assert.equal((body['error'] as Record<string, unknown>)['code'], 'validation_failed');
    }
    const stored = await fetch(`${fixture.base}/api/channels/${fixture.channelId}`);
    assert.equal((await readJson(stored))['permission_mode'], 'trusted-writes');

    // Agent override, explicit null clears it, and the effective reading.
    const override = await patchJson(fixture, `/api/agents/${fixture.agentId}`, {
      permission_mode: 'read-only',
    });
    assert.equal(override.status, 200, await override.clone().text());
    const agentBody = await readJson(override);
    assert.equal(agentBody['permission_mode'], 'read-only');
    assert.equal(agentBody['effective_permission_mode'], 'read-only');
    for (const invalid of ['BYPASS', 'DONT_ASK', 'nope']) {
      const bad = await patchJson(fixture, `/api/agents/${fixture.agentId}`, {
        permission_mode: invalid,
      });
      assert.equal(bad.status, 400);
    }
    const cleared = await patchJson(fixture, `/api/agents/${fixture.agentId}`, {
      permission_mode: null,
    });
    assert.equal(cleared.status, 200, await cleared.clone().text());
    const clearedBody = await readJson(cleared);
    assert.equal(clearedBody['permission_mode'], null);
    assert.equal(clearedBody['effective_permission_mode'], 'ask-writes');

    // Target members: the owner follows the channel, the Agent its override.
    await patchJson(fixture, `/api/agents/${fixture.agentId}`, { permission_mode: 'read-only' });
    const members = await fetch(
      `${fixture.base}/api/targets/${fixture.channelId}/members`,
    );
    const rows = (await readJson(members))['members'] as Record<string, unknown>[];
    const ownerRow = rows.find((row) => row['kind'] === 'owner');
    const agentRow = rows.find((row) => row['kind'] === 'agent');
    assert.equal(ownerRow?.['permission_mode'], 'trusted-writes');
    assert.equal(agentRow?.['permission_mode'], 'read-only');

    // A task follows its channel (the Agent override only applies to agents).
    const task = await postJson(fixture, '/api/tasks', {
      channel_id: fixture.channelId,
      title: '权限任务',
    });
    assert.equal(task.status, 201, await task.clone().text());
    const taskTargetId = ((await readJson(task))['target_id'] as string) ?? '';
    const taskMembers = await fetch(`${fixture.base}/api/targets/${taskTargetId}/members`);
    const taskRows = (await readJson(taskMembers))['members'] as Record<string, unknown>[];
    assert.equal(
      taskRows.find((row) => row['kind'] === 'owner')?.['permission_mode'],
      'trusted-writes',
    );

    // A DM has no channel: the Agent override or the default applies.
    await patchJson(fixture, `/api/agents/${fixture.agentId}`, { permission_mode: null });
    const dm = await postJson(fixture, '/api/dms', { agent_id: fixture.agentId });
    assert.equal(dm.status, 201, await dm.clone().text());
    const dmTargetId = (await readJson(dm))['id'] as string;
    const dmMembers = await fetch(`${fixture.base}/api/targets/${dmTargetId}/members`);
    const dmRows = (await readJson(dmMembers))['members'] as Record<string, unknown>[];
    assert.equal(
      dmRows.find((row) => row['kind'] === 'agent')?.['permission_mode'],
      'ask-writes',
    );
    await patchJson(fixture, `/api/agents/${fixture.agentId}`, {
      permission_mode: 'trusted-writes',
    });
    const dmAgain = await fetch(`${fixture.base}/api/targets/${dmTargetId}/members`);
    const dmAgainRows = (await readJson(dmAgain))['members'] as Record<string, unknown>[];
    assert.equal(
      dmAgainRows.find((row) => row['kind'] === 'agent')?.['permission_mode'],
      'trusted-writes',
    );

    // Workspace: channel default + Agent raw override + effective default.
    const workspace = await fetch(`${fixture.base}/api/workspace`);
    const reading = await readJson(workspace);
    const channelReading = (reading['channels'] as Record<string, unknown>[])[0]!;
    assert.equal(channelReading['permission_mode'], 'trusted-writes');
    const agentReading = (reading['agents'] as Record<string, unknown>[])[0]!;
    assert.equal(agentReading['permission_mode'], 'trusted-writes');
    assert.equal(agentReading['effective_permission_mode'], 'trusted-writes');
    assert.equal(reading['pending_approvals'], 0);
  } finally {
    await fixture.stop();
  }
});

test('permission rules: full replacement, empty set, validation keeps the old set, idempotent, no message/wake/budget', async () => {
  const fixture = await startFixture('allibot-permissions-rules-', {
    configureWorkspace: false,
  });
  try {
    const initial = await fetch(
      `${fixture.base}/api/channels/${fixture.channelId}/permission-rules`,
    );
    assert.deepEqual(await readJson(initial), { rules: [] });

    const rules = [
      { tool_name: 'Write', pattern: 'src/**', behavior: 'ask' },
      { tool_name: 'Bash', pattern: '', behavior: 'deny' },
      { tool_name: 'mcp:demo/echo', pattern: '{"a":1}', behavior: 'allow' },
    ];
    const before = counts(fixture);
    const put = await putJson(
      fixture,
      `/api/channels/${fixture.channelId}/permission-rules`,
      rules,
    );
    assert.equal(put.status, 200, await put.clone().text());
    const stored = (await readJson(put))['rules'] as Record<string, unknown>[];
    assert.deepEqual(
      stored.map((row) => [row['tool_name'], row['pattern'], row['behavior']]),
      rules.map((row) => [row.tool_name, row.pattern, row.behavior]),
    );
    assert.equal(new Set(stored.map((row) => row['id'])).size, 3);
    assert.deepEqual(counts(fixture), before, 'rule writes write no message / wake / budget');

    // Same content, reordered: 200 and the ids / timestamps do not move.
    const replay = await putJson(
      fixture,
      `/api/channels/${fixture.channelId}/permission-rules`,
      [rules[2], rules[0], rules[1]],
    );
    assert.equal(replay.status, 200);
    assert.deepEqual((await readJson(replay))['rules'], stored);

    // An invalid row rejects the whole set and leaves the old one in place.
    for (const invalid of [
      [{ tool_name: 'Nope', pattern: '', behavior: 'allow' }],
      [{ tool_name: 'Write', pattern: '', behavior: 'allow', extra: 1 }],
      [{ tool_name: 'Write', pattern: 3, behavior: 'allow' }],
      [{ tool_name: 'Write', pattern: '', behavior: 'maybe' }],
      [
        { tool_name: 'Write', pattern: '', behavior: 'allow' },
        { tool_name: 'Write', pattern: '', behavior: 'deny' },
      ],
      [{ tool_name: 'mcp:bad', pattern: '', behavior: 'allow' }],
    ]) {
      const bad = await putJson(
        fixture,
        `/api/channels/${fixture.channelId}/permission-rules`,
        invalid,
      );
      assert.equal(bad.status, 400, `invalid set ${JSON.stringify(invalid)}`);
      assert.equal(
        ((await readJson(bad))['error'] as Record<string, unknown>)['code'],
        'validation_failed',
      );
    }
    const unchanged = await fetch(
      `${fixture.base}/api/channels/${fixture.channelId}/permission-rules`,
    );
    assert.deepEqual((await readJson(unchanged))['rules'], stored);

    // Empty array is valid.
    const empty = await putJson(
      fixture,
      `/api/channels/${fixture.channelId}/permission-rules`,
      [],
    );
    assert.equal(empty.status, 200);
    assert.deepEqual((await readJson(empty))['rules'], []);

    // Agent scope works and an unknown Agent is a 404.
    const agentPut = await putJson(
      fixture,
      `/api/agents/${fixture.agentId}/permission-rules`,
      [{ tool_name: 'Read', pattern: 'secret/**', behavior: 'deny' }],
    );
    assert.equal(agentPut.status, 200, await agentPut.clone().text());
    assert.equal(((await readJson(agentPut))['rules'] as unknown[]).length, 1);
    const missing = await putJson(
      fixture,
      '/api/agents/missing-agent/permission-rules',
      [],
    );
    assert.equal(missing.status, 404);

    // The sqlite rows agree with the read model.
    const rows = queryDatabase<Record<string, unknown>>(
      fixture.dataDir,
      'SELECT scope_kind, scope_id, tool_name, pattern, behavior FROM permission_rule ORDER BY rowid',
    );
    assert.deepEqual(rows, [
      {
        scope_kind: 'agent',
        scope_id: fixture.agentId,
        tool_name: 'Read',
        pattern: 'secret/**',
        behavior: 'deny',
      },
    ]);

    // Archived channel rules are a 400; a deleted channel is a 404.
    const archived = await postJson(
      fixture,
      `/api/channels/${fixture.channelId}/archive`,
      {},
    );
    assert.equal(archived.status, 200, await archived.clone().text());
    const archivedPut = await putJson(
      fixture,
      `/api/channels/${fixture.channelId}/permission-rules`,
      [],
    );
    assert.equal(archivedPut.status, 400);
    const archivedGet = await fetch(
      `${fixture.base}/api/channels/${fixture.channelId}/permission-rules`,
    );
    assert.equal(archivedGet.status, 200, 'an archived channel still reads');
  } finally {
    await fixture.stop();
  }
});

function counts(fixture: Fixture): Record<string, number> {
  const rows = queryDatabase<Record<string, number>>(
    fixture.dataDir,
    `SELECT (SELECT COUNT(*) FROM message) AS messages,
            (SELECT COUNT(*) FROM round_outcome) AS outcomes,
            (SELECT COUNT(*) FROM target_budget) AS budgets`,
  );
  return rows[0]!;
}

test('ask-writes pauses on a write, confirms it, reopens for the next batch and keeps the decision history', async () => {
  const fixture = await startFixture('allibot-approval-batches-');
  try {
    const events = await connectEvents(fixture.base);
    const pendingReply = sendMessage(fixture, fixture.channelId, '请写两个文件');
    const first = await waitForPending(fixture);
    assert.equal(first.context_kind, 'round');
    assert.equal(first.context_id, null);
    assert.equal(first.target_id, fixture.channelId);
    assert.equal(first.status, 'pending');
    assert.equal(first.tool_calls.length, 1);
    assert.equal(first.tool_calls[0]!.tool_name, 'Write');
    assert.equal(first.tool_calls[0]!.arguments['path'], 'approval-one.txt');
    const replyId = first.reply_id;
    assert.ok(replyId.length > 0);
    const pendingWorkspace = await fetch(`${fixture.base}/api/workspace`);
    assert.equal((await readJson(pendingWorkspace))['pending_approvals'], 1);
    // Two reads of the same approval are identical (all GETs are idempotent).
    const firstRead = await getApproval(fixture, replyId);
    const secondRead = await getApproval(fixture, replyId);
    assert.deepEqual(secondRead, firstRead);

    const requested = await events.next((frame) => frame.event === 'approval.requested', 3_000);
    assert.ok(requested !== null, 'the stream carries approval.requested');
    assert.deepEqual(
      Object.keys(requested.data).sort(),
      ['context_id', 'context_kind', 'reply_id', 'status', 'target_id', 'tool_call_ids'],
    );
    assert.equal(requested.data['reply_id'], replyId);
    assert.equal(requested.data['context_kind'], 'round');
    assert.equal(requested.data['status'], 'pending');
    assert.deepEqual(requested.data['tool_call_ids'], [first.tool_calls[0]!.tool_call_id]);
    assert.equal(requested.raw.includes('approval-one.txt'), false, 'no tool arguments in the frame');

    const callOne = first.tool_calls[0]!.tool_call_id;
    const approveOne = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: callOne,
      confirmed: true,
    });
    assert.equal(approveOne.status, 200, await approveOne.clone().text());
    const resolvedFirst = await events.next(
      (frame) => frame.event === 'approval.resolved',
      3_000,
    );
    assert.ok(resolvedFirst !== null, 'the first batch resolves');
    assert.equal(resolvedFirst.data['status'], 'confirmed');

    // The second write starts the next batch: the row reopens pending, merges
    // the call, keeps the first decision, and only the new call is published.
    const reopened = await waitForBatch(fixture, replyId, 2);
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.resolved_at, null);
    assert.equal(reopened.tool_calls.length, 2);
    assert.equal(reopened.decisions.length, 1);
    assert.equal(reopened.batches.length, 2);
    assert.ok(reopened.requested_at >= first.requested_at);
    const secondCall = reopened.tool_calls.find(
      (call) => call.tool_call_id !== callOne,
    )!;
    assert.equal(secondCall.arguments['path'], 'approval-two.txt');

    const requestedSecond = await events.next(
      (frame) => frame.event === 'approval.requested',
      3_000,
    );
    assert.ok(requestedSecond !== null);
    assert.deepEqual(requestedSecond.data['tool_call_ids'], [secondCall.tool_call_id]);

    const approveTwo = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: secondCall.tool_call_id,
      confirmed: true,
      rules: [{ tool_name: 'Write', pattern: 'approval-two.txt', behavior: 'allow' }],
    });
    assert.equal(approveTwo.status, 200, await approveTwo.clone().text());
    const finalRow = await getApproval(fixture, replyId);
    assert.equal(finalRow.status, 'confirmed');
    assert.equal(finalRow.decisions.length, 2);
    assert.ok(finalRow.resolved_at !== null);

    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());
    const body = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(body, /\[approval-one\] ok path:approval-one\.txt/);
    assert.match(body, /\[approval-two\] ok path:approval-two\.txt/);
    assert.match(body, /\[approval-read\] ok path:notes\.txt/);
    assert.match(body, /\[permission\] mode:ask-writes shell:0/);
    assert.match(body, /\[permission-check\] Read:notes\.txt=allow/);
    assert.match(body, /\[permission-check\] Write:notes\.txt=ask:mode-ask/);
    assert.match(body, /\[permission-check\] Bash:rm -rf \/=deny:shell-disabled/);
    assert.match(body, /\[permission-check\] mcp:demo\/echo.*=ask:mode-ask/);
    assert.equal(readFileSync(path.join(fixture.root, 'approval-one.txt'), 'utf8'), 'one');
    assert.equal(readFileSync(path.join(fixture.root, 'approval-two.txt'), 'utf8'), 'two');
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');
    // The stable reply identity is the landed message id (D5.6).
    const replyMessage = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1);
    assert.equal(replyMessage?.['id'], replyId);

    // The decision rules were written atomically; the channel set is visible.
    const ruleResponse = await fetch(
      `${fixture.base}/api/channels/${fixture.channelId}/permission-rules`,
    );
    const ruleBody = await readJson(ruleResponse);
    assert.deepEqual(
      (ruleBody['rules'] as Record<string, unknown>[]).map((row) => [
        row['tool_name'],
        row['pattern'],
        row['behavior'],
      ]),
      [['Write', 'approval-two.txt', 'allow']],
    );

    // Replay semantics: same decision 200, opposite 409, unknown call 400.
    const replay = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: callOne,
      confirmed: true,
    });
    assert.equal(replay.status, 200);
    const opposite = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: callOne,
      confirmed: false,
    });
    assert.equal(opposite.status, 409);
    const unknown = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: 'not-a-call',
      confirmed: true,
    });
    assert.equal(unknown.status, 400);

    // The list default reads pending (none now); status=all reads the row.
    assert.deepEqual(await listApprovals(fixture, 'status=pending'), []);
    const all = await listApprovals(fixture, 'status=all');
    assert.equal(all.length, 1);
    assert.equal(all[0]!.reply_id, replyId);
    const filtered = await listApprovals(
      fixture,
      `status=all&target_id=${fixture.channelId}`,
    );
    assert.equal(filtered.length, 1);
    const other = await listApprovals(fixture, 'status=all&target_id=missing-target');
    assert.deepEqual(other, []);
    const unknownReply = await fetch(`${fixture.base}/api/approvals/not-a-reply`);
    assert.equal(unknownReply.status, 404);
    const badQuery = await fetch(`${fixture.base}/api/approvals?status=nope`);
    assert.equal(badQuery.status, 400);
    const badLimit = await fetch(`${fixture.base}/api/approvals?limit=0`);
    assert.equal(badLimit.status, 400);
    const workspace = await fetch(`${fixture.base}/api/workspace`);
    assert.equal((await readJson(workspace))['pending_approvals'], 0);
    events.close();
  } finally {
    await fixture.stop();
  }
});

test('a denied ask returns DENIED, the round continues and a historical denial keeps the final status denied', async () => {
  const fixture = await startFixture('allibot-approval-denied-');
  try {
    const events = await connectEvents(fixture.base);
    const pendingReply = sendMessage(fixture, fixture.channelId, '请写两个文件');
    const first = await waitForPending(fixture);
    const replyId = first.reply_id;
    const callOne = first.tool_calls[0]!.tool_call_id;
    const denied = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: callOne,
      confirmed: false,
    });
    assert.equal(denied.status, 200, await denied.clone().text());
    const resolved = await events.next((frame) => frame.event === 'approval.resolved', 3_000);
    assert.ok(resolved !== null);
    assert.equal(resolved.data['status'], 'denied');

    const reopened = await waitForBatch(fixture, replyId, 2);
    assert.equal(reopened.status, 'pending');
    assert.equal(reopened.decisions.length, 1);
    assert.equal(reopened.decisions[0]!.confirmed, false);
    const secondCall = reopened.tool_calls.find((call) => call.tool_call_id !== callOne)!;
    const approveTwo = await postJson(fixture, `/api/approvals/${replyId}`, {
      tool_call_id: secondCall.tool_call_id,
      confirmed: true,
    });
    assert.equal(approveTwo.status, 200, await approveTwo.clone().text());

    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());
    const finalRow = await getApproval(fixture, replyId);
    assert.equal(finalRow.status, 'denied', 'any historical denial keeps the row denied');
    assert.equal(finalRow.decisions.length, 2);
    const body = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(body, /\[approval-one\] error:denied/);
    assert.match(body, /\[approval-two\] ok path:approval-two\.txt/);
    assert.equal(existsSync(path.join(fixture.root, 'approval-one.txt')), false);
    assert.equal(readFileSync(path.join(fixture.root, 'approval-two.txt'), 'utf8'), 'two');
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');
    events.close();
  } finally {
    await fixture.stop();
  }
});

test('read-only denies writes and execution hard, even with an allow rule; trusted-writes auto-allows root writes', async () => {
  const fixture = await startFixture('allibot-approval-readonly-', {
    permissionMode: 'read-only',
  });
  try {
    const rules = await putJson(
      fixture,
      `/api/channels/${fixture.channelId}/permission-rules`,
      [
        { tool_name: 'Write', pattern: '**', behavior: 'allow' },
        { tool_name: 'Bash', pattern: '**', behavior: 'allow' },
      ],
    );
    assert.equal(rules.status, 200, await rules.clone().text());
    const sent = await sendMessage(fixture, fixture.channelId, '只读轮次');
    assert.equal(sent.status, 201, await sent.clone().text());
    const body = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(body, /\[permission\] mode:read-only shell:0/);
    assert.match(body, /\[permission-check\] Read:notes\.txt=allow/);
    assert.match(body, /\[permission-check\] Write:notes\.txt=deny:read-only/);
    assert.match(body, /\[permission-check\] Write:sub\/deep\.txt=deny:read-only/);
    assert.match(body, /\[permission-check\] Bash:rm -rf \/=deny:shell-disabled/);
    assert.match(body, /\[permission-check\] mcp:demo\/echo.*=deny:read-only/);
    assert.match(body, /\[approval-one\] error:denied/);
    assert.match(body, /\[approval-two\] error:denied/);
    assert.equal(existsSync(path.join(fixture.root, 'approval-one.txt')), false);
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');
    assert.deepEqual(await listApprovals(fixture), [], 'a hard boundary never asks');

    // trusted-writes: root-internal writes are automatic, reads allow; execute
    // (MCP) still asks by default, and the shell hook keeps its hard denial.
    const switched = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      permission_mode: 'trusted-writes',
    });
    assert.equal(switched.status, 200, await switched.clone().text());
    // Clear the allow rules so this round observes the mode default itself.
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, []);
    const trusted = await sendMessage(fixture, fixture.channelId, '信任写入轮次');
    assert.equal(trusted.status, 201, await trusted.clone().text());
    const trustedBody = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(trustedBody, /\[permission\] mode:trusted-writes/);
    assert.match(trustedBody, /\[permission-check\] Write:notes\.txt=allow:trusted-root-write/);
    assert.match(trustedBody, /\[permission-check\] mcp:demo\/echo.*=ask:mode-ask/);
    assert.match(trustedBody, /\[approval-one\] ok path:approval-one\.txt/);
    assert.match(trustedBody, /\[approval-two\] ok path:approval-two\.txt/);
    assert.equal(readFileSync(path.join(fixture.root, 'approval-one.txt'), 'utf8'), 'one');
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');
  } finally {
    await fixture.stop();
  }
});


test('a symlink-escaped write is previewed as a non-allow and never executes outside the root', async () => {
  const fixture = await startFixture('allibot-approval-symlink-', {
    permissionMode: 'trusted-writes',
  });
  try {
    const outside = path.join(fixture.tmp, 'outside');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, path.join(fixture.root, 'escape'));

    const sent = await sendMessage(fixture, fixture.channelId, '符号链接逃逸');
    assert.equal(sent.status, 201, await sent.clone().text());
    const body = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;

    assert.match(body, /\[permission-check\] Write:escape\/evil\.txt=deny:rule-deny/);
    assert.match(body, /\[workspace-symlink-write\] error:outside-root/);
    assert.equal(existsSync(path.join(outside, 'evil.txt')), false);
    assert.deepEqual(await listApprovals(fixture), [], 'a hard root escape never asks');
  } finally {
    await fixture.stop();
  }
});

test('rule merge and pattern glob semantics: agent overrides the same key, deny wins, path and command and MCP subjects', async () => {
  const fixture = await startFixture('allibot-approval-rules-', {
    permissionMode: 'trusted-writes',
  });
  try {
    // The shell switch is on for the first round: the `Bash` pattern semantics
    // and the hard approval are observable. It is a config switch only; no
    // shell executes (#46).
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      allow_local_shell: 1,
    });
    // Same-key Agent replacement: the channel denies this exact file, the
    // Agent allows the same key, so the effective row is `allow`.
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'approval-one.txt', behavior: 'deny' },
      { tool_name: 'Write', pattern: 'approval-two.txt', behavior: 'allow' },
      { tool_name: 'Bash', pattern: '*rf*', behavior: 'deny' },
      { tool_name: 'Bash', pattern: 'ls*', behavior: 'allow' },
      { tool_name: 'mcp:demo/echo', pattern: '*"a":1*', behavior: 'allow' },
      { tool_name: 'mcp:demo/echo', pattern: '*"z":"last",*', behavior: 'deny' },
      { tool_name: 'Read', pattern: 'NOTES.TXT', behavior: 'deny' },
      { tool_name: 'Read', pattern: 'notes', behavior: 'deny' },
    ]);
    await putJson(fixture, `/api/agents/${fixture.agentId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'approval-one.txt', behavior: 'allow' },
    ]);
    const pendingReply = sendMessage(fixture, fixture.channelId, '规则合并');
    // The shell's hard approval arrives after the two writes; the `ls*` allow
    // rule cannot make it automatic.
    const shellPending = await waitForPending(fixture);
    assert.equal(shellPending.tool_calls[0]!.tool_name, 'Bash');
    const approveShell = await postJson(fixture, `/api/approvals/${shellPending.reply_id}`, {
      tool_call_id: shellPending.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(approveShell.status, 200, await approveShell.clone().text());
    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());
    const body = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    // Agent same-key allow replaces the channel deny for approval-one.
    assert.match(body, /\[approval-one\] ok path:approval-one\.txt/);
    // approval-two keeps the channel allow.
    assert.match(body, /\[approval-two\] ok path:approval-two\.txt/);
    // `Bash` matches the command string and `*` crosses `/`.
    assert.match(body, /\[permission\] mode:trusted-writes shell:1/);
    assert.match(body, /\[permission-check\] Bash:rm -rf \/=deny:rule-deny/);
    assert.match(body, /\[permission-check\] Bash:ls -la=ask:shell-approval/);
    assert.match(body, /\[shell-approval\] allow/);
    // MCP matches the stable argument JSON: sorted keys, allow wins because the
    // unsorted deny pattern does not occur in the stable subject.
    assert.match(body, /\[permission-check\] mcp:demo\/echo:{"a":1,"z":"last"}=allow/);
    // A file path glob is case-sensitive and has no implicit prefix: `NOTES.TXT`
    // and `notes` do not match `notes.txt`.
    assert.match(body, /\[permission-check\] Read:notes\.txt=allow/);
    assert.equal(latestOutcome(fixture, fixture.channelId)?.['status'], 'replied');
    // The shell switch goes back off for the pattern rounds: no shell approval
    // can block them.
    await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      allow_local_shell: 0,
    });

    // `*` never crosses `/` for a file tool; `**` does. Run twice with a
    // replaced set to see both.
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'approval-one.txt', behavior: 'allow' },
      { tool_name: 'Write', pattern: 'approval-two.txt', behavior: 'allow' },
      { tool_name: 'Write', pattern: '*', behavior: 'deny' },
    ]);
    await sendMessage(fixture, fixture.channelId, '星号不跨目录');
    let latest = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(latest, /\[permission-check\] Write:notes\.txt=deny:rule-deny/);
    assert.match(latest, /\[permission-check\] Write:sub\/deep\.txt=allow:trusted-root-write/);

    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'approval-one.txt', behavior: 'allow' },
      { tool_name: 'Write', pattern: 'approval-two.txt', behavior: 'allow' },
      { tool_name: 'Write', pattern: '**', behavior: 'deny' },
    ]);
    await sendMessage(fixture, fixture.channelId, '双星跨目录');
    latest = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(latest, /\[permission-check\] Write:notes\.txt=deny:rule-deny/);
    assert.match(latest, /\[permission-check\] Write:sub\/deep\.txt=deny:rule-deny/);
    assert.match(latest, /\[approval-one\] error:denied/, 'a deny rule blocks the write');

    // An empty pattern matches every call of that tool.
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Read', pattern: '', behavior: 'deny' },
      { tool_name: 'Write', pattern: 'approval-one.txt', behavior: 'allow' },
      { tool_name: 'Write', pattern: 'approval-two.txt', behavior: 'allow' },
    ]);
    await sendMessage(fixture, fixture.channelId, '空 pattern');
    latest = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(latest, /\[permission-check\] Read:notes\.txt=deny:rule-deny/);
    assert.match(latest, /\[approval-read\] error:denied/);
  } finally {
    await fixture.stop();
  }
});

test('MCP approval masks secret-shaped arguments before SQLite and SSE', async () => {
  const fixture = await startFixture('allibot-approval-mcp-', {
    behavior: 'mcp-approval',
  });
  try {
    const events = await connectEvents(fixture.base);
    const pendingReply = sendMessage(fixture, fixture.channelId, 'MCP 审批');
    pendingReply.catch(() => undefined);
    let pending: ApprovalShape;
    try {
      pending = await waitForPending(fixture);
    } catch (error) {
      console.error('MCP SERVER LOGS', fixture.running.logs());
      throw error;
    }
    assert.equal(pending.context_kind, 'round');
    assert.equal(pending.tool_calls[0]!.tool_name, 'mcp:demo/echo');
    const args = pending.tool_calls[0]!.arguments;
    assert.equal(args['api_key'], '***');
    assert.deepEqual(args['nested'], { token: '***' });
    assert.equal(args['plain'], 'readable');

    const rawDb = queryDatabase<Record<string, unknown>>(
      fixture.dataDir,
      'SELECT tool_calls FROM approval_request WHERE reply_id = ?',
      [pending.reply_id],
    )[0]!['tool_calls'] as string;
    assert.equal(rawDb.includes('SECRET'), false, 'the raw secret never reaches SQLite');
    const frame = await events.next((entry) => entry.event === 'approval.requested', 3_000);
    assert.ok(frame !== null);
    assert.equal(frame.raw.includes('SECRET'), false, 'the frame carries no arguments');
    const list = await fetch(`${fixture.base}/api/approvals?status=all`);
    assert.equal((await list.clone().text()).includes('SECRET'), false);

    const approve = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(approve.status, 200, await approve.clone().text());
    assert.equal((await approve.clone().text()).includes('SECRET'), false);
    const sent = await pendingReply;
    assert.equal(sent.status, 201);
    const body = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(body, /\[mcp-approval\] mcp:demo\/echo:allow/);
    assert.match(body, /\[mcp-approval-repeat\] mcp:demo\/echo:allow/);
    // The duplicate registration is idempotent: one call, one batch, one
    // decision — no reopen.
    const final = await getApproval(fixture, pending.reply_id);
    assert.equal(final.tool_calls.length, 1);
    assert.equal(final.batches.length, 1);
    assert.equal(final.decisions.length, 1);
    assert.equal(final.status, 'confirmed');
    events.close();
  } finally {
    await fixture.stop();
  }
});

test('a batch that waits past the timeout closes failed and the round fails with a readable reason', async () => {
  const fixture = await startFixture('allibot-approval-timeout-', {
    args: [
      '--approval-timeout-ms',
      '200',
      '--fixed-clock',
      '2026-11-04T00:00:00.000Z',
    ],
  });
  try {
    const sent = await sendMessage(fixture, fixture.channelId, '超时审批');
    assert.equal(sent.status, 201, await sent.clone().text());
    const rows = await waitFor(
      () => listApprovals(fixture, 'status=all'),
      (value) => value.length > 0 && value[0]!.status === 'failed',
      'the timed-out approval',
    );
    assert.equal(rows[0]!.status, 'failed');
    assert.ok(rows[0]!.resolved_at !== null);
    // The process clock is the injected fixed instant; the wait itself is the
    // configured batch timeout (production: 600s).
    assert.equal(rows[0]!.requested_at, '2026-11-04T00:00:00.000Z');
    assert.equal(rows[0]!.resolved_at, '2026-11-04T00:00:00.000Z');
    assert.equal(rows[0]!.decisions.length, 0);
    const outcome = latestOutcome(fixture, fixture.channelId);
    assert.equal(outcome?.['status'], 'failed');
    assert.match(String(outcome?.['reason']), /审批等待超时/);
    // A late decision on a terminal record is a 409, never a revival.
    const late = await postJson(fixture, `/api/approvals/${rows[0]!.reply_id}`, {
      tool_call_id: rows[0]!.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(late.status, 409);
    assert.equal((await getApproval(fixture, rows[0]!.reply_id)).status, 'failed');
  } finally {
    await fixture.stop();
  }
});

test('a pending approval becomes expired on restart and is never replayed', async () => {
  const fixture = await startFixture('allibot-approval-restart-');
  try {
    const pendingReply = sendMessage(fixture, fixture.channelId, '重启前审批');
    const pending = await waitForPending(fixture);
    // Crash with the round still waiting: the request never resolves.
    void pendingReply.catch(() => undefined);
    await restartFixture(fixture, ['--scripted-provider', 'permission']);
    const rows = await waitFor(
      () => listApprovals(fixture, 'status=all'),
      (value) => value.length > 0 && value[0]!.status === 'expired',
      'the expired approval',
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
  } finally {
    await fixture.stop();
  }
});

test('a TeamAssign sub-round approval carries team-assignment context and the assignment id', async () => {
  const fixture = await startFixture('allibot-approval-team-', {
    behavior: 'team-approval',
    configureWorkspace: false,
  });
  try {
    const memberId = await createAgent(fixture, '分派成员');
    await joinChannel(fixture, fixture.channelId, memberId);
    // TeamAssign member availability needs the provider credential (fixture
    // env) and the remote-data-flow consent.
    await postJson(fixture, '/api/remote-data-flow/openai/consent', {});
    const team = await patchJson(fixture, `/api/channels/${fixture.channelId}`, {
      mode: 'team',
      team_leader_member_id: fixture.agentId,
      workspace_root: fixture.root,
      permission_mode: 'ask-writes',
    });
    assert.equal(team.status, 200, await team.clone().text());
    // The fixture's server was started without the member id; restart it with
    // the injection so the leader double assigns exactly this member.
    await restartFixture(fixture, [
      '--scripted-provider',
      'team-approval',
      '--scripted-team-assign-member',
      memberId,
    ]);
    const events = await connectEvents(fixture.base);
    const pendingReply = sendMessage(fixture, fixture.channelId, '分派任务');
    pendingReply.catch(() => undefined);
    const pending = await waitForPending(fixture);
    assert.equal(pending.context_kind, 'team-assignment');
    assert.equal(pending.target_id, fixture.channelId);
    assert.ok(pending.context_id !== null);
    assert.equal(pending.tool_calls[0]!.tool_name, 'Write');
    const assignment = queryDatabase<Record<string, unknown>>(
      fixture.dataDir,
      'SELECT id, state, target_id FROM team_assignment WHERE id = ?',
      [pending.context_id],
    )[0]!;
    assert.deepEqual(assignment, {
      id: pending.context_id,
      state: 'running',
      target_id: fixture.channelId,
    });
    const approve = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
    });
    assert.equal(approve.status, 200, await approve.clone().text());
    const sent = await pendingReply;
    assert.equal(sent.status, 201, await sent.clone().text());
    const sentBody = (await messages(fixture, fixture.channelId))
      .filter((row) => row['kind'] === 'agent')
      .at(-1)?.['body'] as string;
    assert.match(sentBody, /\[team-assign\]/);
    const finalAssignment = queryDatabase<Record<string, unknown>>(
      fixture.dataDir,
      'SELECT state, reply_excerpt FROM team_assignment WHERE id = ?',
      [pending.context_id],
    )[0]!;
    assert.equal(finalAssignment['state'], 'completed');
    assert.match(String(finalAssignment['reply_excerpt']), /team-approval-write\] ok path:team-approval\.txt/);
    assert.equal(readFileSync(path.join(fixture.root, 'team-approval.txt'), 'utf8'), 'member-wrote');
    events.close();
  } finally {
    await fixture.stop();
  }
});

test('decision rules are atomic: an invalid rule rejects the decision and leaves both the row and the old set unchanged', async () => {
  const fixture = await startFixture('allibot-approval-rules-atomic-');
  try {
    const pendingReply = sendMessage(fixture, fixture.channelId, '规则原子性');
    const pending = await waitForPending(fixture);
    await putJson(fixture, `/api/channels/${fixture.channelId}/permission-rules`, [
      { tool_name: 'Write', pattern: 'kept.txt', behavior: 'deny' },
    ]);
    const invalid = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
      rules: [{ tool_name: 'Nope', pattern: '', behavior: 'allow' }],
    });
    assert.equal(invalid.status, 400);
    const stillPending = await getApproval(fixture, pending.reply_id);
    assert.equal(stillPending.status, 'pending');
    assert.equal(stillPending.decisions.length, 0);
    const kept = await fetch(`${fixture.base}/api/channels/${fixture.channelId}/permission-rules`);
    assert.equal(((await readJson(kept))['rules'] as unknown[]).length, 1);

    // A valid set lands with the decision and is immediately visible.
    const valid = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
      tool_call_id: pending.tool_calls[0]!.tool_call_id,
      confirmed: true,
      rules: [
        { tool_name: 'Write', pattern: 'approval-one.txt', behavior: 'allow' },
        { tool_name: 'Write', pattern: 'approval-two.txt', behavior: 'allow' },
      ],
    });
    assert.equal(valid.status, 200, await valid.clone().text());
    const rules = await fetch(`${fixture.base}/api/channels/${fixture.channelId}/permission-rules`);
    assert.deepEqual(
      ((await readJson(rules))['rules'] as Record<string, unknown>[]).map((row) => [
        row['tool_name'],
        row['pattern'],
        row['behavior'],
      ]),
      [
        ['Write', 'approval-one.txt', 'allow'],
        ['Write', 'approval-two.txt', 'allow'],
      ],
    );
    assert.equal((await pendingReply).status, 201);
  } finally {
    await fixture.stop();
  }
});
