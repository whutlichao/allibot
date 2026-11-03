> 本规格由 `GLOSSARY.md`（834 行、93 个词条）转写，按 to-spec 模板的七个章节组织。术语沿用 GLOSSARY 的中英并列写法；每条词条的 `Avoid` 列是约束，不是同义词建议。本轮记作 M1（核心协作环）；M2 及以后的范围见 Out of Scope 与 R1 的「否」行。CopilotKit v2 的 API 事实以官方文档路径标注，不凭记忆写 API；ADR 清单见 `docs/adr/`。

## Problem Statement

本机单机工作台要在一套机制上承载频道、私信、任务三类协作面：owner（人类）与若干 Agent 成员通过 target 协作，业务状态的唯一正本是后端单文件库。GLOSSARY.md 已经把成员、唤醒、回应判断、人类世代、回应预算、轮次、任务、私信、未读、记忆、迁移等行为写得很细，但仓库目前只有词条与规划配置，零源码：这些行为无法执行、无法验证、无法排期，也无法判断哪些词条属于本里程碑、哪些应当延后。

旧仓的 Python + AgentScope + ReMe + Vue Studio 实现前提，与新仓已经定夺的 TypeScript + CopilotKit v2 + SQLite 不一致。直接照抄旧实现会把 Python 进程、AgentScope 适配层、ReMe 文件工作区与两版 Studio 页面带进来，违背「单文件 SQLite 正本」「CopilotKit 原生 copilot 形态」「一个 target 一个编排 agent」这三条新决定。owner 需要的是一份可实施的规格：据此能建实现票、能验收、能判断 CopilotKit 原生形态如何承载多成员协作而不丢词条纪律。

当前的具体问题有四个。其一，术语漂移：多成员、多 Agent、多 thread 的读法不统一，容易被实现成「一个成员一个 agentId」或「一个成员一条 thread」。其二，边界不清：唤醒、回应判断、预算、轮次、记忆分别由前端、runtime 还是后端编排负责，没有一份契约。其三，迁移与备份无代码可依：新仓的 Schema 版本从几开始、旧仓 15 → 25 的步骤链是否复制、启动是否自动迁移，都没有答案。其四，前端形态与词条冲突：词条的「三栏工作台 / dock / 页签」与 CopilotKit 原生 copilot 形态不是同一套语汇，需要一次明确的重新解释。

## Solution

交付一个 CopilotKit 原生的本机单机工作台。主区恒为 `CopilotChat`；左侧 `CopilotSidebar` 承载频道 / 私信 / 任务切换，右侧栏承载当前 target 的成员与上下文；任务看板、成员面板、成员名册、Agent 详情（基础信息 → skills → mcp 三个分组）走抽屉或独立路由。词条的「三栏工作台 / dock / 页签」按这套语汇重新解释，并在 ADR-0002 中留痕。

后端只注册一个编排 agent，但以 target 为编排单位：一个 target（channel / dm / task）= 一个 CopilotKit thread + 一份编排上下文。该 target 内全部成员的唤醒、回应判断、预算与轮次由后端编排驱动；每个成员的回复作为同一条 thread 内的 assistant 消息流式推送，消息 id 指向 SQLite 消息行，消息行记录 `member_id` / `display_name` / `avatar_slot`，前端用自定义 assistant 消息渲染器显示头像与名字。不得改成「一个成员一个 agentId」。

业务正本使用单文件 SQLite（better-sqlite3），库文件落在数据目录；迁移显式执行 `--migrate`，迁移前自动整目录备份、单事务收口，`schema_meta.schema_version` 与代码常量比对，启动与迁移入口都过版本闸门；审计台账是数据目录内的 append-only JSONL。长期记忆以 SQLite 记忆表替代 ReMe 文件工作区：成员级、跨 target 召回、关键词检索注入、轮次收尾自动写回、无开关，不引入 embedding，不新增凭据面。

模型 provider 首个里程碑跑通 Anthropic 与 OpenAI 兼容两类；`provider:model` 标识、缺凭证读环境变量、远端数据流告知、库内不存模型密钥四条保留；自动化测试使用脚本化替身，不联网、零成本。

M1 只交付核心协作环：协作域、唤醒与回应、有界响应、身份与边界、未读与订阅、任务与私信、搜索、工作台前端、语言偏好、数据与版本。team 模式、Plan、SOP、Workspace / 权限 / 审批 / MCP / Skill、联网档 / 联网凭据 / 容器出网、英文词条表延后；旧 `/studio/` 与 `/studio/v2/` 由单一 React 工作台替代。测试只在一个 seam 上做：后端 HTTP 面（人类面 REST + CopilotKit handler + SSE），以临时数据目录启动并注入脚本化 provider。

## User Stories

1. As an owner, I want a workspace read model (GET /api/workspace) to be the single source for the app shell, so that every panel shows the same backend truth.
2. As an owner, I want to create a channel (频道) with a name and description, so that I can group a conversation around a topic.
3. As an owner, I want to join an existing Agent member into a channel explicitly and idempotently, so that repeated joins never create duplicate membership rows.
4. As an Agent member, I want to be a target member of every channel, DM, and task I can be woken in, so that the wake surface and unread rules use one table.
5. As an owner, I want every message (消息) to be append-only with a target-scoped seq, so that rendering order, reconnect cursors, and human epochs share one stable order.
6. As an Agent member, I want mentions (`@mention`) parsed on the backend with start / end ranges and a stored snapshot, so that renaming a member never rewrites old mentions.
7. As an owner, I want to mention an Agent who is not in the channel and have the message delivered once (穿透), so that a direct call is never lost while membership changes only when that Agent replies.
8. As an owner, I want to attach files to messages with metadata in SQLite and bytes in the data directory, so that attachments (附件) are immutable and excluded from search.
9. As an owner, I want to archive a channel (已归档频道) and keep it readable but read-only, so that past work stays searchable without accepting new writes.
10. As an owner, I want to delete a channel (已删除频道) as a soft delete that retains every row, so that history and message append-only stay intact.
11. As an owner, I want system event messages (系统事件消息) for joins, task changes, reminders, auto-continue, and task pointers, so that facts not spoken by a participant are recorded without waking anyone.
12. As an owner, I want message bodies rendered as Markdown in chat, so that emphasis, code, lists, quotes, links, and tables are structural rather than raw notation.
13. As an Agent member, I want a wake (唤醒) signal that carries only identifiers and a reason, so that I read the target messages through the same read path as everyone else.
14. As an Agent member, I want the response judgment (回应判断) to treat mentions, claims, human messages, and auto-continue as mandatory signals, so that I cannot silently ignore a direct call.
15. As an Agent member, I want a structured silent (沉默) status distinct from ignored, so that a deliberate silence is not confused with a normal self-judged ignore.
16. As an owner, I want one round (轮次) per Agent at a time with merged duplicate wakes, so that a member never runs two overlapping rounds in one target.
17. As an owner, I want every round to end in a round outcome (轮次结果) row with a status and a readable reason, so that ignored and failed are different facts I can audit.
18. As an Agent member, I want the last 40 messages as my normal context window (上下文窗口) and the full task thread for auto-continue, so that history informs understanding without re-triggering wakes or budget.
19. As an owner, I want a finished reason (轮次结束原因) separate from the response status, so that a normal finish, an interrupt, an iteration limit, and an error are distinguishable.
20. As an Agent member, I want member-level long-term memory (长期记忆) recalled across targets by keywords and written back at round close, so that I remember prior work without a memory switch.
21. As an owner, I want a status point (状态点) derived from backend facts, so that online, working, error, and offline mean the same after a restart.
22. As a developer, I want one Agent seam (成员面适配接缝) that takes a target round and returns replies plus a round outcome, so that domain tests never depend on a model vendor.
23. As an owner, I want a human epoch (人类世代) opened by a human message, an owner reassignment, or a first claim, so that budget resets at the same boundaries as the conversation.
24. As an owner, I want a per-target response budget (回应预算) with a default of 3 and channel options 3 / 5 / 10, so that one human turn cannot produce an unbounded Agent-to-Agent loop.
25. As an owner, I want one Agent message that delivers at least one wake to consume exactly one jump (跳), so that fan-out to many members does not multiply the budget.
26. As an owner, I want budget-exhausted (预算耗尽) messages to persist with zero wakes and one round outcome per suppressed member, so that exhaustion is visible, not silently dropped.
27. As an owner, I want the budget table (target_budget) to be the canonical used count across restarts, so that the human face cannot rewrite usage facts.
28. As an owner, I want Agent actions to run in-process with structural identity (结构身份), so that no member can impersonate another over HTTP.
29. As a developer, I want the human face / member face (人类面 / 成员面) separated by caller, so that HTTP belongs to the owner and the orchestration Agent belongs to the members.
30. As an owner, I want a one-time remote data flow consent (远端数据流告知) per model provider before the first remote call, so that I know which content leaves the machine.
31. As an owner, I want model credentials read from environment variables and never stored in SQLite, so that the database is not a secret store.
32. As an owner, I want the workbench (工作台) to be a backend read model plus a CopilotKit shell, so that the frontend never becomes a second source of truth.
33. As an owner, I want a read position (已读位置) per member per target, so that unread counts survive refreshes and restarts.
34. As an Agent member, I want my read cursor (消费游标) to advance only on replied or ignored, so that a failed round re-reads the message on the next wake.
35. As an owner, I want unread (未读) to count only top-level human and Agent messages not authored by me, so that system events and my own messages never inflate the badge.
36. As an owner, I want a global SSE stream plus the AG-UI chat stream (订阅), so that workspace facts and chat tokens arrive live without a second per-target connection.
37. As an owner, I want a task (任务) to belong to exactly one channel and have its own task thread, so that task state and task discussion are separate from the channel feed.
38. As an Agent member, I want claim (认领) to assign the task, write two system records, add me as a target member, move the task to in_progress, and wake me in one transaction, so that claiming is an act of starting work.
39. As an Agent member, I want auto-claim to be on by default and gated by autonomous mode and availability, so that new tasks can start without manual assignment.
40. As an Agent member, I want a structured continue_task action (自动续跑) that writes a system record and wakes me again, so that "I will continue" is executable rather than prose.
41. As an owner, I want a five-state task status (任务状态) machine with allowed transitions returned by the backend, so that the board never offers an illegal move.
42. As an owner, I want in_review to done to require a non-assignee or the owner, so that an assignee cannot approve their own work.
43. As an owner, I want a task board (任务看板) that filters by channel and uses backend allowed transitions, so that the board is a view, not a second state machine.
44. As an owner, I want a task pointer (指针消息) in the channel with a chip to the task thread and its unread count, so that the channel points into the task without duplicating its messages.
45. As an owner, I want a DM (私信) to be an explicitly created two-member target that is idempotent per Agent, so that a DM exists before the first message and has no join / leave path.
46. As an owner, I want an archived DM (已归档私信) to be read-only after the Agent is soft-deleted, so that history remains readable without accepting new sends.
47. As an owner, I want a one-shot reminder (提醒) with a local date and time that lands a system message in its channel, so that due facts are recorded without waking anyone.
48. As an owner, I want a due (到点) marker that catches up once within 24 hours and marks later reminders as missed, so that a stopped process does not replay stale reminders.
49. As an owner, I want a team-mode (team 模式) channel to wake only the leader, so that team output is funneled through one member.
50. As a leader, I want TeamAssign (分派) to count one jump per assignment and record a team assignment row, so that member work is traceable without becoming channel messages.
51. As an owner, I want team run records (运行记录) readable through the workspace, so that member process is visible without entering unread or search.
52. As a member, I want a Plan run (Plan) with TaskCreate / TaskGet / TaskList / TaskUpdate scoped to my round, so that I can maintain a work list without creating tasks.
53. As an owner, I want a SOP run (SOP) with executor / verifier steps and attempts, so that a multi-step process is explicit and auditable.
54. As an owner, I want a channel workspace root (工作区项目根) that is the only writable project root, so that file tools cannot escape it.
55. As an owner, I want an Agent home (Agent 家目录) with rules, memory, skills, and mcp.json, so that each Agent has a stable per-member asset location.
56. As an owner, I want global and project layers (全局层 / 项目层) with a defined precedence, so that rules, skills, and MCP declarations resolve predictably.
57. As an Agent member, I want a rules base (规则基座) and a project supplement around my system prompt, so that reusable rules and project overrides are composed.
58. As an owner, I want local and Docker workspace backends (工作区后端) with explicit failure, so that a missing Docker daemon never silently falls back to local shell.
59. As an owner, I want read-only, ask-writes, and trusted-writes permission modes (权限档), so that writes and execution require approval unless explicitly trusted.
60. As an owner, I want permission rules (权限规则) by channel or Agent and tool / pattern, so that allow / deny / ask can be scoped without an ACL.
61. As an owner, I want approval requests (审批) for tool calls with pending / confirmed / denied states, so that a human decision is recorded and a denial is not an error.
62. As an owner, I want MCP declarations (MCP 声明) in a single per-Agent mcp.json, so that the management view and runtime assembly read the same file.
63. As an owner, I want skills (Skill) installed from a local directory, a zip, or the shared skills directory, so that Agent capabilities are explicit and hash-checked.
64. As an owner, I want backend substring search (搜索命中) over messages excluding system events, so that matches are deterministic and case-insensitive.
65. As an owner, I want highlight ranges (高亮区间) for every match, so that the frontend only wraps ranges and never searches text itself.
66. As an owner, I want task hits and Agent hits (任务命中 / Agent 命中) alongside message hits with a hit type, so that search covers the three objects without pretending to be full-text search.
67. As an owner, I want the Agent detail page (Agent 详情页签) to have basic information, skills, and mcp tabs in a fixed order, so that configuration, capabilities, and connections are grouped consistently.
68. As an owner, I want a member panel (成员面板) showing joined and not-joined Agents with a join control, so that I can manage channel membership from the conversation.
69. As an owner, I want a member roster (成员名册) with status points, so that I can see who is in the channel without management actions.
70. As an owner, I want a local Agents list (本机 Agent) independent of channel membership, so that I can see every Agent on this machine.
71. As an owner, I want @ completion (补全) to list only Agent members of the current target, so that completion never implies a membership that does not exist.
72. As an owner, I want the visual contract (视觉契约) token names to be stable, so that downstream components keep consuming the same names.
73. As an owner, I want one React workbench (工作台版本) to replace the old Studio routes, so that there is one product surface, not two frontends.
74. As an owner, I want deterministic avatar slots (头像色位) and role families (角色族) with tiers (档位), so that a member looks the same everywhere and color meaning stays stable.
75. As an owner, I want a string catalog (词条表) with stable keys and parameters, so that UI copy and backend-generated text share one vocabulary.
76. As an owner, I want a locale preference (语言偏好) stored in the database and used by both frontend and backend, so that system messages and round reasons match my language.
77. As an owner, I want workspace settings (工作区设置) for locale, density, and theme, so that configuration is typed and separate from usage facts.
78. As an owner, I want a data directory (数据目录) containing the SQLite file, attachments, and the migration audit ledger, so that backup and migration have one unit.
79. As an owner, I want a pre-migration whole-directory backup (备份), so that rollback is restoring that copy and opening it with the old code.
80. As an owner, I want a schema version (Schema 版本) stored in schema_meta and compared with the code constant, so that I know which shape the database has.
81. As an owner, I want a version gate (版本闸门) that refuses startup and migration on a mismatch, so that no schema change happens by accident.
82. As an owner, I want an explicit --migrate command (数据迁移) with a step chain and one transaction, so that upgrades are deliberate and recoverable.
83. As an owner, I want an append-only audit ledger (审计台账) for every migration attempt, so that even a failed migration has a durable record.

