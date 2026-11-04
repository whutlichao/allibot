> 本规格把 `GLOSSARY.md` 中属于 T10 与 T11 的全部词条，以及散落在其他词条里的 team / workspace 收窄与扩展条款，转写为一份可实施的 M2 规格。章节沿用 M1 规格 `docs/spec/allibot-v2-spec.md` 的七章节模板；术语沿用 GLOSSARY 的中英并列写法，每条词条的 `Avoid` 列是约束，不是同义词建议。基线是 `main` 的 `d52ae96`（M1 集成 PR #34 合并提交）：`SCHEMA_VERSION = 13`、`GLOSSARY.md` 827 行、M1 R1 表 93 个词条、M1 规格 414 行 / 83 条 User Stories、ADR 0001–0005。M2 把 Schema 推进到 21；本规格中的全部基线数字都以该 commit 为准，M1 规格的两处勘误见 Further Notes。

## Problem Statement

owner 已经有一个能跑通 M1 核心协作环的本机工作台：成员、频道、私信、任务、唤醒、回应判断、预算、轮次、记忆、未读、搜索与 CopilotKit 原生界面都已落地，业务正本在单文件 SQLite，测试只穿越后端 HTTP 面这一条 seam。但 M2 要交付的两组能力仍然只有词条、没有实现：T10 的 team 模式、队长、TeamAssign / 分派、运行记录、Plan 与 SOP；T11 的工作区项目根、Agent 家目录、全局层 / 项目层、规则基座、工作区后端、权限档、权限规则、审批、MCP 声明与 Skill。GLOSSARY.md 把这些行为写得很细，却没有一份能建票、能验收、能判断 M1 既有决策是否被悄悄改写的规格。

这个缺口有四个具体后果。其一，team 模式会改变唤醒面、预算落点与消息落点，但 M1 只实现 autonomous 频道；如果不把「谁被唤醒、什么算一次跳、成员产出落在哪里」写成决策，实现票很容易把 team 做成「多 Agent 群聊」。其二，工作区与权限面会第一次让 Agent 触碰项目文件、本机 shell、容器与远端 MCP；M1 的「没有项目根文件工具」前提不再成立，必须一次说清根边界、权限判定顺序、审批的一次性与超时。其三，M2 需要新增 schema 14–21，而 M1 的迁移链已经到 13；如果不把每一步的新表 / 新列 / 约束写清，严格 +1、单事务、备份、版本闸门与审计台账的纪律会在实现票里散掉。其四，M1 已经定下「一个 target 一个 CopilotKit thread、一个编排 agent、SQLite 单文件正本、库内不存密钥、记忆在 SQLite」五条硬决定；T10 / T11 的实现很容易在不知不觉中引入第二个 thread、第二个 agentId、第二个 MCP 正本或一份家目录记忆，必须在规格里显式裁定。

## Solution

交付一份 M2 规格，把 T10 与 T11 转写成可实施的决策集合。T10 把 team 模式作为频道级显式 opt-in：频道默认 autonomous，DM 恒为 autonomous；team 频道与它的全部 task target 只把普通唤醒投递给队长，队长是唯一把最终回复落成频道消息的人，成员产出只走 SSE 与运行记录；TeamAssign 是队长轮次内的工具调用，每次分派计 1 跳，分派记录落 team_run / team_assignment，预算耗尽落在 team_assignment 而不是成员轮次结果；认领在 team 频道停用，建任务、owner 改派与 Agent 转派都只向队长投递必答轮次；Plan 是任务 / team 轮次内的工作清单，不是任务五态；SOP 是 owner 显式启动、executor / verifier 分步、max_attempts 重试的多步流程，不写消息、不进看板 / 未读 / 搜索 / 唤醒 / 预算。

T11 把工作区与权限面收成一条可执行的边界：频道的 workspace root 是唯一可写项目根，成员 skills/ 只是 local 轮次的只读第二根；没有项目根就没有项目根文件工具与 shell；workspace backend 分 local 与 Docker 两档，Docker 按 Agent / 每个 target 上下文一个容器、固定 `/workspace`、不可用时明确失败且绝不静默回落 local；权限档只有 read-only / ask-writes / trusted-writes 三档，权限规则按 channel / Agent、tool_name、pattern 三键裁决；审批是 600 秒一批、可重开、可超时、重启即过期的 HITL 面，拒绝是 DENIED 而不是 ERROR；MCP 声明以成员家目录 mcp.json 为唯一正本，库内 mcp_server 只作历史与迁移来源；Skill 以 skill 表 + 家目录字节 + 三种显式安装来源为准，只按「成员家目录 > 全局公共库」装配。

M2 沿用 M1 的唯一测试 seam：后端进程的 HTTP 面（人类面 REST + CopilotKit handler + 全局 SSE）。脚本化 provider、固定时钟、假容器运行时与临时 HOME 根都是注入依赖，不是第二条 seam。M2 新增 schema 14–21，严格 +1、单事务、迁移前整目录备份、版本闸门与审计台账全部保留；channel 与 remote_consent_scope 的 CHECK 变更走 SQLite 表重建，迁移 runner 在事务外关闭外键、提交前跑 `foreign_key_check`，失败即回滚。凡是与 M1 ADR 或 M1 规格冲突之处，M2 在 D7 与 R4 显式裁定，不默默改写。

## User Stories
1. As an owner, I want to opt a channel into team mode (team 模式) explicitly, so that the channel funnels member output through one leader (队长).
2. As an owner, I want to select a live, enabled Agent channel member as the leader, so that exactly one member owns the team's final reply.
3. As an owner, I want team configuration writes to reject a missing, disabled, deleted, or non-member leader, so that an invalid configuration is caught at the point of writing.
4. As an owner, I want a team channel whose leader becomes unavailable to show a readable invalid-leader (配置无效) reason and never fall back to autonomous, so that I can repair the configuration instead of silently changing the collaboration topology.
5. As a leader, I want ordinary channel messages in team mode to wake only me, so that member output is funneled through one member.
6. As a leader, I want every task target of a team channel to wake only me, so that task-thread work is also funneled through one member.
7. As a leader, I want my own messages to wake nobody, so that the team does not loop on its own final reply.
8. As an owner, I want TeamAssign member output to stay out of the channel message stream, so that the channel shows the leader's final reply rather than a multi-agent transcript.
9. As an owner, I want a team run snapshot (运行记录) per target, so that I can inspect what the leader and members did without treating it as chat.
10. As an owner, I want a direct @mention of a non-leader in a team channel to remain the existing penetration (穿透) path outside the team pipeline, so that a direct call is not lost while the team's final reply still belongs to the leader.
11. As a leader, I want creating a task in a team channel to wake me once with a mandatory reply, so that I can start the team's work.
12. As a leader, I want an owner reassignment in a team task thread to wake me with a mandatory reply, so that I can react to the new assignment.
13. As a leader, I want an Agent transfer (转派) in a team task thread to wake me with a mandatory reply, so that the team learns about the handoff.
14. As an owner, I want a team task-change wake to carry a distinct readable reason (team-change), so that diagnostics never claim a claim or a mention happened.
15. As an owner, I want a team task thread to wake only the leader, so that non-leader assignees never receive task rounds.
16. As an owner, I want claim (认领) to be disabled in team channels, so that a new task stays in todo until I assign it or the leader dispatches work.
17. As an owner, I want automatic continue (自动续跑) to be unavailable in a team task thread, so that the leader-only wake rule is not bypassed.
18. As a leader, I want a TeamAssign tool that names a member and an instruction, so that I can decompose the team's work in one round.
19. As an owner, I want each TeamAssign to consume exactly one jump (跳), so that fan-out does not multiply the budget.
20. As an owner, I want a channel-target assignment to use the channel budget and a task-target assignment to use the task budget, so that one target's spending never locks another.
21. As an owner, I want a budget-exhausted assignment to record state budget-exhausted with jump_consumed=0 and skip the member, so that exhaustion is visible and not charged.
22. As a leader, I want a budget-exhausted TeamAssign to return an error tool result, so that I can stop or report the blocked work.
23. As an owner, I want a consumed jump not to be refunded when the member fails, so that the budget remains a constructive bound.
24. As an owner, I want the leader's final reply not to consume a jump, so that the team's answer is not charged as another assignment.
25. As an owner, I want team member work to produce no round outcome (轮次结果) of its own, so that the member-level outcome vocabulary stays about target rounds.
26. As a member, I want Plan tools (TaskCreate, TaskGet, TaskList, TaskUpdate) in task and team rounds, so that I can maintain a work list inside my round.
27. As an owner, I want a plan run (Plan) to be persisted per target and member, so that a work list survives the round that created it.
28. As an owner, I want Plan to stay out of the task board, unread, search, wake, and budget, so that it never becomes a second task system.
29. As an owner, I want plan_update frames on the global SSE stream, so that the panel reflects changes without polling.
30. As an owner, I want a plan item to use a plan-local status vocabulary, not the task five-state, so that the two objects cannot be confused.
31. As an owner, I want Plan tools to be available to a team assignment sub-round, so that a delegated member can keep its own work list.
32. As an owner, I want to create a SOP definition (SOP) with ordered steps, so that a multi-step process is explicit.
33. As an owner, I want each SOP step to name an executor, a verifier, and max_attempts, so that execution and checking are separate responsibilities.
34. As an owner, I want to start a SOP run explicitly, so that no Agent can trigger a process on its own.
35. As an Agent member, I want SOP creation and start to be unavailable to me, so that I cannot invent an owner-authorized process.
36. As an owner, I want a SOP run to move through pending, running, awaiting, completed, and failed, so that its phase is unambiguous.
37. As an owner, I want a failed verification to retry the step up to max_attempts, so that a transient failure is recoverable.
38. As an owner, I want an awaiting phase when the run waits for a verifier verdict or an approval, so that a paused run is distinguishable from a running one.
39. As an owner, I want a SOP run to stop in failed after max_attempts, so that a broken process does not loop forever.
40. As an owner, I want SOP runs to stay out of tasks, messages, unread, search, wake, and response budget, so that a process is not a conversation.
41. As an owner, I want to set a workspace root (工作区项目根) on a channel, so that all members share one project boundary.
42. As an owner, I want the workspace root to be the only writable project root, so that file writes cannot escape it.
43. As an owner, I want `..`, outside absolute paths, and symlinks that escape the root to be tool errors, so that traversal is not an approval question.
44. As an Agent member, I want the member skills directory as a read-only second root in local rounds with a project root, so that I can read skill references without writing them.
45. As an owner, I want no project-root file tools or shell when no workspace root is configured, so that no tools imply a project that does not exist.
46. As an owner, I want the workspace root to stay outside the data directory and outside the whole-directory backup, so that project files and business data have separate backup stories.
47. As an owner, I want an Agent home (Agent 家目录) created when an Agent is created, so that each Agent has a stable per-member asset location.
48. As an owner, I want the Agent home to hold AGENTS.md, skills/, and mcp.json, so that rules, skills, and MCP declarations share one home.
49. As an owner, I want a global layer at `~/.allibot/` and a project layer at `<workspace_root>/.allibot/`, so that global and project material resolve predictably.
50. As an Agent member, I want my system prompt assembled as global rules base, agent_config.system_prompt, and project supplement, so that reusable rules and project overrides compose.
51. As an owner, I want rules files read by the host and injected as prompt text, so that they are not writable through file tools.
52. As an owner, I want long-term memory to stay in SQLite and not in the Agent home, so that ADR-0005 remains true after the home exists.
53. As an owner, I want member skills to take priority over the global public library on a name collision, so that a member can override a shared skill.
54. As an owner, I want a channel-level workspace backend with local and Docker options, so that a channel chooses its execution environment.
55. As an owner, I want an Agent-level workspace backend override with null meaning follow the channel, so that one member can differ from its channel.
56. As an owner, I want local shell off by default, so that enabling it is a deliberate act.
57. As an owner, I want local shell explicitly enabled per channel, so that the risk switch is visible.
58. As an owner, I want every local shell call to require approval even when the mode or a rule would allow other tools, so that shell remains per-call supervised.
59. As an owner, I want Docker to run one container per Agent per target context, so that members do not share a container.
60. As an owner, I want Docker to mount the project root at `/workspace` read-write, so that project tools have one stable root.
61. As an owner, I want Docker to mount the member home and global public library read-only, so that skills can be read but not written from the container.
62. As an owner, I want the data directory not mounted into the container, so that the business database and attachments stay outside.
63. As an owner, I want Docker unavailability to make the target unavailable with a readable reason and no local fallback, so that a missing daemon never silently executes on the host.
64. As an owner, I want exactly read-only, ask-writes, and trusted-writes permission modes, so that the product has no hidden bypass level.
65. As an owner, I want channel defaults with Agent overrides for permission mode, so that a member can be stricter or looser than its channel.
66. As an owner, I want read-only to allow reads and deny writes and execution, so that the mode name is a real ceiling.
67. As an owner, I want ask-writes to ask before writes and execution, so that the default is supervised.
68. As an owner, I want trusted-writes to auto-allow only root-internal writes and still ask outside the root, so that trust is bounded.
69. As an owner, I want permission rules scoped by channel or Agent, tool name, and pattern, so that allow, deny, and ask can be targeted.
70. As an owner, I want deny to win over ask and allow across matching rules, so that a broad denial cannot be bypassed by a narrower allow.
71. As an owner, I want an approval request (审批) when a tool needs human confirmation, so that the round pauses instead of guessing.
72. As an owner, I want to confirm or deny a specific tool call, so that the decision is attached to one call, not the whole reply.
73. As an owner, I want approval decisions to accept only pending calls, be idempotent for the same decision, and return 409 for the opposite decision, so that retries are safe.
74. As an owner, I want a denied tool to return DENIED without failing the round, so that denial is a normal result, not an error.
75. As an owner, I want one reply to carry multiple approval batches, so that the Nth tool call can ask again without inventing a new reply.
76. As an owner, I want a new batch to reopen a resolved approval request and keep old decisions, so that history is not lost.
77. As an owner, I want a final denied status if any historical decision denied, so that partial approval cannot erase a refusal.
78. As an owner, I want a 600-second wait per batch and a failed closure on timeout, so that a blocked round cannot wait forever.
79. As an owner, I want one mcp.json per Agent home, so that MCP declarations have a single source.
80. As an owner, I want the management view and runtime assembly to read and write the same mcp.json, so that the displayed declaration is the live one.
81. As an owner, I want mcp.json to store env_names only, so that environment values never land in a file or the database.
82. As an owner, I want stdio MCP servers not to require remote consent, so that local processes are not treated as remote data flows.
83. As an owner, I want an invalid or missing mcp.json to disable MCP for the round with a readable reason, so that a bad file cannot crash the round.
84. As an owner, I want MCP to be hosted by the project workspace when a root exists and by a disposable runtime host otherwise, so that MCP has a cwd without becoming project data.
85. As an owner, I want an explicit export-mcp CLI that defaults to dry-run and requires apply and yes, so that old rows can be exported safely.
86. As an owner, I want a skill table with Agent-level metadata and a content hash, so that installed capabilities are auditable.
87. As an owner, I want to install a skill from a local directory, so that I can develop a skill in place and copy it in.
88. As an owner, I want to install a skill from an uploaded zip, so that I can add a packaged skill without a remote market.
89. As an owner, I want to import a skill from `~/.agents/skills/`, so that I can reuse the shared skills landing directory.
90. As an owner, I want every install to validate SKILL.md, paths, and hash, so that a malformed or escaping skill is rejected.
91. As an owner, I want skills assembled from the member home first and the global public library second, so that member overrides are predictable.
92. As an owner, I want old project-layer and channel-scoped skill sources to be ignored at runtime, so that legacy bytes cannot become a second assembly source.
93. As an owner, I want to enable or disable an installed skill, so that I can keep bytes without using them.
94. As an owner, I want the M2 migration to advance schema from 13 through 21 one strict step at a time, so that the database shape is traceable.
95. As an owner, I want a whole-directory backup before migration, so that rollback is restoring that copy.
96. As an owner, I want the migration steps and version bump in one transaction with one audit record, so that a partial upgrade cannot be committed.
97. As an owner, I want the version gate to refuse a future or mismatched database, so that no implicit downgrade or auto-upgrade happens.
98. As an owner, I want new SSE frames for team assignment, plan update, SOP update, and approval changes, so that live surfaces do not poll.
99. As an owner, I want team, Plan, and SOP to stay inside the existing target thread and SQLite database, so that my history and one-thread view do not split into parallel copies.
100. As an owner, I want M2 to leave English catalog, old Studio migration, and T12 network behavior out, so that the milestone boundary is honest.
## Implementation Decisions

