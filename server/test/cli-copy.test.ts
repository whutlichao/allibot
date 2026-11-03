import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { CLI_ENTRY, REPO_ROOT, makeTempDir, removeTempDir, runCli } from './support.ts';
import { SCHEMA_VERSION } from '../dist/db.js';

/**
 * 后端生成的自然语言按语言偏好渲染：语言偏好落库、后端是唯一正本。这几条
 * 断言看的是进程输出这一面——`--migrate` 与 `serve` 的用户可见消息由词条表
 * 的 zh-CN 键渲染，而不是散落的英文字面量。
 */
test('the migrate receipt renders from the zh-CN catalog', async () => {
  const dataDir = await makeTempDir('allibot-copy-migrate-');
  try {
    const first = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(first.exitCode, 0, `migrate should exit 0; output: ${first.output}`);
    assert.match(
      first.stdout,
      new RegExp(`已把数据目录 ${escapeRegExp(dataDir)} 迁移到 Schema 版本 ${SCHEMA_VERSION}。`),
    );
    assert.doesNotMatch(first.output, /migrated .* to schema version/);

    const second = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(second.exitCode, 0, `second migrate should exit 0; output: ${second.output}`);
    assert.match(second.stdout, new RegExp(`数据目录 ${escapeRegExp(dataDir)} 已是 Schema 版本 ${SCHEMA_VERSION}。`));
    assert.doesNotMatch(second.output, /already at schema version/);
  } finally {
    await removeTempDir(dataDir);
  }
});

test('the legacy data dir warning renders from the zh-CN catalog', async () => {
  const root = await makeTempDir('allibot-copy-legacy-');
  try {
    const home = path.join(root, 'home');
    const legacyDir = path.join(home, 'allibot');
    await mkdir(legacyDir, { recursive: true });

    const result = runCli(['--migrate'], { env: { HOME: home } });

    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.match(
      result.stderr,
      new RegExp(`警告：正在使用旧数据目录 ${escapeRegExp(legacyDir)} 做兼容读取`),
    );
    assert.match(result.stderr, /既有数据不会被移动/);
    assert.doesNotMatch(result.output, /legacy data directory/);

    const db = new Database(path.join(legacyDir, 'allibot.db'), { readonly: true });
    try {
      const row = db.prepare('SELECT schema_version FROM schema_meta').get() as {
        schema_version: number;
      };
      assert.equal(row.schema_version, 9);
    } finally {
      db.close();
    }
  } finally {
    await removeTempDir(root);
  }
});

test('the serve listening message renders from the zh-CN catalog', async () => {
  const dataDir = await makeTempDir('allibot-copy-serve-');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);

  // 自己起进程而不是复用 startServer：后者只等到端口就返回，这一条要看
  // 同一行 stdout 上的用户可见文案。
  const child = spawn(process.execPath, [CLI_ENTRY, 'serve', '--data-dir', dataDir, '--port', '0'], {
    cwd: REPO_ROOT,
    env: { ...process.env, HOME: path.join(dataDir, 'home') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let output = '';
    child.stdout.setEncoding('utf8');
    const matched = await new Promise<RegExpExecArray>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`no listening copy within 10s; output: ${output}`));
      }, 10_000);
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        const match = /allibot 已监听 (http:\/\/127\.0\.0\.1:\d+)。/.exec(output);
        if (match !== null) {
          clearTimeout(timer);
          resolve(match);
        }
      });
      child.once('exit', () => {
        clearTimeout(timer);
        reject(new Error(`server exited before listening; output: ${output}`));
      });
    });

    assert.doesNotMatch(output, /allibot server listening on/);
    const response = await fetch(`${matched[1]}/api/settings`);
    assert.equal(response.status, 200, await response.clone().text());
  } finally {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve();
        return;
      }
      child.once('exit', () => resolve());
    });
    await removeTempDir(dataDir);
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
