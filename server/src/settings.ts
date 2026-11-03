import type { WorkspaceSettingsView } from '@allibot/shared';
import type Database from 'better-sqlite3';
import { ApiFailure } from './api-error.js';

/**
 * The delivered locale. M1 ships Simplified Chinese only; the English catalog
 * slot stays open as a text increment, never as a half-delivered second locale.
 */
export const SUPPORTED_LOCALES = ['zh-CN'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** Message density has exactly two readings. */
export const MESSAGE_DENSITIES = ['comfortable', 'compact'] as const;
export type MessageDensity = (typeof MESSAGE_DENSITIES)[number];

/** `system` follows the OS appearance; the other two pin it. */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

/** The three workspace settings, in the order the human face reads them. */
export const DEFAULT_SETTINGS: WorkspaceSettingsView = {
  locale: 'zh-CN',
  density: 'comfortable',
  theme: 'system',
};

const SETTING_KEYS = ['locale', 'density', 'theme'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

const FIELD_KEYS: Record<SettingKey, string> = {
  locale: 'locale',
  density: 'density',
  theme: 'theme',
};

/**
 * Read the persisted workspace settings. A migrated database always carries
 * all three rows; the defaults only step in when a row is missing, so a read
 * can never fail on a hand-edited database.
 */
export function getSettings(db: Database.Database): WorkspaceSettingsView {
  const rows = db.prepare('SELECT key, value FROM setting').all() as {
    key: string;
    value: string;
  }[];
  const stored = new Map(rows.map((row) => [row.key, row.value]));
  return {
    locale: parseStoredLocale(stored.get('locale')),
    density: parseStoredDensity(stored.get('density')),
    theme: parseStoredTheme(stored.get('theme')),
  };
}

/**
 * The workspace settings write path. It is not a general key-value store: only
 * the three known keys parse, unknown keys are a validation failure, and every
 * value is checked against its strict enum. The update shares one transaction
 * and writes no message, no budget row and no audit line — a setting is
 * config, not a conversation fact.
 */
export function updateSettings(db: Database.Database, body: unknown): WorkspaceSettingsView {
  const patch = parseSettingsPatch(body);
  const update = db.transaction((): void => {
    const statement = db.prepare(
      'INSERT INTO setting (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (value !== undefined) {
        statement.run(key, value);
      }
    }
  });
  update();
  return getSettings(db);
}

/**
 * The PATCH body: every known key is optional, at least one must be present,
 * and a present key must pass its enum. Anything else — an unknown key, a
 * non-string value, an array or a bare string — is a 400.
 */
function parseSettingsPatch(body: unknown): Partial<Record<SettingKey, string>> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw ApiFailure.validation('request body must be a JSON object');
  }
  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  for (const key of keys) {
    if (!(SETTING_KEYS as readonly string[]).includes(key)) {
      throw ApiFailure.validation(`unknown setting: ${key}`, { field: key });
    }
  }
  if (keys.length === 0) {
    throw ApiFailure.validation('request body must name at least one setting');
  }

  const patch: Partial<Record<SettingKey, string>> = {};
  for (const key of SETTING_KEYS) {
    const value = record[key];
    if (value === undefined) {
      continue;
    }
    patch[key] = parseSettingValue(key, value);
  }
  return patch;
}

function parseSettingValue(key: SettingKey, value: unknown): string {
  const field = FIELD_KEYS[key];
  if (typeof value !== 'string') {
    throw ApiFailure.validation(`${field} must be a string`, { field, value });
  }
  switch (key) {
    case 'locale':
      return parseLocale(value);
    case 'density':
      return parseDensity(value);
    case 'theme':
      return parseTheme(value);
  }
}

/**
 * M1 accepts one locale. Rejecting `en` and every other value keeps a client
 * from pinning a language the backend cannot render.
 */
export function parseLocale(value: string): SupportedLocale {
  const locale = SUPPORTED_LOCALES.find((candidate) => candidate === value);
  if (locale === undefined) {
    throw ApiFailure.validation(`locale must be one of: ${SUPPORTED_LOCALES.join(', ')}`, {
      field: 'locale',
      value,
    });
  }
  return locale;
}

function parseDensity(value: string): MessageDensity {
  const density = MESSAGE_DENSITIES.find((candidate) => candidate === value);
  if (density === undefined) {
    throw ApiFailure.validation(`density must be one of: ${MESSAGE_DENSITIES.join(', ')}`, {
      field: 'density',
      value,
    });
  }
  return density;
}

function parseTheme(value: string): Theme {
  const theme = THEMES.find((candidate) => candidate === value);
  if (theme === undefined) {
    throw ApiFailure.validation(`theme must be one of: ${THEMES.join(', ')}`, {
      field: 'theme',
      value,
    });
  }
  return theme;
}

/** Stored values are CHECK-constrained by the write path; the guards only make a hand-edited row readable. */
function parseStoredLocale(value: string | undefined): SupportedLocale {
  return value === undefined ? DEFAULT_SETTINGS.locale : parseLocale(value);
}

function parseStoredDensity(value: string | undefined): MessageDensity {
  if (value === undefined) {
    return DEFAULT_SETTINGS.density;
  }
  const density = MESSAGE_DENSITIES.find((candidate) => candidate === value);
  if (density === undefined) {
    throw new Error(`setting row carries an unknown density: ${value}`);
  }
  return density;
}

function parseStoredTheme(value: string | undefined): Theme {
  if (value === undefined) {
    return DEFAULT_SETTINGS.theme;
  }
  const theme = THEMES.find((candidate) => candidate === value);
  if (theme === undefined) {
    throw new Error(`setting row carries an unknown theme: ${value}`);
  }
  return theme;
}
