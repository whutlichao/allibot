#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';

/**
 * Test-only MCP server (#47). It is an injected dependency under the one HTTP
 * seam, not a second seam: the backend process connects to it exactly as it
 * would to any explicitly configured MCP server.
 *
 * Modes:
 *   stdio [--log <file>]
 *   http --port-file <file> [--log <file>]
 *   sse  --port-file <file> [--log <file>]
 *
 * Tools: `echo` returns the process cwd, the probe argument and the presence
 * of two environment variables (so `env_names` can be verified without ever
 * logging their values); `boom` is an isError result.
 */

const args = process.argv.slice(2);
const mode = args[0];
const portFileIndex = args.indexOf('--port-file');
const logIndex = args.indexOf('--log');
const portFile = portFileIndex === -1 ? null : args[portFileIndex + 1];
const logFile = logIndex === -1 ? null : args[logIndex + 1];

function log(line) {
  if (logFile !== null) {
    appendFileSync(logFile, `${line}\n`, 'utf8');
  }
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Return the probe, cwd and a pair of environment-variable readings.',
    inputSchema: { type: 'object', properties: { probe: { type: 'string' } } },
  },
  {
    name: 'boom',
    description: 'Return an isError tool result.',
    inputSchema: { type: 'object', properties: {} },
  },
];

function echoTool(params) {
  const probe = params.arguments?.probe ?? null;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          probe,
          cwd: process.cwd(),
          token: process.env.MCP_TEST_TOKEN ?? null,
          unnamed: process.env.MCP_TEST_SECRET ?? null,
        }),
      },
    ],
  };
}

function handle(message) {
  const method = message?.method;
  const id = message?.id;
  if (method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'allibot-test-mcp', version: '1.0.0' },
      },
    };
  }
  if (method === 'notifications/initialized') {
    return null;
  }
  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: TOOLS } };
  }
  if (method === 'tools/call') {
    const name = message?.params?.name;
    const result =
      name === 'boom'
        ? { content: [{ type: 'text', text: 'BOOM' }], isError: true }
        : echoTool(message?.params ?? {});
    return { jsonrpc: '2.0', id, result };
  }
  if (id === undefined) {
    return null;
  }
  return {
    jsonrpc: '2.0',
    id,
    error: { code: -32601, message: `unknown method: ${String(method)}` },
  };
}

function stdioMode() {
  log(`start ${process.pid} cwd=${process.cwd()}`);
  process.stdin.setEncoding('utf8');
  let buffer = '';
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line.length > 0) {
        try {
          const message = JSON.parse(line);
          log(`request ${String(message.method ?? '')}`);
          const response = handle(message);
          if (response !== null) {
            process.stdout.write(`${JSON.stringify(response)}\n`);
          }
        } catch {
          // A malformed line is ignored; a real client never sends one.
        }
      }
      newline = buffer.indexOf('\n');
    }
  });
}

function httpMode() {
  const server = createServer((request, response) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      log(`http ${String(message?.method ?? '')}`);
      const reply = handle(message);
      if (reply === null) {
        response.writeHead(202).end();
        return;
      }
      const payload = JSON.stringify(reply);
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(payload),
        'mcp-session-id': 'allibot-test-session',
      });
      response.end(payload);
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    log(`listen http ${port}`);
    if (portFile !== null) {
      appendFileSync(portFile, String(port), 'utf8');
    }
  });
}

function sseMode() {
  let stream = null;
  const server = createServer((request, response) => {
    if (request.method === 'GET') {
      log('sse connect');
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      stream = response;
      response.write('event: endpoint\ndata: /messages?session=allibot-test\n\n');
      return;
    }
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      log(`sse post ${String(message?.method ?? '')}`);
      response.writeHead(202).end();
      const reply = handle(message);
      if (reply !== null && stream !== null) {
        stream.write(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
      }
    });
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    log(`listen sse ${port}`);
    if (portFile !== null) {
      appendFileSync(portFile, String(port), 'utf8');
    }
  });
}

if (mode === 'stdio') {
  stdioMode();
} else if (mode === 'http') {
  httpMode();
} else if (mode === 'sse') {
  sseMode();
} else {
  console.error('usage: mcp-server.mjs <stdio|http|sse> [--port-file <file>] [--log <file>]');
  process.exit(2);
}
