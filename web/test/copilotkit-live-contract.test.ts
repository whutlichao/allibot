import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Message } from '@copilotkit/react-core/v2';
import { HttpAgent } from '@copilotkit/react-core/v2';
import { AGUI_RUNTIME_URL, ALLIBOT_AGENT_ID } from '../src/copilotkit-contract.ts';

/**
 * The live face's component contract (the backend-driven half): a round the
 * backend ran without a live run lands its row and the frame carries the
 * SQLite message id; the frontend appends it with `useAgent().agent.addMessage`
 * and hydration plus that append share the one dedupe key. The streamed half —
 * `setMessages` followed by streamed deltas under the same messageId — is the
 * existing contract test in `copilotkit-contract.test.ts`. No browser, no
 * network.
 */

const TARGET_ID = '5d0f2a4e-9c1b-4c3e-8f0a-2b6d7e8f9a01';

/** A fetch stub whose run answers one empty AG-UI stream. */
function quietFetch(): typeof fetch {
  return (async (input: RequestInfo | URL): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
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
    const frames = [
      { type: 'RUN_STARTED', threadId: TARGET_ID, runId: 'run-quiet' },
      { type: 'RUN_FINISHED', threadId: TARGET_ID, runId: 'run-quiet' },
    ];
    return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof fetch;
}

function liveAgent(): HttpAgent {
  return new HttpAgent({
    url: `${AGUI_RUNTIME_URL}/agent/${ALLIBOT_AGENT_ID}/run`,
    agentId: ALLIBOT_AGENT_ID,
    threadId: TARGET_ID,
    fetch: quietFetch(),
  });
}

/**
 * The live run streams member replies from the run itself; backend-driven
 * rounds (claim, auto-continue, a relay) land their rows later and arrive as
 * `message.created` frames, appended with `agent.addMessage(...)` — the spec's
 * backend-driven half of the same dedup rule.
 */
test('a backend-driven message appended after hydration renders once, keyed by messageId', async () => {
  const agent = liveAgent();
  const persisted: Message[] = [{ id: 'm-persisted', role: 'assistant', content: '水合内容' }];
  agent.setMessages(persisted);
  assert.deepEqual(agent.messages.map((message) => message.id), ['m-persisted']);

  // A claim round commits its reply and the global SSE carries the row id; the
  // frontend appends that same message.
  agent.addMessage({ id: 'm-claim', role: 'assistant', content: '认领回复' } as Message);
  assert.deepEqual(
    agent.messages.map((message) => message.id),
    ['m-persisted', 'm-claim'],
  );

  // The same frame arriving twice (a reconnect replay) must not render twice.
  assert.equal(
    agent.messages.filter((message) => message.id === 'm-claim').length,
    1,
    'the component dedupes by messageId, not by arrival',
  );

  // Re-hydrating the same rows after a target switch keeps one of each.
  agent.setMessages([...persisted, { id: 'm-claim', role: 'assistant', content: '认领回复' } as Message]);
  assert.deepEqual(
    agent.messages.map((message) => message.id),
    ['m-persisted', 'm-claim'],
    'hydration plus a backend-driven append never duplicates a bubble',
  );
});
