import {
  t,
  type AgentMcpView,
  type AgentProvider,
  type AgentRulesView,
  type AgentSkillCandidatesView,
  type AgentSkillDetailView,
  type AgentSkillsView,
  type ApprovalDecisionInput,
  type ApprovalView,
  type ChannelConfigPatch,
  type PermissionMode,
  type PermissionRuleInput,
  type PermissionRuleView,
  type PlanRunView,
  type RemoteDataFlowReadView,
  type SopDefinitionCreate,
  type SopDefinitionView,
  type SopRunView,
  type TargetMemberView,
  type TeamRunView,
  type WorkspaceSettingsView,
  type WorkspaceView,
  type WorkspaceBackend,
} from '@allibot/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App.ts';
import { transitionTask } from './task-board/task-board.ts';
import {
  allNavEntries,
  buildWorkspaceNav,
  initialTargetId,
  targetKind,
} from './workspace/model.ts';
import {
  applyTeamAssignmentFrame,
  isTeamTarget,
  readTeamAssignmentFrame,
  readTeamRuns,
} from './workspace/team-runs.ts';
import { shouldRefreshWorkspace } from './workspace/message-sync.ts';
import {
  applyPlanUpdateFrame,
  isPlanTarget,
  readPlanUpdateFrame,
  readPlans,
} from './workspace/plans.ts';
import { readApprovalFrame } from './workspace/approvals.ts';
import {
  permissionScopeKey,
  type PermissionScope,
} from './workspace/permissions.ts';
import {
  applySopUpdateFrame,
  mergeSopRun,
  readSopDefinitions,
  readSopRun,
  readSopRuns,
  readSopUpdateFrame,
} from './workspace/sops.ts';
import {
  confirmProviderDataFlow,
  createAgent,
  createChannel,
  deleteAgent,
  createSopDefinition,
  joinChannelMember,
  patchChannelConfig,
  readApprovals,
  readPermissionRules,
  readRemoteDataFlow,
  deleteAgentSkill,
  readAgentMcp,
  readAgentSkill,
  readAgentSkills,
  readSkillCandidates,
  importAllAgentSkills,
  installAgentSkill,
  readTargetMembers,
  readWorkspace,
  setAgentSkillEnabled,
  saveAgentConfig,
  saveAgentMcp,
  savePermissionRules,
  startSopRun,
  submitApprovalDecision,
} from './workspace-actions.ts';
import { applyJoinResult } from './workspace/member-reading.ts';
import { readAgentRules } from './workspace/agent-rules.ts';

const DEFAULT_SETTINGS: WorkspaceSettingsView = {
  locale: 'zh-CN',
  density: 'comfortable',
  theme: 'system',
};

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('root element #root is missing');
}

const root = createRoot(rootElement);

/** The shell's whole state: one workspace reading, one selected target. */
let currentWorkspace: WorkspaceView | null = null;
let currentSettings: WorkspaceSettingsView = DEFAULT_SETTINGS;
let currentTargetId: string | null = null;
let currentViewportWidth = window.innerWidth;
let refreshGeneration = 0;
/**
 * 两条失败路径各一位：`GET /api/workspace` 读不到与 `PATCH /api/settings` 写不落库
 * 是两条不同的失败，各用一条词条说明；合成一个标志会把读数失败说成写入失败。
 */
let loadFailed = false;
let saveFailed = false;
/**
 * 当前 target 的成员表（成员面板 / 名册 / workspace_status）：按需读，
 * 不把「未加入」或工作区可用性当猜测。
 */
