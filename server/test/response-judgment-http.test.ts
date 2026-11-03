import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ZH_CN } from '@allibot/shared';
import Database from 'better-sqlite3';
import {
  makeTempDir,
  removeTempDir,
  runCli,
  startServer,
  REPO_ROOT,
  type RunningServer,
} from './support.ts';

/**
 * 回应判断 (Response Judgment) and 沉默 (Silence), observed at the process HTTP
 * face: the four definite signals, the structured `silent` status, the
 * failed-closing of ignored / silent / body-less rounds under a definite
 * signal, and the readable copy picked by signal source. The round outcome
 * rows and the captured system prompt are the only things asserted; the
 * scripted double is injected through the startup argument (D4.3).
 */

const AGENT_MESSAGE_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'agent-message.mjs');
const WAKE_ROUND_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'wake-round.mjs');
const DM_TARGET_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'dm-target.mjs');
const PROMPT_FIXTURE = path.join(REPO_ROOT, 'server', 'test', 'fixtures', 'round-prompts.json');

/** The fixed fixture the channel silence rubric is compared against, verbatim. */
interface PromptFixture {
  channelRubric: string;
  dmOneToOne: string;
  dmMandatory: string;
  humanMessageMandatory: string;
}

const PROMPTS = JSON.parse(readFileSync(PROMPT_FIXTURE, 'utf8')) as PromptFixture;

type ProviderBehavior = 'reply' | 'ignore' | 'fail' | 'delay' | 'silent' | 'no-body';

interface Fixture {
  dataDir: string;
  running: RunningServer;
  base: string;
  stop: () => Promise<void>;
}

interface RoundOutcomeRow {
  member_id: string;
  target_id: string;
  base_seq: number;
  status: string;
  reason: string;
  finished_reason: string | null;
  budget_consumed: number;
  merged: number;
}

