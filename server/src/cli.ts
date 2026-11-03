import { t } from '@allibot/shared';
import type { Server } from 'node:http';
import { parseCliArgs } from './args.js';
import { databasePath, resolveDataDir } from './data-dir.js';
import { tFromDb } from './copy.js';
import {
  assertServeableSchemaVersion,
  databaseExists,
  migrateDataDir,
  openDatabase,
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
    const { server, port: boundPort } = await startHttpServer(port, db);
    console.log(
      tFromDb(db, 'cli.serve.listening', { url: `http://${HOST}:${boundPort}` }),
    );

    return await waitForShutdown(server);
  } finally {
    db.close();
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
