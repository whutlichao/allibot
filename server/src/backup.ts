import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { LOCK_FILENAME } from './lock.js';

/**
 * Copy the whole data directory to a sibling directory named after the
 * migration start time. The lock file is runtime state rather than data, so
 * it is dropped from the copy; everything else (database, attachment bytes,
 * audit ledger) is copied byte for byte.
 *
 * `label` distinguishes a non-schema migration (`migrate-skills` uses
 * `skills`) from the schema runner's default name.
 */
export function createDataDirBackup(dataDir: string, startedAt: string, label?: string): string {
  const stamp = startedAt.replaceAll(':', '-').replaceAll('.', '-');
  const suffix = label === undefined ? '' : `${label}-`;
  const backupPath = path.join(
    path.dirname(dataDir),
    `${path.basename(dataDir)}.backup-${suffix}${stamp}`,
  );

  if (existsSync(backupPath)) {
    throw new Error(`backup directory already exists: ${backupPath}`);
  }

  try {
    cpSync(dataDir, backupPath, { recursive: true });
    rmSync(path.join(backupPath, LOCK_FILENAME), { force: true });
  } catch (error) {
    try {
      rmSync(backupPath, { recursive: true, force: true });
    } catch {
      // Best effort: keep the original failure below.
    }
    throw error;
  }

  return backupPath;
}
