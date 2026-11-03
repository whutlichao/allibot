import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { createInFlightRounds, dispatchWakes, type Wake } from '../dist/rounds.js';
import type { RoundProvider } from '../dist/agent-seam.js';
import { makeTempDir, removeTempDir, runCli } from './support.ts';

/**
 * The budget-suppression branch has one mixed state the process-level HTTP
 * seam cannot construct: a wake folded into another member's in-flight round
 * *and* a delivering wake on an exhausted budget. The in-flight registry is
 * process state, and M1 has no human-face agent-message write, so the state
 * cannot be produced by one server process through its own writes. This test
 * calls the production `dispatchWakes` with that state and reads the rows it
 * committed; the setup rows are seeded directly so the test observes only the
 * branch under assertion.
 */

function seed(db: Database.Database, targetId: string, memberIds: readonly string[]): void {
  db.prepare("INSERT INTO target (id, kind) VALUES (?, 'channel')").run(targetId);
  const insertMember = db.prepare(
    `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
     VALUES (?, 'agent', ?, 0, NULL, ?)`,
  );
  for (const memberId of memberIds) {
    insertMember.run(memberId, memberId, new Date().toISOString());
  }
  db.prepare(
    `INSERT INTO target_budget (target_id, epoch_seq, used, limit_value)
     VALUES (?, 0, 3, 3)`,
  ).run(targetId);
}

test('an exhausted budget suppresses only the delivering wake, never a folded one', async () => {
  const dataDir = await makeTempDir('allibot-budget-fold-');
  try {
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const db = new Database(path.join(dataDir, 'allibot.db'));
    db.pragma('foreign_keys = ON');
    try {
      const targetId = randomUUID();
      const foldedMember = randomUUID();
      const deliveringMember = randomUUID();
      seed(db, targetId, [foldedMember, deliveringMember]);

      const inFlight = createInFlightRounds();
      inFlight.set(foldedMember, { targetId, repeats: [], deferred: [] });

      let calls = 0;
      const provider: RoundProvider = {
        deferred: false,
        name: 'stub:not-called',
        async runRound() {
          calls += 1;
          return { verdict: 'ignored', replies: [] };
        },
      };

      const foldedWake: Wake = {
        memberId: foldedMember,
        targetId,
        fromSeq: 1,
        reason: 'channel-message',
      };
      const deliveringWake: Wake = {
        memberId: deliveringMember,
        targetId,
        fromSeq: 1,
        reason: 'channel-message',
      };

      await dispatchWakes(db, provider, [foldedWake, deliveringWake], inFlight, {
        messageKind: 'agent',
      });

      const rows = db
        .prepare(
          `SELECT member_id, status FROM round_outcome WHERE target_id = ? ORDER BY rowid`,
        )
        .all(targetId) as { member_id: string; status: string }[];

      assert.deepEqual(rows, [{ member_id: deliveringMember, status: 'budget-exhausted' }]);
      assert.equal(calls, 0, 'no round starts on either side of an exhausted budget');
      assert.ok(
        !rows.some((row) => row.member_id === foldedMember),
        'the folded wake leaves only the running round\'s merged row, never budget-exhausted',
      );
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(dataDir);
  }
});
