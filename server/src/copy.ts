import { t, type MessageKey, type MessageValues } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { getSettings } from './settings.js';

/**
 * 后端生成的自然语言按语言偏好渲染的唯一入口。语言偏好落库、后端是唯一
 * 正本，所以这里读库内取值，而不是请求头；写 `system` 消息与轮次 reason 的
 * 后续路径沿用同一个入口。
 */
export function tFromDb(
  db: Database.Database,
  key: MessageKey,
  values: MessageValues = {},
): string {
  return t(getSettings(db).locale, key, values);
}
