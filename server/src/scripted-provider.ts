import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  RoundFileToolResult,
  RoundInput,
  RoundProvider,
  RoundResult,
  TeamAssignToolResult,
} from './agent-seam.js';
import { stableJson } from './permissions.js';
import { codepointLength } from './team-assignments.js';
import { agentHomeRoot } from './workspace-root.js';

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
  | 'transfer-task'
  | 'team-assign'
  | 'team-budget'
  | 'plan'
  | 'sop-create'
  | 'sop-start'
  | 'sop-executor'
  | 'sop-verifier'
  | 'sop-approval'
  | 'workspace'
  | 'permission'
  | 'mcp-approval'
  | 'team-approval';

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
  'team-assign',
  'team-budget',
  'plan',
  'sop-create',
  'sop-start',
  'sop-executor',
  'sop-verifier',
  'sop-approval',
  'workspace',
  'permission',
  'mcp-approval',
  'team-approval',
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
  /** The members the leader double assigns, in call order. */
  teamAssignMemberIds?: readonly string[];
  /** The instruction the double puts into every TeamAssign call. */
  teamAssignInstruction?: string;
  /** Make the doubled member sub-round fail instead of answering. */
  teamMemberFail?: boolean;
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
        case 'team-assign':
          return await teamAssignResult(input, options, callReport, false);
        case 'team-budget':
          return await teamAssignResult(input, options, callReport, true);
        case 'plan':
          return await planResult(input, options, callReport);
        case 'workspace':
          return await workspaceResult(input, options, callReport);
        case 'permission':
          return await permissionResult(input, options, callReport);
        case 'mcp-approval':
          return await mcpApprovalResult(input, options, callReport);
        case 'team-approval':
          return await teamApprovalResult(input, options, callReport);
        case 'sop-create':
        case 'sop-start':
          // The member face has no SOP write tool (D4.2): the double states
          // that the tool is unavailable and writes nothing.
          return sopUnavailableResult(input, options, callReport, options.behavior);
        case 'sop-executor':
          return sopResult(input, callReport, 'pass');
        case 'sop-verifier':
          return sopResult(input, callReport, 'fail');
        case 'sop-approval':
          return await sopApprovalResult(input, callReport);
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
    // The content is how a process-level test observes which text each section
    // carried and which one the assembly put last (the project supplement wins
    // a conflict). JSON keeps the three pieces on one reply line.
    `\n[rules-content] ${JSON.stringify({
      global: prompt.rulesBase,
      system: prompt.systemPrompt.length > 0 ? prompt.systemPrompt : null,
      project: prompt.projectSupplement,
    })}` +
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

/**
 * The double's TeamAssign behaviour (#39 / D3.4). A member sub-round is the
 * ordinary reply path (or the injected failure); a leader call walks the
 * injected member ids and reports each tool result back in its final reply.
 *
 * `team-budget` keeps assigning the first member until the tool refuses: the
 * completed calls advance the target budget, so the last call naturally lands
 * on `budget-exhausted`. It never mutates the ledger itself — the production
 * tool face is what spends the jumps.
 */
async function teamAssignResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
  untilExhausted: boolean,
): Promise<RoundResult> {
  if (input.team?.assignment !== null && input.team?.assignment !== undefined) {
    if (options.teamMemberFail === true) {
      return {
        verdict: 'failed',
        replies: [],
        detail: '脚本化 provider：成员子轮次被设定为失败',
      };
    }
    return replyResult(input, options, callReport);
  }

  const assign = input.team?.assign ?? null;
  if (!input.team?.is_leader || assign === null) {
    return {
      verdict: 'replied',
      replies: [`[team-assign] unavailable${callReport}${teamReport(input, options)}`],
    };
  }

  const memberIds = options.teamAssignMemberIds ?? [];
  const instruction = options.teamAssignInstruction ?? '请完成这个子任务。';
  const reports: string[] = [];
  const limit = untilExhausted ? 10 : memberIds.length;
  for (let index = 0; index < limit; index += 1) {
    const memberId = memberIds[untilExhausted ? 0 : index];
    if (memberId === undefined) {
      break;
    }
    const result = await assign({ member_id: memberId, instruction });
    reports.push(toolReport(result));
    if (untilExhausted && !result.ok) {
      break;
    }
  }
  return {
    verdict: 'replied',
    replies: [
      `[team-assign] ${reports.length === 0 ? 'no-members' : reports.join(' | ')}` +
        `${callReport}${teamReport(input, options)}`,
    ],
  };
}

