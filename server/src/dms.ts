import { randomUUID } from 'node:crypto';
import type { DmView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { publishWorkspaceChanged } from './events.js';
import { OWNER_ID_SUBQUERY } from './sql.js';

/**
 * 私信 (DM): owner 与一个 Agent 之间的两方 target (`kind='dm'`).
 *
 * Creation is the one explicit action; there is no join / leave endpoint, and
 * membership is exactly the two rows this write path lands (the owner plus its
 * Agent). The "two people" rule is therefore a write-path guarantee rather than
 * a property of the tables (GLOSSARY 私信 / target 成员).
 *
 * A soft-deleted Agent takes the DM to 已归档私信: the target, its messages and
 * its target_member rows stay, `GET /api/dms` marks it through the existing
 * `peer.deleted_at` field, and the message write path refuses new sends. No new
 * table, endpoint or migration is involved.
 */

interface DmRow {
  id: string;
  peer_id: string;
  peer_display_name: string;
  peer_avatar_slot: number;
  peer_deleted_at: string | null;
}

/**
 * One row per DM: the target and its Agent member. The write path always lands
 * exactly one Agent row per DM, so the join cannot multiply rows; the ordering
 * follows the target rows' insertion order (`target` has no created_at).
 */
const DM_SELECT = `
SELECT t.id AS id,
       m.id AS peer_id,
       m.display_name AS peer_display_name,
       m.avatar_slot AS peer_avatar_slot,
       m.deleted_at AS peer_deleted_at
FROM target t
JOIN target_member tm ON tm.target_id = t.id
JOIN member m ON m.id = tm.member_id
WHERE t.kind = 'dm' AND m.kind = 'agent'
ORDER BY t.rowid`;

export function listDms(db: Database.Database): DmView[] {
  const rows = db.prepare(DM_SELECT).all() as DmRow[];
  return rows.map((row) => ({
    id: row.id,
    peer: {
      id: row.peer_id,
      display_name: row.peer_display_name,
      avatar_slot: row.peer_avatar_slot,
      deleted_at: row.peer_deleted_at,
    },
  }));
}

/**
 * Create the DM for one Agent, or reuse the one it already has: one Agent maps
 * to at most one DM for its whole life, so a repeat (and a repeat after the
 * Agent was soft-deleted) answers with the same id and writes nothing.
 *
 * A creation writes the target row and both `target_member` rows in one
 * transaction: an interrupted create leaves no half-membership behind.
 */
export function createDm(db: Database.Database, body: unknown): { id: string; created: boolean } {
  const agentId = parseCreateInput(body);
  const create = db.transaction((): { id: string; created: boolean } => {
    const member = db
      .prepare('SELECT id, kind, deleted_at FROM member WHERE id = ?')
      .get(agentId) as { id: string; kind: string; deleted_at: string | null } | undefined;
    if (member === undefined || member.kind !== 'agent') {
      throw ApiFailure.notFound(`agent not found: ${agentId}`);
    }
    const existing = findDmForAgent(db, agentId);
    if (existing !== null) {
      return { id: existing, created: false };
    }
    // An archived DM is reachable through the reuse above; a soft-deleted
    // Agent that never had one is not a peer to open a new DM with.
    if (member.deleted_at !== null) {
      throw ApiFailure.notFound(`agent not found: ${agentId}`);
    }

    const id = randomUUID();
    db.prepare("INSERT INTO target (id, kind) VALUES (?, 'dm')").run(id);
    db.prepare(
      `INSERT INTO target_member (target_id, member_id) VALUES (?, ${OWNER_ID_SUBQUERY})`,
    ).run(id);
    db.prepare('INSERT INTO target_member (target_id, member_id) VALUES (?, ?)').run(id, agentId);
    return { id, created: true };
  });
  const result = create();
  // A reused DM wrote nothing, so it announces nothing.
  if (result.created) {
    publishWorkspaceChanged({ source: 'dm' });
  }
  return result;
}

function findDmForAgent(db: Database.Database, agentId: string): string | null {
  const row = db
    .prepare(
      `SELECT t.id AS id
         FROM target t
         JOIN target_member tm ON tm.target_id = t.id
        WHERE t.kind = 'dm' AND tm.member_id = ?`,
    )
    .get(agentId) as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The one DM write guard, used by the message write path: an archived DM (its
 * peer Agent was soft-deleted) accepts no new message, from the human face or
 * from any other wake-producing write. History stays readable through the
 * ordinary message read; only the write entry is closed (已归档私信: 只读,
 * composer 与发送入口一并禁用).
 */
export function assertDmWritable(db: Database.Database, targetId: string): void {
  const peer = db
    .prepare(
      `SELECT m.deleted_at AS deleted_at
         FROM target_member tm
         JOIN member m ON m.id = tm.member_id
        WHERE tm.target_id = ? AND m.kind = 'agent'`,
    )
    .get(targetId) as { deleted_at: string | null } | undefined;
  if (peer !== undefined && peer.deleted_at !== null) {
    throw ApiFailure.validation('dm is archived: the peer Agent was soft-deleted', {
      target_id: targetId,
    });
  }
}

/** The creation body names the Agent and nothing else. */
function parseCreateInput(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'agent_id') {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const agentId = record['agent_id'];
  if (typeof agentId !== 'string' || agentId.trim().length === 0) {
    throw ApiFailure.validation('agent_id must be a non-empty string', { field: 'agent_id' });
  }
  return agentId.trim();
}
