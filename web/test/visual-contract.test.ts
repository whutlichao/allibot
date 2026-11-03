import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { AVATAR_SLOTS, Avatar, avatarSlotToken } from '../src/components/Avatar.ts';
import {
  AVATAR_SLOT_TOKENS,
  FORBIDDEN_TIER_ALIASES,
  ROLE_FAMILY_ROOTS,
  STATUS_TOKENS,
  TIER_SUFFIXES,
  VISUAL_CONTRACT_TOKENS,
} from '../src/styles/token-contract.ts';

const STYLES_ENTRY = new URL('../src/styles/index.css', import.meta.url);
const APP_ENTRY = new URL('../src/main.tsx', import.meta.url);
const AVATAR_SOURCE = new URL('../src/components/Avatar.ts', import.meta.url);

interface CssFile {
  path: string;
  css: string;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function importSpecifiers(css: string): string[] {
  return [...css.matchAll(/@import\s+['"]([^'"]+)['"]\s*;/g)].map((match) => match[1]!);
}

async function loadCssBundle(entry: URL, seen = new Set<string>()): Promise<CssFile[]> {
  if (seen.has(entry.href)) {
    throw new Error(`circular @import: ${entry.href}`);
  }
  seen.add(entry.href);
  const css = stripComments(await readFile(entry, 'utf8'));
  const files: CssFile[] = [{ path: entry.href, css }];
  for (const specifier of importSpecifiers(css)) {
    files.push(...(await loadCssBundle(new URL(specifier, entry), seen)));
  }
  return files;
}

function declarations(files: CssFile[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const file of files) {
    for (const match of file.css.matchAll(/(--[a-zA-Z0-9-]+)\s*:\s*([^;{}]+);/g)) {
      const name = match[1]!;
      const value = match[2]!.trim();
      assert.ok(!found.has(name), `token ${name} is defined more than once (again in ${file.path})`);
      found.set(name, value);
    }
  }
  return found;
}

function required(defined: Map<string, string>, name: string): string {
  const value = defined.get(name);
  assert.ok(value !== undefined, `token ${name} is missing from the loaded stylesheet`);
  return value;
}

function hueOf(value: string): number {
  const match = /^hsl\(\s*([0-9.]+)(?:deg)?\s/i.exec(value);
  assert.ok(match !== null, `expected an hsl() color value, got ${value}`);
  return Number(match[1]);
}

test('loaded stylesheet exposes exactly the fixed visual-contract token names', async () => {
  const defined = declarations(await loadCssBundle(STYLES_ENTRY));

  assert.deepEqual(
    [...defined.keys()].sort(),
    [...VISUAL_CONTRACT_TOKENS].sort(),
    'token name set drifted from the fixed list in token-contract.ts',
  );
  for (const [name, value] of defined) {
    assert.notEqual(value, '', `token ${name} has an empty value`);
  }
});

test('the app entry loads the styles entry', async () => {
  const appEntry = await readFile(APP_ENTRY, 'utf8');
  assert.match(
    appEntry,
    /import\s+['"]\.\/styles\/index\.css['"];/,
    'main.tsx must import the styles entry so the contract CSS is actually loaded',
  );
});

test('every role family has exactly the four contrast-purpose tiers', async () => {
  const defined = declarations(await loadCssBundle(STYLES_ENTRY));

  for (const root of ROLE_FAMILY_ROOTS) {
    const expected = TIER_SUFFIXES.map((suffix) => `${root}${suffix}`);
    const actual = [...defined.keys()].filter(
      (name) => name === root || name.startsWith(`${root}-`),
    );
    assert.deepEqual(actual.sort(), [...expected].sort(), `role family ${root} has drifted`);

    for (const name of actual) {
      const suffix = name.slice(root.length);
      assert.ok(
        (TIER_SUFFIXES as readonly string[]).includes(suffix),
        `${name} uses an unsupported tier suffix (allowed: -fill / -deep / -graphic)`,
      );
    }
  }
});

test('tier names never use -light / -dark aliases', async () => {
  const defined = declarations(await loadCssBundle(STYLES_ENTRY));

  for (const name of defined.keys()) {
    for (const alias of FORBIDDEN_TIER_ALIASES) {
      assert.ok(!name.endsWith(alias), `${name} uses the forbidden tier alias ${alias}`);
    }
  }
});

test('each role family uses exactly one hue and families use distinct hues', async () => {
  const defined = declarations(await loadCssBundle(STYLES_ENTRY));
  const familyHues = new Map<string, number>();

  for (const root of ROLE_FAMILY_ROOTS) {
    const hues = TIER_SUFFIXES.map((suffix) => hueOf(required(defined, `${root}${suffix}`)));
    assert.equal(
      new Set(hues).size,
      1,
      `role family ${root} must use exactly one hue, got ${hues.join(', ')}`,
    );
    familyHues.set(root, hues[0]!);
  }

  assert.equal(
    new Set(familyHues.values()).size,
    ROLE_FAMILY_ROOTS.length,
    'role families must use distinct hues',
  );
});

test('avatar slots are five deterministic status-free hues', async () => {
  const defined = declarations(await loadCssBundle(STYLES_ENTRY));

  const hues = AVATAR_SLOT_TOKENS.map((name) => {
    const value = required(defined, name);
    assert.doesNotMatch(value, /var\(/, `${name} must be a literal slot color, not an alias`);
    for (const status of STATUS_TOKENS) {
      assert.ok(!value.includes(status), `${name} must not read status token ${status}`);
    }
    return hueOf(value);
  });

  assert.equal(
    new Set(hues).size,
    AVATAR_SLOT_TOKENS.length,
    'avatar slots must use distinct hues',
  );
  const statusHues = STATUS_TOKENS.map((name) => hueOf(required(defined, name)));
  for (const hue of hues) {
    assert.ok(!statusHues.includes(hue), `avatar hue ${hue} collides with a status hue`);
  }
});

test('avatar_slot 0..4 renders --av-0..--av-4 and never a status token', () => {
  assert.equal(AVATAR_SLOTS.length, AVATAR_SLOT_TOKENS.length);

  AVATAR_SLOTS.forEach((slot) => {
    const token = AVATAR_SLOT_TOKENS[slot]!;
    assert.equal(avatarSlotToken(slot), token);

    const html = renderToStaticMarkup(createElement(Avatar, { slot, name: '成员' }));
    assert.match(html, new RegExp(`background-color:var\\(${token}\\)`), `slot ${slot} must use ${token}`);
    assert.match(html, new RegExp(`data-avatar-slot="${slot}"`));
    for (const status of STATUS_TOKENS) {
      assert.ok(!html.includes(status), `slot ${slot} must not use status token ${status}`);
    }
  });
});

test('avatar is a 7px rounded square, never a circle', async () => {
  const files = await loadCssBundle(STYLES_ENTRY);
  const allCss = files.map((file) => file.css).join('\n');

  assert.doesNotMatch(allCss, /border-radius\s*:\s*50\s*%/, 'member avatars must not be circles');

  const avatarRule = /\.avatar\s*\{([^}]*)\}/.exec(allCss)?.[1];
  assert.ok(avatarRule !== undefined, '.avatar rule is missing from the loaded stylesheet');
  assert.match(avatarRule, /border-radius\s*:\s*7px\s*;/);

  const inlineSize = /inline-size\s*:\s*(\d+)px\s*;/.exec(avatarRule)?.[1];
  const blockSize = /block-size\s*:\s*(\d+)px\s*;/.exec(avatarRule)?.[1];
  assert.ok(
    inlineSize !== undefined && blockSize !== undefined,
    '.avatar must declare explicit square dimensions',
  );
  assert.equal(inlineSize, blockSize, '.avatar must be a square');

  for (const status of STATUS_TOKENS) {
    assert.ok(!avatarRule.includes(status), `.avatar must not use status token ${status}`);
  }
});

test('avatar component never branches on status tokens', async () => {
  const source = stripComments(await readFile(AVATAR_SOURCE, 'utf8'));

  for (const status of STATUS_TOKENS) {
    assert.ok(!source.includes(status), `Avatar.ts must not reference status token ${status}`);
  }
  assert.doesNotMatch(source, /border-?[rR]adius\s*:\s*['"]?50\s*%/, 'Avatar must not render a circle');
});
