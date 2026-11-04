# allibot M2 部署说明（部署事实，不是完整沙箱承诺）

本文只陈述 M2 实际交付的部署边界。M2 可以在 **local** 或 **Docker** 工作区后端上运行；
它不是完整沙箱，容器网络隔离尚未交付。

## 工作区后端

- **local（默认）**：受限文件工具在宿主进程内执行，cwd 是频道项目根；local shell 默认关闭，
  只有 `channel.allow_local_shell=1` 才启用，且每次调用仍逐次审批。local 模式没有沙箱：
  这是明确的已知风险，不能把它描述成隔离环境。
- **Docker**：文件工具、shell 与 stdio MCP 在每 `(member_id, target_id)` 一个容器内执行。
  项目根挂到 `/workspace`（rw），成员家目录挂到 `/agent-home`（ro），全局技能挂到 `/skills`
  （ro），数据目录**不**挂载。容器不持久、不跨 target 共享、不跨进程复用。

Docker 是容器隔离，不是网络隔离。M2 **不交付**以下 T12 能力：web 访问模式、web provider
凭据、容器出网策略、`--network` 默认值、host allowlist。部署者不能把 M2 容器当作完整沙箱，
也不能假设容器默认不能访问网络。

## Docker 前置条件与一次性确认

- 宿主必须可执行 Docker CLI（默认 `docker`，可用 `--docker-command` 指向其它路径），Docker
  daemon 必须可连接。
- 镜像引用是进程级配置 `allibot_DOCKER_IMAGE`（默认 `node:22-bookworm-slim`）。M2 不构建镜像、
  不保存 registry 凭据。
- 镜像不在本机时，首次拉取前必须存在 `('docker', image_ref)` 的一次性远端数据流确认；
  没有确认就明确失败，不会静默拉取。
- 无 daemon、镜像缺失 / 拉取失败、consent 缺失或容器创建失败时，该 target 上下文的工作区
  不可用：成员读数给出 `workspace_status` 原因，队长按 D3.8 记 `invalid-leader`，轮次零工具
  调用并失败，绝不回落到 local shell 或 local 文件工具。

## 备份边界

三种东西分开备份，不能互相替代：

1. **数据目录**：只承载 `allibot.db`、`attachments/`、`schema-migrations.jsonl` 与可丢弃的
   `mcp-hosts/`。整目录备份只复制这些内容；schema / 技能迁移的整目录备份落在数据目录的同级
   目录（`<data-dir>.backup-*`），迁移清单也在数据目录之外。
2. **项目根**：`workspace_root` 指向的宿主目录（频道 / 任务共用其所属频道的根）。它是工作区
   内容的正本，M2 不把它复制进数据目录，也不把它放进数据目录备份；需要 owner 自行备份。
3. **Agent 家目录 / 全局层**：`~/.allibot/agents/<member_id>/`（`AGENTS.md`、`skills/`、
   `mcp.json`）与 `~/.allibot/skills/`。这些也不进数据目录备份；`AGENTS.md` 由人维护，
   软删除 Agent 不会删除家目录。可用 `--home-dir` / `allibot_HOME_DIR` 改全局层根。

## 密钥与日志

- 模型 provider 密钥、web / 联网凭据、MCP `env_names` 的**值**都不写入 SQLite、日志或 SSE。
  `mcp.json` 只声明变量名；shell / 工具进程按 allowlist 加这些名字从进程环境取值。
- 审批摘要只保留工具名与可读参数；MCP 参数与 Bash 命令中的 token 形值在入库、SSE 与 HTTP
  读数前都会掩码。
- `mcp_server`、`skill` 行只存元数据与 hash，不存字节或密钥。
