import type Database from 'better-sqlite3';
import type { DockerNetwork } from './docker-runtime.js';

/**
 * 容器出网 (#71 / D5 / D14). This module is the one derivation of what one
 * channel's container may reach: the `channel.docker_egress` switch plus the
 * host allowlist named by that channel's `fetch` allow rules.
 *
 * The allowlist is not a second source of truth: the rows are the same
 * `permission_rule` rows the tool layer matches `fetch` calls against, and
 * there is no host-allowlist table and no container-side per-host
 * interception. `deny` / `ask` rows never contribute; an empty `pattern`
 * allows the tool call itself (D14) but adds no host.
 */

/** The egress facts one channel's container creation depends on. */
export interface ChannelEgress {
  /** `channel.docker_egress`: `0` = no network, `1` = may join the network. */
  dockerEgress: 0 | 1;
  /** The explicit hosts of the channel's `fetch` allow rules. */
  hosts: readonly string[];
}

/** A bare hostname: no scheme, path, query, port, glob or regex syntax. */
const EXPLICIT_HOST =
  /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** The explicit host a `fetch` allow pattern names, or null when it names none. */
function explicitHost(pattern: string): string | null {
  return EXPLICIT_HOST.test(pattern) ? pattern : null;
}

/**
 * The host allowlist of one channel: the explicit hosts of its `fetch` allow
 * rules, in rule order. A DM (or a missing channel id) has no channel scope and
 * therefore no allowlist.
 */
export function readChannelEgressHosts(
  db: Database.Database,
  channelId: string | null,
): string[] {
  if (channelId === null) {
    return [];
  }
  const rows = db
    .prepare(
      `SELECT pattern FROM permission_rule
        WHERE scope_kind = 'channel' AND scope_id = ?
          AND tool_name = 'fetch' AND behavior = 'allow'
        ORDER BY created_at, rowid`,
    )
    .all(channelId) as { pattern: string }[];
  const hosts: string[] = [];
  for (const row of rows) {
    const host = explicitHost(row.pattern);
    if (host !== null) {
      hosts.push(host);
    }
  }
  return hosts;
}

/** One channel's switch and host allowlist, read together for the round. */
export function readChannelEgress(
  db: Database.Database,
  channelId: string | null,
): ChannelEgress {
  if (channelId === null) {
    return { dockerEgress: 0, hosts: [] };
  }
  const row = db
    .prepare('SELECT docker_egress FROM channel WHERE id = ?')
    .get(channelId) as { docker_egress: number } | undefined;
  return {
    dockerEgress: row?.docker_egress === 1 ? 1 : 0,
    hosts: readChannelEgressHosts(db, channelId),
  };
}

/**
 * The container network of one channel. No network unless the switch is on and
 * the allowlist names at least one explicit host: an open switch with an empty
 * allowlist is still no network, never "all hosts" (D5).
 */
export function containerNetwork(egress: ChannelEgress): DockerNetwork {
  return egress.dockerEgress === 1 && egress.hosts.length > 0 ? 'default' : 'none';
}