/**
 * The double's Plan behaviour (#40 / D4.1): it calls the four tools through the
 * round's plan face — `TaskList` first (which lazily creates the run), then two
 * `TaskCreate` calls, a `TaskUpdate` that changes both title and status, another
 * `TaskList` and a `TaskGet`. The reply reports what the tools returned, so a
 * process-level test observes the current list, the append order and the three
 * words through the ordinary message.
 *
 * When the round is a leader round with injected assignees it also calls
 * TeamAssign; the member sub-round runs this same behaviour, so the sub-round's
 * own Plan face is exercised too. A round without the face reports
 * `available:false` and writes nothing.
 */
async function planResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
): Promise<RoundResult> {
  const plan = input.plan;
  if (plan === null) {
    return {
      verdict: 'replied',
      replies: [
        `[plan] available:false${callReport}` +
          `\n[plan-tools] ${input.tools.length === 0 ? '-' : input.tools.join(',')}` +
          teamReport(input, options),
      ],
    };
  }

  const before = plan.TaskList();
  const one = plan.TaskCreate({ title: 'PLAN-ITEM-ONE' });
  const two = plan.TaskCreate({ title: 'PLAN-ITEM-TWO' });
  const updated = plan.TaskUpdate({
    id: one.id,
    title: 'PLAN-ITEM-ONE-UPDATED',
    status: 'in_progress',
  });
  const listed = plan.TaskList();
  const got = plan.TaskGet({ id: two.id });
  const order = listed
    .map((task) => `${task.id}:${task.status}:${task.position}`)
    .join(',');
  const lines = [
    `[plan] available:true run:${one.plan_run_id} before:${before.length}` +
      ` count:${listed.length} order:${order}` +
      ` get:${got?.status ?? 'missing'}` +
      ` updated:${updated?.status ?? 'missing'}`,
    `[plan-tools] ${input.tools.join(',')}`,
  ];

  const assign = input.team?.assign ?? null;
  if (input.team?.is_leader === true && assign !== null) {
    const memberIds = options.teamAssignMemberIds ?? [];
    const instruction = options.teamAssignInstruction ?? '请完成这个子任务。';
    const reports: string[] = [];
    for (const memberId of memberIds) {
      const result = await assign({ member_id: memberId, instruction });
      reports.push(toolReport(result));
    }
    if (reports.length > 0) {
      lines.push(`[team-assign] ${reports.join(' | ')}`);
    }
  }

  return {
    verdict: 'replied',
    replies: [`${lines.join('\n')}${callReport}${teamReport(input, options)}`],
  };
}

/**
 * The double's proof that the member face has no SOP write tool (#41 / D4.2):
 * a `sop-create` / `sop-start` round reports the tool as unavailable and names
 * the SOP tools it was actually offered (none). It creates no definition and
 * starts no run; the human face is the only SOP write entry.
 */
function sopUnavailableResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
  behavior: 'sop-create' | 'sop-start',
): RoundResult {
  const sopTools = input.tools.filter((tool) => /sop/i.test(tool));
  return {
    verdict: 'replied',
    replies: [
      `[${behavior}] unavailable` +
        `\n[sop-tools] ${sopTools.length === 0 ? '-' : sopTools.join(',')}` +
        callReport +
        teamReport(input, options),
    ],
  };
}


/**
 * The double's project-root file-tool behaviour (#42 / D5.1). It calls the
 * round's file-tool face in a fixed order over fixtures a process-level test
 * controls (`notes.txt`, `sub/`, an `escape` symlink, an outside file next to
 * the root and the member's `skills/`), then reports each result in the reply.
 * The double never touches the filesystem itself: every read / write / edit is
 * the production face, so an escaping path is a tool error here exactly as it
 * is for a model.
 *
 * A round with no project root reports `available:false` and its actual tool
 * set; the test reads that as "no file tools and no shell".
 */
