# allibot 部署说明（部署事实，不是完整沙箱承诺）

本文只陈述已经交付的部署边界：M2 的工作区后端与工具面，以及 M3 的联网三件套（联网档、联网
provider 凭据、容器出网）。它可以在 **local** 或 **Docker** 工作区后端上运行；它不是完整沙箱，
容器网络只有「默认无网 / 显式白名单」两态，按 host 的判定在联网工具层而不是网络层。

M4 只改投递面，不改上面这些边界：`serve` 同时托管工作台的静态产物，`npm start` 是一条命令起整套，
`npm run upgrade` 是一条命令升级（见「起服务」与「升级」两节）；工作区后端与 Schema（仍是 25）不变。

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
   `127.0.0.1:3000`。这是**开发**入口；构建产物齐全后的日常起服务用 `npm start`，见下一节。
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

## 起服务：一条命令与一个静态宿主（M4）

`serve` 现在同时是 API 与工作台的静态宿主：同一个进程、同一个 origin，没有第二个服务，也不需要
反向代理。构建产物齐全之后的日常起服务就一条命令：

```sh
npm start
```

它等价于 `node dist/cli.js serve`，只绑定 `127.0.0.1:3000`，浏览器打开 `http://127.0.0.1:3000`。
`npm start` 是**起整套**的入口，不是开发流程的替代：「本地开发」那几步（尤其 `dev:server` 与
`dev:web` 的 5173 热重载）一行未改，仍照旧使用。两者用的是同一份 `web/dist`，区别只是 dev 前端由
Vite 在 5173 上提供、后端在 3000 上提供 `/api`。

### `/api` 前缀与 SPA fallback 的分界

`startHttpServer` 里的判定顺序写死成三段：CopilotKit handler → 静态宿主 → `ROUTES`。静态分支的
条件只有一条：方法 `GET` / `HEAD`，且 `pathname` **不在** `/api` 前缀下（前缀判定，`/api` 本身也
算）。所以 `/api` 下的路径永远不进静态分支，没命中也仍由既有的 `ROUTES` 兜底。

进入静态分支后按顺序求值，首个命中即返回：

| 条件 | 结果 |
| --- | --- |
| `pathname` 落在 `/api` 前缀下 | 不进入静态分支，交给 `ROUTES` 与既有 `not_found` 信封 |
| `web/dist` 下存在该文件 | 返回文件（MIME 按扩展名，未知扩展名 `application/octet-stream`） |
| 以 `/assets/` 开头但文件不存在 | `404`，**不**回退 `index.html` |
| 最后一段含点（`/nope.css`、`/x.map`） | `404` |
| 其余（`/`、`/channels/abc`、`/tasks/123`） | `index.html`（SPA fallback） |

最后一行是前端路由能直接刷新、能贴地址就能直达的原因。倒数第二行的判据是**最后一段含点**而不是
扩展名白名单，所以 Vite 产物里的 `.js` / `.css` / `.woff2` / `.svg` / `.ico` / `.map` 缺失都是硬
`404`：一个写错的样式表不能静默变成一份 HTML，否则浏览器只会报「样式不生效」。同理，倒数第三行
与第一行是两条独立的护栏 —— `/assets/` 下最容易被误判成前端路由。静态根之外的读取（`..` 段、
`%2e%2e%2f` 这类编码过的斜线、拼完后跑出 `web/dist` 的路径）一律 `404` 而不是 `403`：不向探测者
提供「这个文件存在但你不该看」这一位信息。

`/assets/` 下的文件名带内容 hash，回 `cache-control: public, max-age=31536000, immutable`；
`index.html` 与其它文件回 `no-cache`，所以升级之后刷新页面就能拿到新的 asset 引用。

**`/api` 的未命中仍是 JSON，不是页壳。** 这是本仓已经踩过的事故形态：`/api` 的路径一旦被 SPA
fallback 吞成 `text/html`，前端的 `response.json()` 就在解析处抛错、而不是读到错误码 —— 一个拼错
的接口看起来会像「后端没起」或「设置读取失败」（词条 `settings.error.load`），排查方向直接跑偏。
所以 `/api` 的未命中保持既有信封：