## Implementation Decisions

### D1 技术栈、运行时与数据基座

**D1.1 全栈 TypeScript。** 前端、后端、共享类型、数据库访问与测试全部用 TypeScript。不保留 Python 运行时，不引入双语言进程边界；旧仓以 Python 模块形式出现的迁移与导出命令改为 Node CLI 子命令。模块划分（按接口而非文件路径）：`db`（SQLite 连接、schema、迁移、备份、审计、数据目录解析）、`domain`（成员、频道、消息、任务、私信、提醒、未读、搜索的写路径与读路径）、`orchestrator`（唤醒、回应判断、轮次、预算、人类世代、记忆、状态点）、`agent.runtime`（AG-UI `AbstractAgent` 适配器与 provider 适配器）、`http.human`（人类面 REST、SSE、CopilotKit handler）、`web.shell`（React 工作台壳、`CopilotChat`、`CopilotSidebar`、抽屉与路由）、`web.render`（自定义消息渲染、Markdown、补全）、`web.detail`（Agent 详情、成员面板、名册、看板）、`i18n`（词条表与语言偏好）、`shared.identity`（结构身份、人类面 / 成员面、远端告知）。每个模块的接口是 caller 与测试共同穿越的 seam；模块内部可以有私有 seam，但不作为测试面。

**D1.2 CopilotKit 运行时接线。** 前端用 `CopilotKitProvider`（`runtimeUrl` 指向后端 handler，`useSingleEndpoint={false}`，因为后端使用多路由 handler）；主区 `CopilotChat`，侧栏 `CopilotSidebar`。后端用 `@copilotkit/runtime/v2` 的 `CopilotRuntime`，`agents` 映射只注册一个 `allibot` 编排 agent；handler 用 `createCopilotRuntimeHandler` 挂多路由（GET / POST / PATCH / DELETE），`basePath` 为 `/api/copilotkit`。依据：<https://docs.copilotkit.ai/a2a/intelligence/quickstart>、<https://docs.copilotkit.ai/a2a/runtime-server-adapter>、<https://docs.copilotkit.ai/a2a/backend/copilot-runtime>。

**D1.3 自写 AG-UI agent 的事件契约。** 编排 agent 继承 `AbstractAgent`（`@ag-ui/client`），实现 `run(input: RunAgentInput): Observable<BaseEvent>`。事件顺序：`RUN_STARTED` →（可选一次 `STATE_SNAPSHOT`，携带本 target 的成员元数据）→ 每个成员回复一组 `TEXT_MESSAGE_START` / `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_END` → `RUN_FINISHED`；错误用 `RUN_ERROR` 收口。`messageId` 使用 SQLite `message.id`；事件是观察面，不是消息正本。依据：<https://docs.copilotkit.ai/a2a/backend/custom-ag-ui-agent>、<https://docs.copilotkit.ai/a2a/troubleshooting/event-inspector>。不使用 LangGraph，不为每个成员注册 agentId。

**D1.4 数据访问层选 better-sqlite3，不选 drizzle。** 理由：本仓是本机单人、单进程、本地优先；better-sqlite3 的同步 API 与「唤醒编排在进程内顺序执行」一致，`db.transaction()` 能把消息落库、seq 分配、提及解析结果、附件绑定与唤醒信号收进一个事务；词条要求的数据库级触发器（消息 append-only、附件不可改、指针消息 BEFORE INSERT 校验）与部分唯一索引必须用原生 DDL 表达，drizzle 会形成第二套 schema 来源并与显式 `--migrate` 步骤链冲突；查询形状固定，手写 SQL + 轻量行映射比 ORM 更短、更可审计。代价是类型安全靠手写映射与测试兜底，由「一条主 seam + 脚本化 provider」的测试策略吸收。

**D1.5 数据目录与库文件。** 数据目录默认 `~/.allibot/data/`，`--data-dir` 或 `allibot_DATA_DIR` 覆盖；解析顺序为「显式覆盖 → 新默认存在 → 旧 `~/allibot` 存在（兼容读取并提示）→ 新建新默认」，绝不自动搬移旧数据。数据目录承载 `allibot.db`、`attachments/` 与 `schema-migrations.jsonl`；它是备份与搬迁的单位，不是库文件的位置。M1 没有项目根文件工具，也没有全局层，因此备份边界只覆盖数据目录；项目文件与 Agent 家目录的备份留给后续票。

**D1.6 M1 的表与写路径。** 表：`member`（id、kind、display_name、avatar_slot、deleted_at、created_at）、`agent_config`（member_id、role、model、system_prompt、enabled、context_window、compression_threshold、max_iterations、auto_claim）、`channel`（id、name、description、mode、response_budget_limit、archived_at、deleted_at）、`target`（id、kind）、`target_member`（target_id、member_id）、`message`（id、target_id、seq、kind、author_member_id、author_display_name、author_avatar_slot、body、created_at、task_ref、task_pointer）、`message_mention`（message_id、member_id、start、end）、`attachment`（id、message_id、filename、mime、size、storage_path、created_at）、`read_position`（member_id、target_id、last_read_seq）、`target_budget`（target_id、epoch_seq、used）、`round_outcome`（id、member_id、target_id、base_seq、status、reason、finished_reason、started_at、finished_at、budget_consumed、merged）、`task`（id、channel_id、target_id、title、status、assignee_member_id、claimed_at、created_at、updated_at）、`reminder`（id、channel_id、due_at_local、text、delivered_at、created_at）、`remote_consent_scope`（scope_kind、scope_id、confirmed_at）、`agent_memory`（id、member_id、content、keywords、source_target_id、source_message_id、created_at）、`setting`（key、value）、`schema_meta`（schema_version）。延后表：`team_run`、`team_assignment`、`plan_run`、`plan_task`、`sop_definition`、`sop_run`、`permission_rule`、`approval_request`、`mcp_server`、`skill`、`web_provider_credential`。M1 不建这些表，避免「建了表但没有写路径」的半成品。

`channel.mode` 在 M1 只接受 `autonomous`；`team` 取值在 T10 前返回 `validation_failed`，不保留半实现的 team 分支。

写路径纪律：消息 append-only，数据库触发器拒绝 UPDATE / DELETE；附件不可改，触发器拒绝 UPDATE / DELETE；`round_outcome` append-only；`seq` 由单写者事务内 `MAX(seq)+1` 分配并由 `UNIQUE(target_id, seq)` 兜底；消息、提及解析结果、附件绑定、轮次结果、预算推进与唤醒信号在同一边界内收口；认领、建任务（任务行 + task target + 频道指针消息）、预算跳扣减各自一个事务。单进程假设写死：一个数据目录同时只允许一个后端进程写入。

**D1.7 迁移、备份、版本闸门与审计台账。** 迁移只经显式 `--migrate` 执行，启动路径不迁移。迁移前自动对整个数据目录建一份同级、带迁移时刻的整目录副本；备份失败就不迁移。数据库变更在一个事务内收口；审计台账是数据目录内的 append-only JSONL，一行一条迁移记录（from / to / 起止时间 / 结果 / 备份路径），失败也记，带原因；它不落库表、不改 Schema 版本，HTTP 没有写入口。代码里的 `SCHEMA_VERSION` 常量与 `schema_meta.schema_version` 比对；不等时启动路径拒绝启动、迁移入口拒绝执行；库的 Schema 版本高于代码版本一律拒绝，不提供降级路径。回滚 = 恢复迁移前整目录备份，再用旧代码打开；改回 `SCHEMA_VERSION` 不算回滚。新仓基线为 `1`，第一条迁移就是初始形态；旧仓 15 → 25 的十个步骤属于上一代仓库历史，不复制、不补号。数据目录不存在或为空时，`--migrate` 负责初始化，不需要备份，审计台账记「空目录、无备份」；`serve` 在库缺失时拒绝启动并提示先运行 `--migrate`。

**D1.8 人类面 HTTP 契约。** 所有端点只服务 owner（本机单人、无登录、无账号、无多租户），默认只绑定 localhost。错误信封统一为 `{error: {code, message, details?}}`；`validation_failed` 400、`not_found` 404、`conflict` 409、`version_mismatch` 409。关键端点：
| 端点 | 语义 |
| --- | --- |
| `GET /api/workspace` | 工作台读数：owner、Agent 列表、频道（含归档）、私信、任务、未读汇总、设置、状态点 |
| `POST /api/channels`、`GET/PATCH /api/channels/{id}` | 建频道、读频道、改名称 / 描述 / 预算上界 |
| `POST /api/channels/{id}/archive`、`DELETE /api/channels/{id}` | 归档、软删除；重复删除返回 404 |
| `GET /api/channels/{id}/members`、`POST /api/channels/{id}/members` | 频道成员；加入幂等，响应 `{joined: boolean}` |
| `GET /api/targets/{id}/members` | 当前 target 的成员（补全与面板共用） |
| `GET /api/targets/{id}/messages?after_seq=&limit=` | 按 seq 补拉消息；含提及区间与附件元数据 |
| `POST /api/targets/{id}/messages` | owner 发消息的非 UI 入口；同一事务分配 seq、解析提及、绑定附件、触发唤醒；与 AG-UI run 共用写路径与 client message id 幂等键 |
| `POST /api/targets/{id}/read` | 推进 owner 的已读位置；只接受单调 max 并裁剪到当前最大 seq |
| `POST /api/attachments`、`GET /api/attachments/{id}` | 上传草稿、下载已绑定附件 |
| `GET /api/agents`、`POST /api/agents`、`GET/PATCH/DELETE /api/agents/{id}` | Agent 列表、创建、配置、软删除（危险操作） |
| `GET /api/dms`、`POST /api/dms` | 私信列表、按 Agent 幂等创建 |
| `GET /api/tasks`、`POST /api/tasks`、`GET/PATCH /api/tasks/{id}` | 看板列表、建任务、改标题 / 状态 / 指派 |
| `GET /api/search?q=` | 消息命中、任务命中、Agent 命中 |
| `GET /api/reminders`、`POST /api/reminders`、`DELETE /api/reminders/{id}` | 提醒的读、建、删 |
| `GET /api/settings`、`PATCH /api/settings` | 语言偏好、消息密度、主题 |
| `GET /api/remote-data-flow`、`POST /api/remote-data-flow/{provider}/consent` | 远端数据流告知的读数与一次性确认 |
| `/api/copilotkit/*` | CopilotKit 多路由 handler；AG-UI 的 live 运行面 |

