/**
 * 词条表（String Catalog）的简体中文取值：界面上按语言取值的文案集合。
 *
 * 每条有稳定键与参数位：`text` 是源文案，`params` 声明这个键的参数位，
 * 文案里的 `{name}` 占位与 `params` 必须一致（由 `npm run test:strings` 校验）。
 * 渲染落点只有两个——前端按词条渲染、后端生成的自然语言按语言偏好渲染；
 * 两者 import 的是同一份取值。
 *
 * 键名使用词条的承重词（setting / locale / density / theme / message /
 * data dir / schema version），不使用 Avoid 列里的替代叫法。
 */
import type { CatalogEntry } from './index.js';

export const ZH_CN = {
  // 后端人类面文案：迁移与启动（serve）的用户可见消息。
  'cli.migrate.migrated': {
    text: '已把数据目录 {data_dir} 迁移到 Schema 版本 {schema_version}。',
    params: ['data_dir', 'schema_version'],
  },
  'cli.migrate.alreadyCurrent': {
    text: '数据目录 {data_dir} 已是 Schema 版本 {schema_version}。',
    params: ['data_dir', 'schema_version'],
  },
  'cli.dataDir.legacyWarning': {
    text:
      '警告：正在使用旧数据目录 {data_dir} 做兼容读取；既有数据不会被移动。' +
      '用 --data-dir 或 allibot_DATA_DIR 指定其他目录。',
    params: ['data_dir'],
  },
  'cli.serve.listening': {
    text: 'allibot 已监听 {url}。',
    params: ['url'],
  },

  // 工作区设置面板：语言偏好 / 消息密度 / 主题三档。
  'settings.title': { text: '工作区设置', params: [] },
  'settings.locale.label': { text: '语言偏好', params: [] },
  'settings.locale.zhCN': { text: '简体中文', params: [] },
  'settings.density.label': { text: '消息密度', params: [] },
  'settings.density.comfortable': { text: '舒适', params: [] },
  'settings.density.compact': { text: '紧凑', params: [] },
  'settings.theme.label': { text: '主题', params: [] },
  'settings.theme.light': { text: '浅色', params: [] },
  'settings.theme.dark': { text: '深色', params: [] },
  'settings.theme.system': { text: '跟随系统', params: [] },
  'settings.error.load': { text: '设置读取失败，请确认后端已启动。', params: [] },
  'settings.error.save': { text: '设置未保存，请重试。', params: [] },

  // 提及补全（Mention Completion）的候选列表标签：候选只列当前 target 的 Agent。
  'mention.completion.label': { text: '提及候选', params: [] },

  // 轮次结果（Round Outcome）与穿透加入事件的可读文案：后端在 HTTP 请求之外
  // 写这两类文本，按库内语言偏好经 tFromDb 渲染。键名用承重词（wake / round /
  // penetration / join），参数位只带标识（seq / count / name），从不携带正文。
  'wake.channelMessage': { text: '本轮由频道消息唤醒', params: [] },
  'wake.mention': { text: '本轮由个人提及唤醒', params: [] },
  'wake.claim': { text: '本轮由认领唤醒', params: [] },
  'wake.continue': { text: '本轮由自动续跑唤醒', params: [] },
  'round.replied': { text: '已回复', params: [] },
  'round.ignored': { text: '自判忽略：本轮没有需要回应的话', params: [] },
  'round.failed': { text: '处理失败，需要排查', params: [] },
  'round.silent': { text: '本轮经结构化声明保持沉默', params: [] },
  'round.noBody': { text: '本轮没有产出可落库的正文', params: [] },
  // 回应判断的可读文案按信号来源选键：确定信号各自一句，不复用未发生的
  // 信号文案；不改变落库状态的那两种只陈述事实。
  'round.mandatory.mention': { text: '本轮由个人提及唤醒：这是确定信号，必须回应', params: [] },
  'round.mandatory.claim': { text: '本轮由认领唤醒：这是确定信号，必须回应', params: [] },
  'round.mandatory.humanMessage': { text: '本轮由人类消息唤醒：这是确定信号，必须回应', params: [] },
  'round.mandatory.continue': { text: '本轮由自动续跑唤醒：这是确定信号，必须回应', params: [] },
  'round.silent.allowed': {
    text: '本轮不是确定信号：结构化沉默是正常协议结果，不按失败收口',
    params: [],
  },
  'round.ignored.allowed': {
    text: '本轮不是确定信号：自判忽略是正常协议选择，不按失败收口',
    params: [],
  },
  'round.mandatory.closed': { text: '确定信号下不回应，按失败收口', params: [] },
  'round.penetrationSuffix': {
    text: '本轮是被点名的穿透唤醒，回复时顺带加入频道，加入事件 seq={seq}',
    params: ['seq'],
  },
  'round.merged': {
    text:
      '已有一轮在进行中（in-flight）：{count} 次重复唤醒合并进那一轮，' +
      '以最大 seq #{largest} 为准；不排队、不重放',
    params: ['count', 'largest'],
  },
  // 预算耗尽不是错误：消息已落库、零唤醒，本轮被压制。
  'round.budgetExhausted': {
    text: '预算耗尽：本世代已用 {used}/{limit} 跳，本条消息的唤醒被压制（消息照常落库）',
    params: ['used', 'limit'],
  },
  'round.finished.completed': { text: '正常完成', params: [] },
  'round.finished.error': { text: '错误', params: [] },
  'round.finished.iterationLimit': { text: '达到迭代上限', params: [] },
  'round.finished.humanInterrupt': { text: '人类中断', params: [] },
  // 自动续跑的两条轮次说明：授予一次续跑，或到达每世代四轮的上限后暂停。
  'round.continue.granted': {
    text: '已按结构化动作 continue_task 申请续跑（本世代第 {round} 轮）',
    params: ['round'],
  },
  'round.continue.paused': {
    text: '结构化动作 continue_task 到达本世代上限（{rounds} 轮），不再续跑',
    params: ['rounds'],
  },
  'system.member.piercedJoin': {
    text: '{name} 加入了频道：它被点名时并不在频道里，回复时顺带加入（成员变化只随真实回复发生）',
    params: ['name'],
  },

  // 本轮 system prompt 的两段纪律：频道轮逐字使用 channel rubric（多成员口径），
  // DM 轮是一对一口径；人类消息必答句永远另起一段。提示是输入面，不是消息。
  'prompt.channel.rubric': {
    text: '这是一个多成员频道：先读上下文，判断其中是否有需要你回应的话；未被点名时可以沉默（自判忽略）。',
    params: [],
  },
  'prompt.dm.oneToOne': {
    text: '这是一对一私信：对话只在 owner 与你之间进行，没有「未被点名」的情形。',
    params: [],
  },
  'prompt.dm.mandatory': {
    text: '一对一的对话里，对方的话你必须回应。',
    params: [],
  },
  'prompt.humanMessage.mandatory': {
    text: '这条消息来自人类（owner）：人类消息是确定信号，必须回应。',
    params: [],
  },

  // 示例文案：用来看消息密度在壳里的呈现。
  'message.sample.author': { text: '示例成员', params: [] },
  'message.sample.body': { text: '{author} 的消息示例：正文按消息密度呈现。', params: ['author'] },

  // 任务线程里的系统事件消息：任务创建与每次任务变更各落一条。
  'task.event.created': { text: '任务「{title}」已创建。', params: ['title'] },
  'task.event.title.renamed': {
    text: '任务标题由「{previous}」改为「{title}」。',
    params: ['previous', 'title'],
  },
  'task.event.status.changed': {
    text: '任务状态由 {previous} 改为 {status}。',
    params: ['previous', 'status'],
  },
  'task.event.assignee.assigned': { text: '任务已指派给 {assignee}。', params: ['assignee'] },
  'task.event.assignee.unassigned': { text: '任务已收回指派。', params: [] },
  'task.event.assignee.reassigned': {
    text: '任务由 {previous} 改派给 {assignee}。',
    params: ['previous', 'assignee'],
  },
  // 认领 (Claim) 的两条系统记录与自动续跑 (Auto-continue) 的两条记录：认领是
  // 一次开工动作，所以「已认领」之后紧跟一条「认领后自动开工」；续跑记录落一条，
  // 到每世代四轮上限时改落暂停记录。作者恒为 owner（既有口径，不表示人推的）。
  'task.event.claimed': {
    text: '任务「{title}」已由 {assignee} 认领。',
    params: ['title', 'assignee'],
  },
  'task.event.claim.started': {
    text: '认领后自动开工：{assignee} 开始处理「{title}」。',
    params: ['assignee', 'title'],
  },
  'task.event.continue': {
    text: '自动续跑：{assignee} 申请继续处理「{title}」。',
    params: ['assignee', 'title'],
  },
  'task.event.continue.paused': {
    text: '自动续跑达到本世代上限（{rounds} 轮）：{assignee} 不再续跑「{title}」。',
    params: ['rounds', 'assignee', 'title'],
  },

  // 频道里的指针消息正文：它是 system，不计未读、不唤醒。
  'task.pointer.body': { text: '已创建任务「{title}」，在这里进入任务线程。', params: ['title'] },

  // 提醒到点的系统事件消息正文：作者恒为 owner，不唤醒、不计未读。
  'reminder.due.body': { text: '提醒到点：{text}', params: ['text'] },

  // 任务状态在系统事件消息里的可读标签（承重词，不用看板列名替代）。
  'task.status.todo': { text: '待认领', params: [] },
  'task.status.inProgress': { text: '进行中', params: [] },
  'task.status.inReview': { text: '待审', params: [] },
  'task.status.done': { text: '完成', params: [] },
  'task.status.closed': { text: '已关闭', params: [] },

  // 长期记忆（Long-term Memory）的两面文案：轮次收尾写回的确定性卡片，以及
  // 回复前注入 system prompt 的记忆段。两者都由后端生成，经 tFromDb 渲染。
  'memory.card.replied': {
    text: '触发消息摘录：{trigger}；本成员回复摘录：{reply}',
    params: ['trigger', 'reply'],
  },
  'memory.card.noReply': {
    text: '触发消息摘录：{trigger}；本成员没有回复（回复摘录为空）',
    params: ['trigger'],
  },
  'memory.card.taskContext': { text: '任务上下文：{context}', params: ['context'] },
  'memory.prompt.header': {
    text: '长期记忆：以下是按关键词召回的相关记忆卡片（共 {count} 条）。',
    params: ['count'],
  },
  'memory.prompt.card': { text: '- {content}', params: ['content'] },

  // 远端数据流告知（Remote Data Flow Consent，D4.2 / R1 词条 35）：清单逐条列出
  // 会离开本机的数据面与接收方，取得一次确认；未确认时绝不发起远端调用。
  // 本仓不做应用层端到端加密，文案不声称 E2EE。
  'remoteFlow.surface.messageBody': { text: '消息正文', params: [] },
  'remoteFlow.surface.authorName': { text: '发送者显示名', params: [] },
  'remoteFlow.surface.targetName': {
    text: 'target 的显示名（频道名称与描述、DM 对方显示名、任务标题）',
    params: [],
  },
  'remoteFlow.surface.mentionedNames': { text: '被点名成员的显示名', params: [] },
  'remoteFlow.surface.receiver': { text: '接收方（模型 provider 的远端端点）', params: [] },
  // 轮次 reason 里的三种不可用键：未确认远端告知（consent）、缺凭证
  // （credential）与未配置模型（model）各自可读，且都声明「零远端调用」。
  'round.consent.missing': {
    text: '未确认远端数据流告知（consent，模型 provider：{provider}）：本轮不发起任何远端调用，也没有回复',
    params: ['provider'],
  },
  'round.credential.missing': {
    text: '缺凭证（credential，环境变量 {env} 未设置）：本轮不发起任何远端调用，也没有回复',
    params: ['env'],
  },
  'round.model.missing': {
    text: '未配置模型（model，没有 provider:model 可解析）：本轮不发起任何远端调用，也没有回复',
    params: [],
  },
  'provider.call.failed': { text: '模型调用失败：{message}', params: ['message'] },

  // 工作台壳（Workspace）：左侧 target 导航、右侧上下文 / 抽屉。文案按词条的
  // 承重词（频道 / 私信 / 任务 / 本机 Agent / 工作台），不使用 Avoid 列的替代叫法。
  'workspace.nav.title': { text: '导航', params: [] },
  'workspace.nav.channels': { text: '频道', params: [] },
  'workspace.nav.channelsArchived': { text: '已归档频道', params: [] },
  'workspace.nav.dms': { text: '私信', params: [] },
  'workspace.nav.dmsArchived': { text: '已归档私信', params: [] },
  'workspace.nav.tasks': { text: '任务', params: [] },
  'workspace.nav.agents': { text: '本机 Agent', params: [] },
  'workspace.nav.empty': { text: '暂无', params: [] },
  'workspace.nav.open': { text: '导航', params: [] },
  'workspace.nav.unread': { text: '{count} 条未读', params: ['count'] },
  'workspace.context.title': { text: '成员与上下文', params: [] },
  'workspace.context.empty': { text: '尚未选择 target', params: [] },
  'workspace.context.kind.channel': { text: '频道', params: [] },
  'workspace.context.kind.dm': { text: '私信', params: [] },
  'workspace.context.kind.task': { text: '任务', params: [] },
  'workspace.panel.taskBoard': { text: '任务看板', params: [] },
  'workspace.panel.members': { text: '成员面板', params: [] },
  'workspace.panel.roster': { text: '成员名册', params: [] },
  'workspace.panel.agentDetail': { text: 'Agent 详情', params: [] },
  'workspace.panel.pending': { text: '此面由后续票接入。', params: [] },
  'workspace.drawer.close': { text: '关闭', params: [] },
  'workspace.status.online': { text: '在线', params: [] },
  'workspace.status.working': { text: '工作中', params: [] },
  'workspace.status.error': { text: '出错', params: [] },
  'workspace.status.offline': { text: '未启用', params: [] },
} as const satisfies Record<string, CatalogEntry>;
