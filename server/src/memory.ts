import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { RoundMemory } from './agent-seam.js';
import { tFromDb } from './copy.js';

/**
 * 长期记忆（Long-term Memory）的落点与读写路径（ADR 0005 / D5）。
 *
 * 一个成员一个逻辑集合：卡片只按 `member_id` 存与读，不按 target / 项目 /
 * 会话切分，因此跨 target 召回是构造事实。写回发生在轮次收尾的同一个事务
 * 里，内容是该轮的可读摘要（触发消息摘录 + 回复摘录 + 任务上下文），关键词
 * 由本文件的确定性 tokenizer 从同一段正文提取——不依赖模型自述，也不额外
 * 调用模型。召回是关键词匹配，没有 embedding、没有向量列。
 */

/** 一段摘录保留的字符数：卡片是可读摘要，不是消息正本。 */
const EXCERPT_LENGTH = 200;
/** 一轮召回注入的固定上限（D5.2 的默认 8 条）。 */
const RECALL_LIMIT = 8;
/** 一张卡片最多保留的关键词数；顺序即首次出现顺序。 */
const MAX_KEYWORDS = 24;
/** 召回查询里「最近上下文」的条数：普通轮的上下文窗口。 */
const RECENT_CONTEXT = 40;

/**
 * The deterministic tokenizer. Latin / digit runs become lowercase keywords
 * (a single character is too weak to match on); Han runs have no spaces, so
 * overlapping bigrams are the deterministic way to make them matchable. The
 * result is deduplicated in first-appearance order and capped, so the same
 * text always yields the same list.
 */
function tokenize(text: string): string[] {
  const tokens: string[] = [];
  const seen = new Set<string>();
  const add = (token: string): void => {
    if (seen.has(token)) {
      return;
    }
    seen.add(token);
    tokens.push(token);
  };

  for (const match of text.matchAll(/[a-z0-9]+|\p{Script=Han}+/giu)) {
    const run = match[0];
    if (/^[a-z0-9]+$/i.test(run)) {
      if (run.length >= 2) {
        add(run.toLowerCase());
      }
      continue;
    }
    for (let index = 0; index + 2 <= run.length; index += 1) {
      add(run.slice(index, index + 2));
    }
  }
  return tokens.slice(0, MAX_KEYWORDS);
}

/** A readable excerpt: collapsed whitespace, truncated with an ellipsis. */
function excerpt(text: string, max = EXCERPT_LENGTH): string {
  const collapsed = text.trim().replace(/\s+/g, ' ');
  return collapsed.length <= max ? collapsed : `${collapsed.slice(0, max)}…`;
}

export interface RoundMemoryCardInput {
  memberId: string;
  targetId: string;
  /** The message that triggered the round; always present. */
  triggerBody: string;
  /** The reply this round committed, or null when it committed none. */
  reply: { id: string; body: string } | null;
}

/**
 * Write the one memory card of a round. It is called inside the round's own
 * transaction, so the reply row and the card that summarises it commit (or
 * roll back) together.
 *
 * Keywords are extracted from the same readable text the card summarises (the
 * trigger excerpt, the reply excerpt and the task context), not from the
 * rendered template around it: the template's own wording would otherwise be a
 * keyword every card shares and recall would match everything.
 */
