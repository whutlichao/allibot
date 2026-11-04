import type { ChannelTeamView, WorkspaceFailureReason } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';
import { tFromDb } from './copy.js';
import { liveMemberClause } from './members.js';
import { checkProviderAvailability, PROVIDER_CREDENTIAL_ENV } from './providers.js';
import { readRoundWorkspaceFailure } from './workspace-root.js';

/**
 * Team 模式与队长 (#37 / D3.1 / D3.8): one place decides whether a team
 * channel's leader is usable. The read model, the wake surface and the config
 * write path all read this module, so "the panel says invalid" and "the round
 * starts nobody" cannot name different facts.
 *
 * Leader availability is exactly the D3.8 list: the member row exists, is a
 * live Agent, `enabled=1`, still a channel member, its model provider is ready
 * (model, remote-data-flow consent, credential), and the target context's
 * workspace backend is usable. The last fact is read through the same
 * target-context resolution a round uses, so a Docker-down / missing-root
 * leader cannot read `valid` while the round would fail.
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
 * membership, model provider, then the target context's workspace. `targetId`
 * is the channel target for a channel reading and the task target for a task
 * reading; a task follows its channel's workspace binding (D5.7).
 */
export function readLeaderAvailability(
  db: Database.Database,
  channelId: string,
  leaderId: string,
  env: NodeJS.ProcessEnv,
  targetId: string = channelId,
): LeaderAvailability {
  return leaderAvailability(db, readAvailabilityFact(db, channelId, leaderId, env, targetId));
}

/**
 * The TeamAssign target's availability (D3.4 step 1): the target must be a live
 * Agent member of the channel / task channel, its model provider must be ready,
 * and the target context's workspace must be usable. It is the same D3.8 fact
 * set as the leader check, with member-facing copy so a failed assignment never
 * says "the leader is disabled".
 */
export function readTeamMemberAvailability(
  db: Database.Database,
  channelId: string,
  memberId: string,
  env: NodeJS.ProcessEnv,
  targetId: string = channelId,
): LeaderAvailability {
  return memberAvailability(db, readAvailabilityFact(db, channelId, memberId, env, targetId));
}

type AvailabilityFact =
  | { kind: 'ok' }
  | {
      kind:
        | 'missing'
        | 'not-agent'
        | 'deleted'
        | 'disabled'
        | 'not-member'
        | 'model-missing'
        | 'consent-missing';
    }
  | { kind: 'credential-missing'; credentialEnv: string }
  | { kind: 'workspace-unavailable'; reason: WorkspaceFailureReason };

/**
 * The shared D3.8 fact read. The leader and the TeamAssign target ask the same
 * questions; only the readable copy differs, so each caller maps the fact to its
 * own literal catalog keys (the string catalog's usage scan needs the literals
 * at the call site).
 */
function readAvailabilityFact(
  db: Database.Database,
  channelId: string,
  memberId: string,
  env: NodeJS.ProcessEnv,
  targetId: string,
): AvailabilityFact {
  const member = db
    .prepare(
      `SELECT m.id, m.kind, m.deleted_at, c.enabled, c.model
         FROM member m
         LEFT JOIN agent_config c ON c.member_id = m.id
        WHERE m.id = ?`,
    )
    .get(memberId) as
    | {
        id: string;
        kind: string;
        deleted_at: string | null;
        enabled: number | null;
        model: string | null;
      }
    | undefined;
  if (member === undefined) {
    return { kind: 'missing' };
  }
  if (member.kind !== 'agent' || member.enabled === null) {
    return { kind: 'not-agent' };
  }
  if (member.deleted_at !== null) {
    return { kind: 'deleted' };
  }
  if (member.enabled === 0) {
    return { kind: 'disabled' };
  }
  const membership = db
    .prepare('SELECT 1 FROM target_member WHERE target_id = ? AND member_id = ?')
    .get(channelId, memberId);
  if (membership === undefined) {
    return { kind: 'not-member' };
  }
  const provider = checkProviderAvailability(db, member.model, env);
  if (!provider.ok) {
    switch (provider.reason) {
      case 'model-missing':
        return { kind: 'model-missing' };
      case 'consent-missing':
        return { kind: 'consent-missing' };
      case 'credential-missing':
        return {
          kind: 'credential-missing',
          credentialEnv: PROVIDER_CREDENTIAL_ENV[provider.provider],
        };
    }
  }
  // 目标上下文的工作区可用性 (D3.8 / D5.7): a configured local root that
  // disappeared or any Docker unavailability is a leader-invalid fact, not a
  // failed leader round. A rootless local target stays valid (the round simply
  // has no file tools), which is exactly the round's own decision.
  const workspace = readRoundWorkspaceFailure(db, memberId, targetId);
  if (workspace !== null) {
    return { kind: 'workspace-unavailable', reason: workspace.reason };
  }
  return { kind: 'ok' };
}

