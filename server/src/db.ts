import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync } from 'node:fs';
import { appendMigrationRecord } from './audit.js';
import { createDataDirBackup } from './backup.js';
import { databasePath } from './data-dir.js';
import { LOCK_FILENAME } from './lock.js';

export const SCHEMA_VERSION = 3;

export interface MigrationStep {
  readonly to: number;
  apply: (db: Database.Database) => void;
}

/**
 * The owner row seeded by this migration. It is a write-path invariant of the
 * migration itself: the empty database always has exactly one human member,
 * and no HTTP route creates it.
 */
const OWNER_DISPLAY_NAME = '我';
const OWNER_AVATAR_SLOT = 0;

/**
 * The production step chain. Every future schema change appends exactly one
 * step at the tail with the next strict +1 number; the baseline step creates
 * schema_meta. Test-only fixtures pass their own appended step instead of
 * changing this chain.
 */
export const MIGRATION_STEPS: readonly MigrationStep[] = [
  {
    to: 1,
    apply(db) {
      db.exec('CREATE TABLE schema_meta (schema_version INTEGER NOT NULL)');
      db.prepare('INSERT INTO schema_meta (schema_version) VALUES (?)').run(1);
    },
  },
  {
    to: 2,
    apply(db) {
      db.exec(`
        CREATE TABLE member (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('owner', 'agent')),
          display_name TEXT NOT NULL,
          avatar_slot INTEGER NOT NULL CHECK (avatar_slot BETWEEN 0 AND 4),
          deleted_at TEXT,
          created_at TEXT NOT NULL
        );

        -- The owner is the single human row; a fresh database has exactly one.
        CREATE UNIQUE INDEX member_single_owner ON member (kind) WHERE kind = 'owner';

        CREATE TABLE agent_config (
          member_id TEXT PRIMARY KEY REFERENCES member (id),
          role TEXT NOT NULL DEFAULT '',
          model TEXT,
          system_prompt TEXT NOT NULL DEFAULT '',
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
          context_window INTEGER NOT NULL CHECK (context_window > 0),
          compression_threshold REAL NOT NULL CHECK (
            compression_threshold > 0 AND compression_threshold <= 1
          ),
          max_iterations INTEGER NOT NULL CHECK (max_iterations > 0),
          auto_claim INTEGER NOT NULL DEFAULT 1 CHECK (auto_claim IN (0, 1))
        );
      `);
      db.prepare(
        `INSERT INTO member (id, kind, display_name, avatar_slot, deleted_at, created_at)
         VALUES (?, 'owner', ?, ?, NULL, ?)`,
      ).run(randomUUID(), OWNER_DISPLAY_NAME, OWNER_AVATAR_SLOT, new Date().toISOString());
    },
  },
  {
    to: 3,
    apply(db) {
      db.exec(`
        CREATE TABLE channel (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL CHECK (mode IN ('autonomous')),
          response_budget_limit INTEGER NOT NULL DEFAULT 3 CHECK (response_budget_limit IN (3, 5, 10)),
          archived_at TEXT,
          deleted_at TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        -- target is the scope key for messages, read positions, response budgets
        -- and round results. A channel-type target is a shadow row reusing
        -- channel.id: target.id == channel.id and kind = 'channel'.
        CREATE TABLE target (
          id TEXT PRIMARY KEY,
          kind TEXT NOT NULL CHECK (kind IN ('channel', 'dm', 'task'))
        );

        -- The single membership ledger for every target kind. Channel members
        -- are its rows read on a channel-type target.
        CREATE TABLE target_member (
          target_id TEXT NOT NULL REFERENCES target (id),
          member_id TEXT NOT NULL REFERENCES member (id),
          PRIMARY KEY (target_id, member_id)
        );
      `);
    },
  },
];

export type MigrationOutcome =
  | { status: 'migrated'; from: number | null; to: number; backupPath: string | null }
  | { status: 'already-current'; version: number };