### D1 Schema 迁移（v13 → v21）

**D1.1 迁移纪律。** M2 沿用 M1 的迁移纪律：显式 `--migrate`、迁移前对整个数据目录建同级整目录备份、迁移步骤与版本号更新在一个事务内收口、`schema_meta.schema_version` 与代码常量 `SCHEMA_VERSION` 比对、审计台账每次真正执行的迁移追加一行、库版本高于代码版本一律拒绝、没有降级路径。M2 的 `SCHEMA_VERSION` 从 13 推进到 21，新增八个严格 +1 的步骤（14–21），不跳号、不合并号、不重排。失败时整条链回滚，审计台账记一条 `failed`（带原因与备份路径），库保持迁移前形态。

M2 有两个步骤必须重建 SQLite 表：v14 重建 `channel` 以放宽 `mode` 的 CHECK 并新增队长列；v21 重建 `remote_consent_scope` 以放宽 `scope_kind` 的 CHECK。SQLite 不能在事务内切换 `PRAGMA foreign_keys`，因此迁移 runner 在 `BEGIN` 之前置 `foreign_keys=OFF`，在事务内执行步骤，提交前跑 `PRAGMA foreign_key_check`；任何一行违规都抛错回滚。提交成功后再恢复 `foreign_keys=ON`。这是 M1 runner 的唯一改动，不改变「单事务、先备份、后记台账」的纪律。表重建采用「建新表 → 复制全部行 → 删旧表 → 新表改名」的顺序，子表的外键文本仍指向原表名，改名后自然解析到新表；重建前后的行数、主键与既有约束由迁移测试逐项比对。

**D1.2 步骤清单。** 下表是 M2 的八步；每步的「新增」列是这一步真正落库的形状，后续步骤不重复声明。所有列名、取值与约束以本表为准；词条清单只是索引，不替代本表。

| 步骤 | 新增表 / 新列 | 约束与写路径 | 所属票 |
| --- | --- | --- | --- |
| 14 | 重建 `channel`：`mode` 的 CHECK 扩为 `autonomous` / `team`；新增 `team_leader_member_id TEXT REFERENCES member(id)` | `mode` NOT NULL DEFAULT `autonomous`；`CHECK (mode = 'team' OR team_leader_member_id IS NULL)` 与 `CHECK (mode = 'autonomous' OR team_leader_member_id IS NOT NULL)`；既有行原样复制，leader 为 NULL；队长必须是活 Agent 且是频道成员由写路径保证，数据库只保证引用存在 | T13 |
| 15 | `team_run`、`team_assignment` | `team_run`：`id`、`target_id`（REFERENCES target）、`channel_id`（REFERENCES channel）、`task_id`（REFERENCES task，可空）、`leader_member_id`（REFERENCES member）、`status ∈ {running, completed, failed, invalid-leader}`、`reason`、`started_at`、`finished_at`；`CHECK` 把 `running` 与 `finished_at IS NULL` 绑定，其余状态与 `finished_at IS NOT NULL` 绑定；触发器保证 channel 型 target 的 `task_id` 为空且 `target_id = channel_id`，task 型 target 的 `task_id` 指向该 target 且 `channel_id` 等于该任务的频道。`team_assignment`：`id`、`team_run_id`（REFERENCES team_run）、`target_id`、`task_id`（可空）、`member_id`、`state ∈ {running, completed, failed, budget-exhausted}`、`jump_consumed ∈ {0,1}`、`reply_excerpt`、`reason`、`started_at`、`finished_at`；`budget-exhausted` 必须 `jump_consumed=0`；触发器保证 assignment 的 target / task 与所属 team_run 一致。两表都不是 append-only：状态从 `running` 收口一次；`jump_consumed` 与 `started_at` 不允许改写 | T14 |
| 16 | `plan_run`、`plan_task` | `plan_run`：`id`、`target_id`（REFERENCES target）、`member_id`（REFERENCES member）、`created_at`、`updated_at`；`plan_task`：`id`、`plan_run_id`（REFERENCES plan_run ON DELETE CASCADE）、`title`（非空）、`status ∈ {pending, in_progress, completed}`、`position`（非负）、`created_at`、`updated_at`。`plan_task` 的 status 是计划项自己的三词表，不是任务五态；plan_run 按 `(target_id, member_id, created_at)` 建索引，plan_task 按 `(plan_run_id, position)` 建索引 | T15 |
| 17 | `sop_definition`、`sop_run` | `sop_definition`：`id`、`channel_id`（REFERENCES channel）、`name`、`steps`（JSON 数组，`json_valid` 且 `json_type='array'`）、`created_at`，`UNIQUE(channel_id, name)`；`sop_run`：`id`、`definition_id`（REFERENCES sop_definition）、`channel_id`、`phase ∈ {pending, running, awaiting, completed, failed}`、`state`（JSON 快照）、`current_step`（非负）、`started_at`、`updated_at`、`finished_at`；`pending/running/awaiting` 与 `finished_at IS NULL` 绑定，`completed/failed` 与 `finished_at IS NOT NULL` 绑定；触发器保证 `sop_run.channel_id` 等于定义的频道。定义在 M2 不可变；run 的状态与 state 可更新，但 `started_at` 与 `definition_id` 不可改写 | T16 |
| 18 | `channel` 新增 `workspace_root TEXT`、`workspace_backend TEXT NOT NULL DEFAULT 'local'`、`allow_local_shell INTEGER NOT NULL DEFAULT 0`；`agent_config` 新增 `workspace_backend TEXT` | `channel.workspace_backend ∈ {local, docker}`；`channel.allow_local_shell ∈ {0,1}`；`agent_config.workspace_backend IS NULL OR ∈ {local, docker}`，NULL = 跟随频道；`workspace_root` 可空，非空时写路径要求绝对路径、存在、是目录、realpath 后不在数据目录 / Agent 家目录内；既有行得到 `local` / `0` / NULL | T17 |
| 19 | `channel` 新增 `permission_mode TEXT NOT NULL DEFAULT 'ask-writes'`；`agent_config` 新增 `permission_mode TEXT`；`permission_rule` | `channel.permission_mode ∈ {read-only, ask-writes, trusted-writes}`；`agent_config.permission_mode` 同集合或 NULL（跟随频道）；`permission_rule`：`id`、`scope_kind ∈ {channel, agent}`、`scope_id`、`tool_name`（非空）、`pattern`（非空字符串，空串 = 全部调用）、`behavior ∈ {allow, deny, ask}`、`created_at`、`updated_at`、`UNIQUE(scope_kind, scope_id, tool_name, pattern)`；触发器保证 `scope_id` 在 channel / agent 上真实存在。写入 / 删除不落消息、不唤醒、不消耗预算 | T18 |
| 20 | `approval_request` | `reply_id`（主键，不引用 message：team / SOP 的 reply_id 可能永远不是消息）、`target_id`（REFERENCES target，可空）、`context_kind ∈ {round, team-assignment, sop}`、`context_id`（可空）、`tool_calls`（JSON 数组）、`decisions`（JSON 数组，默认 `[]`）、`status ∈ {pending, confirmed, denied, failed, expired}`、`requested_at`、`resolved_at`；`pending` 与 `resolved_at IS NULL` 绑定，其余状态与 `resolved_at IS NOT NULL` 绑定；`sop` 的 `target_id` 必须为空，其余 context 必须非空；按 `(status, requested_at)` 与 `(target_id, requested_at)` 建索引 | T18 |
| 21 | `mcp_server`、`skill`；重建 `remote_consent_scope` | `mcp_server`：`id`、`scope_kind ∈ {channel, agent}`、`scope_id`、`name`、`transport ∈ {stdio, http, sse}`、`config`（JSON）、`enabled ∈ {0,1}`、`created_at`、`UNIQUE(scope_kind, scope_id, name)`；运行期不读它，只作历史与迁移来源。`skill`：`id`、`member_id`（REFERENCES member）、`name`、`content_hash`（64 位十六进制 SHA-256）、`enabled ∈ {0,1}`、`source ∈ {directory, zip, agents-skills}`、`created_at`、`updated_at`、`UNIQUE(member_id, name)`；字节不在库内。`remote_consent_scope` 重建为 `scope_kind ∈ {model, mcp, docker}`、`scope_id` 非空、`PRIMARY KEY(scope_kind, scope_id)`、`confirmed_at`；既有 `('model', anthropic / openai)` 行原样保留 | T19 |

**Agent 家目录不新增数据库列。** 家目录路径由 `member_id` 派生（`~/.allibot/agents/<member_id>/`），`member` / `agent_config` 不存路径、不存 `home_created_at`、不存规则或技能内容；这样家目录可搬迁、可被进程级 `--home-dir` 覆盖，也不会形成第二份正本。家目录的创建、保留与软删除语义在 D5.2 定义。

**D1.3 版本、回滚与空库。** 空数据目录的第一次 `--migrate` 仍从 1 开始建到 21，审计台账记「空目录、无备份」；从 v13 升级时一次应用 14–21，备份一份、事务一个、台账一行（from 13 / to 21 / 结果 / 备份路径）。M2 不提供降级路径；库版本高于 21 时启动与迁移都拒绝。回滚 = 恢复迁移前的整目录备份并用 M1 代码打开，不是把 `SCHEMA_VERSION` 改回 13。迁移步骤号一旦发布就不可回收：后续里程碑只能在 21 之后追加 22、23…，即使某个 M2 子行为被删除，也不重排号。

