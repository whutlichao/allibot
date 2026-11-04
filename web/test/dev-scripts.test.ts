import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

/**
 * 本地开发脚本的契约：`dev:web` 必须先重建 `shared`。
 *
 * 坑的形状：`web` 里 `import { t } from '@allibot/shared'` 走 `shared/package.json`
 * 的 `exports`，读到的是 `shared/dist` 而不是 `shared/src`（Vite 只对 `web/src`
 * 直读源码）。改了词条却没重建 `shared` 时，dev 态没有类型检查兜底，`t()` 对不存在
 * 的键直接抛错，整个界面白屏。
 *
 * 这个坑对 CI 不可见：本仓库所有测试脚本都自己先跑 `build --workspace shared`，
 * 于是「忘了重建」在测试里永远不复现。所以这条契约单独钉住脚本本身，而不是钉产物。
 */

const ROOT_PACKAGE = new URL('../../package.json', import.meta.url);
const SHARED_PACKAGE = new URL('../../shared/package.json', import.meta.url);
const DEPLOYMENT_DOC = new URL('../../docs/deployment.md', import.meta.url);

interface PackageManifest {
  scripts?: Record<string, string>;
  exports?: Record<string, { types?: string; import?: string }>;
}

async function readJson(url: URL): Promise<PackageManifest> {
  return JSON.parse(await readFile(url, 'utf8')) as PackageManifest;
}

/** 按 `&&` 切成可比较的逐步命令，并去掉多余空白。 */
function steps(script: string): string[] {
  return script.split('&&').map((step) => step.trim());
}

test('dev:web rebuilds shared before starting vite', async () => {
  const root = await readJson(ROOT_PACKAGE);
  const script = root.scripts?.['dev:web'];
  assert.equal(typeof script, 'string', 'root package.json has no dev:web script');

  const chain = steps(script!);
  assert.equal(
    chain[0],
    'npm run build --workspace shared',
    `dev:web must rebuild shared first, got: ${script}`,
  );
  assert.equal(
    chain.at(-1),
    'npm run dev --workspace web',
    `dev:web must end by starting the web dev server, got: ${script}`,
  );
});

test('shared is consumed through its dist build, not its sources', async () => {
  const shared = await readJson(SHARED_PACKAGE);
  const entry = shared.exports?.['.'];
  assert.equal(
    entry?.import,
    './dist/index.js',
    'shared "." export must point at dist; if this moves to src, the dev:web build step is no longer needed',
  );
});

test('the deployment doc does not claim dev:web skips the shared build', async () => {
  const doc = await readFile(DEPLOYMENT_DOC, 'utf8');
  assert.equal(
    doc.includes('`npm run dev:web` 不依赖这一步'),
    false,
    'docs/deployment.md still says dev:web does not depend on the build — that sentence is the bug the dev:web step fixes',
  );
  assert.equal(
    doc.includes('shared/dist'),
    true,
    'docs/deployment.md must name shared/dist as what the web dev server actually loads',
  );
});
