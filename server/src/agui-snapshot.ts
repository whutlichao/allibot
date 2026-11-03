import type { TargetMemberView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { listTargetMembers } from './target-members.js';

/**
 * One member's metadata as the run snapshot publishes it. The renderer maps a
 * streamed `messageId` to its author through this list; the persisted message
 * row keeps the same metadata as the durable source.
 */
export interface TargetMemberMetadata {
  member_id: string;
  display_name: string;
  avatar_slot: number;
}

/** The STATE_SNAPSHOT payload: the member metadata of the run's target. */
export interface TargetMembersSnapshot {
  target_id: string;
  members: TargetMemberMetadata[];
}

export function readTargetMembersSnapshot(
  db: Database.Database,
  targetId: string,
): TargetMembersSnapshot {
  return {
    target_id: targetId,
    members: listTargetMembers(db, targetId).map(toMetadata),
  };
}

function toMetadata(member: TargetMemberView): TargetMemberMetadata {
  return {
    member_id: member.id,
    display_name: member.display_name,
    avatar_slot: member.avatar_slot,
  };
}