**D1.4 不进库的东西。** Agent 家目录（`AGENTS.md`、`skills/`、`mcp.json`）、工作区项目根、skill 字节、MCP 进程与 Docker 容器都不进 SQLite；数据目录只承载 `allibot.db`、`attachments/`、`schema-migrations.jsonl` 与可丢弃的 `mcp-hosts/`。库内不存模型密钥、MCP env 值、联网凭据（T12）或 Docker registry 凭据；`mcp_server` 与 `skill` 行只存元数据与 hash，不存字节、不存密钥。备份数据目录 ≠ 备份项目文件 ≠ 备份全局层：项目根与 `~/.allibot/agents/`、`~/.allibot/skills/` 需要 owner 自己备份，M2 不把它们塞进整目录备份。

### D2 HTTP 人类面

**D2.1 结构与错误。** 所有新端点仍属于人类面，只服务 owner；成员面（team/Plan/SOP 的工具调用）继续在后端进程内执行，不经 HTTP，不引入 agent 令牌或成员身份字段。统一错误信封 `{error: {code, message, details?}}` 不变；`validation_failed` 400、`not_found` 404、`conflict` 409、`version_mismatch` 409、`internal_error` 500。归档频道的频道配置写入口整体 400；已删除频道整体 404；Agent 级配置 / MCP / Skill 不受频道归档影响。错误信息可以带绝对路径供本机 owner 诊断，但绝不带模型密钥、MCP env 值、联网凭据或容器 registry 凭据。

**D2.2 扩展的既有端点。**

| 端点 | 变化 | 成功 | 错误 / 幂等 |
| --- | --- | --- | --- |
| `GET /api/workspace` | 频道读数增加 `mode` / `team` / `workspace` / `permission_mode`；Agent 读数增加 `workspace_backend` / `permission_mode` / `home_path` 原始覆盖；顶层增加 `workspace_runtime`（Docker 可用性与镜像引用，无凭据）与 `pending_approvals` 计数 | 200 | 只读 |
| `GET /api/channels/{id}` | 增加 `mode`、`team {leader_member_id, status, reason}`、`workspace {root, backend, allow_local_shell}`、`permission_mode` | 200 | 404 已删除；归档仍可读 |
| `PATCH /api/channels/{id}` | 新增 `mode`、`team_leader_member_id`、`workspace_root`、`workspace_backend`、`allow_local_shell`、`permission_mode`；省略 = 不变，显式 `null` 只允许清空 `team_leader_member_id` 与 `workspace_root` | 200 | 400 非法值 / 非法 leader / 非法根；404 已删除；400 归档；同值重放不写新事实、不改 `updated_at` |
| `GET /api/targets/{id}/members` | 成员读数增加目标上下文的 `workspace_status`（backend、available、reason）与有效权限档；全局状态点仍按 D5.7 计算 | 200 | 404 target 不存在 |
| `GET /api/tasks`、`GET /api/tasks/{id}` | 任务载荷增加派生的 `channel_mode`（不写回 task 行） | 200 | 既有口径 |
| `GET /api/agents`、`GET /api/agents/{id}` | 增加 `workspace_backend`、`permission_mode`、`home_path`（只读派生） | 200 | 既有口径 |
| `PATCH /api/agents/{id}` | 新增 `workspace_backend`、`permission_mode`；显式 `null` = 清除覆盖、回到跟随频道；其它字段的显式 `null` 仍整体 400 | 200 | 400 / 404；同值重放不写新事实 |
| `GET /api/remote-data-flow` | 增加 `mcp_consents`、`docker_consents`；读数只含 scope 与确认时间，不含连接参数或凭据 | 200 | 只读 |
| `POST /api/remote-data-flow/{provider}/consent` | 保留 M1 的模型 provider 入口，语义不变 | 200 | 既有口径 |

**D2.3 新增端点。**

| 端点 | 语义 | 成功 | 错误 / 幂等 |
| --- | --- | --- | --- |
| `GET /api/targets/{id}/team-runs?limit=&before=` | 按时间倒序读 team_run 与嵌套 team_assignment；`limit` 1–50 默认 20 | 200 | 404 target 不存在；非 team target 返回空列表 |
| `GET /api/targets/{id}/plans?member_id=&limit=` | 读最近 plan_run 与 plan_task；可按成员过滤 | 200 | 404 target；成员不在 target 返回空 |
| `POST /api/sops` | 创建不可变 SOP 定义；body 含 `channel_id`、`name`、`steps` | 201 首次 / 200 同名同形 | 400 非法步骤 / 成员 / 频道；409 同名不同形；归档频道 400 |
| `GET /api/sops?channel_id=`、`GET /api/sops/{id}` | 读定义 | 200 | 404 |
| `POST /api/sops/{id}/runs` | owner 显式启动；返回 202 与 pending run | 202 | 404 定义；400 频道归档 / 定义无效；409 已有活动 run |
| `GET /api/sops/{id}/runs?limit=&before=`、`GET /api/sop-runs/{id}` | 读 run 列表与 state 快照 | 200 | 404 |
| `GET /api/approvals?status=&target_id=&limit=` | 审批列表；默认 pending，`status=all` 读全部 | 200 | 只读 |
| `GET /api/approvals/{reply_id}` | 读一条审批（含批次与决策） | 200 | 404 未知 reply_id |
| `POST /api/approvals/{reply_id}` | body `{tool_call_id, confirmed, rules?}`；只接受 pending；同一决定重放 200，相反决定 409，未知调用 400 | 200 | 400 / 404 / 409 |
| `GET /api/channels/{id}/permission-rules`、`PUT /api/channels/{id}/permission-rules` | 读 / 全量替换频道规则集 | 200 | 400 非法规则；404 频道；409 无；归档 400；替换原子且幂等 |
| `GET /api/agents/{id}/permission-rules`、`PUT /api/agents/{id}/permission-rules` | 读 / 全量替换 Agent 规则集 | 200 | 400 / 404；替换原子且幂等 |
| `GET /api/agents/{id}/rules?channel_id=` | 只读有效规则：全局 AGENTS.md、项目补充、拼装顺序与读取状态；无写入口 | 200 | 404 Agent；频道无根时项目段 `present=false` |
| `GET /api/agents/{id}/mcp`、`PUT /api/agents/{id}/mcp` | 读 / 替换家目录 `mcp.json`；body 恰好一个 `raw` 或 `entries`；写文件用临时文件 + 原子改名 | 200 | 400 非法 JSON / 条目；404 Agent；同内容重放 200 不重写；文件写入失败 500 |
| `GET /api/agents/{id}/skills`、`GET /api/agents/{id}/skills/{name}` | 列出已安装技能、读元数据与 SKILL.md 正文 | 200 | 404 Agent / 技能 |
| `GET /api/agents/{id}/skill-candidates` | 扫描 `~/.agents/skills/` 候选并标记已安装 | 200 | 404 Agent |
| `POST /api/agents/{id}/skills` | JSON `{source: 'directory' / 'agents-skills', path? / name?}` 安装一条 | 201 首次 / 200 同名同 hash | 400 非法 SKILL.md / 路径 / hash；404 Agent；409 同名不同 hash；归档不影响 |
| `POST /api/agents/{id}/skills/upload?name=` | 原始 zip body 安装一条 | 201 / 200 | 400 非法 zip / 路径逃逸 / 超限；409 同名不同 hash |
| `POST /api/agents/{id}/skills/import-all` | 对当前可导入且未安装的候选逐个走同一安装路径，返回逐项结果 | 200 | 400 请求非法；单项失败不阻断其它项，结果逐项标明 |
| `PATCH /api/agents/{id}/skills/{name}` | `{enabled}` 启停 | 200 | 400 / 404 |
| `DELETE /api/agents/{id}/skills/{name}` | 删除字节与行；重复删除仍 204（资源已不存在） | 204 | 404 Agent |
| `POST /api/remote-data-flow/consent` | 通用一次性确认：body `{scope_kind: 'model' / 'mcp' / 'docker', scope_id}`；与 M1 模型入口写同一行 | 200 | 400 非法 scope / 空 id；同 scope 重放 200 不刷新时间 |

**D2.4 幂等与错误细则。** `PATCH` 只有值变化才改 `updated_at`，同值重放返回同一读模型。`PUT permission-rules` 全量替换，空数组合法，任一行非法整次 400、旧集合不变。MCP `PUT` 同内容 200 且不触碰 mtime。Skill 以 `(member_id, name, content_hash)` 判等：同 hash 200、同 name 异 hash 409；删除幂等 204。SOP 定义以 `(channel_id, name)` 判等：同形 200、异形 409；start 非幂等，已有活动 run 409。审批只接受 pending；同一 `(tool_call_id, confirmed)` 重放 200、相反 409；已 resolved 的同一决定 200、新决定 409（D5.6 终止规则优先）。所有 `POST` 创建返回 id；所有 `GET` 幂等。

**D2.5 SSE 新帧。** 全局 `GET /api/events` 仍是唯一订阅流：live-only、不补拉、不发 `id:`、连接寿命到期前发 `rotate`。M2 增加五类帧：

- `team_assignment`：词条点名的帧名；payload 含 `team_run_id`、`assignment_id`、`target_id`、`task_id`、`member_id`、`state`、`jump_consumed`、`reply_excerpt`、`reason`、`occurred_at`。只发最终状态或 running → final 的状态变化，不重放。
- `plan_update`：词条点名的帧名；payload 含 `plan_run_id`、`target_id`、`member_id`、`tasks`（当前完整清单）与 `occurred_at`。
- `sop_update`：payload 含 `sop_run_id`、`definition_id`、`phase`、`current_step`、`attempt`、`occurred_at`。
- `approval.requested` / `approval.resolved`：payload 含 `reply_id`、`context_kind`、`context_id`、`target_id`、`status`、`tool_call_ids`；不含工具参数中的密钥值。
- 团队配置变化（mode / leader / invalid-leader）复用 `workspace.changed` 的 `source='team'`，不新增帧；team_run 快照由 `GET /api/targets/{id}/team-runs` 重取。

三个词条点名的帧保留词条里的下划线帧名（`team_assignment`、`plan_update`；`sop_update` 同理），M1 已有点分帧名不变；前端按事件名消费，不按 target 开第二条连接。

### D3 team 模式与编排

**D3.1 模式与队长配置。** `channel.mode` 只接受 `autonomous` 与 `team`，默认 `autonomous`；DM 恒为 autonomous，没有 mode 字段。team 是显式 opt-in：写配置不落消息、不唤醒、不改任何成员的 `auto_claim`，mode 不复制到 task 行，task target 经所属频道解析 mode。`PATCH` 把 mode 切到 `team` 时必须提供 leader；切回 `autonomous` 清空 leader；`team_leader_member_id` 的写路径要求目标是活 Agent、`enabled=1`、且是该频道的 target member。队长变化时，在同一配置事务里把新队长写进该频道全部 task target 的 `target_member`（旧队长的行保留，唤醒面仍只投队长）；否则任务线程没有可唤醒的成员。模型缺凭证 / 未确认远端告知 / Docker 不可用这类「以后可能恢复」的可用性不在写路径拒绝，而在读路径与轮次里判为 invalid-leader。

**D3.2 唤醒面收窄与 team-change 信号。** team 频道的 channel 型 target 与它的全部 task target 的普通唤醒面只有队长：普通频道消息、人类消息、任务线程消息、任务变化都只投递队长；作者是队长时零唤醒。task target 不做穿透；channel 上的 @mention 穿透仍按 M1 留在 team pipeline 之外（D3.6）。认领与自动续跑在这里不发生，因此 team 的「必须回应」信号是：被个人提及、人类消息、队长被任务变化唤醒；`claim` 与 `continue` 不出现。

`WAKE_REASONS` 从 M1 的四个值扩为五个：`channel-message`、`mention`、`claim`、`continue`、`team-change`。`team-change` 只用于队长被任务变化唤醒的那一轮；`from_seq` 取该变化的 system 记录 seq——建任务取任务线程里「任务已创建」那条，owner 改派 / Agent 转派取任务线程里那条变更记录。`channel-message` / `mention` / `continue` / `claim` 的既有含义不变。`RoundDiscipline.signal` 增加 `'team-change'`；`definite=true`，可读文案用 `reason.team_change_*`，不得复用 claim / mention / human_message 的文案。人类消息仍是 `channel-message` + 显式 mandatory 标记，不新增 reason。`reason` 只承担可读诊断与「正在回复」指示；「必须回应」仍由投递时算好的标记承载。

**D3.3 运行记录。** 队长的每个 team 轮次有一条 `team_run`：轮次开始插入 `running`，正常收口改 `completed`，轮次失败改 `failed`，队长不可用时不启动轮次、直接插入 `invalid-leader`（带可读 reason）。task target 的 run 带 `task_id`；channel target 的 run 为 NULL。`team_assignment` 在每次 TeamAssign 开始时插入 `running`，按结果收口为 `completed` / `failed` / `budget-exhausted`；`jump_consumed` 在插入时定格，之后不改。进程重启时残留的 `running` run / assignment 一律改为 `failed`，reason 记「interrupted」，已计跳不退款；这是启动时的收口，不是重放。运行记录不写消息、不计未读、不进搜索、不改 task 行；快照读 `GET /api/targets/{id}/team-runs`，实时帧是 `team_assignment`。

