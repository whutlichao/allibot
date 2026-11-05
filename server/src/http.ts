import { apiError } from '@allibot/shared';
import type Database from 'better-sqlite3';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import { ApiFailure } from './api-error.js';
import {
  decideApproval,
  getApproval,
  listApprovals,
  parseApprovalQuery,
} from './approvals.js';
import {
  maxUploadEnvelopeBytes,
  readAttachment,
  uploadAttachment,
} from './attachments.js';
import { createCopilotKitHandler, isCopilotKitPath } from './copilotkit.js';
import {
  DEFAULT_SSE_LIFETIME_MS,
  eventHub,
  formatSseFrame,
  SSE_ROTATE_EVENT,
} from './events.js';
import { readAgentRules } from './agent-home.js';
import { readAgentMcp, replaceAgentMcp } from './mcp-file.js';
import {
  archiveChannel,
  assertChannelReadable,
  assertChannelWritable,
  createChannel,
  deleteChannel,
  getChannel,
  listChannels,
  updateChannel,
} from './channels.js';
import {
  createAgent,
  getAgent,
  listAgents,
  softDeleteAgent,
  updateAgent,
} from './members.js';
import { createDm, listDms } from './dms.js';
import { appendMessageAndDispatch, listMessages, parseMessageRequest, parsePageQuery } from './messages.js';
import {
  confirmProviderConsent,
  confirmRemoteConsent,
  parseConsentScope,
  parseProviderParam,
  remoteDataFlowView,
} from './providers.js';
import { createReminder, deleteReminder, listReminders } from './reminders.js';
import { dispatchWakes, type OrchestrationRuntime } from './rounds.js';
import { parseSearchQuery, searchWorkspace } from './search.js';
import { getSettings, updateSettings } from './settings.js';
import {
  claimTask,
  createTask,
  getTask,
  listTasks,
  parseTaskQuery,
  updateTask,
} from './tasks.js';
import {
  joinChannel,
  listChannelMembers,
  listTargetMembers,
} from './target-members.js';
import { listPlans, parsePlanQuery } from './plans.js';
import {
  assertRuleScopeExists,
  parsePermissionRuleSet,
  readPermissionRules,
  writePermissionRules,
} from './permissions.js';
import {
  createSopDefinition,
  getSopDefinition,
  getSopRun,
  listSopDefinitions,
  listSopRuns,
  parseSopRunQuery,
  startSopRun,
} from './sops.js';
import { scheduleSopRun } from './sop-executor.js';
import {
  deleteSkill,
  importAllSkillCandidates,
  installSkillFromRequest,
  installSkillFromZip,
  listSkills,
  MAX_SKILL_ZIP_BYTES,
  readSkillMarkdown,
  scanSkillCandidates,
  setSkillEnabled,
} from './skills.js';
import { listTeamRuns, parseTeamRunQuery, prepareTeamChangeWake } from './team-runs.js';
import { markOwnerRead } from './unread.js';
import {
  confirmWebProviderConsent,
  parseWebProviderCredential,
  parseWebProviderParam,
  writeWebProviderCredential,
} from './web-providers.js';
import { readWorkspace } from './workspace.js';

export const HOST = '127.0.0.1';

/** Upper bound on a JSON request body; agent configs are tiny. */
const MAX_BODY_BYTES = 64 * 1024;

export interface StartedServer {
  server: Server;
  port: number;
}

/**
 * The orchestration runtime the HTTP face drives: the member-face adapter and
 * the process-local in-flight registry. It is created once by the CLI (which
 * selects the adapter from startup arguments) and handed to the HTTP layer, so
 * the routes stay free of adapter selection. Its shape lives with the
 * orchestration module so the live AG-UI run and the REST message write take
 * the same value.
 */
export type { OrchestrationRuntime } from './rounds.js';

interface HttpContext {
  db: Database.Database;
  dataDir: string;
  orchestration: OrchestrationRuntime;
  /** How long one subscription connection lives before the rotate frame. */
  sseLifetimeMs: number;
  /** The process environment: the one place credentials and base URLs are read. */
  env: NodeJS.ProcessEnv;
}

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpContext,
  ...params: string[]
) => Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  handle: Handler;
}

