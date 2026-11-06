# allibot

本机的 AI 团队工作台：一个进程同时提供工作台页面与 `/api`，只绑定 `127.0.0.1:3000`。

这份 README 是 owner 的「装、起、升级」三步；部署事实与边界看 `docs/deployment.md`。

## 安装

需要 Node.js >= 22.18.0（见 `package.json` 的 `engines`）。在仓库根：

```sh
npm ci
npm run build
```

`npm ci` 按锁文件装依赖；`npm run build` 依次构建 `shared`、`server`、根 `dist/cli.js` 与
`web/dist`。`web/dist` 是工作台的构建产物，缺了它 `serve` 会直接失败并让你回来跑这条命令，
不会启动成一个「只有 API」的服务。

## 迁移数据目录

```sh
npm run migrate
```

数据目录默认 `~/.allibot/data`；换位置用 `--data-dir`：

```sh
node dist/cli.js --migrate --data-dir /tmp/allibot-data
```

迁移是一次性动作，起服务不会替你迁移：库缺失或 Schema 落后时 `serve` 明确失败，并告诉你该跑哪条
命令。本版本的 Schema 版本是 25。

## 起服务

```sh
npm start
```

然后打开 <http://127.0.0.1:3000>。换端口或数据目录：

```sh
npm start -- --port 3010 --data-dir /tmp/allibot-data
```

停服务用 Ctrl+C。数据目录的默认位置、备份边界与容器隔离的边界都在 `docs/deployment.md`。

## 首次配置：模型密钥

模型密钥**只从进程环境变量读，不写库**：

```sh
export ANTHROPIC_API_KEY=...   # 或者 OPENAI_API_KEY=...
npm start
```

- 为什么不写库：密钥一旦落进数据库，就会跟着数据目录备份一起走（拿到一份 `allibot.db` 就能读到
  它）。本仓只有一处例外——联网搜索 provider 的 key 存在 `web_provider_credential`、明文入库
  （ADR-0010），而它的读数只回掩码。模型密钥不走这条例外。
- 所以换 key 就是改环境变量并重启后端，界面里没有「填模型密钥」的输入框。
- 没配密钥时不会静默降级：轮次以可读原因失败，点名缺哪个变量，零远端调用。
- 每个 Agent 的模型写成 `provider:model`（例：`anthropic:claude-sonnet-4-5`、`openai:gpt-5`）；
  没配置模型的 Agent 以可读原因失败（「未配置模型」），不会拿默认模型顶上。

## 升级

```sh
npm run upgrade
```

它就是 `git pull --ff-only && npm install && npm run build && npm run migrate`。本地有分叉时直接
失败，不会产生合并提交；它不做备份、不改数据目录、不自动回滚。逐条边界见 `docs/deployment.md`
的「升级」。

数据目录与 `<data-dir>.backup-*` 里带着明文联网搜索 key，按密钥对待（见 `docs/deployment.md`
的「备份边界」与「密钥与日志」）。

## 开发

```sh
npm run dev:server   # 后端，127.0.0.1:3000
npm run dev:web      # 前端 dev，打开 http://localhost:5173，/api 代理到 3000
```

`npm start` 用的是构建产物，没有热重载；改前端时用上面这两条。改了 `shared/src` 要重启
`dev:web`（原因见 `docs/deployment.md` 的「本地开发」）。

## 文档

- `docs/deployment.md`：部署事实与边界（工作区后端、联网、备份、密钥）。
- `docs/spec/`：里程碑规格；`docs/adr/`：架构决策；`GLOSSARY.md`：术语。
