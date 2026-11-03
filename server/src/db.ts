import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { appendMigrationRecord } from './audit.js';
import { databasePath } from './data-dir.js';

export const SCHEMA_VERSION = 1;

export type MigrationOutcome =
  | { status: 'migrated'; to: number }
  | { status: 'already-current'; version: number };

export function databaseExists(dataDir: string): boolean {
  return existsSync(databasePath(dataDir));
}

export function migrateDataDir(dataDir: string): MigrationOutcome {
  mkdirSync(dataDir, { recursive: true });

  const dbPath = databasePath(dataDir);
  const currentVersion = readSchemaVersion(dbPath);

  if (currentVersion !== null) {
    if (currentVersion === SCHEMA_VERSION) {
      return { status: 'already-current', version: currentVersion };
    }
    throw new Error(
      `schema version ${currentVersion} does not match this build's schema version ` +
        `${SCHEMA_VERSION}; refusing to migrate`,
    );
  }

  const startedAt = new Date().toISOString();
  const db = new Database(dbPath);
  try {
    db.transaction(() => {
      db.exec('CREATE TABLE schema_meta (schema_version INTEGER NOT NULL)');
      db.prepare('INSERT INTO schema_meta (schema_version) VALUES (?)').run(SCHEMA_VERSION);
    })();
  } finally {
    db.close();
  }

  appendMigrationRecord(dataDir, {
    from: null,
    to: SCHEMA_VERSION,
    result: 'ok',
    backup_path: null,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  return { status: 'migrated', to: SCHEMA_VERSION };
}

function readSchemaVersion(dbPath: string): number | null {
  if (!existsSync(dbPath)) {
    return null;
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_meta'")
      .get();
    if (table === undefined) {
      return null;
    }
    const row = db
      .prepare('SELECT schema_version FROM schema_meta')
      .get() as { schema_version: number } | undefined;
    if (row === undefined) {
      throw new Error('schema_meta is empty; refusing to migrate');
    }
    return row.schema_version;
  } finally {
    db.close();
  }
}
