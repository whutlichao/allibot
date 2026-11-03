import { parseArgs } from 'node:util';
import { SCRIPTED_BEHAVIORS, type ScriptedBehavior } from './scripted-provider.js';

export type CliCommand = 'serve' | 'migrate';

/**
 * The member-face adapter the server runs. `scripted` is the test double
 * injected through `--scripted-provider` (D4.3); `model` is the real provider
 * adapter, selected explicitly so no production path ever falls into a double.
 */
export type ProviderMode = 'scripted' | 'model';

export interface CliOptions {
  command: CliCommand;
  dataDir: string | undefined;
  port: number;
  /**
   * Which member-face adapter is live. The scripted double stays the default so
   * every behaviour test runs with no network and no model cost; a real
   * deployment passes `--provider model`.
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
}

const DEFAULT_PORT = 3000;
/**
 * The scripted double is the default member-face adapter. Its default behaviour
 * is `ignore`: a server started without an explicit `--scripted-provider` runs
 * every round exactly once and lands no invented reply. The startup line names
 * the adapter, so the choice is always visible; a real provider is selected
 * with `--provider model`.
 */
const DEFAULT_PROVIDER_MODE: ProviderMode = 'scripted';
const PROVIDER_MODES: readonly ProviderMode[] = ['scripted', 'model'];
const DEFAULT_SCRIPTED_PROVIDER: ScriptedBehavior = 'ignore';
const DEFAULT_SCRIPTED_DELAY_MS = 1500;
const USAGE =
  'usage: allibot <serve|--migrate> [--data-dir <path>] [--port <port>] ' +
  '[--provider <scripted|model>] ' +
  '[--scripted-provider <reply|ignore|fail|delay>] [--scripted-delay-ms <ms>] ' +
  '[--scripted-reply <body>]...';

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
      provider: { type: 'string' },
      'scripted-provider': { type: 'string' },
      'scripted-delay-ms': { type: 'string' },
      'scripted-reply': { type: 'string', multiple: true },
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
    providerMode: parseProviderMode(values.provider),
    scriptedProvider: parseScriptedProvider(values['scripted-provider']),
    scriptedDelayMs: parseDelayMs(values['scripted-delay-ms']),
    scriptedReplies: parseScriptedReplies(values['scripted-reply']),
  };
}

function parseProviderMode(raw: string | undefined): ProviderMode {
  if (raw === undefined) {
    return DEFAULT_PROVIDER_MODE;
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
