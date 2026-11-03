# 0007 权限档、权限规则与审批的唯一工具闸门

## Status

accepted（2026-11-04）

## Context

M2 第一次让 Agent 触碰项目文件、本机 shell 与 MCP 工具。GLOSSARY.md 要求三档权限（read-only / ask-writes / trusted-writes）、频道默认 + Agent 覆盖、permission_rule 的 allow / deny / ask、审批的 600 秒等待与重开语义，并明确 BYPASS / DONT_ASK 不是本仓能力、拒绝是 DENIED 不是 ERROR、local shell 逐次审批且无沙箱。M1 没有工具面，因此也没有工具闸门；如果 M2 把权限档、规则与审批分散在工具适配器、文件工具与 MCP 层各判一次，就会出现多套判定顺序、某些工具绕过审批、或 `reply_id` 被读成一次确认的 id。这个决定是安全边界，回退成本高，且未来读者会问「为什么 trusted-writes 还要审批、为什么 shell 的 allow 规则不生效」。

## Decision

1. **三档，唯一词汇。** 产品只暴露 `read-only` / `ask-writes` / `trusted-writes`，默认 `ask-writes`；频道给默认，Agent 可覆盖（NULL = 跟随频道），DM 用 Agent 覆盖或默认，task 跟随所属频道。`BYPASS` / `DONT_ASK` 一律 400 `validation_failed`，不保留隐藏档位。
2. **read-only 是硬顶。** read-only 下读放行，写 / 执行直接 DENIED；allow 规则不能把它变成可写。ask-writes 下读放行，写 / 执行 ask。trusted-writes 下读放行、根内文件写放行、其它写 / 执行 ask；根外效果仍要审批，但文件工具的根逃逸是装配层错误，不是审批可以放行的路径。
3. **规则三键。** `permission_rule(scope_kind ∈ {channel, agent}, scope_id, tool_name, pattern) → behavior ∈ {allow, deny, ask}`；pattern 为空 = 该工具全部调用。同键 Agent 行覆盖频道行，不同键并存；匹配后按 `deny > ask > allow` 合并。`tool_name` 精确匹配，MCP 写作 `mcp:<server>/<tool>`；pattern 是大小写敏感 glob：文件工具匹配根相对 POSIX 路径，`Bash` 匹配命令串，MCP 匹配稳定序列化参数 JSON。没有正则、没有隐式前缀匹配。
4. **判定顺序。** 先过硬边界（root 逃逸、read-only 硬顶、`allow_local_shell=0`、工作区 / Docker 不可用），再合并规则（deny > ask > allow），再用模式默认兜底，最后 local shell 的硬审批：`allow_local_shell=1` 之后每次 shell 调用都必须 ask，权限档或 allow 规则都不能把它变成自动执行，deny 规则可以拦下。Plan / TeamAssign / transfer_task 是编排内部动作，不经过工具闸门。
5. **审批是一个 reply 的多批决策。** 需要审批时，编排为当前回复分配稳定的 `reply_id`（普通轮次落消息时它就是消息 id；team assignment / SOP 可以是永不落消息的内部 id），落 `approval_request`，发 SSE，等待人类面 `POST /api/approvals/{reply_id}`。一条 reply 可以有多个批次：新批次重开已 resolved 的记录，合并 `tool_calls`、清 `resolved_at`、把 `requested_at` 移到新批次起点、保留旧 `decisions`、只发布新调用；重复登记同一批是幂等，不重开。`confirmed` / `denied` 可因新批次重开；`failed` / `expired` 是终止态，迟到登记不复活。
6. **超时、重启与拒绝。** 默认等待 600 秒，每批重开重新起算；超时收口 `failed`，该轮次以可读 reason 失败。进程重启时残留 pending 一律 `expired`，不跨重启恢复；对应的 team run / SOP run 收口 `failed`（interrupted）。拒绝的工具结果是 `DENIED`，工具未执行，本轮仍可继续；拒绝不是 ERROR，也不自动把轮次判 failed。收口判据是全部历史决策：任一历史拒绝，最终 status 仍是 `denied`；全部批准才是 `confirmed`。
7. **不存密钥。** 审批载荷只带工具调用与必要参数摘要，模型密钥、MCP env 值、联网凭据、registry 凭据在入库前掩码或剔除；人类面只回可读摘要，不回 secret。
8. **工作区可用性按 target 上下文。** 工作区 / Docker 不可用是目标上下文事实，不聚合进全局四态状态点；同一个 Agent 在一个频道不可跑，在另一个频道仍可跑。成员面板、队长无效判定与轮次 reason 消费目标级 `workspace_status`。

## Consequences

- 只有一处判定顺序；工具适配器、文件工具、shell、MCP 都向它要决定，不在各层各判一次。代价是每次工具调用多一次同步判定，收益是可测试、可审计、不会漏掉某个工具。
- trusted-writes 仍会在根外与 shell 上审批；「trusted」不等于「无审批」。local shell 的 allow 规则不能豁免逐次审批，这是有意的硬闸，可能让 owner 觉得重复，但符合词条的「显式开启后逐次审批、无沙箱」。
- 审批面成为 HITL 的唯一入口：普通轮次、TeamAssign、SOP 共用 `reply_id` 与 600 秒批次语义；前端只需要一个审批列表 / 详情面。
- 600 秒等待与 live AG-UI run 的取消 / 断线语义需要固定时钟与中断测试；进程重启不恢复审批，用户会看到 expired，而不是一个悄悄继续的半轮。
- 规则 pattern 的 glob 语义是可逆的实现决策，但「deny 优先」「同键 Agent 覆盖」「read-only 硬顶」是安全边界，改变它们需要重开本 ADR。

## Old ADR Correspondence

- 对应旧仓 ADR-0021（工作区 / 权限面）与 GLOSSARY 中 D18 的可用性裁决：本 ADR 把可用性细化为「全局状态点 + 目标上下文 workspace_status」，把权限面收成一条闸门；不复制旧仓编号。
- 对应旧仓 ADR-0007（人类面不得写用量事实）：审批与权限规则都是配置 / 决策，不写 `target_budget.used`，也不新开预算账本。
- 不涉及 ADR-0004 的迁移闸门：`permission_rule` 与 `approval_request` 是普通 schema 步骤 v19 / v20，仍走严格 +1、备份、单事务、审计。
