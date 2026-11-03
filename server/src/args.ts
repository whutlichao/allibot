import { homedir } from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';

export interface ServerOptions {
  dataDir: string;
  port: number;
}

const DEFAULT_PORT = 3000;

export function parseServerOptions(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): ServerOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      'data-dir': { type: 'string' },
      port: { type: 'string' },
    },
    strict: true,
    allowPositionals: false,
  });

  const dataDir =
    values['data-dir'] ??
    env.allibot_DATA_DIR ??
    path.join(homedir(), '.allibot', 'data');

  if (dataDir.length === 0) {
    throw new Error('data dir must not be empty');
  }

  return {
    dataDir,
    port: parsePort(values.port ?? String(DEFAULT_PORT)),
  };
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
