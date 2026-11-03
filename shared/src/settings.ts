/**
 * The workspace settings contract shared by the backend and the web shell.
 *
 * The three values are config, never usage facts: the backend database is the
 * single source of truth (the `setting` table), and the frontend reads the
 * same `locale` the backend renders its generated text with.
 */

/**
 * The delivered locales. M1 ships Simplified Chinese only; `en-US` is a
 * reserved catalog slot (see `RESERVED_LOCALES` in the string catalog), not a
 * delivered language.
 */
export const SUPPORTED_LOCALES = ['zh-CN'] as const;
export type Locale = (typeof SUPPORTED_LOCALES)[number];

/** Message density has exactly two readings. */
export const MESSAGE_DENSITIES = ['comfortable', 'compact'] as const;
export type MessageDensity = (typeof MESSAGE_DENSITIES)[number];

/** `system` follows the OS appearance; the other two pin it. */
export const THEMES = ['light', 'dark', 'system'] as const;
export type Theme = (typeof THEMES)[number];

/** The three settings as `GET /api/settings` returns them. */
export interface WorkspaceSettingsView {
  locale: Locale;
  density: MessageDensity;
  theme: Theme;
}
