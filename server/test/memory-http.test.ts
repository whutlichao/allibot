import assert from 'node:assert/strict';
import { cpSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { SCHEMA_VERSION } from '../dist/db.js';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  type RunningServer,
} from './support.ts';

/**
 * Long-term memory observed at the one seam (the backend HTTP face plus the
 * data directory products): a round's card is written back at close, a later
 * round of the same member recalls it across targets by keyword, and the
 * scripted double reports what it was actually given.
 */

interface MemoryFixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  restart: () => Promise<void>;
  stop: () => Promise<void>;
}

interface MemoryRow {
  member_id: string;
  content: string;
  keywords: string;
  source_target_id: string;
  source_message_id: string | null;
}

const PROVIDER_ARGS = ['--scripted-provider', 'reply'] as const;

async function startMemoryFixture(prefix: string): Promise<MemoryFixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  let running = await startServer(dataDir, { args: [...PROVIDER_ARGS] });
  return {
    dataDir,
    get running() {
      return running;
    },
    get base() {
      return `http://127.0.0.1:${running.port}`;
    },
    restart: async () => {
      await running.stop();
      running = await startServer(dataDir, { args: [...PROVIDER_ARGS] });
    },
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body: unknown = await response.json();
  assert.ok(typeof body === 'object' && body !== null, 'response body should be a JSON object');
  return body as Record<string, unknown>;
}

async function postJson(
  fixture: MemoryFixture,
  route: string,
  body: unknown,
): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: MemoryFixture, name: string): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name,
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: MemoryFixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(
  fixture: MemoryFixture,
  channelId: string,
  memberId: string,
): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: MemoryFixture,
  targetId: string,
  body: string,
): Promise<void> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, { body });
  assert.equal(response.status, 201, await response.clone().text());
}

