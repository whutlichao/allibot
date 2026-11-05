> 本规格把 #65 的 M3 范围（T12 三项：联网档、联网 provider 凭据、容器出网）转写成可实施、可验收的决策集合。章节沿用 M1 / M2 / #51 规格的七章节模板；术语沿用 `GLOSSARY.md` 的中英并列写法，`Avoid` 列是约束。基线是 `main` 的 `d2a1cdb`（PR #64 合并提交）：`SCHEMA_VERSION = 21`、`GLOSSARY.md` 826 行、ADR 0001–0009、`BUILTIN_TOOL_CLASSES` 共 12 项、`remote_consent_scope.scope_kind` 的 CHECK 为 `('model','mcp','docker')`。本规格把 Schema 推进到 25。

## Problem Statement

M1 与 M2 都交付了「没有联网」的产品：Agent 能读项目文件、跑本地 shell、调 MCP 工具，但`web_search` 与 `fetch` 从未装配，`channel.web_access`、`web_provider_credential`、`channel.docker_egress` 三张正本一个都不存在。这两次延后的账都指向同一个里程碑：M1 规格 R1 表把词条 36/37/38 标成 `否（T12）`，M2 规格 Out of Scope 写明「T12 的规格与实现票由后续里程碑创建」。

后果有三条具体。其一，Agent 无法回答任何「当前」问题，只能用训练数据里的旧事实，而这恰恰是这个产品最常被要求的能力。其二，Docker 工作区现在默认无出网，但**没有任何开关**能打开它——部署者只能用 `--network` 手工改容器，等于绕过后端。其三，「挂不挂工具」与「容器能不能出网」是两个开关，现在后者根本不存在，前者也只有一个不存在的字段，任何实现都会临时发明一套语义。

这次的技术前提已经变了：M2 交付了唯一工具闸门（ADR-0007），#51 交付了轮内工具循环（ADR-0009）。联网工具不再是「第一个工具面」，而是**既有两个契约的又一个消费者**——所以本规格的主要工作是把 T12 的三项塞进既有判定顺序，而不是新建一套。

## Solution

三件事一次交付，但各自有独立正本：

**联网档**是频道级能力配置，Agent 可覆盖（NULL 跟随），四档语义逐字取自词条：NULL 回退默认 `search`、`off` 不装配任何联网工具、`search` 只有 `web_search`、`search+fetch` 再加 `fetch`。`search+fetch` 下 `fetch` 不再逐次审批（2026-10-22 人定的既有事实），但 `permission_rule` 的 `deny` / `ask` 仍可收紧，DM 恒为 read-only 且 `fetch` 永不装配。

**联网 provider 凭据**是五家带凭据 provider（brave / tavily / perplexity / jina / exa）各一把 key，明文存 `web_provider_credential`，至多一行默认。解析顺序唯一：进程环境 `allibot_WEB_SEARCH_PROVIDER` → 凭据表默认项 → 已配置项的固定顺序 → 免凭据回退 `exa` MCP。凭证值优先取库内、环境变量兜底。这条**与「库内不存密钥」正面冲突**，由 ADR-0010 显式裁定并划定边界，不是悄悄破例。

**容器出网**是 Docker 后端的频道级开关，缺省 `0` = `--network none`；打开时容器接默认网络，而**按 host 的白名单由联网工具层执行**，来源是 `permission_rule` 里 `fetch` 的 allow 规则 host。空白名单 = 全禁，不是全开。

三条纪律贯穿：联网工具与文件 / shell / MCP 共用同一道工具闸门（ADR-0007），不新开判定路径；它们作为工具面进入 #51 的轮内循环（ADR-0009），不新开一轮；任何远端调用前必须有一次性的 `('web', provider)` 远端数据流确认，未确认即不装配、零 socket、轮次可读失败。

## User Stories