归档频道的五个写入口（频道消息、频道配置、预算上界、加入成员、新建任务）整体返回 400 `validation_failed`；已删除频道的每条频道端点返回 404。加入频道是显式动作，不落系统事件消息；穿透回复的加入才落系统事件消息。人类面可以写配置类取值，但不得写 `target_budget.used` 等用量事实。

**D1.9 SSE 与实时面。** 只保留一条全局 `GET /api/events`：纯 live、不补拉、不发 `id:` 行；帧里的 `target_id` 是归属正本；事件包括 `message.created`、`member.status`、`round.outcome`、`task.changed`、`unread.changed`、`reminder.due`、`workspace.changed`；单条连接寿命到期前发 `event: rotate`，前端据此区分例行轮换与后端不可达。重连后的补齐由前端重新获取 `GET /api/workspace` 与 `GET /api/targets/{id}/messages` 承担，连接数与 target 数解耦。对话 token 走 CopilotKit 的 AG-UI 流，不走这条 SSE；因此词条里的「按 target 的 SSE」在 M1 不保留（见 R4）。登录态没有，订阅与成员关系无关。

**D1.10 Provider 与凭证。** `agent_config.model` 写作 `provider:model`；provider 决定缺凭证时读哪个环境变量，以及这个模型是否本机（要不要先做远端数据流告知）。M1 的 provider 为 `anthropic` 与 `openai`（OpenAI 兼容端点通过环境变量覆盖 base URL），两者都是远端；本机 provider 延后。缺凭证时读 `ANTHROPIC_API_KEY` / `OPENAI_API_KEY`。库内不存模型密钥；HTTP、进程输出与事件只回掩码或「缺凭证」状态。远端数据流告知按 provider 写 `remote_consent_scope` 的 `('model', provider)` 行，记录何时确认过，不存连接参数；未确认时该 Agent 状态点为未启用，被点名时轮次 reason 可读，且绝不发起任何远端调用。告知列出的数据面：消息正文、发送者显示名、target 的显示名（频道名称与描述、DM 对方显示名、任务标题）、被点名成员的显示名、接收方。本仓不做应用层端到端加密，产品文案不声称 E2EE。联网 provider 的凭据表、联网档与容器出网在 M1 延后（T12）。

**D1.11 附件、提醒、搜索与设置。** 附件元数据落 `attachment`，字节落 `attachments/`，不进单文件库；上传与绑定分两步，未绑定的上传只是草稿，读取面不暴露；附件不可改、与消息同口径没有删除路径，不进搜索与成员面。提醒是 owner 自设的到期时刻 + 文本备忘，可归属一个频道；到期时刻按本机本地时间解释（`created_at` 仍是 UTC 审计戳），到点由后端落一条 `kind='system'` 的消息进归属频道（不唤醒、不消耗预算、不计未读），作者是 owner；不归属任何频道的提醒到点只记已到点、不落消息；`delivered_at` 标记同时保证「至多投递一次」与「至多补投一次」，距到期 24 小时以内补投一次，超过窗口只记已到点并在人类面标成已错过；提醒是一次性的，没有周期重复。搜索是后端子串匹配、大小写不敏感，只排除 `kind='system'` 的事件消息；成员被软删除后的历史消息仍可命中；已删除频道的消息与任务不进全局与定向搜索；任务命中以任务标题为命中本体，Agent 命中以显示名与角色为命中本体；三类命中由后端判定并返回命中类型，消息命中返回全部高亮区间，任务 / Agent 命中可能没有区间，前端退化为整段呈现，绝不自行找位置。不做分词、模糊匹配、拼音或近义词；不用 FTS。工作区设置只有语言偏好、消息密度、主题三档，落库、经 `GET/PATCH /api/settings` 读写；改设置不落消息、不唤醒、不消耗预算。

**D1.12 状态点与可用性。** 四态：`online` / `working` / `error` / `offline`。`working` 是进程内的 in-flight 事实；`error` 读库里该成员最近一条非 `merged` 的轮次结果是否为 `failed`（重启后仍是同一条事实）；`offline` 由可用性推导（未配置模型、缺凭证、未确认远端数据流告知）；其余为 `online`。状态点只表达后端事实，不从浏览器连接推导；它不承载颜色语义以外的在线判断（头像色位与角色族是视觉契约，不与状态混用）。

**D1.13 协作域与有界响应的不变量。** 以下不变量与 R1 表的备注互为索引；实现票不得用「流程上不会发生」替代数据库或写路径上的保证。

- **成员软删除**：写 `member.deleted_at`，删掉它在 `target_member` 的全部行（移出全部频道与任务线程）；DM target、消息、任务历史、`agent_config` 与 `round_outcome` 一律保留；不级联删除、不重写 `task.assignee_member_id`；读路径按 `deleted_at` 筛选；历史消息作者仍按行渲染；删除后不再出现在 Agent 列表 / 频道成员 / 提及候选 / 状态点 / 搜索命中面。
- **频道归档**：`channel.archived_at` 非空；移出活跃段、进可折叠的已归档段；频道消息、频道配置、回应预算上界、加入成员、新建任务五个写入口整体 400 `validation_failed`；历史可读、可被全局搜索命中；频道自己的未读读数照旧，但不计入左栏总未读徽标；既有任务仍可读、可改状态、仍能在任务线程发言；已开始的 Agent 轮次不打断；提醒到点仍落 system 消息；归档是配置类写路径：不落消息、不唤醒、不消耗预算、不开世代；幂等，重复归档不刷新时间。
- **频道删除**：`channel.deleted_at` 非空；`get_channel` 与它背后的每条频道端点是 404；频道列表、全局与定向搜索、任务看板与任务搜索都筛选它；按 id 直接读任务与线程仍可用；channel / target 影子行 / 消息 / target_member / 任务 / 预算 / 轮次结果全部保留；删除不幂等，第二次 404；删除时清空 `archived_at`；归档与删除是两个独立档位，不是一条状态机。
- **系统事件消息**：六个来源（穿透加入、任务创建、任务变更、提醒到点、自动续跑、任务指针）；不唤醒、不消耗预算、不计未读；自动续跑的唤醒是编排紧跟着的显式投递，不是 system 消息自动唤醒；加入频道这条显式动作不写 system 消息。
- **提及与穿透**：解析在后端（最左最长匹配、无引号候选恰好等于成员名、@ 左边界前是 ASCII 字母或数字时不算提及），结果含 start / end 与成员 id，随消息落库；唤醒与渲染消费同一份解析结果，改名不重算历史。channel 上的穿透：要回复就顺带加入，先落一条 system 加入消息、再落回复；不回复则不加入。DM 上的穿透只一次性送达，回复照常落库、不改成员关系。穿透不豁免预算。
- **唤醒**：消息提交后触发；信号只带 `(member_id, target_id, from_seq, reason)`；`reason` ∈ {channel-message, mention, claim, continue}，不带正文；面 = 该 target 的 target_member 里的全部 Agent（排除作者，人类与 Agent 作者一样），未加入但被点名的穿透；同一 Agent 的重复唤醒合并；同一 Agent 同时最多一轮 in-flight；唤醒是注意力，不是命令。
- **回应判断**：M1 四类确定信号（mention / claim / human message / continue）；确定信号下 ignored、silent、无正文且无任务动作一律按 failed 收口；明确无关（他人之间的对话、未点名自己、也不是上述任一条）应当 ignored，这是正常协议选择；其余按相关性自判。silent 是结构化状态，不是消息 kind；可读文案按信号来源选择（claim_* / human_message_* / continue_*），不复用未发生的信号文案。DM 的 system prompt 是一对一口径 + 显式必答句；channel 轮的沉默 rubric 逐字不变，人类消息必答句另起一段。team 队长被任务变化唤醒这条确定信号延后到 T10。
- **轮次**：一轮 ↔ 至多一条 target 消息；落库路径只有一条；每轮以轮次结果收口；同一 Agent 同时最多一轮 in-flight，窗口内重复唤醒合并（不排队、不重放）。普通轮上下文窗口最近 40 条；自动续跑保留完整任务线程；历史只供理解，不重新形成唤醒、确定信号或消费基线。轮次结束原因独立（正常完成 / 人类中断 / 迭代上限 / 错误）；旧轮次未知。消费游标只在 replied / ignored 推进；failed 不推进。
- **人类世代与回应预算**：开世代动作三种——human 消息落库、owner 在 task 上改指派人（落的 system 消息的 seq 即 epoch_seq）、首次认领（取「已认领」那条 system 的 seq，不取紧随其后的「认领后自动开工」）；开世代时 `target_budget.used` 重置 0 并按当世代生效上界给满额；频道上界改动从下一个人类世代生效。上界默认 3，频道可配 3 / 5 / 10；每 target 一份。跳 = 一条 Agent 消息投递至少一个唤醒；一条消息唤醒多个成员只算 1 跳；被合并的重复唤醒不额外计数；全部 in-flight（零投递）不算跳。预算耗尽：消息照常落库、零唤醒、每个被压制成员一条 `budget-exhausted` 轮次结果；不是出错，状态点仍空闲；下一次开世代重置。`target_budget.used` 只由后端推进，人类面不能写或重置。
- **任务**：任务行可变、消息 append-only；任务恰好属于一个频道，不跨频道流转；每次任务变更追加一条 system 消息。建任务由 owner 发起：task 行 + task target + 频道 `task_pointer` system 消息同一事务；M1 只有 owner 建任务。认领：autonomous + `auto_claim=1` + `availability.ok`；同一事务指派、落两条 system（「已认领」+「认领后自动开工」）、写 target_member、推进 in_progress、唤醒认领者；每张任务至多一次；首次认领是开世代动作；不是跳。自动续跑：受派者用 `continue_task` 申请；落 `system.task.continue` 并再唤醒同一人；输入是整个任务线程；确定信号；每世代最多 4 轮（首轮 + 3 轮续跑），到上限落 `system.task.continue_paused`；不是跳、不消耗预算。五态 todo / in_progress / in_review / done / closed；`in_review → done` 只能由指派者之外的成员或 owner 触发；`closed` 是终态；合法迁移集合由后端 `TASK_STATUS_TRANSITIONS` 固定并随任务载荷返回 `allowed_transitions`，前端不持副本。M1 只有 owner 改派；Agent 转派与 team 任务变化唤醒延后到 T10。
- **私信**：两方 target，显式创建、按 Agent 幂等，无加入 / 离开端点；owner 发言唤醒对方，Agent 回复零唤醒；被 @ 的第三个 Agent 一次性送达；Agent 软删除后按 `peer.deleted_at` 归档为只读。
- **未读**：`read_position(member_id, target_id, last_read_seq)`；owner 的行是未读徽标基准，Agent 的行是消费游标；只在同一 target 内单调取 max 并裁剪到当前最大 seq；未读只算 target 顶层、`kind ∈ {human, agent}`、作者不是本人的消息；system 不计；工作台 `unread_total` = channel 型 + dm 型，task 型单列；任务指针是 system，因此不计频道未读。

### D2 产品形态

**D2.1 主区与侧栏。** 主区恒为 `CopilotChat`；任何 target 的对话面都由它承载。左侧 `CopilotSidebar`（或以其 header / 自定义槽承载的导航区）切换频道、私信、任务；右侧栏承载当前 target 的成员与上下文。同一时刻最多一个 docked 侧栏占用文档布局，另一侧以抽屉呈现，避免两个 docked 侧栏争用布局。依据：<https://docs.copilotkit.ai/reference/components/CopilotSidebar>。

**D2.2 抽屉与路由。** 任务看板、成员面板（已加入 / 未加入 + 加入控件）、成员名册、Agent 详情（基础信息 → skills → mcp 三个分组）走抽屉或独立路由。抽屉与路由都是呈现层：打开哪一面不改变 target、不落消息、不唤醒、不消耗预算；不持有业务正本。Agent 详情页签的顺序固定；M1 的基础信息页签可用，skills 与 mcp 页签以「依赖 T11」的占位呈现，不放假按钮、不伪造数据。

**D2.3 词条语汇重新解释。** 三栏工作台 = 左侧 target 导航 + 主区 `CopilotChat` + 右侧栏 / 抽屉（成员与上下文）；dock = 抽屉或独立路由；页签 = Agent 详情路由 / 抽屉内的三个分组；工作台版本 = 单一 React 工作台，旧 `/studio/` 与 `/studio/v2/` 不迁移、不并存。这次重新解释记录在 ADR-0002；旧 Studio 的 Vue 构建链与 `/studio/v2/` 迁移策略不复制。

**D2.4 前端呈现纪律。** 人类与 Agent 对话正文按 Markdown 呈现（段落、标题、强调、行内代码、代码块、列表、引用、链接、表格）；`kind='system'` 的事件记录、状态变更、搜索命中行、技能正文不按 Markdown 对话气泡呈现。渲染是呈现不是判定：提及仍由后端给出区间，前端只按区间包标签；`**@某人**` 是加粗的提及，`` `@某人` `` 是行内代码样式的提及，但「是不是提及」只有后端一处裁决。已知代价：`snake_case_name` 会被误当强调，`2 * 3 * 4` 会被误当斜体；不提供「查看原文」开关。补全候选只列当前 target 的 Agent 成员（不列 owner、不列 target 外成员、不标注未加入），插入库里的原名；频道只列已加入 Agent，DM 只列对方那一个，任务线程只列该任务 target 的 Agent 成员；前端不解析提及。