**D3.4 TeamAssign、跳与预算。** 队长轮次拿到名为 `TeamAssign` 的工具，入参 `{member_id, instruction}`。写路径按以下顺序裁决：

1. 校验调用者是队长、目标成员是同一频道 / task 所属频道的活 Agent 成员、且不是队长本人；目标不可用（模型 / 凭证 / 告知 / 目标工作区不可用）时不扣跳，落 `failed` assignment（`jump_consumed=0`，reason 可读），返回错误 ToolResult。
2. 解析预算 target：channel 型 target 用频道自己的 `target_budget`，task 型 target 用任务自己的 `target_budget`；不跨 target 借预算。
3. `tryConsumeJump` 原子检查并扣减。耗尽时不运行成员、落 `budget-exhausted` assignment（`jump_consumed=0`），返回错误 ToolResult；不写成员轮次结果。
4. 扣减成功后插入 `running` assignment（`jump_consumed=1`），在同一队长轮次内运行成员子轮次，结果作为 ToolResult 返回队长；成员失败也不退款，assignment 收口 `failed`。
5. 每次分派只计 1 跳，不按被分派成员数重复计；队长最终回复不扣跳——team 频道的普通唤醒面对队长作者为空，回复的通用唤醒投递在 team 模式直接跳过（不产生穿透、不扣跳）。
6. 成员子轮次不写 target 消息、不写 `round_outcome`、不进未读 / 搜索 / 预算；它的输出只进 ToolResult 与 `team_assignment.reply_excerpt`（最多 2000 个 Unicode 码点，超出截断并标注）。完整输出只回给队长，不落库。

TeamAssign 在 task 线程同样可用，并写 assignment 的 `task_id` / `target_id`；它不改 task 行，也不把成员写成 `task.assignee_member_id`。

**D3.5 任务线程、认领、转派与续跑。** team 频道的 task target 只唤醒队长：人类与 Agent 消息、owner 改派、Agent 转派都只投递队长；作者是队长时零唤醒；task target 不穿透；非队长受派者不会收到任务轮次。任务五态、task 行、任务线程消息流与 task target 的回应预算都保留。建任务时 task 行 + task target + 频道指针消息仍在同一事务，并把队长写进 task target 的 `target_member`；提交后向队长投递一轮必答，`from_seq` 取任务线程里「任务已创建」那条 system 记录，仍不认领、不改任务行、不唤醒成员、不扣跳。owner 改派走 M1 的 task 更新路径（落 system 变更记录并开新人类世代），并把新受派者写进 task target 的 `target_member`，然后向队长投递 `team-change` 必答轮次；不自我唤醒。认领在读到 `auto_claim` 之前按 `mode='team'` 早退：任务停在 todo，`claimed_at` 锁保留但不用，只能由 owner 指派或队长经 TeamAssign 分派。自动续跑在 team 任务线程不提供：队长轮次的判定不因此开口子。

`transfer_task` 是受派者可用的结构化动作：它把 task 的 assignee 改为同一频道的另一个活 Agent 成员，把新受派者写进 task target 的 `target_member`，追加一条 system 变更记录，不开人类世代，不写消息正文；在 team 频道，该变更向队长投递 `team-change` 必答轮次（作者是队长时零唤醒）；在 autonomous 频道，system 记录本身不唤醒任何人，转派结果回给调用者，新的受派者由下一条人类消息 / 续跑控制下一轮。`transfer_task` 不改变 task 的五态，不跨频道，不写 `task_id` 之外的 team 记录。

**D3.6 消息、穿透与唯一队长。** team 模式把「最终回复」收口给队长：成员子轮次的产出不落频道消息，只走 `team_assignment` SSE 与运行记录；频道里能看到的 team 最终回复来自队长。channel 上的 @mention 穿透是 M1 的既有路径，仍留在 team pipeline 之外：被点名的非队长 Agent 可被一次性送达并按 M1 决定是否回复；若它回复，它仍是普通 M1 频道消息，不是 team 分派产出，不改变队长身份，也不把该成员变成第二个队长。队长自己的最终回复不跑穿透、不扣跳；`team_change` 轮次里队长对成员的 TeamAssign 才是 team pipeline 的产出通道。task target 没有穿透例外。

**D3.7 队长提示与成员面接缝。** 队长轮次的 system prompt 仍是「全局规则基座 → `agent_config.system_prompt` → 项目补充」三段，再加一段队长职责：用 TeamAssign 拆解与分派、成员在同一轮运行、结果作为工具结果回来、成员产出不落频道消息、`transfer_task` 只在本人是受派者时可用。显示名身份句仍由 `member.display_name` 派生，与 M1 相同。

成员面接缝（一轮输入 → 零或多条待落库回复 + 一个轮次结果）不变，M2 只扩输入侧与少量可选结果字段：`RoundInput` 增加 `channelMode`、`team`（leader、is_leader、task_id、assignment 上下文）、`workspace`（root、backend、有效权限档、可用工具描述）、`plan`（是否可用）、`sop`（run / step / role / attempt / instructions）与稳定的 `replyId`；`RoundResult` 增加可选 `sopVerdict: 'pass' | 'fail'` 供 verifier 轮次使用。TeamAssign 的结果是工具调用结果，不是新的输出字段；TeamAssign 子轮次仍返回「回复 + 结果」，只是落库路径改为 assignment 而不是 message。`RoundProvider` 接口不变；脚本化 provider 增加 `team-assign`、`plan`、`sop-executor`、`sop-verifier`、`approval`、`denied`、`team-budget` 等行为，仍由启动参数注入，不在生产代码里按测试环境分支。

**D3.8 invalid-leader。** 队长不可用包括：leader id 找不到、不是活 Agent、`enabled=0`、不再是频道成员、模型 / 凭证 / 远端告知不可用、目标上下文的工作区后端不可用。每个本应向队长投递的触发（频道消息、建任务、owner 改派、Agent 转派、task 线程消息）都落一条 `team_run` `status='invalid-leader'`（reason 可读，`started_at` / `finished_at` 同时写入），零唤醒、零 assignment、零预算、不回落 autonomous。`GET /api/channels/{id}` 与工作台读数给出 `team.status='invalid'` 与同一个 reason；消息本身照常落库。队长恢复可用后，下一次触发恢复正常；不需要重新保存配置。

**D3.9 与预算 / 人类世代的边界。** TeamAssign 只推进 `target_budget.used`，不新开人类世代；建任务、Agent 转派、TeamAssign、队长最终回复都不开新世代。owner 改派仍按 M1 开 task target 的新世代；人类消息仍在落库时开 target 的新世代。team 频道上界改动仍从下一个人类世代生效；task target 继续用内置默认 3。预算耗尽时 team 模式只写 `team_assignment.state='budget-exhausted'`（`jump_consumed=0`），不写成员的 `round_outcome`；团队成员的子轮次本就没有 target 消息轮次。预算表仍是 `target_budget`，没有第二份跳数账本。

### D4 Plan 与 SOP

**D4.1 Plan（Plan Run）。** Plan 是成员轮次内的工作清单，不是任务五态、不是 target、不是消息。Plan 工具只有四个：`TaskCreate`、`TaskGet`、`TaskList`、`TaskUpdate`，名字按词条保留。Plan 工具在任务 target 与 team target 的成员轮次里自动可用，包括 TeamAssign 子轮次；DM 与 autonomous 频道的普通轮次不提供。第一次工具调用时懒创建 `plan_run`（按 target_id + member_id），`plan_task` 的字段为标题、`pending / in_progress / completed` 三词状态、顺序与时间戳；`TaskCreate` 追加到末尾，`TaskGet` / `TaskList` 读当前 run，`TaskUpdate` 改标题 / 状态。plan 的三词状态是计划项自己的字段，不是任务五态，也不出现在任务看板。

Plan 不新增 target、不写消息、不进未读 / 搜索 / 唤醒 / 预算，也不自动改 task 行；它只在运行面板与 `plan_update` SSE 展示。每个 `(target_id, member_id)` 保留最近 20 个 run 或 30 天（以先到者为准）；plan run 删除时 `plan_task` 级联删除。保留清理在创建新 run 时执行，不在启动时扫全库；删除 plan run 不是消息删除，不受 append-only 约束。读模型 `GET /api/targets/{id}/plans` 返回最近 run 与完整任务清单；Plan 工具没有 HTTP 写入口。

**D4.2 SOP 定义与启动。** SOP 是 owner 显式启动的多步流程，不是工作流引擎、不是任务模板、不是 team pipeline。`sop_definition` 含频道、名称与有序步骤；每步有标题、说明、executor_member_id、verifier_member_id、max_attempts。校验：至少 1 步、最多 20 步；`max_attempts` 1–5；executor 与 verifier 都是该频道的活 Agent 成员，且 verifier ≠ executor；频道必须存在且未归档。定义在 M2 不可变：同 `(channel_id, name)` 同形重放返回 200，不同形返回 409；没有 PATCH 定义端点。Agent 不能创建或启动 SOP：成员面没有对应工具，人类面只有 owner 能调用。

`POST /api/sops/{id}/runs` 是唯一的启动入口：同一定义至多一个活动 run（`pending / running / awaiting` 任一），否则 409；启动返回 202 与 pending run，执行异步推进。SOP run 有五个 phase：`pending`（已创建未开始）、`running`（executor 或 verifier 正在跑）、`awaiting`（等待 verifier 判定或等待审批）、`completed`（全部步骤通过）、`failed`（重试耗尽 / 审批超时 / 进程中断）。state 是 `SOPRunState` 的原样快照：当前步骤、当前 attempt、每步 executor / verifier 输出摘录、`waiting_on`（`verifier` / `approval`）、错误与时间戳。完成 / 失败不删除定义；run 保留最近 50 个或 90 天（以先到者为准），定义不自动删除，M2 也不提供删除端点。

**D4.3 SOP 执行器与校验者。** 每个步骤按「executor 轮次 → verifier 轮次」执行。两者都是成员面接缝的内部轮次，不是 target 轮次：不写消息、不新增 target、不写 `round_outcome`、不进未读 / 搜索 / 看板 / 唤醒 / 回应预算；它们的输入是步骤说明、频道上下文与该成员可用的工具集，输出是零或多条文本 + 一个结果。executor 的文本作为 verifier 的输入；verifier 必须返回结构化的 `sopVerdict='pass'|'fail'`（`RoundResult` 的可选字段），不得只靠正文措辞。`pass` 进入下一步；`fail` 在 `max_attempts` 内重试当前步骤，超过后 run 收口 `failed`，reason 记最后一次 verifier 的可读说明。SOP 不并行执行步骤，不跳步，不重排步骤。

SOP 轮次仍受 T11 的工具与审批约束：需要审批的工具调用让 run 进入 `awaiting`（`waiting_on='approval'`），使用该轮次的稳定 `replyId` 作为审批身份；批准后回到 `running`，拒绝按 DENIED 返回给轮次，超时 600 秒后 run 收口 `failed`。SOP 的 `reply_id` 是 run-scoped 的不透明标识，不要求它成为 SQLite 消息 id；`approval_request.context_kind='sop'`、`context_id=sop_run.id`、`target_id` 为空。进程重启时 `running` / `awaiting` 的 run 一律收口 `failed`，reason 记「interrupted」，残留审批按 D5.6 标 `expired`，不跨重启恢复。

SOP 与 team 模式的关系：SOP 是 owner 显式启动的内部流程，不经过唤醒面，因此 team 的「只唤醒队长」规则不适用于它；executor / verifier 可以是频道内任何活 Agent 成员，SOP 也不因此把成员产出写进频道消息。SOP 不是 team pipeline，不产生 `team_run` / `team_assignment`。

### D5 工作区、权限与审批

**D5.1 工作区项目根。** `channel.workspace_root` 是频道级项目边界，所有成员共享这一个根。写路径要求：绝对路径、存在、是目录、realpath 后不在数据目录内、不在 Agent 家目录内、不是指向根外的 symlink；存储的是 realpath 后的规范路径。读路径以它为唯一可写工作根：文件工具的相对路径从这里起算，`..`、根外绝对路径、解析后指向根外的 symlink 一律是工具错误（返回可读错误，不弹审批、不允许规则放行）。本地轮次里，成员 `skills/` 作为只读第二根：Read / Glob / Grep 可读，Write / Edit 不可写；DM 与无项目根轮次没有这套文件工具，也不挂项目根工具与 shell。项目根不在数据目录内，也不进整目录备份；备份数据目录 ≠ 备份项目文件。

运行时根不存在 / 不可读时，该 target 上的工作区不可用：`GET /api/targets/{id}/members` 的 `workspace_status` 给出 `workspace-root-missing`，轮次零工具调用并以可读 reason 失败，绝不回落到本地其它目录。更换根是配置写：不落消息、不唤醒、不消耗预算、不改历史消息或任务行。

