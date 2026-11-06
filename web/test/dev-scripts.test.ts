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
const README = new URL('../../README.md', import.meta.url);
const STRING_SOURCE = new URL('../../shared/src/strings/zh-CN.ts', import.meta.url);

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
 * 文档点名命令的两处落点：```sh 代码块的每一行，与行内代码（单行 span）。
 * 只认 `sh` 块：其它语言的块里没有给 owner 照抄的命令。
 */
function shellBlockLines(doc: string): string[] {
  return [...doc.matchAll(/```sh\n([\s\S]*?)```/g)].flatMap((match) =>
    (match[1] ?? '').split('\n'),
  );
}

function inlineCodeSpans(doc: string): string[] {
  return [...doc.matchAll(/`([^`\n]+)`/g)].map((match) => match[1]!);
}

/**
 * 把一行命令行切成单步命令：`&&` 分段、去掉 `$` 提示符与环境变量赋值前缀
 * （`allibot_API_ORIGIN=… npm run dev:web` 里前置的那段不是命令本身）。
 */
function commandSteps(line: string): string[] {
  return line
    .trim()
    .replace(/^\$\s+/, '')
    .split('&&')
    .map((step) => step.trim())
    .map((step) => {
      const tokens = argv(step);
      while (tokens.length > 0 && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]!)) {
        tokens.shift();
      }
      return tokens.join(' ');
    })
    .filter((step) => step.length > 0);
}

/** 一条文档命令点名的 npm 脚本，以及它属于哪个 workspace（`null` = 根）。 */
interface NpmScriptReference {
  command: string;
  script: string;
  workspace: string | null;
}

/** `npm ci` / `npm install` 不是脚本，不需要出现在任何 `scripts` 里。 */
const NPM_SUBCOMMANDS = new Set(['ci', 'install']);

/** 从单步命令里认出 `npm run <script>` / `npm <script>`；不是 npm 命令就返回 null。 */
function npmScriptReference(step: string): NpmScriptReference | null {
  const tokens = argv(step);
  if (tokens[0] !== 'npm') {
    return null;
  }
  const subcommand = tokens[1];
  if (subcommand === undefined || NPM_SUBCOMMANDS.has(subcommand)) {
    return null;
  }
  const script = subcommand === 'run' ? tokens[2] : subcommand;
  if (script === undefined || script.startsWith('-')) {
    return null;
  }
  const flag = tokens.findIndex((token) => token === '--workspace' || token === '-w');
  return { command: step, script, workspace: flag === -1 ? null : (tokens[flag + 1] ?? null) };
}

/** 文档里的 `--workspace <name>` 指向该 workspace 的 `scripts`；没写就是根。 */
async function scriptsOf(workspace: string | null): Promise<Record<string, string>> {
  const manifest = await readJson(
    workspace === null ? ROOT_PACKAGE : new URL(`../../${workspace}/package.json`, import.meta.url),
  );
  return manifest.scripts ?? {};
}