export async function startHttpServer(
  port: number,
  db: Database.Database,
  dataDir: string,
  orchestration: OrchestrationRuntime,
  options: {
    writeError?: (message: string, error: unknown) => void;
    /** The subscription connection lifetime; a test injects a short one. */
    sseLifetimeMs?: number;
    /** The process environment credentials are read from; tests inject their own. */
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<StartedServer> {
  // The HTTP layer never selects a member-face adapter itself: the CLI resolves
  // one from startup arguments and passes it in, so there is no silent default
  // adapter in a production path.
  const context: HttpContext = {
    db,
    dataDir,
    orchestration,
    sseLifetimeMs: options.sseLifetimeMs ?? DEFAULT_SSE_LIFETIME_MS,
    env: options.env ?? process.env,
  };
  const writeError = options.writeError ?? defaultWriteError;
  // The CopilotKit multi-route handler owns everything under its base path;
  // its routes are not part of the human-face REST table below.
  const copilotKitHandler = createCopilotKitHandler(db, orchestration);
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? '/', `http://${HOST}`).pathname;
    if (isCopilotKitPath(pathname)) {
      copilotKitHandler(request, response).catch((error: unknown) => {
        writeError('unhandled CopilotKit request failure', error);
        if (!response.headersSent) {
          response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
        }
        response.end();
      });
      return;
    }
    handleRequest(request, response, context).catch((error: unknown) => {
      sendFailure(response, error, writeError);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListenError = (error: Error): void => {
      reject(error);
    };
    server.once('error', onListenError);
    server.listen(port, HOST, () => {
      server.off('error', onListenError);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('server did not bind to a TCP port');
  }

  return { server, port: address.port };
}

const AGENT_ID = '([^/]+)';
const CHANNEL_ID = '([^/]+)';
const TARGET_ID = '([^/]+)';
const ATTACHMENT_ID = '([^/]+)';
const TASK_ID = '([^/]+)';
const REMINDER_ID = '([^/]+)';
const SOP_ID = '([^/]+)';
const SOP_RUN_ID = '([^/]+)';
const SKILL_NAME = '([^/]+)';

const ROUTES: readonly Route[] = [
  {
    // The one global subscription stream (D1.9). It is live-only: it carries no
    // backlog, no `id:` line and no Last-Event-ID handling, and the rotate
    // frame is the frontend's signal that the close was routine.
    method: 'GET',
    pattern: /^\/api\/events$/,
    handle: async (_request, response, { sseLifetimeMs }) => {
      openEventStream(response, sseLifetimeMs);
    },
  },
  {
    // The workspace reading (D1.8): the app shell's one backend snapshot. It
    // composes the existing read models — agents, channels, DMs, tasks, unread,
    // settings and status points — and writes nothing.
    method: 'GET',
    pattern: /^\/api\/workspace$/,
    handle: async (_request, response, { db, env, orchestration }) => {
      sendJson(response, 200, readWorkspace(db, env, orchestration.inFlight));
    },
  },
  {
    // The per-target SSE is not part of M1 (R4): the route exists only so the
    // answer is an explicit 404 instead of the channel routes swallowing the
    // path into a different shape.
    method: 'GET',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/events$`),
    handle: async (_request, _response, _context, ...params) => {
      throw ApiFailure.notFound(`per-target subscription is not part of M1: ${params[0] ?? ''}`);
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/attachments$/,
    handle: async (request, response, { db, dataDir }) => {
      const uploaded = await uploadAttachment(
        dataDir,
        db,
        request.headers['content-type'],
        await readBody(request, maxUploadEnvelopeBytes(), 'attachment'),
      );
      sendJson(response, 201, { id: uploaded.id });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/attachments/${ATTACHMENT_ID}$`),
    handle: async (_request, response, { db, dataDir }, ...params) => {
      const attachment = readAttachment(dataDir, db, decodeId(params[0]));
      sendAttachment(response, attachment);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/channels$/,
    handle: async (_request, response, { db, env }) => {
      sendJson(response, 200, { channels: listChannels(db, env) });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/channels$/,
    handle: async (request, response, { db, env }) => {
      sendJson(response, 201, createChannel(db, await readJsonBody(request), env));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}$`),
    handle: async (_request, response, { db, env }, ...params) => {
      sendJson(response, 200, getChannel(db, decodeId(params[0]), env));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}$`),
    handle: async (request, response, { db, dataDir, env }, ...params) => {
      sendJson(
        response,
        200,
        updateChannel(db, decodeId(params[0]), await readJsonBody(request), dataDir, env),
      );
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      deleteChannel(db, decodeId(params[0]));
      response.writeHead(204);
      response.end();
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/archive$`),
    handle: async (_request, response, { db, env }, ...params) => {
      sendJson(response, 200, archiveChannel(db, decodeId(params[0]), env));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/members$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, { members: listChannelMembers(db, decodeId(params[0])) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/members$`),
    handle: async (request, response, { db }, ...params) => {
      const result = joinChannel(db, decodeId(params[0]), await readJsonBody(request));
      sendJson(response, 200, result);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/targets/${CHANNEL_ID}/members$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, { members: listTargetMembers(db, decodeId(params[0])) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/dms$/,
    handle: async (_request, response, { db }) => {
      sendJson(response, 200, { dms: listDms(db) });
    },
  },
  {
    // Creation is the one DM write: it is idempotent per Agent, so a repeat is
    // 200 with the same id and only the first call is a 201.
    method: 'POST',
    pattern: /^\/api\/dms$/,
    handle: async (request, response, { db }) => {
      const created = createDm(db, await readJsonBody(request));
      sendJson(response, created.created ? 201 : 200, { id: created.id });
    },
  },
  {
    // The team run snapshot (D2.3): newest runs first, each with its nested
    // assignments. A run is a forensic record, not a message; the route reads
    // the same target id the message route does, but a non-team target is an
    // empty list rather than an error.
    method: 'GET',
    pattern: new RegExp(`^/api/targets/${TARGET_ID}/team-runs$`),
    handle: async (request, response, { db, env }, ...params) => {
      const query = parseTeamRunQuery(new URL(request.url ?? '/', `http://${HOST}`).searchParams);
      sendJson(response, 200, {
        team_runs: listTeamRuns(db, decodeId(params[0]), query, env),
      });
    },
  },
  {
    // The Plan read model (D2.3): the target's latest runs with their complete
    // task lists, newest first; `member_id` narrows to one member. Plan has no
    // human-face write endpoint — the four tools run inside a member round.
    method: 'GET',
    pattern: new RegExp(`^/api/targets/${TARGET_ID}/plans$`),
    handle: async (request, response, { db }, ...params) => {
      const query = parsePlanQuery(
        db,
        new URL(request.url ?? '/', `http://${HOST}`).searchParams,
      );
      sendJson(response, 200, {
        plans: listPlans(db, decodeId(params[0]), query),
      });
    },
  },
  {
    // The SOP definitions (#41 / D2.3): one immutable, channel-scoped ordered
    // step list per (channel_id, name). `channel_id` narrows the read; an
    // archived channel keeps its definitions readable.
    method: 'GET',
    pattern: /^\/api\/sops$/,
    handle: async (request, response, { db }) => {
      const channelId =
        new URL(request.url ?? '/', `http://${HOST}`).searchParams.get('channel_id') ?? undefined;
      sendJson(response, 200, { sops: listSopDefinitions(db, channelId) });
    },
  },
  {
    // A first create is 201; a same-name same-shape replay is 200 (D2.4). The
    // route has no PATCH / DELETE sibling: a definition is immutable in M2.
    method: 'POST',
    pattern: /^\/api\/sops$/,
    handle: async (request, response, { db }) => {
      const created = createSopDefinition(db, await readJsonBody(request));
      sendJson(response, created.created ? 201 : 200, created.definition);
    },
  },
  {
    // The one SOP start (D4.2): the row is inserted `pending`, the response
    // carries it, and the execution worker advances it asynchronously.
    method: 'POST',
    pattern: new RegExp(`^/api/sops/${SOP_ID}/runs$`),
    handle: async (_request, response, { db, orchestration }, ...params) => {
      const run = startSopRun(db, decodeId(params[0]));
      sendJson(response, 202, run);
      scheduleSopRun(db, orchestration.provider, run.id);
    },
  },
  {
    // The run snapshot of one definition (D2.3): newest first, each with the
    // stored state snapshot; `before` is the run-id cursor.
    method: 'GET',
    pattern: new RegExp(`^/api/sops/${SOP_ID}/runs$`),
    handle: async (request, response, { db }, ...params) => {
      const query = parseSopRunQuery(new URL(request.url ?? '/', `http://${HOST}`).searchParams);
      sendJson(response, 200, { runs: listSopRuns(db, decodeId(params[0]), query) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sops/${SOP_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, getSopDefinition(db, decodeId(params[0])));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/sop-runs/${SOP_RUN_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, getSopRun(db, decodeId(params[0])));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/targets/${CHANNEL_ID}/messages$`),
    handle: async (request, response, { db }, ...params) => {
      const query = parsePageQuery(new URL(request.url ?? '/', `http://${HOST}`).searchParams);
      sendJson(response, 200, { messages: listMessages(db, decodeId(params[0]), query) });
    },
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/targets/${CHANNEL_ID}/messages$`),
    handle: async (request, response, { db, orchestration }, ...params) => {
      const targetId = decodeId(params[0]);
      const result = await appendMessageAndDispatch(
        db,
        parseMessageRequest(targetId, await readJsonBody(request)),
        orchestration,
      );
      // `created` is the orchestration's dedupe fact, not part of the human
      // face's answer: the wire keeps the message identity only.
      sendJson(response, 201, { id: result.id, seq: result.seq });
    },
  },
  {
    // The owner's read position. The body is only `last_read_seq`; the stored
    // row is monotonic and clamped to the target's newest seq.
    method: 'POST',
    pattern: new RegExp(`^/api/targets/${TARGET_ID}/read$`),
    handle: async (request, response, { db }, ...params) => {
      const result = markOwnerRead(db, decodeId(params[0]), await readJsonBody(request));
      sendJson(response, 200, result);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/tasks$/,
    handle: async (request, response, { db }) => {
      const query = parseTaskQuery(new URL(request.url ?? '/', `http://${HOST}`).searchParams);
      sendJson(response, 200, { tasks: listTasks(db, query) });
    },
  },
  {
    // Creating a task is the claim trigger: the row and its pointer commit
    // first, then the orchestrator decides whether an available Agent picks it
    // up. The claim facts are one transaction of their own; its wake is
    // delivered after that commit through the same entry point every other
    // wake uses, so there is no second orchestration path.
    method: 'POST',
    pattern: /^\/api\/tasks$/,
    handle: async (request, response, { db, orchestration, env }) => {
      const created = createTask(db, await readJsonBody(request));
      const claim = claimTask(db, created.task.id, env);
      if (claim !== null) {
        await dispatchWakes(db, orchestration.provider, [claim.wake], orchestration.inFlight);
      } else {
        // team 模式建任务 (D3.5): no claim, but the leader gets one mandatory
        // team-change round whose from_seq is the 「任务已创建」 system record.
        const wake = prepareTeamChangeWake(db, created.task.target_id, created.createdEventSeq, env);
        if (wake !== null) {
          await dispatchWakes(db, orchestration.provider, [wake], orchestration.inFlight);
        }
      }
      sendJson(response, 201, getTask(db, created.task.id));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/tasks/${TASK_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, getTask(db, decodeId(params[0])));
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/tasks/${TASK_ID}$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const updated = updateTask(db, decodeId(params[0]), await readJsonBody(request));
      if (updated.assigneeEventSeq !== null) {
        // owner 改派 on a team channel wakes the leader with the change record
        // as its from_seq; a non-team channel prepares nothing.
        const wake = prepareTeamChangeWake(
          db,
          updated.task.target_id,
          updated.assigneeEventSeq,
          env,
        );
        if (wake !== null) {
          await dispatchWakes(db, orchestration.provider, [wake], orchestration.inFlight);
        }
      }
      sendJson(response, 200, updated.task);
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/reminders$/,
    handle: async (_request, response, { db }) => {
      sendJson(response, 200, listReminders(db));
    },
  },
  {
    // Creating a reminder is a pure config write: no message, no wake, no
    // budget change, no target and no unread. The due fact arrives later.
    method: 'POST',
    pattern: /^\/api\/reminders$/,
    handle: async (request, response, { db }) => {
      sendJson(response, 201, createReminder(db, await readJsonBody(request)));
    },
  },
  {
    // Deleting a delivered reminder leaves its system message in place: the
    // message log is append-only.
    method: 'DELETE',
    pattern: new RegExp(`^/api/reminders/${REMINDER_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      deleteReminder(db, decodeId(params[0]));
      response.writeHead(204);
      response.end();
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/search$/,
    handle: async (request, response, { db }) => {
      const query = parseSearchQuery(new URL(request.url ?? '/', `http://${HOST}`).searchParams);
      sendJson(response, 200, { hits: searchWorkspace(db, query) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/settings$/,
    handle: async (_request, response, { db }) => {
      sendJson(response, 200, getSettings(db));
    },
  },
  {
    method: 'PATCH',
    pattern: /^\/api\/settings$/,
    handle: async (request, response, { db }) => {
      sendJson(response, 200, updateSettings(db, await readJsonBody(request)));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/remote-data-flow$/,
    handle: async (_request, response, { db, env }) => {
      sendJson(response, 200, remoteDataFlowView(db, env));
    },
  },
  {
    // 通用一次性确认 (#47 / D2.3): model / mcp / docker / web all write the same
    // `remote_consent_scope` row and keep the first confirmation time.
    method: 'POST',
    pattern: /^\/api\/remote-data-flow\/consent$/,
    handle: async (request, response, { db }) => {
      const scope = parseConsentScope(await readJsonBody(request));
      sendJson(response, 200, confirmRemoteConsent(db, scope.scopeKind, scope.scopeId));
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/remote-data-flow\/([^/]+)\/consent$/,
    handle: async (_request, response, { db }, ...params) => {
      const provider = parseProviderParam(decodeId(params[0]));
      sendJson(response, 200, confirmProviderConsent(db, provider));
    },
  },
  {
    // 联网 provider 凭据写面 (D11): saving the key and saying yes to the
    // `('web', provider)` data flow are one call, so no UI can forget the
    // second half. The reading that comes back is the mask only.
    method: 'PUT',
    pattern: /^\/api\/web-providers\/([^/]+)\/credential$/,
    handle: async (request, response, { db, env }, ...params) => {
      const provider = parseWebProviderParam(decodeId(params[0]));
      const input = parseWebProviderCredential(await readJsonBody(request));
      sendJson(response, 200, writeWebProviderCredential(db, provider, input, env));
    },
  },
  {
    // The separate confirmation: a provider can be told once without touching
    // the key, and a replay keeps the first instant.
    method: 'POST',
    pattern: /^\/api\/web-providers\/([^/]+)\/consent$/,
    handle: async (_request, response, { db, env }, ...params) => {
      const provider = parseWebProviderParam(decodeId(params[0]));
      sendJson(response, 200, confirmWebProviderConsent(db, provider, env));
    },
  },
  {
    // The channel rule set (D2.3): a bare JSON array is the complete
    // replacement; an empty array is valid and a same-content replay is
    // idempotent. The write path validates every row before the transaction,
    // so an invalid row leaves the old set untouched.
    method: 'GET',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/permission-rules$`),
    handle: async (_request, response, { db }, ...params) => {
      const id = decodeId(params[0]);
      assertChannelReadable(db, id);
      sendJson(response, 200, { rules: readPermissionRules(db, 'channel', id) });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/api/channels/${CHANNEL_ID}/permission-rules$`),
    handle: async (request, response, { db }, ...params) => {
      const id = decodeId(params[0]);
      const channel = assertChannelReadable(db, id);
      assertChannelWritable(channel);
      const rules = parsePermissionRuleSet(await readJsonBody(request));
      sendJson(response, 200, { rules: writePermissionRules(db, 'channel', id, rules) });
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/permission-rules$`),
    handle: async (_request, response, { db }, ...params) => {
      const id = decodeId(params[0]);
      assertRuleScopeExists(db, 'agent', id);
      sendJson(response, 200, { rules: readPermissionRules(db, 'agent', id) });
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/permission-rules$`),
    handle: async (request, response, { db }, ...params) => {
      const id = decodeId(params[0]);
      assertRuleScopeExists(db, 'agent', id);
      const rules = parsePermissionRuleSet(await readJsonBody(request));
      sendJson(response, 200, { rules: writePermissionRules(db, 'agent', id, rules) });
    },
  },
  {
    // The approval list (D2.3): pending by default, `status=all` reads every
    // state. It is a pure read: no message, no wake, no budget, no frame.
    method: 'GET',
    pattern: /^\/api\/approvals$/,
    handle: async (request, response, { db }) => {
      const query = parseApprovalQuery(
        new URL(request.url ?? '/', `http://${HOST}`).searchParams,
      );
      sendJson(response, 200, { approvals: listApprovals(db, query) });
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/approvals\/([^/]+)$/,
    handle: async (_request, response, { db }, ...params) => {
      sendJson(response, 200, getApproval(db, decodeId(params[0])));
    },
  },
  {
    // The one approval decision (D2.3 / D5.6): pending only; a same decision
    // replay is 200, the opposite is 409, an unknown call is 400. `rules?` is
    // written in the same transaction as the decision.
    method: 'POST',
    pattern: /^\/api\/approvals\/([^/]+)$/,
    handle: async (request, response, { db }, ...params) => {
      const body = await readJsonBody(request);
      sendJson(response, 200, decideApproval(db, decodeId(params[0]), body));
    },
  },
  {
    method: 'GET',
    pattern: /^\/api\/agents$/,
    handle: async (request, response, { db, env, orchestration }) => {
      const includeDeleted = parseIncludeDeleted(new URL(request.url ?? '/', 'http://allibot').searchParams);
      sendJson(response, 200, {
        agents: listAgents(db, { includeDeleted, env, inFlight: orchestration.inFlight }),
      });
    },
  },
  {
    method: 'POST',
    pattern: /^\/api\/agents$/,
    handle: async (request, response, { db, env, orchestration }) => {
      const agent = createAgent(db, await readJsonBody(request), env, orchestration.inFlight);
      sendJson(response, 201, agent);
    },
  },
  {
    // mcp.json 管理面 (#47 / D2.3 / D6.1): both blocks read and replace the one
    // Agent-home file the runtime assembles from. The body is exactly one of
    // `entries` (structured form) or `raw` (textarea); the file write is atomic
    // and a same-content replay does not touch mtime.
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/mcp$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      sendJson(response, 200, readAgentMcp(db, id, env));
    },
  },
  {
    method: 'PUT',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/mcp$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      sendJson(response, 200, replaceAgentMcp(db, id, await readJsonBody(request), env));
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/rules$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      // The Agent must be a live Agent; the channel only supplies the project
      // context. No channel / no root simply means the project section is
      // absent — it is not an error (D2.3).
      getAgentOr404(db, id, env, orchestration.inFlight);
      const rawChannelId = new URL(request.url ?? '/', `http://${HOST}`).searchParams.get(
        'channel_id',
      );
      const channelId = rawChannelId === null || rawChannelId.length === 0 ? null : rawChannelId;
      sendJson(response, 200, readAgentRules(db, id, channelId, env));
    },
  },
  {
    // Skill 管理面 (#48 / D2.3 / D6.3): the rows are metadata; the bytes live
    // in the member home. Listing is alphabetical and reads the v21 table only.
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      const agent = getAgentOr404(db, id, env, orchestration.inFlight);
      sendJson(response, 200, {
        agent_id: id,
        home_path: agent.home_path,
        skills: listSkills(db, id),
      });
    },
  },
  {
    // One install entry for the directory / agents-skills JSON sources; a
    // first install is 201, the same bytes replay 200, a different hash 409.
    method: 'POST',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      const installed = installSkillFromRequest(db, id, await readJsonBody(request), env);
      sendJson(response, installed.created ? 201 : 200, installed);
    },
  },
  {
    // The read-only landing-directory scan (D2.3 / D6.3). A missing
    // `~/.agents/skills/` is available:false, not an error.
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skill-candidates$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      sendJson(response, 200, scanSkillCandidates(db, id, env));
    },
  },
  {
    // Import every importable, not-installed candidate; each item carries its
    // own result and a failure never blocks the remaining items (D2.3).
    method: 'POST',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills/import-all$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      sendJson(response, 200, importAllSkillCandidates(db, id, env));
    },
  },
  {
    // The raw zip upload (D2.3). The query carries the target skill name; the
    // body is the archive itself, with the 5 MiB ceiling enforced while reading.
    method: 'POST',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills/upload$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      const name = new URL(request.url ?? '/', `http://${HOST}`).searchParams.get('name');
      if (name === null || name.length === 0) {
        throw ApiFailure.validation('upload requires a name query parameter', { field: 'name' });
      }
      const body = await readBody(request, MAX_SKILL_ZIP_BYTES, 'zip');
      const installed = installSkillFromZip(db, id, body, name, env);
      sendJson(response, installed.created ? 201 : 200, installed);
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills/${SKILL_NAME}$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      const name = decodeId(params[1]).normalize('NFC');
      const reading = readSkillMarkdown(db, id, name, env);
      sendJson(response, 200, { agent_id: id, skill: reading.skill, markdown: reading.markdown });
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills/${SKILL_NAME}$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      const name = decodeId(params[1]).normalize('NFC');
      sendJson(response, 200, {
        skill: setSkillEnabled(db, id, name, await readJsonBody(request)),
      });
    },
  },
  {
    // Deleting is idempotent: the row and bytes are removed once, and a repeat
    // is still 204 because the resource is already gone (D2.4).
    method: 'DELETE',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}/skills/${SKILL_NAME}$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      getAgentOr404(db, id, env, orchestration.inFlight);
      deleteSkill(db, id, decodeId(params[1]).normalize('NFC'), env);
      response.writeHead(204);
      response.end();
    },
  },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}$`),
    handle: async (_request, response, { db, env, orchestration }, ...params) => {
      const id = decodeId(params[0]);
      const agent = getAgentOr404(db, id, env, orchestration.inFlight);
      sendJson(response, 200, agent);
    },
  },
  {
    method: 'PATCH',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}$`),
    handle: async (request, response, { db, env, orchestration }, ...params) => {
      const agent = updateAgent(
        db,
        decodeId(params[0]),
        await readJsonBody(request),
        env,
        orchestration.inFlight,
      );
      sendJson(response, 200, agent);
    },
  },
  {
    method: 'DELETE',
    pattern: new RegExp(`^/api/agents/${AGENT_ID}$`),
    handle: async (_request, response, { db }, ...params) => {
      softDeleteAgent(db, decodeId(params[0]));
      response.writeHead(204);
      response.end();
    },
  },
];

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  context: HttpContext,
): Promise<void> {
  const pathname = new URL(request.url ?? '/', `http://${HOST}`).pathname;

  for (const route of ROUTES) {
    if (route.method !== (request.method ?? 'GET')) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (match === null) {
      continue;
    }
    await route.handle(request, response, context, ...match.slice(1));
    return;
  }

  // A known path with an unsupported method is still an unknown route for the
  // unified envelope; the spec only fixes the not_found shape here.
  sendJson(
    response,
    404,
    apiError('not_found', `unknown route: ${request.method ?? 'GET'} ${pathname}`),
  );
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const raw = (await readBody(request, MAX_BODY_BYTES, 'request')).toString('utf8');
  if (raw.trim().length === 0) {
    throw ApiFailure.validation('request body must be JSON');
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw ApiFailure.validation('request body is not valid JSON');
  }
}

