import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_APPROVAL_TIMEOUT_MS } from './approvals.js';
import { DEFAULT_SSE_LIFETIME_MS } from './events.js';
import { DEFAULT_REMINDER_TICK_MS } from './reminders.js';
import { SCRIPTED_BEHAVIORS, type ScriptedBehavior } from './scripted-provider.js';

export type CliCommand = 'serve' | 'migrate';

/**
 * The member-face adapter the server runs. `model` is the production default:
 * the real Anthropic / OpenAI adapter, which refuses a round with a readable
 * reason when its credential or consent is missing. `scripted` is the test
 * double (D4.3) and is selected only by an explicit startup argument
 * (`--provider scripted` or a `--scripted-*` option), so no production path
 * ever falls into a double.
 */
export type ProviderMode = 'scripted' | 'model';

export interface CliOptions {
  command: CliCommand;
  dataDir: string | undefined;
  /**
   * The process-level global layer root override (D5.2): `--home-dir <path>`
   * or the `allibot_HOME_DIR` environment variable. The flag wins. The default
   * is `~/.allibot/`; the value is never stored in the database and has no
   * HTTP write entry.
   */
  homeDir: string | undefined;
  port: number;
  /**
   * Which member-face adapter is live. The real model adapter is the default;
   * a test opts into the scripted double with `--provider scripted` or any
   * `--scripted-*` option.
   */
  providerMode: ProviderMode;
  /**
   * The scripted double's behaviour. It only matters when the scripted adapter
   * is selected; the startup line always names the adapter that is actually
   * live.
   */
  scriptedProvider: ScriptedBehavior;
  /** How long the scripted `delay` behaviour holds one round. */
  scriptedDelayMs: number;
  /**
   * The bodies a `reply` / `delay` round offers. The seam's output shape is
   * "zero or more pending replies"; a round still lands at most one target
   * message, which this option lets a test observe.
   */
  scriptedReplies: readonly string[];
  /**
   * Have the scripted reply carry the system prompt the round was handed. The
   * double is where a test observes the prompt; it is an adapter capability,
   * not a production branch.
   */
  scriptedEchoPrompt: boolean;
  /**
   * Have the scripted reply carry the context window it was handed (`ctx` /
   * `reread`). Like the prompt echo, it is an adapter capability a test uses to
   * observe the round's input, never a production branch.
   */
  scriptedReportContext: boolean;
  /**
   * Have the scripted reply carry the invocation ordinal (`calls:<n>`). It is
   * how a test observes the provider's call count through the ordinary reply
   * body — the same adapter capability pattern as the prompt / context reports,
   * never a production branch.
   */
  scriptedReportCalls: boolean;
  /**
   * Have the scripted reply carry the team reading (prompt composition order,
   * tool set, assignment context). Like the other reports it is an adapter
   * capability a test uses to observe the round's input, never a production
   * branch.
   */
  scriptedReportTeam: boolean;
  /**
   * The member a scripted `transfer-task` round hands the task to. Like every
   * `--scripted-*` value it only configures the test double, never production.
   */
  scriptedTransferMemberId: string | undefined;
  /**
   * The members a scripted `team-assign` leader call assigns, in call order.
   * Like every `--scripted-*` value it only configures the test double.
   */
  scriptedTeamAssignMemberIds: readonly string[];
  /** The instruction a scripted TeamAssign call sends. */
  scriptedTeamAssignInstruction: string | undefined;
  /** Make the doubled member sub-round fail (a TeamAssign failure case). */
  scriptedTeamMemberFail: boolean;
  /**
   * The commands a scripted `shell` round asks the production shell face to
   * run. Like every `--scripted-*` value it only configures the test double.
   */
  scriptedShellCommands: readonly string[];
  /**
   * How long one `/api/events` connection lives before the server sends the
   * rotate frame and closes it. Production keeps the 30-minute default; a test
   * injects a short value instead of waiting.
   */
  sseLifetimeMs: number;
  /**
   * How often the process looks for due reminders. Production keeps the
   * 30-second default; a test injects a short interval instead of waiting.
   */
  reminderTickMs: number;
  /**
   * A fixed instant for the process clock (`--fixed-clock <ISO>`), or
   * undefined for the wall clock. It is a test injection: retention windows and
   * Plan occurrence timestamps become deterministic without waiting 30 days.
   */
  fixedClock: string | undefined;
  /**
   * How long one approval batch waits for a human decision. Production keeps
   * the spec's 600 seconds; a test injects a short value exactly like the SSE
   * lifetime / reminder tick injections.
   */
  approvalTimeoutMs: number;
  /**
   * The MCP `env_names` declared for the local shell (#46 / D5.4). #47 reads
   * them from the member's `mcp.json`; until then this startup injection is the
   * documented merge point. Names only: values come from the process
   * environment at spawn time and are never stored.
   */
  shellEnvNames: readonly string[];
}

