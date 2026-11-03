import type { TargetMemberView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { assertChannelReadable, assertChannelWritable, type ChannelRow } from './channels.js';
import { liveMemberClause } from './members.js';

interface MemberRow {
  id: string;
  kind: 'owner' | 'agent';
  display_name: string;
  avatar_slot: number;
}

const MEMBER_SELECT = `
SELECT m.id, m.kind, m.display_name, m.avatar_slot
FROM target_member tm
JOIN member m ON m.id = tm.member_id
WHERE tm.target_id = ? AND ${liveMemberClause('m')}`;

export function listChannelMembers(db: Database.Database, channelId: string): TargetMemberView[] {
  assertChannelReadable(db, channelId);
  return readTargetMembers(db, channelId);
}

/**
 * `GET /api/targets/{id}/members` serves both completion and the member panel.
 * A channel-type target whose channel is deleted reads as not found, matching
 * every other channel-layer endpoint.
 */
export function listTargetMembers(db: Database.Database, targetId: string): TargetMemberView[] {
  const target = db.prepare('SELECT kind FROM target WHERE id = ?').get(targetId) as
    | { kind: string }
    | undefined;
  if (target === undefined) {
    throw ApiFailure.notFound(`target not found: ${targetId}`);
  }
  if (target.kind === 'channel') {
    assertChannelReadable(db, targetId);
  }
  return readTargetMembers(db, targetId);
}

/**
 * The explicit channel-join action: it only writes a target_member row and
 * returns whether the row is new. It deliberately writes no system event
 * message, and it is refused on an archived channel like every other channel
 * config write.
 */
export function joinChannel(
  db: Database.Database,
  channelId: string,
  body: unknown,
): { joined: boolean } {
  const memberId = parseJoinInput(body);
  const join = db.transaction((): boolean => {
    const channel: ChannelRow = assertChannelReadable(db, channelId);
    assertChannelWritable(channel);

    const member = db
      .prepare(`SELECT id, kind FROM member WHERE id = ? AND ${liveMemberClause()}`)
      .get(memberId) as { id: string; kind: string } | undefined;
    if (member === undefined) {
      throw ApiFailure.notFound(`member not found: ${memberId}`);
    }
    if (member.kind !== 'agent') {
      throw ApiFailure.validation('only Agents can join a channel; the owner joins at creation', {
        field: 'member_id',
        value: memberId,
      });
    }

    const result = db
      .prepare('INSERT OR IGNORE INTO target_member (target_id, member_id) VALUES (?, ?)')
      .run(channelId, memberId);
    return result.changes === 1;
  });
  return { joined: join() };
}

function readTargetMembers(db: Database.Database, targetId: string): TargetMemberView[] {
  const rows = db
    .prepare(`${MEMBER_SELECT} ORDER BY tm.rowid`)
    .all(targetId) as MemberRow[];
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    display_name: row.display_name,
    avatar_slot: row.avatar_slot,
  }));
}

function parseJoinInput(body: unknown): string {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== 'member_id') {
      throw ApiFailure.validation(`unknown field: ${key}`);
    }
  }
  const memberId = record['member_id'];
  if (typeof memberId !== 'string' || memberId.trim().length === 0) {
    throw ApiFailure.validation('member_id must be a non-empty string');
  }
  return memberId.trim();
}