**D2.5 视觉契约与工作台版本。** 下游按名字消费的 token 名集合保持不变（`--bg` / `--surface` / `--panel` / `--panel-2` / `--fg` / `--muted` / `--faint` / `--border` / `--border-strong` / `--accent*` / `--on-accent` / `--selected*` / `--unread*` / `--warn*` / `--online` / `--working` / `--error` / `--offline` / `--av-0…--av-4` 等）；正本沿用设计系统的 `colors_and_type.css` + `tokens.css`，产品角色族由产品扩展层声明；设计系统自己的 ADR 编号不解析、不复制。头像色位是确定性色位（`--av-0…--av-4`，7px 圆角方块，不是圆形），只用于识别同一成员，不承载在线状态或主题语义。档位按对比度用途分层：填充档、淡底档、文字档、图形档；角色族以角色而不是色相命名，每个角色恰好一个色相；新增档位加后缀（`-deep` / `-graphic` / `-fill`），族名沿用旧名。单一 React 工作台替代旧 `/studio/` 与 `/studio/v2/`；旧 Vue 页面不迁移。

### D3 多成员表达

**D3.1 thread 与 agent 映射。** `threadId = target_id`；一个 target 恰好一个 thread。前端 `CopilotChat` 的 `agentId` 固定为 `allibot`，`threadId` 传当前 target_id。运行时只注册一个编排 agent；它以 threadId 为键为每个 target 持有一份编排上下文（成员表、预算、轮次队列、记忆召回各自独立）。这里的「一个编排 agent」指编排层：`allibot` 是稳定的 agentId，每个 target 在编排模块内是一份独立实例；不按 target 或成员分裂 agentId，也不得把成员回复拆成多个 thread。依据：<https://docs.copilotkit.ai/a2a/threads-lifecycle>。

**D3.2 一轮内的多成员流。** `run(input)` 收到 threadId 后解析 target，按该 target 的成员表、唤醒信号、回应判断、人类世代与回应预算驱动一轮或多轮成员处理。多个成员的回复在同一个 run 内按顺序流式推送，每个成员一组 `TEXT_MESSAGE_START / CONTENT / END`；`messageId` 就是 SQLite `message.id`。run 开始时编排发一个 `STATE_SNAPSHOT`，携带本 target 的成员元数据映射（`member_id` / `display_name` / `avatar_slot`），前端自定义 assistant 消息渲染器按 messageId / 映射显示头像与名字；持久化消息行是同一份元数据的耐久正本。事件类型依据：<https://docs.copilotkit.ai/a2a/troubleshooting/event-inspector>；渲染槽依据：<https://docs.copilotkit.ai/reference/components/CopilotChatMessageView>。

**D3.3 两条调用路径。** live 路径：owner 通过 `CopilotChat` 发消息，CopilotKit handler 调用编排 agent 的 `run`，该 run 内完成本 target 的成员唤醒与回复流。CopilotChat 的发送不先走 REST：run 开始时编排把 `input.messages` 里新的 user 消息作为 human 消息落库（同一事务完成 seq / 提及 / 附件绑定 / 唤醒），再进入成员轮次；`POST /api/targets/{id}/messages` 是非 UI 的同一写路径入口，供脚本与测试使用，两者用 client message id 幂等去重。后端驱动路径：认领、自动续跑、无 live 连接时由后端唤醒编排触发的轮次，同样调用同一个编排模块；结果落库后通过全局 SSE 发布消息行，前端用 `useAgent().agent.addMessage(...)` 追加，或用消息读接口重新水合。两条路径共享同一套唤醒、回应判断、预算与轮次结果，不存在两套编排逻辑。依据：<https://docs.copilotkit.ai/a2a/threads-lifecycle> 的 Manual hydration。

**D3.4 历史回放。** SQLite 消息表是唯一正本。前端切换 target 时用 `useAgent().agent.setMessages(...)` 从后端消息读取并水合；CopilotKit 的 runner 保持进程内默认，不承担业务持久化，也不引入第二个 thread 库。实现票必须验证 `setMessages` 与流式追加不会重复渲染同一条消息；`threadId` 只作为 thread 身份与上下文，不作为第二份历史正本。

### D4 模型 provider

**D4.1 两类 provider。** 首个里程碑只接 Anthropic 与 OpenAI 兼容两类 provider；`provider:model` 解析出 provider 与 model，provider 决定缺凭证时读哪个环境变量，以及是否本机（是否需要远端数据流告知）。M1 两类都是远端；本机 provider 延后。OpenAI 兼容端点通过环境变量覆盖 base URL，仍归入 `openai` provider。

**D4.2 凭证与告知。** 缺凭证读环境变量（`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`）；库内不存模型密钥，HTTP、进程输出与事件只回掩码或「缺凭证」状态。首次启用远端 provider 之前，显式列出会离开本机的数据面（消息正文、发送者显示名、target 的显示名——含频道名称与描述、DM 对方显示名、任务标题、被点名成员的显示名）与接收方，并取得一次确认；按 provider 写 `remote_consent_scope` 的 `('model', provider)` 行，未确认时该 Agent 状态点为未启用，被点名时轮次 reason 可读，且绝不发起任何远端调用。本仓不做应用层端到端加密，产品文案不声称 E2EE。

**D4.3 测试替身。** 自动化测试使用脚本化替身，不联网、零成本。替身实现同一个 provider 适配器接口，固定四种行为：回应 / 忽略 / 失败 / 延迟；测试通过启动参数注入替身，不改变被测的 HTTP 面与 AG-UI 面。真实 provider 的适配器只在手工验证或后续集成测试中使用，不进入本规格的自动化测试成本。

### D5 长期记忆

**D5.1 落点与写回。** 长期记忆落 SQLite 表 `agent_memory`，随业务库一起在数据目录、随整目录备份与迁移。字段至少包含 `id`、`member_id`、`content`、`keywords`、`source_target_id`、`source_message_id`、`created_at`。一个成员一个逻辑集合，不按 target / 项目 / 轮次切分，因此跨 target 召回是构造事实。轮次收尾由编排自动写入一条记忆卡片：触发消息摘录 + 本成员回复摘录 + 任务上下文（若有）；关键词由确定性 tokenizer 从同一段文本提取；写回不依赖模型自述，也不额外调用模型；没有「记忆档」或「长期记忆开关」。

**D5.2 召回。** 回复前用本轮输入（触发消息、任务标题、最近上下文）的关键词检索该成员的记忆行，按关键词重合度与时间新近度排序，取固定上限（默认 8 条）注入 system prompt 的记忆段。召回只影响本轮理解，不改消息、未读、唤醒、回应纪律或预算。不引入 embedding、不做向量检索、不新增 embedding provider 或凭据面；召回质量低于语义检索是本决策接受的代价。

**D5.3 替代关系。** `~/.allibot/agents/<member_id>/reme/` 不再是落点；不创建 `reme/`，不读取旧 `MEMORY.md` / `<topic>.md`，不自动导入旧 ReMe 文件。旧仓 ADR-0034 的 ReMe 工作区被替代；旧仓 ADR-0035 的「记忆始终开启」语义保留，但「全局层未接线时才缺席」的条件在本仓 M1 不成立（本仓没有全局层），记忆始终装配。记忆可以修订、可以重复；消息 append-only、不可改。记忆行不参与搜索命中、未读、唤醒、预算或任务状态。

### D6 ADR 策略

**D6.1 编号空间。** GLOSSARY.md 里的 ADR-00xx 编号属于上一代仓库，本仓不复制它的编号空间。本仓的 ADR 从 `0001` 起，只为本仓真实做出的决策写；每条 ADR 注明它对应 / 替代了词条中的哪些旧 ADR 编号。少即是过：不满足「难以回退 / 无上下文会令人惊讶 / 真实取舍」三条件的不写。

**D6.2 本仓 ADR 清单与三条件判定。**
| ADR | 决策 | 难以回退 | 令人惊讶 | 真实取舍 | 旧 ADR 对应 / 替代 |
| --- | --- | --- | --- | --- | --- |
| 0001 | TypeScript 全栈 + CopilotKit v2 + 自写 AG-UI agent | 是 | 是（旧仓 Python / AgentScope） | 是（保留 Python、用 LangGraph、自建 WebSocket） | 对应 ADR-0010、ADR-0020；替代 Python / AgentScope 前提 |
| 0002 | CopilotKit 原生工作台形态 | 是 | 是（词条三栏 / dock / 页签） | 是（传统三栏、dock 对话、Vue Studio） | 无直接对应；旧 ADR-0038 不适用 |
| 0003 | 一个 target = 一个 thread + 一个编排 agent | 是 | 是（多成员容易被拆成多 agent） | 是（一成员一 agentId、多 thread 并排） | 对应 ADR-0010、ADR-0019、ADR-0022 |
| 0004 | 单文件 SQLite + better-sqlite3 + 显式迁移闸门 | 是 | 是（不用 ORM、启动不迁移、基线 1） | 是（drizzle、自动迁移、云数据库） | 对应 ADR-0001、ADR-0007；不复制旧 15→25 链 |
| 0005 | SQLite 记忆表替代 ReMe 文件工作区 | 是 | 是（词条 ReMe / 家目录） | 是（ReMe、embedding、记忆开关） | 替代 ADR-0034；保留 ADR-0035 的无开关语义 |

**D6.3 不写 ADR 的决策。** D4 的 provider 范围（Anthropic + OpenAI 兼容）不写 ADR：新增或替换 provider 可逆，四条纪律（`provider:model`、环境变量凭证、远端告知、库内不存密钥）是词条约束而不是本仓的新取舍，不满足「难以回退」与「真实取舍」两条。D6 自身是 ADR 流程的元决策，不写 ADR。测试 seam、模块命名、API 形状与票图属于可逆的实现决策，写在本规格与实现票里。M1 的延后范围（team / Plan / SOP、Workspace / 权限 / 审批 / MCP / Skill、联网档 / 凭据 / 容器出网、英文词条表）是范围决策，记录在本规格的 Out of Scope 与 R4，不为「暂时不做」写 ADR。

### R1 词条覆盖表

下表把 GLOSSARY.md 的 93 个词条逐条映射到「实现模块 / 是否本轮实现 / 所属票 / Avoid 约束 / 备注」。`否（后续）` 表示 M1 不实现，所属票为后续工作分解键；`部分` 表示核心行为在 M1、扩展行为延后；`是（替代）` 表示旧词条的落点被新机制替代。票号是规格内部的工作分解键，不是已存在的 GitHub issue 号；实施票在规格验收后创建。

