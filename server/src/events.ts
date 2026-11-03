/**
 * 订阅 (Subscription): the process-local publish/subscribe hub behind the one
 * global live stream. It carries events only — it never reads the database and
 * never replays: a connection sees what is published after it subscribed.
 *
 * The event names are declared once, here, so the later tickets that add
 * `member.status`, `task.changed`, `unread.changed`, `reminder.due` and
 * `workspace.changed` frames do not invent a second spelling. `rotate` is not
 * a business event: it is the stream's own lifecycle frame, sent before the
 * server closes a connection so the frontend can tell a routine rotation from
 * an unreachable backend.
 */
export const SSE_EVENT_TYPES = [
  'message.created',
  'member.status',
  'round.outcome',
  'task.changed',
  'unread.changed',
  'reminder.due',
  'workspace.changed',
] as const;

export type SseEventType = (typeof SSE_EVENT_TYPES)[number];

/** The one lifecycle frame; `data` is an empty object so every frame is shaped alike. */
export const SSE_ROTATE_EVENT = 'rotate';

export interface SseEvent {
  readonly event: SseEventType;
  readonly data: Record<string, unknown>;
}

/** One wire frame: `event: <type>\ndata: <json>\n\n`, and never an `id:` line. */
export function formatSseFrame(event: { event: string; data: Record<string, unknown> }): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`;
}

/**
 * The process-local hub. Publishing is synchronous and side-effect free with
 * respect to the database: callers publish after their transaction commits, so
 * a rolled-back write never reaches a subscriber.
 */
export interface EventHub {
  publish(event: SseEvent): void;
  /** Subscribe; the returned function is the unsubscribe. */
  subscribe(listener: (event: SseEvent) => void): () => void;
}

export function createEventHub(): EventHub {
  const listeners = new Set<(event: SseEvent) => void>();
  return {
    publish: (event) => {
      for (const listener of [...listeners]) {
        listener(event);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/**
 * The one hub of this process. The stream is process-wide and carries no
 * configuration, so the write paths publish through this instance directly
 * rather than threading a hub through every signature; a test observes it
 * through the process's own `/api/events` connection.
 */
export const eventHub: EventHub = createEventHub();

/** The frame a stored message produces; `target_id` is the ownership fact. */
export function publishMessageCreated(message: {
  targetId: string;
  id: string;
  seq: number;
}): void {
  eventHub.publish({
    event: 'message.created',
    data: { target_id: message.targetId, message_id: message.id, seq: message.seq },
  });
}

/** The frame one round outcome row produces. */
export function publishRoundOutcome(outcome: {
  target_id: string;
  member_id: string;
  status: string;
}): void {
  eventHub.publish({
    event: 'round.outcome',
    data: {
      target_id: outcome.target_id,
      member_id: outcome.member_id,
      status: outcome.status,
    },
  });
}

/** How long one connection lives before the server rotates it (30 minutes). */
export const DEFAULT_SSE_LIFETIME_MS = 30 * 60 * 1000;

