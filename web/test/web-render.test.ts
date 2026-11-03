import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { TargetMemberView } from '@allibot/shared';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { MentionCompletion } from '../src/components/MentionCompletion.ts';
import { MessageBody } from '../src/components/MessageBody.ts';
import { renderMessageBody } from '../src/markdown.ts';
import {
  completionCandidates,
  detectMentionQuery,
  filterMentionCandidates,
  insertMention,
  mentionToken,
} from '../src/mention-completion.ts';

/**
 * 正文渲染与补全的组件级契约测试（规格 R2：前端只做呈现层契约）。
 *
 * 这些测试从公开接口观察行为：`renderMessageBody` 把正文呈现成结构化
 * HTML、`MessageBody` 按 kind 选择对话正文或事件行、`MentionCompletion`
 * 只按 props 的成员与区间呈现。领域判定（是不是提及、谁在 target 里）
 * 不在这里测，后端 HTTP seam 已有正本。
 */

test('renders paragraph, heading, emphasis, inline code, code block, list, blockquote, link and table', () => {
  const body = [
    '# 标题',
    '',
    '段落有 **加粗**、_斜体_ 与 `行内代码`。',
    '',
    '- 第一项',
    '- 第二项',
    '',
    '> 引用',
    '',
    '```ts',
    'const x = 1;',
    '```',
    '',
    '[链接](https://example.com/docs)',
    '',
    '| 列一 | 列二 |',
    '| --- | --- |',
    '| 甲 | 乙 |',
  ].join('\n');

  const html = renderMessageBody(body, []);

  assert.match(html, /<h1>标题<\/h1>/, 'heading');
  assert.match(
    html,
    /<p>段落有 <strong>加粗<\/strong>、<em>斜体<\/em> 与 <code>行内代码<\/code>。<\/p>/,
    'paragraph with strong, emphasis and inline code',
  );
  assert.match(html, /<ul>\s*<li>第一项<\/li>\s*<li>第二项<\/li>\s*<\/ul>/, 'unordered list');
  assert.match(html, /<blockquote>\s*<p>引用<\/p>\s*<\/blockquote>/, 'blockquote');
  assert.match(
    html,
    /<pre><code class="language-ts">const x = 1;\n<\/code><\/pre>/,
    'fenced code block with its language class',
  );
  assert.match(html, /<a href="https:\/\/example\.com\/docs">链接<\/a>/, 'link');
  assert.match(
    html,
    /<table>[\s\S]*<th>列一<\/th>[\s\S]*<th>列二<\/th>[\s\S]*<td>甲<\/td>[\s\S]*<td>乙<\/td>[\s\S]*<\/table>/,
    'table',
  );
});

test('human and agent messages render Markdown in a conversation body', () => {
  const html = renderToStaticMarkup(
    createElement(MessageBody, { kind: 'human', body: '**加粗**', mentions: [] }),
  );

  assert.match(html, /class="message-body"/);
  assert.match(html, /data-message-kind="human"/);
  assert.match(html, /<strong>加粗<\/strong>/);
});

test('a system event renders as an event line, not as a Markdown conversation body', () => {
  const html = renderToStaticMarkup(
    createElement(MessageBody, { kind: 'system', body: '任务已创建 **不是加粗**', mentions: [] }),
  );

  assert.match(html, /class="message-event"/);
  assert.match(html, /data-message-kind="system"/);
  assert.doesNotMatch(html, /message-body/, 'a system event is never a conversation body');
  assert.doesNotMatch(html, /<p>|<strong>|<ul>|<table>/, 'the event line does not parse Markdown');
  assert.ok(html.includes('任务已创建 **不是加粗**'), 'the record text stays literal');
});

interface RenderedMention {
  member_id: string;
  start: number;
  end: number;
  text: string;
}

/** 读出渲染结果里的提及标签：属性与标签内的可见文本。 */
function renderedMentions(html: string): RenderedMention[] {
  const pattern =
    /<span class="mention" data-member-id="([^"]*)" data-mention-start="(\d+)" data-mention-end="(\d+)">([\s\S]*?)<\/span>/g;
  return [...html.matchAll(pattern)].map((match) => ({
    member_id: match[1]!,
    start: Number(match[2]),
    end: Number(match[3]),
    text: match[4]!,
  }));
}

test('backend mention ranges wrap exactly, including inside strong and inline code', () => {
  // 你好 **@小明** 和 `@小红`
  //       5    8      14   17
  const body = '你好 **@小明** 和 `@小红`';
  const mentions = [
    { member_id: 'm-ming', start: 5, end: 8 },
    { member_id: 'm-hong', start: 14, end: 17 },
  ];

  const html = renderMessageBody(body, mentions);

  assert.match(html, /<strong><span class="mention"/, 'a bold mention stays bold');
  assert.match(html, /<code><span class="mention"/, 'an inline-code mention keeps the code style');
  assert.deepEqual(renderedMentions(html), [
    { member_id: 'm-ming', start: 5, end: 8, text: '@小明' },
    { member_id: 'm-hong', start: 14, end: 17, text: '@小红' },
  ]);
});