let currentChannelMembers: Record<string, TargetMemberView[]> = {};
/** 当前 team target 的运行记录；run 是独立读数，不进消息流。 */
let currentTeamRuns: Record<string, readonly TeamRunView[]> = {};
/** 当前 target 的 Plan 读数；plan 是独立读数，不进消息流。 */
let currentPlans: Record<string, readonly PlanRunView[]> = {};
/** 审批读数（独立于消息流）：列表与单条来自 GET /api/approvals。 */
let currentApprovals: readonly ApprovalView[] = [];
/** 权限规则集，按 `permissionScopeKey` 归档；频道 / Agent 共用一套形状。 */
let currentPermissionRules: Record<string, readonly PermissionRuleView[]> = {};
/** 当前频道的 SOP 定义；SOP 是频道级流程，不是消息或任务。 */
let currentSopDefinitions: Record<string, readonly SopDefinitionView[]> = {};
/** SOP run 读数，按 definition id 归档；pending run 由启动响应带回。 */
let currentSopRuns: Record<string, readonly SopRunView[]> = {};
/** Agent 家目录 / 规则读数 (#43)：打开详情时按需读，不猜三段内容。 */
let currentAgentRules: Record<string, AgentRulesView> = {};
/** mcp.json 读数 (#47)：结构与原文共用这一份，打开详情时按需读。 */
let currentAgentMcp: Record<string, AgentMcpView> = {};
/** Skill readings (#48): list, selected detail and the landing candidates. */
let currentAgentSkills: Record<string, AgentSkillsView> = {};
let currentAgentSkillDetails: Record<string, AgentSkillDetailView> = {};
let currentAgentSkillCandidates: Record<string, AgentSkillCandidatesView> = {};
/** `/api/remote-data-flow`: the provider credential env names and consent facts. */
let currentRemoteDataFlow: RemoteDataFlowReadView | undefined;

async function loadTargetMembers(targetId: string): Promise<void> {
  currentChannelMembers = {
    ...currentChannelMembers,
    [targetId]: await readTargetMembers(fetch, targetId),
  };
}

async function loadTeamRuns(targetId: string): Promise<void> {
  currentTeamRuns = {
    ...currentTeamRuns,
    [targetId]: await readTeamRuns(fetch, targetId),
  };
}

async function loadApprovals(): Promise<void> {
  currentApprovals = await readApprovals(fetch, 'all');
}

/** The provider reading that names each credential variable and consent row. */
async function loadRemoteDataFlow(): Promise<void> {
  currentRemoteDataFlow = await readRemoteDataFlow(fetch);
}

/**
 * The permission rule sets follow the workspace reading: every channel and
 * Agent has one set. A rule write only changes its own scope, so the shell
 * re-reads all of them after a write (the sets are tiny).
 */
async function loadPermissionRules(workspace: WorkspaceView): Promise<void> {
  const scopes: PermissionScope[] = [
    ...workspace.channels.map((channel) => ({ kind: 'channel' as const, id: channel.id })),
    ...workspace.agents.map((agent) => ({ kind: 'agent' as const, id: agent.id })),
  ];
  const entries = await Promise.all(
    scopes.map(
      async (scope) =>
        [permissionScopeKey(scope), await readPermissionRules(fetch, scope)] as const,
    ),
  );
  const next: Record<string, readonly PermissionRuleView[]> = {};
  for (const [key, rules] of entries) {
    next[key] = rules;
  }
  currentPermissionRules = next;
}

async function loadAgentRules(agentId: string, channelId: string | null): Promise<void> {
  const rules = await readAgentRules(fetch, agentId, channelId);
  currentAgentRules = { ...currentAgentRules, [agentId]: rules };
}

async function loadAgentMcp(agentId: string): Promise<void> {
  const reading = await readAgentMcp(fetch, agentId);
  currentAgentMcp = { ...currentAgentMcp, [agentId]: reading };
}

async function loadAgentSkill(agentId: string, name: string): Promise<void> {
  const detail = await readAgentSkill(fetch, agentId, name);
  currentAgentSkillDetails = { ...currentAgentSkillDetails, [agentId]: detail };
}

/**
 * The list + candidates are one reading; the first (or preferred) skill's
 * detail follows so the right column is never a fabricated placeholder.
 */
async function loadAgentSkills(agentId: string, preferredName?: string): Promise<void> {
  const previousName = currentAgentSkillDetails[agentId]?.skill.name;
  const [view, candidates] = await Promise.all([
    readAgentSkills(fetch, agentId),
    readSkillCandidates(fetch, agentId),
  ]);
  currentAgentSkills = { ...currentAgentSkills, [agentId]: view };
  currentAgentSkillCandidates = { ...currentAgentSkillCandidates, [agentId]: candidates };
  // Keep the user's selected row across a reload (import / toggle) while it
  // still exists; an explicit preferred name (a successful single import)
  // wins, and a deleted selection falls back to the first row.
  const name =
    preferredName !== undefined && view.skills.some((skill) => skill.name === preferredName)
      ? preferredName
      : previousName !== undefined && view.skills.some((skill) => skill.name === previousName)
        ? previousName
        : view.skills[0]?.name;
  if (name === undefined) {
    const rest = { ...currentAgentSkillDetails };
    delete rest[agentId];
    currentAgentSkillDetails = rest;
    return;
  }
  await loadAgentSkill(agentId, name);
}

