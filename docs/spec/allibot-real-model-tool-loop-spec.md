> 本规格把 issue #51 的六条缺口转写成可实施、可验收的决策集合：真实模型 provider 的 **轮内工具循环**。章节沿用 M1 / M2 规格的七章节模板；术语沿用 `GLOSSARY.md` 的中英并列写法，`Avoid` 列是约束。基线是 `main` 的 `eb8b07c`（PR #55 合并提交）：`SCHEMA_VERSION = 21`、`GLOSSARY.md` 826 行、ADR 0001–0008、M2 集成已交付并已由真机跑修过 F1–F5。本规格**不新增 schema 步骤**，`SCHEMA_VERSION` 保持 21；工具循环是轮内行为，没有新的正本表。

## Problem Statement

M2 交付了 team / Plan / SOP / 审批 / 工作区 / MCP / Skill 的 HTTP 面与状态机，但它们全部只能被**脚本化 provider** 驱动。真实模型 adapter 仍是 M1 的单轮文本补全：`server/src/model-provider.ts` 只发一次 system + user 的 chat completion，不传工具定义，也不读 `tool_use` / `tool_calls`。于是换到真实 provider 时，队长不会分派、Plan 四工具不可用、SOP verifier 交不出结构化判定、需要审批的工具调用根本不会被发起。M2 把这写成了已知限制（`docs/deployment.md` 的「真实模型 provider 的已知限制（M2 A1）」），由 #51 承接。

这个缺口有三个具体后果。其一，M2 的验收 seam 只覆盖脚本化 provider，真实模型下"能跑"这件事从未被证明过——真机跑修完的 F1–F5 全是呈现与读模型问题，一条真实模型轮次都还没成功过（三轮全部因 consent / credential 失败）。其二，每次新增工具面（M3 的联网档就是下一批）都会重复同一个洞：工具存在、模型调不动。其三，`agent_config.max_iterations` 与词条 `round.finished.iterationLimit` 已经存在，`server/src/rounds.ts` 也已经按轮次算好了可用工具集，但**没有任何循环去执行它们**——配置与文案先到位、行为缺位的半成品，正是 M1 规格 D1.6 说过的「建了表但没有写路径」在工具面上的同类形状（这里是「配置在、文案在、行为缺位」）。

## Solution

在**适配器内部**实现一个轮内工具循环，接缝形状不变：`RoundProvider.runRound(input) → RoundResult` 仍然是一轮一次调用，循环在这一次调用内完成，`deferred` 保持 `false`。循环只消费 `RoundInput` 已经给到的 face，不打开新 seam、不新建表、不引入第二个正本。

第一批只交付**只读工具**，把两家 provider 的工具调用形状与循环语义一次定型：`Read` / `Glob` / `Grep`（读类，项目根与成员 `skills/` 第二根）与 `TaskList` / `TaskGet`（`internal` 类的只读 Plan 工具）。两个 provider 同批：Anthropic 的 `tools` + `tool_use` 与 OpenAI 兼容的 `tools` + `tool_calls` 在同一份测试里各自断言，形状差异在第一批就摸清，不拖到下一批。

写类（`Write` / `Edit`）、执行类（`Bash` / MCP）、编排类（`TeamAssign` / `transfer_task` / Plan 的写工具）与 SOP 的 `SopVerdict` 通道留给后续批次，但它们在本规格里**先定契约**（尤其是审批在循环里的语义与 `SopVerdict` 的通道），避免下一批重新吵一遍。

循环的边界是三条纪律。其一，**只落最终文本**：工具调用之间的中间文本不落库，只有循环结束（模型不再请求工具）后的那段文本成为本轮的回复，与既有的「一轮 ↔ 至多一条 target 消息」一致。其二，**上限复用 `max_iterations`**（默认 10，人类面已可编辑）：撞上限时本轮以 `replied` 收口，把已经在手的部分结论落成消息，`finished_reason` 读既有词条「达到迭代上限」——与脚本化 `iteration-limit` 逐字一致，消费游标照常推进，同一条消息不会被下一次唤醒重读；唯一例外是撞上限时还没有任何产出文本，那按既有 `empty completion` 规则收口 `failed`。其三，**失败分层**：provider 网络错 / 超时 / 响应不可解析 → 轮次 `failed`；工具自身的失败（路径越界、文件不存在、审批拒绝）→ 作为一个工具结果回灌给模型，由模型改道，绝不当轮次失败。