async function workspaceResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
): Promise<RoundResult> {
  const toolsLine = `[workspace-tools] ${input.tools.length === 0 ? '-' : input.tools.join(',')}`;
  const workspace = input.workspace;
  if (workspace === null) {
    return {
      verdict: 'replied',
      replies: [
        `[workspace] available:false${callReport}\n${toolsLine}` +
          teamReport(input, options),
      ],
    };
  }

  const files = workspace.files;
  const outside = path.join(path.dirname(workspace.root), 'outside.txt');
  const lines: string[] = [
    `[workspace] root:${workspace.root} backend:${workspace.backend}` +
      ` shell:${workspace.allow_local_shell}`,
    reportFileCall('workspace-read', await files.Read({ path: 'notes.txt' })),
    reportFileCall('workspace-glob', await files.Glob({ pattern: '**/*.txt' })),
    reportFileCall('workspace-grep', await files.Grep({ pattern: 'NEEDLE' })),
    reportFileCall(
      'workspace-absolute-inside',
      await files.Read({ path: path.join(workspace.root, 'notes.txt') }),
    ),
    reportFileCall(
      'workspace-write',
      await files.Write({ path: 'written.txt', content: 'written-by-tool' }),
    ),
    reportFileCall(
      'workspace-edit',
      await files.Edit({
        path: 'written.txt',
        old_string: 'written-by-tool',
        new_string: 'edited-by-tool',
      }),
    ),
    reportFileCall('workspace-reread', await files.Read({ path: 'written.txt' })),
    reportFileCall('workspace-dotdot', await files.Read({ path: '../outside.txt' })),
    reportFileCall('workspace-absolute', await files.Read({ path: outside })),
    reportFileCall('workspace-symlink', await files.Read({ path: 'escape/outside.txt' })),
  ];

  if (workspace.skills_root !== null) {
    const skills = workspace.skills_root;
    lines.push(
      reportFileCall(
        'workspace-skills-read',
        await files.Read({ path: path.join(skills, 'demo', 'SKILL.md') }),
      ),
      reportFileCall(
        'workspace-skills-glob',
        await files.Glob({ pattern: '**/*.md', path: skills }),
      ),
      reportFileCall(
        'workspace-skills-grep',
        await files.Grep({ pattern: 'SKILL-NEEDLE', path: skills }),
      ),
      reportFileCall(
        'workspace-skills-write',
        await files.Write({ path: path.join(skills, 'demo', 'SKILL.md'), content: 'hacked' }),
      ),
      reportFileCall(
        'workspace-skills-edit',
        await files.Edit({
          path: path.join(skills, 'demo', 'SKILL.md'),
          old_string: 'SKILL-NEEDLE',
          new_string: 'hacked',
        }),
      ),
    );
  } else {
    lines.push('[workspace-skills] absent');
  }
  // The Agent home is not a project work root (#43 / D5.2): the home AGENTS.md
  // is human-maintained and outside every file-tool root, so a Write to it is a
  // hard error (never an approval, never a silent read-only success).
  lines.push(
    reportFileCall(
      'workspace-home-write',
      await files.Write({
        path: path.join(agentHomeRoot(input.member.id), 'AGENTS.md'),
        content: 'hacked',
      }),
    ),
  );
  lines.push(toolsLine);
  return {
    verdict: 'replied',
    replies: [`${lines.join('\n')}${callReport}${teamReport(input, options)}`],
  };
}

/**
 * The double's permission-gate behaviour (#44 / D5.5 / D5.6). It asks the
 * round's synchronous gate face to classify a fixed set of calls (including the
 * local-shell hook and an MCP name with stable argument JSON), then performs
 * two writes in one round so a test can observe the DENIED result and the
 * multi-batch reopen. The double never decides anything itself: every line is
 * the production gate's answer.
 */
