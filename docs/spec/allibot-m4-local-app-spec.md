> 本规格把 M4 的范围（「从开发者仓库到 owner 每天能打开的应用」）转写成可实施、可验收的决策集合。章节沿用 M1 / M2 / M3 规格的七章节模板；术语沿用 `GLOSSARY.md` 的中英并列写法，`Avoid` 列是约束。基线是 `main` 的 `cc78ddd`（PR #80 合并提交）：`SCHEMA_VERSION = 25`、`GLOSSARY.md` 826 行、ADR 0001–0010、`server/src/http.ts` 1144 行、`server/src/cli.ts` 288 行、`docs/deployment.md` 435 行、`web/dist` 18 MB、`package.json` 共 24 个 `test*` 脚本。**本规格不改 Schema。**

## Problem Statement

M1–M3 把这个产品做成了**能跑**的东西：协作域、真实模型工具循环、联网三件套、权限与审批全部就位。但它还不是**能每天打开**的东西，差距有三条具体、可核对的事实。

其一，**后端不托管前端**。`server/src/http.ts` 的 `createServer` 只做两件事：`isCopilotKitPath` 分给 CopilotKit handler，其余交给 `handleRequest` 的 `ROUTES` 表。`grep static server/src/*.ts` 只命中 `ApiFailure.static`，没有任何静态文件服务。于是 `web/vite.config.ts` 里那条 `/api` 代理是**唯一**能打开界面的路径：owner 想用产品，必须同时起 `node dist/cli.js serve`（3000）与 `npm run dev:web`（5173），也就是每天开一条开发者工具链。`web/dist` 其实已经被 `npm run build` 真实产出（`index.html` + 426 个 asset），只是没有人托管它。

其二，**迁移提示里的命令跑不通**。`shared/src/strings/zh-CN.ts:48-53` 的 `cli.schema.tooOld` 对 owner 说「启动服务前先运行 `allibot --migrate --data-dir {data_dir}`」。但这台机器 `command -v allibot` 无输出，`package.json` 没有 `bin` 字段 —— 也就是说提示给的是**一条不存在命令**。照抄的 owner 会得到 `command not found`，而真正能跑的是根脚本 `npm run migrate`（=`node dist/cli.js --migrate`）或 `node dist/cli.js --migrate --data-dir <path>`。这条是现有实现的缺陷，不是待补的新功能。

其三，**空库首屏是空的，而且不说下一步**。迁移只 seed 唯一 owner 行（`server/src/db.ts:53` 的 `member_single_owner` 唯一索引），没有频道、没有 Agent、没有默认模型。空状态文案是纯否定句：`workspace.nav.empty` = 「暂无」、`workspace.member.empty` = 「暂无成员。」、`workspace.plan.empty` = 「暂无计划」，`workspace.agentDetail.model.unset` = 「未配置」。缺凭证的解释 `round.credential.missing` 只在**一轮失败之后**才出现（`zh-CN.ts:335-338`），首屏一个字都不说密钥放哪、为什么不写库。结果是从空库到发出第一条消息这条路，只能靠回文档走。

三条合起来是一个共同结论：工程师能从仓库跑起来，owner 不能从书签打开。

## Solution

一个里程碑做三件事，各自有独立的验收面，**都不碰数据正本**。

**同源静态宿主。** `serve` 在 `ROUTES` 表之前插入一段静态分支：非 `/api` 的 `GET` / `HEAD` 由 `web/dist` 提供，未命中的无扩展名路径回退 `index.html`（SPA），`/api` 前缀永不落静态。于是产品从两进程变一进程，`/api` 的 REST、SSE 与 CopilotKit 三面与前端天然同源 —— 这正是 `web/vite.config.ts` 那条代理在 dev 下模拟的东西，现在生产侧直接成立。

**一条命令启动，提示必须可执行。** 根脚本增加 `start`；`serve` 在 `web/dist` 缺失时**明确失败**并说明构建命令，而不是降级成「只有 API」。同时把 `cli.schema.tooOld` 里的 `allibot --migrate` 改成仓库里真能执行的命令 —— 提示的验收标准是「照抄能跑通」，不是「文案看起来专业」。

