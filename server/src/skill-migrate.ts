import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { createDataDirBackup } from './backup.js';
import { tFromDb } from './copy.js';
import {
  agentSkillsRoot,
  isInsideOrEqual,
  workspaceHomeRoot,
} from './workspace-root.js';
import {
  readSkillTreeStats,
  recordSkillRow,
  SKILL_NAME_PATTERN,
} from './skills.js';

/**
 * `migrate-skills` (#48 / D6.3 / D6.4).
 *
 * The old four-layer layout put member skills under a project root:
 * `<workspace_root>/.allibot/skills/<member_id>/<name>/`. That project layer is
 * never a runtime source now, so this explicit command copies the **member**
 * partitions into the member home and records Agent-level rows. The old bytes
 * are left in place (copy, never move), channel-id partitions are reported but
 * never migrated, and no row or bytes are deleted. The command defaults to a
 * dry run; writing needs both `--apply` and `--yes`, and startup never calls it.
 *
 * The project layer itself is not registered as an assembly source: only the
 * copied member-home tree participates after the human runs this command.
 */

export interface SkillMigrationOptions {
  apply: boolean;
  yes: boolean;
}

export interface SkillMigrationOutcome {
  exitCode: number;
  lines: string[];
}

type EntryStatus = 'copy' | 'row' | 'skip' | 'refuse';

interface MigrationEntry {
  memberId: string;
  name: string;
  source: string;
  target: string;
  contentHash: string;
  fileCount: number;
  bytes: number;
  status: EntryStatus;
  /** True when the target already has the same bytes (only a row may be needed). */
  targetPresent: boolean;
  reason: string;
}

interface ChannelPartition {
  channelId: string;
  path: string;
  skills: string[];
}

interface UnknownPartition {
  partition: string;
  path: string;
  reason: string;
}

interface ChannelRow {
  id: string;
  workspace_root: string;
}