```sh
curl -s http://127.0.0.1:3000/api/nope
# {"error":{"code":"not_found","message":"unknown route: GET /api/nope"}}
```

响应头是 `application/json; charset=utf-8` + `404`；静态宿主的 `404` 则是 `text/plain` 的
`not found: <pathname>`。两者形状不同是刻意的，用来区分「后端没有这条路由」与「前端没有这个文件」。

### `web/dist` 缺失：`serve` 明确失败，不启动成「只有 API」

启动前检查 `<web/dist>/index.html` 是否存在，缺失就直接失败退出（退出码 1），文案点名构建命令：

```sh
$ npm start
...
allibot：找不到前端构建产物 /<仓库根>/web/dist/index.html；启动服务前先在仓库根执行 `npm run build`，它会构建工作台的 web/dist。
```

词条键是 `cli.serve.webRootMissing`，与库缺失（`cli.serve.databaseMissing`）同形。检查发生在拿
数据目录锁、打开库之前；`startHttpServer` 里还有同一个断言，所以任何调用方都启不了一个只有 API
的服务。**不降级成「只提供 API」**：那会把「打开是 404」变成一个需要读源码才能解释的谜。修法是
在仓库根跑一次 `npm run build`（它会把 `shared`、`server`、根 `dist/cli.js` 与 `web/dist` 一起
构建出来）。

静态根由模块位置解析（相对 `server/src` 与 `server/dist` 定位到仓库根的 `web/dist`），不按
`process.cwd()`：从仓库外启动也照样找得到，不会静默变成「打开全是 404」。

## 升级：`npm run upgrade`

```sh
npm run upgrade
```

它就是根 `package.json` 里的这一行，四步、按顺序：

```sh
git pull --ff-only && npm install && npm run build && npm run migrate
```

1. `git pull --ff-only`：只接受快进。本地有分叉（本地提交、或历史被改写）时**明确失败**，不会产生
   一个合并提交。
2. `npm install`：按锁文件更新依赖。
3. `npm run build`：重建 `shared`、`server`、根 `dist/cli.js` 与 `web/dist`。少了这一步，`npm
   start` 会继续跑旧的 `dist`，所以它不能跳。
4. `npm run migrate`：一次性迁移（默认数据目录；换过数据目录就手动用 `--data-dir`，见「本地开发」
   第 2 步）。本里程碑零 Schema 变更，这一步是幂等的 no-op：已是最新时只回一句「数据目录 … 已是
   Schema 版本 25。」。

边界写死在这里，免得把它读成更宽的东西：

- **不做备份**：脚本不复制数据目录、不额外打包。备份仍是「备份边界」那一节的手工动作；迁移自身在
  需要改 schema 时会在数据目录同级建 `<data-dir>.backup-*`，`upgrade` 不在其上再加一层。
- **不改数据目录**：不带 `--data-dir`、不改 `allibot_DATA_DIR` / `allibot_HOME_DIR`；用哪个目录
  取决于你自己的环境。
- **不自动回滚**：任一步失败就停在那一步，已经落地的 `git pull` 不会退回去。
- **分叉即失败**：`--ff-only` 是刻意的 —— 一条「方便」的脚本不该替你合并或改写历史。

## 工作区后端

- **local（默认）**：受限文件工具在宿主进程内执行，cwd 是频道项目根；local shell 默认关闭，
  只有 `channel.allow_local_shell=1` 才启用，且每次调用仍逐次审批。local 模式没有沙箱：
  这是明确的已知风险，不能把它描述成隔离环境。
- **Docker**：文件工具、shell 与 stdio MCP 在每 `(member_id, target_id)` 一个容器内执行。
  项目根挂到 `/workspace`（rw），成员家目录挂到 `/agent-home`（ro），全局技能挂到 `/skills`
  （ro），数据目录**不**挂载。容器不持久、不跨 target 共享、不跨进程复用。

