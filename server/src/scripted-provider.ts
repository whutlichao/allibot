import { setTimeout as delay } from 'node:timers/promises';
import type { RoundInput, RoundProvider, RoundResult } from './agent-seam.js';

/**
 * The scripted provider double (D4.3): a fixed behaviour injected through the
 * `--scripted-provider` startup argument, so behaviour tests run with no
 * network and no model cost.
 *
 * The four spec behaviours are the fixed set; `silent` and `no-body` are the
 * response-judgment double's extra faces — a structured silence and an answer
 * the write path cannot land — so that discipline under the four definite
 * signals is observable without a model. `delay` settles one round after
 * `delayMs`, which is what makes the "one round in flight" window observable.
 * Every behaviour is an adapter choice, not a production back door: production
 * code never branches on a test environment variable — the CLI selects this
 * adapter by name, exactly like the future real one.
 *
 * `echoPrompt` appends the system prompt the round was handed to the reply,
 * because the reply message is the only face a process-level test can read
 * that input from. It is a capability of the double, not a production branch.
 *
 * `reportContext` appends a report of the context window the round actually
 * read: `thread:window|full` for the scope it was handed, `ctx:<count>` for how
 * many messages, `ctxfirst` / `ctxlast` for the window's boundary seqs, and
 * `reread:<true|false>` — true once the window still carries a message older
 * than the triggering one that this member's consumption cursor has not passed,
 * i.e. the message an earlier failed round did not consume. Like the prompt
 * echo, it is how a process-level test observes an input through the ordinary
 * reply message.
 *
 * `continue-task` is the double's face for the structured `continue_task`
 * action (自动续跑): it answers normally and states the action, so "I will
 * continue" is executable rather than a sentence in the body. `transfer-task`
 * is the same face for `transfer_task` (转派): it names the injected target
 * member and lands no body, because a transfer writes a system record, not a
 * message. Like every other behaviour it is an adapter choice, never a
 * production branch.
 */
export type ScriptedBehavior =
  | 'reply'
  | 'ignore'
  | 'fail'
  | 'delay'
  | 'silent'
  | 'no-body'
  | 'iteration-limit'
  | 'continue-task'
  | 'transfer-task';

export const SCRIPTED_BEHAVIORS: readonly ScriptedBehavior[] = [
  'reply',
  'ignore',
  'fail',
  'delay',
  'silent',
  'no-body',
  'iteration-limit',
  'continue-task',
  'transfer-task',
];

export interface ScriptedProviderOptions {
  behavior: ScriptedBehavior;
  /** How long the `delay` behaviour holds a round before it settles. */
  delayMs: number;
  /** The bodies a `reply` (and `delay`, once settled) round lands. */
  replies?: readonly string[];
  /**
   * Append the captured system prompt to the reply after `[system-prompt]`:
   * the scripted double is the only place a test can observe what prompt a
   * round was handed, and it observes it through the ordinary reply message.
   */
  echoPrompt?: boolean;
  /**
   * Append the captured context window to the reply: `ctx:<count>`,
   * `ctxfirst:<seq>`, `ctxlast:<seq>` and `reread:<true|false>`. The double
   * reads all of them from the round input it was handed, so a test observes
   * the real window, not a recomputation of it.
   */
  reportContext?: boolean;
  /**
   * Append the invocation ordinal to the reply (`calls:<n>`). A test counts
   * the provider's calls through the ordinary reply bodies, so "one provider
   * call per round outcome" is observable at the HTTP seam. Like the prompt and
   * context reports it is a capability of the double, not a production branch.
   */
  reportCalls?: boolean;
  /** The member a `transfer-task` round hands the task to (test injection). */
  transferMemberId?: string;
  /**
   * Append the team reading of the round: the prompt composition order (the
   * three rule pieces, leader duties), the tool set and the assignment context.
   * It is how a test observes the leader prompt / tools through the ordinary
   * reply body; like every other report it is a capability of the double, never
   * a production branch.
   */
  reportTeam?: boolean;
}

/** The default scripted reply: deterministic, readable and free of model calls. */
export function defaultScriptedReply(input: RoundInput): string {
  return `收到 #${input.baseSeq}（${input.member.display_name}）${memoryReport(input)}`;
}

/**
 * The double's report of what the round actually recalled. It is the test
 * double's own observation face (D4.3): the count is the number of cards the
 * seam assembled into the system prompt's memory section, and each
 * `mem:<keyword>` line names a card whose keywords this round's input matched.
 * It stays inside this file — production code never parses a reply body.
 */
function memoryReport(input: RoundInput): string {
  const markers = [
    ...new Set(input.memories.flatMap((memory) => memory.matched_keywords)),
  ].map((keyword) => `mem:${keyword}`);
  const injected = input.memories.filter((memory) =>
    input.systemPrompt.includes(memory.content),
  ).length;
  return ['', `memcount:${injected}`, ...markers].join('\n');
}