**D5.2 Agent 家目录、全局层 / 项目层与规则基座。** Agent 家目录是 `~/.allibot/agents/<member_id>/`；创建 Agent 时创建这个目录，但不在启动时创建 `skills/` 或 `mcp.json`，也不创建记忆目录。家目录直接承载 `AGENTS.md`（规则基座，由人维护）、`skills/`（由应用写入）与 `mcp.json`（MCP 声明唯一正本）。家目录不是项目工作根；有项目根的 local 轮次才把成员 `skills/` 作为只读第二根。软删除 Agent 不删家目录，避免删掉人维护的规则与技能；重新创建同 id 不可能，家目录因此只增不回收。

全局层根是 `~/.allibot/`，项目层根是 `<workspace_root>/.allibot/`；两层成员家目录同构扁平。规则按「全局 `AGENTS.md` → `agent_config.system_prompt` → 项目补充 `<workspace_root>/.allibot/agents/<member_id>/AGENTS.md`」拼装，项目补充在冲突时胜出；文件由宿主读出后作为提示文本注入，不是文件工具的工作文件，应用不写 `AGENTS.md`。任一段缺失或不可读时只有该段缺席，轮次继续。技能只按「成员家目录 `skills/` > 全局公共库 `~/.allibot/skills/`」装配，同名时成员家目录优先；技能装配与 workspace 无关，DM 与无项目根频道同样生效。MCP 只以成员家目录 `mcp.json` 为准，D6 详述。长期记忆仍落 SQLite `agent_memory`，不搬进家目录、不创建 `reme/`、不读取旧 `MEMORY.md` / `<topic>.md`。

项目层旧技能字节 `<workspace_root>/.allibot/skills/<scope_id>/` 与旧频道级 Skill 行保留但装配忽略；不回填、不自动删除。进程级可选 `--home-dir` / `allibot_HOME_DIR` 覆盖全局层根，默认 `~/.allibot/`；它只用于部署与测试隔离，不落库、不提供 HTTP 写入口。测试用临时 HOME 根，绝不写真实 `~/.allibot/`。

**D5.3 工作区后端。** `channel.workspace_backend` 默认 `local`，`agent_config.workspace_backend` 的 NULL = 跟随频道。local 只开受限文件工具，本地 shell 默认关闭；`channel.allow_local_shell` 是显式开关，没有 Agent 覆盖。Docker 是每 Agent / 每个 target 上下文一个容器：首次需要工具时按 `(member_id, target_id)` 懒创建，进程内复用，不跨 target 共享，不跨进程复用；进程退出时停止并删除本进程创建的容器，启动时清理带本应用标记的残留容器。容器内项目根固定挂到 `/workspace`（rw）；成员家目录挂到 `/agent-home`（ro）；全局公共库挂到 `/skills`（ro）；数据目录不挂。文件 / shell 工具与 stdio MCP 在容器内执行，http / sse MCP 由宿主进程连接；工具进程只拿到环境 allowlist 与 MCP `env_names`，不拿模型密钥或联网凭据。

Docker 不可用（无 daemon / 镜像缺失 / 镜像拉取失败 / 镜像 consent 缺失 / 容器创建失败）时，该 target 上的工作区不可用：`workspace_status` 给可读 reason（`docker-unavailable` / `docker-image-missing` / `docker-consent-missing` 等），状态点在目标上下文显示未启用，轮次零工具调用并以可读 reason 失败，绝不静默回落 local shell 或 local 文件工具。镜像引用是进程级配置 `allibot_DOCKER_IMAGE`（默认 `node:22-bookworm-slim`）；M2 不构建镜像、不存 registry 凭据；镜像不在本机时，必须先有 `('docker', image_ref)` 的一次性远端确认才允许拉取，未确认就失败。M2 不实现容器出网策略：`docker_egress`、`--network none` 默认、host 白名单属于 T12，M2 不对容器网络做承诺（见 Out of Scope 与 R4）。

**D5.4 local shell 与工具环境。** local shell 在 `allow_local_shell=1` 之前不可用；开启后每次调用都走审批，权限档、`allow` 规则都不能把它变成自动执行；`deny` 规则可以拦下。local shell 无沙箱，cwd 是项目根；这是明确的已知风险，不把 local 模式说成沙箱。工具进程的环境只保留 PATH、HOME、LANG、TERM 等运行必需项与 MCP `env_names` 显式声明的变量；模型 provider 密钥、联网 provider 凭据、数据库路径以外的 secret 不注入。工具输出进入轮次前不写日志、不落库；审批摘要只保留工具名与必要的可读参数，不保留 env 值。

**D5.5 权限档与权限规则。** 产品只暴露 `read-only` / `ask-writes` / `trusted-writes` 三档，默认 `ask-writes`；频道给默认值，Agent 可覆盖（NULL = 跟随频道）。DM 没有频道，用 Agent 覆盖或默认 `ask-writes`；task 跟随所属频道。`BYPASS` / `DONT_ASK` 不是本仓能力，来自配置或 API 的取值一律 400 `validation_failed`。

判定顺序固定：

1. **硬边界**：root 逃逸直接错误，不进入审批；`read-only` 下写 / 执行直接 DENIED（allow 规则不能把它变成写）；`allow_local_shell=0` 时 shell DENIED；Docker / 工作区不可用时工具不可用。硬边界优先于规则。
2. **规则合并**：同键（scope_kind + scope_id + tool_name + pattern）的 Agent 行覆盖频道行；不同键并存。对一次调用，所有匹配行按 `deny > ask > allow` 合并：任一 deny 即 deny，否则任一 ask 即 ask，否则任一 allow 即 allow。
3. **模式默认**：没有匹配规则时，`read-only` 读放行、写 / 执行 deny；`ask-writes` 读放行、写 / 执行 ask；`trusted-writes` 读放行、根内文件写放行、其它写 / 执行 ask。`trusted-writes` 的「根外仍要审批」由第 2 步的规则与第 3 步的默认共同保证；root 逃逸仍是硬错误，不是审批。
4. **硬审批**：local shell 无论规则如何都必须 ask（除非 deny）；这是第 1 步之外的第二条硬闸。

工具分类：`Read` / `Glob` / `Grep` 是读；`Write` / `Edit` 是写；`Bash` 是执行；MCP 工具是执行（没有可信的只读元数据）；`TeamAssign`、`transfer_task`、Plan 的四个工具是编排内部动作，不经权限档与审批，也不写文件 / 网络。`tool_name` 精确匹配；MCP 工具名写作 `mcp:<server>/<tool>`，其它未知内建名在写规则时 400。`pattern` 是大小写敏感的 glob：文件工具匹配根相对 POSIX 路径（`*` 不跨 `/`，`**` 跨目录），`Bash` 匹配命令串（`*` 任意字符），MCP 匹配稳定序列化后的参数 JSON；空串 = 该工具全部调用。没有正则、没有隐式前缀匹配。权限规则的写入 / 删除不落消息、不唤醒、不消耗预算；`PUT` 全量替换，失败保持旧集合。

**D5.6 审批（Approval / HITL）。** 一轮里工具被判定为 ask 时，编排为当前回复分配一个稳定的 `reply_id`（若该轮之后落消息，这个 id 就是消息 id；team assignment / SOP 的 reply_id 可以永远不是消息），落一条 `approval_request`（pending，带工具调用与决策，不存凭证），发 `approval.requested`，然后等待。人类面 `POST /api/approvals/{reply_id}` 提交 `{tool_call_id, confirmed, rules?}`：只接受 pending；同一 `(tool_call_id, confirmed)` 重放 200，相反结论 409，未知调用 400；`rules?` 是完整权限规则数组，与决定同一事务写入，任一行非法则整次 400 且决定不生效。

一条 reply 可以有多个批次：第 N 个需要确认的调用到达时，若记录已 resolved，则重开为 pending——合并新调用进 `tool_calls`、清空 `resolved_at`、把 `requested_at` 移到这一批的起点、只发布新调用；既有 `decisions` 作为历史保留。重复登记同一批调用是幂等返回，不重开；`failed` / `expired` 是终止态，迟到登记不复活（D2.4 / R4）。收口判据是全部历史决策：任一历史决定为拒绝，最终 status 仍是 `denied`；全部批准才是 `confirmed`。拒绝的工具结果是 `DENIED`（工具未执行，本轮仍可继续），不是 ERROR；被拒绝不会自动把轮次判 failed。默认等待 600 秒，每批重开时按新批次起点重新起算；超时收口 `failed`，该轮次以可读 reason 失败。进程重启时残留 pending 一律标 `expired`，不跨重启恢复；对应的 team run / SOP run 在启动收口为 `failed`（reason interrupted）。

审批列表 `GET /api/approvals` 默认 pending，`status=all` 读全部；`GET /api/approvals/{reply_id}` 返回批次、调用与决策。审批载荷不含模型密钥、MCP env 值、联网凭据或完整工具环境；工具参数中形如密钥的字段在入库前掩码。team assignment 的审批 `context_kind='team-assignment'`、`context_id=assignment.id`、`target_id` 为该 target；SOP 的审批 `context_kind='sop'`、`context_id=sop_run.id`、`target_id` 为空；两者与普通轮次共用同一审批面。

**D5.7 状态点与目标上下文可用性。** 全局四态仍按 M1：`disabled` / `model-missing` / `consent-missing` / `credential-missing` 让成员未启用；`working` 是进程内 in-flight；`error` 读最近非 merged 轮次结果。工作区可用性是**目标上下文事实**，不聚合进全局状态点：同一 Agent 可在一个频道因 Docker 不可用而不能跑，在另一个频道仍可用。`GET /api/targets/{id}/members` 的 `workspace_status` 与轮次 reason 承载 `workspace-root-missing` / `docker-unavailable` / `docker-image-missing` / `docker-consent-missing`；成员面板与队长无效判定消费它。这是对「Docker 不可用时成员状态点为未启用」的按 target 细化（R4）。队长在目标上下文不可用时按 D3.8 记 invalid-leader。

### D6 MCP 与 Skill

**D6.1 MCP 声明与装配。** MCP 声明的唯一正本是成员家目录 `~/.allibot/agents/<member_id>/mcp.json`；管理面（条目结构化表单与原文文本域）与运行期装配读写同一份文件。文件形状是一个对象，含 `servers` 数组；每个条目有 `name`、`transport ∈ {stdio, http, sse}`、`enabled`，stdio 另有 `command` 与 `args`，http / sse 另有 `url`，三种都可带 `env_names`（只存变量名，不存值）。M2 不接受 `headers` / `headers_env` / 内联密钥等字段；远端鉴权若需要，只能通过 `env_names` 指向宿主环境变量，由工具进程自己读取。条目名在同一文件内唯一；结构化 `PUT` 拒绝重复名、未知字段、transport 与字段不匹配（stdio 无 url、http/sse 无 command）的条目。文件缺失 = 本轮不装配 MCP，不报错；文件非法（JSON 坏、schema 坏、任一条目坏） = 整份文件不装配，本轮 MCP 为零，可读提示只进 `RoundOutcome.reason` 与管理面诊断，不伪造半套 MCP。

`mcp.json` 的写路径是原子替换：写临时文件、校验、rename 覆盖，保留 0600 权限；同内容重放不触碰 mtime。管理面 `PUT` 的 `entries` 会序列化为规范 JSON，`raw` 保留用户文本；两者不能同时给。文件由应用写入，但它是唯一正本，不是「写面」；运行期不读 `mcp_server` 表。stdio MCP 在 local 后端是宿主子进程，cwd 为项目根；在 Docker 后端通过 `docker exec -i` 在 Agent 容器内运行，cwd 为 `/workspace`；http / sse MCP 由宿主进程连接，不依赖容器网络。MCP 的宿主：有项目根时用项目 workspace；无项目根（DM / 未配置项目根的频道）时用 `<data_dir>/mcp-hosts/<session_id>/` 这个不带项目文件工具的运行期宿主，可丢弃、不进备份。DM 与频道共用同一份 `mcp.json`，但 DM 不因此获得项目文件权限。

远端（http / sse）MCP 未确认数据面时不连接：`remote_consent_scope` 的 `('mcp', server_name)` 行是唯一确认事实；stdio 不需要确认。远端确认是 per server name 的一次性事实，改名要重新确认；确认只记「何时确认过」，不存 URL、命令、env 值或凭据。未确认的服务器不装配、零连接，诊断可读；已确认的远端服务器仍受权限档 / 规则 / 审批约束（MCP 工具按执行类处理）。`remote_consent_scope` 的 `('docker', image_ref)` 行同理，用于镜像拉取的一次性确认（D5.3）。

**D6.2 库内 mcp_server 与 export-mcp。** `mcp_server` 表只作历史与迁移来源，运行期绝不读它；`scope_kind='channel'` 的旧行保留但装配忽略，不回填、不静默启用。旧 Agent 级行经显式 Node CLI 子命令 `export-mcp` 导出到家目录 `mcp.json`：默认 dry-run；必须同时给 `--apply` 与 `--yes` 才写；写前备份现有 `mcp.json` 并落一份清单；同名不同形的条目整体拒绝，不部分写入；不删除库行；只复制旧行上已有的远端确认行，不代做新确认；旧仓命令 `migrate-mcp` 已退役。新仓的空 `mcp_server` 表也保留这个命令，便于从旧库导入；启动时绝不自动导出或迁移。

