import Database from 'better-sqlite3';
import { createInFlightRounds, dispatchWakes } from '../../dist/rounds.js';
import { createScriptedProvider } from '../../dist/scripted-provider.js';

/**
 * Test-only member-face fixture: deliver wakes that no landed ticket produces
 * yet. #12 delivers `channel-message` / `mention` wakes from a message write;
 * the claim (#24) and auto-continue (#24) producers are follow-up tickets, so
 * this process calls the same orchestration entry point they will call —
 * `dispatchWakes` — with the signal those producers will pass. It is a caller
 * of production code, not a second orchestration path.
 *
 * usage: wake-round.mjs '{"dataDir": "...", "targetId": "...",
 *                         "memberId": "...", "fromSeq": 1,
 *                         "reason": "claim|continue|mention|channel-message",
 *                         "behavior": "reply|ignore|silent|fail|delay",
 *                         "promptFile": "..." }'
 */
const [, , rawInput] = process.argv;
if (rawInput === undefined) {
  console.error('usage: wake-round.mjs <json-input>');
  process.exit(2);
}

const input = JSON.parse(rawInput);

const provider = createScriptedProvider({
  behavior: input.behavior,
  delayMs: 0,
  echoPrompt: input.echoPrompt === true,
});

const db = new Database(`${input.dataDir}/allibot.db`);
db.pragma('foreign_keys = ON');
try {
  await dispatchWakes(
    db,
    provider,
    [
      {
        memberId: input.memberId,
        targetId: input.targetId,
        fromSeq: input.fromSeq,
        reason: input.reason,
      },
    ],
    createInFlightRounds(),
  );
  console.log(JSON.stringify({ ok: true }));
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