/**
 * The one global subscription (D1.9). The connection is live-only: it
 * subscribes to the process's hub and writes each published frame as is. No
 * `id:` line is written and `Last-Event-ID` is never read, so nothing is
 * replayed — a reconnect is a fresh subscription, and the frontend refetches
 * the workspace snapshot and the message pages to catch up.
 *
 * When the connection's lifetime ends the server sends the rotate frame and
 * closes; the frontend reads that as a routine rotation rather than an
 * unreachable backend. The lifetime is a startup option so a test can inject a
 * short one.
 */
function openEventStream(response: ServerResponse, lifetimeMs: number): void {
  response.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
  });
  // Flush the headers now: a subscriber that reads the response before its
  // first frame must not wait for one.
  response.flushHeaders();

  let closed = false;
  let unsubscribe = (): void => {};
  let rotateTimer: NodeJS.Timeout | undefined;

  const teardown = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (rotateTimer !== undefined) {
      clearTimeout(rotateTimer);
    }
    unsubscribe();
    response.end();
  };

  unsubscribe = eventHub.subscribe((event) => {
    if (!closed) {
      response.write(formatSseFrame(event));
    }
  });

  rotateTimer = setTimeout(() => {
    if (closed) {
      return;
    }
    response.write(formatSseFrame({ event: SSE_ROTATE_EVENT, data: {} }));
    teardown();
  }, lifetimeMs);
  // A rotation must not keep the process alive on its own; the server's own
  // handle does that.
  rotateTimer.unref();

  // A client that goes away ends the subscription; the response's own close
  // event covers both a finished response and a dropped connection, while the
  // request's close fires as soon as its (empty) body is read.
  response.once('close', teardown);
  response.once('error', teardown);
}

