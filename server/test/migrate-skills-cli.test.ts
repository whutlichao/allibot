import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { removeTempDir, runCli, startServer } from './support.ts';

/**
 * `migrate-skills` (#48 / D6.3 / D6.4), observed through the CLI process and
 * the bytes / rows it leaves behind. The command is an explicit Node CLI
 * subcommand, dry-run by default, writes only with both `--apply --yes`, keeps
 * the old project-layer bytes and rows, and is never on the HTTP face or the
 * startup path.
 */

interface Fixture {
  tmp: string;
  dataDir: string;
  home: string;
  base: string;
  agentId: string;
  channelId: string;
  project: string;
  stopServer: () => Promise<void>;
  restartServer: () => Promise<void>;
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function startServerFixture(prefix: string): Promise<Fixture> {
  const tmp = mkdtempSync(path.join(tmpdir(), prefix));
  const dataDir = path.join(tmp, 'data');
  const home = path.join(tmp, 'home');
  const project = path.join(tmp, 'project');
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, migration.output);
  let running = await startServer(dataDir, { args: ['--scripted-provider', 'reply'], env: { HOME: home } });
  let base = `http://127.0.0.1:${running.port}`;

  const createAgent = await fetch(`${base}/api/agents`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ display_name: '迁移成员', model: 'openai:gpt-5' }),
  });
  assert.equal(createAgent.status, 201, await createAgent.clone().text());
  const agentId = (await readJson(createAgent))['id'] as string;
  const createChannel = await fetch(`${base}/api/channels`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      name: '迁移频道',
      description: '',
      mode: 'autonomous',
      response_budget_limit: 3,
    }),
  });
  assert.equal(createChannel.status, 201, await createChannel.clone().text());
  const channelId = (await readJson(createChannel))['id'] as string;
  const patched = await fetch(`${base}/api/channels/${channelId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ workspace_root: project }),
  });
  assert.equal(patched.status, 200, await patched.clone().text());

  const fixture: Fixture = {
    tmp,
    dataDir,
    home,
    base,
    agentId,
    channelId,
    project,
    stopServer: async () => {
      await running.stop();
    },
    restartServer: async () => {
      running = await startServer(dataDir, {
        args: ['--scripted-provider', 'reply'],
        env: { HOME: home },
      });
      base = `http://127.0.0.1:${running.port}`;
      fixture.base = base;
    },
  };
  return fixture;
}

async function cleanup(fixture: Fixture): Promise<void> {
  await fixture.stopServer();
  await removeTempDir(fixture.tmp);
}

function writeLegacySkill(
  fixture: Fixture,
  partition: string,
  name: string,
  manifest: string,
  extra: Record<string, string> = {},
): string {
  const directory = path.join(fixture.project, '.allibot', 'skills', partition, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'SKILL.md'), manifest, 'utf8');
  for (const [relative, content] of Object.entries(extra)) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return directory;
}

function agentSkillDir(fixture: Fixture, name: string): string {
  return path.join(fixture.home, '.allibot', 'agents', fixture.agentId, 'skills', name);
}