async function refreshSkillCandidates(agentId: string): Promise<void> {
  const candidates = await readSkillCandidates(fetch, agentId);
  currentAgentSkillCandidates = { ...currentAgentSkillCandidates, [agentId]: candidates };
}

async function importOneSkill(agentId: string, name: string): Promise<void> {
  await installAgentSkill(fetch, agentId, name);
  await loadAgentSkills(agentId, name);
}

async function importAllSkills(agentId: string): Promise<void> {
  await importAllAgentSkills(fetch, agentId);
  await loadAgentSkills(agentId);
}

async function toggleAgentSkill(
  agentId: string,
  name: string,
  enabled: boolean,
): Promise<void> {
  await setAgentSkillEnabled(fetch, agentId, name, enabled);
  await loadAgentSkills(agentId, name);
}

async function removeAgentSkill(agentId: string, name: string): Promise<void> {
  await deleteAgentSkill(fetch, agentId, name);
  await loadAgentSkills(agentId);
}

/** The one mcp.json write; the returned reading refreshes both blocks. */
async function changeAgentMcp(
  agentId: string,
  body: { entries: import('@allibot/shared').McpServerEntry[] } | { raw: string },
): Promise<AgentMcpView> {
  const reading = await saveAgentMcp(fetch, agentId, body);
  currentAgentMcp = { ...currentAgentMcp, [agentId]: reading };
  return reading;
}

async function loadPlans(targetId: string): Promise<void> {
  currentPlans = {
    ...currentPlans,
    [targetId]: await readPlans(fetch, targetId),
  };
}

/**
 * SOP 读数跟随频道选择 (D4.2): definitions are channel-scoped, and each
 * definition's newest runs are one independent snapshot. The panel displays
 * them read-only; nothing here enters the message stream.
 */
async function loadSops(channelId: string): Promise<void> {
  const definitions = await readSopDefinitions(fetch, channelId);
  currentSopDefinitions = { ...currentSopDefinitions, [channelId]: definitions };
  const entries = await Promise.all(
    definitions.map(
      async (definition) => [definition.id, await readSopRuns(fetch, definition.id)] as const,
    ),
  );
  const nextRuns = { ...currentSopRuns };
  for (const [definitionId, runs] of entries) {
    nextRuns[definitionId] = runs;
  }
  currentSopRuns = nextRuns;
}

/** 创建 SOP 定义：后端是正本，成功后重读该频道的定义与 run。 */
async function createSopAction(input: SopDefinitionCreate): Promise<void> {
  await createSopDefinition(fetch, input);
  await loadSops(input.channel_id);
  render();
}

/** 启动 SOP：202 的 pending run 立刻进读数，再重读该定义的 run 快照。 */
async function startSopAction(definitionId: string): Promise<void> {
  const run = await startSopRun(fetch, definitionId);
  currentSopRuns = {
    ...currentSopRuns,
    [definitionId]: [
      run,
      ...(currentSopRuns[definitionId] ?? []).filter((row) => row.id !== run.id),
    ],
  };
  render();
  try {
    const runs = await readSopRuns(fetch, definitionId);
    currentSopRuns = { ...currentSopRuns, [definitionId]: runs };
  } catch (error: unknown) {
    console.error('sop run read failed', error);
  }
  render();
}

/** 加入频道：只有后端响应后行才移动；幂等重复时重读那张过期的成员表。 */
async function joinChannelMemberAction(
  channelId: string,
  memberId: string,
): Promise<void> {
  const result = await joinChannelMember(fetch, channelId, memberId);
  const joinedAgent = currentWorkspace?.agents.find((row) => row.id === memberId);
  if (result.joined && joinedAgent !== undefined) {
    currentChannelMembers = {
      ...currentChannelMembers,
      [channelId]: applyJoinResult(
        currentChannelMembers[channelId] ?? [],
        joinedAgent,
        result.joined,
      ).members,
    };
  } else {
    await loadTargetMembers(channelId);
  }
  render();
}

