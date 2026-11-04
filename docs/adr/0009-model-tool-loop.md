# 0009 真实模型 provider 的轮内工具循环

## Status

accepted（2026-11-04）

## Context

M2 把 team / Plan / SOP / 审批 / 工作区 / MCP / Skill 的 HTTP 面与状态机交付了，但真实模型 adapter 仍是 M1 的单轮文本补全：一次 chat completion，不传工具定义，不读 `tool_use` / `tool_calls`。这些能力因此只有脚本化 provider 能驱动，M2 把这条限制写进了部署说明（A1），由 #51 承接。

补齐循环时有四件事会被实现票各自决定一次，而它们**回退成本高**、且未来读者一定会问"为什么这样"：

1. **循环放在哪里**：适配器内部一轮跑完，还是把轮次拆成多段、由写路径驱动（deferred / 断点重开）。这决定 HTTP 请求的阻塞时间、SSE 的收口语义、以及"一轮"这个词的含义。
2. **审批等待在循环里怎么表现**：阻塞到人类决定，还是把轮次暂停落成 awaiting。前者占着一个请求等最多 600 秒（×批次），后者引入跨请求的轮内状态。
3. **工具名是谁的契约**：工具名同时出现在模型可见的 tool 列表、`permission_rule.tool_name` 与审批载荷里。改名不是重构，是改产品 API。
4. **`max_iterations` 属于谁**：它是 `agent_config` 的既有字段、人类面可编辑、词条 `round.finished.iterationLimit` 已有文案，但 `rounds.ts` 里出现 0 次——没有任何循环执行它。它究竟是"轮次级"计数还是"轮内往返"上限，必须一次说清。

`sopVerdict` 的通道（专用工具 vs 结构化输出 vs 解析散文）同样是一次真实权衡，但它是**后续批次**的实现细节，与本 ADR 的边界无关，写进规格的 D11 即可。

## Decision

1. **循环在适配器内部，接缝不变。** `RoundProvider.runRound(input) → RoundResult` 仍是一轮一次调用；循环在这一次调用里完成 model → tool → model 的往返，`deferred` 保持 `false`。写路径、SSE 收口、"一轮 ↔ 至多一条 target 消息"的纪律全部不动。选择理由：接缝是 M1 唯一的成员面契约，把循环摊到写路径上会引入跨请求的轮内状态，而那个状态没有正本表可放（本 ADR 不同时开迁移）。
2. **审批在循环内阻塞等待，超时不回灌。** 需要审批的调用走既有 `RoundPermissionFace.authorize`：批准即继续，`denied` 作为工具结果回灌（拒绝不是轮次失败）。等满 600 秒批次后 `authorize` 抛 `ApprovalTimeoutError`，本轮按 ADR-0007 决定 6 收口 `failed`——**不**把超时变成一个工具结果，否则无人值守的轮次会一直续跑到上限。不做"暂停轮次、决定后重开"：那要求把"半轮"落成可恢复状态，而 M2 的审批已经是"进程重启即 expired、不跨重启恢复"，两者叠加会产生第三种半完成态。
3. **工具名是对外契约。** 沿用既有词汇，不另起体系：`Read` / `Glob` / `Grep` / `Write` / `Edit` / `Bash` / `TeamAssign` / `transfer_task` / `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate` / `mcp:<server>/<tool>`。同一个名字同时是模型可见的工具名、`permission_rule.tool_name` 的匹配键与审批载荷里的工具名；改名等于同时改三处，且会让已配置的规则静默失效。新增工具名要同时给出 `classifyToolName` 的类别。
4. **`max_iterations` 是轮内往返上限。** 语义定为"一次轮次内 model↔tool 往返的次数上限"，默认 10。撞上限收口为 `replied` + `finishedReason: 'iteration-limit'`：把已经产出的部分结论落成消息，`finished_reason` 读既有词条「达到迭代上限」，与脚本化 `iteration-limit` 逐字一致。唯一的例外是撞上限时还没有任何产出文本：那按既有 `empty completion` 规则收口 `failed`，不伪造一条空消息。不选"failed + 零回复"的理由是游标：`advancesCursor` 只认 `replied` / `ignored`，`failed` 不推进游标，同一条触发消息会留在未读，下一次唤醒会把同一段上下文再跑一遍昂贵循环。不新增"轮次级"计数：M1 的世代与 `target_budget` 已经是轮次的界，再叠一个同义的计数器只会制造两套账。
5. **只落最终文本。** 工具调用之间的中间文本不落库；循环正常结束后那段文本是本轮唯一的 pending reply，为空则按既有 `empty completion` 规则失败。**撞上限是唯一例外**：停下时最后那段 assistant 文本（连同已无预算执行的工具调用）作为部分结论落库——否则「撞上限」按定义只剩中间文本，与第 4 条「落部分结论」无法同时成立。这条与第 1 条配套：既然循环不可见（本批不发 AG-UI 工具事件），中间文本就没有落点。

## Consequences

- 一轮可能占用一个 HTTP 请求长达 10 次往返 × 单次 60 秒超时，且需要审批时还会叠加 600 秒批次等待。这是接受的代价：本批不出 deferred，用户在界面上看到的是"这一轮还在跑"。如果这被证明不可接受，改 deferred 是**重开本 ADR** 的改动，不是实现细节。
- 工具名一旦发布就是产品契约。后续想改（例如把 `Read` 改成 `read_file`）要按"改对外 API"处理：兼容期、文档、规则迁移，而不是一次重命名。
- 撞上限仍是一条**已答复**的轮次（`replied`），带 `iteration-limit` 这个 finished reason。这意味着"达到上限"不会被当成错误状态告警，而是"模型停在这里"的事实；把它读成 `failed` 会同时破坏游标推进与既有测试的断言。
- `max_iterations` 从此有真实执行点。脚本化路径不跑循环，因此行为不变；真实模型路径从此受这个数字约束。原本「配置在、文案在、无人在执行」的半成品形状被补上（M1 规格 D1.6 对表的同类纪律，这里是「配置在、文案在、行为缺位」）。
- 审批阻塞意味着一个跑偏的模型可以在一次往返里触发审批并占用 600 秒。因为超时直接收口 `failed`，总等待不会累积成 10 × 600 秒；代价是一个无人值守的轮次可能白等 600 秒才失败。缓解手段（限制一轮内的审批批次数）留给写类 / 执行类那批。注意只读工具**也**会被 `permission_rule(…, ask)` 触达审批（`checkPermission` 的 `rule-ask` 分支先于模式默认，`Read` 在文件工具内部就调 `authorize`），所以这个 600 秒占用不是写类 / 执行类独有的问题。
- 本 ADR 不做 schema 变更：工具调用不入库，没有新表、没有新列。要审计"模型调了什么工具"是另一张票，届时需要新的正本与新的 ADR。

## Old ADR Correspondence

- 与 ADR-0003（一个 target 一条 thread、一个编排 agent）不冲突：循环仍在成员轮次内部，不新增 thread、不新增 agentId。
- 与 ADR-0007（唯一工具闸门）互补而非覆盖：本 ADR 只说"审批在循环里阻塞等待、超时仍收口 failed"，判定顺序、三档、规则合并、600 秒批次语义全部仍以 0007 为准。0007 决定 6 的"超时收口 failed"在这里被**沿用**，不是被修订。
- 与 ADR-0004（迁移闸门）无关：本 ADR 无 schema 步骤。