async function permissionResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
): Promise<RoundResult> {
  const workspace = input.workspace;
  const toolsLine = `[workspace-tools] ${input.tools.length === 0 ? '-' : input.tools.join(',')}`;
  if (workspace === null) {
    return {
      verdict: 'replied',
      replies: [
        `[permission] available:false${callReport}\n${toolsLine}` +
          teamReport(input, options),
      ],
    };
  }
  const permission = workspace.permission;
  const files = workspace.files;
  const mcpArgs = stableJson({ z: 'last', a: 1 });
  const checks: string[] = [
    `[permission] mode:${permission.mode} shell:${workspace.allow_local_shell}`,
    checkLine('Read:notes.txt', permission.check({ tool_name: 'Read', pattern: 'notes.txt' })),
    checkLine('Write:notes.txt', permission.check({ tool_name: 'Write', pattern: 'notes.txt' })),
    checkLine('Write:sub/deep.txt', permission.check({ tool_name: 'Write', pattern: 'sub/deep.txt' })),
    checkLine('Bash:rm -rf /', permission.check({ tool_name: 'Bash', pattern: 'rm -rf /' })),
    checkLine('Bash:ls -la', permission.check({ tool_name: 'Bash', pattern: 'ls -la' })),
    checkLine(
      'mcp:demo/echo:{"a":1,"z":"last"}',
      permission.check({ tool_name: 'mcp:demo/echo', pattern: mcpArgs }),
    ),
  ];
  const lines: string[] = [
    ...checks,
    reportFileCall(
      'approval-one',
      await files.Write({ path: 'approval-one.txt', content: 'one' }),
    ),
    reportFileCall(
      'approval-two',
      await files.Write({ path: 'approval-two.txt', content: 'two' }),
    ),
    reportFileCall('approval-read', await files.Read({ path: 'notes.txt' })),
    `[shell-approval] ${await permission.authorize({
      tool_name: 'Bash',
      pattern: 'ls -la',
      arguments: { command: 'ls -la' },
    })}`,
    toolsLine,
  ];
  return {
    verdict: 'replied',
    replies: [`${lines.join('\n')}${callReport}${teamReport(input, options)}`],
  };
}

function checkLine(label: string, check: { decision: string; reason: string }): string {
  return `[permission-check] ${label}=${check.decision}:${check.reason}`;
}


/**
 * The double's MCP approval face (#44 / D5.5 / D5.6): MCP tools are execute
 * class, so an ask-writes round asks. The arguments carry secret-shaped fields
 * to prove the approval row masks them; the production gate writes the row, the
 * double only calls the same face the future MCP adapter will.
 */
async function mcpApprovalResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
): Promise<RoundResult> {
  const workspace = input.workspace;
  if (workspace === null) {
    return {
      verdict: 'replied',
      replies: [`[mcp-approval] available:false${callReport}${teamReport(input, options)}`],
    };
  }
  const args = {
    api_key: 'sk-live-approval-SECRET',
    nested: { token: 'token-approval-SECRET' },
    plain: 'readable',
  };
  const outcome = await workspace.permission.authorize({
    tool_name: 'mcp:demo/echo',
    pattern: stableJson(args),
    tool_call_id: 'mcp-call-stable',
    arguments: args,
  });
  // Re-registering the same call id after the decision is the idempotent
  // duplicate-registration case: it must not reopen a batch or add a call.
  const replay = await workspace.permission.authorize({
    tool_name: 'mcp:demo/echo',
    pattern: stableJson(args),
    tool_call_id: 'mcp-call-stable',
    arguments: args,
  });
  return {
    verdict: 'replied',
    replies: [
      `[mcp-approval] mcp:demo/echo:${outcome}` +
        `\n[mcp-approval-repeat] mcp:demo/echo:${replay}` +
        `${callReport}${teamReport(input, options)}`,
    ],
  };
}

/**
 * The double's TeamAssign approval face (#44 / D5.6): the leader assigns, and
 * the member sub-round performs one gated write, so an ask carries
 * `context_kind='team-assignment'` and the assignment id. The production gate
 * writes the approval; the double observes the sub-round's tool result.
 */
async function teamApprovalResult(
  input: RoundInput,
  options: ScriptedProviderOptions,
  callReport: string,
): Promise<RoundResult> {
  if (input.team?.assignment !== null && input.team?.assignment !== undefined) {
    const workspace = input.workspace;
    if (workspace === null) {
      return {
        verdict: 'replied',
        replies: [`[team-approval] available:false${callReport}${teamReport(input, options)}`],
      };
    }
    const result = await workspace.files.Write({
      path: 'team-approval.txt',
      content: 'member-wrote',
    });
    return {
      verdict: 'replied',
      replies: [
        `[team-approval] member:${reportFileCall('team-approval-write', result)}` +
          `${callReport}${teamReport(input, options)}`,
      ],
    };
  }
  return await teamAssignResult(input, options, callReport, false);
}

