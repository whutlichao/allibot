import { MIGRATION_STEPS, runMigrations } from '../../dist/db.js';

/**
 * Test-only migration fixture. It appends a step that only exists in this
 * fixture process so the production schema is never touched by test tables.
 * The `v2` mode builds the version-2 baseline without the fixture step, so a
 * test can drive the real version-2 -> version-3 upgrade.
 */
const [, , mode, dataDir] = process.argv;

if ((mode !== 'ok' && mode !== 'fail' && mode !== 'v2') || dataDir === undefined) {
  console.error('usage: migrate-steps.mjs <ok|fail|v2> <data-dir>');
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

const steps = mode === 'v2' ? MIGRATION_STEPS.filter((step) => step.to <= 2) : [...MIGRATION_STEPS, fixtureStep];

try {
  const outcome = runMigrations(dataDir, steps);
  console.log(`fixture migration: ${JSON.stringify(outcome)}`);
} catch (error) {
  console.error(
    `fixture migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
