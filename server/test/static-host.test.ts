import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import type { RoundProvider } from '../dist/agent-seam.js';
import { openDatabase } from '../dist/db.js';
import { startHttpServer, type StartedServer } from '../dist/http.js';
import { createInFlightRounds } from '../dist/rounds.js';
import { DEFAULT_WEB_ROOT } from '../dist/static-host.js';
import { makeTempDir, removeTempDir, REPO_ROOT, runCli } from './support.ts';

/**
 * 同源静态宿主 (M4 / D1–D6)，观察面只有 HTTP。
 *
 * 静态根由 `startHttpServer` 的 `webRoot` 选项注入临时目录（D6），所以这些
 * 断言不依赖也不触碰真实的 `web/dist`；后端其余部分仍是真实进程内的一套
 * 路由，`/api` 的未命中必须继续是既有的 JSON `not_found` 信封。
 */

const INDEX_HTML =
  '<!doctype html><html><head><title>allibot</title></head><body><div id="root"></div></body></html>';
const ASSET_JS = 'console.log("allibot asset");\n';
const FAVICON_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>';
const HASHLESS_TXT = 'plain text outside assets\n';
const DATA_BIN = Buffer.from([0x00, 0x01, 0x02, 0xff]);
/** 静态根之外的诱饵：只有穿越成功才读得到它。 */
const OUTSIDE_TXT = 'outside the build output\n';

function assertNotShell(body: string): void {
  assert.ok(!body.includes('<div id="root">'), `404 响应体不应是 SPA 页壳：${body}`);
}

/** The adapter is never called here: only the static branch is under test. */
const PROVIDER: RoundProvider = {
  deferred: false,
  name: 'stub:not-called',
  async runRound() {
    return { verdict: 'ignored', replies: [] };
  },
};

interface StaticFixture {
  base: string;
  port: number;
  stop: () => Promise<void>;
}

async function startStaticFixture(prefix: string): Promise<StaticFixture> {
  const dataDir = await makeTempDir(prefix);
  const webBase = await makeTempDir(`${prefix}web-`);
  const webRoot = path.join(webBase, 'dist');
  try {
    await mkdir(path.join(webRoot, 'assets'), { recursive: true });
    await writeFile(path.join(webRoot, 'index.html'), INDEX_HTML);
    await writeFile(path.join(webRoot, 'favicon.svg'), FAVICON_SVG);
    await writeFile(path.join(webRoot, 'notes.txt'), HASHLESS_TXT);
    await writeFile(path.join(webRoot, 'data.bin'), DATA_BIN);
    await writeFile(path.join(webRoot, 'assets', 'index-2f9a11c3.js'), ASSET_JS);
    await writeFile(path.join(webBase, 'outside.txt'), OUTSIDE_TXT);

    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

    const db = openDatabase(dataDir);
    const { server, port } = await startHttpServer(
      0,
      db,
      dataDir,
      { provider: PROVIDER, inFlight: createInFlightRounds() },
      { webRoot },
    );
    return {
      base: `http://127.0.0.1:${port}`,
      port,
      stop: async () => {
        await new Promise<void>((resolve) => {
          server.close(() => {
            resolve();
          });
        });
        db.close();
        await removeTempDir(dataDir);
        await removeTempDir(webBase);
      },
    };
  } catch (error) {
    await removeTempDir(dataDir);
    await removeTempDir(webBase);
    throw error;
  }
}

interface RawResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

/**
 * 原始路径请求：`fetch` 与 `http.request(url)` 都会先在客户端归一 `..` 或吞掉
 * `HEAD` 的响应体，那样测到的是 HTTP 客户端而不是静态宿主。
 */
async function rawRequest(
  port: number,
  rawPath: string,
  method: 'GET' | 'HEAD',
): Promise<RawResponse> {
  return await new Promise<RawResponse>((resolve, reject) => {
    const request = httpRequest(
      { host: '127.0.0.1', port, path: rawPath, method },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    request.on('error', reject);
    request.end();
  });
}

test('默认静态根由模块位置解到仓库的 web/dist，而不是进程工作目录 (D6)', () => {
  assert.equal(DEFAULT_WEB_ROOT, path.join(REPO_ROOT, 'web', 'dist'));
});

test('GET / 由 index.html 回答，并声明不缓存', async () => {
  const fixture = await startStaticFixture('allibot-static-root-');
  try {
    const response = await fetch(`${fixture.base}/`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'no-cache');
    assert.equal(await response.text(), INDEX_HTML);
  } finally {
    await fixture.stop();
  }
});

test('GET /assets/<hash>.js 返回脚本，content-type 与 immutable 缓存头正确', async () => {
  const fixture = await startStaticFixture('allibot-static-asset-');
  try {
    const response = await fetch(`${fixture.base}/assets/index-2f9a11c3.js`);
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    assert.equal(response.headers.get('cache-control'), 'public, max-age=31536000, immutable');
    assert.equal(await response.text(), ASSET_JS);
  } finally {
    await fixture.stop();
  }
});

test('assets 之外的构建产物按扩展名映射 MIME，且不声明不可变', async () => {
  const fixture = await startStaticFixture('allibot-static-root-file-');
  try {
    const cases: readonly (readonly [string, string])[] = [
      ['/favicon.svg', 'image/svg+xml; charset=utf-8'],
      ['/notes.txt', 'text/plain; charset=utf-8'],
      ['/data.bin', 'application/octet-stream'],
    ];
    for (const [route, contentType] of cases) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('content-type'), contentType, route);
      assert.equal(response.headers.get('cache-control'), 'no-cache', route);
    }
  } finally {
    await fixture.stop();
  }
});