1. As an owner, I want a channel-level web access tier, so that one channel can use search while another stays offline.
2. As an owner, I want `off` to mean no web tool is assembled at all, so that "off" is not a filter that a model can argue past.
3. As an owner, I want an unset tier to fall back to `search`, so that opting in is the default once a provider is configured.
4. As an owner, I want `search` to assemble only `web_search`, so that a search-only setup cannot fetch arbitrary pages.
5. As an owner, I want `search+fetch` to add `fetch` without a per-call approval, so that the human decision is made once when the tier is chosen.
6. As an owner, I want a `deny` or `ask` rule to keep tightening `fetch` even on `search+fetch`, so that the tier exemption never overrides an explicit rule.
7. As an owner, I want read-only permission mode to drop `fetch` from the assembled tools and to deny it if called anyway, so that a read-only context cannot pull remote bytes.
8. As an owner, I want DM tiers to fall back to the Agent's config plus the default, so that a DM behaves like the channel it belongs to.
9. As an owner, I want a DM to never assemble `fetch`, so that a one-to-one conversation can only search.
10. As an owner, I want an Agent-level tier that follows the channel when unset, so that per-Agent overrides stay opt-in.
11. As an owner, I want to store one key per provider with at most one default, so that switching provider is a configuration change rather than an environment edit.
12. As an owner, I want five providers supported (brave, tavily, perplexity, jina, exa), so that I can pick by price or coverage.
13. As an owner, I want the provider chosen by environment, then the stored default, then the configured order, so that the resolution order is predictable enough to debug.
14. As an owner, I want the stored key to win over the environment one, so that rotating a key in the UI takes effect without a restart.
15. As an owner, I want the key readable back only as a mask, so that a screenshot of the settings page cannot leak it.
16. As an owner, I want a provider key to never appear in logs, SSE frames or round reasons, so that a failing request cannot leak it.
17. As an owner, I want the backup documentation to say the credential table contains plaintext keys, so that I know what a data-directory backup carries.
18. As an owner, I want a round with no usable provider to fail with a readable reason, so that "web is on but nothing works" is visible rather than silent.
19. As an owner, I want a missing credential to name the environment variable and provider, so that I can fix it without reading the source.
20. As an owner, I want a fallback to an `exa` MCP server when no key exists, so that a configured MCP search works without a key.
21. As an owner, I want that fallback to require a server literally named `exa`, so that an unrelated server cannot take over search by name coincidence.
22. As an owner, I want an unconfirmed `('web', provider)` data flow to block every call with zero sockets, so that no query leaves the machine before I have said yes once.
23. As an owner, I want the confirmation to be per provider and one-time, so that adding a second provider asks again but switching keys does not.
24. As an owner, I want a channel-level container egress switch that defaults to off, so that a container has no network unless I say so.
25. As an owner, I want the egress allowlist computed from `fetch` allow rules' hosts, so that there is one host list rather than two that drift.
26. As an owner, I want an empty allowlist to mean no egress, so that turning the switch on without rules cannot silently expose the network.
27. As an owner, I want an allow rule with an empty pattern to permit the tool call without opening container egress, so that "allow the tool" and "allow the network" stay separable.
28. As an owner, I want web tools to work on both local and Docker backends, so that development does not need containers to try the feature.
29. As a model, I want `web_search` results shaped like other read results, so that the loop's truncation and capping rules apply without a second scheme.
30. As a maintainer, I want `fetch` approval payloads to name the host and not the URL, so that query strings carrying secrets never enter the approval record.
31. As a maintainer, I want the two tool names to stay `web_search` and `fetch`, so that existing rules and the glossary keep one spelling.
32. As a maintainer, I want the schema steps to follow the strict +1 discipline with a rebuild only where a CHECK requires it, so that a failed migration is locatable.

## Implementation Decisions

**D1 三件套与档位取值。** `channel.web_access` 与 `agent_config.web_access` 接受 `NULL` / `'off'` / `'search'` / `'search+fetch'` 四值（Agent 的 `NULL` 表示跟随频道，照 `workspace_backend` / `permission_mode` 的既有先例）；`channel.docker_egress` 是 `0` / `1`，缺省 `0`。有效档位的解析顺序：Agent 覆盖（非 NULL）→ 频道值（非 NULL）→ 默认 `'search'`；DM 走「Agent 级 + 默认档」且恒按 `read-only` 处理。

**D2 read-only 与 fetch 的两层约束。** 装配层：`read-only` 权限档下 `fetch` 不进入本轮工具集（模型看不见）；DM 无论档位如何都不装配 `fetch`。判定层：即使被调用，`checkPermission` 在硬边界段对 `fetch` 返回 `deny`（reason `read-only-tool`），与 ADR-0007 决定 2 的「read-only 是硬顶」同形。两层都写，因为装配层管「看不见」，判定层管「看见了也做不了」。

**D3 工具类与命名。** `BUILTIN_TOOL_CLASSES` 增加两项：`web_search: 'read'`、`fetch: 'execute'`。不新增 `tool_class`。理由：`web_search` 只读远端索引，归 `read` 之后 DM 的 read-only 天然只剩 `web_search`，不需要为词条写豁免分支；`fetch` 能打到任意 host，归 `execute` 与 `Bash` 同类。两个名字就是词条里的产品名，`permission_rule.tool_name` 精确匹配照旧，MCP 的 `mcp:<server>/<tool>` 命名空间不冲突。

