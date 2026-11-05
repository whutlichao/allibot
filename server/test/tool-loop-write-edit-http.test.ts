import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { ZH_CN } from '@allibot/shared';
import {
  removeTempDir,
  runCli,
  startRecordingEndpoint,
  startServer,
  type RecordedReply,
  type RecordingEndpoint,
  type RunningServer,
} from './support.ts';
import { PROVIDER_ROWS, type ProviderRow } from './provider-rows.ts';

/**
 * 写类工具进循环 (#74 / D2 / D3 / D4 / D5 / D6 / D10): `Write` and `Edit` are
 * offered to the real model adapter, execute against the round's project file
 * face, and carry the approval gate inside the loop.
 *
 * The one seam is still the backend HTTP face: a real process, a temporary data
 * directory, and `startRecordingEndpoint` answering in each provider's own wire
 * shape. The matrix is parameterised by provider, and both rows run every case:
 * one internal spec, two serializations, one set of assertions.
 *
 * The approval cases are the point of this ticket, so they assert the human
 * face itself — the pending batch, the decision, the reopened batch — and the
 * tool result the model receives in each case. A timed-out batch is the one
 * case that must *not* look like a tool result: it closes the round failed.
 */

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  endpoint: RecordingEndpoint;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

/** The permission mode every approval case runs under, written down explicitly. */
type PermissionMode = 'read-only' | 'ask-writes' | 'trusted-writes';

