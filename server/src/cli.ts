import { t } from '@allibot/shared';
import type { Server } from 'node:http';
import { parseCliArgs, type CliOptions } from './args.js';
import { expirePendingApprovals, setApprovalTimeoutMs } from './approvals.js';
import { setClock } from './clock.js';
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
import { setShellEnvNames } from './local-shell.js';
import { runMcpExport } from './mcp-export.js';
import { runSkillMigration } from './skill-migrate.js';
import { createModelProvider } from './model-provider.js';
import { startReminderScheduler } from './reminders.js';
import { createInFlightRounds } from './rounds.js';
import { createScriptedProvider } from './scripted-provider.js';
import { closeInterruptedSopRuns } from './sop-executor.js';
import { closeInterruptedTeamRuns } from './team-runs.js';

const SHUTDOWN_GRACE_MS = 5_000;

export async function main(argv: readonly string[]): Promise<number> {
  try {
    return await run(argv);
  } catch (error) {
    // The database may not be open yet (a refused migration, a missing data
    // dir), so the error line renders through the default catalog rather than
    // the in-database locale.
    console.error(
      t('zh-CN', 'cli.error', {
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    return 1;
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const options = parseCliArgs(argv);
  // 全局层根 (#43 / D5.2): `--home-dir` is the process-level override and wins
  // over `allibot_HOME_DIR`. Exporting it into the process environment keeps one
  // derivation (`workspaceHomeRoot`) for rules, Agent homes and the skills
  // second root; nothing writes this value to the database.
  if (options.homeDir !== undefined) {
    process.env.allibot_HOME_DIR = options.homeDir;
  }
  if (options.fixedClock !== undefined) {
    // 固定时钟 injection: one process-wide instant, selected at startup like
    // the scripted adapter. Production keeps the wall clock.
    const instant = options.fixedClock;
    setClock(() => new Date(instant));
  }
  setApprovalTimeoutMs(options.approvalTimeoutMs);
  // 本地 shell 环境 (#46 / D5.4): the declared `env_names` merge point. #47
  // sources these from the member's mcp.json; the startup injection is the
  // documented stand-in until then. Names only, never values.
  setShellEnvNames(options.shellEnvNames);
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

  if (command === 'export-mcp') {
    if (!databaseExists(resolution.dataDir)) {
      throw new Error(
        t('zh-CN', 'cli.serve.databaseMissing', {
          path: databasePath(resolution.dataDir),
          data_dir: resolution.dataDir,
        }),
      );
    }
    assertServeableSchemaVersion(resolution.dataDir);
    const lock = await acquireDataDirLock(resolution.dataDir);
    const db = openDatabase(resolution.dataDir);
    try {
      const outcome = runMcpExport(db, process.env, {
        apply: options.apply,
        yes: options.yes,
      });
      for (const line of outcome.lines) {
        console.log(line);
      }
      return outcome.exitCode;
    } finally {
      db.close();
      await lock.release();
    }
  }

  if (command === 'migrate-skills') {
    if (!databaseExists(resolution.dataDir)) {
      throw new Error(
        t('zh-CN', 'cli.serve.databaseMissing', {
          path: databasePath(resolution.dataDir),
          data_dir: resolution.dataDir,
        }),
      );
    }
    assertServeableSchemaVersion(resolution.dataDir);
    const lock = await acquireDataDirLock(resolution.dataDir);
    const db = openDatabase(resolution.dataDir);
    try {
      const outcome = runSkillMigration(db, resolution.dataDir, process.env, {
        apply: options.apply,
        yes: options.yes,
      });
      for (const line of outcome.lines) {
        console.log(line);
      }
      return outcome.exitCode;
    } finally {
      db.close();
      await lock.release();
    }
  }

  if (!databaseExists(resolution.dataDir)) {
    throw new Error(
      t('zh-CN', 'cli.serve.databaseMissing', {
        path: databasePath(resolution.dataDir),
        data_dir: resolution.dataDir,
      }),
    );
  }

  assertServeableSchemaVersion(resolution.dataDir);

  const lock = await acquireDataDirLock(resolution.dataDir);
  const db = openDatabase(resolution.dataDir);
  // 运行记录 (#38 / D3.3): a residual `running` run belongs to a round the
  // previous process never concluded. It closes as failed/interrupted before
  // the server accepts work; nothing is replayed or refunded.
  closeInterruptedTeamRuns(db);
  // SOP 重启收口 (D4.3): a running / awaiting run (and a pending one whose
  // scheduled worker died with the old process) closes failed/interrupted; no
  // step is replayed across a restart.
  closeInterruptedSopRuns(db);
  // 审批重启收口 (D5.6): a pending approval belongs to a round the previous
  // process never concluded. It closes `expired`; no waiter survives a restart.
  expirePendingApprovals(db);
  // 提醒到点 is a backend fact, not a request: the process ticks on its own.
  // The first pass runs now, so a restart catches up overdue reminders.
  const stopReminders = startReminderScheduler(db, options.reminderTickMs);
  try {
    const orchestration = createOrchestration(options, db);
    // The adapter line precedes the listening line: a caller that waits for
    // "listening" has already seen which face is live.
    console.log(
      tFromDb(db, 'cli.serve.adapter', { adapter: orchestration.provider.name }),
    );
    const { server, port: boundPort } = await startHttpServer(
      port,
      db,
      resolution.dataDir,
      orchestration,
      { sseLifetimeMs: options.sseLifetimeMs },
    );
    console.log(tFromDb(db, 'cli.serve.listening', { url: `http://${HOST}:${boundPort}` }));

    return await waitForShutdown(server);
  } finally {
    stopReminders();
    db.close();
    await lock.release();
  }
}

/**
 * The member-face adapter is selected at startup, exactly once, and handed to
 * the HTTP layer. The real Anthropic / OpenAI adapter is the default; it
 * refuses to call out until the provider's remote-data-flow consent is
 * recorded and its credential is present in the environment. The scripted
 * double (D4.3) is selected only by an explicit test-injection argument.
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
          echoPrompt: options.scriptedEchoPrompt,
          reportContext: options.scriptedReportContext,
          reportCalls: options.scriptedReportCalls,
          reportTeam: options.scriptedReportTeam,
          teamAssignMemberIds: options.scriptedTeamAssignMemberIds,
          teamAssignInstruction: options.scriptedTeamAssignInstruction,
          teamMemberFail: options.scriptedTeamMemberFail,
          transferMemberId: options.scriptedTransferMemberId,
          shellCommands: options.scriptedShellCommands,
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
      // An open subscription is a long-lived response; shutting down must not
      // wait for its rotation. Dropping the sockets lets `close` finish now.
      server.closeAllConnections();
    };

    process.once('SIGTERM', () => shutdown('SIGTERM'));
    process.once('SIGINT', () => shutdown('SIGINT'));
  });
}
