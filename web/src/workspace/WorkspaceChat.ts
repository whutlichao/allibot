import {
  CopilotChat,
  CopilotChatView,
  useAgent,
  useCopilotChatConfiguration,
  type CopilotChatProps,
  type CopilotChatViewProps,
} from '@copilotkit/react-core/v2';
import { Fragment, createContext, createElement, useContext, useEffect, useRef } from 'react';
import { ALLIBOT_AGENT_ID } from '../copilotkit-contract.ts';
import {
  LIVE_EVENT_TYPES,
  applyMessageCreated,
  hydrateThread,
  parseLiveEvent,
  readMessageCreatedFrame,
  readRecentMessages,
  type LiveEvent,
} from './message-sync.ts';

/**
 * The shell's one chat area. `agentId` is always the orchestration agent and
 * `threadId` is the selected target id (ADR 0003); there is no per-target
 * agent and no second thread store.
 */

export type LiveEventSink = (event: LiveEvent) => void;

/** The shell provides this once, around the whole layout. */
export const LiveEventContext = createContext<LiveEventSink | null>(null);

/**
 * The chat view slot: hydration / SSE sync sits inside the chat configuration
 * (where `useAgent` resolves the thread's agent), and the default chat view
 * still renders the conversation.
 */
export function WorkspaceChatView(props: CopilotChatViewProps) {
  const sink = useContext(LiveEventContext);
  return createElement(
    Fragment,
    null,
    createElement(ThreadSync, { onEvent: sink ?? undefined }),
    createElement(CopilotChatView, props),
  );
}

interface ThreadSyncProps {
  onEvent?: LiveEventSink;
}

/**
 * Manual hydration (D3.4): when the thread identity moves, read the newest
 * messages from `GET /api/targets/{id}/messages` and replace the agent's
 * messages. Live `message.created` frames for the same target are appended
 * through the same messageId dedupe. Every other live fact is handed to the
 * shell so it can re-read `GET /api/workspace`.
 */
function ThreadSync({ onEvent }: ThreadSyncProps) {
  const { agent } = useAgent({ agentId: ALLIBOT_AGENT_ID });
  const configuration = useCopilotChatConfiguration();
  const threadId = configuration?.threadId ?? null;
  const threadIdRef = useRef<string | null>(threadId);
  threadIdRef.current = threadId;
  const onEventRef = useRef<LiveEventSink | undefined>(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
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
      for (const { type, listener } of listeners) {
        source.removeEventListener(type, listener as EventListener);
      }
      source.close();
    };
  }, [agent]);

  return null;
}

/** The props the shell's main area binds; the target id is the thread id. */
export function workspaceChatProps(targetId: string | null): CopilotChatProps {
  return {
    agentId: ALLIBOT_AGENT_ID,
    ...(targetId === null ? {} : { threadId: targetId }),
    chatView: WorkspaceChatView,
  };
}

export interface WorkspaceChatAreaProps {
  targetId: string | null;
}

/**
 * The main area is always `CopilotChat`; it is rendered inside the shell's
 * `CopilotKitProvider` and `LiveEventContext` (both configured once, around
 * the whole shell), so the chat itself stays the main element.
 */
export function WorkspaceChatArea({ targetId }: WorkspaceChatAreaProps) {
  return createElement(CopilotChat, workspaceChatProps(targetId));
}