/** 从词条源码里取出一个条目块的原文：键所在位置到下一个同级键之前。 */
function catalogEntrySource(source: string, key: string): string {
  const start = source.indexOf(`'${key}':`);
  assert.notEqual(start, -1, `shared/src/strings/zh-CN.ts 里没有 ${key} 这个词条`);
  const end = source.indexOf('\n  },', start);
  assert.notEqual(end, -1, `${key} 的条目块没有正常结束`);
  return source.slice(start, end);
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

test('root start runs the production serve entry, and the dev scripts stay as they are', async () => {
  const root = await readJson(ROOT_PACKAGE);
  // 单命令启动 (M4 / D7)：一个进程既托管前端又提供 API。不加 `bin`、不装
  // 全局命令，所以启动入口只能是仓库里真实存在的 dist/cli.js。
  assert.equal(
    root.scripts?.['start'],
    'node dist/cli.js serve',
    `root start must run the production serve entry, got: ${String(root.scripts?.['start'])}`,
  );
  // 只增生产路径 (D12)：热重载是维护这个仓库的手段，不是产品功能，两行 dev
  // 脚本不能被 start 顺手改掉或取代。
  assert.equal(
    root.scripts?.['dev:server'],
    'node dist/cli.js serve --port 3000',
    `dev:server must stay as it was, got: ${String(root.scripts?.['dev:server'])}`,
  );
  assert.equal(
    root.scripts?.['dev:web'],
    'npm run build --workspace shared && npm run dev --workspace web',
    `dev:web must stay as it was, got: ${String(root.scripts?.['dev:web'])}`,
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

/**
 * 文档（README 与部署文档）让人照抄的 npm 命令必须真能跑：点名的脚本要么在根
 * `package.json` 的 `scripts` 里，要么在被 `--workspace <name>` 指向的那个
 * workspace 里。只断言名字存在，不断言脚本内容 —— 脚本内容由各条契约测试守。
 */
test('every npm script the docs name exists in the package it runs in', async () => {
  const docs = [
    { name: 'README.md', url: README },
    { name: 'docs/deployment.md', url: DEPLOYMENT_DOC },
  ];
  const scriptTables = new Map<string, Record<string, string>>();
  const missing: string[] = [];
  let references = 0;

  for (const doc of docs) {
    const text = await readFile(doc.url, 'utf8');
    const commands = [
      ...shellBlockLines(text).flatMap(commandSteps),
      ...inlineCodeSpans(text)
        .filter((span) => span.includes('npm '))
        .flatMap(commandSteps),
    ];
    for (const command of commands) {
      const reference = npmScriptReference(command);
      if (reference === null) {
        continue;
      }
      references += 1;
      const owner = reference.workspace ?? '.';
      if (!scriptTables.has(owner)) {
        scriptTables.set(owner, await scriptsOf(reference.workspace));
      }
      const scripts = scriptTables.get(owner)!;
      if (!Object.hasOwn(scripts, reference.script)) {
        missing.push(
          `${doc.name}：${reference.command} —— ${owner === '.' ? '根 package.json' : `${owner}/package.json`} 的 scripts 里没有 ${reference.script}`,
        );
      }
    }
  }

  // 抽取规则自己也会坏：一条命令都没抽到时，上面的循环会空过。
  assert.ok(references > 0, 'README.md / docs/deployment.md 里没抽出任何 npm 命令');
  assert.deepEqual(missing, [], `文档点名的 npm 脚本在仓库里不存在：\n${missing.join('\n')}`);
});

/**
 * 根 `package.json` 没有 `bin` 字段，仓库里就没有 `allibot` 这个可执行文件
 * （照抄只能得到 command not found）。所以 README 的 `sh` 代码块里不能出现以
 * `allibot` 开头的命令行；只说仓库里真实存在的 `npm run …` / `node dist/cli.js …`。
 * `allibot_API_ORIGIN=… npm run dev:web` 这类环境变量前缀不算（它后面跑的是 npm）。
 */
test('the README never hands the owner a global `allibot` command', async () => {
  const readme = await readFile(README, 'utf8');
  const lines = shellBlockLines(readme);
  const npmSteps = lines.flatMap(commandSteps).filter((step) => argv(step)[0] === 'npm');
  assert.ok(npmSteps.length > 0, 'README.md 的 sh 代码块里没抽出任何 npm 命令');

  const offenders = lines.flatMap((line) =>
    commandSteps(line)
      .filter((step) => argv(step)[0] === 'allibot')
      .map((step) => `${line.trim()} → ${step}`),
  );
  assert.deepEqual(
    offenders,
    [],
    `README.md 让人跑一个本仓不存在的全局命令（根 package.json 没有 bin 字段）：\n${offenders.join('\n')}`,
  );
});

/**
 * `cli.schema.tooOld` 是 owner 照着敲的提示（规格 D8）：文案里点名的
 * `npm run <script>` 必须真在根 `package.json` 里，脚本被删或改名时这条要红。
 * 文案从 `shared/src/strings/zh-CN.ts` 的源码读，不读 `shared/dist`：
 * `test:dev-scripts` 自己不构建 shared，读产物会在改了文案却忘了重建时静默通过。
 * 脚本内容不逐字比，只要求它跑的是本仓 CLI 的迁移。
 */
test('the schema-too-old hint only names root scripts that exist', async () => {
  const entry = catalogEntrySource(await readFile(STRING_SOURCE, 'utf8'), 'cli.schema.tooOld');
  const references = inlineCodeSpans(entry)
    .flatMap(commandSteps)
    .map(npmScriptReference)
    .filter((reference): reference is NpmScriptReference => reference !== null);
  assert.ok(references.length > 0, 'cli.schema.tooOld 的文案里没有点名任何 npm run 脚本');

  const scripts = await scriptsOf(null);
  const missing = references
    .filter((reference) => reference.workspace !== null || !Object.hasOwn(scripts, reference.script))
    .map((reference) => reference.command);
  assert.deepEqual(missing, [], `cli.schema.tooOld 点名的脚本在根 package.json 里不存在：${missing.join('、')}`);

  const notTheMigration = references
    .map((reference) => ({ reference, body: scripts[reference.script] ?? '' }))
    .filter(({ body }) => !body.includes('dist/cli.js') || !body.includes('--migrate'))
    .map(({ reference }) => `${reference.script}：${scripts[reference.script] ?? '(缺失)'}`);
  assert.deepEqual(
    notTheMigration,
    [],
    `cli.schema.tooOld 点名的脚本不是本仓 CLI 的迁移：${notTheMigration.join('、')}`,
  );
});