Docker 是容器隔离，不是网络隔离。M3 交付了容器网络的两态：缺省 `--network none`，或按频道的
`docker_egress` 与 host 白名单接入 Docker 默认网络（见「容器出网」）。但那份 host 白名单由联网
工具层执行，不是容器的网络策略：容器一旦接上默认网络，容器内进程并不被它逐 host 拦住。部署者
既不能把容器当作完整沙箱，也不能把「默认无网」读成「容器被限制在几个 host 上」。

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
- `Write` / `Edit`：需要项目根（`RoundInput.workspace` 非空），且只能写在项目根内——相对
  路径从根起算，绝对路径只在 realpath 落在根内时接受，`..` 一律拒绝；无项目根的轮次（DM、
  未设根的频道）拿不到这两个工具。`ask-writes`（默认档）下每次写调用都触发既有的 600 秒
  审批批次（见下方「审批语义」）：批准即写、拒绝回 `denied` 工具结果、超时收口 `failed`；
  越根、父目录不存在、`old_string` 未命中、写失败都是回灌给模型的工具结果，轮次继续。
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
- `mcp:<server>/<tool>`：执行类，名字是契约（D3）——它同时是模型可见的工具名、
  `permission_rule.tool_name` 与审批载荷里的那个字符串，改名等于三处一起改。工具集**不是**
  硬编码清单，而是本轮实际装配出来的 server 用 `tools/list` 答出的工具，按
  「内置工具在前、MCP 在后」的固定顺序追加：
  - `mcp.json` 是唯一正本（M2 D6.1）：文件缺失 = 零 MCP 工具、不报错；文件非法 = 整份不
    装配（连合法的兄弟条目也不连）；启用但未做 `('mcp', server)` 一次性远端确认的 http /
    sse server 零连接（`/api/remote-data-flow/consent`，`scope_kind = 'mcp'`，stdio 不需要）；
    server 连不上或 `tools/list` 取不到 = 零该 server 的工具。另外，名字拼不出合法
    `mcp:<server>/<tool>` 的工具（`server` 或工具名里含 `/` 或空白）不会被装配给模型：
    闸门的 execute 类正则只认 `mcp:<非斜杠非空白>/<非斜杠非空白>`，装配层不为它发明另一个
    名字。以上任一情况轮次都照常用剩下的工具跑完，不报轮次错，可读诊断只进
    `RoundOutcome.reason` 与 MCP 管理面。
  - 参数形状由 server 自己声明：本轮不持有那份 schema（`RoundMcpTool` 只有名字与描述），
    所以请求里的工具定义是开放式对象（`type: object` + `additionalProperties: true`），模型
    给的对象**原样转交**给 server，不套用文件工具那套扁平字符串检查；被 server 自己拒绝的
    参数是工具结果，不是轮次失败。
  - 每次调用都过 M2 的 execute 闸门：`permission_rule(  mcp:<server>/<tool>, <pattern> )`，
    pattern 匹配的是参数的 stable JSON（键递归排序后的 JSON，`*` 匹配任意内容，空 pattern
    匹配该工具的所有调用）。`deny` 与 read-only 硬顶不询问直接 `DENIED`；`ask` 在循环内
    **阻塞**进 600 秒审批批次：批准即调用，拒绝回 `DENIED` 工具结果、轮次继续，等满超时
    收口 `failed`。
  - server 返回 `isError`、连接中断、server 未装配都是工具结果（`error: tool-error` /
    `connection` / `unavailable`），轮次继续；回灌内容是 `[mcp:<server>/<tool>] ok` 或
    `error: <code>` + `server` / `tool` + server 正文，同样受 20000 字回灌上限约束。
- `TaskCreate` / `TaskUpdate`：Plan 写工具，需要 Plan face（`RoundInput.plan` 非空）——
  也就是说任务线程与 team 目标有，DM 与 autonomous 频道的普通轮次没有（请求里根本不带这两个
  名字）。`TaskCreate{title}` 追加到本轮 Plan run；`TaskUpdate{id, title?, status?}` 改标题
  和/或三词状态（`pending` / `in_progress` / `completed`）。`status` 是闭集：Schema 里带
  `enum`，其它值在进入 Plan face 之前就被拒成 `invalid-arguments` 工具结果（不是轮次失败，
  也不会改到任何一行）。查不到的 id 是 `not-found` 工具结果。
