import type { Locale, TaskView } from '@allibot/shared';
import {
  CopilotChat,
  CopilotChatView,
  useAgent,
  useCopilotChatConfiguration,
  type CopilotChatProps,
  type CopilotChatViewProps,
} from '@copilotkit/react-core/v2';
import {
  Fragment,
  createContext,
  createElement,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { ALLIBOT_AGENT_ID } from '../copilotkit-contract.ts';
import { workspaceChatLabels } from './chat-labels.ts';
import {
  LIVE_EVENT_TYPES,
  ROTATE_EVENT,
  INITIAL_STREAM_STATE,
  applyMessageCreated,
  hydrateThread,
  parseLiveEvent,
  readMessageCreatedFrame,
  readRecentMessages,
  readTargetMembersSnapshot,
  reduceStreamState,
  type LiveEvent,
  type StreamState,
  type TargetMembersSnapshot,
} from './message-sync.ts';
import {
  WorkspaceChatContext,
  WorkspaceComposer,
  WorkspaceMessageView,
  WorkspaceSnapshotContext,
} from './WorkspaceMessages.ts';

/**
 * The shell's one chat area. `agentId` is always the orchestration agent and
 * `threadId` is the selected target id (ADR 0003); there is no per-target
 * agent and no second thread store.
 *
 * The v2 rendering slots are bound here: `messageView` is the workbench message
 * list (Markdown / event lines / author metadata) and `input` is the composer
 * with mention completion. `chatView` still hosts hydration and the global
 * subscription inside the chat configuration, where `useAgent` resolves the
 * thread's agent.
 */

export type LiveEventSink = (event: LiveEvent) => void;

/** The shell provides this once, around the whole layout. */
export const LiveEventContext = createContext<LiveEventSink | null>(null);

interface ThreadSyncProps {
  onEvent?: LiveEventSink;
  onSnapshot: (snapshot: TargetMembersSnapshot | null) => void;
}

export function WorkspaceChatView(props: CopilotChatViewProps) {
  const sink = useContext(LiveEventContext);
  const [snapshot, setSnapshot] = useState<TargetMembersSnapshot | null>(null);
  return createElement(
    Fragment,
    null,
    createElement(ThreadSync, {
      ...(sink === null ? {} : { onEvent: sink }),
      onSnapshot: setSnapshot,
    }),
    createElement(
      WorkspaceSnapshotContext.Provider,
      { value: snapshot },
      createElement(CopilotChatView, props),
    ),
  );
}

/**
 * Manual hydration (D3.4): when the thread identity moves, read the newest
 * messages from `GET /api/targets/{id}/messages` and replace the agent's
 * messages. Live `message.created` frames for the same target are appended
 * through the same messageId dedupe. Every other live fact is handed to the
 * shell so it can re-read `GET /api/workspace`.
 *
 * The run's STATE_SNAPSHOT is subscribed to here: its member map is the
 * name / avatar source the message renderer joins by `member_id`.
 *
 * Stream lifecycle (D1.9): the `rotate` frame marks a routine rotation; an
 * `error` without it marks an unreachable backend. Either way the stream is
 * live-only, so a reconnect re-reads the workspace and the current thread
 * (the catch-up the server never replays).
 */
function ThreadSync({ onEvent, onSnapshot }: ThreadSyncProps) {
  const { agent } = useAgent({ agentId: ALLIBOT_AGENT_ID });
  const configuration = useCopilotChatConfiguration();
  const threadId = configuration?.threadId ?? null;
  const threadIdRef = useRef<string | null>(threadId);
  threadIdRef.current = threadId;
  const onEventRef = useRef<LiveEventSink | undefined>(onEvent);
  onEventRef.current = onEvent;
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  const streamStateRef = useRef<StreamState>(INITIAL_STREAM_STATE);

  useEffect(() => {
    const subscription = agent.subscribe({
      onStateSnapshotEvent: ({ event }) => {
        const snapshot = readTargetMembersSnapshot(event.snapshot);
        // A late frame from the thread that was just left must not relabel the
        // new thread's messages.
        if (
          snapshot !== null &&
          (threadIdRef.current === null || snapshot.target_id === threadIdRef.current)
        ) {
          onSnapshotRef.current(snapshot);
        }
      },
    });
    return () => subscription.unsubscribe();
  }, [agent]);

  useEffect(() => {
    onSnapshotRef.current(null);
    if (threadId === null) {
      return;
    }
    let cancelled = false;
    readRecentMessages(fetch, threadId)
      .then((views) => {
        if (!cancelled) {
          hydrateThread(agent, views);
        }
      })
      .catch((error: unknown) => {
        console.error('workspace thread hydration failed', error);
      });
    return () => {
      cancelled = true;
    };
  }, [agent, threadId]);

  useEffect(() => {
    if (typeof EventSource === 'undefined') {
      return;
    }
    const source = new EventSource('/api/events');

    // The first open is the initial connection; every later open follows a
    // rotate or an outage and needs the catch-up read.
    source.onopen = () => {
      const transition = reduceStreamState(streamStateRef.current, 'open');
      streamStateRef.current = transition.state;
      if (!transition.catchUp) {
        return;
      }
      onEventRef.current?.({ event: 'workspace.changed', data: { source: 'reconnect' } });
      const currentThread = threadIdRef.current;
      if (currentThread !== null) {
        void readRecentMessages(fetch, currentThread)
          .then((views) => {
            hydrateThread(agent, views, { replace: false });
          })
          .catch((error: unknown) => {
            console.error('workspace reconnect catch-up failed', error);
          });
      }
    };
    source.onerror = () => {
      streamStateRef.current = reduceStreamState(streamStateRef.current, 'error').state;
    };

    const rotateListener = (): void => {
      streamStateRef.current = reduceStreamState(streamStateRef.current, 'rotate').state;
      onEventRef.current?.({ event: ROTATE_EVENT, data: {} });
    };
    source.addEventListener(ROTATE_EVENT, rotateListener as EventListener);

    const listeners = LIVE_EVENT_TYPES.map((type) => {
      const listener = (event: MessageEvent): void => {
        const live = parseLiveEvent(type, String(event.data));
        if (live === null) {
          return;
        }
        onEventRef.current?.(live);
        if (type !== 'message.created') {
          return;
        }
        const frame = readMessageCreatedFrame(live.data);
        const currentThread = threadIdRef.current;
        if (frame === null || currentThread === null) {
          return;
        }
        void applyMessageCreated({
          data: frame,
          threadId: currentThread,
          agent,
          fetchImpl: fetch,
        }).catch((error: unknown) => {
          console.error('workspace live message append failed', error);
        });
      };
      source.addEventListener(type, listener as EventListener);
      return { type, listener };
    });

    return () => {
      source.removeEventListener(ROTATE_EVENT, rotateListener as EventListener);
      for (const { type, listener } of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
      source.onopen = null;
      source.onerror = null;
    };
  }, [agent]);

  return null;
}

/** The props the shell's main area binds; the target id is the thread id. */
export function workspaceChatProps(
  targetId: string | null,
  locale: Locale = 'zh-CN',
): CopilotChatProps {
  return {
    agentId: ALLIBOT_AGENT_ID,
    ...(targetId === null ? {} : { threadId: targetId }),
    // CopilotKit's own defaults are English; the shell binds the same two
    // labels to the one workspace catalog instead of adding a second i18n path.
    labels: workspaceChatLabels(locale),
    // The library ships a light palette and switches through its own `dark`
    // marker. The chat root is the element carrying `data-copilotkit`, and the
    // marker is appended to that same class list, so the library's own chrome
    // (input surface, tool cards, scrollbars) follows the one dark theme
    // instead of rendering its light defaults on the dark canvas.
    className: 'dark',
    chatView: WorkspaceChatView,
    messageView: WorkspaceMessageView as unknown as CopilotChatViewProps['messageView'],
    input: WorkspaceComposer as unknown as CopilotChatViewProps['input'],
  };
}

export interface WorkspaceChatAreaProps {
  targetId: string | null;
  tasks?: readonly TaskView[];
  locale?: Locale;
  /** The selected DM is archived (its peer Agent was soft-deleted). */
  archivedDm?: boolean;
  onSelectTarget?: (targetId: string) => void;
}

/**
 * The main area is always `CopilotChat`; it is rendered inside the shell's
 * `CopilotKitProvider` and `LiveEventContext` (both configured once, around
 * the whole shell), so the chat itself stays the main element. The chat
 * context carries the readings the message chips and the composer need.
 */
export function WorkspaceChatArea({
  targetId,
  tasks = [],
  locale = 'zh-CN',
  archivedDm = false,
  onSelectTarget,
}: WorkspaceChatAreaProps) {
  return createElement(
    WorkspaceChatContext.Provider,
    { value: { tasks, locale, archivedDm, onSelectTarget } },
    createElement(CopilotChat, workspaceChatProps(targetId, locale)),
  );
}
