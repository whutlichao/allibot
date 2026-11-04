import type {
  AgentMcpView,
  AgentProvider,
  AgentSkillCandidatesView,
  AgentSkillDetailView,
  AgentSkillsView,
  AgentView,
  ApprovalDecisionInput,
  ApprovalView,
  ChannelConfigPatch,
  ChannelView,
  PermissionMode,
  PermissionRuleInput,
  PermissionRuleView,
  RemoteConsentView,
  RemoteDataFlowReadView,
  SopDefinitionCreate,
  SopDefinitionView,
  SkillImportAllView,
  SkillInstallView,
  SkillView,
  SopRunView,
  TargetMemberView,
  WorkspaceBackend,
} from '@allibot/shared';
import type { PermissionScope } from './workspace/permissions.ts';

/**
 * 工作台的人类面写路径与按需读数。它们只被显式动作调用（加入频道、
 * 保存系统提示、软删除 Agent、读取频道成员表），打开抽屉或切换页签不会
 * 经过这里；与 #29 壳的「打开不写」纪律一致。
 *
 * `fetchImpl` 由调用方注入，组件契约测试据此在系统边界上替身，不 mock
 * 内部模块。
 */

async function readJson<T>(response: Response, what: string): Promise<T> {
  if (!response.ok) {
    throw new Error(`${what} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export async function readChannelMembers(
  fetchImpl: typeof fetch,
  channelId: string,
): Promise<TargetMemberView[]> {
  const response = await fetchImpl(`/api/channels/${encodeURIComponent(channelId)}/members`);
  const body = await readJson<{ members?: TargetMemberView[] }>(
    response,
    `GET channel ${channelId} members`,
  );
  return body.members ?? [];
}

/**
 * `GET /api/targets/{id}/members` serves every target kind; the mention
 * completion reads the selected target's Agent members through it.
 */
export async function readTargetMembers(
  fetchImpl: typeof fetch,
  targetId: string,
): Promise<TargetMemberView[]> {
  const response = await fetchImpl(`/api/targets/${encodeURIComponent(targetId)}/members`);
  const body = await readJson<{ members?: TargetMemberView[] }>(
    response,
    `GET target ${targetId} members`,
  );
  return body.members ?? [];
}

/** `GET /api/remote-data-flow`: provider credential variable names and consent. */
export async function readRemoteDataFlow(
  fetchImpl: typeof fetch,
): Promise<RemoteDataFlowReadView> {
  const response = await fetchImpl('/api/remote-data-flow');
  return readJson<RemoteDataFlowReadView>(response, 'GET remote data flow');
}

/** `POST /api/remote-data-flow/{provider}/consent`: one-time consent row. */
export async function confirmProviderDataFlow(
  fetchImpl: typeof fetch,
  provider: AgentProvider,
): Promise<RemoteConsentView> {
  const response = await fetchImpl(
    `/api/remote-data-flow/${encodeURIComponent(provider)}/consent`,
    { method: 'POST' },
  );
  return readJson<RemoteConsentView>(response, `POST ${provider} consent`);
}

/** 加入频道：后端返回 `{joined}`；重复加入返回 `joined: false`，不抛错。 */
export async function joinChannelMember(
  fetchImpl: typeof fetch,
  channelId: string,
  memberId: string,
): Promise<{ joined: boolean }> {
  const response = await fetchImpl(`/api/channels/${encodeURIComponent(channelId)}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ member_id: memberId }),
  });
  const body = await readJson<{ joined?: unknown }>(
    response,
    `POST channel ${channelId} members`,
  );
  if (typeof body.joined !== 'boolean') {
    throw new Error('POST channel members returned no joined fact');
  }
  return { joined: body.joined };
}

export async function saveAgentConfig(
  fetchImpl: typeof fetch,
  agentId: string,
  patch: {
    system_prompt?: string;
    permission_mode?: PermissionMode | null;
    workspace_backend?: WorkspaceBackend | null;
  },
): Promise<AgentView> {
  const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return readJson<AgentView>(response, `PATCH agent ${agentId}`);
}

