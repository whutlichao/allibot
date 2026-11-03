import { t } from '@allibot/shared';
import type { Server } from 'node:http';
import { parseCliArgs, type CliOptions } from './args.js';
import { tFromDb } from './copy.js';
import { databasePath, resolveDataDir } from './data-dir.js';
import {
  assertServeableSchemaVersion,
  databaseExists,
  migrateDataDir,
  openDatabase,
} from './db.js';
import { HOST, startHttpServer, type OrchestrationRuntime } from './http.js';
import { acquireDataDirLock } from './lock.js';
import { createModelProvider } from './model-provider.js';
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
    // 数据目录解析发生在库打开之前，所以这条兼容读取提示用源文案的默认
    // 语言偏好渲染；库内 locale 只在库可用之后才读得到。
    console.error(t('zh-CN', 'cli.dataDir.legacyWarning', { data_dir: resolution.dataDir }));
  }

  if (command === 'migrate') {
    const lock = await acquireDataDirLock(resolution.dataDir);
    try {
      const outcome = migrateDataDir(resolution.dataDir);
      // 迁移已提交，库可直接打开；回执按库内语言偏好渲染。
      const db = openDatabase(resolution.dataDir);
      try {
        if (outcome.status === 'already-current') {
          console.log(
            tFromDb(db, 'cli.migrate.alreadyCurrent', {
              data_dir: resolution.dataDir,
              schema_version: outcome.version,
            }),
          );
        } else {
          console.log(
            tFromDb(db, 'cli.migrate.migrated', {
              data_dir: resolution.dataDir,
              schema_version: outcome.to,
            }),
          );
        }
      } finally {
        db.close();
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
    const orchestration = createOrchestration(options, db);
    const { server, port: boundPort } = await startHttpServer(
      port,
      db,
      resolution.dataDir,
      orchestration,
    );
    console.log(tFromDb(db, 'cli.serve.listening', { url: `http://${HOST}:${boundPort}` }));
    console.log(`allibot member-face adapter: ${orchestration.provider.name}`);

    return await waitForShutdown(server);
  } finally {
    db.close();
    await lock.release();
  }
}

/**
 * The member-face adapter is selected at startup, exactly once, and handed to
 * the HTTP layer. The scripted double is the default (D4.3); `--provider model`
 * selects the real Anthropic / OpenAI adapter, which still refuses to call out
 * until the provider's remote-data-flow consent is recorded and its credential
 * is present in the environment.
 */
function createOrchestration(
  options: CliOptions,
  db: ReturnType<typeof openDatabase>,
): OrchestrationRuntime {
  const provider =
    options.providerMode === 'model'
      ? createModelProvider(db, process.env)
      : createScriptedProvider({
          behavior: options.scriptedProvider,
          delayMs: options.scriptedDelayMs,
          replies: options.scriptedReplies.length > 0 ? options.scriptedReplies : undefined,
        });
  return { provider, inFlight: createInFlightRounds() };
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
