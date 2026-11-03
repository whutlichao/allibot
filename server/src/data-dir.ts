import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const DB_FILENAME = 'allibot.db';
export const MIGRATION_LEDGER_FILENAME = 'schema-migrations.jsonl';

export type DataDirOrigin = 'explicit' | 'default' | 'legacy';

export interface DataDirResolution {
  dataDir: string;
  origin: DataDirOrigin;
}

/**
 * Resolution order per the spec: explicit override, the new default only when
 * it already exists, the legacy directory as a compatibility read, and finally
 * the new default for a fresh install. Legacy data is never moved.
 */
export function resolveDataDir(
  explicit: string | undefined,
  home: string = homedir(),
): DataDirResolution {
  if (explicit !== undefined) {
    if (explicit.length === 0) {
      throw new Error('data dir must not be empty');
    }
    return { dataDir: path.resolve(explicit), origin: 'explicit' };
  }

  const defaultDir = path.join(home, '.allibot', 'data');
  if (existsSync(defaultDir)) {
    return { dataDir: defaultDir, origin: 'default' };
  }

  const legacyDir = path.join(home, 'allibot');
  if (existsSync(legacyDir)) {
    return { dataDir: legacyDir, origin: 'legacy' };
  }

  return { dataDir: defaultDir, origin: 'default' };
}

export function legacyDataDirWarning(dataDir: string): string {
  return (
    `warning: using legacy data directory ${dataDir} for compatibility reads; ` +
    'existing data is not moved. Use --data-dir or allibot_DATA_DIR to choose another directory.'
  );
}

export function databasePath(dataDir: string): string {
  return path.join(dataDir, DB_FILENAME);
}

export function migrationLedgerPath(dataDir: string): string {
  return path.join(dataDir, MIGRATION_LEDGER_FILENAME);
}