- `TeamAssign`：队长专用，需要队长的分派 face（`RoundInput.team.assign` 非空，只有真实队长轮次
  有）。`TeamAssign{member_id, instruction}` 走 M2 既有分派路径：成员子轮次在**同一个队长轮次内**
  跑完，assignment 记录、jump 消耗、子轮次产物全部按 M2 既有行为产生；成员输出只作为**工具结果**
  回给队长，不落成频道消息。队长不可用、`target_self`、成员不可用、预算耗尽等既有判定不变，
  失败是带稳定码（`not_leader` / `target_self` / `target_unavailable` / `budget_exhausted` /
  `member_failed`）的错误工具结果，轮次继续。
- `transfer_task`：任务当前受派者专用（`RoundInput.tools` 只在受派者轮次里给这个名字）。
  `transfer_task{member_id}` 不直接写库，它把本轮结论映射成既有的结构化任务动作
  `RoundResult.taskAction='transfer_task'` + `taskTransferMemberId`，真正的转派由既有写路径做
  （受派者变更、任务线程成员、系统变更记录、team 频道的 `team-change` 唤醒全部照旧）。
  目标不是本频道另一个存活 Agent 成员时写路径拒绝并在轮次原因里说明，写路径不动任何行。
- `SopVerdict`：**只在 verifier 轮**（`RoundInput.sop.role === 'verifier'`）装配的专用
  `internal` 工具，`SopVerdict{verdict: 'pass'|'fail'}` 由适配器映射到既有
  `RoundResult.sopVerdict`。判定的来源是**工具调用**：正文里写 pass 不算，不解析 `replies`；
  也不为两家 provider 各写一套结构化输出（OpenAI 的 `response_format` / Anthropic 的文本协议
  都不用）。没有调用这个工具时 `sopVerdict` 为空，SOP 运行按既有词条
  `sop.run.verifier.noVerdict` 失败。这个工具不对应任何 face、不进 `permission_rule` 词汇，
  因此没有审批批次。
- 两家 provider（`anthropic` 与 `openai:<模型>`）行为一致：工具定义与工具结果各按自己的
  wire shape 序列化（`tools[].input_schema` + `tool_use` / `tools[].function.parameters` +
  `tool_calls`），循环、上限与收口完全一致；结构化事实（`sopVerdict` / `taskAction` /
  `taskTransferMemberId`）两家走同一条通道，没有各自的解析分支。
- 没有工具面（DM、无项目根、无 Plan face）时，请求里根本不带 `tools`，行为与原来的单次
  补全相同。

### 结构化事实的生命周期

`SopVerdict` 与 `transfer_task` 记下的事实属于**轮次**，不属于正文：它们在循环里累积，本轮
无论以哪种方式收口都会带上——正常答复、撞 `max_iterations`、以及"模型说了判定但没有正文"。
最后一种按既有 empty completion 收口 `failed`，此时只保留 `sopVerdict`：判定就是 verifier 的
全部协议（`sop-executor` 只读这个字段）；转派动作**不**随一个没有产出的轮次走，因为写路径提交
任务动作时不看 verdict，而 `failed` 轮次不推进游标——否则同一条触发消息下次唤醒会再转派一次
（团队分派路径本来就有 `verdict !== 'replied'` 的守卫，这里是同一条不变量）。这不是新的可观测
面：映射目标是 `RoundResult` 的既有字段，没有新字段、没有新事件、工具调用本身不入库。

同一轮里同一个事实被陈述多次时，后一次覆盖前一次。

### 仍属脚本化专用的能力

以下能力只有脚本化 provider（`--scripted-provider`）能驱动：

- `continue_task`（自动续跑，结构化任务动作的另一半）：`RoundInput.tools` 里**没有**对应的
  工具名，本批也没有为它发明一个（工具名是对外契约，改名 / 新增等于同时改模型可见列表、
  `permission_rule.tool_name` 与审批载荷三处）。因此真实模型目前无法请求续跑，续跑仍由脚本化
  provider 驱动；这是本批如实保留的缺口。`transfer_task` 已经可用，`continue_task` 待定。

