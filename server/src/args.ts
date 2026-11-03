import { parseArgs } from 'node:util';
import { SCRIPTED_BEHAVIORS, type ScriptedBehavior } from './scripted-provider.js';

export type CliCommand = 'serve' | 'migrate';

export interface CliOptions {
  command: CliCommand;
  dataDir: string | undefined;
  port: number;
  /**
   * The member-face adapter injected through startup (D4.3). The scripted
   * double is the only adapter this ticket ships; a real provider adapter is
   * a later ticket's selection at this same place, never a production branch
   * on a test environment variable.
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
}

const DEFAULT_PORT = 3000;
/**
 * Until the real provider adapter lands (D4.3), the only member-face adapter is
 * the scripted double. Its default is `ignore`: a server started without an
 * explicit `--scripted-provider` runs every round exactly once and lands no
 * invented reply. The startup line names the adapter, so the choice is visible.
 */
const DEFAULT_SCRIPTED_PROVIDER: ScriptedBehavior = 'ignore';
const DEFAULT_SCRIPTED_DELAY_MS = 1500;
const USAGE =
  'usage: allibot <serve|--migrate> [--data-dir <path>] [--port <port>] ' +
  '[--scripted-provider <reply|ignore|fail|delay|silent|no-body>] [--scripted-delay-ms <ms>] ' +
  '[--scripted-reply <body>] [--scripted-echo-prompt]';

export function parseCliArgs(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): CliOptions {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string' },
      migrate: { type: 'boolean' },
      'scripted-provider': { type: 'string' },
      'scripted-delay-ms': { type: 'string' },
      'scripted-reply': { type: 'string', multiple: true },
      'scripted-echo-prompt': { type: 'boolean' },
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
    port: parsePort(values.port ?? String(DEFAULT_PORT)),
    scriptedProvider: parseScriptedProvider(values['scripted-provider']),
    scriptedDelayMs: parseDelayMs(values['scripted-delay-ms']),
    scriptedReplies: parseScriptedReplies(values['scripted-reply']),
    scriptedEchoPrompt: values['scripted-echo-prompt'] === true,
  };
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
  if (raw.some((body) => body.trim().length === 0)) {
    throw new Error('invalid --scripted-reply value: a reply body must not be empty');
  }
  return raw;
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