## User Stories

1. As an owner, I want a real-model round to be able to call tools, so that a model configured with a real provider can actually drive the work M2 already stores.
2. As an owner, I want the tool loop to live behind the existing member-face seam, so that switching between the scripted provider and a real provider never changes the round's outward shape.
3. As an owner, I want the offered tool set to come from the round's existing availability calculation, so that a round with no project root, no Plan face or no shell switch is never handed a tool it cannot call.
4. As an owner, I want only `read` class tools plus the read-only Plan tools in this batch, so that the loop's shape is proven before any write or approval path is wired through it.
5. As an owner, I want `Read`, `Glob` and `Grep` to keep their existing names and reach the same face the scripted double uses, so that a tool name means one thing in the permission gate and in the model's tool list.
6. As an owner, I want the project root and the member's read-only `skills/` second root to stay the only readable roots, so that the model cannot widen the file boundary by asking for a path.
7. As an owner, I want an out-of-root path to come back as a tool error rather than a silent deny, so that the model can correct itself and the round survives.
8. As an owner, I want `TaskList` and `TaskGet` to read only the current Plan run, so that a model cannot read or write another target's plan.
9. As a model, I want tool results fed back in the provider's own result shape, so that Anthropic and OpenAI each get a well-formed conversation rather than one invented common format.
10. As an owner, I want a tool failure to reach the model as a readable result, so that "the file does not exist" is something the model can react to instead of a round-ending error.
11. As an owner, I want provider network errors, timeouts and unparseable responses to close the round as failed with a readable reason, so that infrastructure problems never look like model decisions.
12. As an owner, I want the loop bounded by `max_iterations`, so that the number the Agent detail page already shows is the number that actually bounds the round.
13. As an owner, I want hitting the bound to close the round as replied with the finished reason iteration-limit and the existing copy, so that the scripted and real paths report bounds identically.
14. As an owner, I want a bounded round to land its partial conclusion and be marked iteration-limit, so that I see what the model had reached and the triggering message is consumed rather than re-read on the next wake.
15. As an owner, I want intermediate narration between tool calls to stay out of the target, so that the thread keeps one reply per round.
16. As an owner, I want only the text after the last tool call to become the reply, so that what lands reads as the conclusion rather than the transcript.
17. As an owner, I want an empty final text after tool calls to close the round per the existing empty-completion rule, so that tool activity never substitutes for an answer.
18. As an owner, I want oversized tool results capped at the feed-back layer with an explicit marker, so that one huge result cannot consume the context and the model knows it did not see everything.
19. As an owner, I want the truncation notice to survive into the next model turn, so that the model can narrow its request instead of assuming completeness.
20. As a model, I want each tool call's arguments validated before the face runs, so that a malformed call is a tool result I can fix rather than a crash.
21. As an owner, I want two tool calls in one round to both run, so that a model may read two files before answering.
22. As an owner, I want the round to keep at most one pending reply regardless of how many tool calls it made, so that the write path's single-message discipline is untouched.
23. As an owner, I want the loop to be non-deferred, so that a round settles before the delivery call returns and the existing SSE and write paths need no new state.
24. As an owner, I want no tool-call events on the AG-UI stream in this batch, so that the streaming contract is not widened by a half-visible tool surface.
25. As a maintainer, I want the two provider shapes exercised by one shared test matrix, so that a parsing fix on one side cannot silently diverge from the other.
26. As a maintainer, I want the tool definitions derived from one internal tool specification, so that a new tool is described once and serialized per provider.
27. As a maintainer, I want the approval-wait decision recorded now, so that the next batch does not relitigate it: an `ask` blocks inside the loop, bounded by the existing 600-second batch timeout.
28. As a maintainer, I want the SOP verifier's structured verdict to travel as a dedicated tool in a later batch, so that prose in `replies` never decides a verdict.
29. As a model, I want a capped Grep result to say it was capped, so that I do not read a truncated match list as a complete one.
30. As an owner, I want a model that never calls a tool to behave exactly as it does today, so that this batch is additive for every existing Agent.
31. As an owner, I want the scripted provider path to keep every existing behaviour, so that all M1 / M2 tests pass unchanged.