const DEFAULT_PORT = 3000;
/**
 * The production default is the real model adapter. The scripted double is a
 * test injection: `--provider scripted` (or any `--scripted-*` option, which
 * only the double understands) selects it. The startup line names whichever
 * adapter is live.
 */
const DEFAULT_PROVIDER_MODE: ProviderMode = 'model';
const PROVIDER_MODES: readonly ProviderMode[] = ['scripted', 'model'];
const DEFAULT_SCRIPTED_PROVIDER: ScriptedBehavior = 'ignore';
const DEFAULT_SCRIPTED_DELAY_MS = 1500;
const USAGE =
  'usage: allibot <serve|--migrate> [--data-dir <path>] [--home-dir <path>] [--port <port>] ' +
  '[--provider <scripted|model>] ' +
  '[--scripted-provider <reply|ignore|fail|delay|silent|no-body|iteration-limit|continue-task|transfer-task|team-assign|team-budget|plan|sop-create|sop-start|workspace|permission|mcp-approval|team-approval|shell>] ' +
  '[--scripted-delay-ms <ms>] ' +
  '[--scripted-reply <body>] [--scripted-echo-prompt] [--scripted-report-context] ' +
  '[--scripted-report-calls] [--scripted-report-team] [--scripted-transfer-member <member-id>] ' +
  '[--scripted-team-assign-member <member-id>] [--scripted-team-assign-instruction <text>] ' +
  '[--scripted-team-member-fail] [--scripted-shell-command <command>] ' +
  '[--fixed-clock <ISO-8601>] [--sse-lifetime-ms <ms>] [--reminder-tick-ms <ms>] ' +
  '[--approval-timeout-ms <ms>] [--shell-env-name <NAME>]';

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      'data-dir': { type: 'string' },
      'home-dir': { type: 'string' },
      port: { type: 'string' },
      migrate: { type: 'boolean' },
      provider: { type: 'string' },
      'scripted-provider': { type: 'string' },
      'scripted-delay-ms': { type: 'string' },
      'scripted-reply': { type: 'string', multiple: true },
      'scripted-echo-prompt': { type: 'boolean' },
      'scripted-report-context': { type: 'boolean' },
      'scripted-report-calls': { type: 'boolean' },
      'scripted-report-team': { type: 'boolean' },
      'scripted-transfer-member': { type: 'string' },
      'scripted-team-assign-member': { type: 'string', multiple: true },
      'scripted-team-assign-instruction': { type: 'string' },
      'scripted-team-member-fail': { type: 'boolean' },
      'scripted-shell-command': { type: 'string', multiple: true },
      'sse-lifetime-ms': { type: 'string' },
      'reminder-tick-ms': { type: 'string' },
      'fixed-clock': { type: 'string' },
      'approval-timeout-ms': { type: 'string' },
      'shell-env-name': { type: 'string', multiple: true },
    },
    strict: true,
    allowPositionals: true,
  });

  if (positionals.length > 1) {
    throw new Error(`unexpected arguments: ${positionals.slice(1).join(' ')}; ${USAGE}`);
  }

  return {
    command: resolveCommand(values.migrate === true, positionals[0]),
    dataDir: values['data-dir'] ?? env.allibot_DATA_DIR,
    homeDir: parseHomeDir(values['home-dir']),
    port: parsePort(values.port ?? String(DEFAULT_PORT)),
    providerMode: parseProviderMode(
      values.provider,
      values['scripted-provider'] !== undefined ||
        values['scripted-delay-ms'] !== undefined ||
        values['scripted-reply'] !== undefined ||
        values['scripted-echo-prompt'] === true ||
        values['scripted-report-context'] === true ||
        values['scripted-report-calls'] === true ||
        values['scripted-report-team'] === true ||
        values['scripted-transfer-member'] !== undefined ||
        values['scripted-team-assign-member'] !== undefined ||
        values['scripted-team-assign-instruction'] !== undefined ||
        values['scripted-team-member-fail'] === true ||
        values['scripted-shell-command'] !== undefined,
    ),
    scriptedProvider: parseScriptedProvider(values['scripted-provider']),
    scriptedDelayMs: parseDelayMs(values['scripted-delay-ms']),
    scriptedReplies: parseScriptedReplies(values['scripted-reply']),
    scriptedEchoPrompt: values['scripted-echo-prompt'] === true,
    scriptedReportContext: values['scripted-report-context'] === true,
    scriptedReportCalls: values['scripted-report-calls'] === true,
    scriptedReportTeam: values['scripted-report-team'] === true,
    scriptedTransferMemberId: parseScriptedTransferMember(values['scripted-transfer-member']),
    scriptedTeamAssignMemberIds: parseScriptedTeamAssignMembers(
      values['scripted-team-assign-member'],
    ),
    scriptedTeamAssignInstruction: parseScriptedTeamAssignInstruction(
      values['scripted-team-assign-instruction'],
    ),
    scriptedTeamMemberFail: values['scripted-team-member-fail'] === true,
    scriptedShellCommands: parseScriptedShellCommands(values['scripted-shell-command']),
    sseLifetimeMs: parseSseLifetimeMs(values['sse-lifetime-ms']),
    reminderTickMs: parseReminderTickMs(values['reminder-tick-ms']),
    fixedClock: parseFixedClock(values['fixed-clock']),
    approvalTimeoutMs: parseApprovalTimeoutMs(values['approval-timeout-ms']),
    shellEnvNames: parseShellEnvNames(values['shell-env-name']),
  };
}

