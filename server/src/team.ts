import type { ChannelTeamView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { tFromDb } from './copy.js';
import { liveMemberClause } from './members.js';
import { checkProviderAvailability, PROVIDER_CREDENTIAL_ENV } from './providers.js';

/**
 * Team 模式与队长 (#37 / D3.1 / D3.8): one place decides whether a team
 * channel's leader is usable. The read model, the wake surface and the config
 * write path all read this module, so "the panel says invalid" and "the round
 * starts nobody" cannot name different facts.
 *
 * Leader availability is exactly the D3.8 list: the member row exists, is a
 * live Agent, `enabled=1`, still a channel member, and its model provider is
 * ready (model, remote-data-flow consent, credential). Workspace-backend
 * availability joins this list with the workspace ticket (#41+); until the
 * columns exist there is no target-context backend fact to read.
 *
 * The write path only rejects configuration defects (not a live Agent,
 * disabled, not a member); the "may recover later" availability facts are read
 * here on every read and round, never stored as a second status column.
 */

export interface ChannelTeamRow {
  mode: string;
  team_leader_member_id: string | null;
}

export type LeaderAvailability = { ok: true } | { ok: false; reason: string };

/** The team columns of a channel row, or undefined when the channel is gone. */
export function readChannelTeamRow(
  db: Database.Database,
  channelId: string,
): ChannelTeamRow | undefined {
  return db
    .prepare('SELECT mode, team_leader_member_id FROM channel WHERE id = ?')
    .get(channelId) as ChannelTeamRow | undefined;
}

/**
 * The team reading of a channel. An autonomous channel has no leader and a
 * valid status — there is nothing to be invalid about. A team channel asks the
 * one availability function for the same reason the round side would show.
 */
export function readTeamView(
  db: Database.Database,
  channelId: string,
  row: ChannelTeamRow,
  env: NodeJS.ProcessEnv,
): ChannelTeamView {
  const leaderId = row.team_leader_member_id;
  if (row.mode !== 'team') {
    return { leader_member_id: null, status: 'valid', reason: null };
  }
  if (leaderId === null) {
    // The table CHECK forbids this; the defensive reading is still "invalid"
    // rather than falling back to autonomous.
    return {
      leader_member_id: null,
      status: 'invalid',
      reason: tFromDb(db, 'team.invalid.leaderMissing'),
    };
  }
  const availability = readLeaderAvailability(db, channelId, leaderId, env);
  return {
    leader_member_id: leaderId,
    status: availability.ok ? 'valid' : 'invalid',
    reason: availability.ok ? null : availability.reason,
  };
}

/**
 * Whether this team channel's configured leader can run a round right now.
 * `null` means the channel is not a team channel at all (ordinary M1 wake
 * surface); a team channel with an unusable leader returns `available=false`
 * and the caller must deliver zero wakes — never fall back to the member
 * surface.
 */
export function readTeamWakeState(
  db: Database.Database,
  channelId: string,
  env: NodeJS.ProcessEnv,
): { leaderMemberId: string; available: boolean; reason: string | null } | null {
  const row = readChannelTeamRow(db, channelId);
  if (row === undefined || row.mode !== 'team') {
    return null;
  }
  if (row.team_leader_member_id === null) {
    return {
      leaderMemberId: '',
      available: false,
      reason: tFromDb(db, 'team.invalid.leaderMissing'),
    };
  }
  const availability = readLeaderAvailability(db, channelId, row.team_leader_member_id, env);
  return {
    leaderMemberId: row.team_leader_member_id,
    available: availability.ok,
    reason: availability.ok ? null : availability.reason,
  };
}

/**
 * The leader availability facts, in the D3.8 order: identity, enabled switch,
 * membership, then the model provider. The reason is readable and is the same
 * text the read model carries.
 */
export function readLeaderAvailability(
  db: Database.Database,
  channelId: string,
  leaderId: string,
  env: NodeJS.ProcessEnv,
): LeaderAvailability {
  const member = db
    .prepare(
      `SELECT m.id, m.kind, m.deleted_at, c.enabled, c.model
         FROM member m
         LEFT JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ?`,
    )
    .get(leaderId) as
    | {
        id: string;
        kind: string;
        deleted_at: string | null;
        enabled: number | null;
        model: string | null;
      }
    | undefined;
  if (member === undefined) {
    return { ok: false, reason: tFromDb(db, 'team.invalid.leaderMissing') };
  }
  if (member.kind !== 'agent' || member.enabled === null) {
    return { ok: false, reason: tFromDb(db, 'team.invalid.leaderNotAgent') };
  }
  if (member.deleted_at !== null) {
    return { ok: false, reason: tFromDb(db, 'team.invalid.leaderDeleted') };
  }
  if (member.enabled === 0) {
    return { ok: false, reason: tFromDb(db, 'team.invalid.leaderDisabled') };
  }
  const membership = db
    .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
    .get(channelId, leaderId);
  if (membership === undefined) {
    return { ok: false, reason: tFromDb(db, 'team.invalid.leaderNotMember') };
  }
  const provider = checkProviderAvailability(db, member.model, env);
  if (!provider.ok) {
    switch (provider.reason) {
      case 'model-missing':
        return { ok: false, reason: tFromDb(db, 'team.invalid.modelMissing') };
      case 'consent-missing':
        return { ok: false, reason: tFromDb(db, 'team.invalid.consentMissing') };
      case 'credential-missing':
        return {
          ok: false,
          reason: tFromDb(db, 'team.invalid.credentialMissing', {
            credential_env: PROVIDER_CREDENTIAL_ENV[provider.provider],
          }),
        };
    }
  }
  return { ok: true };
}

/**
 * The write-path validation for `team_leader_member_id` (D3.1). It rejects the
 * configuration defects — not a live Agent, `enabled=0`, not a channel member —
 * because those are the facts the owner can fix in the config; it deliberately
 * does not reject the "may recover later" provider / workspace availability,
 * which the read path reports as invalid-leader.
 */
export function assertAssignableTeamLeader(
  db: Database.Database,
  channelId: string,
  memberId: string,
): void {
  const member = db
    .prepare(
      `SELECT m.id, m.kind, m.deleted_at, c.enabled
         FROM member m
         LEFT JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ? AND ${liveMemberClause('m')}`,
    )
    .get(memberId) as
    | { id: string; kind: string; deleted_at: string | null; enabled: number | null }
    | undefined;
  if (member === undefined) {
    throw ApiFailure.validation(
      'team_leader_member_id must reference a live member',
      { field: 'team_leader_member_id', value: memberId },
    );
  }
  if (member.kind !== 'agent' || member.enabled === null) {
    throw ApiFailure.validation(
      'team_leader_member_id must reference an Agent, not the owner',
      { field: 'team_leader_member_id', value: memberId },
    );
  }
  if (member.enabled === 0) {
    throw ApiFailure.validation(
      'team_leader_member_id must reference an enabled Agent',
      { field: 'team_leader_member_id', value: memberId },
    );
  }
  const membership = db
    .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
    .get(channelId, memberId);
  if (membership === undefined) {
    throw ApiFailure.validation(
      'team_leader_member_id must reference a channel member',
      { field: 'team_leader_member_id', value: memberId },
    );
  }
}

/**
 * Put the new leader into every task target of the channel. The old leader's
 * rows stay in place (the spec keeps them), so a task thread keeps its history;
 * the wake surface still delivers only the current leader.
 */
export function addLeaderToTaskTargets(
  db: Database.Database,
  channelId: string,
  leaderMemberId: string,
): void {
  db.prepare(
    `INSERT OR IGNORE INTO target_member (target_id, member_id)
     SELECT t.target_id, ? FROM task t WHERE t.channel_id = ?`,
  ).run(leaderMemberId, channelId);
}