async function startFixture(
  prefix: string,
  provider: ProviderBehavior,
  extraArgs: readonly string[] = [],
): Promise<Fixture> {
  const dataDir = await makeTempDir(prefix);
  const migration = runCli(['--migrate', '--data-dir', dataDir]);
  assert.equal(migration.exitCode, 0, `migrate should exit 0; output: ${migration.output}`);
  const running = await startServer(dataDir, {
    args: ['--scripted-provider', provider, ...extraArgs],
  });
  return {
    dataDir,
    running,
    base: `http://127.0.0.1:${running.port}`,
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

async function postJson(fixture: Fixture, route: string, body: unknown): Promise<Response> {
  return await fetch(`${fixture.base}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function createChannel(fixture: Fixture): Promise<string> {
  const created = await postJson(fixture, '/api/channels', {
    name: '回应判断频道',
    description: '',
    mode: 'autonomous',
    response_budget_limit: 3,
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function createAgent(fixture: Fixture, displayName: string): Promise<string> {
  const created = await postJson(fixture, '/api/agents', {
    display_name: displayName,
    model: 'openai:gpt-5',
  });
  assert.equal(created.status, 201, await created.clone().text());
  return (await readJson(created))['id'] as string;
}

async function joinChannel(fixture: Fixture, channelId: string, memberId: string): Promise<void> {
  const joined = await postJson(fixture, `/api/channels/${channelId}/members`, {
    member_id: memberId,
  });
  assert.equal(joined.status, 200, await joined.clone().text());
}

async function postMessage(
  fixture: Fixture,
  targetId: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await postJson(fixture, `/api/targets/${targetId}/messages`, body);
  assert.equal(response.status, 201, await response.clone().text());
  return await readJson(response);
}

async function listMessages(fixture: Fixture, targetId: string): Promise<Record<string, unknown>[]> {
  const response = await fetch(`${fixture.base}/api/targets/${targetId}/messages`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await readJson(response))['messages'] as Record<string, unknown>[];
}

/**
 * Call the production entry points the future member-face producers will call.
 * Neither an Agent-authored message that wakes others nor a claim / continue
 * wake has a producer ticket inside M1 yet (#24 owns those), so the fixture is
 * a caller of the same entry points — never a second orchestration path.
 */
function runFixture(
  script: string,
  input: Record<string, unknown>,
): Record<string, unknown> {
  const result = spawnSync(process.execPath, [script, JSON.stringify(input)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, `fixture ${path.basename(script)} should exit 0; ${result.stderr}`);
  const parsed: unknown = JSON.parse(result.stdout);
  assert.ok(typeof parsed === 'object' && parsed !== null, 'the fixture answers JSON');
  const record = parsed as Record<string, unknown>;
  assert.equal(record['ok'], true, `fixture ${path.basename(script)} failed: ${result.stdout}`);
  return record;
}

function roundOutcomes(fixture: Fixture): RoundOutcomeRow[] {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    return db
      .prepare(
        `SELECT member_id, target_id, base_seq, status, reason, finished_reason,
                budget_consumed, merged
           FROM round_outcome ORDER BY rowid`,
      )
      .all() as RoundOutcomeRow[];
  } finally {
    db.close();
  }
}

function ownerId(fixture: Fixture): string {
  const db = new Database(path.join(fixture.dataDir, 'allibot.db'), { readonly: true });
  try {
    const row = db.prepare("SELECT id FROM member WHERE kind = 'owner'").get() as { id: string };
    return row.id;
  } finally {
    db.close();
  }
}

/** The captured system prompt: the scripted reply echoes it after this marker. */
const PROMPT_MARKER = '[system-prompt]';

function capturedPrompt(body: string): string {
  const index = body.indexOf(PROMPT_MARKER);
  assert.notEqual(index, -1, `the reply should carry the captured system prompt: ${body}`);
  return body.slice(index + PROMPT_MARKER.length).trim();
}

test('a mention round cannot stay silent: the structured silent verdict closes as failed', async () => {
  const fixture = await startFixture('allibot-judge-mention-silent-', 'silent');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    await postMessage(fixture, channelId, { body: '@甲 请回应' });

    const messages = await listMessages(fixture, channelId);
    assert.deepEqual(
      messages.map((message) => [message['kind'], message['author_member_id']]),
      [['human', ownerId(fixture)]],
      'a definite signal that stays silent lands no agent message',
    );

    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    const row = outcomes[0]!;
    assert.equal(row.status, 'failed', 'silent is not the stored status under a definite signal');
    assert.equal(
      row.finished_reason,
      ZH_CN['round.finished.completed'].text,
      'the adapter ran to completion; what failed is the response discipline',
    );
    assert.ok(row.reason.includes(ZH_CN['wake.mention'].text), row.reason);
    assert.ok(row.reason.includes(ZH_CN['round.mandatory.mention'].text), row.reason);
    assert.ok(row.reason.includes(ZH_CN['round.silent'].text), row.reason);
    assert.ok(
      !row.reason.includes(ZH_CN['round.mandatory.claim'].text),
      'a mention round never borrows the claim copy',
    );
    assert.ok(
      !row.reason.includes(ZH_CN['round.mandatory.humanMessage'].text),
      'a mention round never borrows the human-message copy',
    );
  } finally {
    await fixture.stop();
  }
});

test('a non-definite round that declares silence stores the structured silent status, never failed', async () => {
  // A channel where an Agent message with no mention wakes a fellow member:
  // no definite signal fired, so a structured silence is a normal protocol
  // result and the stored status says exactly what happened.
  const channelFixture = await startFixture('allibot-judge-silent-optional-', 'ignore');
  try {
    const speaker = await createAgent(channelFixture, '甲');
    const listener = await createAgent(channelFixture, '乙');
    const channelId = await createChannel(channelFixture);
    await joinChannel(channelFixture, channelId, speaker);
    await joinChannel(channelFixture, channelId, listener);

    runFixture(AGENT_MESSAGE_FIXTURE, {
      dataDir: channelFixture.dataDir,
      targetId: channelId,
      authorMemberId: speaker,
      body: '甲对乙说的一句，没有点名',
      behavior: 'silent',
    });

    const outcomes = roundOutcomes(channelFixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'silent');
    assert.equal(outcomes[0]?.finished_reason, ZH_CN['round.finished.completed'].text);
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.silent'].text), outcomes[0]?.reason);
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.silent.allowed'].text));
    assert.ok(!outcomes[0]?.reason.includes(ZH_CN['round.mandatory.closed'].text));
    assert.ok(!outcomes[0]?.reason.includes(ZH_CN['round.failed'].text));
    assert.ok(
      !outcomes[0]?.reason.includes(ZH_CN['round.mandatory.humanMessage'].text),
      'no human message fired, so the human-message copy is absent',
    );
    assert.deepEqual(
      (await listMessages(channelFixture, channelId)).map((message) => message['kind']),
      ['agent'],
      'the silent round lands nothing but the message that woke it',
    );
  } finally {
    await channelFixture.stop();
  }

  // The DM face has no definite signal for an Agent-authored message either;
  // the DM itself is created by its own ticket (#22), so the fixture writes
  // exactly the rows that write path owns.
  const dmFixture = await startFixture('allibot-judge-silent-dm-', 'ignore');
  try {
    const peer = await createAgent(dmFixture, '私信对象');
    const dm = runFixture(DM_TARGET_FIXTURE, { dataDir: dmFixture.dataDir, agentId: peer });
    const dmId = dm['id'] as string;
    runFixture(AGENT_MESSAGE_FIXTURE, {
      dataDir: dmFixture.dataDir,
      targetId: dmId,
      authorMemberId: peer,
      body: '私信里由 Agent 写的一句',
      behavior: 'ignore',
    });

    runFixture(WAKE_ROUND_FIXTURE, {
      dataDir: dmFixture.dataDir,
      targetId: dmId,
      memberId: peer,
      fromSeq: 1,
      reason: 'channel-message',
      behavior: 'silent',
    });

    const outcomes = roundOutcomes(dmFixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'silent', 'a DM wake with no human message is not definite');
  } finally {
    await dmFixture.stop();
  }
});

test('a human message is a definite signal on both faces, and the prompt is one-to-one only in a DM', async () => {
  // The channel face: a human message must be answered, and its prompt keeps
  // the channel rubric verbatim, with the mandatory answer as its own
  // paragraph. The fixed fixture holds both texts, so a silent edit to either
  // fails here.
  const channelFixture = await startFixture('allibot-judge-human-channel-', 'reply', [
    '--scripted-echo-prompt',
  ]);
  try {
    const agent = await createAgent(channelFixture, '甲');
    const channelId = await createChannel(channelFixture);
    await joinChannel(channelFixture, channelId, agent);

    await postMessage(channelFixture, channelId, { body: '请回应' });

    const messages = await listMessages(channelFixture, channelId);
    assert.equal(messages.filter((message) => message['kind'] === 'agent').length, 1);
    const prompt = capturedPrompt(messages[1]?.['body'] as string);
    assert.ok(
      prompt.includes(PROMPTS.channelRubric),
      `the channel rubric is used verbatim: ${prompt}`,
    );
    assert.ok(
      !prompt.includes(PROMPTS.dmOneToOne),
      'a channel round does not borrow the one-to-one DM stance',
    );
    assert.ok(
      prompt.endsWith(`\n\n${PROMPTS.humanMessageMandatory}`),
      `the mandatory answer sentence is its own paragraph at the end: ${prompt}`,
    );
    assert.ok(
      !prompt.includes(PROMPTS.dmMandatory),
      'a channel round does not borrow the DM mandatory sentence',
    );

    const outcomes = roundOutcomes(channelFixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'replied');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['wake.channelMessage'].text));
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.mandatory.humanMessage'].text));
    assert.ok(
      !outcomes[0]?.reason.includes(ZH_CN['round.mandatory.claim'].text),
      'a human-message round never borrows the claim copy',
    );
  } finally {
    await channelFixture.stop();
  }

  // The DM face: the prompt states the one-to-one stance instead of the
  // channel rubric, and the human message still forces an answer.
  const dmFixture = await startFixture('allibot-judge-human-dm-', 'reply', [
    '--scripted-echo-prompt',
  ]);
  try {
    const peer = await createAgent(dmFixture, '私信对象');
    const dm = runFixture(DM_TARGET_FIXTURE, { dataDir: dmFixture.dataDir, agentId: peer });
    const dmId = dm['id'] as string;

    await postMessage(dmFixture, dmId, { body: '私信里的一句' });

    const messages = await listMessages(dmFixture, dmId);
    assert.equal(messages.filter((message) => message['kind'] === 'agent').length, 1);
    const prompt = capturedPrompt(messages[1]?.['body'] as string);
    assert.ok(prompt.includes(PROMPTS.dmOneToOne), `the DM prompt is one-to-one: ${prompt}`);
    assert.ok(
      !prompt.includes(PROMPTS.channelRubric),
      'the DM prompt does not claim to be a multi-member channel',
    );
    assert.ok(
      prompt.endsWith(`\n\n${PROMPTS.humanMessageMandatory}`),
      `a human message in a DM still carries the human-message mandatory sentence: ${prompt}`,
    );
    assert.ok(
      !prompt.includes(PROMPTS.dmMandatory),
      'the human-message DM round does not stack a second mandatory sentence',
    );

    const outcomes = roundOutcomes(dmFixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'replied');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.mandatory.humanMessage'].text));
  } finally {
    await dmFixture.stop();
  }
});

test('a DM round not woken by a human keeps the one-to-one stance and its own mandatory sentence', async () => {
  const fixture = await startFixture('allibot-judge-dm-prompt-', 'reply', ['--scripted-echo-prompt']);
  try {
    const peer = await createAgent(fixture, '私信对象');
    const dm = runFixture(DM_TARGET_FIXTURE, {
      dataDir: fixture.dataDir,
      agentId: peer,
      systemBody: '一条 DM 里的记录',
    });
    const dmId = dm['id'] as string;

    // An Agent-authored message wakes nobody in its own target; the wake is
    // delivered explicitly, pointing at the system record (seq 1). That round
    // has no human message and no mention, so its prompt is the plain DM one.
    runFixture(WAKE_ROUND_FIXTURE, {
      dataDir: fixture.dataDir,
      targetId: dmId,
      memberId: peer,
      fromSeq: 1,
      reason: 'channel-message',
      behavior: 'reply',
      echoPrompt: true,
    });

    const messages = await listMessages(fixture, dmId);
    const reply = messages.find((message) => message['kind'] === 'agent');
    assert.ok(reply !== undefined);
    const prompt = capturedPrompt(reply['body'] as string);
    assert.ok(prompt.includes(PROMPTS.dmOneToOne), prompt);
    assert.ok(!prompt.includes(PROMPTS.channelRubric));
    assert.ok(prompt.endsWith(`\n\n${PROMPTS.dmMandatory}`), prompt);
    assert.ok(
      !prompt.includes(PROMPTS.humanMessageMandatory),
      'no human message fired, so the human-message mandatory copy is not used',
    );
    assert.equal(roundOutcomes(fixture)[0]?.status, 'replied');
  } finally {
    await fixture.stop();
  }
});

test('a human-message round that stays silent on the DM face also closes as failed', async () => {
  const fixture = await startFixture('allibot-judge-human-dm-silent-', 'silent');
  try {
    const peer = await createAgent(fixture, '私信对象');
    const dm = runFixture(DM_TARGET_FIXTURE, { dataDir: fixture.dataDir, agentId: peer });
    const dmId = dm['id'] as string;

    await postMessage(fixture, dmId, { body: '私信里的一句' });

    assert.deepEqual(
      (await listMessages(fixture, dmId)).map((message) => message['kind']),
      ['human'],
    );
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'failed');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.mandatory.humanMessage'].text));
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.silent'].text));
  } finally {
    await fixture.stop();
  }
});

test('claim and auto-continue wakes are definite signals with their own copy', async () => {
  const fixture = await startFixture('allibot-judge-claim-continue-', 'silent');
  try {
    const agent = await createAgent(fixture, '受派者');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);
    await postMessage(fixture, channelId, { body: '这张任务需要开工' });

    runFixture(WAKE_ROUND_FIXTURE, {
      dataDir: fixture.dataDir,
      targetId: channelId,
      memberId: agent,
      fromSeq: 1,
      reason: 'claim',
      behavior: 'silent',
    });
    runFixture(WAKE_ROUND_FIXTURE, {
      dataDir: fixture.dataDir,
      targetId: channelId,
      memberId: agent,
      fromSeq: 1,
      reason: 'continue',
      behavior: 'silent',
    });

    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 3, 'the human-message round and one round per explicit wake');
    const claim = outcomes.find((row) => row.reason.includes(ZH_CN['wake.claim'].text));
    assert.ok(claim !== undefined, 'the claim round has its own wake copy');
    assert.equal(claim.status, 'failed');
    assert.ok(claim.reason.includes(ZH_CN['round.mandatory.claim'].text), claim.reason);
    assert.ok(!claim.reason.includes(ZH_CN['round.mandatory.humanMessage'].text));

    const continued = outcomes.find((row) => row.reason.includes(ZH_CN['wake.continue'].text));
    assert.ok(continued !== undefined, 'the auto-continue round has its own wake copy');
    assert.equal(continued.status, 'failed');
    assert.ok(continued.reason.includes(ZH_CN['round.mandatory.continue'].text), continued.reason);
    assert.ok(!continued.reason.includes(ZH_CN['round.mandatory.claim'].text));
  } finally {
    await fixture.stop();
  }
});

test('a definite-signal round with no committable body closes as failed and lands no message', async () => {
  const fixture = await startFixture('allibot-judge-no-body-', 'no-body');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    await postMessage(fixture, channelId, { body: '@甲 请回应' });

    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['kind']),
      ['human'],
      'a reply verdict without a body is never laundered into a message',
    );
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'failed');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.noBody'].text), outcomes[0]?.reason);
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.mandatory.closed'].text));
  } finally {
    await fixture.stop();
  }
});

test('judgment writes no extra message, wake or budget fact: only the round outcome row', async () => {
  const fixture = await startFixture('allibot-judge-side-effects-', 'silent');
  try {
    const agent = await createAgent(fixture, '甲');
    const channelId = await createChannel(fixture);
    await joinChannel(fixture, channelId, agent);

    await postMessage(fixture, channelId, { body: '@甲 请回应' });

    // One human message, one outcome — the failed closing of a silent mention
    // round adds no system record and no reply.
    assert.deepEqual(
      (await listMessages(fixture, channelId)).map((message) => message['seq']),
      [1],
    );
    const outcomes = roundOutcomes(fixture);
    assert.equal(outcomes.length, 1, 'exactly one round outcome, no extra wake or row');
    assert.equal(outcomes[0]?.budget_consumed, 0, 'judgment moves no budget');
    assert.equal(outcomes[0]?.merged, 0);
  } finally {
    await fixture.stop();
  }
});

test('an ignored definite signal closes as failed, while an ignored Agent-to-Agent wake stays ignored', async () => {
  // The mention round: the double self-judges "not worth answering", which a
  // definite signal never allows.
  const definite = await startFixture('allibot-judge-mention-ignored-', 'ignore');
  try {
    const agent = await createAgent(definite, '甲');
    const channelId = await createChannel(definite);
    await joinChannel(definite, channelId, agent);

    await postMessage(definite, channelId, { body: '@甲 请回应' });

    assert.deepEqual(
      (await listMessages(definite, channelId)).map((message) => message['kind']),
      ['human'],
      'an ignored mention round lands no agent message',
    );
    const outcomes = roundOutcomes(definite);
    assert.equal(outcomes.length, 1);
    assert.equal(outcomes[0]?.status, 'failed', 'ignored under a definite signal is failed');
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.ignored'].text), outcomes[0]?.reason);
    assert.ok(outcomes[0]?.reason.includes(ZH_CN['round.mandatory.closed'].text));
  } finally {
    await definite.stop();
  }

  // The non-definite round: an Agent-authored message with no mention is the
  // "conversation between others" case — ignoring it is the normal protocol
  // choice, and the row must say so rather than fail.
  const optional = await startFixture('allibot-judge-agent-message-', 'ignore');
  try {
    const speaker = await createAgent(optional, '甲');
    const listener = await createAgent(optional, '乙');
    const channelId = await createChannel(optional);
    await joinChannel(optional, channelId, speaker);
    await joinChannel(optional, channelId, listener);

    runFixture(AGENT_MESSAGE_FIXTURE, {
      dataDir: optional.dataDir,
      targetId: channelId,
      authorMemberId: speaker,
      body: '说给另一个成员听的一句',
      behavior: 'ignore',
    });

    const outcomes = roundOutcomes(optional);
    assert.equal(outcomes.length, 1, 'only the listener was woken');
    assert.equal(outcomes[0]?.member_id, listener);
    assert.equal(outcomes[0]?.status, 'ignored', 'a non-definite ignored round is not a failure');
    assert.equal(outcomes[0]?.finished_reason, ZH_CN['round.finished.completed'].text);
    assert.ok(
      outcomes[0]?.reason.includes(ZH_CN['round.ignored.allowed'].text),
      outcomes[0]?.reason,
    );
    assert.ok(!outcomes[0]?.reason.includes(ZH_CN['round.mandatory.closed'].text));
    assert.ok(
      !outcomes[0]?.reason.includes(ZH_CN['round.mandatory.humanMessage'].text),
      'an Agent-to-Agent round that no human message woke never uses the human-message copy',
    );
  } finally {
    await optional.stop();
  }
});
