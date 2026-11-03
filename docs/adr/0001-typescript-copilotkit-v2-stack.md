# 0001 TypeScript 全栈与 CopilotKit v2 运行时

## Status

accepted（2026-11-03）

## Context

GLOSSARY.md 描述的是一个 Python + AgentScope 实现的协作工作台：成员面适配接缝在进程内调用 AgentScope，流式出口把 AgentScope 事件透传给 SSE，迁移与 MCP 命令也以 Python 模块形式出现。本仓是零源码的新仓，用户已定夺 D1：前端 React + CopilotKit v2，后端 Node + CopilotRuntime v2，AG-UI 事件协议，自写 `AbstractAgent` 承载领域编排，不使用 LangGraph。这个决定同时影响语言、运行时协议、流式形状与测试替身，属于难以回退的架构选择。

## Decision

1. **单一 TypeScript 代码库**：前端、后端、共享类型与数据库访问全部用 TypeScript。不保留 Python 运行时，不引入双语言进程边界。旧仓以 `python -m allibot` 形式出现的迁移与导出命令，在本仓改为 Node CLI 子命令。
2. **前端**：React + `@copilotkit/react-core/v2`。主区恒为 `CopilotChat`，左/右侧栏用 `CopilotSidebar`，消息渲染通过 `messageView.assistantMessage` 槽替换。Provider 用 `CopilotKitProvider`，`runtimeUrl` 指向后端 CopilotKit handler，`useSingleEndpoint` 与 handler 形态匹配（多路由 handler 配 `false`）。依据：<https://docs.copilotkit.ai/a2a/intelligence/quickstart>、<https://docs.copilotkit.ai/reference/components/CopilotSidebar>、<https://docs.copilotkit.ai/reference/components/CopilotChatMessageView>。
3. **后端**：Node + `@copilotkit/runtime/v2`。`CopilotRuntime` 的 `agents` 映射接受 AG-UI `AbstractAgent` 实例；handler 用 `createCopilotRuntimeHandler` 挂多路由（GET / POST / PATCH / DELETE），与前端 `useSingleEndpoint={false}` 对齐。依据：<https://docs.copilotkit.ai/a2a/backend/copilot-runtime>、<https://docs.copilotkit.ai/a2a/runtime-server-adapter>。
4. **自写 AG-UI agent**：编排 agent 继承 `AbstractAgent`（`@ag-ui/client`），实现 `run(input: RunAgentInput): Observable<BaseEvent>`；按 `RUN_STARTED →（STATE_SNAPSHOT）→ TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT / TEXT_MESSAGE_END（每个成员回复一组）→ RUN_FINISHED` 发事件，错误用 `RUN_ERROR` 收口。不使用 LangGraph，也不为每个成员注册一个 agentId。依据：<https://docs.copilotkit.ai/a2a/backend/custom-ag-ui-agent>、<https://docs.copilotkit.ai/a2a/troubleshooting/event-inspector>。
5. **模型 provider**：首个里程碑只接 Anthropic 与 OpenAI 兼容两类 provider，`provider:model` 标识解析出 provider 与 model；缺凭证读环境变量；库内不存模型密钥；自动化测试注入脚本化替身，不联网、零成本。provider 适配器是编排 agent 的内部依赖，不构成第二个对外 seam。
6. **事件是观察面，不是正本**：AG-UI 事件用于流式呈现与诊断；消息、轮次结果、预算、任务与成员状态仍以 SQLite 为唯一正本。后端驱动的轮次（认领、续跑、无 live 连接时的成员回应）照常落库，并通过全局 SSE 通知前端；前端用 `useAgent().agent.addMessage(...)` 追加已落库消息（依据：<https://docs.copilotkit.ai/a2a/threads-lifecycle> 的 Manual hydration）。

## Consequences

- 一种语言、一套类型、一个运行时协议；前端与后端可以共享消息、成员、任务与错误类型。
- 旧仓的 AgentScope 生态、Python 脚本、MCP 导出命令与测试替身不能直接复用；迁移到 AG-UI 事件形状需要重写成员面适配层。
- CopilotKit v2 仍在演进，`run` 事件形状、`CopilotChat` 槽位与 provider 配置需要在实现票里锁定版本，并用契约测试盯住。
- 编排不再受图框架约束，但多成员唤醒、预算与轮次的顺序完全由本仓负责；这既是自由度，也是必须自己测试的复杂度。
- 测试的主 seam 变成后端 HTTP 面（人类面 REST + CopilotKit handler + SSE），模型 provider 在 seam 之下用脚本化替身注入。

## Old ADR Correspondence

- 对应旧仓 ADR-0010（成员面适配接缝的输出形状）与 ADR-0020（流式出口）：本 ADR 把接缝的实现从 AgentScope 换成 AG-UI `AbstractAgent`，保留「一轮输出零或多条待落库回复 + 一个轮次结果」的结论形状。
- 替代旧仓以 Python + AgentScope 为实现前提的隐含决策（GLOSSARY 未给该前提编号）；旧仓 ADR-0010 / ADR-0020 的编号不复制到本仓。
- 不涉及旧仓 ADR-0001（消息 append-only）、ADR-0007（人类面不得写用量事实）；那两条在本仓继续有效，见 ADR-0004。