| # | 词条 | 实现模块 | 本轮实现 | 所属票 | Avoid 约束 | 备注 |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | 成员 (Member) | domain.member | 是 | T2 | 用户、账号（本仓没有登录与账号）；session（那是临时运行状态，不是身份） | soft-delete；DM / 任务历史与 agent_config / round_outcome 保留；读路径按 deleted_at 筛选 |
| 2 | Agent | domain.member | 部分 | T2 | 机器人、bot | 核心身份 / 配置 / 唤醒 / 提及穿透在 M1；家目录、项目根、文件 / shell / Docker 工具面延后到 T11 |
| 3 | Agent 配置 (agent_config) | domain.member | 是 | T2 | 模型设置（会被读成进程级配置）；Agent 定义（身份在 member 行，这里只是它的配置） | role / model / system_prompt / enabled / 上下文窗口 / 压缩阈值 / 迭代上限 / auto_claim；workspace / permission / web 字段延后 |
| 4 | 频道 (Channel) | domain.channel | 是 | T2 | 群组、room | channel 型 target 的影子行复用 channel.id；名称与描述由频道持有 |
| 5 | 频道成员 (Channel Member) | domain.channel | 是 | T2 | 群成员、订阅者（那是连接，见订阅） | 即 channel 型 target 的 target_member 行；显式勾选 / 加入频道 / 穿透回复三条增长路径 |
| 6 | target 成员 (Target Member) | domain.target | 是 | T2 | 权限表、ACL（它不表达访问控制）；把 target 成员当作频道成员的同义词（频道成员是它在 channel 型上的读法） | 三种 kind 共用一张表与同一个键；DM 两人 / 任务单指派由写路径保证 |
| 7 | 加入频道 (Channel Join) | domain.channel | 是 | T2 | 邀请（带有待接受的含义，本形态没有邀约状态）；订阅（那是可见性语义，见订阅）；移出频道（本形态没有单频道移出入口；删除 Agent 会把它移出全部频道，见成员） | 人类面 POST /api/channels/{id}/members；幂等，响应 joined；不落系统事件消息 |
| 8 | 消息 (Message) | domain.message | 是 | T2 | 聊天记录（会被读成可编辑的会话历史）；日志（那是 console 输出） | append-only；kind ∈ {human, agent, system}；数据库触发器兜底 |
| 9 | 正文渲染 (Body Rendering) | web.render | 是 | T5 | 富文本（会被读成可自由编辑的排版）；Markdown 预览（预览暗示「临时态」，而这就是正文的正式形态）； 消息格式化（格式化会被读成改写正文，而正文 append-only） | Markdown 呈现；system 事件不作为对话气泡；提及区间仍由后端给出 |
| 10 | 附件 (Attachment) | domain.message | 是 | T2 | 文件（未指明它挂在消息上，也未必是业务对象）；上传件（只描述过程，不说清它是一条消息的附属记录） | 元数据落库、字节落数据目录；上传与绑定两步；不可改；不进搜索与成员面 |
| 11 | seq | domain.message | 是 | T2 | 序号（不说清作用域）、时间戳（seq 与时间无关，只保证单调） | 同一事务内分配；UNIQUE(target_id, seq)；渲染顺序 / 重连游标 / 人类世代共用 |
| 12 | target | domain.target | 是 | T2 | 房间（旧方案指整个共享空间，会让"作用域"与"工作台"混成一件事）；会话 | target(id, kind)；channel 型影子行；软删除保留全部行 |
| 13 | 已归档频道 (Archived Channel) | domain.channel | 是 | T2 | 删除（归档可恢复，删除不可逆）；隐藏（历史仍可读、频道仍在列表里）；回收站（本仓没有恢复删除的动作）。 | 五个写入口整体 400；历史可读、可搜索；不计总未读徽标；幂等 |
| 14 | 已删除频道 (Deleted Channel) | domain.channel | 是 | T2 | 回收站（没有恢复动作）；物理删除（行全在，只是不可见）；归档（归档可恢复且仍可读）。 | channel.deleted_at；所有频道端点 404；行全部保留；第二次删除 404 |
| 15 | 系统事件消息 (System Event Message) | domain.message | 是 | T2 | 系统通知（那是推送形态）；把事件消息当作出自对话参与者的发言 | 六个来源中 M1 实现全部（穿透加入 / 建任务 / 任务变更 / 提醒到点 / 自动续跑 / 任务指针） |
| 16 | 提及 (Mention / `@mention`) | domain.message | 是 | T2 | @ 关联、艾特 | 最左最长匹配；无引号候选必须恰好等于成员名；@ 左边界规则；解析结果含 start / end 落库 |
| 17 | 穿透 (Penetration) | orchestrator.wake | 是 | T3 | 越权（穿透是点名的送达面，不是权限面）；拉人（成员关系只随真实回复发生） | channel 上回复则先落加入系统消息再落回复；DM 一次性送达不改成员关系；不豁免预算 |
| 18 | 唤醒 (Wake) | orchestrator.wake | 是 | T3 | 通知、提醒（唤醒不承诺任何人的反应） | reason ∈ {channel-message, mention, claim, continue}；人类消息用 mandatory 标记升级，不新增 reason；team 收窄延后 |
| 19 | 回应判断 (Response Judgment) | orchestrator.round | 是 | T3 | 过滤、优先级（它们是裁剪信号的手段，不是"要不要回应"的判断） | M1 四类确定信号：mention / claim / human message / continue；team 队长任务变化延后到 T10 |
| 20 | 沉默 (Silence) | orchestrator.round | 是 | T3 | 旁白式交代 (Silent Narration)（反面词：Agent 把「我不需要说话」当成正文说出来，因此仍是一条真实 Agent 消息）；沉默说明、空回应、括注消息（会把「说了等于没说」误读成低配回应）。 | silent 是结构化状态，不是消息 kind；确定信号下 ignored / silent 按 failed 收口 |
| 21 | 轮次 (Round) | orchestrator.round | 是 | T3 | 会话、session（那是模型侧的上下文，不是本仓的处理周期） | 同一成员同时最多一轮 in-flight；重复唤醒合并，不排队、不重放 |
| 22 | 轮次结果 (Round Outcome) | orchestrator.round | 是 | T3 | 日志（那是 console 输出，落不了盘、事后查不到） | 六态 replied / ignored / failed / merged / budget-exhausted / silent；append-only |
| 23 | 上下文窗口 (Context Window) | orchestrator.context | 是 | T3 | 待读消息（那只是尚未消费的新消息）；消息截断（永久消息记录从未被修改） | 普通轮最近 40 条；自动续跑完整任务线程；历史不重新形成唤醒 / 预算 |
| 24 | 轮次结束原因 (Round Finished Reason) | orchestrator.round | 是 | T3 | 回应判断（它决定要不要回应）；轮次状态（它表达一轮的处理结论） | 正常完成 / 人类中断 / 迭代上限 / 错误；与回应状态分开；旧轮次未知 |
| 25 | 长期记忆 (Long-term Memory) | orchestrator.memory | 是 | T3 | 上下文窗口（那是本轮参考的消息）；消息正本（记忆可以修订，消息不可变）；Markdown 索引（MEMORY.md 不再是落点）；记忆档 / 长期记忆开关（已删除，没有这个配置） | SQLite agent_memory；成员级、跨 target、关键词召回、轮次收尾自动写回、无开关、无 embedding |
| 26 | 状态点 (Status Point) | orchestrator.status | 是 | T3 | 状态灯、指示灯 | online / working / error / offline；working 在进程内；error 读最近非 merged 轮次结果 |
| 27 | 成员面适配接缝 (Agent Seam) | agent.runtime | 是 | T4 | SDK 委托边界（泛指，未指明接缝在哪）；框架封装层（那个词不说清它只暴露两个形状） | 自写 AG-UI AbstractAgent 承接；一轮输出零或多条回复 + 一个轮次结果；事件是观察面 |
| 28 | 人类世代 (Human Epoch) | orchestrator.budget | 是 | T3 | 会话（会与模型侧上下文混淆）、轮次（那是单个 Agent 的处理周期） | 三种开世代动作：human 消息、owner 改派、首次认领；team 相关延后 |
| 29 | 回应预算 (Response Budget) | orchestrator.budget | 是 | T3 | 配额（会被读成按成员或按模型算的额度）；限流（那是速率，这里是代数） | 默认 3；频道可配 3 / 5 / 10；改动从下一个人类世代生效；每 target 一份 |
| 30 | 跳 (Jump) | orchestrator.budget | 是 | T3 | 轮次（一轮是单个成员的处理周期，一次跳是整条消息的投递事实） | 一条 Agent 消息投递 ≥1 个唤醒 = 1 跳；全部 in-flight 零投递不算跳；team TeamAssign 延后 |
| 31 | 预算耗尽 (Budget-exhausted) | orchestrator.budget | 是 | T3 | 静默丢弃（消息落库了，只是不再唤醒）；失败（它与"它坏了"无关） | 消息照常落库、零唤醒；每个被压制成员一条 budget-exhausted 轮次结果；team 运行记录延后 |
| 32 | 预算表 (target_budget) | db | 是 | T3 | 用量日志（那是轮次结果的逐行记录，粒度是"成员的一轮"而不是"跳"） | target_budget(epoch_seq, used)；落库；used 只由后端推进；跳数正本 |
| 33 | 结构身份 (Structural Identity) | shared.identity | 是 | T4 | 内部调用（那是实现说法，不说清它以谁的名义）、隐式认证（它不是认证） | Agent 动作由后端进程内执行，不经 HTTP；无 agent 令牌；CopilotKit handler 是人类面传输面 |
| 34 | 人类面 / 成员面 (Human Face / Member Face) | shared.identity | 是 | T4 | 内网 / 外网（那是网络位置，不是调用者类别）；私有 / 公开 API（会被读成同一面里的可见性分级） | REST / SSE 属人类面；编排 agent 与 runTargetRound 属成员面；HTTP 不自称成员 |
| 35 | 远端数据流告知 (Remote Data Flow Consent) | shared.identity | 是 | T4 | 隐私协议（它是运行时的一次确认，不是一份文档）；密钥录入（见「联网 provider 凭据」：保存的是凭据，读回只有掩码） | 按 provider 写 remote_consent_scope('model', provider)；未确认零远端调用；不存连接参数 |
| 36 | 联网档 (Web Access) | tools.web | 否（后续） | T12 | 联网开关（会被读成「一个总闸」，而它只管工具面）；隐私设置（它是能力开关，不是数据面告知） | M1 不装配 web_search / fetch；不建 channel.web_access 行为 |
| 37 | 联网 provider 凭据 (Web Provider Credential) | tools.web | 否（后续） | T12 | 密钥库（它只存联网搜索凭据，不是通用 secret store）；环境变量列表（那不是正本，只是兜底来源） | M1 不建 web_provider_credential；模型密钥只读环境变量 |
| 38 | 容器出网 (Container Egress) | tools.workspace | 否（后续） | T12 | 网络策略（本仓只有「默认无网 / 显式白名单」两态，没有通用 DSL）；防火墙（那是内核/网关层，本形态不在那层） | 依赖 Docker 后端；M1 不建 docker_egress |
| 39 | 工作台 (Workspace) | web.shell | 是（替代） | T5 | 工作区（旧方案指成员绑定的目录）；房间、共享空间（会把"呈现面"与"作用域"混成一件事） | D2 重新解释：CopilotChat 主区 + CopilotSidebar + 抽屉 / 路由；GET /api/workspace 仍是读数 |
| 40 | 已读位置 (Read Position) | domain.unread | 是 | T7 | 游标（不说清是谁的；Agent 的消费游标与 owner 的已读位置共用表但不是一个事实） | read_position(member_id, target_id, last_read_seq)；单调 max 并裁剪到当前最大 seq |
| 41 | 消费游标 (Agent Read Cursor) | orchestrator.round | 是 | T3 | 已读（那是 owner 的未读正本）；inbox（本仓没有队列，只有位置） | 复用已读位置行；只在 replied / ignored 收口推进；failed 不推进 |
| 42 | 未读 (Unread) | domain.unread | 是 | T7 | 把 system 事件消息计入未读；把 owner 自己的消息计入自己的未读；把 Agent 的消费游标当作未读正本 | 只算 target 顶层、kind ∈ {human, agent}、作者非本人；system 不计；channel + dm 汇总，task 单列 |
| 43 | 订阅 (Subscription) | http.human | 是（替代） | T5 | 通知（会被读成主动推送业务消息）；加入频道（那是成员关系） | 只保留全局 /api/events（live-only、无 id:、rotate 帧）+ CopilotKit AG-UI 流；按 target SSE 不保留 |
| 44 | 任务 (Task) | domain.task | 是 | T6 | 待办（会被读成一份清单，而它是有状态机与线程的对象）；工单（带有请求方/处理方与服务台的形态） | kind='task' 的 target + task 行；恰好属于一个频道；任务行可变、消息 append-only |
| 45 | 认领 (Claim) | orchestrator.claim | 是 | T6 | 指派（那是 owner 的动作，或 Agent 的转派）；抢单（会读成多个 Agent 竞速，本形态是编排的单点裁决）；把认领读成模型自己改数据库；把认领读成「只记了一笔、开工是另一件事」 | autonomous + auto_claim=1 + availability.ok；单事务指派 / 两条 system / target_member / in_progress / 唤醒；至多一次；不是跳 |
| 46 | 自动续跑 (Auto-continue) | orchestrator.continue | 是 | T6 | 自动重试（那是失败后的重放，续跑是成功轮次之后的继续）；心跳（没有时间语义）；把「接着干」写成正文承诺（那是没有执行面的一句话） | continue_task 结构化动作；system.task.continue；同人再唤醒；每世代 4 轮；到上限 continue_paused；不是跳 |
| 47 | 任务状态 (Task Status) | domain.task | 是 | T6 | 阶段、进度（会被读成可量化百分比，而这是有限个状态）；把状态迁移当作发言（见唤醒） | todo / in_progress / in_review / done / closed；in_review → done 需非指派者或 owner；closed 终态 |
| 48 | 任务线程 (Task Thread) | domain.task | 是 | T6 | 评论（会被读成对人不对事的留言）；子频道（它不可被再划分为频道） | task 型 target 的消息流；未读单列；M1 不做 team 的队长收口 |
| 49 | 任务看板 (Task Board) | web.detail | 是 | T6 | 任务列表（那是同一批任务的另一种呈现，不是另一个对象）；看板列名当作状态名（列名是呈现用语， 状态名是 todo/in_progress/… 这五个承重词） | 按状态分列、可按频道筛选；只暴露后端 allowed_transitions；不新造色位 |
| 50 | 指针消息 (Task Reference / Task Pointer) | domain.message | 是 | T6 | 任务链接（泛指超链接）；把 chip 当作一条独立的消息；拿 task_ref 表达跨 target 指向 | task_ref 同 target 引用；task_pointer 频道 system 消息 → 任务；部分唯一索引 + BEFORE INSERT 触发器 |
| 51 | 私信 (DM) | domain.dm | 是 | T6 | 聊天、会话（那会被读成短命的临时交谈）；懒创建（本形态不是"聊过才有"，而是显式创建 + 幂等复用） | kind='dm' 的两方 target；显式创建、按 Agent 幂等；无加入 / 离开；owner 发言唤醒对方，Agent 回复零唤醒 |
| 52 | 已归档私信 (Archived DM) | domain.dm | 是 | T6 | 删除私信（消息与 target 都还在）；回收站（没有恢复动作）；隐藏（历史仍可读，只是换了分段与可写性） | peer.deleted_at 非空 → 左栏已归档段、只读；不新增端点 / 迁移 / 表 |
| 53 | 提醒 (Reminder) | domain.reminder | 是 | T7 | 通知、闹钟（前者的推送语义本仓没有，后者只描述时间）；待办（那是任务）；把提醒的到点当成一次唤醒或一次跳 | owner 自设、一次性、本机本地时间；到点落 system 消息；不唤醒 / 不预算 / 不计未读 |
| 54 | 到点 (Due) | domain.reminder | 是 | T7 | 触发器（那是数据库对象的叫法）；闹钟（它承诺周期重复，本形态是一次性的）；把到点读成「有人打开了浏览器」（到点是后端事实，与谁在看无关） | delivered_at 标记；至多投递一次、至多补投一次；24 小时内补投，超过窗口标已错过 |
| 55 | team 模式 (Team Mode) | orchestrator.team | 否（后续） | T10 | 多智能体群聊（那是另一种产品形态）；团队频道（读成又一种频道类型）；把 team 读成"自动多人讨论"（它恰恰把发言收口给队长） | channel.mode='team' 与队长收口不在 M1；默认 autonomous |
| 56 | 队长 (Leader) | orchestrator.team | 否（后续） | T10 | 管理员、主管（那是权限角色）；owner（人类恒为 owner）；把队长当作"第一个回复的成员" | channel.team_leader_member_id 与 invalid-leader 运行记录延后 |
| 57 | TeamAssign / 分派 (Team Assignment) | orchestrator.team | 否（后续） | T10 | 任务（那是五态对象）；消息（分派不改任务行、不写消息）；把分派当"再唤醒一次"（预算与可见性都不同） | 分派计跳、team_assignment 行与预算耗尽语义延后 |
| 58 | 运行记录 (Team Run / Assignment Record) | orchestrator.team | 否（后续） | T10 | 日志（那是 console 输出）；消息（它不是对话记录，也不参与未读/搜索）；审计台账（那是迁移的 append-only 文件） | team_run / team_assignment 表与 SSE 帧延后 |
| 59 | Plan (Plan Run) | agent.plan | 否（后续） | T10 | 待办清单（会被读成用户的任务列表）；子任务（它不是任务对象，没有五态）；把 Plan 当任务看板的数据源 | plan_run / plan_task 与 TaskCreate 等工具延后 |
| 60 | SOP (SOP Run) | agent.sop | 否（后续） | T10 | 工作流引擎、自动化（会承诺本仓没有的触发器/定时能力）；流水线（那是 team pipeline）；把 SOP 当任务模板 | sop_definition / sop_run 与 executor / verifier 延后 |
| 61 | 工作区项目根 (Workspace Root) | tools.workspace | 否（后续） | T11 | 数据目录（那是业务正本与备份单位）；工作台（那是人类面）；工作区设置（那是语言/密度/主题三档的配置集合，勿混用）；把项目根当容器挂载点（Docker 里固定为 /workspace）；把 Agent 家目录当项目工作根（成员 skills/ 仅是只读第二根） | M1 不挂项目根文件工具与 shell |
| 62 | Agent 家目录 (Agent Home) | tools.workspace | 否（后续） | T11 | 工作目录（项目工作路径仍是频道项目根）；项目目录（那是 .allibot/ 所在的用户项目）；把家目录当可写沙箱（文件工具只可读成员 skills/，不可写）；把 MEMORY.md / &amp;lt;topic&amp;gt;.md 当落点（ADR-0034 起记忆在 reme/ 工作区） | M1 不建家目录；记忆落点已被 D5 移到 SQLite；规则 / skills / mcp.json 延后 |
| 63 | 全局层 / 项目层 (Global Layer / Project Layer) | tools.workspace | 否（后续） | T11 | 两层工作区（只有项目层是项目工作根）；全局配置（那是进程级设置，不是每 Agent 的素材）；把全局层当数据库或备份单位（它不在数据目录备份内） | M1 不建 ~/.allibot/ 与 &lt;workspace_root&gt;/.allibot/ 的文件布局 |
| 64 | 规则基座 (Rules Base) | tools.workspace | 否（后续） | T11 | 系统提示（那是库内 agent_config.system_prompt，三段中的第二段）；全局配置（那是进程级设置）；把规则文件当可写配置（全局层 AGENTS.md 对应用只读；项目层由项目权限档决定）；把 rules/AGENTS.md 当落点（ADR-0032 起是扁平路径） | M1 的提示只有 agent_config.system_prompt + 身份句 + 记忆段 + 本轮上下文 |
| 65 | 记忆落点 (Memory Landing) | orchestrator.memory | 是（替代） | T3 | 把项目记忆当独立集合（ADR-0034 起没有项目过滤）；把会话状态当记忆（sessions/ 不参与召回）；把 MEMORY.md 当索引（那是旧形态）；把工作区当文件工具可写目录（应用自管） | D5：SQLite agent_memory 替代 reme/ 工作区；不创建、不读取旧 ReMe 文件 |
| 66 | 工作区后端 (Workspace Backend) | tools.workspace | 否（后续） | T11 | 沙箱（本地模式不是沙箱，Docker 才是容器）；执行环境（泛指，未说明它是文件工具的根） | M1 只做 local 受限文件工具语义；docker 取值返回 validation_failed，不静默回落 |
| 67 | 权限档 (Permission Mode) | tools.permission | 否（后续） | T11 | 角色权限、RBAC（这里没有角色与账号）；"完全信任"档（不存在跳过审批的档位） | read-only / ask-writes / trusted-writes 延后 |
| 68 | 权限规则 (Permission Rule) | tools.permission | 否（后续） | T11 | ACL（它不表达访问控制，scope 是频道/Agent 而不是人）；白名单/黑名单（只有三档行为，且 deny/ask 不是名单） | permission_rule 与 allow / deny / ask 延后 |
| 69 | 审批 (Approval / HITL) | tools.approval | 否（后续） | T11 | 授权（那是权限规则）；确认框（那是呈现）；把拒绝读成 ERROR（实现事实是 DENIED，不伪造框架不会发出的事件）；把 reply_id 读成一次确认的 id（它是回复的 id，一条回复可有多批确认） | approval_request 与 600 秒等待 / 重开语义延后 |
| 70 | MCP 声明 (MCP Server) | tools.mcp | 否（后续） | T11 | 工具服务器（泛称）；密钥表（没有任何值落库）；把 MCP 当远程市场（本仓只支持显式配置的本机/远端连接）；把库内 mcp_server 行当成现行装配来源（它只是历史与迁移来源，运行期不读它）；把「Studio 能编辑 mcp.json」读成「它只是写面」（它就是唯一正本） | mcp.json / mcp_server 迁移来源 / remote consent 延后 |
| 71 | Skill | tools.skill | 否（后续） | T11 | 插件（会读成可执行扩展）；市场/商店（本仓没有远程来源）；「应用执行 / 代跑 npx skills」（它是外部 CLI，本应用只读它的落点）；把项目层旧技能字节或频道级 Skill 行读成现行装配来源 | skill 表、字节目录、三种安装来源与 migrate-skills 延后 |
| 72 | 搜索命中 (Search Hit) | domain.search | 是 | T7 | 搜索结果页（它是列表的呈现，不是命中本身）；全文检索（本形态不做分词，用这个词会承诺一个不存在的能力） | 后端子串、大小写不敏感；排除 system；三类命中；不做分词 / 模糊 / 拼音 |
| 73 | 高亮区间 (Highlight Range) | domain.search | 是 | T7 | 前端高亮（那会被读成前端自己找命中位置，正是被否的第二个落点）；正则替换（它是实现手段，不是契约） | 后端返回全部区间；前端只包标签；任务 / Agent 命中可无区间 |
| 74 | 任务命中 / Agent 命中 (Task Hit / Agent Hit) | domain.search | 是 | T7 | 搜索结果（那是呈现，不是命中本身）；把三类命中合成一个"全文检索"（本形态不做分词、不做模糊匹配，用这个词会承诺一个不存在的能力） | 任务标题 / 显示名与角色为命中本体；与消息命中同级；前端不判定 |
| 75 | Agent 详情页签 (Agent Detail Tab) | web.detail | 部分 | T8 | 标签页 / 选项卡（那是浏览器与控件库的叫法，不说清它是本页的三个分组）；把三个页签读成三个独立页面或三条路由（它们不改 URL、不重新拉取整页）；把 mcp 页签的两块读成两份数据（它们读写同一份家目录文件） | 基础信息页签 M1 可用；skills / mcp 页签以依赖 T11 的占位呈现；顺序固定 |
| 76 | 成员面板 (Member Panel) | web.detail | 是 | T8 | 成员列表（那是左栏的全工作区名单，见本机 Agent）；在线成员（它表达成员关系，不表达在线状态） | 频道成员已加入 / 未加入两段 + 加入控件；私信下不出现 |
| 77 | 成员名册 (Member Roster) | web.detail | 是 | T8 | 成员详情弹窗（会被读成面板的另一种形态，而面板不是弹窗）；成员列表（未指明范围） | 只读全名单 + 状态点；唯一动作是关闭；不是成员面板的别名 |
| 78 | 本机 Agent (Local Agents) | web.shell | 是 | T5 | Agent 成员（会被误读成频道成员）；成员列表（未指明范围） | GET /api/workspace 里 kind='agent' 的成员；不按频道过滤 |
| 79 | 补全 (Mention Completion) | web.render | 是 | T5 | 提及菜单（菜单是它的呈现，不是它的职责）；前端提及解析（解析只有后端一个落点）；全局成员补全（它只列当前 target 的 Agent） | 当前 target 的 Agent 成员；不列 owner / target 外成员；前端不解析提及 |
| 80 | 视觉契约 (Visual Contract) | web.tokens | 是 | T8 | 主题变量（会被读成可自由改值的一层）、设计 token（泛指，不说清"按名消费"这条约束） | token 名按名消费；设计系统 CSS + 产品扩展层；不复制设计系统 ADR 编号 |
| 81 | 工作台版本 (Studio Version) | web.shell | 是（替代） | T5 | 新前端 / 旧前端（会被读成两个产品）；预览版（它承载真实业务读写，不是演示） | 单一 React 工作台替代 /studio/ 与 /studio/v2/；旧 Vue 页面不迁移 |
| 82 | 头像色位 (Avatar Slot) | web.tokens | 是 | T8 | 状态色、角色色（分别属于状态点与产品角色族） | avatar_slot → --av-0…--av-4；7px 圆角方块；不承载状态或主题 |
| 83 | 档位 (Tier) | web.tokens | 是 | T8 | 色阶（会被读成同色相的明度渐变序列，那是色板而不是用途分层）、变体（泛指） | 填充 / 淡底 / 文字 / 图形四档；按对比度用途分层 |
| 84 | 角色族 (Role Family) | web.tokens | 是 | T8 | 配色组（泛指）、主题（会被读成可切换的一套） | 按角色命名的档位族；新增档位加 -deep / -graphic / -fill 后缀 |
| 85 | 词条 / 词条表 (String / String Catalog) | i18n.catalog | 部分 | T9 | 翻译文件（会被读成一份可独立漂移的副本）；i18n 配置（那是机制，不是集合） | M1 只交付简体中文；键与参数位保留；英文目录位预留不交付 |
| 86 | 语言偏好 (Locale Preference) | i18n.catalog | 是 | T9 | 界面语言（会被读成只影响前端）；浏览器语言（那是环境信号，不是本仓的取值）；把语言偏好读成"只影响这一台浏览器" | 落库；前端与后端共用同一取值；M1 可选值只有 zh-CN；历史消息不回溯 |
| 87 | 工作区设置 (Workspace Settings) | domain.settings | 是 | T9 | 偏好文件（会被读成一份可整体替换的配置文档）；全局配置（那是进程级设置，本仓的设置是库内业务数据）；把设置面当通用 key-value 存储（本轮只有明确列出的三档） | 语言偏好 / 消息密度 / 主题三档；人类面可写配置，不可写用量事实 |
| 88 | 数据目录 (Data Directory) | db.data-dir | 是 | T1 | 工作目录（会被读成进程的当前目录）；安装目录（代码不住在这里）；把 \~/.allibot/ 整个当数据目录（数据目录只是它下面的 data/） | 默认 ~/.allibot/data/；--data-dir / allibot_DATA_DIR 覆盖；allibot.db + attachments/ + schema-migrations.jsonl |
| 89 | 备份 (Backup) | db.backup | 是 | T1 | 快照（会被读成库内部的某个可回滚点）；导出（那是另一种格式，不是本仓的备份单位）；把「备了库」当完整备份（附件字节、项目文件与全局层都不在单文件里） | 迁移前整目录同级副本；备份失败不迁移；不含项目文件 / 全局层；回滚 = 恢复副本 + 旧代码 |
| 90 | Schema 版本 (Schema Version) | db.schema | 是 | T1 | 库版本（会被读成 SQLite 的版本或文件格式版本）；迁移号（号只表示形态，不表示迁移次数） | schema_meta.schema_version vs SCHEMA_VERSION；新仓基线 1；号只表示形态 |
| 91 | 版本闸门 (Version Gate) | db.schema | 是 | T1 | 兼容性检查（会被读成尽力而为的探测）；自动升级（闸门只裁决，不动数据） | 启动路径拒绝启动、迁移入口拒绝执行；不改库文件一个字节 |
| 92 | 数据迁移 (Schema Migration) | db.migrate | 是 | T1 | 自动升级（启动不会替你迁）；就地改造（迁移必须经步骤链与备份，不是随手改表）；把迁移读成"改 SCHEMA_VERSION"（号是结果，不是动作） | 显式 --migrate；备份 + 单事务 + 步骤链；未来版本拒绝；无降级；旧 15→25 链不复制 |
| 93 | 审计台账 (Audit Ledger) | db.audit | 是 | T1 | 日志（会被读成进程的 stdout / stderr）；迁移记录表（它不是库内的一张表）；把台账读成可编辑的配置（append-only，历史行不回改） | 数据目录内 append-only JSONL；每次真正执行的迁移一条；失败也记；无 HTTP 写入口 |

