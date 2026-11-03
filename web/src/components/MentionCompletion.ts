import { t, type Locale, type TargetMemberView } from '@allibot/shared';
import { createElement } from 'react';
import {
  completionCandidates,
  detectMentionQuery,
  filterMentionCandidates,
  insertMention,
} from '../mention-completion.ts';
import { AVATAR_SLOTS, Avatar, type AvatarSlot } from './Avatar.ts';

export interface MentionSelection {
  value: string;
  caret: number;
  member: TargetMemberView;
}

export interface MentionCompletionProps {
  /**
   * 当前 target 的成员读数（`GET /api/targets/{id}/members`）。频道、私信、
   * 任务线程的候选范围由这个读数本身决定；组件只排除 owner。
   */
  members: readonly TargetMemberView[];
  /** Composer 的当前文本与光标位置；组件据此判断进行中的补全查询。 */
  text: string;
  caret: number;
  onSelect?: (selection: MentionSelection) => void;
  locale?: Locale;
}

/**
 * 补全（Mention Completion）：Composer 输入 `@` 后弹出的候选列表。
 *
 * 候选只列当前 target 的 Agent 成员，不列 owner、不列 target 外成员、
 * 不标注「未加入」；筛选是包含匹配 + ASCII 大小写不敏感；插入的是库里
 * 的原名（名字含分隔符时走引号形式）。
 *
 * 前端不解析提及：组件只按解析器的字面规则拼要插入的字符串，
 * 「是不是提及」仍由后端在落库时裁决。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function MentionCompletion({
  members,
  text,
  caret,
  onSelect,
  locale = 'zh-CN',
}: MentionCompletionProps) {
  const active = detectMentionQuery(text, caret);
  if (active === null) {
    return null;
  }
  const candidates = filterMentionCandidates(
    completionCandidates(members),
    active.query,
  );
  if (candidates.length === 0) {
    return null;
  }

  return createElement(
    'ul',
    {
      className: 'mention-completion',
      role: 'listbox',
      'aria-label': t(locale, 'mention.completion.label'),
    },
    candidates.map((member) =>
      createElement(
        'li',
        {
          key: member.id,
          className: 'mention-completion__option',
          role: 'option',
          'aria-selected': false,
          'data-member-id': member.id,
        },
        createElement(
          'button',
          {
            type: 'button',
            className: 'mention-completion__button',
            onClick: () => {
              const insertion = insertMention(text, caret, member);
              if (insertion !== null) {
                onSelect?.({ ...insertion, member });
              }
            },
          },
          createElement(Avatar, {
            slot: avatarSlotOf(member.avatar_slot),
            name: member.display_name,
          }),
          createElement(
            'span',
            { className: 'mention-completion__name' },
            member.display_name,
          ),
        ),
      ),
    ),
  );
}

function avatarSlotOf(value: number): AvatarSlot {
  return AVATAR_SLOTS.includes(value as AvatarSlot)
    ? (value as AvatarSlot)
    : AVATAR_SLOTS[0];
}