/**
 * Read a request body up to `limit` bytes. Crossing the limit is a client
 * error, and the rest of the stream is drained rather than left half-read, so
 * the client reads the envelope instead of a reset connection.
 */
async function readBody(
  request: IncomingMessage,
  limit: number,
  what: string,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buffer.length;
    if (total > limit) {
      request.resume();
      throw ApiFailure.validation(`${what} body exceeds ${limit} bytes`, { limit });
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks);
}

/**
 * Soft-deleted members stay out of every read path (Agent list, channel
 * members, mention candidates, status points, search), so `include_deleted=true`
 * cannot be honoured without contradicting D1.13. It is rejected explicitly
 * instead of being silently read as false; `false` and an absent flag are the
 * only accepted values.
 */
function parseIncludeDeleted(searchParams: URLSearchParams): boolean {
  const raw = searchParams.get('include_deleted');
  if (raw === null || raw === 'false') {
    return false;
  }
  if (raw === 'true') {
    throw ApiFailure.validation(
      'include_deleted=true is not supported: soft-deleted members are absent from every read path',
      { field: 'include_deleted', value: raw },
    );
  }
  throw ApiFailure.validation('include_deleted must be true or false');
}

/**
 * Route captures are always present; the only real failure is a malformed
 * percent-encoding, which reads as "that id does not exist".
 */
