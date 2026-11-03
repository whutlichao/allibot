import Database from 'better-sqlite3';
import { claimTask } from '../../dist/tasks.js';

/**
 * Test-only member-face fixture: the claim write is an orchestration act, so
 * the human face can never trigger it and the task-creation trigger can only
 * run once per task. This process calls the same production entry point the
 * creation route calls and reports whether the claim happened — the way a test
 * observes the `claimed_at` at-most-once lock a second time. It is a caller of
 * production code, not a second orchestration path.
 *
 * usage: claim-task.mjs '{"dataDir": "...", "taskId": "..."}'
 */
const [, , rawInput] = process.argv;
if (rawInput === undefined) {
  console.error('usage: claim-task.mjs <json-input>');
  process.exit(2);
}

const input = JSON.parse(rawInput);

const db = new Database(`${input.dataDir}/allibot.db`);
db.pragma('foreign_keys = ON');
try {
  const claim = claimTask(db, input.taskId, process.env);
  console.log(
    JSON.stringify(
      claim === null
        ? { ok: true, claimed: false }
        : { ok: true, claimed: true, memberId: claim.wake.memberId },
    ),
  );
} catch (error) {
  console.log(
    JSON.stringify({
      ok: false,
      status: typeof error?.status === 'number' ? error.status : 500,
      code: typeof error?.code === 'string' ? error.code : 'internal_error',
    }),
  );
} finally {
  db.close();
}
