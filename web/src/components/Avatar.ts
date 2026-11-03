import { createElement } from 'react';

/** avatar_slot 的确定性取值：0..4 对应 --av-0..--av-4。 */
export const AVATAR_SLOTS = [0, 1, 2, 3, 4] as const;
export type AvatarSlot = (typeof AVATAR_SLOTS)[number];

/** avatar_slot → 视觉契约里的 --av-N 头像色位 token。 */
export function avatarSlotToken(slot: AvatarSlot): `--av-${AvatarSlot}` {
  return `--av-${slot}`;
}

export interface AvatarProps {
  slot: AvatarSlot;
  name: string;
}

/**
 * 成员头像方块：确定性头像色位，7px 圆角方块（不是圆形）。
 *
 * 颜色只由 avatar_slot 决定，不读取 --online / --working 等状态 token，
 * 也不承载主题或可切换外观的语义。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function Avatar({ slot, name }: AvatarProps) {
  return createElement(
    'span',
    {
      className: 'avatar',
      'data-avatar-slot': slot,
      style: { backgroundColor: `var(${avatarSlotToken(slot)})` },
      role: 'img',
      'aria-label': name,
    },
    Array.from(name.trim())[0] ?? '',
  );
}
