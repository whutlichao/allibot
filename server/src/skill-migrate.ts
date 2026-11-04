import type Database from 'better-sqlite3';
import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { cpSync } from 'node:fs';
import path from 'node:path';
import { createDataDirBackup } from './backup.js';
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
      lines: ['migrate-skills：--apply 与 --yes 必须同时给出；未写入任何文件。'],
    };
  }

  const plan = buildPlan(db, env);
  const lines = renderPlan(plan, dataDir, env);

  if (plan.entries.some((entry) => entry.status === 'refuse')) {
    return {
      exitCode: 1,
      lines: [
        ...lines,
        '拒绝执行：存在目标同名但内容不同或无法读取的条目。请先手动裁定；本命令不覆盖、不提供 --force；本次未写入任何文件。',
      ],
    };
  }

  if (!options.apply || !options.yes) {
    lines.push('预演结束：未写入任何文件、未改动数据库、未创建备份或迁移清单。');
    return { exitCode: 0, lines };
  }

  const actionable = plan.entries.filter(
    (entry) => entry.status === 'copy' || entry.status === 'row',
  );
  if (actionable.length === 0) {
    lines.push('技能迁移：没有需要写入的条目（全部已就位或没有成员级字节）；未写入任何文件。');
    lines.push(
      `处理条目： 0 条（已复制 0 / 只补行 0 / 跳过 ${plan.entries.filter((entry) => entry.status === 'skip').length}）`,
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
          notice: '频道级已弃用，请按成员安装',
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

  lines.push('技能迁移完成');
  lines.push(`  数据目录备份： ${backupPath}`);
  lines.push(`  迁移清单： ${manifestPath}`);
  lines.push(
    `处理条目： ${actionable.length} 条（已复制 ${copied} / 只补行 ${rowsOnly} / 跳过 ${plan.entries.filter((entry) => entry.status === 'skip').length}）`,
  );
  for (const entry of actionable) {
    lines.push(
      `  ${entry.status === 'copy' ? '复制' : '只补行'} ${entry.source} → ${entry.target}` +
        `（${entry.fileCount} 个文件 / ${entry.bytes} 字节；hash ${entry.contentHash}）`,
    );
  }
  if (removable.length > 0) {
    lines.push('可手工删除的源路径（确认后；本命令不删除任何源文件）：');
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
            ? '未匹配现行成员或频道'
            : '分区名不是安全 slug',
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
      reason: '技能名不是安全 slug，拒绝迁移',
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
      existing.reason = '同一成员的同名旧技能在多个频道根内容不同，需人工裁定';
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
        targetProblem = '目标已存在但内容不同，需人工裁定后再迁移（本命令不覆盖）';
      }
    } catch (error) {
      targetProblem = `目标已存在但不可读取：${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (row !== undefined && row.content_hash !== stats.contentHash) {
    targetProblem = '库行已存在且 hash 不同，需人工裁定';
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
    reason = '目标字节与库行均已就位，跳过';
  } else if (targetPresent) {
    status = 'row';
    reason = '目标字节已存在且内容相同，只补写 Agent 级库行';
  } else if (row !== undefined) {
    status = 'copy';
    reason = '库行已存在但目标字节缺失，补齐成员家目录副本';
  } else {
    status = 'copy';
    reason = '目标不存在，将复制字节并新建 Agent 级库行';
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
): string[] {
  const counts = { copy: 0, row: 0, skip: 0, refuse: 0 };
  for (const entry of plan.entries) {
    counts[entry.status] += 1;
  }
  const lines: string[] = ['技能迁移计划（migrate-skills，只读扫描）'];
  lines.push(`数据目录： ${dataDir}`);
  lines.push(`全局层根： ${workspaceHomeRoot(env)}`);
  if (plan.entries.length === 0 && plan.channelPartitions.length === 0) {
    lines.push('没有发现旧项目层技能字节；空操作（未写入任何文件、未改动数据库）。');
  } else {
    lines.push(
      `成员级技能： ${plan.entries.length} 条（新建 ${counts.copy} / 只补行 ${counts.row} / 跳过 ${counts.skip} / 拒绝 ${counts.refuse}）`,
    );
    for (const entry of plan.entries) {
      lines.push(
        `  ${statusLabel(entry.status)} ${entry.source} → ${entry.target}` +
          (entry.contentHash.length > 0
            ? `（${entry.fileCount} 个文件 / ${entry.bytes} 字节；hash ${entry.contentHash}）`
            : ''),
      );
      lines.push(`    原因：${entry.reason}`);
    }
    if (plan.channelPartitions.length > 0) {
      const skillCount = plan.channelPartitions.reduce(
        (total, partition) => total + partition.skills.length,
        0,
      );
      lines.push(
        `频道级技能（不迁移）： ${plan.channelPartitions.length} 个分区 / ${skillCount} 个技能 —— 频道级已弃用，请按成员安装`,
      );
      for (const partition of plan.channelPartitions) {
        lines.push(
          `  频道 ${partition.channelId}：${partition.path}（${partition.skills.length} 个技能：${partition.skills.join(', ')}）`,
        );
        lines.push('    频道级已弃用，请按成员安装');
      }
    }
    if (plan.unknownPartitions.length > 0) {
      lines.push(`未匹配分区（不迁移）： ${plan.unknownPartitions.length} 个`);
      for (const partition of plan.unknownPartitions) {
        lines.push(`  ${partition.partition}：${partition.path}（${partition.reason}）`);
      }
    }
  }
  return lines;
}

function statusLabel(status: EntryStatus): string {
  switch (status) {
    case 'copy':
      return '新建';
    case 'row':
      return '只补行';
    case 'skip':
      return '跳过';
    case 'refuse':
      return '拒绝';
  }
}
