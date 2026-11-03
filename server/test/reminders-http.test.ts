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

/**
 * 提醒 (Reminder) 与到点 (Due), observed at the process-level HTTP seam.
 *
 * A reminder is a one-shot local date + clock with a text note, optionally
 * owned by a channel. The backend tick lands a `kind='system'` message in that
 * channel when it is due; `delivered_at` is the at-most-once / at-most-once-
 * catch-up marker, and a reminder found more than 24 hours late is recorded as
 * missed without a message. Tests never wait for real time: they create
 * reminders that are already due and inject a short tick.
 */

interface ReminderFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  /** Stop and start the same data directory; the startup tick runs first. */
  restart: (tickMs?: number) => Promise<void>;
  stop: () => Promise<void>;
}

async function startReminderFixture(
  prefix: string,
  options: { tickMs?: number } = {},
): Promise<ReminderFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  let running = await startReminderServer(dataDir, options.tickMs ?? 30);
  return {
    dataDir,
    get running() {
      return running;
    },
    get base() {
      return `http://127.0.0.1:${running.port}`;
    },
    restart: async (tickMs = options.tickMs ?? 30) => {
      await running.stop();
      running = await startReminderServer(dataDir, tickMs);
    },
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

function startReminderServer(dataDir: string, tickMs: number): Promise<RunningServer> {
  return startServer(dataDir, {
    args: ['--scripted-provider', 'ignore', '--reminder-tick-ms', String(tickMs)],
  });
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: ReminderFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: ReminderFixture, name = '提醒频道'): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

/** The fixed local-time format the reminder face accepts: YYYY-MM-DDTHH:mm. */
function localStamp(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

function localStampAfter(offsetMs: number): string {
  return localStamp(new Date(Date.now() + offsetMs));
}

interface ReminderList {
  pending: Record<string, unknown>[];
  delivered: Record<string, unknown>[];
  missed: Record<string, unknown>[];
}

async function listReminders(fixture: ReminderFixture): Promise<ReminderList> {
  const response = await fetch(`${fixture.base}/api/reminders`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await readJson(response);
  return {
    pending: body['pending'] as Record<string, unknown>[],
    delivered: body['delivered'] as Record<string, unknown>[],
    missed: body['missed'] as Record<string, unknown>[],
  };
}

function ids(list: Record<string, unknown>[]): string[] {
  return list.map((row) => row['id'] as string);
}

interface SseFrame {
  event: string;
  data: string;
}

/** Read frames until one of `type` arrives (workspace writes publish their own). */
async function nextOfType(
  subscription: Subscription,
  type: string,
  timeoutMs = 5_000,
): Promise<SseFrame> {
  for (;;) {
    const frame = await subscription.next(timeoutMs);
    if (frame.event === type) {
      return frame;
    }
  }
}

/** One open subscription, read frame by frame; a real fetch against the process. */
class Subscription {
  private readonly frames: SseFrame[] = [];
  private readonly waiting: Array<{
    resolve: (frame: SseFrame) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private buffer = '';
  private closed = false;
  private failure: Error | null = null;
  private readonly decoder = new TextDecoder();
  private readonly abort = new AbortController();
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

  static async open(url: string): Promise<Subscription> {
    const subscription = new Subscription();
    const response = await fetch(url, {
      headers: { accept: 'text/event-stream' },
      signal: subscription.abort.signal,
    });
    assert.ok(response.body !== null, 'the subscription should carry a body stream');
    subscription.reader = response.body.getReader();
    void subscription.pump();
    return subscription;
  }

  async next(timeoutMs = 5_000): Promise<SseFrame> {
    const frame = this.frames.shift();
    if (frame !== undefined) {
      return frame;
    }
    if (this.closed) {
      return await Promise.reject(this.failure ?? new Error('the subscription closed'));
    }
    return await new Promise<SseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiting.findIndex((waiter) => waiter.timer === timer);
        if (index !== -1) {
          this.waiting.splice(index, 1);
        }
        reject(new Error(`no SSE frame within ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiting.push({ resolve, reject, timer });
    });
  }

  close(): void {
    this.abort.abort();
    void this.reader?.cancel().catch(() => undefined);
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const { done, value } = await this.reader!.read();
        if (done) {
          break;
        }
        this.buffer += this.decoder.decode(value, { stream: true });
        let boundary = this.buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const raw = this.buffer.slice(0, boundary);
          const lines = raw.split('\n');
          this.frames.push({
            event: (lines.find((line) => line.startsWith('event: ')) ?? '').slice(7),
            data: (lines.find((line) => line.startsWith('data: ')) ?? '').slice(6),
          });
          this.buffer = this.buffer.slice(boundary + 2);
          boundary = this.buffer.indexOf('\n\n');
        }
        this.settle();
      }
    } catch (error) {
      if (!this.abort.signal.aborted) {
        this.failure = error instanceof Error ? error : new Error(String(error));
      }
    }
    this.closed = true;
    this.settle();
  }

  private settle(): void {
    while (this.waiting.length > 0) {
      const waiter = this.waiting[0]!;
      const frame = this.frames.shift();
      if (frame !== undefined) {
        this.waiting.shift();
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
        continue;
      }
      if (this.closed) {
        this.waiting.shift();
        clearTimeout(waiter.timer);
        waiter.reject(this.failure ?? new Error('the subscription closed'));
        continue;
      }
      return;
    }
  }
}

async function createAgent(fixture: ReminderFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: ReminderFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function listMessages(
  fixture: ReminderFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function queryOne<T>(
  fixture: ReminderFixture,
  sql: string,
  params: readonly unknown[] = [],
): T | undefined {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db.prepare(sql).get(...(params as never[])) as T | undefined;
  } finally {
    db.close();
  }
}

function countRows(fixture: ReminderFixture, table: string): number {
  return (
    queryOne<{ total: number }>(fixture, `SELECT count(*) AS total FROM ${table}`)?.total ?? -1
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('a reminder is created pending and read back with its local time and channel', async () => {
  const fixture = await startReminderFixture('allibot-reminders-create-');
  try {
    const channelId = await createChannel(fixture);
    const due = localStampAfter(60 * 60 * 1000);

    const created = await postJson(fixture, '/api/reminders', {
      channel_id: channelId,
      due_at_local: due,
      text: '  周会  ',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const view = await readJson(created);
    assert.equal(view['channel_id'], channelId);
    assert.equal(view['due_at_local'], due, 'the local time string is stored as given');
    assert.equal(view['text'], '周会');
    assert.equal(view['delivered_at'], null);
    assert.equal(view['missed'], false);

    const list = await listReminders(fixture);
    assert.deepEqual(list, { pending: [view], delivered: [], missed: [] });

    const detached = await postJson(fixture, '/api/reminders', {
      due_at_local: localStampAfter(2 * 60 * 60 * 1000),
      text: '无频道的备忘',
    });
    assert.equal(detached.status, 201, await detached.clone().text());
    const detachedView = await readJson(detached);
    assert.equal(detachedView['channel_id'], null);
    assert.deepEqual(ids((await listReminders(fixture)).pending), [
      view['id'] as string,
      detachedView['id'] as string,
    ]);
  } finally {
    await fixture.stop();
  }
});

test('an invalid local date is a 400 validation_failed and leaves no reminder behind', async () => {
  const fixture = await startReminderFixture('allibot-reminders-validation-');
  try {
    const cases: unknown[] = [
      { due_at_local: '2026-02-30T10:00', text: '不存在的日期' },
      { due_at_local: '2026-11-03 10:00', text: '错的格式' },
      { due_at_local: '2026-11-03T25:00', text: '不存在的钟点' },
      { due_at_local: '明天早上', text: '不是时间' },
      { due_at_local: '2026-11-03T10:00', text: '   ' },
      { due_at_local: '2026-11-03T10:00', channel_id: 7, text: '频道不是 id' },
      { due_at_local: '2026-11-03T10:00', text: '多余字段', extra: true },
    ];
    for (const body of cases) {
      const response = await postJson(fixture, '/api/reminders', body);
      assert.equal(response.status, 400, `${JSON.stringify(body)}: ${await response.clone().text()}`);
      const error = (await readJson(response))['error'] as Record<string, unknown>;
      assert.equal(error['code'], 'validation_failed');
    }

    const unknownChannel = await postJson(fixture, '/api/reminders', {
      channel_id: 'no-such-channel',
      due_at_local: '2026-11-03T10:00',
      text: '未知频道',
    });
    assert.equal(unknownChannel.status, 404);
    assert.equal(
      ((await readJson(unknownChannel))['error'] as Record<string, unknown>)['code'],
      'not_found',
    );

    assert.deepEqual(await listReminders(fixture), { pending: [], delivered: [], missed: [] });
  } finally {
    await fixture.stop();
  }
});

test('a due reminder lands one system message in its channel, once, with no unread and no wake', async () => {
  const fixture = await startReminderFixture('allibot-reminders-due-');
  const subscription = await Subscription.open(`${fixture.base}/api/events`);
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const created = await postJson(fixture, '/api/reminders', {
      channel_id: channelId,
      due_at_local: localStampAfter(-60_000),
      text: '喝水',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const reminder = await readJson(created);

    const reminderFrame = await nextOfType(subscription, 'reminder.due');
    assert.deepEqual(JSON.parse(reminderFrame.data), {
      reminder_id: reminder['id'],
      target_id: channelId,
    });

    const messageFrame = await nextOfType(subscription, 'message.created');
    const messageData = JSON.parse(messageFrame.data) as Record<string, unknown>;
    assert.equal(messageData['target_id'], channelId);
    assert.equal(messageData['seq'], 1);

    const delivered = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const list = await listReminders(fixture);
        if (list.delivered.length === 1) {
          return list.delivered[0]!;
        }
        await delay(25);
      }
      throw new Error('the reminder was not marked delivered');
    })();
    assert.equal(delivered['id'], reminder['id']);
    assert.equal(delivered['missed'], false);
    assert.notEqual(delivered['delivered_at'], null);

    const owner = queryOne<{ id: string }>(fixture, "SELECT id FROM member WHERE kind = 'owner'");
    const messages = await listMessages(fixture, channelId);
    assert.equal(messages.length, 1, 'the due fact lands exactly one message');
    assert.equal(messages[0]?.['kind'], 'system');
    assert.equal(messages[0]?.['body'], '提醒到点：喝水');
    assert.equal(messages[0]?.['author_member_id'], owner?.id, 'the system event is authored by the owner');

    const workspace = await readJson(await fetch(`${fixture.base}/api/workspace`));
    assert.equal(workspace['unread_total'], 0, 'a system event never raises the badge');
    assert.equal((workspace['unread_by_target'] as Record<string, number>)[channelId], 0);

    // Several more ticks pass: the delivered_at marker keeps it at most once.
    await delay(250);
    assert.equal((await listMessages(fixture, channelId)).length, 1);
    const after = await listReminders(fixture);
    assert.equal(after.delivered[0]?.['delivered_at'], delivered['delivered_at']);
    await assert.rejects(subscription.next(250), /no SSE frame within/, 'the due fact announces once');

    assert.equal(countRows(fixture, 'round_outcome'), 0, 'a system event wakes nobody');
    assert.equal(countRows(fixture, 'target_budget'), 0, 'the due write touches no budget');
  } finally {
    subscription.close();
    await fixture.stop();
  }
});

test('a reminder found beyond the 24-hour window is marked missed and lands no message', async () => {
  const fixture = await startReminderFixture('allibot-reminders-missed-');
  const subscription = await Subscription.open(`${fixture.base}/api/events`);
  try {
    const channelId = await createChannel(fixture);
    const created = await postJson(fixture, '/api/reminders', {
      channel_id: channelId,
      due_at_local: localStampAfter(-25 * 60 * 60 * 1000),
      text: '昨天的备忘',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const reminder = await readJson(created);

    const frame = await nextOfType(subscription, 'reminder.due');
    assert.deepEqual(JSON.parse(frame.data), {
      reminder_id: reminder['id'],
      target_id: channelId,
    });

    const missed = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const list = await listReminders(fixture);
        if (list.missed.length === 1) {
          return list.missed[0]!;
        }
        await delay(25);
      }
      throw new Error('the reminder was not marked missed');
    })();
    assert.equal(missed['id'], reminder['id']);
    assert.equal(missed['missed'], true);
    assert.notEqual(missed['delivered_at'], null, 'the due fact is recorded');

    assert.deepEqual(await listMessages(fixture, channelId), [], 'no message outside the window');
    await assert.rejects(
      subscription.next(300),
      /no SSE frame within/,
      'a missed reminder publishes no message.created frame',
    );
    assert.equal(countRows(fixture, 'round_outcome'), 0);
  } finally {
    subscription.close();
    await fixture.stop();
  }
});

test('a reminder with no channel is marked due without a message.created frame', async () => {
  const fixture = await startReminderFixture('allibot-reminders-no-channel-');
  const subscription = await Subscription.open(`${fixture.base}/api/events`);
  try {
    const onTime = await readJson(
      await postJson(fixture, '/api/reminders', {
        due_at_local: localStampAfter(-60_000),
        text: '到点的备忘',
      }),
    );
    const stale = await readJson(
      await postJson(fixture, '/api/reminders', {
        due_at_local: localStampAfter(-25 * 60 * 60 * 1000),
        text: '错过的备忘',
      }),
    );

    const first = await nextOfType(subscription, 'reminder.due');
    const second = await nextOfType(subscription, 'reminder.due');
    assert.deepEqual(
      [JSON.parse(first.data), JSON.parse(second.data)],
      [
        { reminder_id: onTime['id'], target_id: null },
        { reminder_id: stale['id'], target_id: null },
      ],
      'a channel-less reminder names no target',
    );

    const list = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await listReminders(fixture);
        if (current.delivered.length + current.missed.length === 2) {
          return current;
        }
        await delay(25);
      }
      throw new Error('the channel-less reminders were not processed');
    })();
    assert.deepEqual(ids(list.delivered), [onTime['id']]);
    assert.deepEqual(ids(list.missed), [stale['id']]);
    assert.notEqual(list.delivered[0]?.['delivered_at'], null);
    assert.equal(list.missed[0]?.['missed'], true);

    await assert.rejects(
      subscription.next(300),
      /no SSE frame within/,
      'no channel means no message, so no message.created frame',
    );
    assert.equal(countRows(fixture, 'target'), 0, 'a reminder never creates a target');
  } finally {
    subscription.close();
    await fixture.stop();
  }
});

test('deleting a pending reminder writes nothing; deleting a delivered one keeps its message', async () => {
  const fixture = await startReminderFixture('allibot-reminders-delete-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    const pending = await readJson(
      await postJson(fixture, '/api/reminders', {
        channel_id: channelId,
        due_at_local: localStampAfter(60 * 60 * 1000),
        text: '还没到点',
      }),
    );
    const removedPending = await fetch(`${fixture.base}/api/reminders/${pending['id'] as string}`, {
      method: 'DELETE',
    });
    assert.equal(removedPending.status, 204);
    assert.deepEqual(await listMessages(fixture, channelId), [], 'a delete writes no message');
    assert.equal(countRows(fixture, 'round_outcome'), 0, 'a delete wakes nobody');
    assert.equal(countRows(fixture, 'target_budget'), 0, 'a delete changes no budget');
    assert.deepEqual(await listReminders(fixture), { pending: [], delivered: [], missed: [] });

    const unknown = await fetch(`${fixture.base}/api/reminders/no-such-reminder`, {
      method: 'DELETE',
    });
    assert.equal(unknown.status, 404);

    const deliveredReminder = await readJson(
      await postJson(fixture, '/api/reminders', {
        channel_id: channelId,
        due_at_local: localStampAfter(-60_000),
        text: '已到点',
      }),
    );
    const deliveredList = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const list = await listReminders(fixture);
        if (list.delivered.length === 1) {
          return list;
        }
        await delay(25);
      }
      throw new Error('the reminder was not delivered');
    })();
    assert.equal(deliveredList.delivered[0]?.['id'], deliveredReminder['id']);
    const before = await listMessages(fixture, channelId);
    assert.equal(before.length, 1);

    const removedDelivered = await fetch(
      `${fixture.base}/api/reminders/${deliveredReminder['id'] as string}`,
      { method: 'DELETE' },
    );
    assert.equal(removedDelivered.status, 204);
    assert.deepEqual(await listReminders(fixture), { pending: [], delivered: [], missed: [] });
    assert.deepEqual(
      await listMessages(fixture, channelId),
      before,
      'the system message is append-only: deleting the reminder keeps it',
    );
    assert.equal(countRows(fixture, 'reminder'), 0);
  } finally {
    await fixture.stop();
  }
});

test('a restart catches up an overdue reminder once, inside the window', async () => {
  // The long interval means the reminder becomes due while no tick can run:
  // this is the "process was not running" case without waiting for real time.
  const fixture = await startReminderFixture('allibot-reminders-restart-', {
    tickMs: 60 * 60 * 1000,
  });
  try {
    const channelId = await createChannel(fixture);
    const created = await readJson(
      await postJson(fixture, '/api/reminders', {
        channel_id: channelId,
        due_at_local: localStampAfter(-60_000),
        text: '停机期间的备忘',
      }),
    );

    await delay(150);
    assert.deepEqual(ids((await listReminders(fixture)).pending), [created['id']]);

    await fixture.restart(30);
    const delivered = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const list = await listReminders(fixture);
        if (list.delivered.length === 1) {
          return list.delivered[0]!;
        }
        await delay(25);
      }
      throw new Error('the restart did not catch the reminder up');
    })();
    assert.equal(delivered['id'], created['id']);
    assert.equal(delivered['missed'], false);
    const messages = await listMessages(fixture, channelId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.['body'], '提醒到点：停机期间的备忘');

    // The delivered_at marker survives the restart: a second start adds nothing.
    await fixture.restart(30);
    await delay(150);
    assert.equal((await listMessages(fixture, channelId)).length, 1);
    assert.deepEqual(ids((await listReminders(fixture)).delivered), [created['id']]);
  } finally {
    await fixture.stop();
  }
});

test('a due reminder still lands its message on an archived channel', async () => {
  const fixture = await startReminderFixture('allibot-reminders-archived-');
  try {
    const channelId = await createChannel(fixture);
    const archived = await postJson(fixture, `/api/channels/${channelId}/archive`, {});
    assert.equal(archived.status, 200, await archived.clone().text());

    const created = await postJson(fixture, '/api/reminders', {
      channel_id: channelId,
      due_at_local: localStampAfter(-60_000),
      text: '归档频道也要到点',
    });
    assert.equal(created.status, 201, await created.clone().text());

    const list = await (async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const current = await listReminders(fixture);
        if (current.delivered.length === 1) {
          return current;
        }
        await delay(25);
      }
      throw new Error('the reminder was not delivered');
    })();
    assert.equal(list.delivered[0]?.['missed'], false);
    const messages = await listMessages(fixture, channelId);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]?.['kind'], 'system');
    assert.equal(messages[0]?.['body'], '提醒到点：归档频道也要到点');
  } finally {
    await fixture.stop();
  }
});