export function databaseExists(dataDir: string): boolean {
  return existsSync(databasePath(dataDir));
}

export function migrateDataDir(dataDir: string): MigrationOutcome {
  return runMigrations(dataDir, MIGRATION_STEPS);
}

/**
 * Execute a migration step chain against a data directory. A non-empty data
 * directory is backed up to a sibling directory first; backup failure aborts
 * the migration. All schema steps and the version bump share one transaction,
 * and the audit ledger gains exactly one record per attempted migration.
 *
 * Exported for the test-only migration fixture: production callers go through
 * the CLI, which passes the production chain.
 */
export function runMigrations(
  dataDir: string,
  steps: readonly MigrationStep[] = MIGRATION_STEPS,
): MigrationOutcome {
  mkdirSync(dataDir, { recursive: true });

  const dbPath = databasePath(dataDir);
  const currentVersion = readSchemaVersion(dbPath);
  const targetVersion = steps[steps.length - 1]?.to ?? 0;

  if (currentVersion !== null && currentVersion === targetVersion) {
    return { status: 'already-current', version: currentVersion };
  }
  if (currentVersion !== null && currentVersion > targetVersion) {
    throw new Error(
      `version_mismatch: database schema version ${currentVersion} is newer than this build's ` +
        `schema version ${targetVersion}; refusing to migrate, there is no downgrade path`,
    );
  }

  const startedAt = new Date().toISOString();
  const pendingSteps = steps.filter((step) => step.to > (currentVersion ?? 0));
  let backupPath: string | null = null;

  try {
    if (!isDataDirEmpty(dataDir)) {
      backupPath = createDataDirBackup(dataDir, startedAt);
    }

    const db = new Database(dbPath);
    try {
      db.transaction(() => {
        for (const step of pendingSteps) {
          step.apply(db);
        }
        db.prepare('UPDATE schema_meta SET schema_version = ?').run(targetVersion);
      })();
    } finally {
      db.close();
    }
  } catch (error) {
    appendMigrationRecord(dataDir, {
      from: currentVersion,
      to: targetVersion,
      result: 'failed',
      reason: errorMessage(error),
      backup_path: backupPath,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
    });
    throw error;
  }

  appendMigrationRecord(dataDir, {
    from: currentVersion,
    to: targetVersion,
    result: 'ok',
    backup_path: backupPath,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
  });

  return { status: 'migrated', from: currentVersion, to: targetVersion, backupPath };
}

/**
 * Open the migrated database of a data directory for the serving process.
 * better-sqlite3 enables foreign keys by default; the server keeps that on so
 * `agent_config.member_id` cannot point at a missing member.
 */
export function openDatabase(dataDir: string): Database.Database {
  const db = new Database(databasePath(dataDir));
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * The version gate for the serve path: a database older than the code has to
 * be migrated explicitly, and a database newer than the code has no downgrade
 * path. The check is read-only, so a refused database is left byte-identical.
 */
export function assertServeableSchemaVersion(dataDir: string): void {
  const version = readSchemaVersion(databasePath(dataDir));
  if (version === null || version < SCHEMA_VERSION) {
    const found = version === null ? 'has no schema version' : `is at schema version ${version}`;
    throw new Error(
      `version_mismatch: database ${found} but this build expects schema version ${SCHEMA_VERSION}; ` +
        `run \`allibot --migrate --data-dir ${dataDir}\` before starting the server`,
    );
  }
  if (version > SCHEMA_VERSION) {
    throw new Error(
      `version_mismatch: database schema version ${version} is newer than this build's ` +
        `schema version ${SCHEMA_VERSION}; refusing to start, there is no downgrade path`,
    );
  }
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

/**
 * The single-writer lock is runtime state, not data: a directory holding only
 * the lock file counts as empty, so initializing it needs no backup.
 */
function isDataDirEmpty(dataDir: string): boolean {
  return readdirSync(dataDir).every((entry) => entry === LOCK_FILENAME);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