async function listMessages(
  fixture: MemoryFixture,
  targetId: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function readMemoryRows(dataDir: string): MemoryRow[] {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT member_id, content, keywords, source_target_id, source_message_id
           FROM agent_memory ORDER BY rowid`,
      )
      .all() as MemoryRow[];
  } finally {
    db.close();
  }
}

function countRows(dataDir: string, table: string): number {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.prepare(`SELECT count(*) AS total FROM ${table}`).get() as { total: number }).total;
  } finally {
    db.close();
  }
}

async function agentReply(
  fixture: MemoryFixture,
  targetId: string,
): Promise<Record<string, unknown>> {
  const messages = await listMessages(fixture, targetId);
  const reply = messages.find((message) => message['kind'] === 'agent');
  assert.ok(reply !== undefined, `no agent reply in: ${JSON.stringify(messages)}`);
  return reply;
}

function assertAgentHasNoExtraEffects(fixture: MemoryFixture, targetId: string): void {
  // The card is a memory row and nothing else: it never adds a message, a
  // round outcome, a wake or a budget movement.
  assert.equal(countRows(fixture.dataDir, 'round_outcome'), 1, 'the card is not a round outcome');
  assert.equal(
    countRows(fixture.dataDir, 'message'),
    2,
    'one human message and one reply; the card adds no message',
  );
  assert.ok(targetId.length > 0);
}

test('a replied round writes back one memory card with both excerpts and keywords', async () => {
  const fixture = await startMemoryFixture('allibot-memory-writeback-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture, '记忆频道');
    await joinChannel(fixture, channelId, agent);

    await postMessage(fixture, channelId, 'alpha 的需求先记下');

    const reply = await agentReply(fixture, channelId);
    const rows = readMemoryRows(fixture.dataDir);
    assert.equal(rows.length, 1, 'a replied round writes exactly one card');
    const card = rows[0]!;
    assert.equal(card.member_id, agent);
    assert.equal(card.source_target_id, channelId);
    assert.equal(
      card.source_message_id,
      reply['id'],
      'the card names the reply message it was distilled from',
    );
    assert.match(card.content, /alpha 的需求先记下/, 'the card carries the trigger excerpt');
    assert.match(
      card.content,
      new RegExp(escapeRegExp(excerpt(String(reply['body'])))),
      'the card carries the reply excerpt',
    );

    const keywords: unknown = JSON.parse(card.keywords);
    assert.ok(Array.isArray(keywords) && keywords.length > 0, 'keywords are a non-empty JSON array');
    assert.ok(
      (keywords as string[]).includes('alpha'),
      `the deterministic tokenizer extracts alpha: ${card.keywords}`,
    );

    assertAgentHasNoExtraEffects(fixture, channelId);

    // The acceptance reads the row through the sqlite3 CLI, not through a
    // backend read path: memory is a data-directory product.
    const listed = spawnSync(
      'sqlite3',
      [
        path.join(fixture.dataDir, 'allibot.db'),
        'select member_id, content, keywords, source_target_id, source_message_id from agent_memory',
      ],
      { encoding: 'utf8' },
    );
    assert.equal(listed.status, 0, `sqlite3 should exit 0; stderr: ${listed.stderr}`);
    const columns = listed.stdout.trim().split('|');
    assert.equal(columns[0], agent);
    assert.match(columns[1] ?? '', /alpha 的需求先记下/);
    assert.ok((columns[2] ?? '').length > 0, 'keywords are readable through sqlite3');
    assert.equal(columns[3], channelId);
    assert.equal(columns[4], String(reply['id']));
  } finally {
    await fixture.stop();
  }
});

test('an ignored or failed round still writes one card: trigger excerpt, no reply, no model call', async () => {
  // A human message is a definite signal (#15), so the double's self-judged
  // ignore closes as `failed`; either way the round wrote no reply and its
  // card records that.
  for (const [behavior, expectedStatus] of [
    ['ignore', 'failed'],
    ['fail', 'failed'],
  ] as const) {
    const dataDir = await makeTempDir(`allibot-memory-${behavior}-`);
    const migration = runCli(['--migrate', '--data-dir', dataDir]);
    assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
    const running = await startServer(dataDir, { args: ['--scripted-provider', behavior] });
    const fixture: MemoryFixture = {
      dataDir,
      running,
      get base() {
        return `http://127.0.0.1:${running.port}`;
      },
      restart: async () => undefined,
      stop: async () => {
        await running.stop();
        await removeTempDir(dataDir);
      },
    };
    try {
      const agent = await createAgent(fixture, '甲');
      const channelId = await createChannel(fixture, '记忆频道');
      await joinChannel(fixture, channelId, agent);

      await postMessage(fixture, channelId, 'alpha 但没人接');

      const outcome = readOutcomeStatus(dataDir);
      assert.equal(outcome, expectedStatus, 'the round closes with its scripted verdict');
      const rows = readMemoryRows(dataDir);
      assert.equal(rows.length, 1, `a ${expectedStatus} round writes exactly one card`);
      const card = rows[0]!;
      assert.equal(card.member_id, agent);
      assert.match(card.content, /alpha 但没人接/, 'the card carries the trigger excerpt');
      assert.match(card.content, /没有回复/, 'the reply excerpt says there was no reply');
      assert.equal(card.source_message_id, null, 'an ignored or failed round has no reply message');
      const keywords = JSON.parse(card.keywords) as string[];
      assert.ok(keywords.includes('alpha'), `the trigger keywords survive: ${card.keywords}`);
      assert.equal(countRows(dataDir, 'round_outcome'), 1);
      assert.equal(countRows(dataDir, 'message'), 1, 'no reply message is invented');
    } finally {
      await fixture.stop();
    }
  }
});

test('recall crosses targets: alpha remembers in another channel, beta stays silent', async () => {
  const fixture = await startMemoryFixture('allibot-memory-recall-');
  try {
    const agent = await createAgent(fixture, '甲');
    const alphaChannel = await createChannel(fixture, 'alpha 频道');
    await joinChannel(fixture, alphaChannel, agent);
    await postMessage(fixture, alphaChannel, 'alpha 的约定');

    const recallChannel = await createChannel(fixture, '召回频道');
    await joinChannel(fixture, recallChannel, agent);
    await postMessage(fixture, recallChannel, 'alpha 再确认一次');
    const alphaReply = await agentReply(fixture, recallChannel);
    assert.match(
      String(alphaReply['body']),
      /mem:alpha/,
      `the alpha trigger recalls the card written in the other channel: ${String(alphaReply['body'])}`,
    );

    const betaChannel = await createChannel(fixture, 'beta 频道');
    await joinChannel(fixture, betaChannel, agent);
    await postMessage(fixture, betaChannel, 'beta only');
    const betaReply = await agentReply(fixture, betaChannel);
    assert.ok(
      !String(betaReply['body']).includes('mem:alpha'),
      `a beta trigger does not recall the alpha card: ${String(betaReply['body'])}`,
    );
    assert.match(
      String(betaReply['body']),
      /memcount:0/,
      'nothing matched, so nothing was injected',
    );

    // Recall only informs this round's understanding: the recalled round still
    // writes exactly one reply and one round outcome.
    assert.equal(
      countRows(fixture.dataDir, 'round_outcome'),
      3,
      'one outcome per round: one in the alpha channel, one recall round, one beta round',
    );
    assert.equal(
      (await listMessages(fixture, recallChannel)).length,
      2,
      'the recall round adds no message beyond its own reply',
    );
  } finally {
    await fixture.stop();
  }
});