## Implementation Decisions

**D1 循环的位置与接缝。** 循环实现在真实模型适配器内部（`server/src/model-provider.ts` 一侧），不新增 `RoundProvider` 方法、不改 `RoundInput` / `RoundResult` 的既有字段、不改 HTTP 面。`deferred` 保持 `false`：一轮的循环跑完才返回，写路径与 SSE 收口不动。脚本化 provider 与真实 provider 仍然可互换，M1 的 seam 断言与 M2 的脚本化行为全部不变。

**D2 工具集从既有可用集派生，不新开一份。** `RoundInput.tools` 已经按轮次算出可用工具（`rounds.ts` 的 `readRoundTools` + `mcpToolNames`）。循环取这份集合，按 `classifyToolName` 的类别筛出本批范围的工具：`read` 类（`Read` / `Glob` / `Grep`）与 `internal` 类里明确只读的两项（`TaskList` / `TaskGet`）。筛选**不是**权限判定：`read` 类工具仍由文件工具自己过闸门，`internal` 类按既有裁定不过闸门。第一批不新开"模型可见工具集"这份第二正本。

**D3 一份内部工具规格，两家序列化。** 每个工具用一份内部规格描述（名字、说明、参数结构、结果整形）。序列化到 Anthropic 是 `tools[].input_schema`，到 OpenAI 兼容端点是 `tools[].function.parameters`，两者都由同一份规格生成；新增工具只写一次。工具名沿用既有词汇，不另起命名体系：`Read` / `Glob` / `Grep` / `TaskList` / `TaskGet`，后续批次的 `Write` / `Edit` / `Bash` / `TeamAssign` / `transfer_task` / `TaskCreate` / `TaskUpdate` 同理，MCP 工具保持 `mcp:<server>/<tool>`。工具名是**对外契约**：它同时出现在模型可见的 tool 列表、`permission_rule.tool_name` 与审批载荷里，改名等于同时改三处，因此在 ADR 0009 里单独裁定。

**D4 参数形状照既有 face 的请求类型，不发明新参数。** `Read{path}` 对应 `RoundFileTools.Read`；`Glob{pattern, path?}` 对应 `Glob`；`Grep{pattern, path?}` 对应 `Grep`（正则是 JavaScript 正则源，逐行应用，与既有 face 一致）；`TaskList{}` 与 `TaskGet{id}` 对应 `RoundPlanFace` 的同名方法。模型给的参数在调用 face 之前做一次形状校验：缺字段、类型不符、多余字段都作为工具结果回灌，不进入 face，也不抛轮次错误。

**D5 工具结果整形与回灌。** 工具结果转成 provider 自己的 result 形状：Anthropic 用 `tool_result` 内容块（`is_error` 表达失败），OpenAI 兼容用 `role: "tool"` + `tool_call_id`。回灌内容对模型是**结构化摘要 + 必要正文**，不是原始 JSON 倾倒。失败结果的 `error` 稳定码原样保留（`outside-root` / `not-found` / `denied` 等），让模型能区分"路径越界"与"文件不存在"。

**D6 结果大小上限（回灌层新增，文件工具侧不改）。** 文件工具本身**没有**「已截断」事实：`Read` 超过读取上限直接回 `io-error`（`file is too large to read`），`Grep` 命中数静默封顶（`MAX_GREP_MATCHES = 200`），而 `output_truncated` 只属于 `RoundShellResult`，与文件工具无关。因此本批在**回灌层**新增两件事：其一，把回灌给模型的内容压到总量上限，截断处写明「已截断」并给出已给 / 未给的规模提示（语言走词条）；其二，把 `Grep` 的 200 条封顶**显式写进回灌结果**，否则模型会把「只返回 200 条」读成「只匹配 200 条」。这一条需要文件工具给出事实：`RoundFileToolResult` 新增一个可选 `capped` 事实（只加字段，既有字段语义与既有断言不变），取值说明**封顶原因**而不是一个布尔——local 侧是命中数封顶（`MAX_GREP_MATCHES = 200`），Docker 侧还有扫描文件数封顶（`MAX_GREP_FILES = 2000`），两者对模型的含义不同（「还有更多匹配」vs「还有文件没扫」）。不靠 `matches.length === MAX_GREP_MATCHES` 的启发式，因为恰好 200 条完整匹配与封顶在结果上无法区分。命中行的正文在工具侧已经按 300 字截断（行内带省略号，模型可见），回灌层不再叠加；这一层截断不在本批的显式标记范围内。截断与封顶标记都只影响模型看到的那一份。上限是常量，不进 schema，不做每 Agent 配置。