**空状态自解释。** 三处（无频道 / 无 Agent / 缺模型凭证）从「暂无」改成「下一步做什么 + 可点的动作」，模型的空白状态必须点名环境变量并说明密钥不写库。验收标准是 D5 的一句话：**从空库到发出第一条消息，全程不用回文档**。

一条贯穿的纪律：这是**投递里程碑**，不是能力里程碑。它不改 Schema、不加新机制、不换测试范式、不动判定顺序。任何需要新表、新判定路径或浏览器自动化的想法，都属于下一个里程碑。

## User Stories

1. As an owner, I want the server to serve the built frontend itself, so that running the product is one process instead of two.
2. As an owner, I want opening a bookmark to land on the workbench, so that I do not need the Vite dev server to use the product.
3. As an owner, I want an unknown `/api` path to stay a JSON `not_found`, so that a request typo never returns HTML that `response.json()` chokes on.
4. As an owner, I want a missing asset to be a 404 rather than the SPA shell, so that a broken stylesheet fails loudly instead of silently.
5. As an owner, I want an extensionless path to get `index.html`, so that a deep link survives a refresh.
6. As an owner, I want a path traversal attempt rejected, so that the static host cannot read outside the build output.
7. As an owner, I want hashed assets cached as immutable and `index.html` never cached, so that an upgrade cannot serve a stale shell with fresh bundles.
8. As an owner, I want `serve` to fail loudly when the frontend build is missing, so that "the page is a 404" is not a mystery to debug.
9. As an owner, I want one command to start the whole app, so that I do not assemble four steps from a document.
10. As an owner, I want the schema-mismatch hint to print a command that actually exists, so that following it works on the first try.
11. As an owner, I want the empty workbench to tell me the next step, so that an empty database still has an obvious next action.
12. As an owner, I want the missing-model state to name the environment variable and say the key is not stored in the database, so that I know where to put it and why it is not in a form.
13. As an owner, I want one command to upgrade, so that I cannot skip the build and start a stale `dist`.
14. As an owner, I want an upgrade to refuse rather than merge when my checkout has diverged, so that a convenience script never rewrites my work.
15. As an owner, I want the dev flow with hot reload preserved, so that working on the frontend stays pleasant.
16. As a maintainer, I want the static root injectable in tests, so that the HTTP seam stays the only seam.
17. As a maintainer, I want zero schema change in this milestone, so that a delivery milestone adds no migration risk.
18. As a maintainer, I want the not-found envelope unchanged, so that the existing 22 web suites and their assertions keep their meaning.

## Implementation Decisions

**D1 静态分支的插入点。** 在 `startHttpServer` 的 `createServer` 回调里，`isCopilotKitPath` 判定之后、`handleRequest` 之前插入静态分支。顺序不可换：CopilotKit handler 与 `ROUTES` 都要先拿到它们的路径；静态分支必须在 `ROUTES` 之后不成立，否则 `/api` 的未命中会被 SPA fallback 吞成 HTML。判定条件：`method` 是 `GET` 或 `HEAD`，且 `pathname` **不**以 `/api` 开头（前缀判定，含 `/api` 本身）。

**D2 fallback 判定表。** 按顺序求值，首个命中即返回：

| 条件 | 结果 |
| --- | --- |
| `pathname` 落在 `/api` 前缀下 | 不进入静态分支，交给 `ROUTES` 与既有 `not_found` |
| `webRoot` 下存在该文件 | 返回文件 |
| `pathname` 以 `/assets/` 开头且文件不存在 | `404`（**不**回退 `index.html`） |
| `pathname` 的 `lastPathSegment` 含 `.` | `404` |
| 其余 | `index.html`（SPA fallback） |

第四行的判据是**最后一段含点**而不是白名单扩展名：Vite 产物里的 `.js` / `.css` / `.woff2` / `.svg` / `.ico` / `.map` 都会命中，而 `/channels/abc`、`/tasks/123` 这类前端路由不含点。第三行与第一行是两条独立的护栏：`/assets/` 下的失败必须是硬 404，因为它最容易被误判成路由。