/** `GET /api/agents/{id}/mcp` (#47): the same file runtime assembly reads. */
export async function readAgentMcp(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<AgentMcpView> {
  const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/mcp`);
  return readJson<AgentMcpView>(response, `GET agent ${agentId} mcp`);
}

/** The one management write: exactly one of `entries` / `raw` in the body. */
export async function saveAgentMcp(
  fetchImpl: typeof fetch,
  agentId: string,
  body: { entries: import('@allibot/shared').McpServerEntry[] } | { raw: string },
): Promise<AgentMcpView> {
  const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}/mcp`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return readJson<AgentMcpView>(response, `PUT agent ${agentId} mcp`);
}

// ---------------------------------------------------------------------------
// Skill 管理面 (#48 / D2.3 / D6.3): the host's reads and writes. The skills
// panel only renders; these functions are called by main.tsx on an explicit
// action. Every name is URL-encoded because it is part of the path.
// ---------------------------------------------------------------------------

function skillUrl(agentId: string, name?: string): string {
  const base = `/api/agents/${encodeURIComponent(agentId)}/skills`;
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`;
}

export async function readAgentSkills(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<AgentSkillsView> {
  const response = await fetchImpl(skillUrl(agentId));
  return readJson<AgentSkillsView>(response, `GET agent ${agentId} skills`);
}

export async function readAgentSkill(
  fetchImpl: typeof fetch,
  agentId: string,
  name: string,
): Promise<AgentSkillDetailView> {
  const response = await fetchImpl(skillUrl(agentId, name));
  return readJson<AgentSkillDetailView>(response, `GET agent ${agentId} skill ${name}`);
}

export async function readSkillCandidates(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<AgentSkillCandidatesView> {
  const response = await fetchImpl(
    `/api/agents/${encodeURIComponent(agentId)}/skill-candidates`,
  );
  return readJson<AgentSkillCandidatesView>(response, `GET agent ${agentId} skill candidates`);
}

/** Install one `~/.agents/skills/<name>/` candidate through the single-entry path. */
export async function installAgentSkill(
  fetchImpl: typeof fetch,
  agentId: string,
  name: string,
): Promise<SkillInstallView> {
  const response = await fetchImpl(skillUrl(agentId), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ source: 'agents-skills', name }),
  });
  return readJson<SkillInstallView>(response, `POST agent ${agentId} skill ${name}`);
}

export async function importAllAgentSkills(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<SkillImportAllView> {
  const response = await fetchImpl(`${skillUrl(agentId)}/import-all`, { method: 'POST' });
  return readJson<SkillImportAllView>(response, `POST agent ${agentId} skills import-all`);
}

export async function setAgentSkillEnabled(
  fetchImpl: typeof fetch,
  agentId: string,
  name: string,
  enabled: boolean,
): Promise<SkillView> {
  const response = await fetchImpl(skillUrl(agentId, name), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  const body = await readJson<{ skill: SkillView }>(response, `PATCH agent ${agentId} skill ${name}`);
  return body.skill;
}

export async function deleteAgentSkill(
  fetchImpl: typeof fetch,
  agentId: string,
  name: string,
): Promise<void> {
  const response = await fetchImpl(skillUrl(agentId, name), { method: 'DELETE' });
  if (!response.ok) {
    throw new Error(`DELETE agent ${agentId} skill ${name} failed with ${response.status}`);
  }
}

export async function deleteAgent(
  fetchImpl: typeof fetch,
  agentId: string,
): Promise<void> {
  const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    throw new Error(`DELETE agent ${agentId} failed with ${response.status}`);
  }
}

/**
 * The channel configuration write (mode / leader). Both controls send the same
 * shape to the same endpoint: the backend decides validity, archival and
 * leader-change propagation.
 */
export async function patchChannelConfig(
  fetchImpl: typeof fetch,
  channelId: string,
  patch: ChannelConfigPatch,
): Promise<ChannelView> {
  const response = await fetchImpl(`/api/channels/${encodeURIComponent(channelId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return readJson<ChannelView>(response, `PATCH channel ${channelId}`);
}

/**
 * The owner-only SOP writes (#41 / D4.2): one definition create and one start.
 * They live with the other human-face writes, not in the render-only workspace
 * modules; opening the SOP panel never POSTs anything.
 */
export async function createSopDefinition(
  fetchImpl: typeof fetch,
  input: SopDefinitionCreate,
): Promise<SopDefinitionView> {
  const response = await fetchImpl('/api/sops', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson<SopDefinitionView>(response, 'POST /api/sops');
}

/** `POST /api/sops/{id}/runs` answers 202 with the pending run. */
export async function startSopRun(
  fetchImpl: typeof fetch,
  definitionId: string,
): Promise<SopRunView> {
  const response = await fetchImpl(`/api/sops/${encodeURIComponent(definitionId)}/runs`, {
    method: 'POST',
  });
  return readJson<SopRunView>(response, `POST SOP ${definitionId} start`);
}

// ---------------------------------------------------------------------------
// 权限规则与审批 (#44): the host's write paths. The workspace/ panels stay
// presentation-only; these functions are called by main.tsx on an explicit
// action, never by opening a drawer.
// ---------------------------------------------------------------------------

function permissionRulesUrl(scope: PermissionScope): string {
  const base = scope.kind === 'channel' ? '/api/channels' : '/api/agents';
  return `${base}/${encodeURIComponent(scope.id)}/permission-rules`;
}

export async function readPermissionRules(
  fetchImpl: typeof fetch,
  scope: PermissionScope,
): Promise<PermissionRuleView[]> {
  const response = await fetchImpl(permissionRulesUrl(scope));
  const body = await readJson<{ rules?: PermissionRuleView[] }>(
    response,
    `GET ${scope.kind} permission rules`,
  );
  return body.rules ?? [];
}

export async function savePermissionRules(
  fetchImpl: typeof fetch,
  scope: PermissionScope,
  rules: readonly PermissionRuleInput[],
): Promise<PermissionRuleView[]> {
  const response = await fetchImpl(permissionRulesUrl(scope), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(rules),
  });
  const body = await readJson<{ rules?: PermissionRuleView[] }>(
    response,
    `PUT ${scope.kind} permission rules`,
  );
  return body.rules ?? [];
}

export async function readApprovals(
  fetchImpl: typeof fetch,
  status: 'pending' | 'all' = 'all',
): Promise<ApprovalView[]> {
  const response = await fetchImpl(`/api/approvals?status=${status}`);
  const body = await readJson<{ approvals?: ApprovalView[] }>(response, 'GET approvals');
  return body.approvals ?? [];
}

export async function readApproval(
  fetchImpl: typeof fetch,
  replyId: string,
): Promise<ApprovalView> {
  const response = await fetchImpl(`/api/approvals/${encodeURIComponent(replyId)}`);
  return readJson<ApprovalView>(response, `GET approval ${replyId}`);
}

export async function submitApprovalDecision(
  fetchImpl: typeof fetch,
  replyId: string,
  input: ApprovalDecisionInput,
): Promise<ApprovalView> {
  const response = await fetchImpl(`/api/approvals/${encodeURIComponent(replyId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
  });
  return readJson<ApprovalView>(response, `POST approval ${replyId}`);
}