**D6.3 Skill 的安装、字节与装配。** `skill` 表存 Agent 级元数据与内容 hash；字节写入 `~/.allibot/agents/<member_id>/skills/<name>/`，不依赖 workspace。三种来源：本机目录、上传 zip、从 `~/.agents/skills/<name>/` 导入；都校验 `SKILL.md`、安全 slug、路径无 `..` / 绝对路径 / 包外 symlink、内容 hash。限制：单技能 200 文件、解压后 5 MiB、zip 5 MiB。hash 是归一化文件清单的 SHA-256；同 `(member_id, name)` 同 hash 200、不同 hash 409。`source` / `enabled` / 删除与重复删除 204。技能只按「成员家目录 > 全局公共库」装配，DM / 无根频道同样生效；正文是提示素材，不是插件、不是权限来源。旧频道级行与项目层字节保留但装配忽略；新表只写 Agent 级行。

技能只按「成员家目录 `skills/` > 全局公共库 `~/.allibot/skills/`」装配，同名时成员家目录优先；技能装配不依赖 workspace，DM / 未配置项目根的频道同样生效。技能正文是提示素材，不是可执行插件、不是权限来源：它不能让模型获得未装配的工具，也不能绕过权限档 / 规则 / 审批。local 有项目根的轮次里，文件工具可只读成员 `skills/`；Docker 把成员家目录与全局公共库只读挂载；DM / 无项目根轮次仍有技能提示，但没有读取技能文件的项目根文件工具。`scope_kind='channel'` 的旧 Skill 行与项目层旧字节 `<workspace_root>/.allibot/skills/<scope_id>/` 保留但装配忽略，不回填、不自动删除；新 `skill` 表只写 Agent 级行，旧频道级行不导入。

**D6.4 migrate-skills。** 旧技能迁移由显式 Node CLI 子命令 `migrate-skills` 执行：默认 dry-run，`--apply --yes` 才动手；启动时绝不自动迁移。它只处理旧来源到成员家目录 / Agent 级行的映射，保留旧字节与旧行（不删、不回填），不把项目层旧技能变成现行装配来源。新仓没有旧数据时命令是空操作并给出可读清单。

**D6.5 Agent 详情页签。** Agent 详情仍是三个分组，顺序固定：基础信息和配置 → skills → mcp。基础信息页签显示 workspace / permission 原始覆盖与家目录路径；skills 页签左栏列表（名字、hash 前缀、启停态）、右栏元数据 + `SKILL.md` 正文 + 删除，顶部有单条导入、刷新候选、全部导入；mcp 页签上块是结构化条目表单，下块是同一文件的原文文本域，两块读写同一份文件。页签是呈现层分组，不改 URL、不落库、不新建 target；切页签不丢未提交草稿，保存条是全页级。技能正文与 MCP 原文按配置文本呈现，不按对话 Markdown 气泡呈现。

### D7 与 M1 既有决策的兼容

**D7.1 五条硬决定的延续。**

| M1 决定 | M2 处理 | 是否冲突 |
| --- | --- | --- |
| ADR-0001：TypeScript 全栈、CopilotKit v2、自写 AG-UI agent、单一运行时 | M2 不加 Python、不加第二 agent 框架、不加第二运行时；新能力都在既有编排 agent 内 | 否 |
| ADR-0002：CopilotKit 原生工作台、单一 React 工作台、抽屉 / 路由承载非对话面 | M2 只扩展 Agent 详情 skills / mcp 页签、审批面板、运行面板与团队配置；旧 `/studio/` 不迁移 | 否 |
| ADR-0003：一个 target = 一个 CopilotKit thread + 一个编排 agent | team 子轮次、Plan、SOP 都不创建 target / thread / agentId；team 仍是一个 target 一个 thread，成员子轮次在同一队长轮次内；team 最终回复由队长落在同一 thread | 否 |
| ADR-0004：单文件 SQLite + better-sqlite3 + 显式迁移闸门 | v14–21 全部落同一 `allibot.db`；严格 +1、单事务、备份、闸门、审计不变；表重建只改 shape，不改备份单位 | 否 |
| ADR-0005：记忆落 SQLite `agent_memory`，无开关、无 embedding | Agent 家目录在 M2 出现，但记忆不搬进去；不创建 `reme/`，不读旧 `MEMORY.md` / `<topic>.md`；家目录只承载规则 / 技能 / mcp.json | 否 |

**D7.2 与 M1 规格的衔接与显式裁定。** M1 D1.6 只允许 `channel.mode='autonomous'`，M2 扩为 `autonomous` / `team`；M1 D1.8 / R4 说 `workspace_backend='docker'` 在 M1 返回 `validation_failed`，M2 把它变成真实 local / Docker 两档；M1 R1 把 T10 / T11 标为后续实现，M2 实现它们。这些都是 M1 已声明的延后范围，不是静默改写。`WakeReason` 四值扩为五值（新增 `team-change`）；`RoundDiscipline.signal` 四类扩为五类；`StatusPointView` 仍是全局四态，M2 只加目标上下文 `workspace_status`。`remote_consent_scope` 用 v21 重建为 `model / mcp / docker` 并保留既有行。成员面输出形状「零或多条回复 + 一个结果」不变；`sopVerdict` 是可选结果字段。没有 M1 ADR 需要替代或重写；实现票若发现冲突，按 ADR-0003 / ADR-0004 优先，不允许另开 thread / 正本 / seam。

### D8 ADR 策略

**D8.1 新增三条 ADR。** 三条件（难以撤销、脱离上下文会令人意外、真实权衡）全部满足的决策才写 ADR；M2 新增三条，编号从 0006 起连续、不跳号：

| ADR | 决策 | 难以撤销 | 令人意外 | 真实权衡 |
| --- | --- | --- | --- | --- |
| 0006 | Docker 工作区后端：每 Agent / 每个 target 上下文一个容器、固定 `/workspace`、家目录 / 全局技能只读、不可用不回落 | 是（容器生命周期与挂载边界） | 是（local 不是沙箱，Docker 才是容器） | 是（共享容器 / 宿主执行 / 静默回落 local） |
| 0007 | 权限档 + 权限规则 + 审批的唯一工具闸门：read-only 硬顶、trusted-writes 只自动放行根内写、local shell 逐次审批、600 秒 HITL | 是（安全边界与审计） | 是（拒绝是 DENIED，不是 ERROR；同一 reply 可多批确认） | 是（RBAC / BYPASS / 只靠规则不靠审批） |
| 0008 | MCP 声明以家目录 `mcp.json` 为唯一正本，库内 `mcp_server` 只作迁移来源 | 是（正本位置与迁移命令） | 是（库表存在但运行期不读） | 是（库内行为正本 / 双写 / 远程市场） |

**D8.2 不写 ADR 的决策。** team 模式、队长、TeamAssign、运行记录、Plan、SOP 是 GLOSSARY 已经定义的语义；M1 ADR-0003 已经为「未来 team 仍在一个 thread / 一个编排 agent 内」留了裁定。本规格把它们落成 D3 / D4 的实现决策，不重复写 ADR。HTTP 端点、SSE 帧名、schema 步骤号、测试替身、模块命名与保留期都是可逆或可从本规格恢复的实现决策；迁移纪律已由 ADR-0004 覆盖；「不写代码 / 不改 GLOSSARY / 不改 M1 规格」是本票的范围决策，不写 ADR。少即是过：不为「暂时不做 T12」写 ADR。

### R1 词条覆盖表

本表把 T10 / T11 的核心词条、散落条款涉及的跨节词条，以及需要明确「不做」的 T12 / 目录 / 工作台版本行，逐条映射到实现决策。列结构沿用 M1 R1 的核心列（词条 / 本轮是否实现 / 对应决策）；M1 的 Avoid 与备注列由 R3 与 D 节承载。`本轮实现` 取 `是` / `是（替代）` / `部分` / `否（T12）`；`对应实现决策` 指向 D 节；`所属票` 是本规格内部的工作分解键，不是 GitHub issue 号；User Stories 的分组覆盖见 R5。T10 / T11 的每一行都是 `是`（没有 `部分`），T12 的三行是 `否（T12）`，英文词条表是 `部分`，工作台版本是 `是（替代）`。核对命令与 `missing=0` 结果见 R1 末尾。

| # | 词条 | 实现模块 | 本轮实现 | 所属票 | 对应实现决策 |
| --- | --- | --- | --- | --- | --- |
| 1 | team 模式 (Team Mode) | orchestrator.team | 是 | T13 | D3.1 / D3.2 |
| 2 | 队长 (Leader) | orchestrator.team | 是 | T13 | D3.1 / D3.8 |
| 3 | TeamAssign / 分派 (Team Assignment) | orchestrator.team | 是 | T14 | D3.4 |
| 4 | 运行记录 (Team Run / Assignment Record) | orchestrator.team | 是 | T14 | D3.3 |
| 5 | Plan (Plan Run) | agent.plan | 是 | T15 | D4.1 |
| 6 | SOP (SOP Run) | agent.sop | 是 | T16 | D4.2 / D4.3 |
| 7 | 唤醒 (Wake) | orchestrator.wake | 是 | T14 | D3.2 |
| 8 | 回应判断 (Response Judgment) | orchestrator.round | 是 | T14 | D3.2 |
| 9 | 沉默 (Silence) | orchestrator.round | 是 | T14 | D3.2 |
| 10 | 人类世代 (Human Epoch) | orchestrator.budget | 是 | T14 | D3.5 / D3.9 |
| 11 | 回应预算 (Response Budget) | orchestrator.budget | 是 | T14 | D3.4 / D3.9 |
| 12 | 跳 (Jump) | orchestrator.budget | 是 | T14 | D3.4 / D3.9 |
| 13 | 预算耗尽 (Budget-exhausted) | orchestrator.budget | 是 | T14 | D3.3 / D3.4 |
| 14 | 任务 (Task) | domain.task | 是 | T14 | D3.5 |
| 15 | 任务线程 (Task Thread) | domain.task | 是 | T14 | D3.5 |
| 16 | 认领 (Claim) | orchestrator.claim | 是 | T14 | D3.5 |
| 17 | 自动续跑 (Auto-continue) | orchestrator.continue | 是 | T14 | D3.5 |
| 18 | 系统事件消息 (System Event Message) | domain.message | 是 | T14 | D3.5 |
| 19 | 成员面适配接缝 (Agent Seam) | agent.runtime | 是 | T14 / T16 | D3.7 / D4.3 |
| 20 | 人类面 / 成员面 (Human Face / Member Face) | shared.identity | 是 | T18 | D2.1 / D3.7 |
| 21 | 结构身份 (Structural Identity) | shared.identity | 是 | T18 | D2.1 / D3.7 |
| 22 | 状态点 (Status Point) | orchestrator.status | 是 | T17 | D5.3 / D5.7 |
| 23 | 订阅 (Subscription) | http.human | 是 | T18 | D2.5 |
| 24 | 远端数据流告知 (Remote Data Flow Consent) | shared.identity | 是 | T19 | D5.3 / D6.1 |
| 25 | 未读 (Unread) | domain.unread | 是 | T14 | D3.6 / D4.1 |
| 26 | 搜索命中 (Search Hit) | domain.search | 是 | T14 | D3.6 / D4.1 |
| 27 | 任务看板 (Task Board) | web.detail | 是 | T15 | D4.1 |
| 28 | 任务状态 (Task Status) | domain.task | 是 | T14 | D3.5 |
| 29 | 工作区项目根 (Workspace Root) | tools.workspace | 是 | T17 | D5.1 |
| 30 | Agent 家目录 (Agent Home) | tools.workspace | 是 | T17 | D5.2 |
| 31 | 全局层 / 项目层 (Global Layer / Project Layer) | tools.workspace | 是 | T17 | D5.2 |
| 32 | 规则基座 (Rules Base) | tools.workspace | 是 | T17 | D5.2 |
| 33 | 工作区后端 (Workspace Backend) | tools.workspace | 是 | T17 | D5.3 |
| 34 | 权限档 (Permission Mode) | tools.permission | 是 | T18 | D5.5 |
| 35 | 权限规则 (Permission Rule) | tools.permission | 是 | T18 | D5.5 |
| 36 | 审批 (Approval / HITL) | tools.approval | 是 | T18 | D5.6 |
| 37 | MCP 声明 (MCP Server) | tools.mcp | 是 | T19 | D6.1 / D6.2 |
| 38 | Skill | tools.skill | 是 | T19 | D6.3 / D6.4 |
| 39 | 数据目录 (Data Directory) | db.data-dir | 是 | T17 | D1.4 / D5.3 |
| 40 | 备份 (Backup) | db.backup | 是 | T17 | D1.1 / D5.1 |
| 41 | Schema 版本 (Schema Version) | db.schema | 是 | T13–T19 | D1 |
| 42 | 版本闸门 (Version Gate) | db.schema | 是 | T13–T19 | D1 |
| 43 | 数据迁移 (Schema Migration) | db.migrate | 是 | T13–T19 | D1 |
| 44 | 审计台账 (Audit Ledger) | db.audit | 是 | T13–T19 | D1 |
| 45 | 联网档 (Web Access) | tools.web | 否（T12） | T12 | Out of Scope |
| 46 | 联网 provider 凭据 (Web Provider Credential) | tools.web | 否（T12） | T12 | Out of Scope |
| 47 | 容器出网 (Container Egress) | tools.workspace | 否（T12） | T12 | Out of Scope |
| 48 | 词条 / 词条表 (String / String Catalog) | i18n.catalog | 部分 | T20 | D8.2 |
| 49 | 工作台版本 (Studio Version) | web.shell | 是（替代） | T20 | D8.2 |

