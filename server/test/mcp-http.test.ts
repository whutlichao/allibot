import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removeTempDir, runCli, startServer, type RunningServer } from './support.ts';

/**
 * mcp.json 管理面 (#47 / D2.3 / D6.1), observed through the one process seam:
 * a real backend, the human REST face and the Agent-home file on disk.
 *
 * `mcp.json` is the only source of truth. The structured `entries` form and
 * the `raw` textarea read and write that one file; the runtime assembly reads
 * the same file. This suite covers the management face: shape validation,
 * mutual exclusion, atomic replacement, 0600, same-content replay (mtime
 * untouched) and the readable diagnostic for a file edited outside the app.
 */

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  running: RunningServer;
  base: string;
  agentId: string;
  agentHome: string;
  stop: () => Promise<void>;
}

async function startFixture(prefix: string): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  mkdirSync(home, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'reply'],
    env: { HOME: home },
  });
  const base = `http://127.0.0.1:${running.port}`;
  const created = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: 'MCP 成员', model: 'openai:gpt-5' }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const agent = (await created.json()) as Record<string, unknown>;
  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    running,
    base,
    agentId: agent['id'] as string,
    agentHome: agent['home_path'] as string,
    stop: async () => {
      await fixture.running.stop();
      await removeTempDir(tmp);
    },
  };
  return fixture;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

function mcpPath(fixture: Fixture): string {
  return path.join(fixture.agentHome, 'mcp.json');
}

