/**
 * The shared Skill limits and identifiers (#48 / D6.3). They live in their own
 * module so the zip reader and the installer share one definition without an
 * import cycle.
 */
export const MAX_SKILL_FILES = 200;
export const MAX_SKILL_TOTAL_BYTES = 5 * 1024 * 1024;
export const MAX_SKILL_ZIP_BYTES = 5 * 1024 * 1024;
export const SKILL_MANIFEST = 'SKILL.md';
/** AgentScope's skill name is a prompt identifier: one path-free short slug. */
export const SKILL_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
