# 0002 CopilotKit 原生工作台形态

## Status

accepted（2026-11-03）

## Context

GLOSSARY.md 的「工作台 (Workspace)」是三栏界面 + 后端快照；「成员面板」是右侧 dock；「Agent 详情页签」是同一页的三个分组；「工作台版本」是 `/studio/` 与 `/studio/v2/` 两条入口（后者是 Vue SFC + Vite）。用户已定夺 D2：采用 CopilotKit 原生 copilot 形态，主区恒为 `CopilotChat`；左/右侧 `CopilotSidebar` 承载频道 / 私信 / 任务切换；任务看板、成员面板、成员名册、Agent 详情（含三个页签）走抽屉或独立路由。词条里的「三栏工作台 / dock / 页签」必须按这套语汇重新解释，并把这次重新解释记录在 ADR 中。

## Decision

1. **主区恒为 `CopilotChat`**：任何 target（channel / dm / task）的对话面都由 `CopilotChat` 承载；不把聊天塞进 dock，也不为任务线程另造一套消息列表。
2. **侧栏承载导航**：频道、私信、任务三者的切换在左侧 `CopilotSidebar`（或以其 header / 自定义槽承载的导航区）完成；右侧栏承载当前 target 的成员与上下文。同一时刻最多一个 docked 侧栏占用文档布局，另一侧以抽屉呈现，避免两个 docked 侧栏争用布局。
3. **抽屉 / 路由承载非对话面**：任务看板、成员面板（已加入 / 未加入 + 加入控件）、成员名册、Agent 详情（基础信息 → skills → mcp 三个分组）走抽屉或独立路由。抽屉与路由都是呈现层，不持有业务正本；打开哪一面不改变 target、不落消息、不唤醒。
4. **词条语汇的重新解释**：
   | 词条旧语汇 | 本仓语汇 |
   | --- | --- |
   | 三栏工作台 | 左侧栏（target 导航）+ 主区 `CopilotChat` + 右侧栏 / 抽屉（成员与上下文） |
   | dock | 抽屉（drawer）或独立路由；不再是唯一的右侧容器 |
   | 页签 | Agent 详情路由 / 抽屉内的三个分组；仍是同一页的三个分组，不变成三个独立 target |
   | 工作台版本 `/studio/`、`/studio/v2/` | 单一 React 工作台；旧两条入口不迁移、不并存 |
5. **后端快照仍是唯一读模型**：`GET /api/workspace` 继续提供工作台快照；前端不持正本。CopilotKit 的 thread 状态只承载对话呈现与流式运行，不是成员、任务、预算或未读的正本。
6. **消息渲染**：`CopilotChat` 通过 `messageView.assistantMessage` 槽渲染自定义 assistant 消息（头像、显示名、成员元数据）；人类与 Agent 对话正文按 Markdown 呈现；system 事件消息按事件行呈现，不按 Markdown 对话气泡呈现。

## Consequences

- 界面是 chat-first：打开工作台先看到对话，任务看板、成员管理与 Agent 详情是次级面；深度链接通过路由承载。
- 旧仓 `/studio/` 与 `/studio/v2/` 的 Vue 页面、组件与构建链不迁移；旧 ADR-0038 的「按面推进迁移」不再适用。视觉 token 名与头像色位等契约仍沿用，见 ADR 之外的规格。
- `CopilotSidebar` 的布局约束（同一时刻只允许一个 docked 侧栏）成为产品布局约束；实现票需要在桌面与窄屏下验证导航可达性。
- 抽屉与路由不落库、不唤醒、不消耗预算；这条纪律与「配置类写路径」一致，避免呈现动作被误读为对话事实。

## Old ADR Correspondence

- 旧仓没有与「CopilotKit 原生形态」直接对应的 ADR；本 ADR 首次记录这次重新解释。
- 旧仓 ADR-0038（Vue 版 Studio 按面迁移）不适用：本仓不复制 `/studio/` 与 `/studio/v2/`，也不复制其编号空间。
- 重新解释的词条：工作台 (Workspace)、成员面板 (Member Panel)、Agent 详情页签 (Agent Detail Tab)、工作台版本 (Studio Version)。
