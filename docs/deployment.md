# allibot M2 部署说明（部署事实，不是完整沙箱承诺）

本文只陈述 M2 实际交付的部署边界。M2 可以在 **local** 或 **Docker** 工作区后端上运行；
它不是完整沙箱，容器网络隔离尚未交付。

## 本地开发

四步各有一条命令：构建 → 一次性迁移 → 起后端 → 起前端 dev。后端两条命令跑的都是根
`dist/cli.js`（由 `scripts/write-root-cli.mjs` 生成，入口是 `server/dist/cli.js`）。

1. **构建**：`npm install && npm run build`。根 `build` 依次构建 `shared`、`server`、写根
   `dist/cli.js`，再构建 `web`。`dist/cli.js` 是编译产物，所以改了 `server/` 源码要重跑构建；
   只重建后端用 `npm run build --workspace shared && npm run build --workspace server && node scripts/write-root-cli.mjs`。
   **前端 dev 也依赖 `shared` 的构建产物**：`web` 里的 `import { t } from '@allibot/shared'`
   走 `shared/package.json` 的 `exports`，读的是 `shared/dist` 而不是 `shared/src`（Vite 只对
   `web/src` 直读源码）。所以改了 `shared/src` 必须先重建 `shared`；`npm run dev:web` 已经把
   这一步放进脚本，不必先跑整条 `npm run build`。
2. **一次性迁移**：`npm run migrate`（即 `node dist/cli.js --migrate`）。数据目录默认
   `~/.allibot/data`，可用 `--data-dir <path>` 或 `allibot_DATA_DIR` 改。迁移不塞进 `serve`：
   迁移是一次性动作，起服务是每次动作；`serve` 在库缺失或 schema 落后时明确失败，不隐式迁移。
3. **起后端**：`npm run dev:server`（即 `node dist/cli.js serve --port 3000`），只绑定
   `127.0.0.1:3000`。
4. **起前端 dev**：`npm run dev:web`（即 `npm run build --workspace shared && npm run dev --workspace web`），
   浏览器打开 `http://localhost:5173`。改完 `shared/src` 要**重启** dev，只刷新页面不够：
   Vite 把 `@allibot/shared` 预打包在 `web/node_modules/.vite` 里，重启前一直是旧产物；
   重启后仍不生效时删掉 `web/node_modules/.vite` 再起。产物过期表现为整页白屏而不是缺词条：
   `shared/src/strings/index.ts` 的 `t()` 对不存在的键直接抛错，这是刻意不降级。

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

## 真实模型 provider 的工具循环：已进循环 / 仍属脚本化专用（M2 A1）

真实模型 adapter 不再是单轮文本补全：`server/src/model-provider.ts` 在一次 `runRound` 内跑
**轮内工具循环**（round-level tool loop）。一次往返 = 模型请求一批工具 → 本轮执行这一批 →
结果回灌 → 再问模型，直到模型不再请求工具。接缝形状不变：`deferred` 仍为 `false`，一轮仍
至多落一条 target 消息，工具调用之间的旁白不落库，只有最后一段文本是本轮回复。

### 已进循环的工具与条件

- `Read` / `Glob` / `Grep`：需要项目根（`RoundInput.workspace` 非空）。可读根只有项目根与
  成员只读 `skills/` 第二根；越根、不存在、不可读都是回灌给模型的工具结果，不结束轮次。
- `TaskList` / `TaskGet`：需要 Plan face（`RoundInput.plan` 非空），只读本轮 Plan run；
  `TaskGet` 查不到 id 是 `not-found` 工具结果。
- `Bash`：执行类。条件是轮次装配已经按 M2 的既有规则把 `Bash` 放进可用集——频道
  `allow_local_shell=1`，或者 Docker 工作区后端（容器内的 shell）；两者都需要项目根，
  没有项目根的轮次（DM、未配置根的频道 / 任务）根本没有 shell face。Docker 不可用
  （无 daemon / 镜像缺失 / consent 缺失 / 容器创建失败）是轮次在适配器之前就失败的
  目标上下文事实，不是「Bash 被拒」，此时零工具调用。
  - 参数只有 `command`（一条命令串）：工作目录固定为项目根，**不是**参数，模型无法选择；
    多给 `cwd` 之类的参数会被参数形状检查拒绝为 `invalid-arguments` 工具结果。
  - 每次调用都走 M2 的硬审批（`allow_local_shell=1` 之后即使 trusted-writes 或 `Bash`
    allow 规则也要问）：批准才执行，拒绝是 `denied` 工具结果、命令不执行、轮次继续；
    `deny` 规则与 read-only 硬顶不询问直接 `DENIED`；等满 600 秒批次超时收口 `failed`。
  - 非零退出码、stderr、命令不存在（`exit-code: 127`）都是这次调用的结果，不是轮次失败：
    回灌内容是 `[Bash] ok` + `command` + `cwd` + `exit-code` + `stdout` / `stderr` 两段正文。
    已完成命令的 `exit_code` 原样陈述，不折成工具错误。
  - 输出在 shell 侧按每条流 1 MiB 封顶（`MAX_SHELL_OUTPUT_BYTES`）；被截断时回灌结果在
    **两段正文之前**写明「输出已截断：…超过 1048576 字节上限，超出部分未捕获」。这条事实
    必须排在正文之前，因为 20000 字的回灌上限会在正文头部切一刀，尾部提示会先被切掉。
