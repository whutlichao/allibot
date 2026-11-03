import type { SearchHit, SearchHighlight } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';

/**
 * 搜索 (Search): backend substring matching over messages, task titles and
 * Agent identity, returning the hit type with each result. The frontend only
 * renders by type and wraps the ranges it is handed — it never decides what
 * matched (GLOSSARY 搜索命中 / 高亮区间 / 任务命中 / Agent 命中).
 *
 * The matching rule is one rule for all three kinds: case-insensitive for
 * ASCII, exactly the text for everything else, no tokenization, no fuzzy
 * matching, no pinyin, no FTS. SQLite's `lower()` folds ASCII only, which is
 * exactly the rule, and `instr` is the substring test.
 */

/**
 * Search has no pagination in M1, so every kind is bounded: the cap keeps one
 * very common word from returning the whole history, and it is applied in the
 * same stable order the results are read in. Each kind is capped on its own,
 * so a message-heavy result never crowds out task or Agent hits.
 */
export const MAX_HITS_PER_TYPE = 50;

interface MessageHitRow {
  message_id: string;
  target_id: string;
  body: string;
}

interface TaskHitRow {
  task_id: string;
  title: string;
}

interface AgentHitRow {
  member_id: string;
  display_name: string;
  role: string;
}

/**
 * A message hit excludes only `kind = 'system'` events; a message whose author
 * was soft-deleted still matches, because the author snapshot lives in the
 * message row and history is not rewritten.
 *
 * A deleted channel takes its messages out of search, including the messages
 * of its task threads: a task thread belongs to the channel that owns the
 * task. A DM target has no channel row and is never excluded by this rule.
 */
const MESSAGE_HITS = `
SELECT m.id AS message_id, m.target_id AS target_id, m.body AS body
FROM message m
JOIN target tg ON tg.id = m.target_id
LEFT JOIN task tk ON tk.target_id = m.target_id
LEFT JOIN channel ch ON ch.id =
  CASE WHEN tg.kind = 'channel' THEN m.target_id ELSE tk.channel_id END
WHERE m.kind <> 'system'
  AND (tg.kind = 'dm' OR ch.deleted_at IS NULL)
  AND instr(lower(m.body), lower(?)) > 0
ORDER BY m.created_at, m.rowid
LIMIT ?`;

/** A task hit is its title; a deleted channel takes its tasks out of search. */
const TASK_HITS = `
SELECT t.id AS task_id, t.title AS title
FROM task t
JOIN channel ch ON ch.id = t.channel_id AND ch.deleted_at IS NULL
WHERE instr(lower(t.title), lower(?)) > 0
ORDER BY t.created_at, t.rowid
LIMIT ?`;

/**
 * An Agent hit is its display name or its role. A soft-deleted Agent leaves
 * every read path, this one included.
 */
const AGENT_HITS = `
SELECT m.id AS member_id, m.display_name AS display_name, c.role AS role
FROM member m
JOIN agent_config c ON c.member_id = m.id
WHERE m.kind = 'agent'
  AND m.deleted_at IS NULL
  AND (instr(lower(m.display_name), lower(?)) > 0 OR instr(lower(c.role), lower(?)) > 0)
ORDER BY m.created_at, m.rowid
LIMIT ?`;

/**
 * The three kinds are siblings, not a ranking: message hits first, then task
 * hits, then Agent hits, each in its own stable order. Repeating a query over
 * unchanged data returns the identical array.
 */
export function searchWorkspace(db: Database.Database, query: { text: string }): SearchHit[] {
  const text = query.text;
  const messageHits: SearchHit[] = (
    db
      .prepare(MESSAGE_HITS)
      .all(text, MAX_HITS_PER_TYPE) as MessageHitRow[]
  ).map((row) => ({
    type: 'message',
    target_id: row.target_id,
    message_id: row.message_id,
    highlights: highlightRanges(row.body, text),
  }));

  const taskHits: SearchHit[] = (db.prepare(TASK_HITS).all(text, MAX_HITS_PER_TYPE) as TaskHitRow[]).map(
    (row) => ({
      type: 'task',
      task_id: row.task_id,
      title: row.title,
    }),
  );

  const agentHits: SearchHit[] = (
    db
      .prepare(AGENT_HITS)
      .all(text, text, MAX_HITS_PER_TYPE) as AgentHitRow[]
  ).map((row) => ({
    type: 'agent',
    member_id: row.member_id,
    display_name: row.display_name,
    role: row.role,
  }));

  return [...messageHits, ...taskHits, ...agentHits];
}

/**
 * Every occurrence of the query in the body, as UTF-16 code-unit offsets —
 * the same unit and the same half-open `[start, end)` convention the mention
 * ranges use, so the two kinds of range are read by one frontend rule.
 *
 * Folding is ASCII-only and length-preserving, so an offset in the folded copy
 * is an offset in the stored body. Occurrences do not overlap: a highlight
 * range is wrapped by the frontend, and overlapping ranges could not be
 * rendered as independent labels.
 */
export function highlightRanges(body: string, query: string): SearchHighlight[] {
  const foldedBody = foldAscii(body);
  const foldedQuery = foldAscii(query);
  if (foldedQuery.length === 0) {
    return [];
  }
  const ranges: SearchHighlight[] = [];
  let from = 0;
  while (from + foldedQuery.length <= foldedBody.length) {
    const at = foldedBody.indexOf(foldedQuery, from);
    if (at < 0) {
      break;
    }
    ranges.push({ start: at, end: at + foldedQuery.length });
    from = at + foldedQuery.length;
  }
  return ranges;
}

/** ASCII case folding only; every other character is compared verbatim. */
function foldAscii(value: string): string {
  return value.replace(/[A-Z]/g, (char) => char.toLowerCase());
}

/**
 * `q` is the whole query. An absent, empty or whitespace-only value is a
 * client mistake rather than "match everything": searching for nothing is not
 * a search. Surrounding whitespace is not part of the query.
 */
export function parseSearchQuery(searchParams: URLSearchParams): { text: string } {
  const raw = searchParams.get('q');
  if (raw === null || raw.trim().length === 0) {
    throw ApiFailure.validation('q must be a non-empty search string', { field: 'q' });
  }
  return { text: raw.trim() };
}
