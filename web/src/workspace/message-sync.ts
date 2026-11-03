import type { MessageView } from '@allibot/shared';
import type { Message } from '@copilotkit/react-core/v2';

/**
 * Manual thread hydration and live appends (ADR 0003 / D3.4).
 *
 * SQLite is the only message source. Switching target re-reads the backend
 * message page into the one chat agent with `setMessages`, and a global
 * `message.created` frame is appended with `addMessage`. Both paths key on
 * `messageId`, so a hydrated row and the same live row render one bubble, and
 * switching away and back never duplicates a row.
 */

/** The one chat agent's minimum surface; `HttpAgent` and `AbstractAgent` fit. */
export interface ChatAgent {
  readonly messages: readonly Message[];
  setMessages(messages: Message[]): void;
  addMessage(message: Message): void;
}

/** The normal context window: hydration keeps the newest 40 rows (D1.13). */
export const HYDRATE_MESSAGE_LIMIT = 40;

/** The backend page cap (`GET /api/targets/{id}/messages`). */
export const MESSAGE_PAGE_SIZE = 200;

/**
 * A runaway guard for the forward paging: local M1 threads are small, and a
 * backend that keeps answering a full page must not loop forever.
 */
const MAX_HYDRATION_PAGES = 50;

/** The live event names the global stream carries (D1.9). */
export const LIVE_EVENT_TYPES = [
  'message.created',
  'member.status',
  'round.outcome',
  'task.changed',
  'unread.changed',
  'reminder.due',
  'workspace.changed',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

export interface LiveEvent {
  event: LiveEventType;
  data: Record<string, unknown>;
}

/** The frame a stored message publishes; `target_id` is the ownership fact. */
export interface MessageCreatedFrame {
  target_id: string;
  message_id: string;
  seq: number;
}

/** A row maps to one chat message; the id is the SQLite message id. */
export function toChatMessage(view: MessageView): Message {
  switch (view.kind) {
    case 'human':
      return { id: view.id, role: 'user', content: view.body };
    case 'agent':
      return { id: view.id, role: 'assistant', content: view.body };
    case 'system':
      return { id: view.id, role: 'system', content: view.body };
  }
}

/**
 * One row per message id, first-seen order, last copy wins. This is the one
 * dedupe both hydration and the live append share.
 */
export function dedupeMessages(messages: readonly Message[]): Message[] {
  const byId = new Map<string, Message>();
  for (const message of messages) {
    byId.set(message.id, message);
  }
  return [...byId.values()];
}

/**
 * Load a target's newest messages into the chat agent. `replace` is true when
 * the target changed (the thread identity moved); merging is used when the
 * same thread is re-read, so an in-flight append is not dropped.
 */
export function hydrateThread(
  agent: ChatAgent,
  views: readonly MessageView[],
  options: { replace?: boolean } = {},
): Message[] {
  const hydrated = dedupeMessages(views.map(toChatMessage));
  const next =
    options.replace === false
      ? dedupeMessages([...agent.messages, ...hydrated])
      : hydrated;
  agent.setMessages(next);
  return next;
}

/**
 * Append one live row unless the thread already renders it. A user message
 * that the chat already shows under its client id is also skipped: the
 * message write path stores that id as `client_message_id`.
 */
export function appendThreadMessage(agent: ChatAgent, view: MessageView): boolean {
  const ids = new Set(agent.messages.map((message) => message.id));
  if (ids.has(view.id)) {
    return false;
  }
  if (view.client_message_id !== null && ids.has(view.client_message_id)) {
    return false;
  }
  agent.addMessage(toChatMessage(view));
  return true;
}

async function readMessagePage(
  fetchImpl: typeof fetch,
  targetId: string,
  afterSeq: number,
): Promise<MessageView[]> {
  const url = `/api/targets/${encodeURIComponent(targetId)}/messages?after_seq=${afterSeq}&limit=${MESSAGE_PAGE_SIZE}`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`GET messages for ${targetId} failed with ${response.status}`);
  }
  const body = (await response.json()) as { messages?: MessageView[] };
  return body.messages ?? [];
}

/**
 * Read the newest `limit` messages through the backend's forward page. The
 * endpoint has no backwards cursor, so the newest rows are found by paging to
 * the end of the thread; the guard bounds a misbehaving backend.
 */
export async function readRecentMessages(
  fetchImpl: typeof fetch,
  targetId: string,
  limit: number = HYDRATE_MESSAGE_LIMIT,
): Promise<MessageView[]> {
  const collected: MessageView[] = [];
  let afterSeq = 0;
  for (let page = 0; page < MAX_HYDRATION_PAGES; page += 1) {
    const messages = await readMessagePage(fetchImpl, targetId, afterSeq);
    collected.push(...messages);
    if (messages.length < MESSAGE_PAGE_SIZE) {
      break;
    }
    afterSeq = messages[messages.length - 1]?.seq ?? afterSeq;
  }
  return collected.slice(-limit);
}

/**
 * Apply the global `message.created` frame: a frame for another target never
 * enters this thread, and a frame for this target reads exactly the announced
 * row back from the message read model before appending it.
 */
export async function applyMessageCreated(options: {
  data: MessageCreatedFrame;
  threadId: string;
  agent: ChatAgent;
  fetchImpl: typeof fetch;
}): Promise<boolean> {
  const { data, threadId, agent, fetchImpl } = options;
  if (data.target_id !== threadId) {
    return false;
  }
  if (agent.messages.some((message) => message.id === data.message_id)) {
    return false;
  }

  const afterSeq = Math.max(0, data.seq - 1);
  const url = `/api/targets/${encodeURIComponent(threadId)}/messages?after_seq=${afterSeq}&limit=1`;
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`GET message ${data.message_id} failed with ${response.status}`);
  }
  const body = (await response.json()) as { messages?: MessageView[] };
  const messages = body.messages ?? [];
  const view =
    messages.find((candidate) => candidate.id === data.message_id) ?? messages[0];
  if (view === undefined || view.target_id !== threadId) {
    return false;
  }
  return appendThreadMessage(agent, view);
}

/** Narrow one live frame's data to the message.created payload. */
export function readMessageCreatedFrame(
  data: Record<string, unknown>,
): MessageCreatedFrame | null {
  const targetId = data['target_id'];
  const messageId = data['message_id'];
  const seq = data['seq'];
  if (
    typeof targetId !== 'string' ||
    typeof messageId !== 'string' ||
    typeof seq !== 'number'
  ) {
    return null;
  }
  return { target_id: targetId, message_id: messageId, seq };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse one SSE `event:` / `data:` pair; unknown or malformed frames are ignored. */
export function parseLiveEvent(eventType: string, rawData: string): LiveEvent | null {
  if (!(LIVE_EVENT_TYPES as readonly string[]).includes(eventType)) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) {
    return null;
  }
  return { event: eventType as LiveEventType, data: parsed };
}

const WORKSPACE_REFRESH_EVENTS: ReadonlySet<string> = new Set(
  LIVE_EVENT_TYPES.filter((event) => event !== 'message.created'),
);

/**
 * Chat rows are appended to the thread; every other live fact changes a
 * workspace reading (unread, task, status, round, reminder), so the shell
 * re-reads `GET /api/workspace` instead of inventing a local count.
 */
export function shouldRefreshWorkspace(eventType: string): boolean {
  return WORKSPACE_REFRESH_EVENTS.has(eventType);
}
