import { randomUUID } from 'node:crypto';
import type { ReminderListView, ReminderView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { assertChannelReadable, channelReadState, readChannelLiveness } from './channels.js';
import { tFromDb } from './copy.js';
import { publishMessageCreated, publishReminderDue } from './events.js';
import { insertMessageRow } from './message-store.js';

/**
 * 提醒 (Reminder): the owner's one-shot local date + clock with a text note,
 * optionally owned by a channel. It is a backend-held object — it survives a
 * refresh, a restart and a browser change — not browser state.
 *
 * due_at_local is the fixed `YYYY-MM-DDTHH:mm` wall time the owner typed and is
 * interpreted in this machine's local timezone by the tick. created_at stays
 * the UTC audit stamp; the two are never converted against each other.
 */
export const DUE_AT_LOCAL_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

/**
 * How often the serve process looks for due reminders. The reminder test seam
 * injects a short interval instead of waiting for real time.
 */
export const DEFAULT_REMINDER_TICK_MS = 30_000;

/** The catch-up window: a reminder found later than this is marked missed, not delivered. */
export const CATCH_UP_WINDOW_MS = 24 * 60 * 60 * 1000;

interface ReminderRow {
  id: string;
  channel_id: string | null;
  due_at_local: string;
  text: string;
  delivered_at: string | null;
  missed: number;
  created_at: string;
}

const REMINDER_SELECT = `
SELECT id, channel_id, due_at_local, text, delivered_at, missed, created_at
FROM reminder`;

const FIELD_KEYS = new Set(['channel_id', 'due_at_local', 'text']);

/**
 * The human-face create body: a channel (optional), a local due time and a
 * text note. The channel is read through the shared channel guard, so an
 * unknown or deleted channel is a 404 rather than a dangling reference; an
 * archived channel is allowed, because a due reminder still lands its system
 * message there (D1.13 频道归档).
 */
export function createReminder(db: Database.Database, body: unknown): ReminderView {
  const record = asObject(body);
  for (const key of Object.keys(record)) {
    if (!FIELD_KEYS.has(key)) {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const channelId = parseChannelId(record['channel_id']);
  if (channelId !== null) {
    assertChannelReadable(db, channelId);
  }
  const dueAtLocal = parseDueAtLocal(record['due_at_local']);
  const text = requireText(record['text']);

  const id = randomUUID();
  db.prepare(
    `INSERT INTO reminder (id, channel_id, due_at_local, text, delivered_at, missed, created_at)
     VALUES (?, ?, ?, ?, NULL, 0, ?)`,
  ).run(id, channelId, dueAtLocal, text, new Date().toISOString());
  return readReminderView(db, id);
}

/** The reminder list, grouped by due state; the order is creation order. */
export function listReminders(db: Database.Database): ReminderListView {
  const rows = db.prepare(`${REMINDER_SELECT} ORDER BY created_at, rowid`).all() as ReminderRow[];
  const view: ReminderListView = { pending: [], delivered: [], missed: [] };
  for (const row of rows) {
    const reminder = toReminderView(row);
    if (row.delivered_at === null) {
      view.pending.push(reminder);
    } else if (row.missed === 1) {
      view.missed.push(reminder);
    } else {
      view.delivered.push(reminder);
    }
  }
  return view;
}

/**
 * Delete removes the reminder row only. A delivered reminder's system message
 * is a stored fact and stays where it is: messages are append-only, so
 * deleting the reminder never deletes history.
 */
export function deleteReminder(db: Database.Database, id: string): void {
  const result = db.prepare('DELETE FROM reminder WHERE id = ?').run(id);
  if (result.changes !== 1) {
    throw ApiFailure.notFound(`reminder not found: ${id}`);
  }
}

/**
 * One backend tick: every pending reminder whose local due time has arrived is
 * marked delivered exactly once. A reminder within the 24-hour catch-up window
 * lands one `kind='system'` message in its channel (authored by the owner,
 * archiving does not stop it); a reminder found beyond the window, or one that
 * belongs to no channel, is only marked — `missed` records the window fact.
 *
 * The conditional UPDATE is the second half of the at-most-once guarantee: a
 * concurrent or repeated tick that loses the race publishes nothing.
 */
export function processDueReminders(db: Database.Database, now: Date = new Date()): void {
  const pending = db
    .prepare(`${REMINDER_SELECT} WHERE delivered_at IS NULL ORDER BY rowid`)
    .all() as ReminderRow[];
  for (const row of pending) {
    try {
      processDueReminder(db, row, now);
    } catch (error) {
      // One bad row must not stop the tick for every other reminder.
      console.error(`allibot: reminder ${row.id} due processing failed:`, error);
    }
  }
}

function processDueReminder(db: Database.Database, row: ReminderRow, now: Date): void {
  const dueEpoch = dueAtLocalEpoch(row.due_at_local);
  const nowMs = now.getTime();
  if (dueEpoch > nowMs) {
    return;
  }
  const missed = nowMs - dueEpoch > CATCH_UP_WINDOW_MS;
  const channelId = row.channel_id;
  const commit = db.transaction((): { message: { id: string; seq: number } | null; claimed: boolean } => {
    const update = db
      .prepare('UPDATE reminder SET delivered_at = ?, missed = ? WHERE id = ? AND delivered_at IS NULL')
      .run(now.toISOString(), missed ? 1 : 0, row.id);
    if (update.changes !== 1) {
      return { message: null, claimed: false };
    }
    if (channelId === null || missed) {
      return { message: null, claimed: true };
    }
    // A deleted channel can no longer receive history. An archived one can:
    // D1.13 频道归档 keeps "提醒到点仍落 system 消息" true.
    if (channelReadState(readChannelLiveness(db, channelId)) === 'deleted') {
      return { message: null, claimed: true };
    }
    const message = insertMessageRow(db, {
      targetId: channelId,
      kind: 'system',
      body: tFromDb(db, 'reminder.due.body', { text: row.text }),
    });
    return { message, claimed: true };
  });
  const committed = commit();
  if (!committed.claimed) {
    return;
  }
  publishReminderDue({ reminderId: row.id, targetId: channelId });
  if (committed.message !== null && channelId !== null) {
    publishMessageCreated({
      targetId: channelId,
      id: committed.message.id,
      seq: committed.message.seq,
    });
  }
}

/**
 * The process-local tick. The first pass runs at startup, so a backend that
 * was stopped catches up its overdue reminders immediately; later passes run
 * on the injected interval. The timer is unref'd: it never keeps the process
 * alive on its own, and the returned function stops it on shutdown.
 */
export function startReminderScheduler(
  db: Database.Database,
  tickMs: number,
): () => void {
  const tick = (): void => {
    try {
      processDueReminders(db);
    } catch (error) {
      console.error('allibot: reminder tick failed:', error);
    }
  };
  tick();
  const timer = setInterval(tick, tickMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}

/**
 * Parse the fixed local-time string into the epoch the tick compares against
 * `now`. `new Date(y, m, d, h, min)` interprets the parts in the machine's
 * local timezone; the round-trip check rejects a calendar-invalid local date
 * such as 2026-02-30 or a DST gap that silently normalizes to another clock
 * time.
 */
export function parseDueAtLocal(value: unknown): string {
  if (typeof value !== 'string' || !DUE_AT_LOCAL_PATTERN.test(value)) {
    throw ApiFailure.validation(
      'due_at_local must be a local date and time formatted as YYYY-MM-DDTHH:mm',
      { field: 'due_at_local', value },
    );
  }
  const epoch = dueAtLocalEpoch(value);
  const parsed = new Date(epoch);
  const roundTrips =
    parsed.getFullYear() === Number(value.slice(0, 4)) &&
    parsed.getMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getDate() === Number(value.slice(8, 10)) &&
    parsed.getHours() === Number(value.slice(11, 13)) &&
    parsed.getMinutes() === Number(value.slice(14, 16));
  if (!roundTrips) {
    throw ApiFailure.validation(`due_at_local is not a real local date: ${value}`, {
      field: 'due_at_local',
      value,
    });
  }
  return value;
}

/** The local wall time as an epoch; the string is already format-checked. */
export function dueAtLocalEpoch(dueAtLocal: string): number {
  return new Date(
    Number(dueAtLocal.slice(0, 4)),
    Number(dueAtLocal.slice(5, 7)) - 1,
    Number(dueAtLocal.slice(8, 10)),
    Number(dueAtLocal.slice(11, 13)),
    Number(dueAtLocal.slice(14, 16)),
    0,
    0,
  ).getTime();
}

function readReminderView(db: Database.Database, id: string): ReminderView {
  const row = db.prepare(`${REMINDER_SELECT} WHERE id = ?`).get(id) as ReminderRow | undefined;
  if (row === undefined) {
    throw new Error(`reminder row disappeared after write: ${id}`);
  }
  return toReminderView(row);
}

function toReminderView(row: ReminderRow): ReminderView {
  return {
    id: row.id,
    channel_id: row.channel_id,
    due_at_local: row.due_at_local,
    text: row.text,
    delivered_at: row.delivered_at,
    missed: row.missed === 1,
    created_at: row.created_at,
  };
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  return body as Record<string, unknown>;
}

function parseChannelId(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('channel_id must be a non-empty string or null', {
      field: 'channel_id',
      value,
    });
  }
  return value.trim();
}

function requireText(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw ApiFailure.validation('text must be a non-empty string', { field: 'text' });
  }
  return value.trim();
}