**D4 判定顺序。** 在 ADR-0007 决定 4 的顺序里插一条，位置在**规则合并之后、模式默认之前**：硬边界（root 逃逸、read-only 硬顶含 `fetch`、`allow_local_shell=0`、工作区不可用）→ 规则合并（`deny > ask > allow`）→ **档位豁免**（`merged` 为 `null` 且有效档位是 `search+fetch` 且工具是 `fetch` → `allow`，reason 记 `web-fetch-tier`）→ 模式默认。豁免必须排在规则合并之后：词条明说 `deny` / `ask` 仍可收紧，排前面会让规则失效。

**D5 host 白名单的两层语义。** 工具层：`fetch` 的规则 `pattern` 与审批载荷都用 **host**（不含 path / query），审批记录因此不可能带上 `?token=…` 这类值。容器层：出网白名单 = 带**显式** host pattern 的 `fetch` allow 规则所声明的 host 集合；空 `pattern` 的 allow 规则只放行工具调用，不计入出网白名单。空白名单 = 全禁（`--network none`）。两层的正本是同一张 `permission_rule`，不新建 host 白名单表。

**D6 凭据表与解析顺序。** 新表 `web_provider_credential(provider TEXT PRIMARY KEY, api_key TEXT NOT NULL, is_default INTEGER NOT NULL CHECK (is_default IN (0,1)), created_at, updated_at)`，provider 取值限定五家（CHECK），并用部分唯一索引保证至多一行 `is_default = 1`。解析顺序唯一：进程环境 `allibot_WEB_SEARCH_PROVIDER` → 凭据表默认项 → 已配置项的固定顺序（`brave` → `tavily` → `perplexity` → `jina` → `exa`）→ 免凭据回退 `exa` MCP。同一 provider 的凭证值库内优先、环境变量兜底（`allibot_WEB_<PROVIDER>_API_KEY`）。人类面读数只回掩码（形如 `sk-…abcd`）。

**D7 端点覆盖。** 每家一个 `allibot_WEB_<PROVIDER>_BASE_URL`（`BRAVE` / `TAVILY` / `PERPLEXITY` / `JINA` / `EXA`），未设置时用该家默认端点；尾部斜杠剥除规则与 `providerBaseUrl` 一致。测试用它把请求指向本地假 provider，生产不用它换家运行。

**D8 缺能力时的收口。** 有效档位不是 `off`、但解析不出任何可用 provider（无 key、无默认、无 `exa` MCP）时：本轮 `failed`，可读 reason 点名缺什么（缺哪家的 key / 缺 `exa` MCP / 缺确认），零 socket。不静默降级为 `off`，也不把配置错误伪装成工具结果。

**D9 `exa` MCP 回退的判定。** 可用 = 该 Agent 的 `mcp.json` 里 server 名**恰为** `exa`、该 server 已连接、且其工具列表里存在搜索类工具（按 server 返回的工具名匹配 `search` 语义，取第一个命中项）。命中则经既有 MCP face 调用 `mcp:exa/<tool>`，沿用既有 MCP 一次性确认与 execute 类判定。名字模糊匹配一律不做。

**D10 轮次输入的新面。** `RoundInput` 增加 `web: RoundWebFace | null`：`web_search({query})` 与 `fetch({url})` 两个方法，加该轮的有效档位与解析出的 provider 事实；`null` 表示本轮不装配（`off`、read-only 下的 `fetch` 单独处理、DM 的 `fetch`）。装配由 `rounds.ts` 按 D1 的有效档位与 D2 的两层约束决定；local 与 Docker 两种后端都装配，区别只是出网由谁执行（local 由宿主进程直接发请求，属于已明示的无沙箱事实）。

**D11 `('web', provider)` 远端数据流确认。** 复用 `remote_consent_scope` 与既有通用确认端点，`scope_kind` 的 CHECK 从 `('model','mcp','docker')` 扩到含 `'web'`；未确认时该 provider 视为不可用，走 D8 的收口。确认按 provider 一次性，不按 key 轮换失效。

**D12 schema 四步。** `v22`：`channel` 加 `web_access` 与 `docker_egress` 两列（含 CHECK）；`v23`：`agent_config` 加 `web_access`（NULL = 跟随）；`v24`：新建 `web_provider_credential` 与「至多一行 default」的部分唯一索引；`v25`：`remote_consent_scope` 的 `scope_kind` CHECK 扩容——这是 CHECK 变更，必须表重建，沿用 v14 / v21 的形状（重建表、`INSERT … SELECT`、`RENAME`、提交前 `PRAGMA foreign_key_check` 把门）。`SCHEMA_VERSION` 21 → 25，严格 +1，单事务，迁移前整目录备份与审计台账不变。

**D13 结果回灌复用 #51 的纪律。** `web_search` / `fetch` 的结果形状走 `tool-specs` 的既有整形与回灌截断，不新造一套；命中的是「回灌层总量上限 + 显式截断标记」，`capped` 事实只在有封顶语义时给出（搜索命中数上限）。