**D7 只落最终文本。** 循环内的中间文本（模型在请求工具前说的话）不落库、不进任何面。循环正常结束时把最后一段文本作为唯一一条 pending reply，为空则按既有 `empty completion` 规则收口为失败。`replies` 的上限纪律（一轮至多落一条 target 消息）不变。**撞上限是本条的唯一例外**：循环停下时最后那段 assistant 文本——连同它请求、但已无预算执行的工具调用——按 D8 作为部分结论落库。若不留这个例外，「撞上限」这条路径按定义永远只有中间文本可落，D8 与测试项将无文本可用；而既有脚本化 `iteration-limit` 落下的正是这份部分结论。

**D8 上限与收口。** `agent_config.max_iterations`（默认 10）是本轮**模型↔工具往返次数**的上限，语义在 ADR 0009 中裁定为「轮内往返」，不是「轮次级」计数。撞上限：`verdict: 'replied'`、把循环内已经产出的结论作为本轮唯一的 pending reply 落成消息、`finishedReason: 'iteration-limit'`。落库落在 `finished_reason` 列（由 `finishedReasonText` 渲染词条 `round.finished.iterationLimit` =「达到迭代上限」），**不是** `reason` 列——两列是两件事。这与脚本化 `iteration-limit` 逐字一致（`scripted-provider.ts` 展开 `replyResult` 后只补 `finishedReason`），因此两条路径共用同一份断言；因为状态是 `replied`，`advancesCursor` 照常推进，同一条触发消息不会被下一次唤醒重读。唯一的例外：撞上限时**还没有任何产出文本**，按既有 `empty completion` 规则收口 `failed`，`finished_reason` 落「错误」（`finishedReasonOf` 对 `failed` 的既有映射），不写「达到迭代上限」，也不伪造一条空消息。

**D9 失败分层。** provider 网络错误、超时（既有 60 秒单次调用超时）、响应不可解析、缺 consent / 缺凭证 → 轮次 `failed`，`reason` 可读且密钥掩码规则不变（`maskSecret` 继续在 reason 落库前生效）。工具失败、参数校验失败、审批拒绝 → 工具结果，轮次继续。区分判据是"错误来自 provider 链路还是来自工具面"，唯一例外是审批超时：它虽从工具面抛出，但按 D10 走 `failed` 收口，不是工具结果。

**D10 审批在循环里的语义（为后续批次先定）。** 需要审批的调用在循环内**阻塞等待** `RoundPermissionFace.authorize`。人类批准即继续执行；**拒绝**作为 `DENIED` 工具结果回灌，模型继续循环——拒绝是结果，不是轮次失败。**超时不回灌**：等满 600 秒批次后 `authorize` 抛 `ApprovalTimeoutError`，本轮按 ADR-0007 决定 6 收口 `failed`，可读 reason 走既有词条。循环不得把超时伪装成一个工具结果，否则一个没人看的轮次会一直续跑到上限。选择阻塞而非「暂停轮次、决定后重开」的理由写在 ADR 0009；本决策**沿用** 0007，不改它。第一批的只读工具在默认路径上不触达审批（`read` 类落到 `mode-allow`），但一条 `permission_rule(Read|Glob|Grep, …, ask)` 会让它们触达：`Read` 在文件工具内部就调 `authorize`，而 `checkPermission` 的规则合并先于模式默认（`rule-ask` 分支），此时同样阻塞等待、超时同样收口 `failed`。多批重开沿用 ADR-0007 决定 5：同一 reply 的新批次重开已 resolved 的记录、合并 `tool_calls`、只发布新调用；循环对每个批次只看到一个最终决定。本批**不**引入「每轮审批批次上限」的抑制规则，所以一条 `ask` 规则可以让一个只读轮次占满一个 600 秒批次。这是接受的风险，不是遗漏。