**覆盖核对。** T10 6/6、T11 10/10、跨节 28/28、T12 3/3；`词条表` 为 `部分`、`工作台版本` 为 `是（替代）`。核对命令（脚本与完整词表随本轮报告保留）：`python3 /tmp/m2-coverage-check.py docs/spec/allibot-m2-spec.md`；结果：`checked=49 missing=0`。表内没有未决占位，也没有把 T10 / T11 留到后续的 `否` 行。

### R2 Seam 声明

**继承 M1 的唯一 seam，无例外。** M2 不新开测试 seam。唯一 seam 仍是后端进程的 HTTP 面：人类面 REST（含 M1 端点与 M2 新增端点）、CopilotKit 多路由 handler（AG-UI 的 `run` 流）与全局 SSE。测试启动真实后端进程，使用临时数据目录与临时 HOME 根，经 HTTP 驱动频道、任务、team、Plan、SOP、审批、权限、MCP、Skill 与迁移命令，断言 HTTP 响应、SSE 帧、AG-UI 事件序列、SQLite 数据目录的对外产物（库、备份目录、审计台账）以及家目录的对外文件形状。所有 T10 / T11 行为都能在这条 seam 上观察：team / Plan / SOP 通过 REST + SSE + AG-UI 观察；workspace / 权限 / 审批通过 REST + SSE + 轮次结果 reason 观察；Docker 的容器生命周期通过注入的假容器运行时状态、`workspace_status` 与轮次失败 reason 观察；MCP / Skill 通过 REST + 家目录文件 + 轮次 reason 观察。

**注入依赖，不是第二 seam。** 脚本化 provider、固定时钟、假容器运行时、临时 HOME 根、MCP 测试服务器都是 seam 之下的注入依赖，与 M1 的脚本化 provider / 固定时钟同一性质。它们让同一个 HTTP 面在零成本、无网络、无真实 Docker、无真实 `~/.allibot/` 的条件下运行，不改变被测协议。真实 Docker 与真实远端 MCP 只做手工冒烟，不进入自动化测试 seam；如果要把真实容器行为纳入自动化，必须先证明它仍能通过 HTTP 面观察，而不是在容器运行时内部加测试后门。M2 没有需要 coordinator 特批的 seam 例外。

**为什么仍在最高处。** 用 codebase-design 的词汇：编排 agent 仍是深模块，接口很小（`run(input)` + 人类面端点 + SSE），背后藏着 team 唤醒收窄、TeamAssign 子轮次、Plan 工具、SOP 执行器 / 校验者、工作区装配、权限判定、审批生命周期、MCP 文件与 Skill 装配。HTTP 面是 caller 与测试共同穿越的那个 seam，leverage 最高、locality 最好；再往下放会得到更多浅 seam，测试会依赖内部形状。前端仍只做呈现契约测试，不建立第二套领域 seam。

### R3 Avoid 约束

GLOSSARY.md 每条词条的 `Avoid` 列对本规格有约束力；GLOSSARY 的 Avoid 列本身是实现与评审的禁用词清单；R1 表不再复制该列。设计陈述使用词条的承重词，不用 Avoid 列里的同义词替代它：team 不写成「多智能体群聊」，队长不写成「管理员 / 主管」，team 分派不写成「任务 / 消息」，运行记录不写成「日志 / 消息」，Plan 不写成「待办清单 / 子任务」，SOP 不写成「工作流引擎 / 自动化」，工作区项目根不写成「数据目录 / 工作台」，Agent 家目录不写成「工作目录 / 项目目录」，工作区后端不写成「沙箱 / 执行环境」，权限档不写成「角色权限 / RBAC」，权限规则不写成「ACL / 白名单」，审批不写成「授权 / 确认框」，MCP 声明不写成「工具服务器 / 密钥表」，Skill 不写成「插件 / 市场」，Schema 版本不写成「库版本 / 迁移号」，数据迁移不写成「自动升级」，审计台账不写成「日志 / 迁移记录表」。

GLOSSARY 的 Avoid 列本身是约束声明，不是设计用词；规格正文不使用这些词替代词条。`team-change` 是本规格新增的 **wake reason 取值**，不是新词条；`pending / in_progress / completed` 是 plan_task 的字段取值，不是任务五态；`running / completed / failed / invalid-leader` 是 team_run 的字段取值；这些都不是 GLOSSARY 的新承重词。实现票的代码、接口与文案同样受 R3 约束；发现以 Avoid 词替代词条的设计陈述即视为缺陷。

### R4 与词条的差异与降级

| 词条要求 / M1 口径 | M2 实现 | 差异理由 |
| --- | --- | --- |
| Docker 不可用时「成员状态点为未启用」 | 全局状态点仍只聚合禁启用 / 模型 / 告知 / 凭证；工作区故障作为目标上下文的 `workspace_status` 与轮次 reason，成员面板与队长无效判定消费它 | 同一 Agent 可在多个频道；把某个频道的 Docker 故障写进全局状态点会让其它频道假离线；四态词表不变，只把工作区事实按 target 细化 |
| team 频道「唯一被唤醒的成员」 | 普通消息 / 任务变化只唤醒队长；channel 上的 @mention 穿透仍按 M1 留在 pipeline 之外，被点名的非队长可一次性送达并回复 | 词条明确写「channel 上的穿透仍留在 pipeline 之外」；这条回复是 M1 普通消息，不是 TeamAssign 产出，不改变队长身份 |
| team 成员「产出不落频道消息」 | TeamAssign 子轮次不写消息、不写 round_outcome；队长最终回复落频道；穿透例外按上一行处理 | 成员子轮次是运行记录，不是 target 轮次；否则会与「team 成员没有频道消息轮次」冲突 |
| 队长最终回复「不扣跳」 | team 频道对队长作者的普通唤醒面为空，回复的通用唤醒投递被跳过；不产生穿透、不扣跳 | 词条明确「队长最终回复不扣跳」；若跑通用穿透会违背这一条 |
| team 任务变化唤醒的 reason | 新增 `team-change`，`from_seq` 取任务线程的 system 变更记录；mandatory 标记独立承载「必须回应」 | 词条要求 `reason.team_change_*` 文案；不能复用 claim / mention / human_message |
| Agent 转派在 autonomous 频道的唤醒 | `transfer_task` 改 assignee 并追加 system 变更；system 本身不唤醒；team 频道再向队长投递 team-change，autonomous 频道不额外投递 | 词条只把「队长被任务变化唤醒」定为确定信号；不在 M2 给 autonomous 造第六类信号 |
| SOP 执行器 / 校验者需要一个运行位置 | 作为成员面内部轮次运行：不新增 target、不写消息、不写 round_outcome、不进未读 / 搜索 / 看板 / 唤醒 / 预算；输出进 SOP state | 词条明确 SOP「不改任务行、不写消息、不进看板 / 未读 / 搜索 / 唤醒 / 预算」；内部轮次是唯一不违反这些边界的执行方式 |
| SOP 审批需要 reply_id | 使用 run-scoped 的不透明 `reply_id`；它不要求成为消息 id；approval_request.context_kind='sop' | SOP 不写消息，因此没有真实消息 id；审批面仍以 reply 为身份，只是身份来自内部轮次 |
| 审批记录「已收口可重开」 | `confirmed` / `denied` 可因新批次重开；`failed` / `expired` 是终止态，迟到登记不复活；同一批重复登记始终幂等 | 超时 / 重启后拥有该 reply 的轮次已结束，重开会制造没有消费者的孤儿；把终止态写死比假装可恢复更诚实 |
| Plan 的字段状态 | plan_task 用 `pending / in_progress / completed` 三词，不进任务五态、不进看板 | 词条只说 Plan 是工作清单；三词是字段取值，不是新对象；避免与任务五态混淆 |
| 旧频道级 Skill 行 / 项目层技能字节 | 新 `skill` 表只写 Agent 级行；旧频道级行不导入新表；旧字节与旧行保留在旧位置，装配忽略 | 新仓从干净 SQLite 基线开始；没有旧数据可保留；运行期只认「成员家目录 > 全局公共库」 |
| 库内 mcp_server 行 | 只作历史与迁移来源；运行期不读；channel 级旧行忽略；export-mcp 显式导出 | 词条 2026-10-29 决定文件为唯一正本；保留表只是迁移来源，不构成第二正本 |
| 容器出网 | M2 只交付容器生命周期、固定 /workspace、挂载与不可用失败；不实现 docker_egress / --network none 默认 / host 白名单 | 这三项属于 T12；M2 不对容器网络做承诺，避免写出半套网络策略 |
| SQLite 单事务迁移 | v14 / v21 表重建需要在事务外关闭 foreign_keys，提交前 foreign_key_check；仍然一个事务、一次备份、一条台账 | SQLite 不能在事务内切换 foreign_keys；这是表重建的必要纪律，不改变单事务语义 |
| M1 的 docker 取值返回 validation_failed | M2 接受 `local` / `docker` 并真正执行 Docker 后端；不可用明确失败 | M1 已声明的延后范围；M2 兑现 T11，不改变「不静默回落」 |
| M1 的 channel.mode 仅 autonomous | M2 扩为 autonomous / team；默认仍是 autonomous | M1 已声明的 T10 延后范围 |
| Agent 家目录出现，但记忆在 SQLite | 家目录只承载 AGENTS.md / skills / mcp.json；不创建 reme/，不读旧 MEMORY.md | ADR-0005 不变；家目录不是记忆落点 |
| approval_request 只有工具调用与决策 | M2 增加 target_id / context_kind / context_id，支持普通轮次、TeamAssign、SOP 三类上下文 | 审批面需要一个可读归属；不增加新的审批对象 |
| reply_id 是「回复的 ID」 | 需要审批时为当前回复分配 prospective reply_id；普通轮次落消息时它就是消息 id；team / SOP 可以是永不落消息的内部 id | 审批发生在消息提交之前；prospective id 让多批确认有稳定身份 |
| 权限规则的 pattern | M2 定义为大小写敏感 glob：文件路径 / 命令串 / MCP 参数 JSON；空串 = 全部调用 | 词条只给三键与空 pattern 语义；glob 是可实施、可测试的确定化选择 |

### R5 User Stories 覆盖

User Stories 使用严格句式 `As an <actor>, I want a <feature>, so that <benefit>`（英文句式，术语保留 GLOSSARY 的中英并列写法），共 100 条。分组：1–10 team 模式与队长；11–17 team 任务线程、认领、转派与续跑；18–25 TeamAssign 与预算；26–31 Plan；32–40 SOP；41–46 工作区项目根；47–53 Agent 家目录、全局层 / 项目层与规则基座；54–63 工作区后端、Docker 与 local shell；64–70 权限档与权限规则；71–78 审批；79–85 MCP 声明；86–93 Skill；94–100 迁移、HTTP 面、订阅、兼容与边界。M1 规格的 49–53（team·Plan·SOP）与 54–63（Workspace·权限·审批·MCP·Skill）是产品蓝图；M2 在此基础上展开，不重复 M1 已实现的协作环故事。每条只描述外部可见行为，不写内部实现；实现票不得把 R4 的差异当作省略验收的理由。

## Testing Decisions

**好的测试。** 只测外部行为：从后端 HTTP 面发请求、读响应与 SSE 帧、读 AG-UI 事件序列、读数据目录的对外产物（库、备份目录、审计台账）与家目录的对外文件形状，不测私有函数、SQL 字符串、React 内部状态、容器运行时内部 API 或 provider 适配器的私有形状。每个测试用临时数据目录、临时 HOME 根与临时端口，互不共享状态；固定时钟、脚本化 provider、假容器运行时与 MCP 测试服务器由启动参数注入；不联网、不产生模型费用、不依赖本机 Docker 或真实 `~/.allibot/`。

**测试的 seam。** 只有一个：后端进程的 HTTP 面（人类面 REST + CopilotKit 多路由 handler + 全局 SSE）。T10 / T11 的全部领域测试、协议测试、迁移测试、team / Plan / SOP 测试、工作区 / 权限 / 审批测试、MCP / Skill 测试都在这条 seam 上做。前端只做新面板的数据契约（team 运行记录、Plan、SOP、审批、skills / mcp）与视觉 token 名的组件 / 静态契约测试；不为前端建立第二套领域 seam。

