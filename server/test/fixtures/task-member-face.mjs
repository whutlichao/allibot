import Database from 'better-sqlite3';
import { updateTaskStatusAsMember } from '../../dist/tasks.js';

/**
 * Test-only member-face fixture: the actor-aware status write is production
 * code (#24 / #26 call it when the orchestrator acts for a member), but the
 * HTTP face can never claim a member identity. This process is just another
 * caller of that entry point — it opens the migrated database the running
 * server handed it and reports the ApiFailure as JSON, so a test can assert
 * the review rule without reaching into the module's internals.
 *
 * usage: task-member-face.mjs '{"dataDir": "...", "taskId": "...",
 *                              "memberId": "...", "status": "done"}'
 */
const [, , rawInput] = process.argv;
if (rawInput === undefined) {
  console.error('usage: task-member-face.mjs <json-input>');
  process.exit(2);
}

const input = JSON.parse(rawInput);

const db = new Database(`${input.dataDir}/allibot.db`);
db.pragma('foreign_keys = ON');
try {
  const view = updateTaskStatusAsMember(db, input.taskId, input.memberId, input.status);
  console.log(JSON.stringify({ ok: true, status: view.status }));
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
