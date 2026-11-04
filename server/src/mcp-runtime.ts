import type Database from 'better-sqlite3';
import { mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import type {
  RoundMcpCallResult,
  RoundMcpContext,
  RoundMcpServer,
} from './agent-seam.js';
import {
  createHttpMcpClient,
  createSseMcpClient,
  createStdioMcpClient,
  newMcpToolCallId,
  type McpClient,
} from './mcp-client.js';
import { tFromDb } from './copy.js';
import { hasMcpConsent, mcpFilePath, readMcpFile } from './mcp-file.js';
import {
  containerToolEnvironment,
  type DockerContainerHandle,
} from './docker-workspace.js';
import { stableJson } from './permissions.js';
import { createToolGate } from './tool-gate.js';
import { readTargetPermissionContext } from './permissions.js';
import type { McpServerEntry } from '@allibot/shared';

/**
 * 运行期 MCP 装配 (#47 / D6.1 / ADR-0008).
 *
 * One round assembles from the Agent-home `mcp.json` only:
 * - a missing file is zero MCP, no error;
 * - an invalid file is whole-file zero MCP plus a readable diagnostic (never a
 *   half set);
 * - a disabled entry is skipped;
 * - an enabled http / sse entry without its `('mcp', name)` consent row is not
 *   connected at all (zero request), with a readable diagnostic; stdio needs
 *   no consent;
 * - the host cwd is the project root when one exists, otherwise a disposable
 *   `<data_dir>/mcp-hosts/<session_id>/` directory (not a project workspace and
 *   not a file-tool root), removed when the round releases its connections;
 * - in the Docker backend stdio servers run inside the Agent container via
 *   `docker exec -i` (#49). This ticket only assembles the local host and the
 *   host-side http / sse connections; the container lifecycle is not here.
 *
 * Every tool call goes through the one #44 tool gate as an execution-class
 * call (`mcp:<server>/<tool>` with stable JSON arguments). A denial is a
 * `DENIED` result, not a round error.
 */

export interface BuildRoundMcpOptions {
  db: Database.Database;
  dataDir: string;
  memberId: string;
  /** The round's stable reply id; also names the disposable host directory. */
  sessionId: string;
  targetId: string;
  contextKind: 'round' | 'team-assignment' | 'sop';
  contextId: string | null;
  /** The usable project root, or null for a DM / rootless target. */
  projectRoot: string | null;
  env: NodeJS.ProcessEnv;
  /**
   * The Docker round's container (#49): stdio servers run inside it via
   * `docker exec -i` with cwd `/workspace`; http / sse servers are always
   * connected by the host process and ignore this handle.
   */
  stdioContainer?: DockerContainerHandle | null;
  timeoutMs?: number;
  /** A SOP approval has no target; ordinary / team rounds keep the target. */
  approvalTargetId?: string | null;
  onApprovalWait?: () => void;
  onApprovalSettled?: () => void;
}

interface ConnectedServer {
  entry: McpServerEntry;
  client: McpClient;
}

export async function buildRoundMcp(
  options: BuildRoundMcpOptions,
): Promise<RoundMcpContext | null> {
  const file = readMcpFile(mcpFilePath(options.memberId, options.env), options.db);
  if (!file.present && file.diagnostic === null) {
    // 文件缺失 = 本轮不装配 MCP，不报错.
    return null;
  }
  if (file.diagnostic !== null) {
    // 文件非法 = 整份不装配，零连接，可读提示只进 reason / 管理面诊断.
    return diagnosticOnlyContext(file.diagnostic);
  }

  const enabled = file.entries.filter((entry) => entry.enabled);
  const hostRoot =
    options.projectRoot ??
    (enabled.length === 0
      ? null
      : path.join(options.dataDir, 'mcp-hosts', options.sessionId));
  if (hostRoot !== null && options.projectRoot === null) {
    mkdirSync(hostRoot, { recursive: true, mode: 0o700 });
  }

  const permission = readTargetPermissionContext(
    options.db,
    options.memberId,
    options.targetId,
  );
  if (permission === null) {
    return diagnosticOnlyContext(
      tFromDb(options.db, 'mcp.runtime.permissionContextMissing', {
        target_id: options.targetId,
      }),
    );
  }
  const gate = createToolGate({
    db: options.db,
    permission,
    replyId: options.sessionId,
    contextKind: options.contextKind,
    contextId: options.contextId,
    approvalTargetId: options.approvalTargetId,
    onApprovalWait: options.onApprovalWait,
    onApprovalSettled: options.onApprovalSettled,
  });

  const diagnostics: string[] = [];
  const connected: ConnectedServer[] = [];
  const servers: RoundMcpServer[] = [];

  for (const entry of enabled) {
    if (entry.transport !== 'stdio' && !hasMcpConsent(options.db, entry.name)) {
      diagnostics.push(
        tFromDb(options.db, 'mcp.runtime.remoteUnconfirmed', {
          name: entry.name,
          transport: entry.transport,
        }),
      );
      continue;
    }
    let client: McpClient;
    try {
      client = createClient(entry, hostRoot, options);
    } catch (error) {
      diagnostics.push(
        tFromDb(options.db, 'mcp.runtime.assembleFailed', {
          name: entry.name,
          detail: messageOf(error),
        }),
      );
      continue;
    }
    try {
      await client.initialize();
      const tools = await client.listTools();
      connected.push({ entry, client });
      servers.push({ name: entry.name, transport: entry.transport, tools });
    } catch (error) {
      diagnostics.push(
        tFromDb(options.db, 'mcp.runtime.connectFailed', {
          name: entry.name,
          detail: shortDiagnostic(messageOf(error)),
        }),
      );
      await client.close().catch(() => undefined);
    }
  }

  return {
    host_root: hostRoot,
    servers,
    diagnostics,
    async callTool(serverName, toolName, args) {
      const target = connected.find((server) => server.entry.name === serverName);
      if (target === undefined) {
        return {
          ok: false,
          error: 'unknown-server',
          message: tFromDb(options.db, 'mcp.runtime.serverMissing', { name: serverName }),
        };
      }
      const request = {
        tool_name: `mcp:${serverName}/${toolName}`,
        pattern: stableJson(args),
        tool_call_id: newMcpToolCallId(),
        arguments: args,
      };
      const decision = await gate.authorize(request);
      if (decision === 'denied') {
        return { ok: false, error: 'denied', message: 'DENIED' };
      }
      try {
        const result = await target.client.callTool(toolName, args);
        return {
          ok: !result.is_error,
          content: result.content,
          ...(result.is_error ? { error: 'tool-error' as const } : {}),
        };
      } catch (error) {
        return {
          ok: false,
          error: 'connection',
          message: shortDiagnostic(messageOf(error)),
        };
      }
    },
    async close() {
      await Promise.all(
        connected.map((server) => server.client.close().catch(() => undefined)),
      );
      if (options.projectRoot === null && hostRoot !== null) {
        // The disposable runtime host is not business data: drop it with the
        // round's connections so mcp-hosts/ does not grow one directory per
        // round.
        rmSync(hostRoot, { recursive: true, force: true });
      }
    },
  };
}

/** Release the round's MCP host connections; safe for a null context. */
export async function closeRoundMcp(
  context: RoundMcpContext | null | undefined,
): Promise<void> {
  await context?.close().catch(() => undefined);
}

function createClient(
  entry: McpServerEntry,
  hostRoot: string | null,
  options: BuildRoundMcpOptions,
): McpClient {
  if (entry.transport === 'stdio') {
    const command = entry.command ?? '';
    const args = entry.args ?? [];
    const envNames = entry.env_names ?? [];
    const container = options.stdioContainer ?? null;
    if (container !== null) {
      // Docker backend: the stdio server is a process inside the Agent
      // container, not a host child. Only the allowlist + declared env_names
      // reach it; the container environment is built by the manager.
      return createStdioMcpClient({
        command,
        args,
        cwd: '/workspace',
        env: options.env,
        envNames,
        timeoutMs: options.timeoutMs,
        label: `${entry.name} (container)`,
        spawnProcess: () =>
          container.spawn([command, ...args], {
            workdir: '/workspace',
            env: containerToolEnvironment(options.env, envNames, '/workspace'),
          }),
      });
    }
    if (hostRoot === null) {
      throw new Error('no MCP host directory');
    }
    return createStdioMcpClient({
      command,
      args,
      cwd: hostRoot,
      env: options.env,
      envNames,
      timeoutMs: options.timeoutMs,
    });
  }
  const url = entry.url ?? '';
  return entry.transport === 'http'
    ? createHttpMcpClient({ url, timeoutMs: options.timeoutMs })
    : createSseMcpClient({ url, timeoutMs: options.timeoutMs });
}

/**
 * The union of the enabled servers' declared `env_names` (D6.1). The names come
 * from the one mcp.json; a missing or invalid file declares nothing. The shell
 * and file-tool processes get exactly these names on top of the allowlist.
 */
export function readDeclaredEnvNames(
  db: Database.Database,
  memberId: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const file = readMcpFile(mcpFilePath(memberId, env), db);
  if (!file.present || file.diagnostic !== null) {
    return [];
  }
  const names = new Set<string>();
  for (const entry of file.entries) {
    if (!entry.enabled) {
      continue;
    }
    for (const name of entry.env_names ?? []) {
      names.add(name);
    }
  }
  return [...names];
}

function diagnosticOnlyContext(diagnostic: string): RoundMcpContext {
  return {
    host_root: null,
    servers: [],
    diagnostics: [diagnostic],
    async callTool() {
      return {
        ok: false,
        error: 'unavailable',
        message: diagnostic,
      };
    },
    async close() {
      return undefined;
    },
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function shortDiagnostic(message: string): string {
  return message.length <= 300 ? message : `${message.slice(0, 300)}…`;
}

export type { RoundMcpCallResult };