const PARTITION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function runSkillMigration(
  db: Database.Database,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  options: SkillMigrationOptions,
): SkillMigrationOutcome {
  if (options.apply !== options.yes) {
    return {
      exitCode: 2,
      lines: [tFromDb(db, 'skill.migrate.applyYes')],
    };
  }

  const plan = buildPlan(db, env);
  const lines = renderPlan(plan, dataDir, env, db);

  if (plan.entries.some((entry) => entry.status === 'refuse')) {
    return {
      exitCode: 1,
      lines: [
        ...lines,
        tFromDb(db, 'skill.migrate.refused'),
      ],
    };
  }

  if (!options.apply || !options.yes) {
    lines.push(tFromDb(db, 'skill.migrate.dryRunEnd'));
    return { exitCode: 0, lines };
  }

  const actionable = plan.entries.filter(
    (entry) => entry.status === 'copy' || entry.status === 'row',
  );
  if (actionable.length === 0) {
    lines.push(tFromDb(db, 'skill.migrate.nothingToDo'));
    lines.push(
      tFromDb(db, 'skill.migrate.processedZero', {
        skipped: plan.entries.filter((entry) => entry.status === 'skip').length,
      }),
    );
    return { exitCode: 0, lines };
  }

  const startedAt = new Date().toISOString();
  const backupPath = createDataDirBackup(dataDir, startedAt, 'skills');
  const stamp = startedAt.replaceAll(':', '-').replaceAll('.', '-');
  // D1.4: the data directory carries only the database, attachments, the
  // schema ledger and disposable mcp-hosts/. The manifest is migration evidence
  // and sits beside the whole-directory backup, so no later backup inherits it.
  const manifestPath = path.join(
    path.dirname(dataDir),
    `skill-migration-${stamp}.json`,
  );
  writeFileSync(
    manifestPath,
    `${JSON.stringify(
      {
        migration: 'migrate-skills',
        generated_at: startedAt,
        data_dir: dataDir,
        global_layer_root: workspaceHomeRoot(env),
        backup_path: backupPath,
        entries: plan.entries.map((entry) => ({
          member_id: entry.memberId,
          name: entry.name,
          source: entry.source,
          target: entry.target,
          content_hash: entry.contentHash,
          file_count: entry.fileCount,
          bytes: entry.bytes,
          status: entry.status,
          reason: entry.reason,
        })),
        channel_level: plan.channelPartitions.map((partition) => ({
          channel_id: partition.channelId,
          path: partition.path,
          skills: partition.skills,
          notice: tFromDb(db, 'skill.migrate.channelDeprecated'),
        })),
        unknown_partitions: plan.unknownPartitions,
      },
      null,
      2,
    )}\n`,
    { encoding: 'utf8', mode: 0o600 },
  );

  let copied = 0;
  let rowsOnly = 0;
  const removable: string[] = [];
  for (const entry of actionable) {
    if (entry.status === 'copy') {
      const parent = path.dirname(entry.target);
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      cpSync(entry.source, entry.target, { recursive: true, dereference: true });
      copied += 1;
      removable.push(entry.source);
    } else {
      rowsOnly += 1;
    }
    recordSkillRow(db, entry.memberId, entry.name, entry.contentHash, 'directory');
  }

  lines.push(tFromDb(db, 'skill.migrate.done'));
  lines.push(tFromDb(db, 'skill.migrate.backupLine', { path: backupPath }));
  lines.push(tFromDb(db, 'skill.migrate.manifestLine', { path: manifestPath }));
  lines.push(
    tFromDb(db, 'skill.migrate.processed', {
      processed: actionable.length,
      copied,
      rows_only: rowsOnly,
      skipped: plan.entries.filter((entry) => entry.status === 'skip').length,
    }),
  );
  for (const entry of actionable) {
    lines.push(
      tFromDb(db, 'skill.migrate.entryLine', {
        action:
          entry.status === 'copy'
            ? tFromDb(db, 'skill.migrate.copy')
            : tFromDb(db, 'skill.migrate.rowOnly'),
        source: entry.source,
        target: entry.target,
        files: entry.fileCount,
        bytes: entry.bytes,
        hash: entry.contentHash,
      }),
    );
  }
  if (removable.length > 0) {
    lines.push(tFromDb(db, 'skill.migrate.removable'));
    for (const source of removable) {
      lines.push(`  ${source}`);
    }
  }
  return { exitCode: 0, lines };
}

interface MigrationPlan {
  entries: MigrationEntry[];
  channelPartitions: ChannelPartition[];
  unknownPartitions: UnknownPartition[];
}

