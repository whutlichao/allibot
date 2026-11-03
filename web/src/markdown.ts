import type { MessageMentionView } from '@allibot/shared';
import MarkdownIt from 'markdown-it';

/**
 * 正文渲染（Body Rendering）：把人类与 Agent 消息的正文按 Markdown 呈现。
 *
 * 渲染是呈现不是判定：提及区间由后端在落库时裁决，这里只按 props 给出的
 * `start` / `end` 包标签，从不按成员名重新找位置。
 *
 * `html: false` 是安全边界：正文里的原始 HTML 一律转义，不进入输出。
 */
const markdown = new MarkdownIt({
  html: false,
  linkify: false,
  typographer: false,
  breaks: false,
});

/**
 * 已知代价（D2.4 固定夹具）：Markdown 的强调记号同时管 intraword 下划线
 * 与两侧带空格的星号——`snake_case_name` 呈现为强调、`2 * 3 * 4` 呈现
 * 为斜体。规格接受这两个代价，不提供「查看原文」开关来兜底。
 *
 * 这条文本规则只处理 Markdown 解析后剩下的字面文本；已经成形的强调、
 * 行内代码与链接不走这里。转义在拼接前逐段完成，渲染结果不引入原始 HTML。
 */
const LEGACY_EMPHASIS = /([*_])([^*_\n]+?)\1/g;

markdown.renderer.rules.text = (tokens, index) =>
  renderLegacyText(tokens[index]?.content ?? '');

// 正文渲染的范围只有规格列出的结构；图片不在其中，也避免正文触发远端请求。
markdown.renderer.rules.image = (tokens, index) =>
  escapeHtml(tokens[index]?.content ?? '');

/** 哨兵围住的提及正文按原样转义，不再当作强调记号。 */
function renderLegacyText(raw: string): string {
  let out = '';
  let cursor = 0;
  while (cursor < raw.length) {
    const open = raw.indexOf(MENTION_OPEN, cursor);
    if (open < 0) {
      return out + renderLegacyEmphasis(raw.slice(cursor));
    }
    const close = raw.indexOf(MENTION_CLOSE, open + 1);
    if (close < 0) {
      return out + renderLegacyEmphasis(raw.slice(cursor));
    }
    out += renderLegacyEmphasis(raw.slice(cursor, open));
    out += escapeHtml(raw.slice(open, close + 1));
    cursor = close + 1;
  }
  return out;
}

function renderLegacyEmphasis(text: string): string {
  let out = '';
  let cursor = 0;
  for (const match of text.matchAll(LEGACY_EMPHASIS)) {
    out += escapeHtml(text.slice(cursor, match.index));
    out += `<em>${escapeHtml(match[2]!)}</em>`;
    cursor = match.index! + match[0].length;
  }
  return out + escapeHtml(text.slice(cursor));
}

/**
 * 提及区间的哨兵：先按区间把哨兵插进源文，Markdown 解析后再把哨兵换成
 * 标签。这样 `**@某人**`、`` `@某人` `` 这类含 Markdown 记号的形态仍按
 * 后端给的源文 offset 落在 `start` / `end` 上，不因记号而错位。
 *
 * 用私用区字符做哨兵，用户正文里同字符先替换成 U+FFFD（等长替换，
 * 区间坐标不变），所以哨兵不会与正文混淆。
 */
const MENTION_OPEN = '\uE000';
const MENTION_CLOSE = '\uE001';

type MentionRange = MessageMentionView;

/**
 * 把一条消息正文渲染成结构化 HTML。`mentions` 是后端给出的 UTF-16 半开
 * 区间 `[start, end)`，与消息正文同一坐标。
 */
export function renderMessageBody(
  body: string,
  mentions: readonly MessageMentionView[],
): string {
  const ranges = validMentionRanges(body, mentions);
  if (ranges.length === 0) {
    return markdown.render(body);
  }
  const prepared = withMentionSentinels(sanitizeSentinels(body), ranges);
  return wrapMentionSentinels(markdown.render(prepared), ranges);
}