### R2 Seam 声明

**唯一测试 seam：后端进程的 HTTP 面。** 测试启动一个真实后端进程，使用临时数据目录与脚本化 provider，经人类面 REST（频道、消息、任务、私信、提醒、搜索、设置、迁移命令）与 CopilotKit 多路由 handler（AG-UI 的 `run` 流）驱动，经全局 SSE 观察实时帧；断言只读 HTTP 响应、SSE 帧、SQLite 数据目录的对外产物（库、备份目录、审计台账）与 AG-UI 事件序列。前端不建立第二套领域 seam：它只消费这个 HTTP 面的消息元数据契约；渲染器用组件级契约测试验证「messageId → 成员元数据 → 头像 / 名字」，不重复测领域行为。

**为什么落在这个高度。** 用 codebase-design 的词汇：编排 agent 是一个深模块——接口很小（`run(input): Observable<BaseEvent>` 与人类面端点），背后藏着唤醒、回应判断、预算、轮次、记忆、任务、私信、未读与持久化；HTTP 面是 caller 与测试共同穿越的那个 seam，leverage 最高（一条 seam 覆盖两种调用者与全部领域行为），locality 最好（失败集中在后端进程与它的数据目录，不需要在 React 组件、provider 适配器、SQL 辅助函数之间追）。再往下放（编排模块、数据库模块、provider 适配器）会得到更多浅 seam，测试会开始依赖内部形状；再往上放（浏览器 UI）会漏掉协议、持久化与预算，且需要浏览器环境。脚本化 provider 与固定时钟是注入依赖，不是第二个 seam；它们让同一个 HTTP 面在零成本、无网络、可重复的条件下运行。

