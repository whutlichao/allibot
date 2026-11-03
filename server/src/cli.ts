import type { Server } from 'node:http';
import { parseCliArgs, type CliOptions } from './args.js';
import {
  databasePath,
  legacyDataDirWarning,
  resolveDataDir,
} from './data-dir.js';
import {
  assertServeableSchemaVersion,
  databaseExists,
  migrateDataDir,
  openDatabase,
} from './db.js';
import { HOST, startHttpServer, type OrchestrationRuntime } from './http.js';
import { acquireDataDirLock } from './lock.js';
import { createInFlightRounds } from './rounds.js';
import { createScriptedProvider } from './scripted-provider.js';

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
  const options = parseCliArgs(argv);
  const { command, port } = options;
  const resolution = resolveDataDir(options.dataDir);
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
  const db = openDatabase(resolution.dataDir);
  try {
    const orchestration = createOrchestration(options);
    const { server, port: boundPort } = await startHttpServer(
      port,
      db,
      resolution.dataDir,
      orchestration,
    );
    console.log(`allibot server listening on http://${HOST}:${boundPort}`);
    console.log(`allibot member-face adapter: ${orchestration.provider.name}`);

    return await waitForShutdown(server);
  } finally {
    db.close();
    await lock.release();
  }
}

/**
 * The member-face adapter is selected at startup, exactly once, and handed to
 * the HTTP layer. A later ticket adds the real provider adapter here; nothing
 * downstream branches on which one is live.
 */
function createOrchestration(options: CliOptions): OrchestrationRuntime {
  return {
    provider: createScriptedProvider({
      behavior: options.scriptedProvider,
      delayMs: options.scriptedDelayMs,
      replies: options.scriptedReplies.length > 0 ? options.scriptedReplies : undefined,
    }),
    inFlight: createInFlightRounds(),
  };
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
