import assert from 'node:assert/strict';
import { test } from 'node:test';
import { t } from '@allibot/shared';
import type { RoundFileToolResult } from '../dist/agent-seam.js';
import { MAX_GREP_FILES } from '../dist/docker-files.js';
import { shapeGrep, type ToolCopy } from '../dist/tool-specs.js';
import { MAX_GREP_MATCHES } from '../dist/workspace-files.js';

/**
 * Grep 封顶事实的模型可见文案 (#62 / AC3): the container face states *why* it
 * stopped — the hit count or the files it walked — and the round feeds that
 * reason to the model as copy, not as a number the model has to derive from
 * the hit list. Both directions are pinned here: each reason's own sentence and
 * the scale the cap actually used (200 hits, 2000 files), and that an uncapped
 * result carries neither sentence.
 *
 * The seam is the shaping function the `Grep` spec calls
 * (`shapeGrep`), plus the one translation entry point every backend string uses;
 * no provider, no process, no container.
 */

const copy: ToolCopy = (key, values) => t('zh-CN', key, values ?? {});

/** One `Grep` hit list the container face would answer. */
function hits(count: number): RoundFileToolResult {
  return {
    ok: true,
    scope: 'project',
    matches: Array.from({ length: count }, (_unused, index) => ({
      path: `f${String(index).padStart(5, '0')}.txt`,
      line: 1,
      text: 'NEEDLE',
    })),
  };
}

const REQUEST = { pattern: 'NEEDLE' };

test('a grep capped on scanned files tells the model files were left unscanned', () => {
  const answer = shapeGrep(REQUEST, { ...hits(1), capped: 'files' }, copy);

  assert.equal(answer.ok, true);
  assert.ok(
    answer.content.includes('还有文件未扫描'),
    `the result names the unscanned files: ${answer.content}`,
  );
  assert.ok(
    answer.content.includes(`前 ${String(MAX_GREP_FILES)} 个文件`),
    `the result states the file cap it used: ${answer.content}`,
  );
  assert.equal(MAX_GREP_FILES, 2000);
  assert.equal(
    answer.content.includes('还有更多匹配未列出'),
    false,
    'a file cap is not reported as a hit cap',
  );
});

test('a grep capped on hits tells the model more matches exist', () => {
  const answer = shapeGrep(REQUEST, { ...hits(MAX_GREP_MATCHES), capped: 'matches' }, copy);

  assert.equal(answer.ok, true);
  assert.ok(
    answer.content.includes('还有更多匹配未列出'),
    `the result names the matches it did not list: ${answer.content}`,
  );
  assert.ok(
    answer.content.includes(`前 ${String(MAX_GREP_MATCHES)} 条匹配`),
    `the result states the hit cap it used: ${answer.content}`,
  );
  assert.equal(MAX_GREP_MATCHES, 200);
  assert.equal(
    answer.content.includes('还有文件未扫描'),
    false,
    'a hit cap is not reported as a file cap',
  );
});

test('an uncapped grep carries neither cap sentence', () => {
  const answer = shapeGrep(REQUEST, hits(2), copy);

  assert.equal(answer.ok, true);
  assert.ok(answer.content.includes('NEEDLE'), 'the hits are still listed');
  assert.equal(answer.content.includes('还有文件未扫描'), false, 'no file cap was hit');
  assert.equal(answer.content.includes('还有更多匹配未列出'), false, 'no hit cap was hit');
  assert.equal(answer.content.includes('已封顶'), false, 'an uncapped result claims no cap at all');
});