async function saveAgentAction(
  agentId: string,
  patch: {
    system_prompt?: string;
    permission_mode?: PermissionMode | null;
    workspace_backend?: WorkspaceBackend | null;
  },
): Promise<void> {
  await saveAgentConfig(fetch, agentId, patch);
  await refreshWorkspace();
}

/** One approval decision; the backend is the source of truth, then re-read. */
async function approvalDecisionAction(
  replyId: string,
  input: ApprovalDecisionInput,
): Promise<void> {
  await submitApprovalDecision(fetch, replyId, input);
  await loadApprovals();
  await refreshWorkspace();
}

/** The full-replacement permission rule write for one channel / Agent scope. */
async function permissionRulesAction(
  scope: PermissionScope,
  rules: PermissionRuleInput[],
): Promise<void> {
  const saved = await savePermissionRules(fetch, scope, rules);
  currentPermissionRules = {
    ...currentPermissionRules,
    [permissionScopeKey(scope)]: saved,
  };
  render();
}

/**
 * The team configuration write (mode / leader): one PATCH, then re-read the
 * one workspace reading. The backend owns validity and leader propagation; the
 * shell never writes optimistically.
 */
async function channelConfigAction(
  channelId: string,
  patch: ChannelConfigPatch,
): Promise<void> {
  await patchChannelConfig(fetch, channelId, patch);
  await refreshWorkspace();
}

async function deleteAgentAction(agentId: string): Promise<void> {
  await deleteAgent(fetch, agentId);
  await refreshWorkspace();
}

/**
 * 空状态里的两个创建（D9）：动作自己带回刷新后的工作台读数，宿主直接采用，
 * 不再多读一次；名字就是用户输入的名字，空名字已由表单拦下。
 */
async function createChannelAction(name: string): Promise<void> {
  await adoptWorkspaceReading(await createChannel(fetch, name));
}

async function createAgentAction(name: string): Promise<void> {
  await adoptWorkspaceReading(await createAgent(fetch, name));
}

/** One one-time provider consent; the workspace re-read refreshes the status point. */
async function confirmProviderConsentAction(provider: AgentProvider): Promise<void> {
  await confirmProviderDataFlow(fetch, provider);
  await refreshWorkspace();
}

async function writeSettings(
  patch: Partial<WorkspaceSettingsView>,
): Promise<WorkspaceSettingsView> {
  const response = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`PATCH /api/settings failed with ${response.status}`);
  }
  return (await response.json()) as WorkspaceSettingsView;
}

