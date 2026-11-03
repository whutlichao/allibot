import type { AgentView, TargetMemberView } from '@allibot/shared';

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
  patch: { system_prompt: string },
): Promise<AgentView> {
  const response = await fetchImpl(`/api/agents/${encodeURIComponent(agentId)}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  return readJson<AgentView>(response, `PATCH agent ${agentId}`);
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