test('ten matching cards are capped: the double reports at most eight injected', async () => {
  const fixture = await startMemoryFixture('allibot-memory-cap-');
  try {
    const agent = await createAgent(fixture, '甲');
    const alphaChannel = await createChannel(fixture, 'alpha 频道');
    await joinChannel(fixture, alphaChannel, agent);
    for (let index = 1; index <= 10; index += 1) {
      await postMessage(fixture, alphaChannel, `alpha 第 ${index} 条约定`);
    }
    assert.equal(readMemoryRows(fixture.dataDir).length, 10, 'each round wrote one card');

    const recallChannel = await createChannel(fixture, '召回频道');
    await joinChannel(fixture, recallChannel, agent);
    await postMessage(fixture, recallChannel, 'alpha 汇总一下');
    const body = String((await agentReply(fixture, recallChannel))['body']);
    const match = /memcount:(\d+)/.exec(body);
    assert.ok(match !== null, `the double reports the injection count: ${body}`);
    assert.equal(Number(match[1]), 8, `ten matching cards are capped at the fixed 8: ${body}`);
    assert.match(body, /mem:alpha/);
  } finally {
    await fixture.stop();
  }
});

test('a merged wake is not a round: the folded round writes exactly one card', async () => {
  const dataDir = await makeTempDir('allibot-memory-merged-');
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', 'delay', '--scripted-delay-ms', '1000', '--scripted-reply', '慢一点'],
  });
  const fixture: MemoryFixture = {
    dataDir,
    running,
    get base() {
      return `http://127.0.0.1:${running.port}`;
    },
    restart: async () => undefined,
    stop: async () => {
      await running.stop();
      await removeTempDir(dataDir);
    },
  };
  try {
    const agent = await createAgent(fixture, '慢工');
    const channelId = await createChannel(fixture, '慢频道');
    await joinChannel(fixture, channelId, agent);
    await postMessage(fixture, channelId, 'alpha 第一句');
    await postMessage(fixture, channelId, 'alpha 第二句');

    const deadline = Date.now() + 10_000;
    while (readMemoryRows(dataDir).length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const rows = readMemoryRows(dataDir);
    assert.equal(rows.length, 1, 'the repeated wake folds into the running round; only it writes a card');
    assert.match(rows[0]!.content, /alpha 第一句/, 'the card summarises the round that actually ran');
    assert.doesNotMatch(rows[0]!.content, /第二句/);
    assert.equal(countRows(dataDir, 'round_outcome'), 2, 'one merged row plus the round it folded into');
  } finally {
    await fixture.stop();
  }
});

test('a task-thread round writes the task context into its card', async () => {
  const fixture = await startMemoryFixture('allibot-memory-task-');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture, '任务频道');
    await joinChannel(fixture, channelId, agent);

    const created = await postJson(fixture, '/api/tasks', {
      channel_id: channelId,
      title: '整理 alpha 需求',
    });
    assert.equal(created.status, 201, await created.clone().text());
    const task = await readJson(created);
    const targetId = String(task['target_id']);
    const assigned = await fetch(
      `${fixture.base}/api/tasks/${String(task['id'])}`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assignee_member_id: agent }),
      },
    );
    assert.equal(assigned.status, 200, await assigned.clone().text());

    await postMessage(fixture, targetId, 'alpha 任务线程里的一句');

    const rows = readMemoryRows(fixture.dataDir);
    assert.equal(rows.length, 1, 'the task-thread round writes one card');
    const card = rows[0]!;
    assert.equal(card.source_target_id, targetId);
    assert.match(card.content, /alpha 任务线程里的一句/, 'the trigger excerpt is there');
    assert.match(card.content, /任务上下文：整理 alpha 需求/, 'the task title is the task context');
    assert.match(card.content, /待认领/, 'the task status label rides along');
    assert.match(card.content, /甲/, 'the assignee identity rides along');
  } finally {
    await fixture.stop();
  }
});