function putMcp(fixture: Fixture, body: unknown): Promise<Response> {
  return fetch(`${fixture.base}/api/agents/${fixture.agentId}/mcp`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function stdioEntry(name = 'demo'): Record<string, unknown> {
  return {
    name,
    transport: 'stdio',
    enabled: true,
    command: 'node',
    args: ['server.mjs'],
  };
}

test('GET and PUT /api/agents/{id}/mcp read and replace the one home file', async () => {
  const fixture = await startFixture('allibot-mcp-file-');
  try {
    const missing = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/mcp`);
    assert.equal(missing.status, 200);
    const missingBody = await readJson(missing);
    assert.equal(missingBody['agent_id'], fixture.agentId);
    assert.equal(missingBody['path'], mcpPath(fixture));
    assert.equal(missingBody['present'], false);
    assert.deepEqual(missingBody['entries'], []);
    assert.equal(missingBody['raw'], '');
    assert.equal(missingBody['diagnostic'], null);
    assert.equal(existsSync(mcpPath(fixture)), false, 'a missing file is not created by a read');

    const entries = [
      {
        ...stdioEntry('zeta'),
        env_names: ['MCP_TOKEN'],
      },
      {
        name: 'alpha',
        transport: 'http',
        enabled: false,
        url: 'http://127.0.0.1:9/mcp',
        env_names: [],
      },
    ];
    const put = await putMcp(fixture, { entries });
    assert.equal(put.status, 200, await put.clone().text());
    const putBody = await readJson(put);
    assert.equal(putBody['present'], true);
    assert.equal(putBody['diagnostic'], null);
    assert.deepEqual(putBody['entries'], [
      {
        name: 'alpha',
        transport: 'http',
        enabled: false,
        url: 'http://127.0.0.1:9/mcp',
      },
      {
        name: 'zeta',
        transport: 'stdio',
        enabled: true,
        command: 'node',
        args: ['server.mjs'],
        env_names: ['MCP_TOKEN'],
      },
    ]);

    assert.equal(existsSync(mcpPath(fixture)), true);
    assert.equal(statSync(mcpPath(fixture)).mode & 0o777, 0o600, 'the file is 0600');
    const onDisk = JSON.parse(readFileSync(mcpPath(fixture), 'utf8')) as {
      servers: Record<string, unknown>[];
    };
    assert.deepEqual(onDisk, {
      servers: [
        {
          name: 'alpha',
          transport: 'http',
          enabled: false,
          url: 'http://127.0.0.1:9/mcp',
        },
        {
          name: 'zeta',
          transport: 'stdio',
          enabled: true,
          command: 'node',
          args: ['server.mjs'],
          env_names: ['MCP_TOKEN'],
        },
      ],
    });

    const read = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/mcp`);
    const readBody = await readJson(read);
    assert.deepEqual(readBody['entries'], putBody['entries']);
    assert.equal(readBody['raw'], readFileSync(mcpPath(fixture), 'utf8'));

    // Same content replay returns 200 and does not touch mtime. The file's
    // mtime is deliberately moved into the past so a rewrite is detectable.
    const old = new Date('2020-01-01T00:00:00.000Z');
    utimesSync(mcpPath(fixture), old, old);
    const replay = await putMcp(fixture, { entries });
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal(statSync(mcpPath(fixture)).mtimeMs, old.getTime(), 'same content does not rewrite');

    // raw preserves the user's exact text but must be a valid declaration.
    const rawText = `{"servers":[{"name":"raw-one","transport":"sse","enabled":true,"url":"http://127.0.0.1:9/sse"}]}\n`;
    const rawPut = await putMcp(fixture, { raw: rawText });
    assert.equal(rawPut.status, 200, await rawPut.clone().text());
    assert.equal(readFileSync(mcpPath(fixture), 'utf8'), rawText, 'raw keeps the user text');
    const rawRead = await readJson(await fetch(`${fixture.base}/api/agents/${fixture.agentId}/mcp`));
    assert.equal(rawRead['raw'], rawText);
    assert.deepEqual(rawRead['entries'], [
      { name: 'raw-one', transport: 'sse', enabled: true, url: 'http://127.0.0.1:9/sse' },
    ]);

    // Same raw text again: no rewrite.
    utimesSync(mcpPath(fixture), old, old);
    const rawReplay = await putMcp(fixture, { raw: rawText });
    assert.equal(rawReplay.status, 200, await rawReplay.clone().text());
    assert.equal(statSync(mcpPath(fixture)).mtimeMs, old.getTime());

    const unknown = await fetch(
      `${fixture.base}/api/agents/00000000-0000-4000-8000-000000000000/mcp`,
    );
    assert.equal(unknown.status, 404);
    assert.equal(
      ((await readJson(unknown))['error'] as Record<string, unknown>)['code'],
      'not_found',
    );
  } finally {
    await fixture.stop();
  }
});

test('PUT /api/agents/{id}/mcp takes exactly one of entries or raw and rejects bad entries', async () => {
  const fixture = await startFixture('allibot-mcp-validation-');
  try {
    const good = await putMcp(fixture, { entries: [stdioEntry()] });
    assert.equal(good.status, 200, await good.clone().text());
    const goodBytes = readFileSync(mcpPath(fixture), 'utf8');

    const badBodies: { label: string; body: unknown }[] = [
      { label: 'both', body: { entries: [stdioEntry()], raw: '{"servers":[]}' } },
      { label: 'neither', body: {} },
      { label: 'extra key', body: { entries: [], extra: true } },
      { label: 'entries not an array', body: { entries: {} } },
      { label: 'duplicate names', body: { entries: [stdioEntry('dup'), stdioEntry('dup')] } },
      {
        label: 'headers',
        body: { entries: [{ ...stdioEntry(), headers: { Authorization: 'Bearer nope' } }] },
      },
      {
        label: 'headers_env',
        body: { entries: [{ ...stdioEntry(), headers_env: ['TOKEN'] }] },
      },
      {
        label: 'inline env values',
        body: { entries: [{ ...stdioEntry(), env: { TOKEN: 'secret' } }] },
      },
      {
        label: 'stdio with url',
        body: { entries: [{ ...stdioEntry(), url: 'http://127.0.0.1:9/mcp' }] },
      },
      {
        label: 'http with command',
        body: {
          entries: [
            { name: 'h', transport: 'http', enabled: true, url: 'http://x', command: 'node' },
          ],
        },
      },
      {
        label: 'sse with args',
        body: {
          entries: [{ name: 's', transport: 'sse', enabled: true, url: 'http://x', args: [] }],
        },
      },
      {
        label: 'unknown transport',
        body: { entries: [{ ...stdioEntry(), transport: 'websocket' }] },
      },
      {
        label: 'enabled not boolean',
        body: { entries: [{ ...stdioEntry(), enabled: 'yes' }] },
      },
      {
        label: 'missing enabled',
        body: {
          entries: [{ name: 'x', transport: 'stdio', command: 'node', args: [] }],
        },
      },
      {
        label: 'non-string arg',
        body: { entries: [{ ...stdioEntry(), args: [1] }] },
      },
      {
        label: 'env_names not names',
        body: { entries: [{ ...stdioEntry(), env_names: [{ name: 'TOKEN' }] }] },
      },
      { label: 'raw invalid JSON', body: { raw: '{"servers":[' } },
      {
        label: 'raw unknown field',
        body: {
          raw: '{"servers":[{"name":"x","transport":"stdio","enabled":true,"command":"node","args":[],"headers":{}}]}',
        },
      },
      {
        label: 'raw duplicate names',
        body: {
          raw: '{"servers":[{"name":"x","transport":"stdio","enabled":true,"command":"node","args":[]},{"name":"x","transport":"http","enabled":true,"url":"http://x"}]}',
        },
      },
    ];

    for (const bad of badBodies) {
      const response = await putMcp(fixture, bad.body);
      assert.equal(response.status, 400, `${bad.label} should be 400 (got ${response.status})`);
      const body = await readJson(response);
      assert.equal(
        (body['error'] as Record<string, unknown>)['code'],
        'validation_failed',
        bad.label,
      );
      assert.equal(
        readFileSync(mcpPath(fixture), 'utf8'),
        goodBytes,
        `${bad.label} leaves the old file untouched`,
      );
    }
  } finally {
    await fixture.stop();
  }
});

test('an externally edited invalid mcp.json reads back raw with a readable diagnostic', async () => {
  const fixture = await startFixture('allibot-mcp-diagnostic-');
  try {
    const broken = JSON.stringify({
      servers: [
        { name: 'half', transport: 'http', enabled: true, url: 'http://127.0.0.1:9/mcp' },
        { name: 'bad', transport: 'stdio', enabled: true, command: 'node', args: [], url: 'x' },
      ],
    });
    writeFileSync(mcpPath(fixture), broken, { mode: 0o600 });
    const body = await readJson(await fetch(`${fixture.base}/api/agents/${fixture.agentId}/mcp`));
    assert.equal(body['present'], true);
    assert.equal(body['raw'], broken, 'the raw text is still shown for repair');
    assert.deepEqual(body['entries'], [], 'an invalid file has no half-assembled entries');
    assert.equal(typeof body['diagnostic'], 'string');
    assert.ok(String(body['diagnostic']).length > 0, 'the diagnostic is readable');
    assert.ok(!String(body['diagnostic']).includes('127.0.0.1:9'), 'diagnostic omits connection values');
  } finally {
    await fixture.stop();
  }
});
