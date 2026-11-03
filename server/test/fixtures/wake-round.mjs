import Database from 'better-sqlite3';
import { createInFlightRounds, dispatchWakes } from '../../dist/rounds.js';
import { createScriptedProvider } from '../../dist/scripted-provider.js';

/**
 * Test-only member-face fixture: deliver an explicit wake. The claim (#24),
 * auto-continue (#24) and human-message paths are reachable through the HTTP
 * face; this fixture covers the remaining signals a test must pin down (a
 * `mention` / `channel-message` wake pointed at a chosen seq, and the DM round
 * that no human message woke). The server's in-flight registry is process
 * state, so the exact combination cannot be constructed from an external
 * request. It calls the same orchestration entry point the HTTP paths call —
 * `dispatchWakes` — and is therefore a caller of production code, not a second
 * orchestration path.
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
  reportContext: input.reportContext === true,
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
