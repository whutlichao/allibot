/**
 * 词条表（String Catalog）的类型化取值入口。
 *
 * 一个词条 = 稳定键 + 源文案 + 参数位。参数位按键声明：文案里的 `{name}`
 * 必须与 `params` 一一对应，缺参或多参都会显式失败，不做静默的字符串替换。
 *
 * 渲染落点只有两个：前端按词条渲染、后端生成的自然语言按语言偏好渲染。
 * 两边 import 的是同一份 zh-CN 取值；英文目录位（`en-US`）预留但不交付，
 * 因此这里没有第二个目录，也就不会出现落单键。
 */
import type { Locale } from '../settings.js';
import { ZH_CN } from './zh-CN.js';

/** 一条词条：源文案与它声明的参数位。 */
export interface CatalogEntry {
  readonly text: string;
  readonly params: readonly string[];
}

/** 一个语言的完整取值集合：同一键集逐键对应。 */
export type Catalog = Readonly<Record<string, CatalogEntry>>;

/** 参数位按 key 声明：这里就是 zh-CN 目录的键集。 */
export type MessageKey = keyof typeof ZH_CN;

/** 该键允许的参数取值。 */
export type MessageValues = Readonly<Record<string, string | number>>;

/**
 * 已交付语言的取值集合。英文目录位预留：等英文取值与键集同时到位，
 * 这里再多一个条目，而调用点的 `t(locale, key, params)` 不变。
 */
const CATALOGS: Readonly<Record<Locale, Catalog>> = {
  'zh-CN': ZH_CN,
};

/** 预留但未交付的语言目录位；不是可选值，只说明缺口在哪里。 */
export const RESERVED_LOCALES = ['en-US'] as const;

/**
 * 取一条词条并按参数位渲染。缺参、多参、或文案里的占位没有声明都抛错：
 * 词条表是数据，不是可以静默降级的模板。
 */
export function t(locale: Locale, key: MessageKey, values: MessageValues = {}): string {
  const catalog = CATALOGS[locale];
  const entry: CatalogEntry | undefined = catalog[key];
  if (entry === undefined) {
    throw new Error(`string catalog ${locale} is missing key: ${String(key)}`);
  }

  const provided = Object.keys(values);
  for (const param of entry.params) {
    if (!provided.includes(param)) {
      throw new Error(`string ${String(key)} is missing parameter: {${param}}`);
    }
  }
  for (const param of provided) {
    if (!entry.params.includes(param)) {
      throw new Error(`string ${String(key)} has no parameter: {${param}}`);
    }
  }

  return entry.text.replace(/\{([a-zA-Z0-9_]+)\}/g, (_match, name: string) => {
    if (!entry.params.includes(name)) {
      throw new Error(`string ${String(key)} has an undeclared placeholder: {${name}}`);
    }
    return String(values[name]);
  });
}

export { ZH_CN };