接入真实模型不等于自动续跑可用；本版本不能这样宣传。写类、执行类、MCP 工具、team 分派、
Plan 写、转派与 SOP 判定都已进循环，但边界仍是真实的：写只在项目根内；`Bash` 是本机明文
shell + 逐次审批 + 项目根工作目录，没有沙箱；MCP 工具只在 `mcp.json` 正本、远端一次性确认
与实际连上的 server 上可用，零 server 就是零 MCP 工具。

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
  `unknown-tool` / `denied` / `old-string-not-found`），轮次继续，由模型自己改道。
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
- 写类（`Write` / `Edit`）在 `ask-writes` 下按模式默认问，`trusted-writes` 下根内写直接放行、
  根外效果仍问；一条 reply 里的多次写调用沿用 ADR-0007 决定 5：同一 `approval_request` 行里
  合并 `tool_calls`，重开只发布新调用、保留历史决策，判据是全部历史决策。
- 本批没有「一轮内审批批次数」上限，所以一条 `ask` 规则或 `ask-writes` 下的一次写调用都可以
  让一个轮次占满一个 600 秒批次。这是接受的风险，不是遗漏。

### 仍不提供的能力

- AG-UI 不发工具调用事件（没有 `TOOL_CALL_*`），前端看不到轮内工具进度。
- 工具调用不入库：没有审计面，也没有工具调用表；M3 的 v22–v25 迁移只加两个联网档列、容器出网
  开关、凭据表与 `('web', …)` 的告知范围，与工具调用无关。当前 `SCHEMA_VERSION` 是 25，部署时
  跑一次 `npm run migrate`。
- 无 deferred / 异步收口：一轮在同一个 HTTP 请求内跑完，默认最坏情况是 10 批工具执行、11 次
  模型调用 × 单次 60 秒超时，需要审批时再叠加 600 秒批次等待。**这个上界只在每条 `Bash`
  命令都会自己退出时成立**——命令执行没有超时（见下一条），一条不退出的命令会让这个请求
  无界等待。
- `Bash` 没有命令级超时：`local-shell` 接缝（`RunShellRequest` / `RoundShellResult`）没有超时
  字段，`spawn` 也没有 timer，所以一条不退出或等 stdin 的命令会让这一轮的 HTTP 请求无界
  等待：既不回灌工具结果，也不收口。#75 里的「超时」在本批只覆盖 600 秒**审批批次**超时
  （等满收口 `failed`），不含命令执行本身；补上它要改接缝与错误码，属后续票。
- 无 token 级流式：文本仍一次性返回，AG-UI 的 `TEXT_MESSAGE_CONTENT` 语义不变。
- 无每 Agent 工具白名单：模型可见工具仍只由轮次可用集（项目根 / Plan face / 频道的
  `allow_local_shell` 与工作区后端；M3 又加了联网档与 provider 解析，见「联网能力」）决定，
  `permission_rule` 只判定调用是否放行，不是可见性过滤器；也没有按 Agent 逐工具勾选的配置面。
- 无本机 provider 通道：仍只有 `anthropic` 与 `openai` 两条线（M1 D1.10 的延后项不随本批
  引入）。

这是部署时必须向使用者说明的边界，不是配置开关。

## 联网能力（M3）：三个开关各管一件事

M3 交付了三件正本，`SCHEMA_VERSION` 因此到 25（迁移步骤 v22–v25）：

- **联网档**：`channel.web_access` 与 `agent_config.web_access`——本轮装配哪些联网工具；
- **联网 provider 凭据**：`web_provider_credential`——`web_search` 用哪家 provider；
- **容器出网**：`channel.docker_egress`——Docker 后端的容器接不接网络。

三者互不代替：档位开了不等于有 provider，有 provider 不等于容器能出网，容器能出网也不放宽工具
判定。`web_search` 与 `fetch` 都作为工具面进上文的轮内工具循环，走同一道闸门（ADR-0007）与同一
套回灌截断，没有第二套判定路径。

### 联网档：四档，与有效档位怎么算

档位只决定**装配哪些工具**：

- `off`：本轮**不装配任何联网工具**。它不是「装配了再全部拒绝」——模型根本看不到这两个名字，
  所以 `off` 不是模型能绕过的过滤器。
- `search`：只有 `web_search`。
- `search+fetch`：`web_search` 与 `fetch`。
- 未配置（`NULL`）：回退默认档 `search`。缺省就是「有 provider 就能搜」，关闭必须显式写 `off`。

