import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';

/**
 * Test-only fixture: a DM target. `POST /api/dms` owns this write now (#22);
 * this fixture stays for tests that seed a DM directly rather than through the
 * process, and it writes exactly the rows that write path owns — one `target`
 * row of kind 'dm' and the two `target_member` rows (owner + the Agent).
 *
 * `systemBody` writes one owner-authored system record (seq 1) into the DM,
 * the way a reminder-due or task-pointer record would: a wake can then point
 * at a message that is neither human nor agent.
 *
 * usage: dm-target.mjs '{"dataDir": "...", "agentId": "...", "systemBody": "..."}'
 */
const [, , rawInput] = process.argv;
if (rawInput === undefined) {
  console.error('usage: dm-target.mjs <json-input>');
  process.exit(2);
}

const input = JSON.parse(rawInput);

const db = new Database(`${input.dataDir}/allibot.db`);
db.pragma('foreign_keys = ON');
try {
  const id = randomUUID();
  const owner = db
    .prepare("SELECT id, display_name, avatar_slot FROM member WHERE kind = 'owner'")
    .get();
  if (owner === undefined) {
    throw new Error('owner row is missing');
  }
  db.transaction(() => {
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'dm')").run(id);
    const insert = db.prepare('INSERT INTO target_member (target_id, member_id) VALUES (?, ?)');
    insert.run(id, owner.id);
    insert.run(id, input.agentId);
    if (typeof input.systemBody === 'string' && input.systemBody.length > 0) {
      db.prepare(
        `INSERT INTO message
           (id, target_id, seq, kind, author_member_id, author_display_name,
            author_avatar_slot, body, created_at, task_ref, task_pointer, client_message_id)
         VALUES (?, ?, 1, 'system', ?, ?, ?, ?, ?, NULL, NULL, NULL)`,
      ).run(
        randomUUID(),
        id,
        owner.id,
        owner.display_name,
        owner.avatar_slot,
        input.systemBody,
        new Date().toISOString(),
      );
    }
  })();
  console.log(JSON.stringify({ ok: true, id }));
} catch (error) {
  console.log(
    JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }),
  );
} finally {
  db.close();
}
