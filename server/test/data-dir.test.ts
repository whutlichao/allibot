import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { makeTempDir, removeTempDir, runCli } from './support.ts';

const DB_FILENAME = 'allibot.db';

test('--data-dir takes precedence over allibot_DATA_DIR and the default', async () => {
  const root = await makeTempDir('allibot-resolution-flag-');
  try {
    const home = path.join(root, 'home');
    const flagDir = path.join(root, 'flag-data');
    const envDir = path.join(root, 'env-data');
    await mkdir(home, { recursive: true });

    const result = runCli(['--migrate', '--data-dir', flagDir], {
      env: { HOME: home, allibot_DATA_DIR: envDir },
    });

    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(existsSync(path.join(flagDir, DB_FILENAME)), true, 'the flag directory wins');
    assert.equal(existsSync(envDir), false, 'the env directory must not be touched');
    assert.equal(
      existsSync(path.join(home, '.allibot', 'data')),
      false,
      'the default directory must not be touched',
    );
  } finally {
    await removeTempDir(root);
  }
});

test('allibot_DATA_DIR is used when no --data-dir is given, even if a legacy directory exists', async () => {
  const root = await makeTempDir('allibot-resolution-env-');
  try {
    const home = path.join(root, 'home');
    const envDir = path.join(root, 'env-data');
    await mkdir(home, { recursive: true });
    await mkdir(path.join(home, 'allibot'), { recursive: true });

    const result = runCli(['--migrate'], {
      env: { HOME: home, allibot_DATA_DIR: envDir },
    });

    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(existsSync(path.join(envDir, DB_FILENAME)), true, 'the env directory wins');
    assert.equal(
      existsSync(path.join(home, '.allibot', 'data')),
      false,
      'the default directory must not be touched',
    );
    assert.equal(
      existsSync(path.join(home, 'allibot', DB_FILENAME)),
      false,
      'the legacy directory must not be touched',
    );
  } finally {
    await removeTempDir(root);
  }
});

test('an existing new default directory wins over an existing legacy directory', async () => {
  const root = await makeTempDir('allibot-resolution-default-');
  try {
    const home = path.join(root, 'home');
    const defaultDir = path.join(home, '.allibot', 'data');
    const legacyDir = path.join(home, 'allibot');
    await mkdir(defaultDir, { recursive: true });
    await mkdir(legacyDir, { recursive: true });

    const result = runCli(['--migrate'], { env: { HOME: home } });

    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(existsSync(path.join(defaultDir, DB_FILENAME)), true);
    assert.equal(existsSync(path.join(legacyDir, DB_FILENAME)), false);
    assert.doesNotMatch(result.output, /legacy data directory/);
    assert.doesNotMatch(result.output, /旧数据目录/);
  } finally {
    await removeTempDir(root);
  }
});

test('a legacy ~/allibot directory is used read-in-place with a visible warning and is not moved', async () => {
  const root = await makeTempDir('allibot-resolution-legacy-');
  try {
    const home = path.join(root, 'home');
    const legacyDir = path.join(home, 'allibot');
    const defaultDir = path.join(home, '.allibot', 'data');
    await mkdir(legacyDir, { recursive: true });

    const result = runCli(['serve'], { env: { HOME: home } });

    assert.notEqual(result.exitCode, 0, `serve without a database must fail; output: ${result.output}`);
    assert.match(result.stderr, /旧数据目录/);
    assert.match(result.stderr, /既有数据不会被移动/);
    assert.ok(
      result.output.includes(path.join(legacyDir, DB_FILENAME)),
      `resolution should point at the legacy directory; output: ${result.output}`,
    );
    assert.equal(existsSync(defaultDir), false, 'the new default must not be created');
    assert.deepEqual(await readdir(legacyDir), [], 'legacy data must not be moved or written');
  } finally {
    await removeTempDir(root);
  }
});

test('a fresh install creates the new default directory under the temporary HOME', async () => {
  const root = await makeTempDir('allibot-resolution-fresh-');
  try {
    const home = path.join(root, 'home');
    await mkdir(home, { recursive: true });

    const result = runCli(['--migrate'], { env: { HOME: home } });

    assert.equal(result.exitCode, 0, `migrate should exit 0; output: ${result.output}`);
    assert.equal(
      existsSync(path.join(home, '.allibot', 'data', DB_FILENAME)),
      true,
      'a fresh install migrates into ~/.allibot/data',
    );
  } finally {
    await removeTempDir(root);
  }
});
