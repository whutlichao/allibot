import type { Server } from 'node:http';
import { parseCliArgs } from './args.js';
import {
  databasePath,
  legacyDataDirWarning,
  resolveDataDir,
} from './data-dir.js';
import {
  assertServeableSchemaVersion,
  databaseExists,
  migrateDataDir,
} from './db.js';
import { HOST, startHttpServer } from './http.js';
import { acquireDataDirLock } from './lock.js';

const SHUTDOWN_GRACE_MS = 5_000;

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error) {
    console.error(`allibot: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const { command, dataDir: explicitDataDir, port } = parseCliArgs(argv);
  const resolution = resolveDataDir(explicitDataDir);
  if (resolution.origin === 'legacy') {
    console.error(legacyDataDirWarning(resolution.dataDir));
  }

  if (command === 'migrate') {
    const lock = await acquireDataDirLock(resolution.dataDir);
    try {
      const outcome = migrateDataDir(resolution.dataDir);
      if (outcome.status === 'already-current') {
        console.log(`already at schema version ${outcome.version}`);
      } else {
        console.log(`migrated ${resolution.dataDir} to schema version ${outcome.to}`);
      }
      return 0;
    } finally {
      await lock.release();
    }
  }

  if (!databaseExists(resolution.dataDir)) {
    throw new Error(
      `database not found at ${databasePath(resolution.dataDir)}; ` +
        `run \`allibot --migrate --data-dir ${resolution.dataDir}\` before starting the server`,
    );
  }

  assertServeableSchemaVersion(resolution.dataDir);

  const lock = await acquireDataDirLock(resolution.dataDir);
  try {
    const { server, port: boundPort } = await startHttpServer(port);
    console.log(`allibot server listening on http://${HOST}:${boundPort}`);

    return await waitForShutdown(server);
  } finally {
    await lock.release();
  }
}

function waitForShutdown(server: Server): Promise<number> {
  return new Promise((resolve) => {
    let stopping = false;

    const shutdown = (signal: NodeJS.Signals): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      const forceExit = setTimeout(() => process.exit(1), SHUTDOWN_GRACE_MS);
      forceExit.unref();
      server.close((error) => {
        if (error !== undefined) {
          console.error(`allibot server failed to stop on ${signal}:`, error);
          resolve(1);
          return;
        }
        resolve(0);
      });
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}
