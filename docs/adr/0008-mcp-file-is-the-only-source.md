# 0008 成员家目录 mcp.json 是 MCP 声明的唯一正本

## Status

accepted（2026-11-04）

## Context

M2 要交付 MCP 声明的管理面与运行期装配。GLOSSARY.md 已经记下旧仓的反复：`mcp_server` 表曾经是装配来源，后来文件成为只读装配层，再后来库行成为来源，2026-10-29 用户又决定「家目录 `mcp.json` 是唯一正本，库行只作历史与迁移来源」。本仓是全新的 SQLite 正本，但 MCP 的声明不是业务状态：它包含 transport、command / args、url、env_names 与启用态，且 env 值只能从进程环境读。如果把声明同时写进库与文件，管理面显示哪一份、运行期读哪一份、远端 consent 以哪一份为准都会分叉；如果把 env 值写进库或文件，又会违反「库内不存密钥」。这个决定影响正本位置、迁移命令、管理面读写与审批 / consent 的归属，回退成本高，且未来读者会问「为什么有 mcp_server 表却不在运行期读」。

## Decision

1. **唯一正本。** `~/.allibot/agents/<member_id>/mcp.json` 是 MCP 声明的唯一正本；管理面的条目结构化表单与原文文本域读写同一份文件；运行期装配也只读它。DM 与频道共用同一份文件，DM 不因此获得项目文件权限。
2. **文件形状。** 文件是含 `servers` 数组的对象；每个条目有 `name`、`transport ∈ {stdio, http, sse}`、`enabled`，stdio 另有 `command` / `args`，http / sse 另有 `url`，三种都可带 `env_names`（只存变量名）。M2 不接受 `headers` / `headers_env` / 内联密钥或未知字段；条目名在同一文件内唯一。`PUT` 恰好给 `raw` 或 `entries` 之一；写临时文件、校验、rename 原子替换，保留 0600 权限；同内容重放不触碰 mtime。
3. **非法文件零装配。** 文件缺失 = 本轮不装配 MCP，不报错；文件非法（JSON 坏、schema 坏、任一条目坏）= 整份文件不装配，本轮 MCP 为零，可读提示只进 `RoundOutcome.reason` 与管理面诊断，不伪造半套 MCP。
4. **远端 consent。** http / sse 服务器未确认数据面时不连接：`remote_consent_scope` 的 `('mcp', server_name)` 行是唯一确认事实，只记确认时间，不存 URL、命令、env 值或凭据；改名要重新确认。stdio 不需要远端确认。未确认的服务器不装配、零连接。
5. **宿主与执行。** 有项目根时 MCP 以项目 workspace 为宿主；无项目根（DM / 未配置项目根的频道）时用 `<data_dir>/mcp-hosts/<session_id>/` 这个不带项目文件工具的可丢弃宿主。stdio MCP 在 local 后端是宿主子进程，在 Docker 后端通过容器执行；http / sse 由宿主进程连接。数据目录不挂进容器。
6. **库表只作历史。** `mcp_server` 表保留，但运行期绝不读它；`scope_kind='channel'` 的旧行保留、装配忽略，不回填、不静默启用。旧 Agent 级行经显式 Node CLI 子命令 `export-mcp` 导出：默认 dry-run，`--apply --yes` 才写，写前备份并落清单，同名不同形整体拒绝，不删库行，只复制既有远端 consent，不代做新确认；旧命令 `migrate-mcp` 已退役。启动时绝不自动导出或迁移。
7. **不是市场。** 本仓只支持显式配置的本机 / 远端连接，不做远程市场、自动下载、OAuth 托管或通用 secret store；MCP 的能力仍受权限档 / 规则 / 审批约束。

## Consequences

- 管理面显示的就是运行期读的那一份；不存在「表单显示 A、运行期读 B」的双写漂移。代价是文件写入要自己保证原子性、权限与并发（单进程假设下由后端串行化）。
- `mcp_server` 表存在但运行期不读，会让只读代码的人困惑；本 ADR 与 export-mcp 的清单就是解释。库行可以随旧库保留，也可以在显式导出后由 owner 自行清理；M2 不自动删。
- `mcp.json` 不随数据目录整目录备份，部署说明必须提醒 owner 单独备份家目录与全局技能；M2 不把它们塞进数据库备份。
- 远端 MCP 的 consent 与模型 consent 共用 `remote_consent_scope`（v21 重建后允许 `mcp` / `docker`），但只记 scope 与确认时间，不存连接参数或凭据。
- 旧频道级 MCP 行不会因为文件存在而复活；如果 owner 需要某个频道级声明，必须手动写进对应成员家目录并重新确认远端。

## Old ADR Correspondence

- 对应旧仓 ADR-0031 §二与 2026-10-29 用户的「文件为唯一正本」决定；旧仓 #270 / #275 的「文件 → 库行 → 文件」历史在本 ADR 中记下，但本仓不复制旧仓的迁移编号或旧命令行为。
- 替代旧仓 `migrate-mcp`：本仓只保留显式 `export-mcp`，不自动迁移、不静默启用。
- 不涉及 ADR-0005（记忆落 SQLite）：MCP 文件在家目录，但记忆仍只在 `agent_memory` 表；家目录出现不改变记忆落点。
