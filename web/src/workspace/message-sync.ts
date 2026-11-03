import type { MessageKind, MessageMentionView, MessageView } from '@allibot/shared';
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
  'team_assignment',
  'plan_update',
] as const;

export type LiveEventType = (typeof LIVE_EVENT_TYPES)[number];

/** The stream's own lifecycle frame; it is not a business event. */
export const ROTATE_EVENT = 'rotate' as const;

export interface LiveEvent {
  event: LiveEventType | typeof ROTATE_EVENT;
  data: Record<string, unknown>;
}

/** The frame a stored message publishes; `target_id` is the ownership fact. */
export interface MessageCreatedFrame {
  target_id: string;
  message_id: string;
  seq: number;
}

/**
 * The author and rendering facts a stored row carries onto the chat message.
 * The message id is the SQLite message id, so a renderer can map every
 * messageId back to the exact author the row recorded — including after a
 * rename or soft delete.
 */
export interface AllibotMessageMetadata {
  allibot_kind: MessageKind;
  author_member_id: string;
  author_display_name: string;
  author_avatar_slot: number;
  task_ref: string | null;
  task_pointer: string | null;
  mentions: MessageMentionView[];
}

/** A row maps to one chat message; the id is the SQLite message id. */
export function toChatMessage(view: MessageView): Message {
  const metadata: AllibotMessageMetadata = {
    allibot_kind: view.kind,
    author_member_id: view.author_member_id,
    author_display_name: view.author_display_name,
    author_avatar_slot: view.author_avatar_slot,
    task_ref: view.task_ref,
    task_pointer: view.task_pointer,
    mentions: view.mentions,
  };
  switch (view.kind) {
    case 'human':
      return {
        id: view.id,
        role: 'user',
        content: view.body,
        name: view.author_display_name,
        metadata,
      };
    case 'agent':
      return {
        id: view.id,
        role: 'assistant',
        content: view.body,
        name: view.author_display_name,
        metadata,
      };
    case 'system':
      return { id: view.id, role: 'system', content: view.body, metadata };
  }
}

/** The typed metadata a rendered chat message carries, or null for a streamed one. */
export function readMessageMetadata(message: Message): AllibotMessageMetadata | null {
  const value = message.metadata;
  if (value === undefined) {
    return null;
  }
  const kind = value['allibot_kind'];
  const authorId = value['author_member_id'];
  const authorName = value['author_display_name'];
  const avatar = value['author_avatar_slot'];
  if (
    (kind !== 'human' && kind !== 'agent' && kind !== 'system') ||
    typeof authorId !== 'string' ||
    typeof authorName !== 'string' ||
    typeof avatar !== 'number'
  ) {
    return null;
  }
  const mentions = Array.isArray(value['mentions'])
    ? (value['mentions'] as MessageMentionView[])
    : [];
  return {
    allibot_kind: kind,
    author_member_id: authorId,
    author_display_name: authorName,
    author_avatar_slot: avatar,
    task_ref: typeof value['task_ref'] === 'string' ? value['task_ref'] : null,
    task_pointer: typeof value['task_pointer'] === 'string' ? value['task_pointer'] : null,
    mentions,
  };
}

/**
 * One member entry of the run's STATE_SNAPSHOT. The snapshot is the run's own
 * declaration of the target's members; the message row remains the durable
 * author fact, so the renderer prefers row metadata and falls back to this map
 * for a message the run streamed before the row was re-read.
 */
export interface SnapshotMember {
  member_id: string;
  display_name: string;
  avatar_slot: number;
}

export interface TargetMembersSnapshot {
  target_id: string;
  members: SnapshotMember[];
}

