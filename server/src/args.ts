import { parseArgs } from 'node:util';

export type CliCommand = 'serve' | 'migrate';

export interface CliOptions {
  command: CliCommand;
  dataDir: string | undefined;
  port: number;
}

const DEFAULT_PORT = 3000;
const USAGE = 'usage: allibot <serve|--migrate> [--data-dir <path>] [--port <port>]';

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
