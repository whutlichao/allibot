import type { McpServerEntry, RemoteConsentScopeView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ApiFailure } from './api-error.js';
import { tFromDb } from './copy.js';
import {
  canonicalMcpJson,
  mcpFilePath,
  parseEntries,
  readMcpFile,
  sameEntries,
  writeMcpFileAtomically,
} from './mcp-file.js';
import { agentHomeRoot } from './workspace-root.js';

/**
 * `export-mcp` (#47 / D6.2 / ADR-0008).
 *
 * The historical `mcp_server` table is only a migration source. This command is
 * the one explicit bridge to the Agent-home `mcp.json`:
 * - default dry-run; it writes only when `--apply` and `--yes` are both given;
 * - it backs up an existing file and writes a manifest before replacing it;
 * - a same-name entry with a different shape refuses the whole export (no
 *   partial write);
 * - it never deletes `mcp_server` rows and never confirms a remote server on
 *   the owner's behalf — only pre-existing consent rows are recorded.
 *
 * Startup never calls this module.
 */

interface LegacyRow {
  id: string;
  scope_kind: 'channel' | 'agent';
  scope_id: string;
  name: string;
  transport: 'stdio' | 'http' | 'sse';
  config: string;
  enabled: number;
}

interface ExportPlan {
  agentId: string;
  home: string;
  filePath: string;
  existingExists: boolean;
  existingText: string | null;
  merged: McpServerEntry[];
  exported: McpServerEntry[];
  unchanged: boolean;
  consents: RemoteConsentScopeView[];
}

export interface ExportMcpOptions {
  apply: boolean;
  yes: boolean;
}

export interface ExportMcpOutcome {
  exitCode: number;
  lines: string[];
  /** Test-only observation; the CLI only prints. */
  written: string[];
}

export function runMcpExport(
  db: Database.Database,
  env: NodeJS.ProcessEnv,
  options: ExportMcpOptions,
): ExportMcpOutcome {
  const lines: string[] = [];
  if (options.apply !== options.yes) {
    return {
      exitCode: 2,
      lines: [tFromDb(db, 'mcp.export.applyYes')],
      written: [],
    };
  }
  const rows = db
    .prepare(
      `SELECT id, scope_kind, scope_id, name, transport, config, enabled
         FROM mcp_server
        WHERE scope_kind = 'agent'
        ORDER BY scope_id, name`,
    )
    .all() as LegacyRow[];
  if (rows.length === 0) {
    return {
      exitCode: 0,
      lines: [tFromDb(db, 'mcp.export.noRows')],
      written: [],
    };
  }

  const byAgent = new Map<string, LegacyRow[]>();
  for (const row of rows) {
    const list = byAgent.get(row.scope_id) ?? [];
    list.push(row);
    byAgent.set(row.scope_id, list);
  }

  const problems: string[] = [];
  const plans: ExportPlan[] = [];
  for (const [agentId, agentRows] of byAgent) {
    const plan = planOneAgent(db, agentId, agentRows, env);
    if (typeof plan === 'string') {
      problems.push(plan);
      continue;
    }
    plans.push(plan);
  }
  if (problems.length > 0) {
    return {
      exitCode: 1,
      lines: [
        tFromDb(db, 'mcp.export.rejectedHeader'),
        ...problems.map((problem) => `  - ${problem}`),
      ],
      written: [],
    };
  }

  if (!options.apply || !options.yes) {
    for (const plan of plans) {
      lines.push(
        tFromDb(db, 'mcp.export.dryRunLine', {
          agent_id: plan.agentId,
          count: plan.exported.length,
          status: plan.unchanged
            ? tFromDb(db, 'mcp.export.latestSuffix')
            : ` → ${plan.filePath}`,
        }),
      );
      for (const entry of plan.exported) {
        lines.push(`  - ${entry.name} (${entry.transport}${entry.enabled ? '' : ', disabled'})`);
      }
    }
    lines.push(tFromDb(db, 'mcp.export.dryRunEnd'));
    return { exitCode: 0, lines, written: [] };
  }

  const written: string[] = [];
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  for (const plan of plans) {
    if (plan.unchanged) {
      lines.push(tFromDb(db, 'mcp.export.unchanged', { agent_id: plan.agentId }));
      continue;
    }
    mkdirSync(plan.home, { recursive: true, mode: 0o700 });
    let backupPath: string | null = null;
    if (plan.existingExists && plan.existingText !== null) {
      backupPath = path.join(plan.home, `mcp.json.backup-${stamp}`);
      copyFileSync(plan.filePath, backupPath);
    }
    writeMcpFileAtomically(plan.filePath, canonicalMcpJson(plan.merged));
    const manifestPath = path.join(plan.home, `mcp-export-manifest-${stamp}.json`);
    writeFileSync(
      manifestPath,
      `${JSON.stringify(
        {
          agent_id: plan.agentId,
          generated_at: new Date().toISOString(),
          file: plan.filePath,
          backup_path: backupPath,
          servers: plan.exported,
          consents: plan.consents,
        },
        null,
        2,
      )}\n`,
      { encoding: 'utf8', mode: 0o600 },
    );
    written.push(plan.filePath);
    lines.push(
      tFromDb(db, 'mcp.export.written', {
        agent_id: plan.agentId,
        path: plan.filePath,
        backup:
          backupPath === null
            ? ''
            : tFromDb(db, 'mcp.export.backupSuffix', { path: backupPath }),
      }),
    );
  }
  lines.push(
    tFromDb(db, 'mcp.export.done', {
      rows: rows.length,
      consents: countConsents(plans),
    }),
  );
  return { exitCode: 0, lines, written };
}