**D3 缓存与 MIME。** `/assets/` 前缀下（Vite 输出带内容 hash）回 `cache-control: public, max-age=31536000, immutable`；`index.html` 回 `cache-control: no-cache`。`content-type` 按扩展名映射，覆盖 `html` / `js` / `mjs` / `css` / `json` / `svg` / `png` / `jpg` / `ico` / `woff2` / `map` / `txt`；未知扩展名按 `application/octet-stream`。所有文本类型带 `; charset=utf-8`，与既有 REST 响应口径一致。

**D4 路径安全。** 静态根之外的读取一律拒绝（`403` 或 `404`，取一，写死在测试里）。实现：`decodeURIComponent` → `normalize` → 拒绝任何 `..` 段 → 拼接后确认结果仍在 `webRoot` 内（前缀比对带分隔符）。拒绝用 `404` 而不是 `403`，不为探测者提供路径存在性信息。

**D5 `web/dist` 缺失即失败。** `serve` 启动时检查 `<webRoot>/index.html` 是否存在，缺失时抛错并说明构建命令，与既有的 `cli.serve.databaseMissing` 同形。**不降级**成「只提供 API」：降级把「打开是 404」变成一个需要读源码才能解释的谜。与 `t()` 对缺键直接抛错的既有风格一致。

**D6 静态根的解析与注入。** `webRoot` 由模块位置解析（`import.meta.url` 相对定位到仓库根的 `web/dist/`），**不用 `process.cwd()`** —— 否则从别处启动就找错目录。`startHttpServer` 的 `options` 增加 `webRoot?: string`，测试注入临时目录里的 `index.html` + `assets/*`；这与既有 `sseLifetimeMs?` / `env?` 的注入形状相同，不新开第二条 seam。

**D7 单命令启动。** 根 `package.json` 增加 `"start": "node dist/cli.js serve"`。保留 `dev:server`（既有）与 `dev:web`（dev 流程，见 D12）。**不**新增 `bin` 字段、不安装全局命令：M4 不做分发，装一个全局命令会把「怎么升级」变成另一个问题。

**D8 可执行提示（修正既有缺陷）。** `cli.schema.tooOld` 的文案从 `allibot --migrate --data-dir {data_dir}` 改为仓库里真实存在的两条：默认数据目录用 `npm run migrate`；显式目录用 `node dist/cli.js --migrate --data-dir {data_dir}`，并写明「在仓库根执行」。`cli.schema.tooNew` 不含命令行，保持原样；本次只修 `cli.schema.tooOld` 与 `cli.serve.databaseMissing` 两处指向不存在命令的文案。验收是 **`test:strings` 断言 zh-CN 目录里不再出现 `` `allibot --migrate `` / `` `allibot ` `` 形式的命令行**，再补一条断言文案里出现 `npm run migrate`。

**D9 空状态引导三处。** 只改三处，不铺开：

1. **无频道**：频道列表空 → 「还没有频道。先建一个频道，再建 Agent 并加入，才能开始对话。」+ 创建入口；
2. **无 Agent**：成员面空 → 「还没有 Agent。每个 Agent 有角色、模型与系统提示，可由你点名唤醒。」+ 创建入口；
3. **缺模型 / 缺凭证**：Agent 详情与状态点把「未配置」改成点名事实 —— 「模型密钥从环境变量读，不写库：需要 `{env}`。设置后需重启后端。」`{env}` 由 provider 推得，与 `round.credential.missing` 用的是同一个来源。

三处都是 `zh-CN` 文案 + 空状态渲染，不加新组件族、不做多步向导、不做「跳过」逻辑。

**D10 一条命令升级。** 根脚本 `"upgrade": "git pull --ff-only && npm install && npm run build && npm run migrate"`。`--ff-only` 是刻意的：分叉时明确失败，而不是产生一个合并提交。边界写死：不建备份、不改数据目录位置、不自动回滚、不在 `dist` 缺失时跳过后端构建。它只做这四件事。

**D11 零 Schema 变更。** `SCHEMA_VERSION` 保持 25。本里程碑没有任何表、列、索引、CHECK 或迁移步骤。这条要写进规格是因为它**是决策**：为了一个投递里程碑动数据正本，收益为零、风险为正。

**D12 dev 流程保留。** `npm run dev:web`（5173 + `/api` 代理）与 `npm run dev:server` 一行不改。M4 只增生产路径，不替代开发路径 —— 热重载是维护这个仓库的手段，不是产品功能。

## Testing Decisions

**唯一 seam 不变。** 测试仍只穿越后端 HTTP 面与前端 DOM 桩：真实后端进程 + 临时数据目录 + 注入 provider，静态根用临时目录注入（D6）。不引入无头浏览器、不引入真实网络、不引入真实 Docker。

**必须覆盖的外部行为。**

- 静态命中：`/` 返回 `index.html`；`/assets/<hash>.js` 返回脚本且 `content-type` 与 `immutable` 缓存头正确。
- SPA fallback：`/channels/abc`、`/tasks/123` 这类不含点的路径返回 `index.html`。
- 硬 404 两条：`/assets/nope.js` 返回 `404` 且**响应体不是 HTML**；`/favicon-nope.png` 返回 `404`。
- `/api` 护栏：`GET /api/nope` 仍是既有 JSON `not_found` 信封，且 `content-type` 不是 `text/html`。
- 路径安全：`/../server/package.json`、`/%2e%2e/server/package.json`、`/assets/../../package.json` 都被拒。
- `web/dist` 缺失：`serve` 失败且错误文案给出构建命令（不是「只有 API」）。
- 提示可执行：`zh-CN` 里不存在 `` `allibot --migrate `` 与 `` `allibot ` `` 形式的命令；`cli.schema.tooOld` 文案含 `npm run migrate`。
- 空状态三处：空库下 DOM 桩渲染出三处引导文案与对应动作入口；缺模型时文案含环境变量名。
- `upgrade` 脚本形状：四个步骤齐全，`git pull` 带 `--ff-only`。
- 端到端：空库 → 建 Agent → 建频道 → 发第一条消息 → 脚本化 provider 回复，全程只走一次 `serve`（真进程、真静态根、真 HTTP）。