**在哪个 seam 上测。** 所有领域测试、迁移测试、协议测试、任务 / 私信 / 提醒 / 搜索测试、记忆写回与召回测试都在「后端 HTTP 面」这一条 seam 上做；不按测试文件或模块列清单。前端只做消息元数据契约与视觉 token 名的静态 / 组件契约测试。

### R3 Avoid 约束

GLOSSARY.md 每条词条的 `Avoid` 列对本规格有约束力；R1 表的「Avoid 约束」列逐条复制该列，作为实现与评审的禁用词清单。设计陈述使用词条的承重词，不用 Avoid 列里的同义词替代它：成员不写成「用户 / 账号」，target 不写成「会话 / 房间」，消息不写成「聊天记录 / 日志」，唤醒不写成「通知」，轮次不写成「会话」，回应预算不写成「配额 / 限流」，正文呈现不写成「富文本 / 预览」，备份不写成「快照 / 导出」，数据迁移不写成「自动升级」，审计台账不写成「日志 / 迁移记录表」。R1 的 Avoid 列本身是约束声明，不是设计用词；规格正文（R1 表外）不使用这些词替代词条。实现票的代码、接口与文案同样受此约束；发现以 Avoid 词替代词条的设计陈述即视为缺陷。本次自检的核对命令与结果见本轮 Answer。

### R4 与词条的差异与降级

| 词条要求 | 本仓 M1 实现 | 差异理由 |
| --- | --- | --- |
| Python 运行时、`python -m allibot` 命令、AgentScope 依赖 | TypeScript 全栈；Node CLI；无 Python 进程 | D1：单一语言、共享类型、CopilotKit runtime 是 TS 优先；双语言边界会复制类型与部署面 |
| 成员面适配接缝在进程内调用 AgentScope；测试注入 AgentScope 脚本化替身 | 自写 AG-UI `AbstractAgent`；`run(input)` 发 AG-UI 事件；脚本化 provider 替身 | D1 / D3：AG-UI 是 CopilotKit 的运行时协议；自写 agent 完全控制多成员编排与流式；不引入第二个 agent 框架 |
| 长期记忆落 Agent 家目录 `reme/` 工作区，ReMe 中间件写回与检索 | SQLite `agent_memory` 表；确定性摘要写回；关键词检索注入；无开关 | D5：与单文件 SQLite 正本同库、同备份、同迁移；不新增文件权限、embedding 与凭据面；代价是召回质量 |
| 工作区后端 local / docker 双档；Docker 每个 Agent / 每个运行上下文一个容器、固定 `/workspace`、不可用时明确失败 | M1 只做 local 的受限文件工具语义；不接 Docker、不接容器、不接 shell；`workspace_backend` 的 `docker` 取值在 M1 返回 `validation_failed`，绝不静默回落 local | 容器运行时是独立运维面；M1 先跑通协作环与 CopilotKit 运行时；保留「不静默回落」的纪律，Docker 票（T11）再实现 |
| SOP：`sop_definition` / `sop_run`、executor / verifier、max_attempts、五 phase | M1 不实现；不建表、不给端点、不给 UI；SOP User Stories保留为 T10 的产品蓝图 | owner 显式启动的多步流程是独立产品面；与 CopilotKit 对话环的耦合低；先交付核心协作环 |
| 容器出网：`channel.docker_egress`、默认 `--network none`、按 host 白名单 | M1 不实现；没有 Docker，就没有出网开关；不建字段、不给端点 | 依赖 Docker 后端；没有容器时保留一个无行为的开关只会制造假读数；与 Docker 票一起实现 |
| 全局层 `~/.allibot/` + 项目层 `<workspace_root>/.allibot/` 的文件布局；`AGENTS.md` 规则基座、`skills/`、`mcp.json`、`reme/` | M1 不实现家目录 / 全局层 / 项目层；Agent 的提示只有 `agent_config.system_prompt`（+ 身份句 + 记忆段 + 本轮上下文）；记忆落点改为 SQLite；规则基座、skills、mcp.json 延后到 T11 | D5 已把记忆移出文件；再保留一个半套家目录会形成第二份正本；单文件 SQLite 正本优先；后续票可以按 T11 重新引入，但不得把记忆搬回 `reme/` |
| i18n 两语言词条表：简体中文源文案 + 英文第二语言，两份覆盖同一键集 | M1 只交付简体中文词条表；键、参数位与渲染落点保留；`locale` 落库且后端使用同一取值，但可选值只有 `zh-CN`；英文目录位预留、不交付 | 本机单人产品，M1 没有英文使用者；保留键与参数结构，使英文目录是数据增量而不是代码改造；不交付半份英文目录，避免落单键 |
| 旧工作台版本：`/studio/` 四文件零构建 + `/studio/v2/` Vue SFC + Vite | 单一 React 工作台；旧两条入口不迁移、不并存；视觉 token 名与头像色位契约沿用 | D2：CopilotKit 原生形态是 React；两版入口会形成两个产品面；旧 Vue 构建链不进入新仓 |
| 订阅：按 target 的 SSE（断线带 last_seq 重连、补拉）+ 全局 `/api/events`（live-only） | 只保留全局 `/api/events`（live-only、无 `id:`、重连后重新获取工作台读数与消息）+ CopilotKit AG-UI 对话流；按 target 的 SSE 不保留 | AG-UI 已经承载 per-target 对话流；再建一条 per-target SSE 会重复传输；全局 SSE 只承载工作台事实，连接数与 target 数解耦 |
| Schema 版本：旧仓当前 25，迁移链 15 → 25 十个严格 +1 步骤 | 新仓基线 1；第一条迁移是初始形态；后续严格 +1；不复制旧链、不补号 | 新仓零源码、没有旧库；复制旧号会让「库是哪一代形态」失去意义；显式迁移、备份、单事务、闸门、台账纪律全部保留 |
| 远端确认兼容面：`remote_consent` + `remote_consent_scope`，迁移把旧行复制过去 | 新仓只建 `remote_consent_scope`；没有旧库、没有兼容行；`('model', provider)` 行记录确认时间 | 新仓基线没有旧表；兼容面是旧仓迁移的产物；保留「按 provider 一次性确认、不存连接参数」的语义 |
| 联网档 / 联网 provider 凭据 / Agent 转派与 team 的任务变化唤醒 | M1 不实现联网工具、凭据表、容器出网；Agent 转派与 team 任务变化唤醒延后到 T10；M1 只有 owner 改派 | 这些能力依赖工具面或 team 拓扑；先交付核心协作环；延后项在 R1 标「否」并有后续票 |

### R5 User Stories 覆盖

User Stories 使用严格句式 `As an <actor>, I want a <feature>, so that <benefit>`（英文句式，术语保留 GLOSSARY 的中英并列写法），共 83 条，覆盖全部分组：1–12 协作域；13–22 唤醒与回应（含成员面适配接缝）；23–27 有界响应；28–32 身份与边界；33–36 未读与订阅；37–48 任务与私信（含提醒 / 到点）；49–53 team·Plan·SOP；54–63 Workspace·权限·审批·MCP·Skill；64–66 搜索；67–74 前端与视觉；75–77 语言与偏好；78–83 数据与版本。49–63 是 M2 及以后的产品蓝图，M1 不实现；其余为 M1 范围。每条故事只描述外部可见行为，不写内部实现。

## Testing Decisions

**好的测试。** 只测外部行为：从后端 HTTP 面发请求、读响应与 SSE 帧、读 AG-UI 事件序列、读数据目录的对外产物（库文件、备份目录、审计台账），不测私有函数、SQL 字符串、React 内部状态或 provider 适配器的私有形状。每个测试用临时数据目录与临时端口，互不共享状态；固定时钟与脚本化 provider 由启动参数注入；不联网、不产生模型费用、不依赖本机 Docker 或外部服务。

**测试的 seam。** 只有一个：后端进程的 HTTP 面（人类面 REST + CopilotKit 多路由 handler + SSE）。所有领域测试、协议测试、迁移测试、任务 / 私信 / 提醒 / 搜索测试、记忆写回与召回测试都在这条 seam 上做。前端只做消息元数据契约（messageId → member_id / display_name / avatar_slot）与视觉 token 名的组件 / 静态契约测试；不为前端建立第二套领域 seam。

**被测模块（经 seam 观察）。** `domain` 的成员、频道、消息、附件、目标成员、任务、私信、提醒、未读、搜索；`orchestrator` 的唤醒、回应判断、沉默、轮次、轮次结果、上下文窗口、结束原因、人类世代、预算、跳、预算耗尽、记忆、状态点；`agent.runtime` 的 AG-UI 事件顺序、threadId → target 映射、成员元数据映射、历史水合契约；`http.human` 的错误码、幂等、归档 / 删除筛选、SSE 帧与 rotation；`db` 的 schema、append-only 触发器、seq 唯一性、迁移步骤链、备份、版本闸门、审计台账；`shared.identity` 的远端告知、缺凭证、结构身份边界。前端 `web.render` / `web.detail` / `web.shell` 只做契约测试。

**迁移与闸门测试。** 用临时数据目录构造版本 N 的库（通过迁移 CLI 或测试夹具），运行 `--migrate`，断言：备份目录存在且内容与迁移前一致；审计台账追加一条 with from / to / 结果 / 备份路径；`schema_meta.schema_version` 等于代码常量；单事务失败时库回到迁移前形态；库的 Schema 版本高于代码版本时启动与迁移都拒绝；备份失败时迁移不执行；重复迁移是幂等或明确拒绝（按实现票固定）。新数据目录的首次 `--migrate` 断言审计台账记「空目录、无备份」。

**脚本化替身与时钟。** 脚本化 provider 固定四种行为（回应 / 忽略 / 失败 / 延迟），由启动参数选择；它不改变被测的 HTTP 面与 AG-UI 面。提醒测试不等待真实时间：构造一个到期时刻已过的提醒，重启后端触发补投；或注入固定时钟。测试中禁止真实网络、真实模型密钥、真实 Docker、真实数据目录。

**既有测试的先例。** 本仓零源码，没有既有测试可参照；本规格建立第一条模式：进程级 HTTP seam + 临时数据目录 + 脚本化 provider + 固定时钟。实现票必须沿用这条模式，不得为图省事在模块内部另开 seam；如果某条行为无法在这条 seam 上观察，先问「它是不是外部行为」，再决定是否调整接口，而不是加测试后门。

