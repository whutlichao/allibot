/**
 * Mention parsing: resolve every `@name` token in a message body to a member
 * id and its range, once, at write time. Three rules from the glossary:
 *
 * 1. **Leftmost-longest.** At a given `@`, the longest member name wins, so a
 *    body holding both 张三 and 张三丰 resolves `@张三丰` to 张三丰.
 * 2. **Exact match, never a prefix.** A bare candidate token is the run of
 *    characters up to the next separator; it must equal a member name in full.
 *    `@张三丰茂` is not a mention when no member carries that name.
 * 3. **ASCII left boundary.** An `@` preceded by an ASCII letter or digit does
 *    not start a mention, which excludes `user@example.com` while keeping
 *    `你好@张三`.
 *
 * A name containing a separator is written in one of three quote pairs, and
 * the quoted content must also equal a member name exactly.
 *
 * Offsets are UTF-16 code units, the unit the browser's `String.prototype.slice`
 * counts, so a frontend can wrap the range without recomputing anything. The
 * parser runs on member display names that are still live: a soft-deleted
 * member is not a mention candidate.
 */

/** Opening quote → closing quote. */
const QUOTE_PAIRS: readonly (readonly [string, string])[] = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
];

/**
 * Characters that end a bare candidate token. Names may carry `- . _ +`, so
 * those stay inside the token; whitespace, punctuation and the quote glyphs
 * end it.
 */
const TOKEN_STOPS = new Set(
  [...' \t\r\n@,，。、;；:：!！?？\'"()（）[]【】{}「」<>《》/\\|~#$%^&*='],
);
for (const [open, close] of QUOTE_PAIRS) {
  TOKEN_STOPS.add(open);
  TOKEN_STOPS.add(close);
}

const ASCII_ALNUM = /^[A-Za-z0-9]$/;

export interface MentionCandidate {
  id: string;
  display_name: string;
}

export interface ParsedMention {
  member_id: string;
  start: number;
  end: number;
}

export function parseMentions(
  body: string,
  members: readonly MentionCandidate[],
): ParsedMention[] {
  const byName = new Map<string, string>();
  for (const member of members) {
    if (member.display_name.length > 0 && !byName.has(member.display_name)) {
      byName.set(member.display_name, member.id);
    }
  }
  // Longest first, then lexical, so the tie-break is reproducible.
  const ordered = [...byName.entries()].sort(
    (a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  );

  const mentions: ParsedMention[] = [];
  let cursor = 0;
  while (cursor < body.length) {
    if (body[cursor] !== '@' || !leftBoundaryOk(body, cursor)) {
      cursor += 1;
      continue;
    }

    const match = matchQuoted(body, cursor, byName) ?? matchBare(body, cursor, ordered);
    if (match === null) {
      cursor += 1;
      continue;
    }
    mentions.push(match);
    cursor = match.end;
  }
  return mentions;
}

function leftBoundaryOk(body: string, index: number): boolean {
  if (index === 0) {
    return true;
  }
  return !ASCII_ALNUM.test(body[index - 1] ?? '');
}

function matchQuoted(
  body: string,
  at: number,
  byName: ReadonlyMap<string, string>,
): ParsedMention | null {
  const open = body[at + 1];
  const pair = QUOTE_PAIRS.find(([candidate]) => candidate === open);
  if (pair === undefined) {
    return null;
  }
  const closeAt = body.indexOf(pair[1], at + 2);
  if (closeAt < 0) {
    return null;
  }
  const memberId = byName.get(body.slice(at + 2, closeAt));
  if (memberId === undefined) {
    return null;
  }
  return { member_id: memberId, start: at, end: closeAt + 1 };
}

function matchBare(
  body: string,
  at: number,
  ordered: readonly (readonly [string, string])[],
): ParsedMention | null {
  let end = at + 1;
  while (end < body.length && !TOKEN_STOPS.has(body[end] ?? '')) {
    end += 1;
  }
  const token = body.slice(at + 1, end);
  if (token.length === 0) {
    return null;
  }
  for (const [name, memberId] of ordered) {
    if (token === name) {
      return { member_id: memberId, start: at, end };
    }
  }
  return null;
}