**D11 `SopVerdict` 的通道（为后续批次先定）。** `RoundResult` 已经有结构化出口 `sopVerdict?: 'pass' | 'fail'`，本决策只锁定它的**取值来源**：一个专用工具（`internal` 类，只返回 `pass` / `fail`），由适配器把该工具调用映射到既有字段。不解析 `replies` 的散文，也不为两家 provider 各写一套结构化输出（OpenAI 的 `response_format` / Anthropic 的文本协议）。同一条通道也适用于 #51 缺口 3 的另一半：`RoundResult.taskAction` 与 `taskTransferMemberId` 是既有的结构化任务动作出口（`continue_task` / `transfer_task` 等），真实模型的取值同样来自专用工具（`internal` 类），不靠解析散文决定「我要续跑」还是「我要转派」。本批不实现这些工具；本决策只锁定通道，避免下一批在「两家不一致」和「解析散文」之间再选一次。

**D12 不新增可观测面。** AG-UI 契约不加 `TOOL_CALL_*` 事件，前端本批看不到工具调用；`RoundResult` 不新增字段。工具调用的可观测性留到明确需要时再开（届时是一次契约扩展，不是本规格的遗漏）。

**D13 无 schema 变更。** 工具调用不入库：没有新表、没有新列、没有迁移步骤。`SCHEMA_VERSION` 保持 21，本规格的 PR 不改 `server/src/db.ts`。若要持久化工具调用记录（审计面），那是另一张票的范围。

## Testing Decisions

**唯一 seam 不变。** 测试仍然只穿越后端 HTTP 面：真实后端进程 + 临时数据目录 + 注入 provider。provider 侧**复用**既有的 `startRecordingEndpoint`（`server/test/support.ts`：`127.0.0.1` + `listen(0)` 随机端口、录请求、`respondWith` 换应答、跑完 `stop`）。它已经按路径分别返回 Anthropic `/v1/messages` 与 OpenAI `/chat/completions` 两种形状（`defaultProviderReply`），本批只加 tool 形状的应答，不改它的形状、不新开注入点。它是 seam 的注入口，不是第二条 seam；真实网络与真实模型密钥仍然禁止。先例：`server/test/remote-data-flow-http.test.ts`。

**好测试的标准。** 只断言外部行为：HTTP 响应、SSE 帧、SQLite 行、AG-UI 事件顺序。不断言适配器内部的循环次数、不断言中间消息数组的形状、不断言某个私有方法被调用。

**必须覆盖的外部行为。**

- 一轮内一次工具调用后给出回答：`round_outcome.status = replied`，target 里恰好一条新消息，正文是**最终文本**，中间文本不落库。
- 一轮内两次工具调用：两次 face 都被执行，落消息仍只有一条。
- 撞 `max_iterations`：`status = replied`、恰好多出一条消息且正文是部分结论、`finished_reason` 读「达到迭代上限」、该消息被消费（未读清零）；撞上限且无产出文本时则是 `failed`。
- 工具失败（越界路径 / 不存在的文件）：轮次仍 `replied`，模型看到的工具结果是 `is_error` / 稳定错误码。
- provider 链路失败（假 server 返回 500 / 返回不可解析 body / 超时）：轮次 `failed`，`reason` 带掩码后的短摘要。
- 缺 consent / 缺凭证：零 socket 打开、轮次 `failed`、`reason` 点名环境变量（既有行为，回归）。
- 没有可用工具面（无项目根、无 Plan face）：provider 收到**零工具定义**，行为与今天的单轮补全一致。
- 两家 provider 用同一组用例各跑一遍：Anthropic `tool_use` 与 OpenAI `tool_calls` 的解析、回灌、终止都逐条对齐。

**先例。** `server/test/agui-contract.test.ts`（AG-UI 事件顺序 + `--scripted-provider` 注入）、`server/test/mcp-runtime.test.ts`（假 TCP / HTTP 服务器 + 随机端口）、`server/test/remote-data-flow-http.test.ts`（`startRecordingEndpoint` 端点注入）、`server/test/permissions-http.test.ts` 与 `server/test/local-shell-http.test.ts`（`--fixed-clock` + `--approval-timeout-ms` 驱动 600 秒超时）是本批的形状先例。脚本化 provider 的既有用例一条都不改。

