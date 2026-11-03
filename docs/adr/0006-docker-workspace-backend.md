# 0006 Docker 工作区后端与「不可用不回落」

## Status

accepted（2026-11-04）

## Context

M1 把工作区项目根、Agent 家目录、文件 / shell 工具与 Docker 后端整体延后到 T11；M1 的实际代码没有交付任何项目根文件工具，也没有 Docker 容器面。GLOSSARY.md 的「工作区后端 (Workspace Backend)」要求 local / docker 两档、频道给默认值、Agent 可覆盖、Docker 每 Agent / 每个运行上下文一个容器、项目根挂进容器且容器内固定 `/workspace`、不可用时明确失败且绝不静默回落本地外壳。旧仓的 ADR-0021 已经给过一套 Docker 语义，但本仓是全新的 TypeScript + SQLite + CopilotKit 实现，不能照抄旧仓的进程与路径。M2 必须决定：容器由谁创建、何时创建、挂载什么、进程退出后留下什么、不可用时如何失败、哪些网络行为留给 T12。这个决定影响部署、文件权限、工具执行位置与故障语义，回退成本高，且未来读者会问「为什么 local 不是沙箱、为什么容器不能复用」。

## Decision

1. **两档后端，local 默认。** `channel.workspace_backend ∈ {local, docker}` 默认 `local`；`agent_config.workspace_backend` 的 NULL = 跟随频道。频道与 Agent 的覆盖关系只影响工具执行位置，不改变项目根、成员家目录或 Skill / MCP 的正本位置。
2. **一个 Agent / 一个 target 上下文一个容器。** Docker 容器按 `(member_id, target_id)` 懒创建：第一次需要文件 / shell / stdio MCP 的轮次才创建；同一进程内同一键复用；不跨 target 共享，不跨进程复用。进程退出时停止并删除本进程创建的容器；启动时清理带本应用标记的残留容器。容器不是持久工作区，容器内文件改动以项目根挂载为准，容器内其它路径不保证保留。
3. **固定挂载。** 项目根挂到 `/workspace`（rw）；成员家目录挂到 `/agent-home`（ro）；全局公共库挂到 `/skills`（ro）；数据目录不挂。文件工具与 shell 的 cwd 是 `/workspace`，相对路径从项目根起算；`..`、根外绝对路径、逃逸 symlink 仍是装配层错误，不是审批问题。成员家目录与全局技能只读，应用写入仍在宿主完成。
4. **工具执行位置。** 文件工具、shell、stdio MCP 在容器内执行；http / sse MCP 由宿主进程连接，不依赖容器网络。工具进程只拿环境 allowlist 与 MCP `env_names` 指定的变量，不拿模型密钥、联网凭据或 registry 凭据。
5. **不可用明确失败。** 无 daemon、镜像缺失、镜像拉取失败、`('docker', image_ref)` consent 缺失、容器创建失败，都让该 target 上下文的工作区不可用：`workspace_status` 给可读 reason，状态点在目标上下文显示未启用，轮次零工具调用并以可读 reason 失败。绝不静默回落 local shell 或 local 文件工具。
6. **镜像是运行期输入。** 镜像引用来自进程级 `allibot_DOCKER_IMAGE`（默认 `node:22-bookworm-slim`）；镜像不在本机时，必须先有 `remote_consent_scope` 的 `('docker', image_ref)` 一次性确认才允许拉取。M2 不构建镜像、不存 registry 凭据、不做镜像市场。
7. **local 不是沙箱。** local 只开受限文件工具，shell 默认关闭；`channel.allow_local_shell=1` 才启用，启用后每次调用仍逐次审批且没有沙箱。Docker 是容器隔离，local 不是；产品文案不得把 local 说成沙箱。
8. **网络留给 T12。** M2 不实现 `docker_egress`、`--network none` 默认或 host 白名单；M2 只承诺容器生命周期、固定 `/workspace`、挂载与不可用失败，不对容器网络隔离做承诺。T12 在 M2 容器后端之上加出网策略。

## Consequences

- 文件 / shell 工具的执行位置成为频道 / Agent 配置的函数；同一成员在不同频道可以一个用 local、一个用 Docker，故障也按 target 上下文归属。
- 测试通过注入的假容器运行时观察 create / exec / stop / remove / inspect，HTTP seam 不变；真实 Docker 只做手工冒烟，自动化测试不依赖本机 daemon。
- 容器不持久、不跨进程复用，启动时清理残留；代价是每次进程重启后的首轮有创建成本，收益是不会积累孤儿容器与第二份工作区状态。
- M2 没有容器网络策略，部署说明必须明确「网络隔离尚未交付」；T12 完成前不能把 M2 说成完整沙箱。这是本 ADR 接受的已知风险。
- 镜像拉取需要一次性 consent；没有 consent 时不是「偷偷 pull」，而是明确失败。镜像构建、registry 凭据、多宿主 Docker 都不在本 ADR 的范围。

## Old ADR Correspondence

- 对应旧仓 ADR-0021（工作区项目根、local / Docker 后端、固定 `/workspace` 与不可用不回落）的语义；本 ADR 用本仓的 TypeScript 进程、CopilotKit 编排与 SQLite 正本重新实现，不复制旧仓编号空间。
- 旧仓 ADR-0026 的容器出网 / 网络策略不属于本 ADR；本 ADR 明确把 `docker_egress`、`--network none` 默认与 host 白名单留给 T12。
- 不涉及 ADR-0003（一个 target 一个 thread）：容器按 target 上下文创建，但容器不是 thread，也不改变 thread 身份。