- 两家 provider（`anthropic` 与 `openai:<模型>`）行为一致：工具定义与工具结果各按自己的
  wire shape 序列化（`tools[].input_schema` + `tool_use` / `tools[].function.parameters` +
  `tool_calls`），循环、上限与收口完全一致。
- 没有工具面（DM、无项目根、无 Plan face）时，请求里根本不带 `tools`，行为与原来的单次
  补全相同。

### 仍属脚本化专用的工具

以下工具名在轮次可用集里，但本批没有给模型提供规格，因此真实模型调不到，只有脚本化
provider（`--scripted-provider`）能驱动：

- 写类：`Write` / `Edit`；MCP 工具 `mcp:<server>/<tool>`。
- 编排类：`TeamAssign` / `transfer_task` / Plan 的写工具 `TaskCreate` / `TaskUpdate`。
- `SopVerdict` 的结构化判定通道：通道已定（一个专用 `internal` 类工具映射到既有
  `sopVerdict`），本批未实现；`RoundResult.taskAction` 用的同一条通道同理。

接入真实模型不等于 team 分派、Plan 写、SOP 判定或写类工具可用；本版本不能这样宣传。
执行类的 `Bash` 已进循环，但它的边界是本机明文 shell + 逐次审批 + 项目根工作目录，没有沙箱。

### 上限语义

`agent_config.max_iterations`（默认 10，人类面可编辑）是**轮内模型↔工具往返批次**的上限，
不是轮次计数：一次往返就是一批工具（一批里可以有多个调用，全部执行），`= 1` 只跑一批。
只有真正执行的一批才花预算；模型请求下一批而预算已尽时，那一批**不执行**。

- 撞上限：轮次 `replied`，把停下时那一轮 assistant 文本作为部分结论落成消息（它请求的那批
  工具调用已无预算执行），`finished_reason` 读「达到迭代上限」，触发消息照常消费（游标
  推进，下次唤醒不重读）。**这不是错误状态。**
- 撞上限且没有任何产出文本：按既有 empty completion 规则收口 `failed`，`finished_reason`
  读「错误」，不伪造一条空消息。

### 回灌限流

- 单条工具结果超过 20000 字时，只截断**模型读到的那一份**，并在截断处写明「已截断：已给
  N 字，共 M 字；其余内容未回灌」；工具自身的结果不受影响。
- `Grep` 命中数封顶 200、Docker 侧扫描文件数封顶 2000 会如实说明原因（「还有更多匹配未
  列出」/「还有文件未扫描」）。封顶是事实而不是计数启发式：恰好 200 条完整命中不会被说成
  封顶。
- 命中行正文在工具侧已按 300 字截断（带省略号），回灌层不再叠加。
- `Bash` 的输出在 shell 侧已按 1 MiB 封顶，回灌结果在正文前显式写明「输出已截断」；
  这一条与回灌层的 20000 字上限是两件事，两条都会在结果里出现。

### 失败分层

- **工具面失败**（越根、不存在、不可读、参数形状不合、未知工具、审批拒绝）是回灌给模型的
  工具结果，带稳定错误码（`outside-root` / `not-found` / `invalid-arguments` /
  `unknown-tool` / `denied`），轮次继续，由模型自己改道。
- **provider 链路失败**（HTTP 非 2xx、响应不可解析、单次调用 60 秒超时）收口 `failed`，
  reason 走「模型调用失败：{message}」，错误体里的密钥已掩码。
- 缺 consent、缺凭证、未配置模型仍是**零远端调用** + `failed`，reason 点名 provider /
  环境变量 / 没有可解析的 `provider:model`。

### 审批语义（工具闸门不变）

- 需要审批的调用在循环内**阻塞等待**人类决定：批准即继续执行，拒绝作为 `DENIED` 工具结果
  回灌，模型继续循环——拒绝是结果，不是轮次失败。
- 等满 600 秒批次超时后抛 `ApprovalTimeoutError`：它**不回灌**，本轮直接收口 `failed`，
  reason 读「审批等待超时（600 秒），本轮以失败收口。」；否则一个没人看的轮次会一直续跑到
  上限。
- 只读工具在默认路径上不触达审批（`read` 类落到 `mode-allow`），但一条
  `permission_rule(Read, …, ask)` 会让它们触达：此时同样阻塞等待、超时同样收口 `failed`。
- 本批没有「一轮内审批批次数」上限，所以一条 `ask` 规则可以让一个只读轮次占满一个 600 秒
  批次。这是接受的风险，不是遗漏。

### 仍不提供的能力

- AG-UI 不发工具调用事件（没有 `TOOL_CALL_*`），前端看不到轮内工具进度。
- 工具调用不入库：没有审计面，也没有新表 / 新列，`SCHEMA_VERSION` 仍为 21，本批无迁移步骤。
- 无 deferred / 异步收口：一轮在同一个 HTTP 请求内跑完，默认最坏情况是 10 批工具执行、11 次
  模型调用 × 单次 60 秒超时，需要审批时再叠加 600 秒批次等待。
- 无 token 级流式：文本仍一次性返回，AG-UI 的 `TEXT_MESSAGE_CONTENT` 语义不变。
- 无每 Agent 工具白名单：模型可见工具仍只由轮次可用集（项目根 / Plan face / 频道的
  `allow_local_shell` 与工作区后端）决定，`permission_rule` 只判定调用是否放行，不是可见性
  过滤器；也没有新的配置面。
- 无本机 provider 通道：仍只有 `anthropic` 与 `openai` 两条线（M1 D1.10 的延后项不随本批
  引入）。

这是部署时必须向使用者说明的边界，不是配置开关。

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
