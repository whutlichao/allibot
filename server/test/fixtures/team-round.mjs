import Database from 'better-sqlite3';
import { createInFlightRounds, runRound } from '../../dist/rounds.js';
import { createScriptedProvider } from '../../dist/scripted-provider.js';

/**
 * Test-only member-round fixture: a member-face round is production code whose
 * wake may arrive as a TeamAssign sub-round inside the leader's round (#39) or
 * as a task-thread delivery. The HTTP face either wakes the leader (team task
 * threads) or cannot name a member identity; this process is the narrow
 * exception that runs one real `runRound` with the same scripted double, so a
 * structured `transfer_task` action is exercised through the production write
 * path. It never adds a branch to production code and never calls a private
 * function.
 *
 * usage: team-round.mjs '{"dataDir": "...", "targetId": "...",
 *                         "memberId": "...", "fromSeq": 1,
 *                         "reason": "channel-message",
 *                         "behavior": "transfer-task",
 *                         "transferMemberId": "..."}'
 */
const [, , rawInput] = process.argv;
if (rawInput === undefined) {
  console.error('usage: team-round.mjs <json-input>');
  process.exit(2);
}

const input = JSON.parse(rawInput);

const provider = createScriptedProvider({
  behavior: input.behavior,
  delayMs: 0,
  replies: input.replies,
  transferMemberId: input.transferMemberId,
});

const db = new Database(`${input.dataDir}/allibot.db`);
db.pragma('foreign_keys = ON');
try {
  const outcome = await runRound(
    db,
    provider,
    {
      memberId: input.memberId,
      targetId: input.targetId,
      fromSeq: input.fromSeq,
      reason: input.reason ?? 'channel-message',
    },
    createInFlightRounds(),
  );
  console.log(
    JSON.stringify({
      ok: true,
      status: outcome?.status ?? null,
      reason: outcome?.reason ?? null,
    }),
  );
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