有效档位的解析顺序：Agent 覆盖（`agent_config.web_access` 非 NULL）→ 频道值（`channel.web_access`
非 NULL）→ 默认档 `search`。私聊（DM）没有频道，所以 DM 的有效档位是「Agent 覆盖 + 默认档」；DM
的 `fetch` 永不装配（即使 Agent 覆盖写的是 `search+fetch`），闸门对 DM 的 `fetch` 也直接拒绝
（reason `read-only-tool`）——这是 DM 自己的硬边界，不是把 DM 的权限档改成 `read-only`（DM 的
`permission_mode` 仍按 Agent 覆盖或默认档算）。任务线程跟随所属频道的档位。写面是
`PATCH /api/channels/{id}` 与 `PATCH /api/agents/{id}` 的 `web_access`：
前者接受 `'off'` / `'search'` / `'search+fetch'` / `null`（`null` = 未配置），后者同样接受三档与
`null`（`null` = 清除覆盖、回到跟随频道），三档以外的值一律 400 且不写；这两条 PATCH 的其它字段
口径不变。

装配之上还有两层约束，两层都要读：

- **`read-only` 权限档下 `fetch` 不进工具集**（模型看不见）。万一模型仍然调用（陈旧装配、按规则
  直呼），闸门的硬边界直接拒绝：`deny`，reason `read-only-tool`，零 socket。两层都写，是因为
  装配层管「看不见」，判定层管「看见了也做不了」。
- **`search+fetch` 下 `fetch` 不逐次审批**：选这一档本身就是那次人类授权（决策 reason 记
  `web-fetch-tier`）。`permission_rule` 的 `deny` / `ask` 规则仍能收紧它——豁免排在规则合并之后：
  一条 `fetch` 的 `deny` 仍然拒绝，一条 `ask` 仍然进 600 秒审批批次（批准即取，拒绝是 `denied`
  工具结果、轮次继续）。

`fetch` 的规则 `pattern` 与审批载荷**只有 host**（`target.hostname`，不含协议、端口、路径与
query），所以一条带 `?token=…` 的 URL 不可能把 token 写进审批记录。规则按 glob 匹配这个 host
字符串（空 `pattern` = 该工具的全部调用）。`fetch` 自己是后端进程对目标 URL 的直接 GET：不带
provider 凭据、也不带任何凭据头（URL 里自带 `user:pass@` 的在闸门之前就被拒），同 host 的重定向
最多跟 5 跳，跳到另一个 host 时不跟、明确失败。

### 联网 provider 凭据

五家带凭据的 provider：`brave` / `tavily` / `perplexity` / `jina` / `exa`。每家一把 key，存
`web_provider_credential`（`provider` 主键、`api_key` **明文**、`is_default`、时间戳）；provider
取值由 CHECK 限定为这五家，至多一行默认（部分唯一索引保证）。这是本仓唯一一处明文入库的密钥，
由 ADR-0010 显式裁定；模型 provider 密钥仍然只从进程环境读、不写库。不做加解密，也不把它
扩成通用 secret store。

解析顺序唯一，逐级往下：

1. 进程环境 `allibot_WEB_SEARCH_PROVIDER` 点名的 provider；
2. 凭据表里的默认项（`is_default = 1`，至多一行）；
3. 已有凭据的 provider，按固定顺序 `brave` → `tavily` → `perplexity` → `jina` → `exa`；
4. 免凭据回退：该 Agent 的 `mcp.json` 里 server 名**恰为** `exa`、本轮已连上、且工具列表里有一个
   名字带 `search` 的工具（取第一个命中），经既有 MCP 面调用 `mcp:exa/<tool>`。名字近似
   （`exa-search`、`my-exa`）不算；它走既有的 `('mcp', server)` 确认，不需要 `('web','exa')` 行。

一个 provider 可用 = 它有凭据 **且** 有那一行 `('web', provider)` 的一次性远端数据流确认。未确认
的 provider 不可用，不会被静默跳过当成能用；某一步点名的 provider 缺凭据时往下走一步（名字是
偏好，不是硬失败）。