test('mention tags come only from props; the renderer never parses a name itself', () => {
  const unmatched = renderMessageBody('你好 @小明', []);
  assert.deepEqual(renderedMentions(unmatched), [], 'an @ the backend did not decide is plain text');

  const ghost = renderMessageBody('@幽灵', [{ member_id: 'm-ghost', start: 0, end: 3 }]);
  assert.deepEqual(
    renderedMentions(ghost),
    [{ member_id: 'm-ghost', start: 0, end: 3, text: '@幽灵' }],
    'a backend range is wrapped even when no member name matches in the component',
  );
});

test('the fixed known costs render as emphasis and italic, with no view-source control', () => {
  const html = renderMessageBody('snake_case_name 与 2 * 3 * 4', []);

  assert.match(html, /snake<em>case<\/em>name/, 'intraword underscores are a known emphasis cost');
  assert.match(html, /2 <em> 3 <\/em> 4/, 'spaced asterisks are a known italic cost');

  const message = renderToStaticMarkup(
    createElement(MessageBody, { kind: 'agent', body: 'snake_case_name 与 2 * 3 * 4', mentions: [] }),
  );
  assert.doesNotMatch(message, /查看原文/, 'the known costs are not compensated by a view-source toggle');
  assert.doesNotMatch(message, /<button|<details|<summary|data-raw/i, 'no raw-body control exists');
});

test('raw HTML, script URLs and attribute injection never reach the rendered body', () => {
  const html = renderMessageBody(
    '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[x](javascript:alert(1))',
    [],
  );

  assert.ok(!html.includes('<script'), 'raw script tags are escaped');
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), 'the script shows as text');
  assert.ok(!html.includes('<img'), 'raw HTML never becomes elements');
  assert.doesNotMatch(html, /href="javascript:/i, 'script URLs are not turned into links');

  const image = renderMessageBody('![追踪像素](https://tracker.example/pixel.png)', []);
  assert.ok(!image.includes('<img'), 'a body never loads a remote image');
  assert.ok(image.includes('追踪像素'), 'the alt text still reads as text');

  const injected = renderMessageBody('@x', [
    { member_id: 'm" onmouseover="alert(1)', start: 0, end: 2 },
  ]);
  assert.ok(
    injected.includes('data-member-id="m&quot; onmouseover=&quot;alert(1)"'),
    'member ids are escaped inside the attribute',
  );

  // 后端在链接地址里也可能给出提及区间；可见正文之外没有可包的文本，
  // 标签绝不能插进 href 属性里。
  const link = '[x](https://example.com/@bob)';
  const at = link.indexOf('@');
  const linked = renderMessageBody(link, [
    { member_id: 'm-bob-link', start: at, end: at + 4 },
  ]);
  assert.match(linked, /href="https:\/\/example\.com\/@bob"/);
  assert.ok(!linked.includes('class="mention"'), 'no tag is inserted inside an attribute');
});

const OWNER: TargetMemberView = {
  id: 'owner-1',
  kind: 'owner',
  display_name: 'Owner',
  avatar_slot: 1,
};

const ALICE: TargetMemberView = {
  id: 'agent-alice',
  kind: 'agent',
  display_name: 'Alice',
  avatar_slot: 0,
};

const BOB: TargetMemberView = {
  id: 'agent-bob',
  kind: 'agent',
  display_name: 'Bob',
  avatar_slot: 2,
};

const CAROL: TargetMemberView = {
  id: 'agent-carol',
  kind: 'agent',
  display_name: 'Carol',
  avatar_slot: 3,
};

function ids(members: readonly TargetMemberView[]): string[] {
  return members.map((member) => member.id);
}

test('completion lists only the current target Agent members', () => {
  // 频道：GET /api/targets/{id}/members 已给出 owner + 已加入 Agent。
  const channel = [OWNER, ALICE, BOB];
  assert.deepEqual(
    ids(completionCandidates(channel)),
    ['agent-alice', 'agent-bob'],
    'the owner is not a candidate; only joined Agents are',
  );
  assert.ok(
    !ids(completionCandidates(channel)).includes(CAROL.id),
    'an Agent outside the target is never a candidate',
  );

  // 私信：同一端点返回 owner + 对方那一个 Agent。
  assert.deepEqual(ids(completionCandidates([OWNER, BOB])), ['agent-bob']);

  // 任务线程：同一端点返回 owner + 该 task 型 target 的 Agent 成员。
  assert.deepEqual(ids(completionCandidates([OWNER, ALICE])), ['agent-alice']);
});

