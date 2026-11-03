import type { StatusPointView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { checkProviderAvailability } from './providers.js';
import type { InFlightRounds } from './rounds.js';

/**
 * 状态点 (Status Point) 的唯一计算点（D1.12 / R1 词条 26）。
 *
 * 四态来自三种后端事实，彼此不派生：
 * - `offline`（未启用）由可用性推导。三种可用性判断收在
 *   `checkProviderAvailability` 里，真实 provider 适配器拒绝一轮时读的是同一个
 *   函数，因此「状态点说缺什么」与「轮次 reason 说缺什么」不会各说各话。
 * - `working` 是进程内的 in-flight 事实：重启后不存在，也从不落库。
 * - `error` 读该成员最近一条非 `merged` 的轮次结果是否为 `failed`。轮次结果
 *   append-only，所以重启后仍是同一条事实。`budget-exhausted` 与 `silent` 都
 *   不是错误，自然读到空闲。
 * - 其余为 `online`。
 *
 * 判定顺序：先看可用性（跑不了的成员是「未启用」，即使库里留着一条失败），
 * 再看进行中的轮次（此刻正在回复比上一条结果更新），最后看库里的轮次结果。
 * 状态点只读后端事实：浏览器连接、SSE 订阅与浏览器存活从不参与。
 */

/** The identity facts the status point needs; an AgentView satisfies it. */
export interface StatusAgent {
  id: string;
  model: string | null;
  /** `agent_config.enabled`: 0 means the owner switched the Agent off. */
  enabled: number;
}

export function readStatusPoint(
  db: Database.Database,
  agent: StatusAgent,
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): StatusPointView {
  // The enabled switch is the first fact: a switched-off Agent is offline even
  // if its model, consent and credential are all in place, and it never runs a
  // round (the wake surface and the claim surface read the same column).
  if (agent.enabled === 0) {
    return { status: 'offline', offline_reason: 'disabled' };
  }
  const availability = checkProviderAvailability(db, agent.model, env);
  if (!availability.ok) {
    return { status: 'offline', offline_reason: availability.reason };
  }
  if (inFlight.get(agent.id) !== undefined) {
    return { status: 'working', offline_reason: null };
  }
  if (latestOutcomeFailed(db, agent.id)) {
    return { status: 'error', offline_reason: null };
  }
  return { status: 'online', offline_reason: null };
}

/**
 * The status points of several Agents, keyed by member id. This is the read the
 * workspace snapshot (#27) shares with `GET /api/agents/{id}`: one function,
 * one set of backend facts.
 */
export function readStatusPoints(
  db: Database.Database,
  agents: readonly StatusAgent[],
  env: NodeJS.ProcessEnv,
  inFlight: InFlightRounds,
): Record<string, StatusPointView> {
  const points: Record<string, StatusPointView> = {};
  for (const agent of agents) {
    points[agent.id] = readStatusPoint(db, agent, env, inFlight);
  }
  return points;
}

/**
 * The failure fact the error state reads: the member's latest non-merged round
 * outcome. `merged` rows fold a repeated wake into another round, so they are
 * not a round of their own and never decide the status.
 *
 * Recency is `rowid` order because `round_outcome.id` is an opaque random UUID,
 * not a time-sortable value; ordering by it would answer a random row instead
 * of the latest one.
 */
function latestOutcomeFailed(db: Database.Database, memberId: string): boolean {
  const row = db
    .prepare(
      `SELECT status FROM round_outcome
        WHERE member_id = ? AND status <> 'merged'
        ORDER BY rowid DESC
        LIMIT 1`,
    )
    .get(memberId) as { status: string } | undefined;
  return row?.status === 'failed';
}
