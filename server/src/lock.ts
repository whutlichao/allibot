import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export const LOCK_FILENAME = '.allibot.lock';
const ACQUIRE_ATTEMPTS = 50;
const RETRY_DELAY_MS = 10;
const INCOMPLETE_LOCK_GRACE_MS = 5_000;

export class DataDirInUseError extends Error {
  constructor(dataDir: string, pid: number | null) {
    super(
      pid === null
        ? `data directory is already in use: ${dataDir}`
        : `data directory is already in use: ${dataDir} (held by pid ${pid})`,
    );
    this.name = 'DataDirInUseError';
  }
}

export interface DataDirLock {
  release: () => Promise<void>;
}

interface LockRecord {
  pid: number;
  started_at: string;
}

type LockState = 'missing' | 'incomplete' | LockRecord;

/**
 * A single backend may write a data directory. The lock file carries the
 * holder pid, so a lock left behind by a crashed process is recovered instead
 * of deadlocking the directory.
 */
export async function acquireDataDirLock(dataDir: string): Promise<DataDirLock> {
  await mkdir(dataDir, { recursive: true });
  const lockPath = path.join(dataDir, LOCK_FILENAME);

  for (let attempt = 0; attempt < ACQUIRE_ATTEMPTS; attempt += 1) {
    try {
      const handle = await open(lockPath, 'wx');
      try {
        const record: LockRecord = {
          pid: process.pid,
          started_at: new Date().toISOString(),
        };
        await handle.writeFile(JSON.stringify(record), 'utf8');
      } finally {
        await handle.close();
      }
      return { release: async (): Promise<void> => releaseLock(lockPath) };
    } catch (error) {
      if (!isErrno(error, 'EEXIST')) {
        throw error;
      }

      const state = await inspectLock(lockPath);
      if (state === 'missing') {
        await delay(RETRY_DELAY_MS);
        continue;
      }
      if (state === 'incomplete') {
        const ageMs = await lockAgeMs(lockPath);
        if (ageMs !== null && ageMs < INCOMPLETE_LOCK_GRACE_MS) {
          throw new DataDirInUseError(dataDir, null);
        }
        await removeLockFile(lockPath);
        continue;
      }
      if (isProcessAlive(state.pid)) {
        throw new DataDirInUseError(dataDir, state.pid);
      }
      await removeLockFile(lockPath);
    }
  }

  throw new DataDirInUseError(dataDir, null);
}

async function releaseLock(lockPath: string): Promise<void> {
  const state = await inspectLock(lockPath);
  if (state === 'missing') {
    return;
  }
  if (state === 'incomplete' || state.pid === process.pid) {
    await removeLockFile(lockPath);
  }
}

async function inspectLock(lockPath: string): Promise<LockState> {
  let raw: string;
  try {
    raw = await readFile(lockPath, 'utf8');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return 'missing';
    }
    throw error;
  }

  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'pid' in parsed &&
      typeof parsed.pid === 'number' &&
      Number.isInteger(parsed.pid) &&
      parsed.pid > 0
    ) {
      return parsed as LockRecord;
    }
  } catch {
    // Fall through to the incomplete state.
  }
  return 'incomplete';
}

async function lockAgeMs(lockPath: string): Promise<number | null> {
  try {
    const info = await stat(lockPath);
    return Date.now() - info.mtimeMs;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      return null;
    }
    throw error;
  }
}

async function removeLockFile(lockPath: string): Promise<void> {
  try {
    await unlink(lockPath);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) {
      throw error;
    }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, 'EPERM');
  }
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