function rows(fixture: Fixture): Record<string, unknown>[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare('SELECT id, member_id, name, content_hash, enabled, source, created_at, updated_at FROM skill ORDER BY name')
      .all() as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

function backups(fixture: Fixture): string[] {
  return readdirSync(fixture.tmp).filter((entry) => entry.includes('backup-skills'));
}

/** The manifest lives beside the data directory, not inside it (D1.4). */
function manifests(fixture: Fixture): string[] {
  return readdirSync(fixture.tmp).filter((entry) => entry.startsWith('skill-migration-'));
}

function dataDirManifests(fixture: Fixture): string[] {
  return readdirSync(fixture.dataDir).filter((entry) => entry.startsWith('skill-migration-'));
}

function migrateSkills(fixture: Fixture, args: readonly string[] = []): ReturnType<typeof runCli> {
  return runCli(['migrate-skills', '--data-dir', fixture.dataDir, ...args], {
    env: { HOME: fixture.home },
  });
}

test('migrate-skills is a readable no-op in a clean repository and never runs at startup', async () => {
  const fixture = await startServerFixture('allibot-migrate-skills-empty-');
  try {
    // Neither an HTTP route nor the startup path may run the migration.
    for (const method of ['GET', 'POST']) {
      const route = await fetch(`${fixture.base}/api/migrate-skills`, { method });
      assert.equal(route.status, 404, `${method} must not expose migrate-skills`);
    }
    await fixture.stopServer();

    const response = migrateSkills(fixture);
    assert.equal(response.exitCode, 0, response.output);
    assert.match(response.output, /migrate-skills/);
    assert.match(response.output, /没有发现旧项目层技能字节|空操作/);
    assert.deepEqual(rows(fixture), []);
    assert.equal(existsSync(path.join(fixture.home, '.allibot', 'agents', fixture.agentId, 'skills')), false);
    assert.deepEqual(backups(fixture), []);
    assert.deepEqual(manifests(fixture), []);
    assert.deepEqual(dataDirManifests(fixture), []);

    writeLegacySkill(fixture, fixture.agentId, 'startup-legacy', 'STARTUP-LEGACY');
    await fixture.restartServer();
    assert.equal(existsSync(agentSkillDir(fixture, 'startup-legacy')), false);
    assert.deepEqual(rows(fixture), []);
  } finally {
    await cleanup(fixture);
  }
});

test('dry-run prints the plan with zero side effects; --apply --yes copies, records and keeps the old bytes', async () => {
  const fixture = await startServerFixture('allibot-migrate-skills-apply-');
  try {
    const memberSource = writeLegacySkill(
      fixture,
      fixture.agentId,
      'review',
      '---\nname: review\ndescription: 旧技能\n---\n\n# Review\n',
      { 'notes.txt': 'old notes\n' },
    );
    const channelSource = writeLegacySkill(
      fixture,
      fixture.channelId,
      'channel-only',
      '---\nname: channel-only\ndescription: 频道旧技能\n---\n\nchannel\n',
    );

    await fixture.stopServer();
    const dryRun = migrateSkills(fixture);
    assert.equal(dryRun.exitCode, 0, dryRun.output);
    assert.match(dryRun.output, /成员级技能/);
    assert.match(dryRun.output, /review/);
    assert.ok(dryRun.output.includes(memberSource), 'the plan names the legacy source');
    assert.ok(
      dryRun.output.includes(path.join(fixture.home, '.allibot', 'agents', fixture.agentId, 'skills', 'review')),
      'the plan names the member-home target',
    );
    assert.match(dryRun.output, /频道级技能（不迁移）/);
    assert.match(dryRun.output, /频道级已弃用/);
    assert.match(dryRun.output, /预演结束/);
    assert.equal(existsSync(agentSkillDir(fixture, 'review')), false, 'dry-run writes no bytes');
    assert.deepEqual(rows(fixture), []);
    assert.deepEqual(backups(fixture), []);
    assert.deepEqual(manifests(fixture), []);
    assert.deepEqual(dataDirManifests(fixture), []);

    assert.equal(migrateSkills(fixture, ['--apply']).exitCode, 2);
    assert.equal(migrateSkills(fixture, ['--yes']).exitCode, 2);
    assert.equal(existsSync(agentSkillDir(fixture, 'review')), false);
    assert.deepEqual(rows(fixture), []);

    const applied = migrateSkills(fixture, ['--apply', '--yes']);
    assert.equal(applied.exitCode, 0, applied.output);
    assert.match(applied.output, /技能迁移完成/);
    assert.match(applied.output, /可手工删除的源路径/);
    assert.equal(existsSync(path.join(agentSkillDir(fixture, 'review'), 'SKILL.md')), true);
    assert.equal(
      readFileSync(path.join(agentSkillDir(fixture, 'review'), 'notes.txt'), 'utf8'),
      'old notes\n',
    );
    assert.equal(existsSync(path.join(memberSource, 'SKILL.md')), true, 'the old bytes are kept');
    assert.equal(existsSync(path.join(channelSource, 'SKILL.md')), true);
    assert.equal(existsSync(agentSkillDir(fixture, 'channel-only')), false, 'channel bytes are not copied');

    const skillRows = rows(fixture);
    assert.equal(skillRows.length, 1);
    assert.equal(skillRows[0]!['member_id'], fixture.agentId);
    assert.equal(skillRows[0]!['name'], 'review');
    assert.equal(skillRows[0]!['source'], 'directory');
    assert.equal(skillRows[0]!['enabled'], 1);
    assert.match(String(skillRows[0]!['content_hash']), /^[0-9a-f]{64}$/);

    assert.equal(backups(fixture).length, 1, 'apply backs up the whole data directory');
    assert.equal(manifests(fixture).length, 1, 'apply writes one migration manifest');
    assert.deepEqual(dataDirManifests(fixture), [], 'the data directory keeps only its D1.4 files');
    assert.ok(
      readdirSync(path.join(fixture.tmp, backups(fixture)[0]!)).every(
        (entry) => !entry.startsWith('skill-migration-'),
      ),
      'the whole-directory backup does not contain the manifest',
    );
    const manifest = JSON.parse(
      readFileSync(path.join(fixture.tmp, manifests(fixture)[0]!), 'utf8'),
    ) as Record<string, unknown>;
    assert.equal((manifest['entries'] as unknown[]).length, 1);
    const manifestEntry = (manifest['entries'] as Record<string, unknown>[])[0]!;
    assert.equal(manifestEntry['name'], 'review');
    assert.equal(manifestEntry['member_id'], fixture.agentId);
    assert.equal(manifestEntry['target'], agentSkillDir(fixture, 'review'));
    assert.ok((manifest['channel_level'] as unknown[]).length >= 1);

    // A second apply is idempotent: no duplicate row, no second backup.
    const again = migrateSkills(fixture, ['--apply', '--yes']);
    assert.equal(again.exitCode, 0, again.output);
    assert.match(again.output, /跳过|没有需要写入/);
    assert.equal(rows(fixture).length, 1);
    assert.equal(backups(fixture).length, 1);
    assert.equal(manifests(fixture).length, 1);
    assert.deepEqual(dataDirManifests(fixture), []);
  } finally {
    await cleanup(fixture);
  }
});

test('a conflicting target refuses the whole apply without overwriting it', async () => {
  const fixture = await startServerFixture('allibot-migrate-skills-conflict-');
  try {
    writeLegacySkill(fixture, fixture.agentId, 'review', 'LEGACY-REVIEW');
    const target = agentSkillDir(fixture, 'review');
    mkdirSync(target, { recursive: true });
    writeFileSync(path.join(target, 'SKILL.md'), 'HUMAN-REVIEW', 'utf8');
    await fixture.stopServer();

    const refused = migrateSkills(fixture, ['--apply', '--yes']);
    assert.notEqual(refused.exitCode, 0);
    assert.match(refused.output, /拒绝|冲突/);
    assert.equal(readFileSync(path.join(target, 'SKILL.md'), 'utf8'), 'HUMAN-REVIEW');
    assert.deepEqual(rows(fixture), []);
    assert.deepEqual(backups(fixture), []);
    assert.deepEqual(manifests(fixture), []);
    assert.deepEqual(dataDirManifests(fixture), []);
  } finally {
    await cleanup(fixture);
  }
});
