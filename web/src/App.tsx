import { CopilotChat, CopilotKitProvider } from '@copilotkit/react-core/v2';
import {
  AGUI_RUNTIME_URL,
  AGUI_USE_SINGLE_ENDPOINT,
  ALLIBOT_AGENT_ID,
} from './copilotkit-contract';

export interface AppProps {
  /** 当前 target 的 id；thread 身份就是它（本仓 ADR 0003）。 */
  targetId?: string;
}

/**
 * CopilotKit 接线的最小壳：provider 指向后端多路由 handler，主区是
 * `CopilotChat`。target 导航与侧栏由工作台壳票（#29）补齐；本票只保证
 * `agentId` 固定 `allibot`、`threadId` 是当前 target_id。
 */
export function App({ targetId }: AppProps = {}) {
  return (
    <CopilotKitProvider
      runtimeUrl={AGUI_RUNTIME_URL}
      useSingleEndpoint={AGUI_USE_SINGLE_ENDPOINT}
    >
      <main className="app-shell">
        {targetId === undefined ? null : (
          <CopilotChat agentId={ALLIBOT_AGENT_ID} threadId={targetId} />
        )}
      </main>
    </CopilotKitProvider>
  );
}