test('不含点的前端路由回退 index.html，深链接刷新不 404', async () => {
  const fixture = await startStaticFixture('allibot-static-spa-');
  try {
    for (const route of ['/channels/abc', '/tasks/123']) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 200, await response.clone().text());
      assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assert.equal(response.headers.get('cache-control'), 'no-cache');
      assert.equal(await response.text(), INDEX_HTML, `${route} 应回退到 index.html`);
    }
  } finally {
    await fixture.stop();
  }
});

test('HEAD 只回响应头，不带响应体', async () => {
  const fixture = await startStaticFixture('allibot-static-head-');
  try {
    const response = await rawRequest(fixture.port, '/', 'HEAD');
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-type'], 'text/html; charset=utf-8');
    assert.equal(response.headers['content-length'], String(Buffer.byteLength(INDEX_HTML)));
    assert.equal(response.body, '');
  } finally {
    await fixture.stop();
  }
});

test('/api 前缀（含 /api 本身）不进静态分支，未命中仍是既有 JSON not_found 信封', async () => {
  const fixture = await startStaticFixture('allibot-static-api-');
  try {
    for (const route of ['/api/nope', '/api']) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 404, `${route} 应是 404；实测 ${response.status}`);
      assert.match(response.headers.get('content-type') ?? '', /^application\/json/, route);
      const body: unknown = await response.json();
      assert.deepEqual(
        (body as { error: { code: string } }).error.code,
        'not_found',
        `${route} 应保留 not_found 信封`,
      );
    }
  } finally {
    await fixture.stop();
  }
});

test('路径穿越一律 404：静态根之外的诱饵文件读不到', async () => {
  const fixture = await startStaticFixture('allibot-static-traversal-');
  try {
    const routes = [
      '/../server/package.json',
      '/%2e%2e/server/package.json',
      '/assets/../../package.json',
      '/%2e%2e/outside.txt',
      '/assets/../../outside.txt',
      // 编码的斜线不会被 URL 解析器当成段分隔符：只有这两条会真的带着 `..`
      // 走到 decodeURIComponent，也就是 D4 那两道屏障实际拦住的东西。
      '/%2e%2e%2foutside.txt',
      '/assets/%2e%2e%2f%2e%2e%2foutside.txt',
    ];
    for (const route of routes) {
      const response = await rawRequest(fixture.port, route, 'GET');
      assert.equal(response.status, 404, `${route} 应被拒；实测 ${response.status}`);
      assert.notEqual(response.body, OUTSIDE_TXT, `${route} 读到了静态根之外的文件`);
    }
  } finally {
    await fixture.stop();
  }
});

test('/assets/ 下的缺失文件与带扩展名的缺失路径都是硬 404，响应体不是 HTML', async () => {
  const fixture = await startStaticFixture('allibot-static-missing-');
  try {
    for (const route of ['/assets/nope.js', '/favicon-nope.png']) {
      const response = await fetch(`${fixture.base}${route}`);
      assert.equal(response.status, 404, `${route} 应是 404；实测 ${response.status}`);
      assert.notEqual(response.headers.get('content-type'), 'text/html; charset=utf-8');
      assertNotShell(await response.text());
    }
  } finally {
    await fixture.stop();
  }
});

test('静态根没有 index.html 时 startHttpServer 拒绝启动，文案给出构建命令 (D5)', async () => {
  const dataDir = await makeTempDir('allibot-static-unbuilt-');
  const webRoot = await makeTempDir('allibot-static-unbuilt-web-');
  const db = openDatabase(dataDir);
  let started: StartedServer | undefined;
  try {
    // 空目录就是「忘了构建」的形状：没有 index.html。降级成「只有 API」会
    // 把「打开是 404」变成需要读源码才能解释的谜，所以这里必须直接拒绝。
    //
    // 先把可能 resolve 的监听器接住：这条断言一旦不成立（拒绝丢失），那个已
    // 经 listen 的 server 就没人关了，测试进程会挂着一个打开的 handle 不退出。
    const attempted = startHttpServer(
      0,
      db,
      dataDir,
      { provider: PROVIDER, inFlight: createInFlightRounds() },
      { webRoot },
    );
    void attempted.then(
      (server) => {
        started = server;
      },
      () => undefined,
    );
    await assert.rejects(
      attempted,
      /npm run build/,
      '缺前端构建产物时必须拒绝启动，并在文案里给出构建命令',
    );

    // 同一 seam 的另一侧：补上 index.html 就能启动，说明被拒的是产物缺失本身。
    await writeFile(path.join(webRoot, 'index.html'), INDEX_HTML);
    started = await startHttpServer(
      0,
      db,
      dataDir,
      { provider: PROVIDER, inFlight: createInFlightRounds() },
      { webRoot },
    );
  } finally {
    if (started !== undefined) {
      const toClose = started;
      await new Promise<void>((resolve) => {
        toClose.server.close(() => {
          resolve();
        });
      });
    }
    db.close();
    await removeTempDir(dataDir);
    await removeTempDir(webRoot);
  }
});

test('带 NUL 的路径是 404，不是内部错误', async () => {
  const fixture = await startStaticFixture('allibot-static-nul-');
  try {
    const response = await fetch(`${fixture.base}/notes.txt%00`);
    assert.equal(response.status, 404, `实测 ${response.status}`);
  } finally {
    await fixture.stop();
  }
});