function buildPlan(db: Database.Database, env: NodeJS.ProcessEnv): MigrationPlan {
  const channels = db
    .prepare("SELECT id, workspace_root FROM channel WHERE workspace_root IS NOT NULL AND workspace_root <> ''")
    .all() as ChannelRow[];
  const seenRoots = new Set<string>();
  const entries = new Map<string, MigrationEntry>();
  const channelPartitions = new Map<string, ChannelPartition>();
  const unknownPartitions: UnknownPartition[] = [];

  for (const channel of channels) {
    let root: string;
    try {
      root = realpathSync(channel.workspace_root);
      if (!statSync(root).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    if (seenRoots.has(root)) {
      continue;
    }
    seenRoots.add(root);
    const skillsRoot = path.join(root, '.allibot', 'skills');
    if (!existsSync(skillsRoot)) {
      continue;
    }
    let resolvedSkillsRoot: string;
    try {
      resolvedSkillsRoot = realpathSync(skillsRoot);
      if (!isInsideOrEqual(resolvedSkillsRoot, root) || !statSync(resolvedSkillsRoot).isDirectory()) {
        continue;
      }
    } catch {
      continue;
    }
    let partitions: string[];
    try {
      partitions = readdirSync(resolvedSkillsRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    } catch {
      continue;
    }
    for (const partition of partitions) {
      const partitionPath = path.join(resolvedSkillsRoot, partition);
      const channelRow = db.prepare('SELECT id FROM channel WHERE id = ?').get(partition) as
        | { id: string }
        | undefined;
      if (channelRow !== undefined) {
        channelPartitions.set(partition, {
          channelId: partition,
          path: partitionPath,
          skills: listSkillNames(partitionPath),
        });
        continue;
      }
      const member = db
        .prepare("SELECT id FROM member WHERE id = ? AND kind = 'agent' AND deleted_at IS NULL")
        .get(partition) as { id: string } | undefined;
      if (member === undefined) {
        unknownPartitions.push({
          partition,
          path: partitionPath,
          reason: PARTITION_PATTERN.test(partition)
            ? tFromDb(db, 'skill.migrate.unknownPartitionMember')
            : tFromDb(db, 'skill.migrate.unsafePartition'),
        });
        continue;
      }
      for (const name of listSkillNames(partitionPath)) {
        addEntry(
          db,
          entries,
          member.id,
          name,
          path.join(partitionPath, name),
          agentSkillsRoot(member.id, env),
        );
      }
    }
  }

  return {
    entries: [...entries.values()].sort((left, right) =>
      left.memberId === right.memberId
        ? left.name < right.name
          ? -1
          : left.name > right.name
            ? 1
            : 0
        : left.memberId < right.memberId
          ? -1
          : 1,
    ),
    channelPartitions: [...channelPartitions.values()].sort((left, right) =>
      left.channelId < right.channelId ? -1 : left.channelId > right.channelId ? 1 : 0,
    ),
    unknownPartitions,
  };
}

function addEntry(
  db: Database.Database,
  entries: Map<string, MigrationEntry>,
  memberId: string,
  name: string,
  source: string,
  memberSkillsRoot: string,
): void {
  const key = `${memberId}\0${name}`;
  const existing = entries.get(key);
  const target = path.join(memberSkillsRoot, name);
  if (!SKILL_NAME_PATTERN.test(name)) {
    entries.set(key, {
      memberId,
      name,
      source,
      target,
      contentHash: '',
      fileCount: 0,
      bytes: 0,
      status: 'refuse',
      targetPresent: false,
      reason: tFromDb(db, 'skill.migrate.unsafeName'),
    });
    return;
  }
  let stats;
  try {
    stats = readSkillTreeStats(source);
  } catch (error) {
    entries.set(key, {
      memberId,
      name,
      source,
      target,
      contentHash: '',
      fileCount: 0,
      bytes: 0,
      status: 'refuse',
      targetPresent: false,
      reason: error instanceof Error ? error.message : String(error),
    });
    return;
  }
  if (existing !== undefined) {
    if (existing.contentHash !== stats.contentHash) {
      existing.status = 'refuse';
      existing.reason = tFromDb(db, 'skill.migrate.multiRootConflict');
    }
    return;
  }

  const row = db
    .prepare('SELECT content_hash FROM skill WHERE member_id = ? AND name = ?')
    .get(memberId, name) as { content_hash: string } | undefined;
  let targetPresent = false;
  let targetProblem: string | null = null;
  if (existsSync(target)) {
    try {
      const current = readSkillTreeStats(target);
      if (current.contentHash === stats.contentHash) {
        targetPresent = true;
      } else {
        targetProblem = tFromDb(db, 'skill.migrate.targetDiffers');
      }
    } catch (error) {
      targetProblem = tFromDb(db, 'skill.migrate.targetUnreadable', {
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (row !== undefined && row.content_hash !== stats.contentHash) {
    targetProblem = tFromDb(db, 'skill.migrate.rowHashDiffers');
  }
  if (targetProblem !== null) {
    entries.set(key, {
      memberId,
      name,
      source,
      target,
      contentHash: stats.contentHash,
      fileCount: stats.fileCount,
      bytes: stats.bytes,
      status: 'refuse',
      targetPresent,
      reason: targetProblem,
    });
    return;
  }

  let status: EntryStatus;
  let reason: string;
  if (targetPresent && row !== undefined) {
    status = 'skip';
    reason = tFromDb(db, 'skill.migrate.skippedPresent');
  } else if (targetPresent) {
    status = 'row';
    reason = tFromDb(db, 'skill.migrate.rowOnlyPresent');
  } else if (row !== undefined) {
    status = 'copy';
    reason = tFromDb(db, 'skill.migrate.rowMissingBytes');
  } else {
    status = 'copy';
    reason = tFromDb(db, 'skill.migrate.copyNew');
  }
  entries.set(key, {
    memberId,
    name,
    source,
    target,
    contentHash: stats.contentHash,
    fileCount: stats.fileCount,
    bytes: stats.bytes,
    status,
    targetPresent,
    reason,
  });
}

function listSkillNames(partitionPath: string): string[] {
  try {
    return readdirSync(partitionPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function renderPlan(
  plan: MigrationPlan,
  dataDir: string,
  env: NodeJS.ProcessEnv,
  db: Database.Database,
): string[] {
  const counts = { copy: 0, row: 0, skip: 0, refuse: 0 };
  for (const entry of plan.entries) {
    counts[entry.status] += 1;
  }
  const lines: string[] = [tFromDb(db, 'skill.migrate.planTitle')];
  lines.push(tFromDb(db, 'skill.migrate.dataDirLine', { path: dataDir }));
  lines.push(tFromDb(db, 'skill.migrate.globalLayerLine', { path: workspaceHomeRoot(env) }));
  if (plan.entries.length === 0 && plan.channelPartitions.length === 0) {
    lines.push(tFromDb(db, 'skill.migrate.empty'));
  } else {
    lines.push(
      tFromDb(db, 'skill.migrate.memberEntries', {
        total: plan.entries.length,
        copy: counts.copy,
        row: counts.row,
        skip: counts.skip,
        refuse: counts.refuse,
      }),
    );
    for (const entry of plan.entries) {
      lines.push(
        tFromDb(db, 'skill.migrate.entryHead', {
          action: statusLabel(db, entry.status),
          source: entry.source,
          target: entry.target,
        }) +
          (entry.contentHash.length > 0
            ? tFromDb(db, 'skill.migrate.entryDetail', {
                files: entry.fileCount,
                bytes: entry.bytes,
                hash: entry.contentHash,
              })
            : ''),
      );
      lines.push(tFromDb(db, 'skill.migrate.reasonLine', { reason: entry.reason }));
    }
    if (plan.channelPartitions.length > 0) {
      const skillCount = plan.channelPartitions.reduce(
        (total, partition) => total + partition.skills.length,
        0,
      );
      lines.push(
        tFromDb(db, 'skill.migrate.channelSection', {
          partitions: plan.channelPartitions.length,
          skills: skillCount,
        }),
      );
      for (const partition of plan.channelPartitions) {
        lines.push(
          tFromDb(db, 'skill.migrate.channelLine', {
            channel_id: partition.channelId,
            path: partition.path,
            count: partition.skills.length,
            skills: partition.skills.join(', '),
          }),
        );
        lines.push(tFromDb(db, 'skill.migrate.channelNotice'));
      }
    }
    if (plan.unknownPartitions.length > 0) {
      lines.push(
        tFromDb(db, 'skill.migrate.unknownSection', {
          count: plan.unknownPartitions.length,
        }),
      );
      for (const partition of plan.unknownPartitions) {
        lines.push(`  ${partition.partition}：${partition.path}（${partition.reason}）`);
      }
    }
  }
  return lines;
}

function statusLabel(db: Database.Database, status: EntryStatus): string {
  switch (status) {
    case 'copy':
      return tFromDb(db, 'skill.migrate.new');
    case 'row':
      return tFromDb(db, 'skill.migrate.rowOnly');
    case 'skip':
      return tFromDb(db, 'skill.migrate.skip');
    case 'refuse':
      return tFromDb(db, 'skill.migrate.refuse');
  }
}