function leaderAvailability(
  db: Database.Database,
  fact: AvailabilityFact,
): LeaderAvailability {
  switch (fact.kind) {
    case 'ok':
      return { ok: true };
    case 'missing':
      return { ok: false, reason: tFromDb(db, 'team.invalid.leaderMissing') };
    case 'not-agent':
      return { ok: false, reason: tFromDb(db, 'team.invalid.leaderNotAgent') };
    case 'deleted':
      return { ok: false, reason: tFromDb(db, 'team.invalid.leaderDeleted') };
    case 'disabled':
      return { ok: false, reason: tFromDb(db, 'team.invalid.leaderDisabled') };
    case 'not-member':
      return { ok: false, reason: tFromDb(db, 'team.invalid.leaderNotMember') };
    case 'model-missing':
      return { ok: false, reason: tFromDb(db, 'team.invalid.modelMissing') };
    case 'consent-missing':
      return { ok: false, reason: tFromDb(db, 'team.invalid.consentMissing') };
    case 'credential-missing':
      return {
        ok: false,
        reason: tFromDb(db, 'team.invalid.credentialMissing', {
          credential_env: fact.credentialEnv,
        }),
      };
    case 'workspace-unavailable':
      switch (fact.reason) {
        case 'workspace-root-missing':
          return { ok: false, reason: tFromDb(db, 'team.invalid.workspaceRootMissing') };
        case 'docker-unavailable':
          return { ok: false, reason: tFromDb(db, 'team.invalid.dockerUnavailable') };
        case 'docker-image-missing':
          return { ok: false, reason: tFromDb(db, 'team.invalid.dockerImageMissing') };
        case 'docker-consent-missing':
          return { ok: false, reason: tFromDb(db, 'team.invalid.dockerConsentMissing') };
      }
  }
}

function memberAvailability(
  db: Database.Database,
  fact: AvailabilityFact,
): LeaderAvailability {
  switch (fact.kind) {
    case 'ok':
      return { ok: true };
    case 'missing':
      return { ok: false, reason: tFromDb(db, 'team.member.missing') };
    case 'not-agent':
      return { ok: false, reason: tFromDb(db, 'team.member.notAgent') };
    case 'deleted':
      return { ok: false, reason: tFromDb(db, 'team.member.deleted') };
    case 'disabled':
      return { ok: false, reason: tFromDb(db, 'team.member.disabled') };
    case 'not-member':
      return { ok: false, reason: tFromDb(db, 'team.member.notMember') };
    case 'model-missing':
      return { ok: false, reason: tFromDb(db, 'team.member.modelMissing') };
    case 'consent-missing':
      return { ok: false, reason: tFromDb(db, 'team.member.consentMissing') };
    case 'credential-missing':
      return {
        ok: false,
        reason: tFromDb(db, 'team.member.credentialMissing', {
          credential_env: fact.credentialEnv,
        }),
      };
    case 'workspace-unavailable':
      switch (fact.reason) {
        case 'workspace-root-missing':
          return { ok: false, reason: tFromDb(db, 'team.member.workspaceRootMissing') };
        case 'docker-unavailable':
          return { ok: false, reason: tFromDb(db, 'team.member.dockerUnavailable') };
        case 'docker-image-missing':
          return { ok: false, reason: tFromDb(db, 'team.member.dockerImageMissing') };
        case 'docker-consent-missing':
          return { ok: false, reason: tFromDb(db, 'team.member.dockerConsentMissing') };
      }
  }
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
/**
 * The target-context team reading (#38): a channel-type target or a task-type
 * target whose owning channel is in team mode. `null` means the ordinary
 * autonomous surface — there is no leader to deliver to and no team record to
 * write. A task target resolves its mode through its channel (D3.1), so the
 * task row never stores a second topology.
 */
export interface TeamTargetState {
  targetId: string;
  targetKind: 'channel' | 'task';
  channelId: string;
  /** The task id on a task target; null on a channel target. */
  taskId: string | null;
  /** The configured leader, or `''` when the row cannot carry one. */
  leaderMemberId: string;
  available: boolean;
  /** The same readable reason the channel read model serves (D3.8). */
  reason: string | null;
}

export function readTeamTargetState(
  db: Database.Database,
  targetId: string,
  env: NodeJS.ProcessEnv,
): TeamTargetState | null {
  const target = db.prepare('SELECT kind FROM target WHERE id = ?').get(targetId) as
    | { kind: string }
    | undefined;
  if (target === undefined) {
    return null;
  }
  if (target.kind === 'channel') {
    const row = readChannelTeamRow(db, targetId);
    if (row === undefined || row.mode !== 'team') {
      return null;
    }
    return buildTeamTargetState(db, targetId, 'channel', targetId, null, row.team_leader_member_id, env);
  }
  if (target.kind === 'task') {
    const task = db
      .prepare(
        `SELECT t.id, t.channel_id, c.mode, c.team_leader_member_id
           FROM task t
           JOIN channel c ON c.id = t.channel_id
          WHERE t.target_id = ?`,
      )
      .get(targetId) as
      | { id: string; channel_id: string; mode: string; team_leader_member_id: string | null }
      | undefined;
    if (task === undefined || task.mode !== 'team') {
      return null;
    }
    return buildTeamTargetState(
      db,
      targetId,
      'task',
      task.channel_id,
      task.id,
      task.team_leader_member_id,
      env,
    );
  }
  return null;
}

function buildTeamTargetState(
  db: Database.Database,
  targetId: string,
  targetKind: 'channel' | 'task',
  channelId: string,
  taskId: string | null,
  leaderId: string | null,
  env: NodeJS.ProcessEnv,
): TeamTargetState {
  if (leaderId === null) {
    // The channel CHECK forbids this; the defensive reading is still invalid
    // rather than a fallback to autonomous.
    return {
      targetId,
      targetKind,
      channelId,
      taskId,
      leaderMemberId: '',
      available: false,
      reason: tFromDb(db, 'team.invalid.leaderMissing'),
    };
  }
  const availability = readLeaderAvailability(db, channelId, leaderId, env, targetId);
  return {
    targetId,
    targetKind,
    channelId,
    taskId,
    leaderMemberId: leaderId,
    available: availability.ok,
    reason: availability.ok ? null : availability.reason,
  };
}
