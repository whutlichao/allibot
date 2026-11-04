import assert from 'node:assert/strict';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { removeTempDir, runCli, startServer, type RunningServer } from './support.ts';
import { buildZip } from './zip-support.ts';

/**
 * Skill 安装 / 字节 / 管理面 (#48 / D2.3 / D2.4 / D6.3), observed through the
 * one process seam: a real backend, the human REST face and the home bytes.
 *
 * The four `skill` columns are the v21 metadata; bytes live in the member home
 * and never enter SQLite. The suite drives the three install sources through
 * the same installer and asserts the hash / limit / conflict / idempotence
 * contract from the ticket.
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
    body: JSON.stringify({ display_name: 'Skill 成员', model: 'openai:gpt-5' }),
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

function skillSource(
  root: string,
  name: string,
  options: { body?: string; extra?: Record<string, string> } = {},
): string {
  const directory = path.join(root, `${name}-source`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${name} 的技能\n---\n\n${options.body ?? '# Skill\n\nbody'}\n`,
    'utf8',
  );
  for (const [relative, content] of Object.entries(options.extra ?? {})) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return directory;
}

function skillDir(fixture: Fixture, name: string): string {
  return path.join(fixture.agentHome, 'skills', name);
}

function installDirectory(fixture: Fixture, body: unknown): Promise<Response> {
  return fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchSkill(fixture: Fixture, name: string, body: unknown): Promise<Response> {
  return fetch(
    `${fixture.base}/api/agents/${fixture.agentId}/skills/${encodeURIComponent(name)}`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
}

function deleteSkill(fixture: Fixture, name: string): Promise<Response> {
  return fetch(
    `${fixture.base}/api/agents/${fixture.agentId}/skills/${encodeURIComponent(name)}`,
    { method: 'DELETE' },
  );
}

function listSkills(fixture: Fixture): Promise<Response> {
  return fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`);
}

test('a directory install writes the row and the home bytes; replay / conflict / patch / delete follow D2.4', async () => {
  const fixture = await startFixture('allibot-skills-install-');
  try {
    const source = skillSource(fixture.tmp, 'review', {
      body: '# Review\n\n按清单评审。',
      extra: { 'references/checklist.md': 'one\ntwo\n' },
    });

    const created = await installDirectory(fixture, { source: 'directory', path: source });
    assert.equal(created.status, 201, await created.clone().text());
    const createdBody = await readJson(created);
    const skill = createdBody['skill'] as Record<string, unknown>;
    assert.equal(skill['member_id'], fixture.agentId);
    assert.equal(skill['name'], 'review');
    assert.match(String(skill['content_hash']), /^[0-9a-f]{64}$/);
    assert.equal(skill['source'], 'directory');
    assert.equal(skill['enabled'], true);
    assert.equal(createdBody['created'], true);
    assert.equal(skillDir(fixture, 'review'), path.join(fixture.agentHome, 'skills', 'review'));
    assert.equal(
      readFileSync(path.join(skillDir(fixture, 'review'), 'SKILL.md'), 'utf8').includes('按清单评审。'),
      true,
    );
    assert.equal(
      readFileSync(path.join(skillDir(fixture, 'review'), 'references', 'checklist.md'), 'utf8'),
      'one\ntwo\n',
    );
    assert.equal(existsSync(path.join(source, 'SKILL.md')), true, 'the source directory is copied, not moved');
    assert.equal(
      readFileSync(path.join(fixture.dataDir, 'allibot.db')).includes('按清单评审。'),
      false,
      'the skill body never enters SQLite',
    );

    const list = await listSkills(fixture);
    assert.equal(list.status, 200);
    const listBody = await readJson(list);
    assert.equal(listBody['agent_id'], fixture.agentId);
    const listed = listBody['skills'] as Record<string, unknown>[];
    assert.equal(listed.length, 1);
    assert.deepEqual(listed[0], skill);

    const detail = await fetch(
      `${fixture.base}/api/agents/${fixture.agentId}/skills/review`,
    );
    assert.equal(detail.status, 200, await detail.clone().text());
    const detailBody = await readJson(detail);
    assert.deepEqual(detailBody['skill'], skill);
    assert.match(String(detailBody['markdown']), /按清单评审。/);

    // Same source and bytes replay -> 200, no second row, same id.
    const replay = await installDirectory(fixture, { source: 'directory', path: source });
    assert.equal(replay.status, 200, await replay.clone().text());
    const replayBody = await readJson(replay);
    assert.equal(replayBody['created'], false);
    assert.equal((replayBody['skill'] as Record<string, unknown>)['id'], skill['id']);
    const afterReplay = await readJson(await listSkills(fixture));
    assert.equal((afterReplay['skills'] as unknown[]).length, 1);

    // Same name with different bytes -> 409 and the installed bytes stay.
    const changed = skillSource(fixture.tmp, 'review', {
      body: '# Review\n\n完全不同。',
      extra: { 'references/checklist.md': 'three\n' },
    });
    const conflict = await installDirectory(fixture, { source: 'directory', path: changed });
    assert.equal(conflict.status, 409, await conflict.clone().text());
    const conflictBody = await readJson(conflict);
    assert.equal((conflictBody['error'] as Record<string, unknown>)['code'], 'conflict');
    assert.match(
      readFileSync(path.join(skillDir(fixture, 'review'), 'SKILL.md'), 'utf8'),
      /按清单评审。/,
    );

    // PATCH only changes updated_at when the value changes.
    const oldUpdatedAt = skill['updated_at'] as string;
    const disabled = await patchSkill(fixture, 'review', { enabled: false });
    assert.equal(disabled.status, 200, await disabled.clone().text());
    const disabledBody = await readJson(disabled);
    const disabledSkill = disabledBody['skill'] as Record<string, unknown>;
    assert.equal(disabledSkill['enabled'], false);
    assert.notEqual(disabledSkill['updated_at'], oldUpdatedAt);
    const same = await patchSkill(fixture, 'review', { enabled: false });
    assert.equal(same.status, 200);
    assert.equal(
      ((await readJson(same))['skill'] as Record<string, unknown>)['updated_at'],
      disabledSkill['updated_at'],
    );
    assert.equal(existsSync(skillDir(fixture, 'review')), true, 'disable keeps the bytes');
    assert.equal((await patchSkill(fixture, 'review', { enabled: 'no' })).status, 400);
    assert.equal((await patchSkill(fixture, 'review', {})).status, 400);
    assert.equal((await patchSkill(fixture, 'review', { enabled: true, extra: 1 })).status, 400);
    assert.equal((await patchSkill(fixture, 'missing', { enabled: false })).status, 404);

    const deleted = await deleteSkill(fixture, 'review');
    assert.equal(deleted.status, 204);
    assert.equal(existsSync(skillDir(fixture, 'review')), false);
    assert.equal(existsSync(path.join(source, 'SKILL.md')), true, 'delete never touches the source');
    assert.deepEqual((await readJson(await listSkills(fixture)))['skills'], []);
    assert.equal((await deleteSkill(fixture, 'review')).status, 204, 'a repeat delete is still 204');
    assert.equal(
      (await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills/review`)).status,
      404,
    );
  } finally {
    await fixture.stop();
  }
});

test('install validation covers the Agent, source shape, slug and SKILL.md', async () => {
  const fixture = await startFixture('allibot-skills-validation-');
  try {
    const unknown = await fetch(`${fixture.base}/api/agents/not-an-agent/skills`);
    assert.equal(unknown.status, 404);
    const unknownInstall = await fetch(`${fixture.base}/api/agents/not-an-agent/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'directory', path: fixture.tmp }),
    });
    assert.equal(unknownInstall.status, 404);
    const unknownDelete = await fetch(`${fixture.base}/api/agents/not-an-agent/skills/x`, {
      method: 'DELETE',
    });
    assert.equal(unknownDelete.status, 404);

    const noManifest = path.join(fixture.tmp, 'no-manifest');
    mkdirSync(noManifest, { recursive: true });
    writeFileSync(path.join(noManifest, 'notes.txt'), 'no skill here', 'utf8');
    const noManifestResponse = await installDirectory(fixture, {
      source: 'directory',
      path: noManifest,
    });
    assert.equal(noManifestResponse.status, 400);
    assert.equal(
      ((await readJson(noManifestResponse))['error'] as Record<string, unknown>)['code'],
      'validation_failed',
    );

    const tooManyDirectory = path.join(fixture.tmp, 'too-many-directory');
    mkdirSync(tooManyDirectory, { recursive: true });
    writeFileSync(path.join(tooManyDirectory, 'SKILL.md'), 'ok', 'utf8');
    for (let index = 0; index < 200; index += 1) {
      writeFileSync(path.join(tooManyDirectory, `f${index}.txt`), 'x', 'utf8');
    }
    assert.equal(
      (await installDirectory(fixture, { source: 'directory', path: tooManyDirectory, name: 'too-many-dir' }))
        .status,
      400,
    );

    const tooLargeDirectory = path.join(fixture.tmp, 'too-large-directory');
    mkdirSync(tooLargeDirectory, { recursive: true });
    writeFileSync(path.join(tooLargeDirectory, 'SKILL.md'), 'ok', 'utf8');
    writeFileSync(path.join(tooLargeDirectory, 'big.bin'), Buffer.alloc(5 * 1024 * 1024 + 1));
    assert.equal(
      (await installDirectory(fixture, { source: 'directory', path: tooLargeDirectory, name: 'too-large-dir' }))
        .status,
      400,
    );

    const escapingSymlink = path.join(fixture.tmp, 'escaping-symlink');
    mkdirSync(escapingSymlink, { recursive: true });
    writeFileSync(path.join(escapingSymlink, 'SKILL.md'), 'ok', 'utf8');
    writeFileSync(path.join(fixture.tmp, 'outside-secret.txt'), 'outside', 'utf8');
    symlinkSync(path.join(fixture.tmp, 'outside-secret.txt'), path.join(escapingSymlink, 'outside.txt'));
    assert.equal(
      (await installDirectory(fixture, { source: 'directory', path: escapingSymlink, name: 'escaping' }))
        .status,
      400,
    );

    const source = skillSource(fixture.tmp, 'good');
    for (const name of ['../escape', 'a/b', '/absolute', 'Bad Name', '']) {
      const response = await installDirectory(fixture, { source: 'directory', path: source, name });
      assert.equal(response.status, 400, `name ${JSON.stringify(name)} must be refused`);
    }
    assert.equal((await installDirectory(fixture, { source: 'nope', path: source })).status, 400);
    assert.equal((await installDirectory(fixture, { source: 'directory' })).status, 400);
    assert.equal(
      (await installDirectory(fixture, { source: 'directory', path: 'relative/path' })).status,
      400,
    );
    assert.equal(
      (await installDirectory(fixture, { source: 'directory', path: path.join(fixture.tmp, 'missing') }))
        .status,
      400,
    );
    // No row or home bytes are left behind by a refused install.
    assert.deepEqual((await readJson(await listSkills(fixture)))['skills'], []);
    assert.equal(existsSync(path.join(fixture.agentHome, 'skills')), false);
  } finally {
    await fixture.stop();
  }
});

function uploadSkill(fixture: Fixture, name: string | null, bytes: Buffer): Promise<Response> {
  const query = name === null ? '' : `?name=${encodeURIComponent(name)}`;
  return fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills/upload${query}`, {
    method: 'POST',
    headers: { 'content-type': 'application/zip' },
    body: bytes,
  });
}

test('a zip upload installs the same normalized bytes and refuses each unsafe / oversized archive', async () => {
  const fixture = await startFixture('allibot-skills-zip-');
  try {
    const manifest = '---\nname: zipped\ndescription: zip 技能\n---\n\n# Zipped\n\nzip body\n';
    const directory = path.join(fixture.tmp, 'zip-equal-source');
    mkdirSync(directory, { recursive: true });
    writeFileSync(path.join(directory, 'SKILL.md'), manifest, 'utf8');
    writeFileSync(path.join(directory, 'checklist.md'), 'a\nb\n', 'utf8');
    const fromDirectory = await installDirectory(fixture, {
      source: 'directory',
      path: directory,
      name: 'directory-equal',
    });
    assert.equal(fromDirectory.status, 201, await fromDirectory.clone().text());
    const directorySkill = (await readJson(fromDirectory))['skill'] as Record<string, unknown>;

    const zip = buildZip([
      { path: 'zip-equal/SKILL.md', content: manifest },
      { path: 'zip-equal/checklist.md', content: 'a\nb\n' },
    ]);
    const uploaded = await uploadSkill(fixture, 'zip-equal', zip);
    assert.equal(uploaded.status, 201, await uploaded.clone().text());
    const uploadedBody = await readJson(uploaded);
    const skill = uploadedBody['skill'] as Record<string, unknown>;
    assert.equal(skill['source'], 'zip');
    assert.equal(skill['name'], 'zip-equal');
    assert.equal(
      skill['content_hash'],
      directorySkill['content_hash'],
      'the same bytes produce the same hash from a zip and a directory',
    );
    assert.equal(
      readFileSync(path.join(skillDir(fixture, 'zip-equal'), 'checklist.md'), 'utf8'),
      'a\nb\n',
    );

    const replay = await uploadSkill(fixture, 'zip-equal', zip);
    assert.equal(replay.status, 200, await replay.clone().text());
    assert.equal((await readJson(replay))['created'], false);
    const different = buildZip([{ path: 'zip-equal/SKILL.md', content: 'changed' }]);
    assert.equal((await uploadSkill(fixture, 'zip-equal', different)).status, 409);

    const random = Buffer.from('this is definitely not a zip archive');
    assert.equal((await uploadSkill(fixture, 'bad', random)).status, 400);
    assert.equal(
      (await uploadSkill(fixture, 'missing-manifest', buildZip([{ path: 'notes.txt', content: 'x' }])))
        .status,
      400,
    );
    assert.equal(
      (await uploadSkill(
        fixture,
        'escape',
        buildZip([{ path: '../escape.txt', content: 'x' }, { path: 'SKILL.md', content: 'ok' }]),
      )).status,
      400,
    );
    assert.equal(
      (await uploadSkill(
        fixture,
        'absolute',
        buildZip([{ path: '/tmp/escape.txt', content: 'x' }, { path: 'SKILL.md', content: 'ok' }]),
      )).status,
      400,
    );
    assert.equal(
      (await uploadSkill(
        fixture,
        'symlink',
        buildZip([
          { path: 'SKILL.md', content: 'ok' },
          { path: 'link', content: '/etc/passwd', symlink: true },
        ]),
      )).status,
      400,
    );

    const tooMany = buildZip([
      { path: 'SKILL.md', content: 'ok' },
      ...Array.from({ length: 200 }, (_value, index) => ({
        path: `f${index}.txt`,
        content: 'x',
      })),
    ]);
    assert.equal((await uploadSkill(fixture, 'too-many', tooMany)).status, 400);

    const tooLargeExtracted = buildZip([
      { path: 'SKILL.md', content: 'ok' },
      { path: 'big.bin', content: Buffer.alloc(5 * 1024 * 1024 + 1) },
    ]);
    assert.equal((await uploadSkill(fixture, 'too-large-extracted', tooLargeExtracted)).status, 400);

    const tooLargeZip = Buffer.alloc(5 * 1024 * 1024 + 1);
    const tooLargeZipResponse = await uploadSkill(fixture, 'too-large-zip', tooLargeZip);
    assert.equal(tooLargeZipResponse.status, 400);
    assert.equal(
      ((await readJson(tooLargeZipResponse))['error'] as Record<string, unknown>)['code'],
      'validation_failed',
    );

    assert.equal((await uploadSkill(fixture, null, zip)).status, 400);
    assert.equal((await uploadSkill(fixture, 'Bad Name', zip)).status, 400);
  } finally {
    await fixture.stop();
  }
});

function candidateRoot(fixture: Fixture): string {
  return path.join(fixture.home, '.agents', 'skills');
}

function writeCandidate(
  fixture: Fixture,
  name: string,
  options: { manifest?: string | null; extra?: Record<string, string> } = {},
): string {
  const directory = path.join(candidateRoot(fixture), name);
  mkdirSync(directory, { recursive: true });
  if (options.manifest !== null) {
    writeFileSync(
      path.join(directory, 'SKILL.md'),
      options.manifest ?? `---\nname: ${name}\ndescription: ${name} 候选\n---\n\n# ${name}\n`,
      'utf8',
    );
  }
  for (const [relative, content] of Object.entries(options.extra ?? {})) {
    const file = path.join(directory, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, content, 'utf8');
  }
  return directory;
}

test('candidates scan ~/.agents/skills read-only, mark installed entries, and import through the same installer', async () => {
  const fixture = await startFixture('allibot-skills-candidates-');
  try {
    const missing = await fetch(
      `${fixture.base}/api/agents/${fixture.agentId}/skill-candidates`,
    );
    assert.equal(missing.status, 200);
    const missingBody = await readJson(missing);
    assert.equal(missingBody['available'], false);
    assert.deepEqual(missingBody['candidates'], []);
    assert.equal(existsSync(candidateRoot(fixture)), false, 'the read never creates the landing dir');

    writeCandidate(fixture, 'alpha', { extra: { 'notes.txt': 'alpha notes' } });
    writeCandidate(fixture, 'broken', { manifest: null });
    writeCandidate(fixture, 'Bad Name');
    mkdirSync(path.join(fixture.tmp, 'outside-skill'), { recursive: true });
    writeFileSync(path.join(fixture.tmp, 'outside-skill', 'SKILL.md'), 'outside', 'utf8');
    const symlinkCandidate = path.join(candidateRoot(fixture), 'linked');
    // Directory symlinks are the escaping-candidate case; the scanner refuses
    // to follow them out of its root.
    mkdirSync(candidateRoot(fixture), { recursive: true });
    try {
      symlinkSync(path.join(fixture.tmp, 'outside-skill'), symlinkCandidate);
    } catch {
      // A platform without symlink permission still exercises the other cases.
    }

    const scan = await readJson(
      await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skill-candidates`),
    );
    assert.equal(scan['available'], true);
    const candidates = scan['candidates'] as Record<string, unknown>[];
    const byName = new Map(candidates.map((candidate) => [candidate['name'], candidate]));
    assert.equal(byName.get('alpha')!['importable'], true);
    assert.equal(byName.get('alpha')!['installed'], false);
    assert.match(String(byName.get('alpha')!['path']), /\.agents[\\/]skills[\\/]alpha$/);
    assert.equal(byName.get('broken')!['importable'], false);
    assert.match(String(byName.get('broken')!['reason']), /SKILL\.md/);
    if (byName.has('Bad Name')) {
      assert.equal(byName.get('Bad Name')!['importable'], false);
    }
    if (byName.has('linked')) {
      assert.equal(byName.get('linked')!['importable'], false);
    }

    const install = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'agents-skills', name: 'alpha' }),
    });
    assert.equal(install.status, 201, await install.clone().text());
    const installed = (await readJson(install))['skill'] as Record<string, unknown>;
    assert.equal(installed['source'], 'agents-skills');
    assert.equal(
      readFileSync(path.join(skillDir(fixture, 'alpha'), 'notes.txt'), 'utf8'),
      'alpha notes',
    );
    assert.equal(
      (await listSkills(fixture).then((response) => response.json()) as { skills: unknown[] }).skills
        .length,
      1,
    );

    const replay = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'agents-skills', name: 'alpha' }),
    });
    assert.equal(replay.status, 200, await replay.clone().text());
    writeFileSync(path.join(candidateRoot(fixture), 'alpha', 'notes.txt'), 'changed', 'utf8');
    const changed = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'agents-skills', name: 'alpha' }),
    });
    assert.equal(changed.status, 409, await changed.clone().text());

    const afterInstall = await readJson(
      await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skill-candidates`),
    );
    const installedCandidate = (afterInstall['candidates'] as Record<string, unknown>[]).find(
      (candidate) => candidate['name'] === 'alpha',
    );
    assert.equal(installedCandidate!['installed'], true);

    const unknownCandidates = await fetch(
      `${fixture.base}/api/agents/not-an-agent/skill-candidates`,
    );
    assert.equal(unknownCandidates.status, 404);
    const unknownImportAll = await fetch(
      `${fixture.base}/api/agents/not-an-agent/skills/import-all`,
      { method: 'POST' },
    );
    assert.equal(unknownImportAll.status, 404);
    assert.equal(
      (await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'agents-skills', name: 'unknown' }),
      })).status,
      400,
    );
    assert.equal(
      (await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'agents-skills', name: 'alpha', path: '/tmp' }),
      })).status,
      400,
    );
  } finally {
    await fixture.stop();
  }
});

test('import-all returns per-item results and one failure does not block the others', async () => {
  const fixture = await startFixture('allibot-skills-import-all-');
  try {
    writeCandidate(fixture, 'alpha', { extra: { 'a.txt': 'alpha' } });
    writeCandidate(fixture, 'delta', { extra: { 'd.txt': 'delta' } });
    writeCandidate(fixture, 'gamma', { extra: { 'g.txt': 'gamma' } });
    writeCandidate(fixture, 'broken', { manifest: null });

    // alpha is installed through the single-entry path first.
    const first = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'agents-skills', name: 'alpha' }),
    });
    assert.equal(first.status, 201, await first.clone().text());

    // delta has no row but conflicting bytes at the destination: the install
    // fails for that item while gamma must still be imported afterwards.
    const conflicting = skillDir(fixture, 'delta');
    mkdirSync(conflicting, { recursive: true });
    writeFileSync(path.join(conflicting, 'SKILL.md'), 'conflicting bytes', 'utf8');

    const response = await fetch(
      `${fixture.base}/api/agents/${fixture.agentId}/skills/import-all`,
      { method: 'POST' },
    );
    assert.equal(response.status, 200, await response.clone().text());
    const body = await readJson(response);
    const results = body['results'] as Record<string, unknown>[];
    const byName = new Map(results.map((item) => [item['name'], item]));
    assert.equal(byName.get('alpha')!['status'], 'skipped');
    assert.equal(byName.get('broken')!['status'], 'skipped');
    assert.equal(byName.get('delta')!['status'], 'failed');
    assert.equal(byName.get('gamma')!['status'], 'imported');
    assert.equal(body['imported'], 1);
    assert.equal(body['failed'], 1);
    assert.equal(body['skipped'], 2);
    assert.equal(existsSync(path.join(fixture.agentHome, 'skills', 'gamma', 'g.txt')), true);
    assert.equal(existsSync(path.join(fixture.agentHome, 'skills', 'delta')), true);
    assert.equal(
      readFileSync(path.join(fixture.agentHome, 'skills', 'delta', 'SKILL.md'), 'utf8'),
      'conflicting bytes',
    );

    const second = await readJson(
      await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills/import-all`, {
        method: 'POST',
      }),
    );
    assert.equal(second['imported'], 0, 'a second import-all is idempotent');
    assert.equal(second['failed'], 1);

    const empty = await fetch(`${fixture.base}/api/agents/${fixture.agentId}/skills/import-all`, {
      method: 'POST',
    });
    assert.equal(empty.status, 200);

    const unknown = await fetch(`${fixture.base}/api/agents/not-an-agent/skills/import-all`, {
      method: 'POST',
    });
    assert.equal(unknown.status, 404);
  } finally {
    await fixture.stop();
  }
});
