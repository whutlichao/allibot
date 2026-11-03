import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { ZH_CN, t } from '../../shared/dist/index.js';
import { App } from '../src/App.ts';
import { SettingsPanel } from '../src/components/SettingsPanel.ts';

const WEB_SRC = new URL('../src/', import.meta.url);
const APP_ENTRY = new URL('../src/main.tsx', import.meta.url);

/** 直接写死的用户可见文案：中文、或标签之间的英文句子。 */
const HARD_CODED_CJK = /[一-鿿]/u;
const HARD_CODED_LABEL = />\s*[A-Za-z][A-Za-z ,.'!?-]{2,}\s*</;

/**
 * 前端只做契约测试（规格「测试的 seam」）：从词条表渲染出的静态标记与
 * 壳上的 density / theme 状态。组件内没有硬编码文案，是这条契约的一部分。
 */
async function sourceFiles(dir: URL): Promise<URL[]> {
  const files: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = new URL(`${entry.name}${entry.isDirectory() ? '/' : ''}`, dir);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(full)));
      continue;
    }
    if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
      files.push(full);
    }
  }
  return files;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('the settings panel renders its copy from the string catalog, not literals', () => {
  const html = renderToStaticMarkup(
    createElement(SettingsPanel, {
      settings: { locale: 'zh-CN', density: 'comfortable', theme: 'system' },
    }),
  );

  for (const key of [
    'settings.title',
    'settings.locale.label',
    'settings.locale.zhCN',
    'settings.density.label',
    'settings.density.comfortable',
    'settings.density.compact',
    'settings.theme.label',
    'settings.theme.light',
    'settings.theme.dark',
    'settings.theme.system',
  ] as const) {
    assert.ok(html.includes(ZH_CN[key].text), `the panel is missing the ${key} copy`);
  }
});

test('every web source file renders copy through the catalog and hard-codes none', async () => {
  for (const file of await sourceFiles(WEB_SRC)) {
    const name = file.pathname.slice(file.pathname.lastIndexOf('/') + 1);
    if (name === 'strings.ts' || name === 'strings.tsx') {
      continue;
    }
    const source = stripComments(await readFile(file, 'utf8'));
    assert.doesNotMatch(
      source,
      HARD_CODED_CJK,
      `${name} hard-codes Chinese copy; render it from the string catalog`,
    );
    assert.doesNotMatch(
      source,
      HARD_CODED_LABEL,
      `${name} hard-codes an English label; render it from the string catalog`,
    );
  }
});

test('the app shell carries the density and theme settings and renders the sample message', () => {
  const comfortable = renderToStaticMarkup(
    createElement(App, {
      settings: { locale: 'zh-CN', density: 'comfortable', theme: 'light' },
    }),
  );
  assert.match(comfortable, /data-density="comfortable"/);
  assert.match(comfortable, /data-theme="light"/);

  const compact = renderToStaticMarkup(
    createElement(App, {
      settings: { locale: 'zh-CN', density: 'compact', theme: 'dark' },
    }),
  );
  assert.match(compact, /data-density="compact"/);
  assert.match(compact, /data-theme="dark"/);

  const sample = t('zh-CN', 'message.sample.body', {
    author: ZH_CN['message.sample.author'].text,
  });
  for (const html of [comfortable, compact]) {
    assert.ok(html.includes(sample), `the shell should render: ${sample}`);
    assert.ok(html.includes(ZH_CN['message.sample.author'].text));
  }
});

test('the app entry loads settings from the backend before rendering the shell', async () => {
  const entry = await readFile(APP_ENTRY, 'utf8');
  assert.match(entry, /['"]\/api\/settings['"]/, 'the shell must read GET /api/settings');
  assert.match(entry, /from '\.\/App(\.ts|\.tsx)?'/, 'main.tsx must render the App shell');
});