## Out of Scope

- **写与执行类工具**：`Write` / `Edit` / `Bash` / MCP 工具（`mcp:<server>/<tool>`）不进第一批。它们的审批语义已由 D10 定形，实现是下一批。
- **编排类工具**：`TeamAssign`、`transfer_task`、Plan 的 `TaskCreate` / `TaskUpdate` 不进第一批。`TaskList` / `TaskGet` 只读入列。
- **`SopVerdict` 工具本身**：通道已定（D11），实现留给后续批次。
- **工具调用的可观测面**：AG-UI `TOOL_CALL_*` 事件、轮次内的工具进度、审批列表之外的展示面，一律不做（D12）。
- **工具调用持久化**：不记录每次工具调用的入参与结果，不新增审计表（D13）。
- **deferred / 异步收口**：循环可能在一次 HTTP 请求内跑满 10 次往返；本批接受这个延迟，不引入 deferred 路径。
- **流式输出**：一次性返回的文本不变；不做 token 级流式，也不改 AG-UI 的 `TEXT_MESSAGE_CONTENT` 语义。
- **每 Agent 的工具配置 / 工具白名单**：模型可见工具仍只由既有可用集与 `permission_rule` 决定，不新增配置面。
- **本机 provider**：仍只有 `anthropic` / `openai` 两条线（M1 D1.10 的延后项），不随本批引入本地模型通道。
- **M3 的 T12 范围**：联网档、联网 provider 凭据、容器出网由后续里程碑的规格承接，不在本票。

## Further Notes

**基线数字与来源。** 基线 commit `eb8b07c`：`SCHEMA_VERSION = 21`；`GLOSSARY.md` 826 行；M1 规格 414 行 / 83 条 User Stories；M2 规格 483 行；ADR 0001–0008；`AGENT_DEFAULTS.maxIterations = 10`（`server/src/members.ts`）；`round.finished.iterationLimit`（「达到迭代上限」）已在词条表；`RoundInput.tools` 已按轮次算好可用工具集（`server/src/rounds.ts`）；`rounds.ts` 中 `max_iterations` 出现 0 次——即配置存在但无人执行，这是本规格要补的位。以上数字都从该 commit 上 `wc -l`、`grep -c` 与源码直读得到（`wc -l` 口径：`GLOSSARY.md` 826、M1 规格 414、M2 规格 483），不凭记忆。

**ADR。** 新增 `docs/adr/0009-model-tool-loop.md`：裁定循环位置与 `deferred`、上限的语义归属、工具名作为对外契约、审批阻塞等待、只落最终文本五件事。解析细节、结果回灌长度、批次划分是实现决策，写在本规格。

**批次建议（供 to-tickets 用）。** 第二批：写类与执行类工具 + 审批在循环内的实跑；第三批：编排类工具（TeamAssign / transfer_task / Plan 写工具）；第四批：`SopVerdict` 与 SOP verifier 的真实模型路径。每批都必须在同一 seam 上留下外部行为断言。

**词条缺口。** 本规格引入一个承重说法「轮内工具循环」（round-level tool loop），`GLOSSARY.md` 里没有这个词条。按 `docs/agents/domain.md` 的纪律，缺词要么是发明了项目不用的语言、要么是真缺口：这里是后者——它是 `RoundProvider` 接缝内部的新行为，不与任何已有词条同义（ADR-0007 的工具闸门管的是判定顺序，`轮次` 管的是唤醒到收口，都不覆盖「一次调用内的多次 model↔tool 往返」）。本规格不新增 / 不改写 GLOSSARY 正文；若后续实现票需要公开这个说法，走一次 domain-modeling 补词条，而不是在代码里造同义词。

**与 M2 A1 限制的关系。** 本规格实施完成后，`docs/deployment.md` 的「真实模型 provider 的已知限制（M2 A1）」一节必须改写：限制从"真实模型没有工具循环"变成"哪几类工具已进循环、哪几类仍是脚本化专用"。那条限制是部署事实，不能靠代码合入自动过期。
