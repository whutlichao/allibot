import Database from 'better-sqlite3';
import { appendMessageAndDispatch } from '../../dist/messages.js';
import { createInFlightRounds } from '../../dist/rounds.js';
import { createScriptedProvider } from '../../dist/scripted-provider.js';

/**
 * Test-only member-face fixture: an Agent-authored message and the wakes it
 * delivers. The human face can only write `human` messages, and no ticket has
 * landed an Agent message that wakes others yet (the relay path is #16's), so
 * this process is just another caller of the production entry point
 * `appendMessageAndDispatch` — the same one the human face uses. It selects
 * the same scripted double through its arguments and never branches inside
 * production code on a test environment.
 *
 * usage: agent-message.mjs '{"dataDir": "...", "targetId": "...",
 *                            "authorMemberId": "...", "body": "...",
 *                            "behavior": "reply|ignore|fail|delay|silent",
 *                            "echoPrompt": true}'
 */
const [, , rawInput] = process.argv;
if (rawInput === undefined) {
  console.error('usage: agent-message.mjs <json-input>');
  process.exit(2);
}

const input = JSON.parse(rawInput);

const provider = createScriptedProvider({
  behavior: input.behavior,
  delayMs: 0,
  echoPrompt: input.echoPrompt === true,
  reportContext: input.reportContext === true,
});

const db = new Database(`${input.dataDir}/allibot.db`);
db.pragma('foreign_keys = ON');
try {
  const result = await appendMessageAndDispatch(
    db,
    {
      targetId: input.targetId,
      kind: 'agent',
      authorMemberId: input.authorMemberId,
      body: input.body,
    },
    { provider, inFlight: createInFlightRounds() },
  );
  console.log(JSON.stringify({ ok: true, ...result }));
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      status: typeof error?.status === 'number' ? error.status : 500,
      code: typeof error?.code === 'string' ? error.code : 'internal_error',
      message: error instanceof Error ? error.message : String(error),
    }),
  );
} finally {
  db.close();
}