/** Resolve one Agent for a management route or throw the shared 404 envelope. */
function getAgentOr404(
  db: Database.Database,
  id: string,
  env: NodeJS.ProcessEnv,
  inFlight: Parameters<typeof getAgent>[3],
): NonNullable<ReturnType<typeof getAgent>> {
  const agent = getAgent(db, id, env, inFlight);
  if (agent === null) {
    throw ApiFailure.notFound(`agent not found: ${id}`);
  }
  return agent;
}

function decodeId(raw: string | undefined): string {
  try {
    return decodeURIComponent(raw ?? '');
  } catch {
    throw ApiFailure.notFound(`malformed id: ${raw ?? ''}`);
  }
}

function sendFailure(
  response: ServerResponse,
  error: unknown,
  writeError: (message: string, error: unknown) => void,
): void {
  if (response.headersSent) {
    response.destroy();
    return;
  }
  if (error instanceof ApiFailure) {
    sendJson(response, error.status, apiError(error.code, error.message, error.details));
    return;
  }
  writeError('unhandled request failure', error);
  sendJson(response, 500, apiError('internal_error', 'internal server error'));
}

function defaultWriteError(message: string, error: unknown): void {
  console.error(`allibot: ${message}:`, error);
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/**
 * Attachment bytes are served with the stored media type and an
 * `attachment` disposition. The filename is carried twice — the RFC 5987
 * `filename*` form for non-ASCII names and a quoted ASCII fallback — and both
 * are quoted/escaped so the header cannot be split.
 */
function sendAttachment(
  response: ServerResponse,
  attachment: { filename: string; mime: string; bytes: Buffer },
): void {
  const fallback = attachment.filename.replace(/[^\x20-\x7e]|["\\]/g, '_');
  response.writeHead(200, {
    'content-type': attachment.mime,
    'content-length': attachment.bytes.length,
    'content-disposition':
      `attachment; filename="${fallback}"; ` +
      `filename*=UTF-8''${encodeRfc5987(attachment.filename)}`,
    'x-content-type-options': 'nosniff',
  });
  response.end(attachment.bytes);
}

/**
 * RFC 5987 extended parameter value: percent-encode everything outside
 * `attr-char`. `encodeURIComponent` leaves `'()*` alone, and a raw `'` would
 * end the `UTF-8''` prefix early.
 */
function encodeRfc5987(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
