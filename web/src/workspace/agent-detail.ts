import type { AgentView } from '@allibot/shared';

/**
 * Agent 详情页签（Agent Detail Tab）的呈现状态。
 *
 * 三个页签是同一详情面的三个分组，不是三条路由：这里没有 URL、没有
 * 请求，也没有第二份 Agent 读数。当前页签与未提交的草稿都是呈现层状态，
 * 不落库；切换页签只移动选中项，草稿随状态一起保留。
 */

/** 固定顺序：基础信息和配置 → skills → mcp（R1 词条 75）。 */
export const AGENT_DETAIL_TABS = ['basic', 'skills', 'mcp'] as const;
export type AgentDetailTab = (typeof AGENT_DETAIL_TABS)[number];

/** 基础信息页签的四个区块；危险操作恒为最后一块。 */
export const AGENT_BASIC_SECTIONS = ['stats', 'system-prompt', 'config', 'danger'] as const;
export type AgentBasicSection = (typeof AGENT_BASIC_SECTIONS)[number];

/**
 * 未提交的草稿。M1 只编辑系统提示；其余配置项是读数，不在这张票里做
 * 第二个写路径（PATCH 的人类面已由 #7 提供）。
 */
export interface AgentDetailDraft {
  systemPrompt: string;
}

export interface AgentDetailState {
  tab: AgentDetailTab;
  draft: AgentDetailDraft;
}

export function initialAgentDetailState(
  agent: AgentView,
  tab: AgentDetailTab = 'basic',
  draft: Partial<AgentDetailDraft> = {},
): AgentDetailState {
  return {
    tab,
    draft: { systemPrompt: draft.systemPrompt ?? agent.system_prompt },
  };
}

/** 换页签只换选中项；草稿原样保留。 */
export function switchAgentDetailTab(
  state: AgentDetailState,
  tab: AgentDetailTab,
): AgentDetailState {
  return { ...state, tab };
}

export function editSystemPrompt(state: AgentDetailState, systemPrompt: string): AgentDetailState {
  return { ...state, draft: { ...state.draft, systemPrompt } };
}

export function hasUnsavedSystemPrompt(state: AgentDetailState, agent: AgentView): boolean {
  return state.draft.systemPrompt !== agent.system_prompt;
}
