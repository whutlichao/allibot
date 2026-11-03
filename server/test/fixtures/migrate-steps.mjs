import { MIGRATION_STEPS, runMigrations } from '../../dist/db.js';

/**
 * Test-only migration fixture. It appends a step that only exists in this
 * fixture process so the production schema is never touched by test tables.
 * The `vN` modes build the version-N baseline without the fixture step, so a
 * test can drive the real version-N -> version-N+1 upgrade.
 */
const [, , mode, dataDir] = process.argv;

const BASELINE_MODES = new Set(['v2', 'v3', 'v4']);

if ((mode !== 'ok' && mode !== 'fail' && !BASELINE_MODES.has(mode ?? '')) || dataDir === undefined) {
  console.error('usage: migrate-steps.mjs <ok|fail|v2|v3|v4> <data-dir>');
  process.exit(2);
}

const tail = MIGRATION_STEPS[MIGRATION_STEPS.length - 1];
const fixtureStep = {
  to: (tail === undefined ? 0 : tail.to) + 1,
  apply(db) {
    db.exec('CREATE TABLE fixture_business (id INTEGER PRIMARY KEY)');
    if (mode === 'fail') {
      throw new Error('injected migration step failure');
    }
  },
};

const steps = BASELINE_MODES.has(mode)
  ? MIGRATION_STEPS.filter((step) => step.to <= Number(mode.slice(1)))
  : [...MIGRATION_STEPS, fixtureStep];

try {
  const outcome = runMigrations(dataDir, steps);
  console.log(`fixture migration: ${JSON.stringify(outcome)}`);
} catch (error) {
  console.error(
    `fixture migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
