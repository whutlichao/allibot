import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  CopilotChat,
  CopilotKitProvider,
  HttpAgent,
  useAgent,
  useCopilotChatConfiguration,
  useCopilotKit,
} from '@copilotkit/react-core/v2';
import type { Message } from '@copilotkit/react-core/v2';
import { CopilotWorkbench } from '../src/CopilotWorkbench.ts';
import {
  AGUI_BASE_PATH,
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
  ALLIBOT_AGENT_ID,
} from '../src/copilotkit-contract.ts';

/**
 * Component-level contract tests for the CopilotKit wiring: the runtime the
 * provider connects to, the properties the chat binds, and manual hydration
 * dedup. They render through React SSR — no browser, no network — and never
 * re-test domain behaviour the backend HTTP seam covers.
 *
 * The hooks that read the chat's own binding are called from a `chatView` slot
 * so they sit inside the chat configuration (a sibling of the chat sees only
 * the provider defaults). `useAgent` is also the hook the spec names for
 * hydration: `useAgent().agent.setMessages(...)`.
 */

const TARGET_ID = '5d0f2a4e-9c1b-4c3e-8f0a-2b6d7e8f9a01';

interface RuntimeStub {
  fetch: typeof fetch;
  calls: string[];
}

/**
 * The runtime stub the provider talks to: `/info` describes the one allibot
 * agent, a run streams the given AG-UI frames. `globalThis.fetch` is replaced
 * around a render so the provider's own connection attempt stays offline.
 */
function stubRuntime(sseBody: string): RuntimeStub {
  const calls: string[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push(`${init?.method ?? 'GET'} ${url}`);
    if (url.endsWith('/info')) {
      return new Response(
        JSON.stringify({
          version: '1.83.0',
          agents: { allibot: { name: 'allibot', description: '' } },
          mode: 'sse',
          threadEndpoints: {},
          suggestions: false,
        }),
        { headers: { 'content-type': 'application/json' } },
      );
    }
    return new Response(sseBody, { headers: { 'content-type': 'text/event-stream' } });
  };
  return { fetch: fetchImpl as typeof fetch, calls };
}

async function withStubbedFetch<T>(stub: RuntimeStub, run: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = stub.fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = original;
  }
}

