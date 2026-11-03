import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  RESERVED_LOCALES,
  SUPPORTED_LOCALES,
  ZH_CN,
  t,
  type CatalogEntry,
} from '../dist/index.js';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The two source trees that render copy: the web shell and the backend. */
const WORKSPACES = ['web/src', 'server/src'] as const;
const SOURCE_EXTENSIONS = ['.ts', '.tsx'] as const;

/**
 * 词条表本身（shared/src/strings）是数据，不是用法：扫它会把自己的定义算成
 * 一次“渲染”，孤儿键检查就永远通过。所以用法扫描只覆盖两个 workspace。
 */

/** `t(locale, 'key', ...)` / `tFromDb(db, 'key', ...)` call sites. */
const CALL_PATTERN =
  /\b(?:t|tFromDb)\s*\([\s\S]{0,120}?'([a-z][a-zA-Z0-9]*(?:\.[a-zA-Z0-9-]+)+)'/g;
/** A direct catalog read: `ZH_CN['key']` or `ZH_CN.key`. */
const CATALOG_INDEX_PATTERN = /\bZH_CN\s*(?:\[\s*'([^']+)'\s*\]|\.([A-Za-z0-9_.]+))/g;

interface CatalogUse {
  file: string;
  key: string;
}

/**
 * 词条表是数据：两个 workspace 只按 key 消费它。这些正则只扫“用法”（key
 * 字符串），不判断渲染结果，所以前端与后端共用同一套检查。
 */
async function collectCatalogUses(dir: string): Promise<CatalogUse[]> {
  const uses: CatalogUse[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      uses.push(...(await collectCatalogUses(full)));
      continue;
    }
    if (!SOURCE_EXTENSIONS.some((extension) => entry.name.endsWith(extension))) {
      continue;
    }
    const source = await readFile(full, 'utf8');
    for (const match of source.matchAll(CALL_PATTERN)) {
      uses.push({ file: full, key: match[1]! });
    }
    for (const match of source.matchAll(CATALOG_INDEX_PATTERN)) {
      uses.push({ file: full, key: match[1] ?? match[2]! });
    }
  }
  return uses;
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{([a-zA-Z0-9_]+)\}/g)].map((match) => match[1]!);
}

const catalog: Record<string, CatalogEntry> = ZH_CN;

test('the zh-CN catalog declares exactly the placeholders its text uses', () => {
  for (const [key, entry] of Object.entries(catalog)) {
    assert.deepEqual(
      [...placeholders(entry.text)].sort(),
      [...entry.params].sort(),
      `string ${key} declares ${entry.params.join(', ') || '(none)'} but its text uses ${placeholders(entry.text).join(', ') || '(none)'}`,
    );
  }
});

test('every key string is a stable namespace-qualified key with no Avoid-word name', () => {
  const AVOID = /\b(i18n|translation|lingo)\b/i;
  for (const key of Object.keys(catalog)) {
    assert.match(key, /^[a-z][a-zA-Z0-9]*(\.[a-zA-Z0-9]+)+$/, `string key ${key} is not stable`);
    assert.doesNotMatch(key, AVOID, `string key ${key} uses an Avoid-column word`);
  }
});

test('every catalog key used by the web and server source exists in zh-CN', async () => {
  const uses = (
    await Promise.all(WORKSPACES.map((workspace) => collectCatalogUses(path.join(REPO_ROOT, workspace))))
  ).flat();

  assert.ok(uses.length > 0, 'no catalog use was found in web/src or server/src');
  for (const use of uses) {
    assert.ok(
      Object.hasOwn(catalog, use.key),
      `${path.relative(REPO_ROOT, use.file)} uses ${use.key}, which zh-CN does not define`,
    );
  }
});

test('there are no orphan keys: every zh-CN key is rendered by a workspace', async () => {
  const uses = (
    await Promise.all(WORKSPACES.map((workspace) => collectCatalogUses(path.join(REPO_ROOT, workspace))))
  ).flat();
  const rendered = new Set(uses.map((use) => use.key));

  // The backend serves the catalog at runtime; the executable proof that a
  // backend key renders is the CLI process test, so only the shell's own
  // catalog module is excluded from the scan.
  const orphans = Object.keys(catalog).filter((key) => !rendered.has(key));
  assert.deepEqual(orphans, [], `zh-CN strings no workspace renders: ${orphans.join(', ')}`);
});

test('the English catalog slot is reserved but not delivered: one catalog, one key set', () => {
  assert.deepEqual([...SUPPORTED_LOCALES], ['zh-CN']);
  assert.deepEqual([...RESERVED_LOCALES], ['en-US']);
  assert.equal(Object.keys(catalog).length, new Set(Object.keys(catalog)).size);
});

test('t renders a key and fails loudly on a missing or extra parameter', () => {
  assert.equal(t('zh-CN', 'settings.title', {}), '工作区设置');
  assert.equal(
    t('zh-CN', 'cli.serve.listening', { url: 'http://127.0.0.1:3000' }),
    'allibot 已监听 http://127.0.0.1:3000。',
  );

  assert.throws(
    () => t('zh-CN', 'cli.serve.listening', {} as never),
    /missing parameter: \{url\}/,
  );
  assert.throws(
    () =>
      t('zh-CN', 'settings.title', { url: 'x' } as never),
    /has no parameter: \{url\}/,
  );
});