function render(): void {
  root.render(
    <StrictMode>
      <App
        settings={currentSettings}
        workspace={currentWorkspace ?? undefined}
        activeTargetId={currentTargetId}
        viewportWidth={currentViewportWidth}
        channelMembers={currentChannelMembers}
        teamRuns={currentTeamRuns}
        plans={currentPlans}
        sopDefinitions={currentSopDefinitions}
        sopRuns={currentSopRuns}
        approvals={currentApprovals}
        permissionRules={currentPermissionRules}
        agentRules={currentAgentRules}
        agentMcp={currentAgentMcp}
        remoteDataFlow={currentRemoteDataFlow}
        onConfirmProviderConsent={confirmProviderConsentAction}
        agentSkills={currentAgentSkills}
        agentSkillDetails={currentAgentSkillDetails}
        agentSkillCandidates={currentAgentSkillCandidates}
        onAgentSkillsNeeded={(agentId) => {
          void loadAgentSkills(agentId)
            .then(() => render())
            .catch((error: unknown) => {
              console.error('Agent skills read failed', error);
            });
        }}
        onAgentSkillNeeded={(agentId, name) => {
          void loadAgentSkill(agentId, name)
            .then(() => render())
            .catch((error: unknown) => {
              console.error('Agent skill read failed', error);
            });
        }}
        onAgentSkillRefreshCandidates={(agentId) =>
          refreshSkillCandidates(agentId).then(() => render())
        }
        onAgentSkillImport={(agentId, name) => importOneSkill(agentId, name).then(() => render())}
        onAgentSkillsImportAll={(agentId) => importAllSkills(agentId).then(() => render())}
        onAgentSkillToggle={(agentId, name, enabled) =>
          toggleAgentSkill(agentId, name, enabled).then(() => render())
        }
        onAgentSkillDelete={(agentId, name) =>
          removeAgentSkill(agentId, name).then(() => render())
        }
        onAgentRulesNeeded={(agentId, channelId) => {
          void loadAgentRules(agentId, channelId)
            .then(() => render())
            .catch((error: unknown) => {
              console.error('Agent rules read failed', error);
            });
        }}
        onAgentMcpNeeded={(agentId) => {
          void loadAgentMcp(agentId)
            .then(() => render())
            .catch((error: unknown) => {
              console.error('Agent mcp read failed', error);
            });
        }}
        onAgentMcpChange={changeAgentMcp}
        saveFailed={saveFailed}
        loadFailed={loadFailed}
        onSelectTarget={(targetId) => {
          currentTargetId = targetId;
          render();
          const reading = currentWorkspace;
          if (reading !== null) {
            // Workspace status is a target fact: read the selected target's
            // member table for every target kind, not only a channel.
            void loadTargetMembers(targetId)
              .then(() => render())
              .catch((error: unknown) => {
                console.error('target members read failed', error);
              });
          }
          if (reading !== null && isTeamTarget(reading, targetId)) {
            void loadTeamRuns(targetId)
              .then(() => render())
              .catch((error: unknown) => {
                console.error('team runs read failed', error);
              });
          }
          if (reading !== null && isPlanTarget(reading, targetId)) {
            void loadPlans(targetId)
              .then(() => render())
              .catch((error: unknown) => {
                console.error('plan read failed', error);
              });
          }
          if (reading !== null && targetKind(reading, targetId) === 'channel') {
            void loadSops(targetId)
              .then(() => render())
              .catch((error: unknown) => {
                console.error('SOP read failed', error);
              });
          }
        }}
        onTaskTransition={(task, status) =>
          transitionTask(fetch, task, status)
            .then(async (outcome) => {
              if (!outcome.ok) {
                return false;
              }
              // 写路径成功后重新读工作台读数；看板不做乐观更新。
              await refreshWorkspace();
              return true;
            })
            .catch(() => false)
        }
        onJoinMember={joinChannelMemberAction}
        onCreateChannel={createChannelAction}
        onCreateAgent={createAgentAction}
        onSaveAgent={saveAgentAction}
        onChannelConfigChange={channelConfigAction}
        onCreateSop={createSopAction}
        onStartSop={startSopAction}
        onDeleteAgent={deleteAgentAction}
        onApprovalDecision={approvalDecisionAction}
        onPermissionRulesChange={permissionRulesAction}
        onAgentPermissionModeChange={(agentId, mode) =>
          saveAgentAction(agentId, {
            permission_mode: mode === null ? null : (mode as PermissionMode),
          })
        }
        onAgentWorkspaceBackendChange={(agentId, backend) =>
          saveAgentAction(agentId, {
            workspace_backend: backend === null ? null : (backend as WorkspaceBackend),
          })
        }
        onSettingsChange={(patch) => {
          // 后端是正本：先读返回值，再重渲染。
          writeSettings(patch)
            .then((saved) => {
              currentSettings = saved;
              if (currentWorkspace !== null) {
                currentWorkspace = { ...currentWorkspace, settings: saved };
              }
              saveFailed = false;
              render();
            })
            .catch(() => {
              saveFailed = true;
              render();
            });
        }}
        onLiveEvent={(event) => {
          if (event.event === 'plan_update') {
            const frame = readPlanUpdateFrame(event.data);
            if (frame === null) {
              return;
            }
            currentPlans = applyPlanUpdateFrame(currentPlans, frame);
            render();
            void loadPlans(frame.target_id)
              .then(() => render())
              .catch((error: unknown) => {
                console.error('plan read failed', error);
              });
            return;
          }
          if (event.event === 'sop_update') {
            const frame = readSopUpdateFrame(event.data);
            if (frame === null) {
              return;
            }
            // 帧是进度点，不是摘录快照：先用它移动本地读数，再按 run id 各读一次
            // `GET /api/sop-runs/{id}` 取回 state。没有轮询，也没有第二条流。
            currentSopRuns = applySopUpdateFrame(currentSopRuns, frame);
            render();
            void readSopRun(fetch, frame.sop_run_id)
              .then((run) => {
                currentSopRuns = mergeSopRun(currentSopRuns, run);
                render();
              })
              .catch((error: unknown) => {
                console.error('SOP run read failed', error);
              });
            return;
          }
          if (event.event === 'team_assignment') {
            const frame = readTeamAssignmentFrame(event.data);
            if (frame === null) {
              return;
            }
            currentTeamRuns = applyTeamAssignmentFrame(currentTeamRuns, frame);
            render();
            void loadTeamRuns(frame.target_id)
              .then(() => render())
              .catch((error: unknown) => {
                console.error('team runs read failed', error);
              });
            return;
          }
          if (event.event === 'approval.requested' || event.event === 'approval.resolved') {
            const frame = readApprovalFrame(event.data);
            if (frame === null) {
              return;
            }
            void loadApprovals()
              .then(() => refreshWorkspace())
              .catch((error: unknown) => {
                console.error('approval read failed', error);
              });
            return;
          }
          if (shouldRefreshWorkspace(event.event)) {
            void refreshWorkspace().catch((error: unknown) => {
              console.error('workspace refresh failed', error);
            });
          }
        }}
      />
    </StrictMode>,
  );
}