/** 只保留后端区间里形状合法且互不重叠的那些，按 start 排序。 */
function validMentionRanges(
  body: string,
  mentions: readonly MessageMentionView[],
): MentionRange[] {
  const valid = mentions
    .filter(
      (mention) =>
        Number.isInteger(mention.start) &&
        Number.isInteger(mention.end) &&
        mention.start >= 0 &&
        mention.end <= body.length &&
        mention.start < mention.end,
    )
    .slice()
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const ranges: MentionRange[] = [];
  let lastEnd = 0;
  for (const mention of valid) {
    if (mention.start < lastEnd) {
      continue;
    }
    ranges.push(mention);
    lastEnd = mention.end;
  }
  return ranges;
}

function sanitizeSentinels(body: string): string {
  return body.replace(/[\uE000\uE001]/g, '\uFFFD');
}

function withMentionSentinels(body: string, ranges: readonly MentionRange[]): string {
  let out = '';
  let cursor = 0;
  for (const range of ranges) {
    out += body.slice(cursor, range.start);
    out += MENTION_OPEN + body.slice(range.start, range.end) + MENTION_CLOSE;
    cursor = range.end;
  }
  return out + body.slice(cursor);
}

/**
 * 把渲染后的哨兵换成提及标签。哨兵落在 HTML 标签内部（例如链接地址里
 * 恰好含 `@名字`）时只去掉哨兵、不插标签：可见正文之外的区间没有可包
 * 的文本，插标签只会破坏标签结构。
 */
function wrapMentionSentinels(html: string, ranges: readonly MentionRange[]): string {
  // Markdown 的链接归一化会把地址里的哨兵百分号编码；先还原，下面才能按
  // 区间配对。落在标签内部的哨兵会被认出并只删除、不插标签。
  const restored = restoreEncodedSentinels(html);
  const starts = positionsOf(restored, MENTION_OPEN);
  const ends = positionsOf(restored, MENTION_CLOSE);
  if (starts.length !== ranges.length || ends.length !== ranges.length) {
    return stripSentinels(restored);
  }

  let out = '';
  let cursor = 0;
  let previous = -1;
  for (let index = 0; index < ranges.length; index += 1) {
    const start = starts[index]!;
    const end = ends[index]!;
    if (start < previous || end < start) {
      return stripSentinels(restored);
    }
    out += restored.slice(cursor, start);
    const content = restored.slice(start + 1, end);
    out +=
      insideHtmlTag(restored, start) || insideHtmlTag(restored, end)
        ? content
        : `${mentionOpenTag(ranges[index]!)}${content}</span>`;
    cursor = end + 1;
    previous = end;
  }
  return stripSentinels(out + restored.slice(cursor));
}

/**
 * `%EE%80%80` / `%EE%80%81` 是 U+E000 / U+E001 在 URL 里的百分号编码。
 * 只还原 HTML 标签内部，可见正文里的同字面量保持原样。
 */
function restoreEncodedSentinels(html: string): string {
  return html.replace(/<[^>]*>/g, (tag) =>
    tag
      .replace(/%EE%80%80/gi, MENTION_OPEN)
      .replace(/%EE%80%81/gi, MENTION_CLOSE),
  );
}

function positionsOf(html: string, sentinel: string): number[] {
  const positions: number[] = [];
  let cursor = html.indexOf(sentinel);
  while (cursor >= 0) {
    positions.push(cursor);
    cursor = html.indexOf(sentinel, cursor + 1);
  }
  return positions;
}

function insideHtmlTag(html: string, index: number): boolean {
  const lastOpen = html.lastIndexOf('<', index);
  if (lastOpen < 0) {
    return false;
  }
  return lastOpen > html.lastIndexOf('>', index);
}

function mentionOpenTag(range: MentionRange): string {
  return (
    `<span class="mention" data-member-id="${escapeHtml(range.member_id)}"` +
    ` data-mention-start="${range.start}" data-mention-end="${range.end}">`
  );
}

function stripSentinels(html: string): string {
  return html.replaceAll(MENTION_OPEN, '').replaceAll(MENTION_CLOSE, '');
}

const HTML_ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPES[character]!);
}
