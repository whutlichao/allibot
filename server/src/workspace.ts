import type { WorkspaceView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { countPendingApprovals } from './approvals.js';
import { listChannels } from './channels.js';
import { listDms } from './dms.js';
import { listAgents, readOwner } from './members.js';
import type { InFlightRounds } from './rounds.js';
import { getSettings } from './settings.js';
import { readStatusPoints } from './status.js';
import { listTasks } from './tasks.js';
import { readWorkspaceUnread } from './unread.js';

/**
 * 工作台 (Workspace) 的唯一读模型（D1.8 / ADR 0002）。它是纯组合：每个面板
 * 读到的行都来自同一批既有的只读函数，这里不写第二条查询形状——
 *
 * - `agents` 是本机 Agent 名单（`listAgents`），不按频道过滤；
 * - `channels` 与 `GET /api/channels` 同源（含已归档、不含已删除）；
 * - `dms` 与 `GET /api/dms` 同源（`peer.deleted_at` 就是已归档私信的标记）；
 * - `tasks` 与 `GET /api/tasks` 同源（已删除频道的任务不出现）；
 * - 未读由 `readWorkspaceUnread` 给出：channel + dm 进 `unread_total`，task
 *   单列在任务载荷的 `unread_count`；
 * - `settings` 与 `GET /api/settings` 是同一个函数；
 * - `status_points` 走 #23 为工作台准备的批量读数，键是 Agent 成员 id。
 *
 * 读数只读：这些函数都只 SELECT，不落消息、不唤醒、不消耗预算。
 */
export function readWorkspace(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): WorkspaceView {
  const owner = readOwner(db);
  const agents = listAgents(db, { includeDeleted: false, env, inFlight });
  const unread = readWorkspaceUnread(db, owner.id);
  return {
    owner,
    agents,
    channels: listChannels(db, env),
    dms: listDms(db),
    tasks: listTasks(db, {}),
    unread_total: unread.unread_total,
    unread_by_target: unread.unread_by_target,
    settings: getSettings(db),
    status_points: readStatusPoints(db, agents, env, inFlight),
    pending_approvals: countPendingApprovals(db),
  };
}
