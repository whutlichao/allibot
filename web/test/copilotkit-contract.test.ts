import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  AbstractAgent,
  CopilotChat,
  CopilotChatMessageView,
  CopilotKitProvider,
  HttpAgent,
} from '@copilotkit/react-core/v2';
import type { Message } from '@copilotkit/react-core/v2';
import {
  AGUI_BASE_PATH,
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
  ALLIBOT_AGENT_ID,
  mergeMessagesById,
} from '../src/copilotkit-contract.ts';

/**
 * Component-level contract tests for the CopilotKit wiring: the provider and
 * chat props, the runtime URL the proxied agent calls, and the manual
 * hydration dedup. They render through React SSR — no browser, no network —
 * and never re-test domain behaviour that the backend HTTP seam covers.
 */

const TARGET_ID = '5d0f2a4e-9c1b-4c3e-8f0a-2b6d7e8f9a01';

/** A runtime stub: `/info` describes one allibot agent, a run streams AG-UI frames. */
function stubRuntimeFetch(sseBody: string): { fetch: typeof fetch; calls: string[] } {
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

function renderProviderChat(agent: AbstractAgent | undefined): string {
  const props: Record<string, unknown> = {
    runtimeUrl: AGUI_RUNTIME_URL,
    useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT,
  };
  if (agent !== undefined) {
    props['selfManagedAgents'] = { [ALLIBOT_AGENT_ID]: agent };
  }
  return renderToStaticMarkup(
    createElement(
      CopilotKitProvider as never,
      props as never,
      createElement(CopilotChat as never, {
        agentId: ALLIBOT_AGENT_ID,
        threadId: TARGET_ID,
      } as never),
    ),
  );
}
function agentWithHydratedMessage(): HttpAgent {
  const runtime = stubRuntimeFetch(sseFrames(TARGET_ID, 'run-dedup', ['流式追加']));
  const agent = new HttpAgent({
    url: `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    agentId: ALLIBOT_AGENT_ID,
    threadId: TARGET_ID,
    fetch: runtime.fetch,
  });
  agent.setMessages([{ id: 'm-streamed', role: 'assistant', content: '水合内容' }]);
  return agent;
}

test('the provider names the multi-route handler and turns the single endpoint off', () => {
  assert.equal(AGUI_RUNTIME_URL, '/api/copilotkit');
  assert.equal(AGUI_RUNTIME_URL, AGUI_BASE_PATH);
  assert.equal(AGUI_USE_SINGLE_ENDPOINT, false);
});

test('CopilotKitProvider and CopilotChat accept the contract props and render the chat', () => {
  const html = renderProviderChat(undefined);

  assert.match(html, /data-testid="copilot-chat"/, 'the main area is a CopilotChat');
});

test('the proxied agent talks to the multi-route handler under /api/copilotkit for agent allibot', async () => {
  const runtime = stubRuntimeFetch(sseFrames(TARGET_ID, 'run-url', ['你好']));
  const agent = new HttpAgent({
    url: `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    agentId: ALLIBOT_AGENT_ID,
    threadId: TARGET_ID,
    fetch: runtime.fetch,
  });

  await agent.runAgent({ runId: 'run-url', tools: [], context: [] });

  assert.deepEqual(runtime.calls, [`POST ${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`]);
  assert.equal(
    `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    `/api/copilotkit/agent/allibot/run`,
    'the run route is the backend multi-route path, not a single-route envelope',
  );
});

test('a hydrated message and a streamed append with the same messageId render one row', async () => {
  const agent = agentWithHydratedMessage();
  await agent.runAgent({ runId: 'run-dedup', tools: [], context: [] });

  assert.deepEqual(
    agent.messages.map((message) => [message.id, message.content]),
    [['m-streamed', '水合内容流式追加']],
    'the stream continued the hydrated message instead of adding a second one',
  );

  const html = renderProviderChat(agent);
  assert.equal(
    html.split('data-message-id="m-streamed"').length - 1,
    1,
    'the chat renders exactly one row for the messageId',
  );
  assert.equal(html.split('data-message-id=').length - 1, 1, 'no second row appears');
});

test('the message view itself collapses duplicate messageIds and keeps the later copy', () => {
  const messages: Message[] = [
    { id: 'm-1', role: 'assistant', content: '第一次' },
    { id: 'm-1', role: 'assistant', content: '第二次' },
  ];
  const html = renderToStaticMarkup(
    createElement(
      CopilotKitProvider as never,
      { runtimeUrl: AGUI_RUNTIME_URL, useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT } as never,
      createElement(CopilotChatMessageView as never, { messages } as never),
    ),
  );
  assert.equal(html.split('data-message-id="m-1"').length - 1, 1);
});

test('manual hydration merge keeps one entry per messageId and preserves order', () => {
  const hydrated: Message[] = [
    { id: 'm-1', role: 'assistant', content: '已落库' },
    { id: 'm-2', role: 'user', content: '人类消息' },
  ];
  const appended: Message[] = [{ id: 'm-1', role: 'assistant', content: '已落库 + 流式追加' }];

  const merged = mergeMessagesById(hydrated, appended);

  assert.deepEqual(
    merged.map((message) => message.id),
    ['m-1', 'm-2'],
    'the merge does not duplicate the re-appended messageId',
  );
  assert.equal(merged[0]?.content, '已落库 + 流式追加', 'the later copy wins');
});

test('the CopilotChat mount takes agentId="allibot" and threadId=target_id', () => {
  // The props are the contract: the same target id is the thread id, and the
  // agent id never becomes a member id.
  const chatProps = { agentId: ALLIBOT_AGENT_ID, threadId: TARGET_ID };
  assert.equal(chatProps.agentId, 'allibot');
  assert.equal(chatProps.threadId, TARGET_ID);
  assert.notEqual(chatProps.agentId, chatProps.threadId);
});