export function writeRoundMemoryCard(
  db: Database.Database,
  input: RoundMemoryCardInput,
): void {
  const trigger = excerpt(input.triggerBody);
  const reply = input.reply === null ? null : excerpt(input.reply.body);
  const taskContext = readTaskContext(db, input.targetId);
  const content = composeContent(db, trigger, reply, taskContext);
  db.prepare(
    `INSERT INTO agent_memory
       (id, member_id, content, keywords, source_target_id, source_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    input.memberId,
    content,
    JSON.stringify(cardKeywords(trigger, reply, taskContext)),
    input.targetId,
    input.reply?.id ?? null,
    new Date().toISOString(),
  );
}

/**
 * The card's keyword list. A text whose tokenizer finds nothing (a single
 * one-letter or one-digit word) still yields one keyword — the excerpt itself —
 * so `keywords` is never an empty array.
 */
function cardKeywords(
  trigger: string,
  reply: string | null,
  taskContext: string | null,
): string[] {
  const tokens = tokenize([trigger, reply ?? '', taskContext ?? ''].join('\n'));
  return tokens.length > 0 ? tokens : [trigger];
}

function composeContent(
  db: Database.Database,
  trigger: string,
  reply: string | null,
  taskContext: string | null,
): string {
  const base =
    reply === null
      ? tFromDb(db, 'memory.card.noReply', { trigger })
      : tFromDb(db, 'memory.card.replied', { trigger, reply });
  return taskContext === null
    ? base
    : `${base}；${tFromDb(db, 'memory.card.taskContext', { context: taskContext })}`;
}

interface TaskContextRow {
  title: string;
  status: string;
  assignee_name: string | null;
}

interface MemoryRow {
  id: string;
  content: string;
  keywords: string;
  created_at: string;
}

interface ScoredCard {
  memory: RoundMemory;
  score: number;
  created_at: string;
  rowid: number;
}

/**
 * Recall the member's cards for this round (D5.2). The query text is this
 * round's input: the messages being processed, the task title when the target
 * is a task thread, and the target's recent context window.
 *
 * Ordering is keyword overlap first and time recency second — newest first —
 * and the result is capped at RECALL_LIMIT cards. Memory can be revised but
 * never becomes a second message log: recall reads only, so it cannot change
 * messages, unread, wakes, the response discipline or the budget.
 */
export function recallForRound(
  db: Database.Database,
  memberId: string,
  targetId: string,
  newMessages: readonly { seq: number; body: string }[],
): RoundMemory[] {
  const queryTokens = new Set(tokenize(recallQueryText(db, targetId, newMessages)));
  if (queryTokens.size === 0) {
    return [];
  }

  const rows = db
    .prepare(
      `SELECT id, content, keywords, created_at, rowid
         FROM agent_memory WHERE member_id = ?`,
    )
    .all(memberId) as (MemoryRow & { rowid: number })[];

  const scored: ScoredCard[] = [];
  for (const row of rows) {
    const keywords = parseKeywords(row.keywords);
    const matched = keywords.filter((keyword) => queryTokens.has(keyword));
    if (matched.length === 0) {
      continue;
    }
    scored.push({
      memory: { id: row.id, content: row.content, matched_keywords: matched },
      score: matched.length,
      created_at: row.created_at,
      rowid: row.rowid,
    });
  }

  scored.sort(
    (left, right) =>
      right.score - left.score ||
      right.created_at.localeCompare(left.created_at) ||
      right.rowid - left.rowid,
  );
  return scored.slice(0, RECALL_LIMIT).map((card) => card.memory);
}

/**
 * The round's recall input text: the messages this round reads, the task title
 * when there is one, and the target's recent context. The new messages overlay
 * the recent page by seq, so a round that reads more than one window still
 * hands every new body to the tokenizer.
 */
function recallQueryText(
  db: Database.Database,
  targetId: string,
  newMessages: readonly { seq: number; body: string }[],
): string {
  const bodies = new Map<number, string>();
  const recent = db
    .prepare(
      `SELECT seq, body FROM message WHERE target_id = ?
        ORDER BY seq DESC LIMIT ?`,
    )
    .all(targetId, RECENT_CONTEXT) as { seq: number; body: string }[];
  for (const message of recent) {
    bodies.set(message.seq, message.body);
  }
  for (const message of newMessages) {
    bodies.set(message.seq, message.body);
  }
  const parts = [...bodies.entries()]
    .sort((left, right) => left[0] - right[0])
    .map(([, body]) => body);
  const taskTitle = readTaskTitle(db, targetId);
  if (taskTitle !== null) {
    parts.push(taskTitle);
  }
  return parts.join('\n');
}

function parseKeywords(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === 'string')
      : [];
  } catch {
    // A hand-edited row must not break a round: an unreadable keyword list
    // matches nothing.
    return [];
  }
}

/**
 * The memory section of the system prompt (D5.2): one header line plus one
 * line per recalled card. `null` when nothing was recalled, so a round without
 * matches never gains an empty section.
 */
export function memoryPromptSection(
  db: Database.Database,
  memories: readonly RoundMemory[],
): string | null {
  if (memories.length === 0) {
    return null;
  }
  return [
    tFromDb(db, 'memory.prompt.header', { count: memories.length }),
    ...memories.map((memory) => tFromDb(db, 'memory.prompt.card', { content: memory.content })),
  ].join('\n');
}

/** The task title when the target is a task thread; the task context of D5.1. */
function readTaskTitle(db: Database.Database, targetId: string): string | null {
  const row = db
    .prepare('SELECT title FROM task WHERE target_id = ?')
    .get(targetId) as { title: string } | undefined;
  return row?.title ?? null;
}

/**
 * The task context a task-thread round carries into its card (D5.1): the task
 * title, its current status and the assignee identity, i.e. the same task
 * context the agent seam already gives a task round. `null` for every other
 * target kind.
 */
function readTaskContext(db: Database.Database, targetId: string): string | null {
  const row = db
    .prepare(
      `SELECT t.title, t.status, a.display_name AS assignee_name
         FROM task t
         LEFT JOIN member a ON a.id = t.assignee_member_id
        WHERE t.target_id = ?`,
    )
    .get(targetId) as TaskContextRow | undefined;
  if (row === undefined) {
    return null;
  }
  const status = taskStatusLabel(db, row.status);
  return row.assignee_name === null
    ? `${row.title}（${status}）`
    : `${row.title}（${status}，${row.assignee_name}）`;
}

function taskStatusLabel(db: Database.Database, status: string): string {
  switch (status) {
    case 'todo':
      return tFromDb(db, 'task.status.todo');
    case 'in_progress':
      return tFromDb(db, 'task.status.inProgress');
    case 'in_review':
      return tFromDb(db, 'task.status.inReview');
    case 'done':
      return tFromDb(db, 'task.status.done');
    case 'closed':
      return tFromDb(db, 'task.status.closed');
    default:
      throw new Error(`task row carries an unknown status: ${status}`);
  }
}
