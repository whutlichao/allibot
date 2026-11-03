import { cpSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import { LOCK_FILENAME } from './lock.js';

/**
 * Copy the whole data directory to a sibling directory named after the
 * migration start time. The lock file is runtime state rather than data, so
 * it is dropped from the copy; everything else (database, attachment bytes,
 * audit ledger) is copied byte for byte.
 */
export function createDataDirBackup(dataDir: string, startedAt: string): string {
  const stamp = startedAt.replaceAll(':', '-').replaceAll('.', '-');
  const backupPath = path.join(
    path.dirname(dataDir),
    `${path.basename(dataDir)}.backup-${stamp}`,
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
