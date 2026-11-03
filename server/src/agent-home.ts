import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import {
  AGENT_RULE_SECTIONS,
  type AgentRuleSectionView,
  type AgentRulesView,
} from '@allibot/shared';
import type Database from 'better-sqlite3';
import { agentHomeRoot } from './workspace-root.js';

/**
 * Agent 家目录的创建与路径 (D5.2).
 *
 * The home is derived from `member_id` and the process-level global layer root;
 * no database column stores it. Creation happens when an Agent is created, and
 * only that directory is made: `skills/`, `mcp.json` and memory directories are
 * never created by startup (or by this path). The home is human-owned for
 * `AGENTS.md` and app-owned for skills later (#48); #43 only reads rules from it.
 */

/** Create `<home>/agents/<member_id>/` (idempotent) and return it. */
export function ensureAgentHome(
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const home = agentHomeRoot(memberId, env);
  mkdirSync(home, { recursive: true });
  return home;
}

/** `~/.allibot/agents/<member_id>/AGENTS.md` — the global rules base (D5.2). */
export function globalRulesBasePath(
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(agentHomeRoot(memberId, env), 'AGENTS.md');
}

/** `<workspace_root>/.allibot/` — the project layer root (D5.2). */
export function projectLayerRoot(workspaceRoot: string): string {
  return path.join(workspaceRoot, '.allibot');
}

/** `<workspace_root>/.allibot/agents/<member_id>/` — the flat project member home. */
export function projectAgentHomeRoot(workspaceRoot: string, memberId: string): string {
  return path.join(projectLayerRoot(workspaceRoot), 'agents', memberId);
}

/** `<workspace_root>/.allibot/agents/<member_id>/AGENTS.md` — the project supplement. */
export function projectSupplementPath(workspaceRoot: string, memberId: string): string {
  return path.join(projectAgentHomeRoot(workspaceRoot, memberId), 'AGENTS.md');
}

/** One file reading: exists / could be read / text. */
export interface RuleFileReading {
  present: boolean;
  readable: boolean;
  content: string | null;
}

/**
 * Read one rules file as text (D5.2). Missing and unreadable are separate
 * facts, and an unreadable section is simply absent from the round's prompt;
 * the caller never sees a thrown error. A directory at the path exists but is
 * not readable as a rules file.
 */
export function readRuleFile(filePath: string): RuleFileReading {
  if (!existsSync(filePath)) {
    return { present: false, readable: false, content: null };
  }
  try {
    if (!statSync(filePath).isFile()) {
      return { present: true, readable: false, content: null };
    }
    return { present: true, readable: true, content: readFileSync(filePath, 'utf8') };
  } catch {
    return { present: true, readable: false, content: null };
  }
}

/** The stored `agent_config.system_prompt` as the middle section. */
function readStoredPrompt(db: Database.Database, memberId: string): string {
  const row = db
    .prepare('SELECT system_prompt FROM agent_config WHERE member_id = ?')
    .get(memberId) as { system_prompt: string } | undefined;
  return row?.system_prompt ?? '';
}

/** The project-layer root of a live channel, or null (no channel / no root). */
function readLiveChannelRoot(db: Database.Database, channelId: string | null): string | null {
  if (channelId === null) {
    return null;
  }
  const row = db
    .prepare('SELECT workspace_root FROM channel WHERE id = ? AND deleted_at IS NULL')
    .get(channelId) as { workspace_root: string | null } | undefined;
  return row?.workspace_root ?? null;
}

/**
 * The read-only effective rules (D2.3): the global rules base, the stored
 * system prompt and the project supplement, in the fixed assembly order, with
 * present / readable on each section. There is no write entry: the host only
 * reads these files and never changes them.
 */
export function readAgentRules(
  db: Database.Database,
  memberId: string,
  channelId: string | null,
  env: NodeJS.ProcessEnv = process.env,
): AgentRulesView {
  const homePath = agentHomeRoot(memberId, env);
  const globalPath = globalRulesBasePath(memberId, env);
  const projectRoot = readLiveChannelRoot(db, channelId);
  const systemPrompt = readStoredPrompt(db, memberId);

  const global = readRuleFile(globalPath);
  const project =
    projectRoot === null
      ? { present: false, readable: false, content: null, path: null }
      : {
          ...readRuleFile(projectSupplementPath(projectRoot, memberId)),
          path: projectSupplementPath(projectRoot, memberId),
        };

  const sections: AgentRuleSectionView[] = [
    {
      kind: 'global',
      path: globalPath,
      present: global.present,
      readable: global.readable,
      content: global.readable ? global.content : null,
    },
    {
      kind: 'system_prompt',
      path: null,
      present: systemPrompt.length > 0,
      readable: true,
      content: systemPrompt,
    },
    {
      kind: 'project',
      path: project.path,
      present: project.present,
      readable: project.readable,
      content: project.readable ? project.content : null,
    },
  ];

  return {
    agent_id: memberId,
    channel_id: channelId,
    home_path: homePath,
    order: [...AGENT_RULE_SECTIONS],
    sections,
  };
}

/**
 * The two file-backed prompt sections of one round (D5.2). A DM / no-root
 * round has no project supplement; both reads swallow missing / unreadable
 * files, so a broken file only omits its own section. Empty text is absent
 * rather than an empty section.
 */
export function readRoundRuleSections(
  memberId: string,
  projectRoot: string | null,
  env: NodeJS.ProcessEnv = process.env,
): { rulesBase: string | null; projectSupplement: string | null } {
  const text = (filePath: string): string | null => {
    const reading = readRuleFile(filePath);
    if (!reading.readable || reading.content === null || reading.content.trim().length === 0) {
      return null;
    }
    return reading.content.trim();
  };
  return {
    rulesBase: text(globalRulesBasePath(memberId, env)),
    projectSupplement:
      projectRoot === null ? null : text(projectSupplementPath(projectRoot, memberId)),
  };
}
