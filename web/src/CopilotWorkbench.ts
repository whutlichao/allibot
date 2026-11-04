import type { Locale } from '@allibot/shared';
import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import { createElement } from 'react';
import {
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
  ALLIBOT_AGENT_ID,
} from './copilotkit-contract.ts';
import { workspaceChatLabels } from './workspace/chat-labels.ts';

export interface CopilotWorkbenchProps {
  /** 当前 target 的 id；thread 身份就是它（本仓 ADR 0003）。 */
  targetId: string;
  /** 界面语言；占位符与页脚从同一份 workspace 词条取。 */
  locale?: Locale;
}

/**
 * CopilotKit 接线的落点：provider 指向后端多路由 handler（配
 * `useSingleEndpoint={false}`），主区恒为 `CopilotChat`，`agentId` 固定
 * `allibot`、`threadId` 传当前 target_id。target 导航、侧栏与抽屉由工作台壳
 * 票（#29）围绕它搭建；本票只固定这几个接线取值。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级契约测试需要直接 import 本文件。
 */
export function CopilotWorkbench({ targetId, locale = 'zh-CN' }: CopilotWorkbenchProps) {
  return createElement(CopilotKitProvider, {
    runtimeUrl: AGUI_RUNTIME_URL,
    useSingleEndpoint: AGUI_USE_SINGLE_ENDPOINT,
    children: createElement(CopilotChat, {
      agentId: ALLIBOT_AGENT_ID,
      threadId: targetId,
      labels: workspaceChatLabels(locale),
    }),
  });
}