**先例。** `server/test/m2-e2e.test.ts`（真进程 + 真 HTTP + 脚本化 provider）、`server/test/version-gate.test.ts`（Schema 闸门与文案）、`web/test/task-board.test.ts` 与 `web/test/agent-detail.test.ts`（DOM 桩断言空状态与文案）是本批的形状先例。`shared/test/string-catalog.test.ts` 与 `web/test/strings.test.ts`（各跑一次 `test:strings`）是 D8 那条断言的落点。

**没有 CI。** 仓库至今没有 `.github/workflows`，所有门禁靠人肉跑（`npm run typecheck`、`npm run test`，24 个 `test*` 脚本）。本规格不假设 CI 存在，因此每条验收都必须能由一条本地命令复现。

## Out of Scope

- **安装包与分发**：不做 npm 全局包、brew formula、`.app`、`pkg` / `bun compile` 单文件二进制。`better-sqlite3@13.0.3` 是原生模块（`engines.node >= 22.18`），单二进制打包没有把握，而「给自己的机器日常用」不需要它。
- **Docker Compose 部署**：本仓已经用 Docker 跑 Agent 工作区（`DockerWorkspaceManager` / ADR-0006）；产品本体再进容器会把「项目根」与「Agent 家目录」的挂载语义重定义一遍。
- **开机自启与托盘**：不做 launchd plist、不做菜单栏应用、不做后台常驻。
- **日志落盘**：不写 `<data-dir>/logs/`、不做轮转与保留策略。手动启动的终端就是日志；长期观测属可观测方向，不混进本里程碑。
- **浏览器自动化验收**：不引入 Playwright / Chromium，不改测试范式。缺口（验不到「视觉上走不通」）已知且被接受，`test:visual-contract` 继续守它那一层。
- **Schema 变更**：零迁移（D11）。
- **前端体积优化**：`web/dist` 18 MB 与构建时的 500 kB chunk 警告不在本规格内。
- **多用户 / 登录 / 远程访问 / 云端同步 / 移动端**：`docs/spec/allibot-v2-spec.md` 的「明确非目标」原样保留。
- **英文词条表**：新增文案只进 `zh-CN`。
- **current M1–M3 的行为变更**：不改判定顺序、不改工具类、不改审批语义、不改 SSE 与 AG-UI 契约。