/**
 * 采用一份新的工作台读数：先换正本，再按需重读跟随它的读数（权限规则、
 * 审批、远端数据流、当前 target 的成员表 / team / plan / SOP），最后渲染。
 */
async function adoptWorkspaceReading(reading: WorkspaceView): Promise<void> {
  currentWorkspace = reading;
  currentSettings = reading.settings;
  // 读数又读到了：兜底设置面的「设置读取失败」随之消失。
  loadFailed = false;
  try {
    await loadPermissionRules(reading);
    await loadApprovals();
    await loadRemoteDataFlow();
  } catch (error: unknown) {
    console.error('permission / approval / remote-flow read failed', error);
  }
  const targets = new Set(allNavEntries(buildWorkspaceNav(reading)).map((entry) => entry.targetId));
  if (currentTargetId === null || !targets.has(currentTargetId)) {
    currentTargetId = initialTargetId(reading);
  }
  // 成员表也承载目标上下文的 workspace_status；SSE 的成员 / 状态事实会
  // 走到这里，因此跟随工作台读数一起刷新当前 target 的成员表。
  if (currentTargetId !== null) {
    try {
      await loadTargetMembers(currentTargetId);
    } catch (error: unknown) {
      console.error('target members read failed', error);
    }
  }
  if (currentTargetId !== null && isTeamTarget(reading, currentTargetId)) {
    try {
      await loadTeamRuns(currentTargetId);
    } catch (error: unknown) {
      console.error('team runs read failed', error);
    }
  }
  if (currentTargetId !== null && isPlanTarget(reading, currentTargetId)) {
    try {
      await loadPlans(currentTargetId);
    } catch (error: unknown) {
      console.error('plan read failed', error);
    }
  }
  if (currentTargetId !== null && targetKind(reading, currentTargetId) === 'channel') {
    try {
      await loadSops(currentTargetId);
    } catch (error: unknown) {
      console.error('SOP read failed', error);
    }
  }
  render();
}

/**
 * Re-read the one workspace reading (D1.9): SSE frames carry facts, not the
 * reading itself, so unread / task / status changes re-fetch the snapshot
 * instead of growing a local count.
 */
async function refreshWorkspace(): Promise<void> {
  const generation = ++refreshGeneration;
  const reading = await readWorkspace(fetch);
  if (generation !== refreshGeneration) {
    return;
  }
  await adoptWorkspaceReading(reading);
}

window.addEventListener('resize', () => {
  currentViewportWidth = window.innerWidth;
  render();
});

refreshWorkspace().catch(() => {
  // 后端不可达时壳仍显示可读文案：它说明读数没读到，而不是静默空白。
  console.error(t(DEFAULT_SETTINGS.locale, 'settings.error.load'));
  loadFailed = true;
  render();
});
