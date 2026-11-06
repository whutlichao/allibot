import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

/** 把单步命令按空白切成 argv（本文件里的命令都不带引号）。 */
function argv(step: string): string[] {
  return step.split(/\s+/).filter((token) => token.length > 0);
}

/**
 * 升级脚本里 `git pull --ff-only` 的语义：分叉时必须明确失败，而不是产生一个合并
 * 提交。这条用真实的本地 git 仓库验证，不依赖机器全局配置、不访问网络。
 *
 * 临时全局配置里刻意写了 `pull.ff = false`：用户机器上常见这种「默认合并」的配置，
 * 只有命令行上的 `--ff-only` 能否过它 —— 这正是少写 `--ff-only` 的 pull 会悄悄
 * 造出一个合并提交的原因。
 */
const GIT_IDENTITY = [
  '-c',
  'user.name=allibot test',
  '-c',
  'user.email=dev@allibot.test',
  '-c',
  'commit.gpgsign=false',
];

function gitEnv(globalConfig: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    // 全局与系统配置完全由本测试给定：身份、默认分支、pull 策略都不读用户机器。
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    LC_ALL: 'C',
    GIT_AUTHOR_NAME: 'allibot test',
    GIT_AUTHOR_EMAIL: 'dev@allibot.test',
    GIT_COMMITTER_NAME: 'allibot test',
    GIT_COMMITTER_EMAIL: 'dev@allibot.test',
  };
}

function git(env: NodeJS.ProcessEnv, cwd: string, args: string[]) {
  return spawnSync('git', [...GIT_IDENTITY, ...args], {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 30_000,
  });
}

function gitOk(env: NodeJS.ProcessEnv, cwd: string, args: string[]): string {
  const result = git(env, cwd, args);
  assert.equal(
    result.status,
    0,
    `git ${args.join(' ')} failed: ${result.stderr || result.stdout}`,
  );
  return result.stdout.trim();
}

async function commitFile(
  env: NodeJS.ProcessEnv,
  repo: string,
  name: string,
  content: string,
  message: string,
): Promise<string> {
  await writeFile(path.join(repo, name), content);
  gitOk(env, repo, ['add', name]);
  gitOk(env, repo, ['commit', '-m', message]);
  return gitOk(env, repo, ['rev-parse', 'HEAD']);
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

test('upgrade pulls fast-forward only, then installs, builds and migrates in that order', async () => {
  const root = await readJson(ROOT_PACKAGE);
  const script = root.scripts?.['upgrade'];
  assert.equal(typeof script, 'string', 'root package.json has no upgrade script');

  assert.deepEqual(
    steps(script!),
    ['git pull --ff-only', 'npm install', 'npm run build', 'npm run migrate'],
    `upgrade must be exactly pull → install → build → migrate, got: ${script}`,
  );
});

test('the upgrade pull step fails on a diverged clone and leaves the working tree untouched', async () => {
  const manifest = await readJson(ROOT_PACKAGE);
  const script = manifest.scripts?.['upgrade'];
  assert.equal(typeof script, 'string', 'root package.json has no upgrade script');
  const [pullStep] = steps(script!);
  assert.ok(pullStep, `upgrade has no first step, got: ${script}`);
  const tokens = argv(pullStep);
  const command = tokens[0];
  assert.ok(command, `upgrade step 1 is not a command, got: ${pullStep}`);
  const args = tokens.slice(1);

  const scratch = await mkdtemp(path.join(tmpdir(), 'allibot-upgrade-'));
  try {
    const globalConfig = path.join(scratch, 'gitconfig');
    await writeFile(globalConfig, '[pull]\n\tff = false\n');
    const env = gitEnv(globalConfig);

    const origin = path.join(scratch, 'origin.git');
    gitOk(env, scratch, ['init', '--bare', '--initial-branch=main', origin]);

    // 第一份 clone 扮演「origin 上有新提交」的那一侧。
    const upstream = path.join(scratch, 'upstream');
    gitOk(env, scratch, ['clone', origin, upstream]);
    await commitFile(env, upstream, 'base.txt', 'base\n', 'base');
    gitOk(env, upstream, ['push', 'origin', 'main']);

    // 第二份 clone 是被升级的那份工作副本。
    const work = path.join(scratch, 'work');
    gitOk(env, scratch, ['clone', origin, work]);

    await commitFile(env, upstream, 'upstream-only.txt', 'upstream\n', 'upstream commit');
    gitOk(env, upstream, ['push', 'origin', 'main']);

    const localHead = await commitFile(env, work, 'local-only.txt', 'work\n', 'local commit');
    gitOk(env, work, ['fetch', 'origin']);
    const statusBefore = gitOk(env, work, ['status', '--porcelain']);
    assert.equal(statusBefore, '', 'the working tree is clean before the pull step runs');
    assert.equal(
      gitOk(env, work, ['rev-list', '--count', 'origin/main..HEAD']),
      '1',
      'the work clone is one commit ahead of origin/main',
    );
    assert.equal(
      gitOk(env, work, ['rev-list', '--count', 'HEAD..origin/main']),
      '1',
      'origin/main is one commit ahead of the work clone',
    );

    const pull = spawnSync(command, args, {
      cwd: work,
      env,
      encoding: 'utf8',
      timeout: 30_000,
    });

    assert.notEqual(
      pull.status,
      0,
      `pull on a diverged clone must fail; stdout: ${pull.stdout} stderr: ${pull.stderr}`,
    );
    assert.match(
      pull.stderr,
      /Not possible to fast-forward/,
      `pull must fail because a fast-forward is impossible, got: ${pull.stderr}`,
    );
    assert.equal(gitOk(env, work, ['rev-parse', 'HEAD']), localHead, 'HEAD must not move');
    assert.equal(
      gitOk(env, work, ['status', '--porcelain']),
      statusBefore,
      'the working tree must stay unchanged',
    );
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
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