/**
 * The double's SOP executor / verifier face (#45 / D4.3). The same injected
 * behaviour serves both roles: in an executor round it answers with a
 * deterministic text; in a verifier round it returns the selected structured
 * `sopVerdict` and quotes the executor text it was handed, so a process-level
 * test can prove the executor output was the verifier's input.
 */
function sopResult(
  input: RoundInput,
  callReport: string,
  verdict: 'pass' | 'fail',
): RoundResult {
  const sop = input.sop;
  if (sop === null) {
    return {
      verdict: 'replied',
      replies: [`[sop] unavailable${callReport}`],
    };
  }
  if (sop.role === 'executor') {
    return {
      verdict: 'replied',
      replies: [
        `SOP-EXEC:${sop.step_index}:${sop.attempt}:${sop.step_title}${callReport}`,
      ],
    };
  }
  const saw = (sop.executor_text ?? '-').replaceAll('\n', ' ');
  return {
    verdict: 'replied',
    replies: [
      `SOP-VERIFY:${verdict.toUpperCase()}:${sop.step_index}:${sop.attempt}:SAW:${saw}${callReport}`,
    ],
    sopVerdict: verdict,
  };
}

/**
 * The double's SOP approval face (#45 / D4.3 / D5.6). The executor round makes
 * one gated write: under `ask-writes` that registers a SOP approval and waits;
 * approve executes the write, deny returns the tool's DENIED result and the
 * round still continues. The verifier then passes with a readable text.
 */
async function sopApprovalResult(
  input: RoundInput,
  callReport: string,
): Promise<RoundResult> {
  const sop = input.sop;
  if (sop === null) {
    return { verdict: 'replied', replies: [`[sop-approval] unavailable${callReport}`] };
  }
  if (sop.role === 'verifier') {
    const saw = (sop.executor_text ?? '-').replaceAll('\n', ' ');
    return {
      verdict: 'replied',
      replies: [`[sop-approval] verifier:pass saw:${saw}${callReport}`],
      sopVerdict: 'pass',
    };
  }
  const workspace = input.workspace;
  if (workspace === null) {
    return {
      verdict: 'replied',
      replies: [`[sop-approval] available:false${callReport}`],
    };
  }
  const result = await workspace.files.Write({
    path: 'sop-approval.txt',
    content: 'written-by-sop-approval',
  });
  const outcome = result.ok ? 'ok' : `error:${result.error ?? 'unknown'}`;
  return {
    verdict: 'replied',
    replies: [`[sop-approval] write:${outcome}${callReport}`],
  };
}

/** The double's readable line for one file-tool result (never production copy). */
function reportFileCall(label: string, result: RoundFileToolResult): string {
  if (!result.ok) {
    return `[${label}] error:${result.error ?? 'unknown'}`;
  }
  const parts = [`[${label}] ok`];
  if (result.path !== undefined) {
    parts.push(`path:${result.path}`);
  }
  if (result.paths !== undefined) {
    parts.push(`paths:${result.paths.join(',')}`);
  }
  if (result.matches !== undefined) {
    parts.push(`matches:${result.matches.length}`);
  }
  if (result.replacements !== undefined) {
    parts.push(`replacements:${result.replacements}`);
  }
  if (result.content !== undefined) {
    parts.push(`content:${result.content.replaceAll('\n', ' ').trimEnd()}`);
  }
  return parts.join(' ');
}

/** The double's readable line for one tool result (never production copy). */
function toolReport(result: TeamAssignToolResult): string {
  const state = result.state ?? 'none';
  return (
    `${result.member_id}=${state}` +
    `:jump=${result.jump_consumed}` +
    `:excerpt=${codepointLength(result.reply_excerpt ?? '')}` +
    `:output=${codepointLength(result.output ?? '')}` +
    (result.ok ? '' : `:error=${result.code ?? 'unknown'}`)
  );
}