## Further Notes

**基线数字与来源。** 基线 commit `cc78ddd`（PR #80 合并提交）。`SCHEMA_VERSION = 25`（`server/src/db.ts:10`）；`GLOSSARY.md` 826 行；ADR 0001–0010 共 10 个；`server/src/http.ts` 1144 行（`startHttpServer` 在 154 行，`ROUTES` 表在 228 行起，`handleRequest` 的 `not_found` 兜底在 908 行起）；`server/src/cli.ts` 288 行（`assertServeableSchemaVersion` 的调用在 114 / 141 / 168 行，`startHttpServer` 调用在 208 行）；`server/src/args.ts` 456 行；`docs/deployment.md` 435 行；`web/dist` 18 MB（`index.html` + 426 个 asset）；`package.json` 24 个 `test*` 脚本（其中 `web` 22 个、`server` 1 个）。以上都从该 commit 上 `wc -l`、`grep -n`、`du -sh` 与源码直读得到，不凭记忆。

**一处对 grill 结论的事实纠正。** grill 阶段我以为「`serve` 检测到 schema 落后时只给一句失败」，据此把 D4 定成「补一条可复制命令」。核对源码后事实是：**可复制命令早就有了**（`zh-CN.ts:48-53`），问题是**那条命令不存在** —— `package.json` 没有 `bin` 字段，`command -v allibot` 无输出。所以 D4 的内容从「加提示」改为「修正不可执行的提示」，验收也从「提示存在」改为「照抄能跑通」。这条纠正写在这里而不是悄悄改掉，因为它是本规格唯一一条推翻了既有假设的决策。

**为什么不新增 ADR。** `docs/adr/` 的三条件是「难以逆转 + 影响多方 + 需要解释为什么」。同源静态托管是 ADR-0002「CopilotKit 原生工作台」立场的落点（工作台本来就意味着一个进程），不是新的取舍；单命令启动、空状态文案、`upgrade` 脚本都是可逆的实现细节；零 Schema 变更本身就是「没有不可逆决定」的证明。因此本规格只更新 `docs/deployment.md`（`serve` 的职责、`npm start`、`upgrade`、静态根的失败语义），不新增 ADR。

**与既有 ADR 的关系。** ADR-0002（工作台形态）与 ADR-0004（迁移闸门）是本规格的两条支撑：前者让「一个进程托管前端」成为自然结论，后者让「保持显式迁移、只修文案」成为唯一不破坏闸门的做法。ADR-0006 / ADR-0007 / ADR-0009 / ADR-0010 不动。

**票图（规格内部键，不是 GitHub issue 号）。** T1 静态宿主（D1–D4、D6）；T2 单命令启动与 `web/dist` 缺失失败（D5、D7）；T3 可执行提示（D8）；T4 空状态引导三处（D9）；T5 `npm run upgrade`（D10）；T6 端到端验收：空库 → 第一条消息；T7 文档对齐（`docs/deployment.md` 与 README 的启动/升级章节）。建议顺序：T1 → T2 → T3 → T4 → T5 → T6 → T7；T6 依赖 T1–T5 全部落地，T7 可在 T1–T5 之后与 T6 并行。

**风险。** 三处值得先写在前面：(1) SPA fallback 与 `/api` 前缀的边界最容易写错，错了的表现是前端某个请求拿到 HTML 而不是 JSON —— 这正是 `docs/deployment.md:44-51` 记录过的既有事故形态，所以 D2 与 Testing 都把这条列为必测；(2) `webRoot` 若用 `cwd` 解析，从仓库外启动会静默 404，因此 D6 写死用模块位置；(3) 空状态验收（「全程不用回文档」）比看起来难——它要求文案自己承担解释成本，而「暂无」这类否定句天然做不到，T4 的实现必须被 T6 的端到端流程真正走一遍，否则只是换了几个字。

**为什么问题陈述里要写「工程师能跑、owner 不能」。** 因为这是本里程碑唯一的正当性来源。若这一条不成立，M4 应该直接去做能力（记忆质量、成本观测）而不是投递。写在这里是为了让后续 review 能据此否掉任何「顺手加个功能」的膨胀。