**D14 审批载荷与规则 pattern 同源。** `fetch` 的审批 `arguments` 里只放 host，规则匹配也按 host；`permission_rule.pattern` 为空 = 该工具全部调用（既有语义），但在出网白名单里不计（D5）。

## Testing Decisions

**唯一 seam 不变。** 测试仍只穿越后端 HTTP 面：真实后端进程 + 临时数据目录 + 注入 provider。联网侧的注入点是**假 web provider HTTP server**——进程内、随机端口、按路径返回固定结果、可断言收到的请求头与 body；与 #51 的 `startRecordingEndpoint` 同形，是注入口而不是第二条 seam。真实网络一律禁止。

**必须覆盖的外部行为。**

- 四档：`off` 零装配；`search` 只给 `web_search`；`search+fetch` 两个都给我；NULL 回退 `search`。
- DM：只给 `web_search`，`fetch` 不装配且强制调用时 `deny`。
- read-only：`fetch` 不装配；绕过装配直接调用返回 `deny` / `read-only-tool`。
- `search+fetch` 的 `fetch` 不逐次审批；同一条 `fetch` 的 `deny` 规则仍拒绝、`ask` 规则仍询问。
- 规则 pattern 用 host：伪 URL 带 query 时审批载荷只有 host。
- 容器出网：`docker_egress=0` → 容器参数含 `--network none`；`=1` 且有显式 host 的 allow 规则 → 白名单就是这些 host；`=1` 但只有空 pattern 的 allow → 仍无网。
- 凭据：库内优先于环境变量；五家都没有时 `failed` 且 reason 点名缺口；未做 `('web', provider)` 确认时零 socket + `failed`。
- `exa` MCP 回退：server 名恰为 `exa` 时命中；名字近似时**不**命中，走 D8 收口。
- 掩码：HTTP 读数、SSE 帧、日志、轮次 reason 里都不出现完整 key。

**先例。** `server/test/docker-workspace-http.test.ts`（假容器运行时的参数断言）、`server/test/permissions-http.test.ts`（判定顺序与 600 秒审批）、`server/test/remote-data-flow-http.test.ts`（`startRecordingEndpoint` 端点注入）、`server/test/model-tool-loop-http.test.ts`（工具循环与回灌）是本批的形状先例。

## Out of Scope

- **联网 provider 市场 / OAuth / 通用 secret store**：不建 provider 注册表，不支持任意新 provider，不做凭据加解密。
- **`--network` 之外的网络策略**：不做 `docker_egress` 之外的通用 DSL、不做防火墙规则、不做 host 白名单正则。
- **搜索缓存 / 结果重排 / 摘要合成**：`web_search` 返回 provider 原样结果，不做二次加工。
- **限流与配额**：不做每频道调用上限、不做 provider 配额计数。
- **英文词条表**：新增文案只进 zh-CN。
- **旧 `/studio/` 迁移**：不并存、不迁移。
- **容器出网的真机验证**：真实 daemon 与真实容器网络不在自动化 seam 内，与 M2 的既有缺口一致；自动化只断言运行时参数。

## Further Notes

**基线数字与来源。** 基线 commit `d2a1cdb`：`SCHEMA_VERSION = 21`；`GLOSSARY.md` 826 行；ADR 0001–0009；`BUILTIN_TOOL_CLASSES` 12 项（`Read` / `Glob` / `Grep` / `Write` / `Edit` / `Bash` / `TeamAssign` / `transfer_task` / `TaskCreate` / `TaskGet` / `TaskList` / `TaskUpdate`）；`remote_consent_scope.scope_kind` 的 CHECK 为 `('model','mcp','docker')`（`server/src/db.ts:1008`）；表重建与 `foreign_key_check` 先例在 v14 / v21。以上数字都从该 commit 上 `wc -l`、`grep -c` 与源码直读得到，不凭记忆。

**ADR。** 新增 `docs/adr/0010-web-provider-credential-in-db.md`：裁定「模型密钥不进库、联网 provider 凭据是唯一例外」，并写死安全边界（只回掩码、不入日志 / SSE / reason、备份说明标注、至多一行默认、provider 枚举）。档位判定顺序、工具类、host 粒度、schema 步骤都属于可逆实现决策，写在本规格，不另开 ADR。

**"与 ADR-0007 的关系。** 本规格不改 0007 的判定顺序，只在其中插一条档位豁免（D4）并新增两个工具名（D3）；read-only 硬顶、规则合并优先级、600 秒审批批次全部沿用。

**`exa-mcp` 免凭据回退的边界。** 它是解析顺序的最后一项，不是「永远可用」的兜底：没有名为 `exa` 的服务器时它就是不可用，走 D8 收口。真实 provider 与 MCP 回退二选一，不会并行发两份请求。