async function startFixture(
  prefix: string,
  provider: ProviderRow,
  options: { args?: readonly string[]; env?: NodeJS.ProcessEnv } = {},
): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const endpoint = await startRecordingEndpoint();
  const running = await startServer(dataDir, {
    args: ['--provider', 'model', ...(options.args ?? [])],
    env: { HOME: home, ...provider.env(endpoint.baseUrl), ...options.env },
  });
  return {
    tmp,
    dataDir,
    home,
    endpoint,
    running,
    base: `http://127.0.0.1:${running.port}`,
    stop: async () => {
      await running.stop();
      await endpoint.stop();
      await removeTempDir(tmp);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

interface HasBase {
  base: string;
}

async function postJson(server: HasBase, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function patchJson(server: HasBase, route: string, body: unknown): Promise<Response> {
  return await fetch(`${server.base}${route}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function confirmRemoteDataFlow(server: HasBase, provider: ProviderRow): Promise<void> {
  const confirmed = await postJson(server, `/api/remote-data-flow/${provider.provider}/consent`, {});
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
}

/**
 * Arrange the recording endpoint's answers in order: one answer per request the
 * round makes, and the last answer repeats if the round asks again, so an extra
 * round trip shows up as an assertion on the recorded request count.
 */
function queueReplies(endpoint: RecordingEndpoint, replies: readonly RecordedReply[]): void {
  let served = 0;
  endpoint.respondWith(() => {
    const reply = replies[Math.min(served, replies.length - 1)];
    served += 1;
    assert.ok(reply !== undefined, 'the fixture supplies at least one reply');
    return reply;
  });
}

interface RoundTarget {
  agentId: string;
  channelId: string;
  /** The project root this round writes into; `null` leaves the channel rootless. */
  project: string | null;
}

async function openRound(
  fixture: Fixture,
  provider: ProviderRow,
  options: { prefix: string; withRoot: boolean; permissionMode?: PermissionMode },
): Promise<RoundTarget> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: '写文件的成员',
    model: provider.model,
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agentId = (await readJson(created))['id'] as string;

  await confirmRemoteDataFlow(fixture, provider);

  const channel = await postJson(fixture, '/api/channels', {
    name: '写类工具频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(channel.status, 201, await channel.clone().text());
  const channelId = (await readJson(channel))['id'] as string;

  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: agentId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());

  if (!options.withRoot) {
    return { agentId, channelId, project: null };
  }
  const project = path.join(fixture.tmp, options.prefix);
  mkdirSync(project, { recursive: true });
  const patched = await patchJson(fixture, `/api/channels/${channelId}`, {
    workspace_root: project,
    ...(options.permissionMode === undefined
      ? {}
      : { permission_mode: options.permissionMode }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());
  if (options.permissionMode !== undefined) {
    assert.equal(
      (await readJson(patched))['permission_mode'],
      options.permissionMode,
      'the channel keeps the mode this case runs under',
    );
  }
  return { agentId, channelId, project };
}

function requestPayload(request: { body: string }): Record<string, unknown> {
  const payload: unknown = JSON.parse(request.body);
  assert.ok(typeof payload === 'object' && payload !== null, 'the request body is a JSON object');
  return payload as Record<string, unknown>;
}

async function sendMessage(server: HasBase, targetId: string, body: string): Promise<Response> {
  return await postJson(server, `/api/targets/${targetId}/messages`, { body });
}

async function messages(server: HasBase, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${server.base}/api/targets/${targetId}/messages?limit=50`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

interface OutcomeRow {
  status: string;
  reason: string;
  finished_reason: string | null;
}

function roundOutcome(fixture: Fixture): OutcomeRow {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const rows = db
      .prepare('SELECT status, reason, finished_reason FROM round_outcome ORDER BY rowid')
      .all() as OutcomeRow[];
    assert.equal(rows.length, 1, 'one wake runs exactly one round');
    return rows[0]!;
  } finally {
    db.close();
  }
}

interface ApprovalShape {
  reply_id: string;
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

/** The approval batch the round is blocked on, read from the human face. */
async function waitForPending(fixture: Fixture): Promise<ApprovalShape> {
  const rows = await waitFor(
    () => listApprovals(fixture, 'status=pending'),
    (value) => value.length > 0,
    'a pending approval',
  );
  return rows[0]!;
}

/** Wait for the same approval row to reopen as the given pending batch. */
async function waitForBatch(
  fixture: Fixture,
  replyId: string,
  batch: number,
): Promise<ApprovalShape> {
  return await waitFor(
    () => getApproval(fixture, replyId),
    (value) => value.status === 'pending' && value.batches.some((entry) => entry.batch === batch),
    `batch ${batch}`,
  );
}

interface SseFrame {
  event: string;
  data: Record<string, unknown>;
  raw: string;
}

interface SseStream {
  next(
    predicate: (frame: SseFrame) => boolean,
    timeoutMs: number,
  ): Promise<SseFrame | null>;
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

for (const provider of PROVIDER_ROWS) {
  test(`[${provider.label}] a round writes and edits one file and lands the final text only`, async () => {
    const fixture = await startFixture(`allibot-write-edit-basic-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'trusted-writes',
      });
      assert.ok(round.project !== null);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-write', name: 'Write', input: { path: 'out.txt', content: 'ALPHA\n' } },
          {
            id: 'call-edit',
            name: 'Edit',
            input: { path: 'out.txt', old_string: 'ALPHA', new_string: 'BETA' },
          },
        ]),
        provider.text('写好了 out.txt'),
      ]);

      await sendMessage(fixture, round.channelId, '@写文件的成员 写一个 out.txt');

      assert.equal(fixture.endpoint.requests.length, 2, 'one tool batch adds one round trip');
      const definitions = provider.toolDefinitions(requestPayload(fixture.endpoint.requests[0]!));
      assert.deepEqual(
        definitions.map((definition) => definition.name),
        ['Read', 'Glob', 'Grep', 'Write', 'Edit'],
        'a rooted channel round is handed the whole file batch, write tools included',
      );
      const write = definitions.find((definition) => definition.name === 'Write');
      assert.ok(write !== undefined, 'the round is handed the Write tool');
      assert.ok(write.description.length > 0, 'the tool definition explains what Write does');
      assert.deepEqual(
        write.schema['required'],
        ['path', 'content'],
        'Write requires exactly the face request fields',
      );
      assert.deepEqual(
        Object.keys(write.schema['properties'] as Record<string, unknown>).sort(),
        ['content', 'path'],
        'Write declares no argument the face does not take',
      );
      const edit = definitions.find((definition) => definition.name === 'Edit');
      assert.ok(edit !== undefined, 'the round is handed the Edit tool');
      assert.ok(edit.description.length > 0, 'the tool definition explains what Edit does');
      assert.deepEqual(
        edit.schema['required'],
        ['path', 'old_string', 'new_string'],
        'Edit requires exactly the face request fields',
      );

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-write', false],
          ['call-edit', false],
        ],
        'both write calls run and answer in call order',
      );
      assert.ok(
        (results[0]?.content ?? '').includes('[Write] ok'),
        `the write result states its state: ${results[0]?.content ?? ''}`,
      );
      assert.ok(
        (results[0]?.content ?? '').includes('path: out.txt'),
        'the write result names the root-relative path it wrote',
      );
      assert.ok(
        (results[0]?.content ?? '').includes('bytes: 6'),
        `the write result states how much it wrote: ${results[0]?.content ?? ''}`,
      );
      assert.ok(
        (results[1]?.content ?? '').includes('[Edit] ok'),
        `the edit result states its state: ${results[1]?.content ?? ''}`,
      );
      assert.ok(
        (results[1]?.content ?? '').includes('replacements: 1'),
        `the edit result states how many replacements it made: ${results[1]?.content ?? ''}`,
      );

      assert.equal(
        readFileSync(path.join(round.project, 'out.txt'), 'utf8'),
        'BETA\n',
        'both calls reached the project root, in call order',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [
          message['kind'],
          message['body'],
        ]),
        [
          ['human', '@写文件的成员 写一个 out.txt'],
          ['agent', '写好了 out.txt'],
        ],
        'only the final text lands',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] ask-writes: an approved Write waits in one batch, runs, and the round answers`, async () => {
    const fixture = await startFixture(`allibot-write-edit-approve-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'ask-writes',
      });
      assert.ok(round.project !== null);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-write', name: 'Write', input: { path: 'approved.txt', content: 'OK' } },
        ]),
        provider.text('批准后写好了'),
      ]);

      // The round blocks on the approval, so the POST settles only after the
      // human decision.
      const sent = sendMessage(fixture, round.channelId, '@写文件的成员 写 approved.txt');
      const pending = await waitForPending(fixture);
      assert.equal(pending.tool_calls.length, 1, 'one write call is one projected call');
      assert.equal(pending.tool_calls[0]?.tool_name, 'Write');
      assert.equal(pending.tool_calls[0]?.pattern, 'approved.txt');
      assert.equal(pending.tool_calls[0]?.arguments['path'], 'approved.txt');
      assert.equal(pending.tool_calls[0]?.batch, 1);
      assert.equal(
        existsSync(path.join(round.project, 'approved.txt')),
        false,
        'the write has not run while the batch waits',
      );

      const approved = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
        tool_call_id: pending.tool_calls[0]!.tool_call_id,
        confirmed: true,
      });
      assert.equal(approved.status, 200, await approved.clone().text());
      const response = await sent;
      assert.equal(response.status, 201, await response.clone().text());

      assert.equal(fixture.endpoint.requests.length, 2, 'the result is fed back for another turn');
      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [['call-write', false]],
        'an approved write answers as a successful tool result',
      );
      assert.ok((results[0]?.content ?? '').includes('[Write] ok'));
      assert.equal(
        readFileSync(path.join(round.project, 'approved.txt'), 'utf8'),
        'OK',
        'the approved write ran against the project root',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [
          message['kind'],
          message['body'],
        ]),
        [
          ['human', '@写文件的成员 写 approved.txt'],
          ['agent', '批准后写好了'],
        ],
        'the round answered after the approval',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
      const row = await getApproval(fixture, pending.reply_id);
      assert.equal(row.status, 'confirmed');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] ask-writes: a denied Write is a DENIED tool result and the round continues`, async () => {
    const fixture = await startFixture(`allibot-write-edit-denied-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'ask-writes',
      });
      assert.ok(round.project !== null);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-denied', name: 'Write', input: { path: 'denied.txt', content: 'NO' } },
        ]),
        provider.text('写被拒绝了，我按已知信息回答'),
      ]);

      const sent = sendMessage(fixture, round.channelId, '@写文件的成员 写 denied.txt');
      const pending = await waitForPending(fixture);
      const denied = await postJson(fixture, `/api/approvals/${pending.reply_id}`, {
        tool_call_id: pending.tool_calls[0]!.tool_call_id,
        confirmed: false,
      });
      assert.equal(denied.status, 200, await denied.clone().text());
      const response = await sent;
      assert.equal(response.status, 201, await response.clone().text());

      assert.equal(
        fixture.endpoint.requests.length,
        2,
        'a denial is fed back and the model gets another turn',
      );
      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [['call-denied', true]],
        'a denial is a tool error result, never a round failure',
      );
      assert.ok(
        (results[0]?.content ?? '').includes('denied'),
        `the stable code reaches the model: ${results[0]?.content ?? ''}`,
      );
      assert.equal(
        existsSync(path.join(round.project, 'denied.txt')),
        false,
        'a denied write never runs',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [
          message['kind'],
          message['body'],
        ]),
        [
          ['human', '@写文件的成员 写 denied.txt'],
          ['agent', '写被拒绝了，我按已知信息回答'],
        ],
        'the round still answers after a denial',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
      const row = await getApproval(fixture, pending.reply_id);
      assert.equal(row.status, 'denied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a write approval that times out fails the round and is never a tool result`, async () => {
    const fixture = await startFixture(
      `allibot-write-edit-timeout-${provider.label}-`,
      provider,
      { args: ['--approval-timeout-ms', '200', '--fixed-clock', '2026-11-04T00:00:00.000Z'] },
    );
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'ask-writes',
      });
      assert.ok(round.project !== null);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-waits', name: 'Write', input: { path: 'timed-out.txt', content: 'X' } },
        ]),
      ]);

      const sent = await sendMessage(fixture, round.channelId, '@写文件的成员 写 timed-out.txt');
      assert.equal(sent.status, 201, await sent.clone().text());

      assert.equal(
        fixture.endpoint.requests.length,
        1,
        'the timeout is never fed back, so no further turn is taken',
      );
      assert.deepEqual(
        provider.toolResults(requestPayload(fixture.endpoint.requests[0]!)),
        [],
        'the first request carries no tool result at all',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human'],
        'a timed-out approval writes no Agent message',
      );
      const row = await waitFor(
        () => listApprovals(fixture),
        (value) => value.length > 0 && value[0]!.status === 'failed',
        'the timed-out write approval',
      );
      assert.equal(row[0]!.tool_calls[0]?.tool_name, 'Write');
      assert.equal(row[0]!.requested_at, '2026-11-04T00:00:00.000Z');
      assert.equal(row[0]!.resolved_at, '2026-11-04T00:00:00.000Z');
      assert.equal(row[0]!.decisions.length, 0, 'a timeout is nobody-s decision');
      assert.equal(
        existsSync(path.join(round.project, 'timed-out.txt')),
        false,
        'a timed-out write never runs',
      );
      const outcome = roundOutcome(fixture);
      assert.equal(outcome.status, 'failed');
      assert.ok(
        outcome.reason.includes('审批等待超时'),
        `the existing approval-timeout copy is the reason: ${outcome.reason}`,
      );
      assert.equal(
        outcome.reason.includes('模型调用失败'),
        false,
        `an approval timeout is not a model-call failure: ${outcome.reason}`,
      );
      assert.equal(outcome.finished_reason, ZH_CN['round.finished.error'].text);
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] two writes in one reply share one approval request and the reopen publishes only the new call`, async () => {
    const fixture = await startFixture(`allibot-write-edit-batches-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'ask-writes',
      });
      assert.ok(round.project !== null);
      const events = await connectEvents(fixture.base);
      try {
        queueReplies(fixture.endpoint, [
          provider.toolCalls([
            { id: 'call-one', name: 'Write', input: { path: 'one.txt', content: '1' } },
            { id: 'call-two', name: 'Write', input: { path: 'two.txt', content: '2' } },
          ]),
          provider.text('两个文件都写好了'),
        ]);

        const sent = sendMessage(fixture, round.channelId, '@写文件的成员 写两个文件');
        const first = await waitForPending(fixture);
        assert.equal(first.tool_calls.length, 1, 'the first batch carries the first call only');
        assert.equal(first.tool_calls[0]?.arguments['path'], 'one.txt');
        const replyId = first.reply_id;
        const firstCall = first.tool_calls[0]!.tool_call_id;
        const firstRequested = await events.next(
          (frame) => frame.event === 'approval.requested',
          3_000,
        );
        assert.ok(firstRequested !== null, 'the stream carries the first batch');
        assert.deepEqual(firstRequested.data['tool_call_ids'], [firstCall]);

        const approvedFirst = await postJson(fixture, `/api/approvals/${replyId}`, {
          tool_call_id: firstCall,
          confirmed: true,
        });
        assert.equal(approvedFirst.status, 200, await approvedFirst.clone().text());

        // The second write starts the next batch on the same approval row: the
        // call list merges, the first decision is kept, only the new call is
        // published.
        const reopened = await waitForBatch(fixture, replyId, 2);
        assert.equal(reopened.status, 'pending');
        assert.equal(reopened.resolved_at, null);
        assert.equal(reopened.tool_calls.length, 2, 'the row merges both calls of the reply');
        assert.equal(reopened.decisions.length, 1, 'the first decision is kept');
        assert.equal(reopened.batches.length, 2);
        const secondCall = reopened.tool_calls.find((call) => call.tool_call_id !== firstCall)!;
        assert.equal(secondCall.arguments['path'], 'two.txt');
        assert.equal(secondCall.batch, 2);

        const secondRequested = await events.next(
          (frame) => frame.event === 'approval.requested',
          3_000,
        );
        assert.ok(secondRequested !== null, 'the stream carries the reopened batch');
        assert.deepEqual(
          secondRequested.data['tool_call_ids'],
          [secondCall.tool_call_id],
          'the reopen publishes only the new call, never the already-decided one',
        );

        const approvedSecond = await postJson(fixture, `/api/approvals/${replyId}`, {
          tool_call_id: secondCall.tool_call_id,
          confirmed: true,
        });
        assert.equal(approvedSecond.status, 200, await approvedSecond.clone().text());
        const response = await sent;
        assert.equal(response.status, 201, await response.clone().text());

        assert.equal(
          readFileSync(path.join(round.project, 'one.txt'), 'utf8'),
          '1',
          'the first approved write ran',
        );
        assert.equal(
          readFileSync(path.join(round.project, 'two.txt'), 'utf8'),
          '2',
          'the second approved write ran',
        );
        const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
        assert.deepEqual(
          results.map((result) => [result.id, result.isError]),
          [
            ['call-one', false],
            ['call-two', false],
          ],
          'both calls of the batch answer in call order',
        );
        const rows = await listApprovals(fixture);
        assert.equal(rows.length, 1, 'one reply keeps exactly one approval_request row');
        assert.equal(rows[0]!.status, 'confirmed');
        assert.equal(rows[0]!.decisions.length, 2);
        assert.deepEqual(
          (await messages(fixture, round.channelId)).map((message) => [
            message['kind'],
            message['body'],
          ]),
          [
            ['human', '@写文件的成员 写两个文件'],
            ['agent', '两个文件都写好了'],
          ],
          'the round lands one message after two approval batches',
        );
        assert.equal(roundOutcome(fixture).status, 'replied');
      } finally {
        events.close();
      }
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] an out-of-root path and a failed write are tool results, not round failures`, async () => {
    const fixture = await startFixture(`allibot-write-edit-errors-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'trusted-writes',
      });
      assert.ok(round.project !== null);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-escape', name: 'Write', input: { path: '../escape.txt', content: 'X' } },
          { id: 'call-parent', name: 'Write', input: { path: 'nope/file.txt', content: 'X' } },
          {
            id: 'call-no-match',
            name: 'Edit',
            input: { path: 'target.txt', old_string: 'ABSENT', new_string: 'Y' },
          },
        ]),
        provider.text('三条都失败了，我按已知信息回答'),
      ]);
      writeFileSync(path.join(round.project, 'target.txt'), 'PRESENT\n', 'utf8');

      await sendMessage(fixture, round.channelId, '@写文件的成员 试三种失败写法');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-escape', true],
          ['call-parent', true],
          ['call-no-match', true],
        ],
        'every write failure is an error tool result',
      );
      assert.ok(
        (results[0]?.content ?? '').startsWith('[Write] error: outside-root'),
        `an escaping path keeps its stable code: ${results[0]?.content ?? ''}`,
      );
      assert.ok(
        (results[1]?.content ?? '').startsWith('[Write] error: not-found'),
        `a missing parent directory keeps its stable code: ${results[1]?.content ?? ''}`,
      );
      assert.ok(
        (results[2]?.content ?? '').startsWith('[Edit] error: old-string-not-found'),
        `a non-matching edit keeps its stable code: ${results[2]?.content ?? ''}`,
      );
      assert.equal(
        existsSync(path.join(fixture.tmp, 'escape.txt')),
        false,
        'nothing was written outside the project root',
      );
      assert.equal(
        readFileSync(path.join(round.project, 'target.txt'), 'utf8'),
        'PRESENT\n',
        'a failed edit leaves the file untouched',
      );
      assert.deepEqual(
        await listApprovals(fixture),
        [],
        'a hard path failure never asks for an approval',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => message['kind']),
        ['human', 'agent'],
        'the round still answers',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a write onto an existing directory is an io-error tool result`, async () => {
    const fixture = await startFixture(`allibot-write-edit-io-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'trusted-writes',
      });
      assert.ok(round.project !== null);
      const directory = path.join(round.project, 'a-directory');
      mkdirSync(directory);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-io', name: 'Write', input: { path: 'a-directory', content: 'X' } },
        ]),
        provider.text('那个路径是个目录，我换个名字再写'),
      ]);

      await sendMessage(fixture, round.channelId, '@写文件的成员 写到那个目录上');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.equal(results.length, 1);
      assert.equal(results[0]?.id, 'call-io');
      assert.equal(results[0]?.isError, true, "the face's own failure is an error tool result");
      assert.ok(
        (results[0]?.content ?? '').startsWith('[Write] error: io-error'),
        `the io-error code reaches the model: ${results[0]?.content ?? ''}`,
      );
      assert.equal(statSync(directory).isDirectory(), true, 'the directory is untouched');
      assert.deepEqual(await listApprovals(fixture), [], 'a trusted root write never asks');
      assert.equal(roundOutcome(fixture).status, 'replied', 'the round continues');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] malformed write arguments are tool results and never reach the face`, async () => {    const fixture = await startFixture(`allibot-write-edit-shape-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, {
        prefix: 'project',
        withRoot: true,
        permissionMode: 'trusted-writes',
      });
      assert.ok(round.project !== null);
      queueReplies(fixture.endpoint, [
        provider.toolCalls([
          { id: 'call-missing', name: 'Write', input: { path: 'missing.txt' } },
          {
            id: 'call-typed',
            name: 'Edit',
            input: { path: 'typed.txt', old_string: 5, new_string: 'Y' },
          },
          {
            id: 'call-extra',
            name: 'Write',
            input: { path: 'extra.txt', content: 'X', encoding: 'utf8' },
          },
        ]),
        provider.text('三个参数都不合形状，我按 schema 重来'),
      ]);

      await sendMessage(fixture, round.channelId, '@写文件的成员 用三个不合形状的调用');

      const results = provider.toolResults(requestPayload(fixture.endpoint.requests[1]!));
      assert.deepEqual(
        results.map((result) => [result.id, result.isError]),
        [
          ['call-missing', true],
          ['call-typed', true],
          ['call-extra', true],
        ],
        'a malformed call is a tool result',
      );
      assert.ok(
        (results[0]?.content ?? '').includes('invalid-arguments'),
        `a missing required argument is refused: ${results[0]?.content ?? ''}`,
      );
      assert.ok(
        (results[1]?.content ?? '').includes('invalid-arguments'),
        `a wrongly typed argument is refused: ${results[1]?.content ?? ''}`,
      );
      assert.ok(
        (results[2]?.content ?? '').includes('invalid-arguments'),
        `an extra argument is refused: ${results[2]?.content ?? ''}`,
      );
      for (const name of ['missing.txt', 'typed.txt', 'extra.txt']) {
        assert.equal(
          existsSync(path.join(round.project, name)),
          false,
          `a shape-refused call never reached the face: ${name}`,
        );
      }
      assert.deepEqual(await listApprovals(fixture), [], 'a shape refusal never asks for an approval');
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });

  test(`[${provider.label}] a round with no project root is handed neither Write nor Edit`, async () => {
    const fixture = await startFixture(`allibot-write-edit-noroot-${provider.label}-`, provider);
    try {
      const round = await openRound(fixture, provider, { prefix: 'project', withRoot: false });
      queueReplies(fixture.endpoint, [provider.text('没有项目根，我不能写文件')]);

      await sendMessage(fixture, round.channelId, '@写文件的成员 写一个文件');

      assert.equal(fixture.endpoint.requests.length, 1, 'no tool call means no second round trip');
      const payload = requestPayload(fixture.endpoint.requests[0]!);
      assert.deepEqual(
        provider.toolDefinitions(payload),
        [],
        'a rootless round hands the provider zero tool definitions',
      );
      assert.deepEqual(
        (await messages(fixture, round.channelId)).map((message) => [
          message['kind'],
          message['body'],
        ]),
        [
          ['human', '@写文件的成员 写一个文件'],
          ['agent', '没有项目根，我不能写文件'],
        ],
        'the rootless round answers in one call',
      );
      assert.equal(roundOutcome(fixture).status, 'replied');
    } finally {
      await fixture.stop();
    }
  });
}