function parseProviderMode(raw: string | undefined, scriptedOption: boolean): ProviderMode {
  if (raw === undefined) {
    // Any `--scripted-*` option is itself an explicit injection of the double;
    // without one the production adapter is the default.
    return scriptedOption ? 'scripted' : DEFAULT_PROVIDER_MODE;
  }
  const mode = PROVIDER_MODES.find((candidate) => candidate === raw);
  if (mode === undefined) {
    throw new Error(
      `invalid --provider value: ${raw}; expected one of ${PROVIDER_MODES.join(', ')}`,
    );
  }
  return mode;
}

function resolveCommand(migrate: boolean, positional: string | undefined): CliCommand {
  if (migrate) {
    if (positional !== undefined) {
      throw new Error(`--migrate does not take a command; ${USAGE}`);
    }
    return 'migrate';
  }
  if (positional === 'serve') {
    return 'serve';
  }
  if (positional === undefined) {
    throw new Error(USAGE);
  }
  throw new Error(`unknown command: ${positional}; ${USAGE}`);
}

/**
 * The global layer root override is a real path or absent. The default is
 * resolved later from HOME, so an absent flag stays `undefined` rather than
 * baking this process's HOME into an option value.
 */
function parseHomeDir(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.trim().length === 0) {
    throw new Error('invalid --home-dir value: a path must not be empty');
  }
  return path.resolve(raw);
}

