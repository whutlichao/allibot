import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import type { DockerContainerHandle } from '../dist/docker-workspace.js';
import type { DockerExecResult } from '../dist/docker-runtime.js';
import { createContainerFileTools, MAX_GREP_FILES } from '../dist/docker-files.js';
import { MAX_GREP_MATCHES } from '../dist/workspace-files.js';

/**
 * 容器 Grep 的封顶事实 (#62 / D6): the container face has two caps — the hit
 * count (`MAX_GREP_MATCHES`) and the files it walks (`MAX_GREP_FILES`) — and
 * the result names the reason instead of letting the re-feed layer guess from
 * the hit count.
 *
 * The seam is the face itself (`createContainerFileTools`): the handle below is
 * a container runtime answering the fixed command shapes the face issues, with
 * the workspace as an in-memory file map. No daemon, no CLI process.
 */

const PROJECT_ROOT = '/workspace';

/** One container workspace: a flat file map below `/workspace`. */
function fakeHandle(files: ReadonlyMap<string, string>): DockerContainerHandle {
  const ok = (stdout: string): DockerExecResult => ({
    exitCode: 0,
    stdout,
    stderr: '',
    truncated: false,
  });
  return {
    id: 'fake-container',
    root: '/host/project',
    async exec(argv) {
      const script = argv[2] ?? '';
      // `sh -c <script> sh <subject>`: the subject is the fifth word.
      const subject = argv[4] ?? '';
      if (script.startsWith('if [ -d')) {
        if (subject === PROJECT_ROOT) {
          return ok('dir\n');
        }
        return ok(files.has(subject) ? 'file\n' : 'none\n');
      }
      if (script.startsWith('readlink -f')) {
        return ok(`${subject}\n`);
      }
      if (script.startsWith('find -H')) {
        return ok([...files.keys()].sort().join('\n'));
      }
      if (script.startsWith('size=$(wc -c')) {
        const text = files.get(subject);
        return text === undefined
          ? { exitCode: 2, stdout: '', stderr: '', truncated: false }
          : ok(text);
      }
      throw new Error(`unexpected container command: ${argv.join(' ')}`);
    },
    spawn() {
      throw new Error('the grep path never spawns an interactive exec');
    },
  };
}

function containerFiles(files: ReadonlyMap<string, string>) {
  return createContainerFileTools({
    handle: fakeHandle(files),
    projectRoot: '/host/project',
    skillsRoot: null,
  });
}

/** `count` workspace files, each `body` repeated in the file. */
function workspace(count: number, body: (index: number) => string): Map<string, string> {
  const files = new Map<string, string>();
  for (let index = 0; index < count; index += 1) {
    files.set(path.posix.join(PROJECT_ROOT, `f${String(index).padStart(5, '0')}.txt`), body(index));
  }
  return files;
}

test('a container grep stops at the scanned-file cap and names that reason', async () => {
  const files = workspace(MAX_GREP_FILES + 100, () => 'nothing here\n');
  const result = await containerFiles(files).Grep({ pattern: 'NEEDLE' });

  assert.equal(result.ok, true);
  assert.deepEqual(result.matches, [], 'no file holds a hit');
  assert.equal(
    result.capped,
    'files',
    'the walk ran out of budget with files left, which is not the hit cap',
  );
});

test('a container grep that scans every file carries no cap fact', async () => {
  const files = workspace(MAX_GREP_FILES, () => 'nothing here\n');
  const result = await containerFiles(files).Grep({ pattern: 'NEEDLE' });

  assert.equal(result.ok, true);
  assert.equal(result.capped, undefined, 'a walk that finished is not capped');
});

test('a container grep over the hit cap says the hit cap cut it', async () => {
  const files = new Map([
    [path.posix.join(PROJECT_ROOT, 'hits.txt'), 'NEEDLE\n'.repeat(MAX_GREP_MATCHES + 1)],
  ]);
  const result = await containerFiles(files).Grep({ pattern: 'NEEDLE' });

  assert.equal(result.ok, true);
  assert.equal(result.matches?.length, MAX_GREP_MATCHES, 'the list stops at the cap');
  assert.equal(result.capped, 'matches', 'the hit cap is reported as the hit cap');
});

test('a container grep with exactly the cap of hits is not reported as capped', async () => {
  const files = new Map([
    [path.posix.join(PROJECT_ROOT, 'hits.txt'), 'NEEDLE\n'.repeat(MAX_GREP_MATCHES)],
  ]);
  const result = await containerFiles(files).Grep({ pattern: 'NEEDLE' });

  assert.equal(result.ok, true);
  assert.equal(result.matches?.length, MAX_GREP_MATCHES, 'every hit is listed');
  assert.equal(
    result.capped,
    undefined,
    'exactly MAX_GREP_MATCHES complete hits are the whole answer, not a cap',
  );
});
