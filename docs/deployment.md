# allibot M2 部署说明（部署事实，不是完整沙箱承诺）

本文只陈述 M2 实际交付的部署边界。M2 可以在 **local** 或 **Docker** 工作区后端上运行；
它不是完整沙箱，容器网络隔离尚未交付。

## 本地开发

四步各有一条命令：构建 → 一次性迁移 → 起后端 → 起前端 dev。后端两条命令跑的都是根
`dist/cli.js`（由 `scripts/write-root-cli.mjs` 生成，入口是 `server/dist/cli.js`）。

1. **构建**：`npm install && npm run build`。根 `build` 依次构建 `shared`、`server`、写根
   `dist/cli.js`，再构建 `web`。`dist/cli.js` 是编译产物，所以改了 `server/` 源码要重跑构建；
   只重建后端用 `npm run build --workspace shared && npm run build --workspace server && node scripts/write-root-cli.mjs`。
   `npm run dev:web` 不依赖这一步（Vite 直接跑源码），只有后端需要它。
2. **一次性迁移**：`npm run migrate`（即 `node dist/cli.js --migrate`）。数据目录默认
   `~/.allibot/data`，可用 `--data-dir <path>` 或 `allibot_DATA_DIR` 改。迁移不塞进 `serve`：
   迁移是一次性动作，起服务是每次动作；`serve` 在库缺失或 schema 落后时明确失败，不隐式迁移。
3. **起后端**：`npm run dev:server`（即 `node dist/cli.js serve --port 3000`），只绑定
   `127.0.0.1:3000`。
4. **起前端 dev**：`npm run dev:web`（即 `npm run dev --workspace web`），浏览器打开
   `http://localhost:5173`。

### 前端 dev 与后端同源靠一条 `/api` 代理

`web/vite.config.ts` 只有一条 `/api` 代理规则，默认目标是 `http://127.0.0.1:3000`。
进程级环境变量 `allibot_API_ORIGIN` 覆盖默认值，命名与 `allibot_DATA_DIR` /
`allibot_HOME_DIR` / `allibot_DOCKER_IMAGE` 一致：

```sh
allibot_API_ORIGIN=http://127.0.0.1:3010 npm run dev:web
```

这条规则同时覆盖 `/api` 下的三面，且不改写路径（后端路由本身就是 `/api/...`）：

- REST 读数（`/api/workspace`、`/api/settings` 等）返回 `application/json`；
- `/api/events` 是 SSE 长连接：代理在转发头就位时显式 flush，所以前端不必等第一帧就能
  拿到 `text/event-stream`；帧到达时按字节转发、不缓存，连接也不会被立刻断开；
- `/api/copilotkit` 是 CopilotKit handler：它在后端内部再分流多个子路由并读请求体流。

**前端 dev 与后端同源靠这条代理，没有它前端只能落到兜底设置面**：5173 上的
`GET /api/workspace` 会命中 Vite 的 SPA fallback 返回 `text/html`，`response.json()` 抛错，
页面退回设置面板并显示「设置读取失败，请确认后端已启动。」（词条 `settings.error.load`）。
这条读失败文案与写入失败（`settings.error.save`，「设置未保存」）是两条不同的失败，
不要把前者当成后者排查。

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

## 真实模型 provider 的已知限制（M2 A1）

M2 的真实模型 adapter 仍是单轮文本补全：`server/src/model-provider.ts` 只发送一次
system + user 的 chat completion，不传 tool definitions，也不解析 `tool_use` / `tool_calls`。
因此：

- `TeamAssign` / `transfer_task`、Plan 的四个工具、SOP verifier 的结构化 `sopVerdict`、以及
  需要审批的工具调用，目前只有脚本化 provider（`--scripted-provider`）能驱动。
- 接入真实模型并不等于 team / Plan / SOP / 工具审批可用；本版本不能这样宣传。
- M2 的验收 seam 是后端 HTTP 面 + 脚本化 provider；真实模型工具循环由 follow-up
  GitHub #51 承接，不在本版本内。

这是部署时必须向使用者说明的限制，不是配置开关。

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