function parsePort(raw: string): number {
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid --port value: ${raw}`);
  }
  const port = Number(raw);
  if (port > 65_535) {
    throw new Error(`--port must be between 0 and 65535, got ${raw}`);
  }
  return port;
}

function parseScriptedProvider(raw: string | undefined): ScriptedBehavior {
  if (raw === undefined) {
    return DEFAULT_SCRIPTED_PROVIDER;
  }
  const behavior = SCRIPTED_BEHAVIORS.find((candidate) => candidate === raw);
  if (behavior === undefined) {
    throw new Error(
      `invalid --scripted-provider value: ${raw}; expected one of ${SCRIPTED_BEHAVIORS.join(', ')}`,
    );
  }
  return behavior;
}

function parseScriptedReplies(raw: readonly string[] | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  // A whitespace-only body is not empty: it is the double's way to state a
  // reply the write path cannot land (the response-judgment test observes a
  // body-less round). An actually empty argument stays a client error.
  if (raw.some((body) => body.length === 0)) {
    throw new Error('invalid --scripted-reply value: a reply body must not be empty');
  }
  return raw;
}

function parseScriptedTransferMember(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.trim().length === 0) {
    throw new Error('invalid --scripted-transfer-member value: a member id must not be empty');
  }
  return raw.trim();
}

function parseScriptedTeamAssignMembers(
  raw: readonly string[] | undefined,
): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  if (raw.some((memberId) => memberId.trim().length === 0)) {
    throw new Error('invalid --scripted-team-assign-member value: a member id must not be empty');
  }
  return raw.map((memberId) => memberId.trim());
}

function parseScriptedShellCommands(raw: readonly string[] | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  if (raw.some((command) => command.trim().length === 0)) {
    throw new Error('invalid --scripted-shell-command value: a command must not be empty');
  }
  return raw;
}

/** Shell env names are variable names only: no `=` and no empty name. */
function parseShellEnvNames(raw: readonly string[] | undefined): readonly string[] {
  if (raw === undefined) {
    return [];
  }
  const names: string[] = [];
  for (const name of raw) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`invalid --shell-env-name value: ${name}`);
    }
    if (!names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

function parseScriptedTeamAssignInstruction(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (raw.trim().length === 0) {
    throw new Error('invalid --scripted-team-assign-instruction value: an instruction must not be empty');
  }
  return raw;
}

/** A fixed clock is one valid instant; it is stored normalized so ISO comparison is stable. */
function parseFixedClock(raw: string | undefined): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const instant = new Date(raw);
  if (!Number.isFinite(instant.getTime())) {
    throw new Error(`invalid --fixed-clock value: ${raw}; expected an ISO 8601 instant`);
  }
  return instant.toISOString();
}

function parseDelayMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SCRIPTED_DELAY_MS;
  }
  if (!/^\d+$/.test(raw)) {
    throw new Error(`invalid --scripted-delay-ms value: ${raw}`);
  }
  return Number(raw);
}

/** A tick interval is a positive integer; 0 would spin the timer. */
function parseReminderTickMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_REMINDER_TICK_MS;
  }
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new Error(`invalid --reminder-tick-ms value: ${raw}`);
  }
  return Number(raw);
}

/** An approval wait is a positive integer; 0 would time out every ask instantly. */
function parseApprovalTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_APPROVAL_TIMEOUT_MS;
  }
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new Error(`invalid --approval-timeout-ms value: ${raw}`);
  }
  return Number(raw);
}

/** A connection lifetime is a positive integer; 0 would rotate every stream instantly. */
function parseSseLifetimeMs(raw: string | undefined): number {
  if (raw === undefined) {
    return DEFAULT_SSE_LIFETIME_MS;
  }
  if (!/^\d+$/.test(raw) || Number(raw) === 0) {
    throw new Error(`invalid --sse-lifetime-ms value: ${raw}`);
  }
  return Number(raw);
}