凭据值的优先级是**库内值优先、环境变量兜底**：同一 provider 两边都有时用库内值，所以 UI 里换 key
立即生效、不用重启进程（解析在每次调用时做，凭据值不被缓存）。环境变量只是兜底来源，不是
正本：

- `allibot_WEB_<PROVIDER>_API_KEY`（`BRAVE` / `TAVILY` / `PERPLEXITY` / `JINA` / `EXA`）：兜底的凭据；
- `allibot_WEB_<PROVIDER>_BASE_URL`：该 provider 的端点覆盖，未设置时用默认端点。它存在的理由是
  让测试把请求指向进程内的假 provider，生产不用它换家运行。

人类面读数（`GET /api/remote-data-flow` 的 `web_providers` / `web_consents` 等）只回掩码（形如
`sk-…abcd`）与「有没有凭据」；完整 key 不进 HTTP 响应、不进 SSE 帧、不进日志、不进轮次 reason、
不进审批载荷。写面是两条：`PUT /api/web-providers/{provider}/credential`（保存 key 的同时写那行
确认，一次调用两个事实）与 `POST /api/web-providers/{provider}/consent`（不换 key 也能补确认，
重复调用保留首次时间）。只接受这五家，第六家是 400。

**解析不出可用 provider 时，不静默降级成 `off`，也不把配置错误伪装成工具结果。** 有效档位不是
`off`、但上面四步都拿不到可用 provider 时：

- **装配层不把 `web_search` 交给模型**（不挂一个只会失败的工具）；`search+fetch` 下 `fetch`
  照旧装配——它不需要 provider。
- 模型仍然调用它（陈旧装配、按规则直呼）时，本轮在**调用点**失败：`failed` + 可读 reason，点名
  缺什么，例如「联网搜索不可用：provider brave 没有凭据（设置 `allibot_WEB_BRAVE_API_KEY` 或为
  该 provider 保存 key）」；零出网 socket。

收口挂在调用点而不是轮次开头，因为默认档就是 `search`：迁移上来的数据目录一个 provider 都没有，
若在轮次开头收口，每一次与联网无关的轮次都会失败。`fetch` 不受这条影响：它不需要 provider，是
一次直接的 host GET，缺凭据与缺确认都不挡住它（它只受档位、`read-only` 与 `permission_rule` 的
约束）。

### 容器出网

只有两态，没有第三种：

- **默认无网**：`docker_egress = 0`（缺省）→ 容器创建时带 `--network none`。
- **显式白名单**：`docker_egress = 1` 且该频道至少有一条带**显式 host** 的 `fetch` `allow` 规则
  → 容器接上 Docker 的默认网络（create 参数里没有 `--network none`）。

白名单就是那些显式 host 的集合，来源是同一批 `permission_rule` 行（`tool_name = 'fetch'`、
`behavior = 'allow'`、scope 是该频道），没有第二张 host 表。以下都不算显式 host，因此不贡献出网：
空 `pattern`（它只放行工具调用）、带协议 / 路径 / query 的 URL、端口、glob（`*.example.net`）与
正则；`deny` / `ask` 行也不贡献。所以：

- `docker_egress = 1` 但白名单为空（例如只有一条空 `pattern` 的 `allow`）→ **仍然无网**，不是
  「全开」。
- `docker_egress = 0` 时，即使规则里写着显式 host，容器也无网——开关在规则之前。

写面是频道视图：`PATCH /api/channels/{id}` 接受 `docker_egress` 的 `0` / `1`，其它值（`2`、`'1'`、
`null`、`true`）一律 400 且不写；读数随频道读数返回，没有 `/api/docker-egress` 这样的第二面。
Agent 级没有这个字段（与 `allow_local_shell` 同形）。

两点必须如实说明：

- **按 host 的判定不在网络层，在联网工具层。** 容器一旦接上默认网络，容器内进程（容器里的
  `Bash`、容器内 stdio MCP server）并不被那份 host 白名单拦在网络层：那不是防火墙，也不是通用
  网络策略。按 host 的允许 / 拒绝发生在 `fetch` 这个工具调用上，而 `fetch` 与 `web_search` 都由
  后端进程自己发起、不经容器——所以 `fetch` 能不能用由联网档与 `permission_rule` 决定，容器开不
  开网由 `docker_egress` 决定，两个开关不改写彼此。
