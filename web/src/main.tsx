import {
  t,
  type AgentRulesView,
  type ChannelConfigPatch,
  type PlanRunView,
  type SopDefinitionCreate,
  type SopDefinitionView,
  type SopRunView,
  type TargetMemberView,
  type TeamRunView,
  type WorkspaceSettingsView,
  type WorkspaceView,
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
import { readSopDefinitions, readSopRuns } from './workspace/sops.ts';
import {
  deleteAgent,
  createSopDefinition,
  joinChannelMember,
  patchChannelConfig,
  readTargetMembers,
  saveAgentConfig,
  startSopRun,
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
 * 当前 target 的成员表（成员面板 / 名册 / workspace_status）：按需读，
 * 不把「未加入」或工作区可用性当猜测。
 */
let currentChannelMembers: Record<string, TargetMemberView[]> = {};
/** 当前 team target 的运行记录；run 是独立读数，不进消息流。 */
let currentTeamRuns: Record<string, readonly TeamRunView[]> = {};
/** 当前 target 的 Plan 读数；plan 是独立读数，不进消息流。 */
let currentPlans: Record<string, readonly PlanRunView[]> = {};
/** 当前频道的 SOP 定义；SOP 是频道级流程，不是消息或任务。 */
let currentSopDefinitions: Record<string, readonly SopDefinitionView[]> = {};
/** SOP run 读数，按 definition id 归档；pending run 由启动响应带回。 */
let currentSopRuns: Record<string, readonly SopRunView[]> = {};
/** Agent 家目录 / 规则读数 (#43)：打开详情时按需读，不猜三段内容。 */
let currentAgentRules: Record<string, AgentRulesView> = {};

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

async function loadAgentRules(agentId: string, channelId: string | null): Promise<void> {
  const rules = await readAgentRules(fetch, agentId, channelId);
  currentAgentRules = { ...currentAgentRules, [agentId]: rules };
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
  patch: { system_prompt: string },
): Promise<void> {
  await saveAgentConfig(fetch, agentId, patch);
  await refreshWorkspace();
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

function render(saveFailed = false): void {
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
        agentRules={currentAgentRules}
        onAgentRulesNeeded={(agentId, channelId) => {
          void loadAgentRules(agentId, channelId)
            .then(() => render())
            .catch((error: unknown) => {
              console.error('Agent rules read failed', error);
            });
        }}
        saveFailed={saveFailed}
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
        onSaveAgent={saveAgentAction}
        onChannelConfigChange={channelConfigAction}
        onCreateSop={createSopAction}
        onStartSop={startSopAction}
        onDeleteAgent={deleteAgentAction}
        onSettingsChange={(patch) => {
          // 后端是正本：先读返回值，再重渲染。
          writeSettings(patch)
            .then((saved) => {
              currentSettings = saved;
              if (currentWorkspace !== null) {
                currentWorkspace = { ...currentWorkspace, settings: saved };
              }
              render();
            })
            .catch(() => render(true));
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
 * Re-read the one workspace reading (D1.9): SSE frames carry facts, not the
 * reading itself, so unread / task / status changes re-fetch the snapshot
 * instead of growing a local count.
 */
async function refreshWorkspace(): Promise<void> {
  const generation = ++refreshGeneration;
  const response = await fetch('/api/workspace');
  if (!response.ok) {
    throw new Error(`GET /api/workspace failed with ${response.status}`);
  }
  const reading = (await response.json()) as WorkspaceView;
  if (generation !== refreshGeneration) {
    return;
  }

  currentWorkspace = reading;
  currentSettings = reading.settings;
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

window.addEventListener('resize', () => {
  currentViewportWidth = window.innerWidth;
  render();
});

refreshWorkspace().catch(() => {
  // 后端不可达时壳仍显示可读文案；它说明读数没读到，而不是静默空白。
  console.error(t(DEFAULT_SETTINGS.locale, 'settings.error.load'));
  render(true);
});