/** Narrow one STATE_SNAPSHOT payload; a malformed snapshot is ignored. */
export function readTargetMembersSnapshot(value: unknown): TargetMembersSnapshot | null {
  if (!isRecord(value)) {
    return null;
  }
  const targetId = value['target_id'];
  const members = value['members'];
  if (typeof targetId !== 'string' || !Array.isArray(members)) {
    return null;
  }
  const parsed: SnapshotMember[] = [];
  for (const entry of members) {
    if (!isRecord(entry)) {
      continue;
    }
    const memberId = entry['member_id'];
    const displayName = entry['display_name'];
    const avatar = entry['avatar_slot'];
    if (
      typeof memberId === 'string' &&
      typeof displayName === 'string' &&
      typeof avatar === 'number'
    ) {
      parsed.push({ member_id: memberId, display_name: displayName, avatar_slot: avatar });
    }
  }
  return { target_id: targetId, members: parsed };
}

/**
 * The stream lifecycle state: D1.9 uses the `rotate` frame to tell a routine
 * rotation from an unreachable backend, and a reconnect (routine or not)
 * leaves the stream live-only, so the frontend owes a catch-up read.
 */
export type StreamPhase = 'connecting' | 'open' | 'rotating' | 'unreachable';

export interface StreamState {
  phase: StreamPhase;
  connectedOnce: boolean;
  needsCatchUp: boolean;
}

export const INITIAL_STREAM_STATE: StreamState = {
  phase: 'connecting',
  connectedOnce: false,
  needsCatchUp: false,
};

export interface StreamTransition {
  state: StreamState;
  /** True when the caller must re-read the workspace and the current thread. */
  catchUp: boolean;
}

export function reduceStreamState(
  state: StreamState,
  event: 'open' | 'rotate' | 'error',
): StreamTransition {
  switch (event) {
    case 'rotate':
      // The server closed the connection on purpose; the same EventSource
      // reconnects, and the close is not an outage.
      return {
        state: { phase: 'rotating', connectedOnce: state.connectedOnce, needsCatchUp: true },
        catchUp: false,
      };
    case 'error':
      // A routine rotation also closes the socket; an `error` that follows the
      // rotate frame is still the routine path, not an outage.
      return {
        state: {
          phase: state.phase === 'rotating' ? 'rotating' : 'unreachable',
          connectedOnce: state.connectedOnce,
          needsCatchUp: true,
        },
        catchUp: false,
      };
    case 'open': {
      const catchUp = state.connectedOnce || state.needsCatchUp || state.phase === 'unreachable';
      return {
        state: { phase: 'open', connectedOnce: true, needsCatchUp: false },
        catchUp,
      };
    }
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
  const row = toChatMessage(view);
  const existing = agent.messages.find((message) => message.id === view.id);
  if (existing !== undefined) {
    // A streamed reply may already be on screen without the row's author
    // metadata (the run's TEXT_MESSAGE_START is not the durable row). The
    // stored row is the last copy that wins, so fill the metadata without
    // adding a second bubble.
    if (existing.metadata === undefined && row.metadata !== undefined) {
      agent.setMessages(
        agent.messages.map((message) => {
          if (message.id !== view.id) {
            return message;
          }
          const existingName = 'name' in message ? message.name : undefined;
          return {
            ...message,
            name: existingName ?? ('name' in row ? row.name : undefined),
            metadata: row.metadata,
          } as Message;
        }),
      );
      return true;
    }
    return false;
  }
  const ids = new Set(agent.messages.map((message) => message.id));
  if (view.client_message_id !== null && ids.has(view.client_message_id)) {
    return false;
  }
  agent.addMessage(row);
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
  const existing = agent.messages.find((message) => message.id === data.message_id);
  if (existing !== undefined && existing.metadata !== undefined) {
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
  LIVE_EVENT_TYPES.filter(
    (event) =>
      event !== 'message.created' &&
      event !== 'team_assignment' &&
      event !== 'plan_update',
  ),
);

/**
 * Chat rows are appended to the thread; every other live fact changes a
 * workspace reading (unread, task, status, round, reminder), so the shell
 * re-reads `GET /api/workspace` instead of inventing a local count.
 */
export function shouldRefreshWorkspace(eventType: string): boolean {
  return WORKSPACE_REFRESH_EVENTS.has(eventType);
}