function planOneAgent(
  db: Database.Database,
  agentId: string,
  rows: LegacyRow[],
  env: NodeJS.ProcessEnv,
): ExportPlan | string {
  const member = db
    .prepare("SELECT kind FROM member WHERE id = ? AND kind = 'agent'")
    .get(agentId) as { kind: string } | undefined;
  if (member === undefined) {
    return tFromDb(db, 'mcp.export.missingAgent', { agent_id: agentId });
  }

  const exported: McpServerEntry[] = [];
  for (const row of rows) {
    const parsed = legacyEntry(db, row);
    if (typeof parsed === 'string') {
      return `agent ${agentId} / ${row.name}：${parsed}`;
    }
    exported.push(parsed);
  }

  const home = agentHomeRoot(agentId, env);
  const filePath = mcpFilePath(agentId, env);
  const current = readMcpFile(filePath, db);
  if (current.diagnostic !== null) {
    return tFromDb(db, 'mcp.export.invalidExisting', {
      agent_id: agentId,
      diagnostic: current.diagnostic,
    });
  }

  const merged = new Map<string, McpServerEntry>();
  for (const entry of current.entries) {
    merged.set(entry.name, entry);
  }
  for (const entry of exported) {
    const existing = merged.get(entry.name);
    if (existing !== undefined) {
      if (JSON.stringify(existing) !== JSON.stringify(entry)) {
        return tFromDb(db, 'mcp.export.shapeConflict', {
          agent_id: agentId,
          name: entry.name,
        });
      }
      continue;
    }
    merged.set(entry.name, entry);
  }
  const mergedEntries = [...merged.values()].sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  const consents: RemoteConsentScopeView[] = [];
  for (const entry of exported) {
    if (entry.transport === 'stdio') {
      continue;
    }
    const consent = db
      .prepare(
        `SELECT scope_kind, scope_id, confirmed_at FROM remote_consent_scope
          WHERE scope_kind = 'mcp' AND scope_id = ?`,
      )
      .get(entry.name) as RemoteConsentScopeView | undefined;
    if (consent !== undefined) {
      consents.push(consent);
    }
  }
  return {
    agentId,
    home,
    filePath,
    existingExists: existsSync(filePath),
    existingText: existsSync(filePath) ? readFileSync(filePath, 'utf8') : null,
    merged: mergedEntries,
    exported,
    unchanged: current.diagnostic === null && current.present && sameEntries(current.entries, mergedEntries),
    consents,
  };
}

/** One historical row → one file entry; unknown config fields are refused. */
function legacyEntry(db: Database.Database, row: LegacyRow): McpServerEntry | string {
  let config: unknown;
  try {
    config = JSON.parse(row.config) as unknown;
  } catch {
    return tFromDb(db, 'mcp.export.configInvalidJson');
  }
  if (typeof config !== 'object' || config === null || Array.isArray(config)) {
    return tFromDb(db, 'mcp.export.configNotObject');
  }
  const record = config as Record<string, unknown>;
  const allowed =
    row.transport === 'stdio'
      ? new Set(['command', 'args', 'env_names'])
      : new Set(['url', 'env_names']);
  const unsupported = Object.keys(record).find((key) => !allowed.has(key));
  if (unsupported !== undefined) {
    return tFromDb(db, 'mcp.export.configUnsupported', { field: unsupported });
  }
  const candidate: Record<string, unknown> = {
    name: row.name,
    transport: row.transport,
    enabled: row.enabled === 1,
  };
  if (row.transport === 'stdio') {
    candidate['command'] = record['command'];
    candidate['args'] = record['args'];
  } else {
    candidate['url'] = record['url'];
  }
  if (record['env_names'] !== undefined) {
    candidate['env_names'] = record['env_names'];
  }
  try {
    return parseEntries([candidate], db)[0]!;
  } catch (error) {
    if (error instanceof ApiFailure) {
      return error.message;
    }
    return error instanceof Error ? error.message : String(error);
  }
}

function countConsents(plans: readonly ExportPlan[]): number {
  return plans.reduce((total, plan) => total + plan.consents.length, 0);
}
