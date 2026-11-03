/**
 * CopilotKit 接线契约的前端一侧：provider 指向后端的多路由 handler，
 * 对话固定走一个编排 agent，thread 身份就是 target id（本仓 ADR 0003）。
 */

import type { Message } from '@copilotkit/react-core/v2';

/** 后端 CopilotKit 多路由 handler 的 base path（`createCopilotRuntimeHandler` 的 basePath）。 */
export const AGUI_BASE_PATH = '/api/copilotkit';

/** provider 的 runtimeUrl：多路由 handler 挂载的位置。 */
export const AGUI_RUNTIME_URL = AGUI_BASE_PATH;

/**
 * 唯一的编排 agentId。成员不是 agentId：同一 target 内的成员回复是同一 thread 内
 * 的 assistant 消息作者，由消息行的成员元数据表达。
 */
export const ALLIBOT_AGENT_ID = 'allibot';

/** 多路由 handler 配 `useSingleEndpoint={false}`（单路由信封只在 `mode: "single-route"` 下成立）。 */
export const AGUI_USE_SINGLE_ENDPOINT = false;

/**
 * 历史水合与流式追加共用同一个去重口径：同一 messageId 只保留一条消息。
 * `useAgent().agent.setMessages(...)` 水合已落库消息，`addMessage` / AG-UI 流追加
 * 同一 messageId 时不新增第二条渲染行。
 */
export function mergeMessagesById(
  hydrated: readonly Message[],
  appended: readonly Message[],
): Message[] {
  const merged = new Map<string, Message>();
  for (const message of [...hydrated, ...appended]) {
    merged.set(message.id, message);
  }
  return [...merged.values()];
}
