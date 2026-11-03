import { mkdir } from 'node:fs/promises';
import { parseServerOptions } from './args.js';
import { HOST, startHttpServer } from './http.js';

async function main(): Promise<void> {
  const { dataDir, port } = parseServerOptions(process.argv.slice(2));
  await mkdir(dataDir, { recursive: true });

  const { server, port: boundPort } = await startHttpServer(port);
  console.log(`allibot server listening on http://${HOST}:${boundPort}`);

  let stopping = false;
  const shutdown = (signal: NodeJS.Signals): void => {
    if (stopping) {
      return;
    }
    stopping = true;
    const forceExit = setTimeout(() => process.exit(1), 5_000);
    forceExit.unref();
    server.close((error) => {
      if (error !== undefined) {
        console.error(`allibot server failed to stop on ${signal}:`, error);
        process.exit(1);
      }
      process.exit(0);
    });
  };

  process.once('SIGTERM', () => shutdown('SIGTERM'));
  process.once('SIGINT', () => shutdown('SIGINT'));
}

main().catch((error: unknown) => {
  console.error('allibot server failed to start:', error);
  process.exit(1);
});
