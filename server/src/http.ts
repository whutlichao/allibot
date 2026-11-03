import { apiError } from '@allibot/shared';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

export const HOST = '127.0.0.1';

export interface StartedServer {
  server: Server;
  port: number;
}

export async function startHttpServer(port: number): Promise<StartedServer> {
  const server = createServer(handleRequest);

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

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
  const pathname = new URL(request.url ?? '/', `http://${HOST}`).pathname;
  sendJson(
    response,
    404,
    apiError('not_found', `unknown route: ${request.method ?? 'GET'} ${pathname}`),
  );
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}