**被测模块（经 seam 观察）。** `orchestrator.team` 的 mode / leader / 唤醒收窄 / team-change / invalid-leader / team_run / team_assignment / TeamAssign 跳；`orchestrator.plan` 的四工具与保留期；`orchestrator.sop` 的五 phase / executor / verifier / awaiting；`tools.workspace` 的 root / 家目录 / 规则基座 / local / Docker / 容器生命周期；`tools.permission` 的三档与规则合并；`tools.approval` 的批次 / 600 秒 / reopen / DENIED；`tools.mcp` / `tools.skill` 的文件正本、来源、装配；`http.human` 的新端点、错误码、幂等、SSE；`db` 的 v14–21 步骤与迁移纪律。

**迁移与闸门测试。** 用临时数据目录构造 v13 库，运行 `--migrate` 到 21，断言：备份存在且与迁移前一致；台账一条 from 13 / to 21 / 结果 / 备份路径；`schema_meta.schema_version=21`；`channel` 与 `remote_consent_scope` 的行、主键、值完全保留；`foreign_key_check` 为空；失败回到 v13；高版本拒绝；备份失败不迁移；空目录记「无备份」。另测 v14 / v21 表重建后的子表外键与 team / SOP 触发器。

**team 测试。** 经 REST + 脚本化 provider + SSE 断言：team mode opt-in 与默认 autonomous；leader 写入校验与 invalid-leader；普通消息 / 建任务 / owner 改派 / Agent 转派只唤醒队长；`team-change` reason 与 mandatory 文案；队长作者零唤醒；TeamAssign 1 跳、频道 / 任务预算分离、耗尽 assignment、失败不退款、队长回复 0 跳；成员子轮次不写消息 / 不写 round_outcome / 不计未读；team_run / team_assignment 快照与 SSE；claim / auto-continue 在 team 不出现；task target 无穿透；channel 穿透例外仍按 M1。测试用 `--scripted-provider team-assign` 等行为，不联网。

**Plan / SOP 测试。** Plan：四个工具在 task / team 轮次可用，DM / autonomous 普通轮次不可用；plan_run 懒创建、按 target + member 持久化；三词状态；20 run / 30 天清理 + cascade；plan_update SSE；不进看板 / 未读 / 搜索 / 唤醒 / 预算。SOP：定义校验、同形幂等 / 异形 409、不可变；start 202、活动 run 409；五 phase；executor → verifier；max_attempts 重试与失败；awaiting 的 verifier / approval 两种 waiting_on；审批通过 / 拒绝 / 超时；进程重启 running / awaiting 收口 failed；50 run / 90 天保留；定义不自动删除；Agent 不能创建 / 启动。SOP 的内部轮次断言不产生 target、message、round_outcome、未读、搜索命中或预算变化。

**工作区 / 后端 / 审批测试。** 工作区：root 写校验、相对路径、`..` / 根外 / 逃逸 symlink 是错误而非审批、无 root 无工具、root 消失不回落、备份不含 root。后端：local 默认与 shell 逐次审批、Docker 假运行时的 `(member, target)` 容器 / `/workspace` / 只读挂载 / 数据目录不挂 / 清理 / 三类不可用 reason / 零回落。权限：三档、Agent 覆盖、deny > ask > allow、read-only 硬顶、pattern glob、规则写不落消息。审批：pending 才能决策、同决定幂等 / 相反 409、DENIED 继续、多批次重开、历史拒绝保持、600 秒超时、重启 expired、`rules?` 原子、team / SOP 上下文、载荷无密钥。

**MCP / Skill 测试。** MCP：文件缺失 / 非法 -> 零装配 + reason；三种 transport 校验；env_names 只传变量名；远端 consent 缺失零连接；stdio 免 consent；host 有 / 无 root；DM 共用文件不获项目权限；`mcp_server` 运行期不读；export-mcp dry-run / apply / 备份 / 同名异形拒绝；structured 与 raw 同一文件。Skill：三来源、hash 同 / 异、同名异 hash 409、逃逸 / 超限 400、SKILL.md 缺失 400；家目录 > 全局库；DM / 无 root 仍装配；启停 / 删除；旧项目层字节不装配；migrate-skills dry-run / apply。

**脚本化替身、时钟与容器。** 脚本化 provider 在 M1 八种行为之外增加 `team-assign`、`team-budget`、`plan`、`sop-executor`、`sop-verifier`、`approval`、`denied` 等显式行为，由启动参数选择；它不改变被测 HTTP / AG-UI 面。固定时钟驱动 600 秒审批超时、30 天 / 90 天保留期与重启收口；假容器运行时实现 create / exec / stop / remove / inspect，状态可断言；MCP 测试服务器只监听 localhost 随机端口，测试结束即关。测试中禁止真实网络、真实模型密钥、真实 Docker、真实数据目录、真实 `~/.allibot/`。

**既有测试的先例与回归。** M1 的进程级 HTTP seam、临时数据目录、脚本化 provider、固定时钟、迁移夹具是 M2 的先例；M2 只加新端点与新行为，不重写 M1 测试形状。回归必须覆盖：M1 的频道 / 消息 / 任务 / 私信 / 提醒 / 搜索 / 设置 / 迁移 / AG-UI 契约仍通过；新 schema 不破坏 M1 读模型；全局 SSE 的 rotate 与 live-only 语义不变；`GET /api/workspace` 的旧字段仍存在。

## Out of Scope

**T12 明确不在本票：** 联网档（Web Access）、联网 provider 凭据（Web Provider Credential）、容器出网（Container Egress：`docker_egress`、`--network none` 默认、host 白名单）。这三项依赖 M2 的容器后端，但 M2 不为它们写实现决策：不建 `channel.web_access` / `web_provider_credential` / `docker_egress`，不装配 web_search / fetch，不做 host 白名单，不对容器网络做承诺。T12 的规格与实现票由后续里程碑创建。

**其他明确不在本票：** 英文词条表（M2 只交付简体中文新增键，英文目录位保留、不交付，避免落单键）；旧 `/studio/` 与 `/studio/v2/` 的迁移（单一 React 工作台已替代，旧 Vue 页面不迁移、不并存）；M1 规格 `docs/spec/allibot-v2-spec.md` 与 ADR 0001–0005 的正文修改；GLOSSARY.md 正文、词条新增或 Avoid 列改写；旧仓数据整体导入（只保留 `export-mcp` / `migrate-skills` 两个显式 CLI 契约，启动时绝不自动执行）。

**M2 明确不做的子行为：** team 不做队长选举 / 多队长 / 自动回落 autonomous / 跨频道 team / TeamAssign 之外的 pipeline / 成员产出落频道消息（穿透例外除外）；Plan 不做任务看板数据源、跨 target 计划、计划模板、HTTP 写入口；SOP 不做触发器 / 定时 / 并行步骤 / 取消端点 / 定义编辑或删除 / Agent 自建；工作区不做项目根自动创建、项目文件备份、远程工作区；Docker 不做镜像构建、registry 凭据、多宿主 Docker、GPU、跨进程持久容器、容器网络策略（T12）；权限不做 RBAC / 账号 / 多租户 / BYPASS / DONT_ASK / 按人 ACL；审批不做推送 / 邮件 / 移动端 / 跨重启恢复；MCP 不做远程市场 / OAuth / 通用 secret store / 托管 MCP 服务；Skill 不做远程市场 / 自动下载 / 代跑 `npx skills` / 项目层或频道级装配；迁移不做自动升级、降级、就地改表、步骤重排。

**本规格票的范围：** 不写实现代码（无 `.ts` / `.tsx` / `.sql` 源文件，不改 `server/` `web/` `shared/`）；不跑源码单元测试、`npm run build` / `typecheck`、双轴 code-review（G-spec，本票无源码改动）；不提交 `.scratch/`、临时文件或 `node_modules`；交付物只有 `docs/spec/allibot-m2-spec.md`、新增 ADR 与 GitHub issue / PR。

## Further Notes

**基线数字与来源。** 本规格的基线 commit 是 `d52ae96`（M1 集成 PR #34 合并提交）。在该 commit 上：`SCHEMA_VERSION = 13`；`GLOSSARY.md` 827 行、M1 R1 表 93 个词条；M1 规格 414 行、83 条 User Stories；ADR 0001–0005；M1 的 server 测试夹具与迁移链是既有先例。M2 目标 `SCHEMA_VERSION = 21`；本规格 100 条 User Stories；新增 ADR 0006–0008。以上数字都从该 commit 的 `wc -l`、`SCHEMA_VERSION` 常量与 M1 R1 表读数得到，不凭记忆。

**ADR 清单。** 新增 `docs/adr/0006-docker-workspace-backend.md`、`docs/adr/0007-permission-and-approval-gate.md`、`docs/adr/0008-mcp-file-is-the-only-source.md`；三条都满足「难以撤销 / 脱离上下文会意外 / 真实权衡」。编号从 0006 起连续、不跳号；D8.2 说明 team / Plan / SOP / HTTP / schema 步骤 / 测试替身为什么不写 ADR。

**M1 规格勘误（不改 M1 正文，只在 M2 记录）。** 其一，M1 规格开头写 `GLOSSARY.md`（834 行、93 个词条）；在 `d52ae96` 上实际是 827 行、词条数仍为 93（M1 R1 表 93 行）。这是基线数字陈旧，不影响 M1 语义；M2 以 827 行为基线。其二，M1 规格 R4 的「M1 只做 local 的受限文件工具语义」与 M1 规格 D1.5「M1 没有项目根文件工具，也没有全局层」及 M1 代码形状不一致：M1 实际没有交付任何项目根文件工具或 shell，只有「无项目根工具」的空面；M2 才交付 local / Docker 的工作区工具面。建议 M1 规格后续把 R4 该行改为「M1 不交付项目根文件工具 / shell；local / Docker 工具面在 M2 交付」，本票不直接改。M1 Further Notes 已自行记录的 `client_message_id` / `target_budget.limit_value` / `reminder.missed` 三列补充，不再重复列为新勘误。

**工作分解票图（规格内部键，不是 GitHub issue 号）。** T13 team 模式、队长与 v14；T14 team run、TeamAssign、任务变化与 v15；T15 Plan 与 v16；T16 SOP 与 v17；T17 工作区项目根、Agent 家目录、规则基座、工作区后端 / Docker 与 v18；T18 权限档、权限规则、审批与 v19 / v20；T19 MCP 声明、Skill 与 v21；T20 Agent 详情 skills / mcp 页签、审批 / Plan / team run / SOP 面板、SSE 消费者与端到端集成。建议顺序：T13 → T14 → T15 / T16 → T17 → T18 → T19 → T20；T14 与 T17 可以并行，但 v14–v21 的步骤号必须按规格顺序追加，不按开发顺序重排。

**风险与验证点。** Docker 真实运行时不在自动化 seam 内：假运行时能验证生命周期与挂载契约，但真实 daemon / 镜像 / 容器内路径需要手工冒烟；这是 M2 接受的验证缺口，不把它伪装成自动化覆盖。审批的 600 秒等待与 live AG-UI run 的取消 / 断线语义要在 T18 用固定时钟与中断测试盯住；team 穿透例外可能在频道里产生非队长消息，前端文案必须把它读成「直接提及的 M1 回复」而不是 team 产出；目标上下文 workspace_status 与全局状态点的分工要在 UI 文案里一致；v14 / v21 表重建要在 T13 / T19 做 FK 与行数比对；MCP `mcp.json` 的原子写与单进程假设要在 T19 做并发重放；Skill zip 的路径逃逸 / 超限要在 T19 做负例；审批载荷的密钥掩码要在 T18 做负例。T12 之前，M2 容器没有出网策略，部署说明必须明确「容器网络隔离尚未交付」，不能把 M2 说成完整沙箱。

**词条缺口。** 本轮没有发现需要新增 GLOSSARY 词条的缺口；需要记录的是取值与字段，不是新承重词：`team-change` 是 wake reason 取值，`pending / in_progress / completed` 是 plan_task 字段取值，`running / completed / failed / invalid-leader` 是 team_run 字段取值，`awaiting` 是 SOP phase 取值。实现票不得自行发明新的承重词；若发现真实缺口，按「不自行补写词条」的纪律上抛，不在实现里静默改名。

**M2 集成 review 的实现注记（2026-11-04）。** D3.4 第 6 条的「成员子轮次不写 target 消息」按「不写成员发言与回复」理解，不排除系统事实记录：`transfer_task` 在 TeamAssign 子轮次成功时按 D3.5 追加一条 system 变更记录（受派者变更），该记录不计未读、不进搜索、不唤醒、不扣跳，也不产生成员 `round_outcome` 或对话正文；成员子轮次仍不写任何 human / agent 消息。D3.4 正文不改。真实模型 adapter 的 tool loop 是 M2 的已知限制（GitHub #51）：M2 只用脚本化 provider 驱动 TeamAssign / Plan / SOP verifier，接入真实模型不等于这些能力可用；该限制同时记录在集成 PR 的 Door 段与 `docs/deployment.md`，不扩大 M2 的能力承诺。