function sseFrames(threadId: string, runId: string, deltas: string[]): string {
  const frames: Record<string, unknown>[] = [
    { type: 'RUN_STARTED', threadId, runId },
    { type: 'TEXT_MESSAGE_START', messageId: 'm-streamed', role: 'assistant' },
    ...deltas.map((delta) => ({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm-streamed', delta })),
    { type: 'TEXT_MESSAGE_END', messageId: 'm-streamed' },
    { type: 'RUN_FINISHED', threadId, runId },
  ];
  return `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join('')}`;
}

interface ChatRender {
  runtimeUrl?: string;
  transport?: string;
  agentId?: string;
  chatThreadId?: string;
  /** The message ids the chat view was handed for this render. */
  messageIds: string[];
}

/**
 * Mounts the same provider/chat pair `CopilotWorkbench` builds, plus a
 * `chatView` slot that records what the chat bound and hydrates on demand.
 */
function renderChat(options: {
  stub: RuntimeStub;
  agent?: HttpAgent;
  persisted?: Message[];
}): ChatRender {
  const seen: ChatRender = { messageIds: [] };

  function ChatViewSlot(props: { messages?: Message[] }) {
    const { copilotkit } = useCopilotKit();
    const configuration = useCopilotChatConfiguration();
    const { agent } = useAgent({ agentId: ALLIBOT_AGENT_ID });
    seen.runtimeUrl = copilotkit.runtimeUrl;
    seen.transport = copilotkit.runtimeTransport;
    seen.chatThreadId = configuration?.threadId;
    seen.agentId = configuration?.agentId;
    seen.messageIds = (props.messages ?? []).map((message) => message.id);
    if (options.persisted !== undefined) {
      // 手动水合：切换 target 时把已落库消息装进这个 thread 的 agent。
      agent.setMessages(options.persisted as never);
    }
    return null;
  }

  renderToStaticMarkup(
    createElement(
      CopilotKitProvider as never,
      {
        runtimeUrl: AGUI_RUNTIME_URL,
        useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT,
        ...(options.agent === undefined
          ? {}
          : { selfManagedAgents: { [ALLIBOT_AGENT_ID]: options.agent } }),
      } as never,
      createElement(CopilotChat as never, {
        agentId: ALLIBOT_AGENT_ID,
        threadId: TARGET_ID,
        chatView: ChatViewSlot,
      } as never),
    ),
  );
  return seen;
}

test('the wiring constants name the multi-route handler and the one allibot agent', () => {
  assert.equal(AGUI_RUNTIME_URL, '/api/copilotkit');
  assert.equal(AGUI_RUNTIME_URL, AGUI_BASE_PATH);
  assert.equal(AGUI_USE_SINGLE_ENDPOINT, false);
  assert.equal(ALLIBOT_AGENT_ID, 'allibot');
});

test('the workbench renders the chat as the main area', async () => {
  const stub = stubRuntime(sseFrames(TARGET_ID, 'run-workbench', []));

  // The provider's `/info` probe runs in an effect, which SSR does not run;
  // this test pins the rendered shell, and the render below pins the runtime
  // the provider was configured with.
  const html = await withStubbedFetch(stub, async () =>
    renderToStaticMarkup(createElement(CopilotWorkbench, { targetId: TARGET_ID })),
  );

  assert.match(html, /data-testid="copilot-chat"/, 'the main area is a CopilotChat');
});

test('the provider selects the multi-route REST transport', () => {
  const seen = renderChat({ stub: stubRuntime(sseFrames(TARGET_ID, 'run-info', [])) });

  assert.equal(seen.runtimeUrl, '/api/copilotkit', 'the provider points at the handler base path');
  assert.equal(
    seen.transport,
    'rest',
    'useSingleEndpoint={false} selects the multi-route REST transport, not the single-route envelope',
  );
});

test('the chat binds agentId="allibot" and threadId=target_id', () => {
  const seen = renderChat({ stub: stubRuntime(sseFrames(TARGET_ID, 'run-bind', [])) });

  assert.equal(seen.agentId, 'allibot', 'the chat runs the one orchestration agent');
  assert.equal(seen.chatThreadId, TARGET_ID, 'the thread identity is the target id');
});

test('a run goes to the multi-route endpoint with the target id as its thread', async () => {
  const stub = stubRuntime(sseFrames(TARGET_ID, 'run-thread', ['你好']));
  const agent = new HttpAgent({
    url: `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    agentId: ALLIBOT_AGENT_ID,
    threadId: TARGET_ID,
    fetch: stub.fetch,
  });

  await agent.runAgent({ runId: 'run-thread', tools: [], context: [] });

  assert.deepEqual(
    stub.calls,
    [`POST ${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`],
    'the run goes to the multi-route endpoint of the one allibot agent',
  );
  assert.equal(
    `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    '/api/copilotkit/agent/allibot/run',
  );
  assert.equal(agent.threadId, TARGET_ID, 'the agent stays scoped to the target thread');
});

test('a hydrated message and a streamed append with the same messageId render one row', async () => {
  const stub = stubRuntime(sseFrames(TARGET_ID, 'run-dedup', ['流式追加']));
  const agent = new HttpAgent({
    url: `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    agentId: ALLIBOT_AGENT_ID,
    threadId: TARGET_ID,
    fetch: stub.fetch,
  });
  const persisted: Message[] = [{ id: 'm-streamed', role: 'assistant', content: '水合内容' }];

  const hydrated = renderChat({ stub, agent, persisted });
  assert.deepEqual(
    agent.messages.map((message) => [message.id, message.content]),
    [['m-streamed', '水合内容']],
    'setMessages loaded the persisted message into the chat agent',
  );

  await agent.runAgent({ runId: 'run-dedup', tools: [], context: [] });

  assert.deepEqual(
    agent.messages.map((message) => [message.id, message.content]),
    [['m-streamed', '水合内容流式追加']],
    'the stream continued the hydrated message instead of adding a second one',
  );

  const rendered = renderChat({ stub, agent, persisted });
  assert.deepEqual(
    rendered.messageIds,
    ['m-streamed'],
    `hydration plus the streamed append leaves exactly one message (saw: ${hydrated.messageIds.join(',')})`,
  );
});