- **网络在容器创建时定死。** 已经跑起来的容器不会因为改 `docker_egress` 或改一条 `fetch` 规则而
  热改网络；新事实作用于本进程此后创建的下一个容器（改项目根会导致重建，改开关不会立即重建）。

最后是本仓一贯的验证缺口：**真机 Docker daemon 与真实容器网络不在自动化 seam 内**。自动化只断言
两件事：假运行时收到的 create argv 里有没有 `--network none`（也就是上面那两态本身），以及白名单
就是唯一那份推导 `readChannelEgressHosts`（`server/src/docker-egress.ts`）从 `fetch` 的 `allow`
规则读出的 host 集合——host 不是从 create 参数里读回来的，create argv 只承载 `--network` 这一个
事实。真实容器里能不能出网需要部署者手工冒烟；这与 M2 的既有缺口一致，不能读成「已经证明容器无
网」。

## 备份边界

三种东西分开备份，不能互相替代：

1. **数据目录**：只承载 `allibot.db`、`attachments/`、`schema-migrations.jsonl` 与可丢弃的
   `mcp-hosts/`。整目录备份只复制这些内容；schema / 技能迁移的整目录备份落在数据目录的**同级**
   目录（`<data-dir>.backup-*`，名字里带迁移开始时间戳）；清单本身在数据目录内，
   `schema-migrations.jsonl` 的每一行记着对应那次备份的路径。

   **数据目录备份从此包含明文密钥。** `web_provider_credential.api_key` 是明文（ADR-0010 的
   命名例外，见「联网 provider 凭据」），它就在 `allibot.db` 里，所以一份数据目录备份 = 已保存的
   联网 provider 密钥一份不少地跟着走；迁移前自动建的那份 `<data-dir>.backup-*` 是数据目录的整
   目录副本，因此与数据目录同体携带同一批密钥，磁盘快照 / 整机备份同理。由此有两条操作要求，
   不是可选项：
   - **位置与可读性按密钥对待**：数据目录与每一份 `<data-dir>.backup-*` 都只应放在 owner 与运行
     后端的账号可读的位置（目录 700、文件 600 由部署层保证，本仓不加密库文件）。把这些副本拷到
     别处——另一台机器、共享盘、工单附件、聊天窗口——等于把密钥拷到那里。
   - **不用的副本删掉**：确认迁移后的库可用之后删掉旧的 `<data-dir>.backup-*`，不要长期堆成历史。
     想收回已落盘的密钥只有删 `web_provider_credential` 的行这一条路，而删完之后旧备份里仍然有。
2. **项目根**：`workspace_root` 指向的宿主目录（频道 / 任务共用其所属频道的根）。它是工作区
   内容的正本，M2 不把它复制进数据目录，也不把它放进数据目录备份；需要 owner 自行备份。
3. **Agent 家目录 / 全局层**：`~/.allibot/agents/<member_id>/`（`AGENTS.md`、`skills/`、
   `mcp.json`）与 `~/.allibot/skills/`。这些也不进数据目录备份；`AGENTS.md` 由人维护，
   软删除 Agent 不会删除家目录。可用 `--home-dir` / `allibot_HOME_DIR` 改全局层根。

## 密钥与日志

- 模型 provider 密钥与 MCP `env_names` 的**值**都不写入 SQLite、日志或 SSE。`mcp.json` 只声明
  变量名；shell / 工具进程按 allowlist 加这些名字从进程环境取值。
- **唯一的例外是联网 provider 凭据**（ADR-0010）：`web_provider_credential.api_key` 明文入库，
  所以数据目录备份与 `<data-dir>.backup-*` 都带着它（见「备份边界」）。例外只到这张表这一列
  为止：读数只回掩码，密钥值不进 SSE 帧、日志、轮次 reason 与审批载荷；provider 回显的片段在落
  成结果前按 `maskSecret` 掩码。
- 审批摘要只保留工具名与可读参数；MCP 参数与 Bash 命令中的 token 形值在入库、SSE 与 HTTP
  读数前都会掩码。
- `mcp_server`、`skill` 行只存元数据与 hash，不存字节或密钥。
