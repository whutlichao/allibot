import Database from 'better-sqlite3';
import { appendMessageAndDispatch } from '../../dist/messages.js';
import { createInFlightRounds } from '../../dist/rounds.js';
import { createScriptedProvider } from '../../dist/scripted-provider.js';

/**
 * Test-only member-face fixture: an Agent-authored message and the wakes it
 * delivers. M1's human face can only write `human` messages: a real Agent
 * message is produced inside a round, and the wait needed to observe a
 * non-definite Agent-to-Agent wake cannot be produced on demand through the
 * HTTP face. This process is the narrow R2 exception: it calls the same
 * production entry point `appendMessageAndDispatch` the human face uses, with
 * the same scripted double selected through its arguments, and never adds a
 * branch inside production code for a test environment.
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