export function createScriptedProvider(options: ScriptedProviderOptions): RoundProvider {
  let calls = 0;
  return {
    deferred: options.behavior === 'delay',
    name: `scripted:${options.behavior}`,
    async runRound(input: RoundInput): Promise<RoundResult> {
      calls += 1;
      const callReport = options.reportCalls === true ? `\ncalls:${calls}` : '';
      switch (options.behavior) {
        case 'ignore':
          return { verdict: 'ignored', replies: [] };
        case 'silent':
          // The structured silence: a verdict, never a body and never a kind.
          return { verdict: 'silent', replies: [] };
        case 'no-body':
          // "Answered" without a committable body: the verdict claims a reply
          // the write path cannot land.
          return { verdict: 'replied', replies: ['   '] };
        case 'fail':
          return { verdict: 'failed', replies: [], detail: '脚本化 provider：本轮被设定为失败' };
        case 'iteration-limit':
          // The round stopped because the iteration budget ran out, not because
          // it had concluded: the partial conclusion it did produce is landed,
          // and the round states the iteration-limit finished reason.
          return {
            ...replyResult(input, options, callReport),
            finishedReason: 'iteration-limit',
          };
        case 'delay':
          await delay(options.delayMs);
          return replyResult(input, options, callReport);
        case 'continue-task':
          // The structured action rides the same round result as the reply:
          // the output shape stays "zero or more replies plus one result".
          return { ...replyResult(input, options, callReport), taskAction: 'continue_task' };
        case 'transfer-task':
          // A transfer writes a system change record, never a message body, so
          // the double answers with the action and no pending reply.
          return {
            verdict: 'replied',
            replies: [],
            taskAction: 'transfer_task',
            taskTransferMemberId: options.transferMemberId,
          };
        case 'reply':
          return replyResult(input, options, callReport);
      }
    },
  };
}

function replyResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
): RoundResult {
  // Without an explicit body the double answers with what it read through the
  // ordinary read path — the triggering seq — so the round is observably a
  // real round rather than a canned string.
  const bodies = options.replies ?? [defaultScriptedReply(input)];
  // Each capture rides the first body: the reply message is the only face a
  // test can read the round's input from.
  const [first, ...rest] = bodies;
  const sections = [`${first}${contextReport(input, options)}${callReport}${teamReport(input, options)}`];
  if (options.echoPrompt === true) {
    sections[0] = `${sections[0]} [system-prompt] ${input.systemPrompt}`;
  }
  return { verdict: 'replied', replies: [...sections, ...rest] };
}

/**
 * The double's report of the team reading it was handed: the tool set, the
 * assignment context and the prompt composition order. The rules order is the
 * seam's own declared order (D3.7); the two workspace pieces are `absent`
 * until the Agent-home / project layer exists (#43).
 */
function teamReport(input: RoundInput, options: ScriptedProviderOptions): string {
  if (options.reportTeam !== true) {
    return '';
  }
  const team = input.team;
  const prompt = input.promptSections;
  return (
    `\n[team] leader:${String(team?.is_leader ?? false)}` +
    ` task:${team?.task_id ?? '-'}` +
    ` run:${team?.team_run_id ?? '-'}` +
    ` assignment:${team?.assignment?.assignment_id ?? '-'}` +
    `\n[rules] global:${prompt.rulesBase === null ? 'absent' : 'present'}` +
    ` > system:${prompt.systemPrompt.length > 0 ? 'present' : 'absent'}` +
    ` > project:${prompt.projectSupplement === null ? 'absent' : 'present'}` +
    `\n[leader] duties:${prompt.leaderDuties === null ? 'absent' : 'present'}` +
    `\n[tools] ${input.tools.length === 0 ? '-' : input.tools.join(',')}`
  );
}

/**
 * The double's report of a context window it was handed. `reread` is true once
 * the window still carries a message older than the trigger that this member's
 * cursor has not passed — the message an earlier failed round read but did not
 * consume, so this round reads it again. Nothing about the window is derived
 * here beyond what the input states.
 */
function contextReport(input: RoundInput, options: ScriptedProviderOptions): string {
  if (options.reportContext !== true) {
    return '';
  }
  const reread = input.messages.some(
    (message) => message.seq < input.baseSeq && message.seq > input.consumedSeq,
  );
  const first = input.messages[0]?.seq ?? 0;
  const last = input.messages[input.messages.length - 1]?.seq ?? 0;
  return (
    `\nthread:${input.contextScope}` +
    `\nctx:${input.messages.length}\nctxfirst:${first}\nctxlast:${last}\nreread:${String(reread)}`
  );
}