test('memory survives a restart and rides along with a whole data directory restore', async () => {
  const fixture = await startMemoryFixture('allibot-memory-restart-');
  let restoredDir: string | undefined;
  let restored: RunningServer | undefined;
  try {
    const agent = await createAgent(fixture, '甲');
    const alphaChannel = await createChannel(fixture, 'alpha 频道');
    await joinChannel(fixture, alphaChannel, agent);
    await postMessage(fixture, alphaChannel, 'alpha 的约定');
    assert.equal(readMemoryRows(fixture.dataDir).length, 1);

    await fixture.restart();
    assert.equal(readMemoryRows(fixture.dataDir).length, 1, 'the card survives a restart');
    const afterRestart = await createChannel(fixture, '重启后频道');
    await joinChannel(fixture, afterRestart, agent);
    await postMessage(fixture, afterRestart, 'alpha 重启后');
    assert.match(
      String((await agentReply(fixture, afterRestart))['body']),
      /mem:alpha/,
      'recall still works after a restart',
    );

    // A whole-directory copy is the backup contract: the restored copy reads
    // the memory rows it was copied with.
    await fixture.running.stop();
    restoredDir = await makeTempDir('allibot-memory-restored-');
    for (const entry of readdirSync(fixture.dataDir)) {
      cpSync(path.join(fixture.dataDir, entry), path.join(restoredDir, entry), {
        recursive: true,
      });
    }
    const migration = runCli(['--migrate', '--data-dir', restoredDir]);
    assert.equal(migration.exitCode, 0, `the restored copy is current: ${migration.output}`);
    assert.match(migration.stdout, new RegExp(`已是 Schema 版本 ${SCHEMA_VERSION}`));

    restored = await startServer(restoredDir, { args: [...PROVIDER_ARGS] });
    const restoredBase = `http://127.0.0.1:${restored.port}`;
    const restoredChannel = await postRestored(restoredBase, '/api/channels', {
      name: '恢复后频道',
      description: '',
      mode: 'autonomous',
      response_budget_limit: 3,
    });
    await postRestored(restoredBase, `/api/channels/${restoredChannel}/members`, {
      member_id: agent,
    });
    await postRestored(restoredBase, `/api/targets/${restoredChannel}/messages`, {
      body: 'alpha 恢复后',
    });
    const restoredMessages = await getRestored(restoredBase, `/api/targets/${restoredChannel}/messages`);
    const restoredReply = restoredMessages.find((message) => message['kind'] === 'agent');
    assert.ok(restoredReply !== undefined, `no restored reply: ${JSON.stringify(restoredMessages)}`);
    assert.match(
      String(restoredReply['body']),
      /mem:alpha/,
      'the restored copy recalls the card it was backed up with',
    );
  } finally {
    await restored?.stop();
    await fixture.running.stop().catch(() => undefined);
    if (restoredDir !== undefined) {
      await removeTempDir(restoredDir);
    }
    await removeTempDir(fixture.dataDir);
  }
});

function readOutcomeStatus(dataDir: string): string {
  const db = new Database(path.join(dataDir, 'allibot.db'), { readonly: true });
  try {
    return (db.prepare('SELECT status FROM round_outcome ORDER BY rowid').get() as { status: string })
      .status;
  } finally {
    db.close();
  }
}

async function postRestored(
  base: string,
  route: string,
  body: unknown,
): Promise<string> {
  const response = await fetch(`${base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.ok(response.status === 200 || response.status === 201, await response.clone().text());
  const parsed = await readJson(response);
  return String(parsed['id'] ?? '');
}

async function getRestored(
  base: string,
  route: string,
): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${base}${route}`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The card is a one-line readable excerpt: whitespace collapses, so the reply
 * excerpt is compared in its collapsed form. That rule is the card's own
 * readable-presentation contract, not an implementation detail of a helper.
 */
function excerpt(text: string): string {
  return text.trim().replace(/\s+/g, ' ');
}
