# 0003 一个 target = 一个 thread + 一个编排 agent

## Status

accepted（2026-11-03）

## Context

一个 target（channel / dm / task）内可以有多个成员。旧仓的成员面适配接缝按「一个成员的一轮」建模，每个成员各自跑一轮；如果直接映射到 CopilotKit，最自然的读法是「一个成员一个 agentId」。用户已定夺 D3：一个 target = 一个 CopilotKit thread + 一个编排 agent；该 target 内全部成员的唤醒、回应判断、预算与轮次由后端编排驱动；每个成员的回复作为带成员元数据的 assistant 消息流式推送；不得改成「一个成员一个 agentId」。这是一个关于 thread 身份、消息作者表达与流式协议的架构决定，回退成本高，也会让未来的维护者问「为什么不是每个成员一个 agent」。

## Decision

1. **thread 身份**：`threadId = target_id`。一个 target 恰好一个 thread；前端 `CopilotChat` 的 `agentId` 固定为 `allibot`，`threadId` 传当前 target_id。运行时只注册一个编排 agent；它以 threadId 为键为每个 target 持有一份编排上下文。依据：<https://docs.copilotkit.ai/a2a/threads-lifecycle>。
2. **编排单位**：`run(input)` 收到 threadId 后解析 target，按该 target 的成员表、唤醒信号、回应判断、人类世代与回应预算驱动一轮或多轮成员处理。多个成员的回复在同一个 run 内按顺序流式推送，每个成员一组 `TEXT_MESSAGE_START / CONTENT / END`；不按成员拆 thread，也不按成员拆 agentId。
3. **成员元数据**：每条 assistant 消息的 `messageId` 就是 SQLite `message.id`；消息行在写入时快照 `member_id`、`display_name`、`avatar_slot`。run 开始时编排发一个 AG-UI `STATE_SNAPSHOT`，携带本 target 的成员元数据映射；前端自定义消息渲染器按 messageId / 快照显示头像与名字。事件类型依据：<https://docs.copilotkit.ai/a2a/troubleshooting/event-inspector>；渲染槽依据：<https://docs.copilotkit.ai/reference/components/CopilotChatMessageView>。
4. **两条调用路径共用同一个深模块**：
   - live 路径：owner 通过 `CopilotChat` 发消息，CopilotKit handler 调用编排 agent 的 `run`，该 run 内完成本 target 的成员唤醒与回复流。
   - 后端驱动路径：认领、自动续跑、无 live 连接时由后端唤醒编排触发的轮次，同样调用同一个编排模块；结果落库后通过全局 SSE 发布消息行，前端用 `useAgent().agent.addMessage(...)` 追加，或用快照重新水合。
   - 两条路径共享同一套唤醒、回应判断、预算与轮次结果，不存在两套编排逻辑。
5. **历史回放**：SQLite 消息表是唯一正本。前端切换 target 时用 `useAgent().agent.setMessages(...)` 从后端消息读取并水合；CopilotKit 的 runner 保持进程内默认，不承担业务持久化，也不引入第二个 thread 库。依据：<https://docs.copilotkit.ai/a2a/threads-lifecycle> 的 Manual hydration。
6. **禁止的形状**：不为每个成员注册 agentId；不把成员回复拆成多个 thread；不让前端按成员自判「这条消息是谁说的」——作者元数据由后端消息行给出。

## Consequences

- 前端只有一个对话流，但每条 assistant 消息可以有不同的头像与显示名；这比「多 thread 并排」更接近 group chat 的读法。
- 同一个 run 内多成员顺序执行；一个成员的回复可能触发下一个成员的唤醒，预算与人类世代在同一 target 内裁决。
- 后端驱动轮次没有 live run 时不能逐 token 流式到前端，只能落库后由 SSE 追加；这是「事件是观察面，不是正本」的代价，也是保证无浏览器连接时协作仍能推进的必要条件。
- CopilotKit 的 `threadId` 历史回放能力依赖 runner；本仓主动选择手动水合，避免 runner 的存储成为第二正本。实现票需要验证 `setMessages` 与流式追加不会重复渲染同一条消息。
- 未来若引入 team 模式，队长收口仍发生在这个 thread 与这个编排 agent 内，不改变「一个 target 一个 thread」的形状。

## Old ADR Correspondence

- 对应旧仓 ADR-0010（成员面适配接缝）：保留「一轮的输出是零或多条待落库回复 + 一个轮次结果」，但输出载体改为同一 thread 内的多条 assistant 消息。
- 对应旧仓 ADR-0019 / ADR-0022（team 模式收窄为队长）：本仓把「一个 target 一个编排者」的思想保留下来，但 team 模式本身在 M1 不实现；未来实现时仍走本 ADR 的 thread/agent 形状。
- 替代「一个成员一个 agentId」的潜在读法；不复制旧仓 ADR-0010 / ADR-0019 / ADR-0022 的编号。