## Out of Scope

**M1 不实现的产品面（T10 / T11 / T12）：** team 模式、队长、TeamAssign / 分派、运行记录、Plan、SOP；工作区项目根、Agent 家目录、全局层 / 项目层、规则基座、工作区后端（local / Docker）、权限档、权限规则、审批、MCP 声明、Skill；联网档、联网 provider 凭据、容器出网。这些词条在 R1 标「否」，User Stories 49–63 保留为产品蓝图；实现票由后续里程碑创建。

**M1 不实现的子行为：** Agent 转派（`transfer_task`）与 team 的任务变化唤醒；本机模型 provider；embedding / 向量记忆；英文词条目录；旧 `/studio/` 与 `/studio/v2/` 页面；按 target 的 SSE；审批的 600 秒等待与重开语义；联网工具的 host 白名单；Docker 挂载与容器内固定 `/workspace`。

**明确非目标：** 登录、账号、多租户、云端同步、远程访问、移动原生应用；应用层端到端加密；远程技能市场或自动下载；多进程同时写一个数据目录；自动迁移、降级迁移、就地改表；把模型密钥、联网凭据或任何 secret 存进库；为每个成员注册 agentId；为每个 target 建第二条 thread 或第二份历史正本；用 ORM 取代手写 SQL；用 LangGraph 取代自写 AG-UI agent；用 Python / AgentScope / Vue Studio 作为实现前提。

**本规格票的范围：** 不写实现代码（无 `.ts` / `.tsx` / `.sql` 源文件）；不修改 GLOSSARY.md 正文；不新造词条、不引入 Avoid 词作为设计用词；不跑源码单元测试、构建或双轴 code-review（G-spec，本票无源码改动）；不提交 `.scratch/`、临时文件或 `node_modules`。

## Further Notes

**ADR 清单。** `docs/adr/0001-typescript-copilotkit-v2-stack.md`、`0002-copilotkit-native-workbench.md`、`0003-target-thread-orchestration-agent.md`、`0004-sqlite-better-sqlite3-and-migration-gate.md`、`0005-sqlite-memory-replaces-reme.md`。五条都满足三条件；D4 / D6 / 测试 seam / 范围决策不写 ADR 的理由见 D6.3。

**工作分解票图（规格内部键，不是 GitHub issue 号）。** T1 数据基座与迁移；T2 协作域与消息；T3 唤醒、回应与有界响应；T4 CopilotKit 运行时与编排 agent；T5 工作台前端壳；T6 任务、认领、续跑与私信；T7 未读、提醒与搜索；T8 Agent 详情、成员面板与视觉契约；T9 词条表、语言偏好与设置；T10 team 模式、Plan 与 SOP（后续）；T11 Workspace、权限、审批、MCP、Skill（后续）；T12 联网档、凭据与容器出网（后续）。建议顺序：T1 → T2 / T3 → T4 / T5 → T6 / T7 → T8 / T9；T10–T12 在 M1 验收后另立里程碑。

**CopilotKit 事实出处。** 运行时三件套（前端 / runtime / agent）与 AG-UI 连接、`CopilotRuntime` 的 `agents` 映射接受 `AbstractAgent`、自写 agent 的 `run` 与事件顺序：<https://docs.copilotkit.ai/a2a/backend/custom-ag-ui-agent>；`createCopilotRuntimeHandler` 与多路由 handler：<https://docs.copilotkit.ai/a2a/runtime-server-adapter>；`CopilotRuntime` / handler 版本差异：<https://docs.copilotkit.ai/a2a/backend/copilot-runtime>；`CopilotChat` 的 `threadId` 与历史回放 / 手动水合：<https://docs.copilotkit.ai/a2a/threads-lifecycle>；`useSingleEndpoint` 与多路由匹配：<https://docs.copilotkit.ai/a2a/intelligence/quickstart>；`CopilotSidebar`：<https://docs.copilotkit.ai/reference/components/CopilotSidebar>；消息渲染槽：<https://docs.copilotkit.ai/reference/components/CopilotChatMessageView>；AG-UI 事件类型：<https://docs.copilotkit.ai/a2a/troubleshooting/event-inspector>。

**词条缺口与口径说明。** 本轮没有发现需要新增词条的缺口；需要记录的是口径差异，不是词条矛盾：旧仓 15 → 25 的 Schema 版本链不复制，新仓基线 1；`remote_consent` 兼容表不复制，只保留 `remote_consent_scope`；按 target 的 SSE 不保留，只保留全局 SSE + AG-UI；旧 `/studio/` 与 `/studio/v2/` 不迁移；ReMe `reme/` 不再是记忆落点。以上都在 R4 或 ADR 中留痕。若实现票发现新的词条缺口，按「不自行补写词条」的纪律上抛，不在实现中发明承重词。

**风险与验证点。** CopilotKit v2 的 API 仍在演进，实现票要锁定版本并用契约测试盯住 `run` 事件顺序、`threadId` 水合与 `useSingleEndpoint` 形态；手动水合与流式追加可能重复渲染同一条消息，必须在 T4 验证；一个 run 内多成员顺序流式推送的取消 / 中断语义要在 T4 定义；SQLite 单写者假设要在 T1 的并发测试中写成「第二个进程被拒绝」；记忆关键词检索的召回质量要在 T3 用固定夹具验证「相关卡片被注入、不相关卡片不被注入」；提醒的 24 小时补投窗口要用固定时钟验证边界。

**实现注记（#12 唤醒投递与轮次最小闭环）。** 本票把唤醒投递与轮次收口收敛在两个深模块里：`orchestrator.wake`（`collectWakes`，唤醒面与 `(member_id, target_id, fromSeq, reason)` 信号）与 `orchestrator.round`（`runRound`，一轮 ↔ 至多一条 target 消息 + 一条轮次结果 + 零或多条 `merged` 行）。成员面适配接缝（`agent-seam`）只暴露「一轮输入 → 零或多条待落库回复 + 一个轮次结果」；脚本化 provider 由启动参数 `--scripted-provider reply|ignore|fail|delay` 注入，不在生产代码里按测试环境变量分支。`reply` / `ignore` / `fail` 在 `POST /api/targets/{id}/messages` 的响应返回前跑完；`delay` 是唯一的异步行为（窗口内重复唤醒合并为一条 `status='merged'`）。本票只落 `replied` / `ignored` / `failed` / `merged` 四态，`budget-exhausted` 与 `silent` 由后续票产生；`budget_consumed` 在无预算扣减时恒为 0。一条 Agent 回复自身不投递唤醒（跳与预算见 #16）——本票只保证唤醒入口由成功落库的 human / agent 消息触发，且 system 消息与重放写请求零唤醒。

**实现注记（#16 人类世代与回应预算）。** 预算表 `target_budget(target_id, epoch_seq, used, limit_value)` 落在 Schema 版本 9：`epoch_seq` 是开世代动作那条消息的 seq（没有开世代动作前是 0），`used` 是该世代内已投递的跳数，`limit_value` 是开世代时快照下来的上界——频道上界的改动因此只在下一个人类世代生效，进行中的世代继续读自己那一行快照。开世代入口 `openEpoch` 有三个调用点（human 消息落库、owner 改派落的 system 消息、#24 首次认领的「已认领」记录），每个都由写路径把消息与 `used = 0` 收进同一个事务。跳的扣减在唤醒投递之前完成（`tryConsumeJump` 是一次同步事务：读行、判上界、`used + 1`），所以上界是构造性保证而不是事后统计；`dispatchWakes` 只在「本消息至少投递一个唤醒」时扣跳，全部折叠进 in-flight 轮次（零实际投递）不扣。预算耗尽走同一条边界的另一支：消息照常落库、零唤醒、每个被抑制成员一条 `status='budget-exhausted'` 轮次结果（不是错误，状态点不受影响）。一条回复的消息也是 Agent 消息，因此 `runRound` 提交后在同一边界内把这条回复的唤醒再投递一次，Agent 之间的往返因此受同一份预算约束。人类面对 `target_budget` 没有写入口：PATCH 频道只改 `response_budget_limit`（配置类），`used` 只在开世代与投递跳两处由后端推进（ADR-0004）。

**实现注记（#18 Provider 适配器、凭证与远端数据流告知）。** 本票把 provider 口径收在 `server/src/providers.ts`（`provider:model` 解析、凭证环境变量、Base URL 覆盖、`remote_consent_scope` 的读写）与 `server/src/model-provider.ts`（真实适配器）两个模块里，两者都在成员面适配接缝之下，HTTP 面与 AG-UI 面不变。启动参数 `--provider scripted|model` 显式选择适配器，默认仍是脚本化替身：脚本化路径不查询凭证、不查询告知，测试注入路径不被生产分支污染。规格正文只规定 `OPENAI_BASE_URL` 覆盖 OpenAI 兼容端点；本票为实现与测试另加 `ANTHROPIC_BASE_URL`，语义相同（覆盖该 provider 的 API 根，仍归该 provider），未覆盖时两类 provider 都访问各自的默认接收方。缺凭证与未确认告知都让轮次以 `failed` 收口、零回复、零远端调用，reason 分别含 `credential` / `consent` 键；provider 返回的错误文本在进入 reason 前按凭证值做掩码，只有掩码形式（如 `sk-…abcd`）可能出现。真实调用只做最小可用的 chat completion（system + user → 文本），`GET /api/remote-data-flow` 的 `data_surfaces` 是告知清单本身，`receiver` 读的是实际端点（含覆盖），不暴露任何密钥。

**实现注记（#22 私信与已归档私信）。** 本票把私信收敛在 `server/src/dms.ts`：`createDm` 是唯一的 DM 写入口（显式创建、按 Agent 幂等，重复调用返回同一条 id 并以 200 区别于首次的 201），它在同一个事务里写 `target(kind='dm')` 与恰好两行 `target_member`（owner + 该 Agent）——"两人"因此由写路径保证，不提供加入 / 离开端点（`POST /api/dms/{id}/members` 落在统一 404 上）。`GET /api/dms` 是 DM 的唯一读模型（`id` + `peer{id, display_name, avatar_slot, deleted_at}`）；历史消息仍走 `GET /api/targets/{id}/messages`，不新增端点、表或迁移。已归档私信只消费已有字段：Agent 软删除后 `member.deleted_at` 非空，`GET /api/dms` 据此标记，消息与未读读数全部保留；`assertDmWritable`（由消息写路径的 `assertTargetWritable` 调用）对归档 DM 的写入返回 400 `validation_failed`，历史仍可读，对同一 Agent 再创建仍复用同一条 id。软删除同时改为只清理非 dm target 的 `target_member` 行，DM 的两行保留。唤醒面在 DM 上收窄：`collectWakes` 对 Agent 作者的 DM 消息不投递成员面唤醒（owner 发言唤醒对方、Agent 回复零唤醒，因此没有 agent→agent 循环），但被 @ 的非成员仍一次性送达（穿透），且该送达照常扣 1 跳——DM 的预算表与频道同构（每 target 一条 `target_budget`，上界取内置默认 3）。

**实现注记（#24 认领与自动续跑）。** 认领收敛在 `server/src/tasks.ts` 的 `claimTask`：建任务事务提交后，`POST /api/tasks` 调它裁决一次，事实（指派、`in_progress`、`target_member`、两条 system 记录「已认领」+「认领后自动开工」、开世代）全部落在它自己的一个事务里；唤醒与 #12 的投递接缝一致，在事务提交后经同一个 `dispatchWakes` 显式投递，不是 system 消息自动唤醒。候选面是该频道 `target_member` 里的活 Agent（按加入顺序），合取 `channel.mode='autonomous'`、`auto_claim=1`、`availability.ok`（模型 + 凭证 + provider 告知，复用 `resolveAgentAvailability`）；`claimed_at` 是「每张任务至多一次」的锁，二次认领在读到它时早退、不写任何行。世代标识取「已认领」那条的 seq（不是紧随其后的「认领后自动开工」），`used` 随开世代重置为 0；认领与续跑都不经 `tryConsumeJump`，因此不是跳、在预算耗尽的世代里也照常投递。自动续跑扩展成员面接缝的既有形状：`RoundResult` 多一个结构化 `taskAction='continue_task'`（正文承诺不算执行面），`RoundInput` 明示 `contextScope`；轮次写入路径在同一个事务里落 `system.task.continue` 并返回同人的 `reason='continue'` 唤醒，续跑轮读整个任务线程。上限按人类世代计：`round_outcome` 中该成员在该任务上、`base_seq >= target_budget.epoch_seq` 的真实轮次（`merged` 与 `budget-exhausted` 不算）到 4 轮时，第 4 次请求改落 `system.task.continue_paused` 且不再唤醒。脚本化替身新增 `--scripted-provider continue-task` 以声明该动作；本票不需要新表或迁移。二次认领无法从人类面触发，测试用 `server/test/fixtures/claim-task.mjs` 作为同一生产入口的另一个调用者观察 `claimed_at` 锁。