test('completion filters by ASCII-case-insensitive containment', () => {
  const candidates = completionCandidates([OWNER, ALICE, BOB, CAROL]);

  assert.deepEqual(ids(filterMentionCandidates(candidates, 'LI')), ['agent-alice']);
  assert.deepEqual(ids(filterMentionCandidates(candidates, 'lic')), ['agent-alice']);
  assert.deepEqual(ids(filterMentionCandidates(candidates, 'BO')), ['agent-bob']);
  assert.deepEqual(
    ids(filterMentionCandidates(candidates, '')),
    ['agent-alice', 'agent-bob', 'agent-carol'],
    'an empty query lists the whole target roster in backend order',
  );

  const nonAscii = [{ display_name: 'Ärger' }];
  assert.deepEqual(
    filterMentionCandidates(nonAscii, 'ä'),
    [],
    'only ASCII letters are case-folded, matching the backend filter',
  );
  assert.deepEqual(filterMentionCandidates(nonAscii, 'Ä'), nonAscii);
});

test('typing @ opens completion only at the parser left boundary', () => {
  assert.deepEqual(detectMentionQuery('你好 @', 4), { start: 3, end: 4, query: '' });
  assert.deepEqual(detectMentionQuery('@Al', 3), { start: 0, end: 3, query: 'Al' });
  assert.equal(
    detectMentionQuery('user@example', 12),
    null,
    'an ASCII letter or digit before @ excludes an email-like token',
  );
  assert.equal(detectMentionQuery('@Ali ce', 7), null, 'a separator closes the active query');
  assert.equal(detectMentionQuery('没有触发', 4), null);
});

test('selection inserts the original catalog name, quoting names with separators', () => {
  assert.deepEqual(insertMention('你好 @', 4, ALICE), { value: '你好 @Alice', caret: 9 });
  assert.deepEqual(
    insertMention('x @ali', 6, ALICE),
    { value: 'x @Alice', caret: 8 },
    'the original name wins over the typed query',
  );

  const spaced = { display_name: '张 三' };
  assert.equal(mentionToken('张 三'), '@"张 三"');
  assert.equal(insertMention('@张', 2, spaced)?.value, '@"张 三"');

  assert.equal(mentionToken('Alice'), '@Alice');
  assert.equal(
    mentionToken('a"b'),
    '@“a"b”',
    'a name holding the ASCII quote uses the next parser quote pair',
  );
  assert.equal(insertMention('no trigger', 10, ALICE), null);
});

function optionIds(html: string): string[] {
  return [...html.matchAll(/role="option"[^>]*data-member-id="([^"]*)"/g)].map(
    (match) => match[1]!,
  );
}

test('the completion renders the current target Agent members and nothing else', () => {
  const html = renderToStaticMarkup(
    createElement(MentionCompletion, {
      members: [OWNER, ALICE, BOB, CAROL],
      text: '你好 @',
      caret: 4,
    }),
  );

  assert.match(html, /role="listbox"/);
  assert.match(html, /aria-label="提及候选"/, 'the listbox carries the catalog label');
  assert.deepEqual(
    optionIds(html),
    ['agent-alice', 'agent-bob', 'agent-carol'],
    'the endpoint roster decides membership; ordering stays the backend join order',
  );
  assert.ok(!html.includes('Owner'), 'the owner is not a completion candidate');
  assert.ok(!html.includes('未加入'), 'candidates carry no not-joined annotation');
});

test('a DM target offers only its one peer Agent', () => {
  const html = renderToStaticMarkup(
    createElement(MentionCompletion, {
      members: [OWNER, BOB],
      text: '@',
      caret: 1,
    }),
  );

  assert.deepEqual(optionIds(html), ['agent-bob']);
});

test('the completion filters as the user types and closes when no query is active', () => {
  const filtered = renderToStaticMarkup(
    createElement(MentionCompletion, {
      members: [OWNER, ALICE, BOB],
      text: '@LI',
      caret: 3,
    }),
  );
  assert.deepEqual(optionIds(filtered), ['agent-alice'], 'ASCII-case-insensitive containment');

  const closed = renderToStaticMarkup(
    createElement(MentionCompletion, {
      members: [OWNER, ALICE, BOB],
      text: '你好',
      caret: 2,
    }),
  );
  assert.equal(closed, '', 'no @ means no completion');

  const empty = renderToStaticMarkup(
    createElement(MentionCompletion, {
      members: [OWNER, ALICE, BOB],
      text: '@zzz',
      caret: 4,
    }),
  );
  assert.equal(empty, '', 'no matching candidate renders no list');
});
