import type { TargetMemberView } from '@allibot/shared';

/**
 * 补全（Mention Completion）的纯逻辑：候选范围、包含匹配与插入文本。
 *
 * 候选只来自当前 target 的成员读数（`GET /api/targets/{id}/members`）；
 * 频道、私信、任务线程的差别已经由后端端点收窄，这里只排除 owner。
 *
 * 前端不解析提及：本模块不做“这是不是提及”的判定，只按解析器的字面规则
 * 拼出要插入的 `@名字` 文本。
 */

/** 当前 target 的 Agent 成员，保持后端给出的顺序。 */
export function completionCandidates(
  members: readonly TargetMemberView[],
): TargetMemberView[] {
  return members.filter((member) => member.kind === 'agent');
}

/** ASCII 大小写折叠：只折叠 A-Z，与后端的 ASCII 大小写不敏感一致。 */
export function asciiLower(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/** 包含匹配 + ASCII 大小写不敏感；空查询列出全部候选。 */
export function filterMentionCandidates<T extends { display_name: string }>(
  candidates: readonly T[],
  query: string,
): T[] {
  const needle = asciiLower(query);
  return candidates.filter((candidate) =>
    asciiLower(candidate.display_name).includes(needle),
  );
}

/**
 * 后端的三种引号对，顺序即插入时的选择顺序：名字里含某对引号时换下一对。
 */
const QUOTE_PAIRS = [
  ['"', '"'],
  ['“', '”'],
  ['‘', '’'],
] as const;

/**
 * 无引号形式候选串的终止字符，与后端解析器同一套：名字含任一字符时
 * 必须走引号形式（词条：提及）。
 */
const TOKEN_STOPS = new Set(
  [
    ..." \t\r\n@,，。、;；:：!！?？'\"()（）[]【】{}「」<>《》/\\|~#$%^&*=",
    ...QUOTE_PAIRS.flatMap(([open, close]) => [open, close]),
  ],
);

const ASCII_ALNUM = /^[A-Za-z0-9]$/;

export interface MentionQuery {
  /** 替换区间：`@` 的位置到光标；半开区间 `[start, end)`。 */
  start: number;
  end: number;
  /** 光标前、`@` 后的筛选词。 */
  query: string;
}

/**
 * 光标处是否有进行中的补全查询。规则与后端提及解析一致：`@` 左侧是
 * ASCII 字母或数字时不算（排除邮箱式）；无引号形式的候选串遇到分隔符
 * 即结束；`@"..."` 形式允许分隔符。
 */
export function detectMentionQuery(
  text: string,
  caret: number,
): MentionQuery | null {
  if (!Number.isInteger(caret) || caret <= 0 || caret > text.length) {
    return null;
  }
  const at = text.lastIndexOf('@', caret - 1);
  if (at < 0) {
    return null;
  }
  if (at > 0 && ASCII_ALNUM.test(text[at - 1] ?? '')) {
    return null;
  }

  const pair = QUOTE_PAIRS.find(([open]) => open === text[at + 1]);
  if (pair !== undefined) {
    const closeAt = text.indexOf(pair[1], at + 2);
    if (closeAt < 0 || closeAt >= caret) {
      return { start: at, end: caret, query: text.slice(at + 2, caret) };
    }
    if (closeAt + 1 === caret) {
      return { start: at, end: caret, query: text.slice(at + 2, closeAt) };
    }
    return null;
  }

  const query = text.slice(at + 1, caret);
  if ([...query].some((character) => TOKEN_STOPS.has(character))) {
    return null;
  }
  return { start: at, end: caret, query };
}

export interface MentionInsertion {
  value: string;
  caret: number;
}

/** 插入库里的原名；名字含分隔符时走引号形式。 */
export function mentionToken(name: string): string {
  const needsQuotes = [...name].some((character) => TOKEN_STOPS.has(character));
  if (!needsQuotes) {
    return `@${name}`;
  }
  const pair =
    QUOTE_PAIRS.find(
      ([open, close]) => !name.includes(open) && !name.includes(close),
    ) ?? QUOTE_PAIRS[0];
  return `@${pair[0]}${name}${pair[1]}`;
}

/** 用选中的成员替换光标处的补全查询；没有进行中的查询时返回 null。 */
export function insertMention(
  text: string,
  caret: number,
  member: { display_name: string },
): MentionInsertion | null {
  const active = detectMentionQuery(text, caret);
  if (active === null) {
    return null;
  }
  const token = mentionToken(member.display_name);
  return {
    value: text.slice(0, active.start) + token + text.slice(active.end),
    caret: active.start + token.length,
  };
}
