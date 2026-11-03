import { MIGRATION_STEPS, runMigrations } from '../../dist/db.js';

/**
 * Test-only migration fixture. It appends a step that only exists in this
 * fixture process so the production schema is never touched by test tables.
 */
const [, , mode, dataDir] = process.argv;

if ((mode !== 'ok' && mode !== 'fail') || dataDir === undefined) {
  console.error('usage: migrate-steps.mjs <ok|fail> <data-dir>');
  process.exit(2);
}

const fixtureStep = {
  to: 2,
  apply(db) {
    db.exec('CREATE TABLE fixture_business (id INTEGER PRIMARY KEY)');
    if (mode === 'fail') {
      throw new Error('injected migration step failure');
    }
  },
};

try {
  const outcome = runMigrations(dataDir, [...MIGRATION_STEPS, fixtureStep]);
  console.log(`fixture migration: ${JSON.stringify(outcome)}`);
} catch (error) {
  console.error(
    `fixture migration failed: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
}
