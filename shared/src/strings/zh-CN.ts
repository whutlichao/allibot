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
  'cli.serve.adapter': {
    text: 'allibot 成员面适配器：{adapter}',
    params: ['adapter'],
  },
  'cli.serve.databaseMissing': {
    text:
      '在 {path} 找不到数据库；启动服务前先在仓库根执行 ' +
      '`node dist/cli.js --migrate --data-dir {data_dir}`。',
    params: ['path', 'data_dir'],
  },
  'cli.serve.webRootMissing': {
    text:
      '找不到前端构建产物 {path}；启动服务前先在仓库根执行 `npm run build`，' +
      '它会构建工作台的 web/dist。',
    params: ['path'],
  },
  'cli.error': {
    text: 'allibot：{message}',
    params: ['message'],
  },
  'cli.schema.tooOld': {
    text:
      'version_mismatch：数据库{found}，本构建期望 Schema 版本 {expected}；' +
      '启动服务前先在仓库根迁移：默认数据目录用 `npm run migrate`，' +
      '指定数据目录用 `node dist/cli.js --migrate --data-dir {data_dir}`。',
    params: ['found', 'expected', 'data_dir'],
  },
  'cli.schema.tooNew': {
    text:
      'version_mismatch：数据库 Schema 版本 {found} 高于本构建的 {expected}；' +
      '拒绝执行，没有降级路径。',
    params: ['found', 'expected'],
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
  'wake.teamChange': { text: '本轮由任务变化唤醒', params: [] },
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
  'round.mandatory.teamChange': {
    text: '本轮由任务变化唤醒：这是确定信号，必须回应',
    params: [],
  },
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
  // 人类中断的轮次说明：run 被取消发生在结论落库之前，本轮不产生回复消息。
  'round.interrupted': {
    text: '本轮被人类中断：run 在结论落库前被取消，不产生回复消息，轮次按人类中断收口',
    params: [],
  },
  // 自动续跑的两条轮次说明：授予一次续跑，或到达每世代四轮的上限后暂停。
  'round.continue.granted': {
    text: '已按结构化动作 continue_task 申请续跑（本世代第 {round} 轮）',
    params: ['round'],
  },
  'round.continue.teamDisabled': {
    text: 'team 任务线程不提供自动续跑（结构化动作 continue_task 被拒绝），本轮不产生续跑轮次',
    params: [],
  },
  'round.continue.paused': {
    text: '结构化动作 continue_task 到达本世代上限（{rounds} 轮），不再续跑',
    params: ['rounds'],
  },
  // 转派（#38 / D3.5）：受派者的结构化动作。拒绝是结构化结果，不是轮次失败；
  // 转派本身只追加 system 变更记录，不写消息正文、不开人类世代。
  'round.transfer.done': {
    text: '已按结构化动作 transfer_task 把任务转派给 {assignee}',
    params: ['assignee'],
  },
  'round.transfer.rejected': {
    text: '结构化动作 transfer_task 被拒绝：{reason}',
    params: ['reason'],
  },
  'round.transfer.notAssignee': {
    text: '只有当前受派者才能转派这张任务',
    params: [],
  },
  'round.transfer.self': { text: '不能把任务转派给自己', params: [] },
  'round.transfer.same': { text: '目标成员已经是当前受派者', params: [] },
  'round.transfer.notMember': {
    text: '目标必须是同一频道的另一个活 Agent 成员',
    params: [],
  },
  'round.transfer.noTarget': {
    text: '结构化动作没有给出目标成员',
    params: [],
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
  // 队长被任务变化唤醒的那一轮（#38 / D3.2）：任务变化是确定信号，与人类
  // 消息、认领、提及的可读文案分开，不能写下没发生过的来源。
  'prompt.teamChange.mandatory': {
    text: '这次唤醒来自任务变化（建任务 / 改派 / 转派）：作为队长，你必须回应并推进这件事。',
    params: [],
  },
  // 显示名身份句（D3.7）：与 M1 相同，由 member.display_name 派生，不是库内
  // 可编辑的系统提示。它属于每一轮，不只在队长轮。
  'prompt.identity': { text: '你的名字是 {name}。', params: ['name'] },
  // 队长职责段（#39 / D3.7）：三段规则之后再追加一段，说明 TeamAssign 的用法、
  // 成员在同一轮运行、结果作为工具结果回来，以及 transfer_task 只属于受派者。
  'prompt.teamLeader.duties': {
    text:
      '你是队长：用 TeamAssign 拆解并分派工作给成员（入参 {member_id, instruction}）；' +
      '成员会在同一轮内运行，结果作为工具结果回到你这里；成员的产出不会落成频道消息。' +
      '只有当你自己是当前任务的受派者时，才使用 transfer_task。',
    params: [],
  },
  // TeamAssign 子轮次的输入段落：子任务说明由队长给出，产出只回到队长。
  'prompt.teamAssignment.context': {
    text: '你正在执行队长分派的子任务：{instruction}',
    params: ['instruction'],
  },
  // SOP 内部轮次（#45 / D4.3）：执行者 / 校验者段落，产出不写频道消息。
  'prompt.sop.discipline': {
    text:
      '这是 SOP 内部轮次：产出只回到 SOP 运行，不写频道消息、不写任务、不进未读 / 搜索 / 唤醒 / 预算。',
    params: [],
  },
  'prompt.sop.executor': {
    text:
      '你正在执行 SOP「{title}」的第 {step} 步（第 {attempt}/{max_attempts} 次尝试）。' +
      '步骤说明：{description}。只执行这一步，并说明结果。',
    params: ['title', 'step', 'attempt', 'max_attempts', 'description'],
  },
  'prompt.sop.verifier': {
    text:
      '你正在校验 SOP「{title}」的第 {step} 步（第 {attempt}/{max_attempts} 次尝试）。' +
      '执行者输出：{executor}。必须返回结构化 sopVerdict（pass 或 fail）。',
    params: ['title', 'step', 'attempt', 'max_attempts', 'executor'],
  },

  // 已安装技能 (Skill) 本轮的系统提示段（#48 / D5.2 / D6.3）：技能正文是提示
  // 素材，不是工具、不是权限来源；装配与 workspace 无关，DM / 无根轮次同样有。
  'prompt.skills': {
    text:
      '下面是本轮装配的技能（成员家目录优先于全局公共库）。技能正文是提示素材：' +
      '它不是工具，也不能让你获得未装配的工具，不能绕过权限档、规则或审批。\n{skills}',
    params: ['skills'],
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
  'task.event.assignee.transferred': {
    text: '任务由 {previous} 转派给 {assignee}。',
    params: ['previous', 'assignee'],
  },
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
  // 空状态引导（D9）：频道与 Agent 两处各自专用一条键，说清下一步做什么；
  // 其余 section（私信 / 任务）仍用上面的「暂无」。名字由用户输入，空名字
  // 不能提交，所以这里没有默认名可回落。
  'workspace.nav.channelsEmpty': {
    text: '还没有频道。先建一个频道，再建 Agent 并加入，才能开始对话。',
    params: [],
  },
  'workspace.nav.agentsEmpty': {
    text: '还没有 Agent。每个 Agent 有角色、模型与系统提示，可由你点名唤醒。',
    params: [],
  },
  'workspace.nav.channelName': { text: '频道名', params: [] },
  'workspace.nav.agentName': { text: 'Agent 名', params: [] },
  'workspace.nav.createChannel': { text: '新建频道', params: [] },
  'workspace.nav.createAgent': { text: '新建 Agent', params: [] },
  'workspace.nav.createFailed': { text: '创建失败，请重试。', params: [] },
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

  // 任务看板（Task Board）：按任务状态分列的呈现面，列名沿用任务状态的
  // 可读文案；筛选只收窄视图，不改变任务恰好属于一个频道的归属事实。
  'taskBoard.filter.label': { text: '频道筛选', params: [] },
  'taskBoard.filter.all': { text: '全部频道', params: [] },
  'taskBoard.transition.label': { text: '流转', params: [] },
  'taskBoard.chip.thread': { text: '进入任务线程', params: [] },
  'taskBoard.chip.unread': { text: '· {count} 条未读', params: ['count'] },
  'taskBoard.chip.taskRef': { text: '任务：{title}', params: ['title'] },
  // Agent 详情页签（Agent Detail Tab）：三个分组固定顺序；基础信息和配置在
  // M1 可用，skills / mcp 是依赖 T11（M2）的占位。
  'workspace.agentDetail.tab.basic': { text: '基础信息和配置', params: [] },
  'workspace.agentDetail.tab.skills': { text: 'skills', params: [] },
  'workspace.agentDetail.tab.mcp': { text: 'mcp', params: [] },
  'workspace.agentDetail.section.stats': { text: '统计', params: [] },
  'workspace.agentDetail.section.systemPrompt': { text: '系统提示', params: [] },
  'workspace.agentDetail.section.config': { text: '配置', params: [] },
  'workspace.agentDetail.section.rules': { text: '家目录与规则', params: [] },
  'workspace.agentDetail.section.danger': { text: '危险操作', params: [] },
  'workspace.agentDetail.field.homePath': { text: '家目录', params: [] },
  'workspace.agentDetail.rules.global': { text: '全局规则基座', params: [] },
  'workspace.agentDetail.rules.systemPrompt': { text: '系统提示（库内）', params: [] },
  'workspace.agentDetail.rules.project': { text: '项目补充', params: [] },
  'workspace.agentDetail.rules.present': { text: '已读取', params: [] },
  'workspace.agentDetail.rules.absent': { text: '缺失', params: [] },
  'workspace.agentDetail.rules.unreadable': { text: '不可读', params: [] },
  'workspace.agentDetail.rules.pending': { text: '规则读取中…', params: [] },
  'workspace.agentDetail.rules.readOnly': { text: '规则由人维护，这里只读显示。', params: [] },
  'workspace.agentDetail.field.status': { text: '状态点', params: [] },
  'workspace.agentDetail.field.model': { text: '模型标识', params: [] },
  'workspace.agentDetail.field.credential': { text: '凭证', params: [] },
  'workspace.agentDetail.field.role': { text: '角色', params: [] },
  'workspace.agentDetail.field.enabled': { text: '启用', params: [] },
  'workspace.agentDetail.field.contextWindow': { text: '上下文窗口', params: [] },
  'workspace.agentDetail.field.compressionThreshold': { text: '压缩阈值', params: [] },
  'workspace.agentDetail.field.maxIterations': { text: '迭代上限', params: [] },
  'workspace.agentDetail.field.autoClaim': { text: '自动认领', params: [] },
  'workspace.agentDetail.credential.present': { text: '已设置', params: [] },
  // 缺模型 / 缺凭证（D9）：不说「未配置」，而是点名密钥从哪里来；
  // {credential_env} 只来自 `/api/remote-data-flow` 的 providers[].credential_env，
  // 与后端 round.credential.missing 同源。
  'workspace.agentDetail.credential.env': {
    text: '模型密钥从环境变量读，不写库：需要 {credential_env}。设置后需重启后端。',
    params: ['credential_env'],
  },
  'workspace.agentDetail.credential.envUnknown': {
    text: '模型密钥从环境变量读，不写库：具体变量名由模型的 provider 决定。设置后需重启后端。',
    params: [],
  },
  'workspace.agentDetail.model.unset': {
    text: '还没有配置模型（provider:model）。模型密钥从环境变量读，不写库。',
    params: [],
  },
  'workspace.agentDetail.enabled.on': { text: '已启用', params: [] },
  'workspace.agentDetail.enabled.off': { text: '已停用', params: [] },
  'workspace.agentDetail.yes': { text: '是', params: [] },
  'workspace.agentDetail.no': { text: '否', params: [] },
  // skills 页签 (#48 / D6.5): 左栏安装列表、右栏元数据 + SKILL.md 正文 + 删除；
  // 顶部是单条导入、刷新候选与全部导入。技能正文按配置文本呈现。
  'workspace.agentDetail.skills.title': { text: '技能', params: [] },
  'workspace.agentDetail.skills.pending': { text: '技能读取中…', params: [] },
  'workspace.agentDetail.skills.empty': {
    text: '还没有安装技能。可以把技能目录放到 ~/.agents/skills/ 后导入，或从本机目录安装。',
    params: [],
  },
  'workspace.agentDetail.skills.selectHint': { text: '从左侧选择一条技能查看详情。', params: [] },
  'workspace.agentDetail.skills.importTitle': { text: '导入', params: [] },
  'workspace.agentDetail.skills.importSelected': { text: '导入所选', params: [] },
  'workspace.agentDetail.skills.refreshCandidates': { text: '刷新候选', params: [] },
  'workspace.agentDetail.skills.importAll': { text: '全部导入', params: [] },
  'workspace.agentDetail.skills.importing': { text: '导入中…', params: [] },
  'workspace.agentDetail.skills.candidatesPending': { text: '候选读取中…', params: [] },
  'workspace.agentDetail.skills.candidatesEmpty': {
    text: '没有可导入的候选；把技能放到 ~/.agents/skills/ 后刷新。',
    params: [],
  },
  'workspace.agentDetail.skills.candidatesUnavailable': {
    text: '候选目录不存在：~/.agents/skills/',
    params: [],
  },
  'workspace.agentDetail.skills.candidateImportable': { text: '可导入', params: [] },
  'workspace.agentDetail.skills.candidateInstalled': { text: '已安装', params: [] },
  'workspace.agentDetail.skills.enabled': { text: '已启用', params: [] },
  'workspace.agentDetail.skills.disabled': { text: '已停用', params: [] },
  'workspace.agentDetail.skills.field.name': { text: '名字', params: [] },
  'workspace.agentDetail.skills.field.hash': { text: '内容 hash', params: [] },
  'workspace.agentDetail.skills.field.source': { text: '来源', params: [] },
  'workspace.agentDetail.skills.field.enabled': { text: '启停', params: [] },
  'workspace.agentDetail.skills.field.created': { text: '创建时间', params: [] },
  'workspace.agentDetail.skills.field.updated': { text: '更新时间', params: [] },
  'workspace.agentDetail.skills.markdown': { text: 'SKILL.md 正文', params: [] },
  'workspace.agentDetail.skills.delete': { text: '删除技能', params: [] },
  'workspace.agentDetail.skills.deleting': { text: '删除中…', params: [] },
  'workspace.agentDetail.skills.importFailed': { text: '导入失败。', params: [] },
  'workspace.agentDetail.skills.toggleFailed': { text: '启停失败。', params: [] },
  'workspace.agentDetail.skills.deleteFailed': { text: '删除失败。', params: [] },
  'workspace.agentDetail.skills.refreshFailed': { text: '候选刷新失败。', params: [] },
  'workspace.agentDetail.skills.enabledToggle': { text: '启用 {name}', params: ['name'] },
  // mcp 页签 (#47 / D6.5): 上块是结构化条目表单，下块是同一文件的原文文本域。
  'workspace.agentDetail.mcp.entries': { text: '条目', params: [] },
  'workspace.agentDetail.mcp.raw': { text: '原文', params: [] },
  'workspace.agentDetail.mcp.entriesEmpty': {
    text: '家目录还没有 mcp.json；新增条目并保存即可创建。',
    params: [],
  },
  'workspace.agentDetail.mcp.name': { text: '名称', params: [] },
  'workspace.agentDetail.mcp.transport': { text: 'transport', params: [] },
  'workspace.agentDetail.mcp.enabled': { text: '启用', params: [] },
  'workspace.agentDetail.mcp.command': { text: 'command', params: [] },
  'workspace.agentDetail.mcp.args': { text: 'args（每行一个）', params: [] },
  'workspace.agentDetail.mcp.url': { text: 'url', params: [] },
  'workspace.agentDetail.mcp.envNames': { text: 'env_names（逗号分隔，只存变量名）', params: [] },
  'workspace.agentDetail.mcp.addEntry': { text: '新增条目', params: [] },
  'workspace.agentDetail.mcp.removeEntry': { text: '删除条目', params: [] },
  'workspace.agentDetail.mcp.saveEntries': { text: '保存条目', params: [] },
  'workspace.agentDetail.mcp.saveRaw': { text: '保存原文', params: [] },
  'workspace.agentDetail.mcp.saving': { text: '保存中…', params: [] },
  'workspace.agentDetail.mcp.saveFailed': { text: 'mcp.json 保存失败，请修正后重试。', params: [] },
  'workspace.agentDetail.mcp.fileMissing': { text: 'mcp.json 缺失：本轮不装配 MCP。', params: [] },
  'workspace.agentDetail.mcp.diagnostic': { text: '诊断', params: [] },
  'workspace.agentDetail.mcp.sameFile': {
    text: '两块读写同一份家目录 mcp.json；管理面与运行期装配读的是它。',
    params: [],
  },
  'workspace.agentDetail.mcp.consent': {
    text: '远端 http / sse 服务器需要先确认远端数据流，否则运行期不会连接。',
    params: [],
  },
  'workspace.agentDetail.consent.confirm': { text: '确认远端数据流告知', params: [] },
  'workspace.agentDetail.consent.confirming': { text: '确认中…', params: [] },
  'workspace.agentDetail.consent.failed': { text: '确认失败，请重试。', params: [] },
  'workspace.agentDetail.save': { text: '保存', params: [] },
  'workspace.agentDetail.saving': { text: '保存中…', params: [] },
  'workspace.agentDetail.saveFailed': { text: '保存失败，请重试。', params: [] },
  'workspace.agentDetail.delete': { text: '删除 Agent', params: [] },
  'workspace.agentDetail.deleteConfirm': { text: '确认删除', params: [] },
  'workspace.agentDetail.deleteCancel': { text: '取消', params: [] },
  'workspace.agentDetail.deleting': { text: '删除中…', params: [] },
  'workspace.agentDetail.deleteFailed': { text: '删除失败，请重试。', params: [] },
  'workspace.agentDetail.deleteWarning': {
    text: '软删除后，这个 Agent 不再出现在成员面板、成员名册与本机 Agent 列表；历史消息保留。',
    params: [],
  },
  'workspace.agentDetail.missing': { text: '该 Agent 不存在或已删除。', params: [] },
  // 已归档私信（对方 Agent 已软删除）的只读提示：composer 与发送入口一并禁用。
  'workspace.composer.archivedDm': {
    text: '对方 Agent 已被软删除，此私信已归档，只能阅读历史，无法继续发送。',
    params: [],
  },
  'workspace.composer.placeholder': { text: '输入消息，@ 提及成员', params: [] },
  'workspace.chat.disclaimer': {
    text: 'AI 可能会犯错，请核对重要信息。',
    params: [],
  },
  // 成员面板（Member Panel）与成员名册（Member Roster）：面板按频道成员表
  // 分「已加入 / 未加入」两段，名册是含 owner 的只读全名单。
  'workspace.member.joined': { text: '已加入', params: [] },
  'workspace.member.notJoined': { text: '未加入', params: [] },
  'workspace.member.join': { text: '加入', params: [] },
  'workspace.member.joining': { text: '加入中…', params: [] },
  'workspace.member.joinFailed': { text: '加入失败，请重试。', params: [] },
  'workspace.member.loading': { text: '正在读取频道成员…', params: [] },
  'workspace.member.empty': { text: '暂无成员。', params: [] },
  'workspace.member.modelMissing': { text: '还没有配置模型', params: [] },
  'workspace.member.channelOnly': { text: '成员面板只属于频道。', params: [] },
  'workspace.member.reason.disabled': { text: '已停用', params: [] },
  'workspace.member.reason.modelMissing': { text: '未配置模型', params: [] },
  'workspace.member.reason.consentMissing': {
    text: '未确认远端数据流告知：请打开 Agent 详情确认。',
    params: [],
  },
  'workspace.member.reason.credentialMissing': {
    text: '缺少凭证：需要设置环境变量 {credential_env}，设置后重启后端。',
    params: ['credential_env'],
  },
  'workspace.member.reason.credentialMissingNoEnv': {
    text: '缺少凭证：请设置该模型 provider 需要的环境变量后重启后端。',
    params: [],
  },
  'workspace.member.consent.openDetail': { text: '去确认远端数据流', params: [] },
  'workspace.member.notice': { text: '有 {count} 位成员未启用或出错', params: ['count'] },
  'workspace.member.notice.open': { text: '查看成员面板', params: [] },
  'workspace.roster.channelOnly': { text: '成员名册只属于频道。', params: [] },
  'workspace.roster.ownerRole': { text: 'owner', params: [] },
  // team 模式配置（#37）：频道配置区的模式 / 队长 / 配置无效原因。模式与
  // 队长都是频道级配置，不落消息、不唤醒；配置无效时消息照常落库但零唤醒。
  'channel.config.title': { text: '频道配置', params: [] },
  'channel.config.mode.label': { text: '协作拓扑', params: [] },
  'channel.config.mode.autonomous': { text: '自主', params: [] },
  'channel.config.mode.team': { text: 'team 模式', params: [] },
  'channel.config.leader.label': { text: '队长', params: [] },
  'channel.config.leader.placeholder': { text: '选择队长', params: [] },
  'channel.config.leader.unknown': { text: '未知成员', params: [] },
  'channel.config.leader.saving': { text: '保存中…', params: [] },
  'channel.config.leader.saveFailed': { text: '保存失败，请重试。', params: [] },
  'channel.config.leader.loading': { text: '正在读取频道成员…', params: [] },
  'channel.config.invalid': { text: '配置无效', params: [] },
  'channel.config.workspace.root.label': { text: '项目根', params: [] },
  'channel.config.workspace.root.placeholder': { text: '输入项目根的绝对路径', params: [] },
  'channel.config.workspace.root.save': { text: '保存项目根', params: [] },
  'channel.config.workspace.backend.label': { text: '工作区后端', params: [] },
  'channel.config.workspace.backend.local': { text: '本地', params: [] },
  'channel.config.workspace.backend.docker': { text: 'Docker', params: [] },
  'workspace.agent.workspaceBackend.followChannel': { text: '跟随频道', params: [] },
  'channel.config.workspace.status.label': { text: '工作区状态', params: [] },
  'channel.config.workspace.shell.label': { text: '允许本地 shell', params: [] },
  'channel.config.workspace.shell.risk': {
    text: '本地 shell 无沙箱：命令以项目根为工作目录运行，且每次调用都必须人工审批。',
    params: [],
  },
  'workspace.status.available': { text: '可用', params: [] },
  'workspace.status.line': { text: '工作区状态：{status}', params: ['status'] },
  'workspace.status.loading': { text: '正在读取工作区状态…', params: [] },
  'workspace.status.reason.workspaceRootUnset': {
    text: '未配置项目根，本轮不挂文件工具',
    params: [],
  },
  'workspace.status.reason.workspaceRootMissing': { text: '项目根不存在或不可读', params: [] },
  'workspace.status.reason.dockerUnavailable': { text: 'Docker 后端不可用', params: [] },
  'workspace.status.reason.dockerImageMissing': { text: 'Docker 镜像不存在或无法拉取', params: [] },
  'workspace.status.reason.dockerConsentMissing': { text: '镜像未确认远端数据流', params: [] },
  'workspace.round.rootMissing': {
    text: '工作区不可用：项目根不存在或不可读（workspace-root-missing）。',
    params: [],
  },
  'workspace.round.dockerUnavailable': {
    text: '工作区不可用：Docker 后端不可用（docker-unavailable），本轮不回落本地文件工具。',
    params: [],
  },
  'workspace.round.dockerImageMissing': {
    text: '工作区不可用：Docker 镜像不存在或无法拉取（docker-image-missing），本轮不回落本地文件工具。',
    params: [],
  },
  'workspace.round.dockerConsentMissing': {
    text: '工作区不可用：镜像未确认远端数据流（docker-consent-missing），本轮不回落本地文件工具。',
    params: [],
  },
  // 运行面板（#38）：run 是取证面，不是消息；状态、reason、归属与时间都来自
  // `GET /api/targets/{id}/team-runs` 的同一份读数。
  'workspace.teamRuns.title': { text: '运行记录', params: [] },
  'workspace.teamRuns.empty': { text: '还没有 team 运行记录。', params: [] },
  'workspace.teamRuns.status.running': { text: '运行中', params: [] },
  'workspace.teamRuns.status.completed': { text: '已完成', params: [] },
  'workspace.teamRuns.status.failed': { text: '失败', params: [] },
  'workspace.teamRuns.status.invalidLeader': { text: '队长不可用', params: [] },
  'workspace.teamRuns.attribution.task': { text: '任务', params: [] },
  'workspace.teamRuns.attribution.channel': { text: '频道', params: [] },
  'workspace.teamRuns.reason': { text: '原因', params: [] },
  'workspace.teamRuns.time': { text: '时间', params: [] },
  // 队长不可用的可读原因（D3.8）：读模型与轮次共用同一段文案。
  'team.invalid.leaderMissing': { text: '队长成员不存在或已被移除。', params: [] },
  'team.invalid.leaderNotAgent': { text: '队长必须是 Agent 成员。', params: [] },
  'team.invalid.leaderDeleted': { text: '队长已被软删除。', params: [] },
  'team.invalid.leaderDisabled': { text: '队长已被禁用（enabled=0）。', params: [] },
  'team.invalid.leaderNotMember': { text: '队长已不是该频道的成员。', params: [] },
  'team.invalid.modelMissing': { text: '队长没有配置可用的模型。', params: [] },
  'team.invalid.consentMissing': { text: '队长所属模型 provider 尚未确认远端数据流告知。', params: [] },
  // 运行记录（#38）：进程重启把残留 running 收口为 failed，reason 带 interrupted；
  // 已计跳不退款，也不产生消息、assignment 或新轮次。
  'team.run.interrupted': {
    text: '进程重启：残留的 running 运行记录收口为 failed（interrupted），已计跳不退款',
    params: [],
  },
  'team.invalid.credentialMissing': {
    text: '队长所属模型 provider 缺少凭证（{credential_env}）。',
    params: ['credential_env'],
  },
  // 目标上下文的工作区不可用也是队长无效事实（D3.8 / D5.7）：读模型、消息
  // 触发与 team-change 触发共用这段文案，而不是让轮次失败后再说原因。
  'team.invalid.workspaceRootMissing': {
    text: '队长在目标上下文不可用：项目根不存在或不可读（workspace-root-missing）。',
    params: [],
  },
  'team.invalid.dockerUnavailable': {
    text: '队长在目标上下文不可用：Docker 后端不可用（docker-unavailable）。',
    params: [],
  },
  'team.invalid.dockerImageMissing': {
    text: '队长在目标上下文不可用：Docker 镜像不存在或无法拉取（docker-image-missing）。',
    params: [],
  },
  'team.invalid.dockerConsentMissing': {
    text: '队长在目标上下文不可用：镜像未确认远端数据流（docker-consent-missing）。',
    params: [],
  },
  // TeamAssign 目标成员的可用性（#39 / D3.4 第 1 步）：与队长的不可用原因
  // 分开措辞，因为被分派的是成员，不是队长。
  'team.member.missing': { text: '目标成员不存在或已被移除。', params: [] },
  'team.member.notAgent': { text: '目标必须是 Agent 成员。', params: [] },
  'team.member.deleted': { text: '目标成员已被软删除。', params: [] },
  'team.member.disabled': { text: '目标成员已被禁用（enabled=0）。', params: [] },
  'team.member.notMember': { text: '目标成员已不是该频道的成员。', params: [] },
  'team.member.modelMissing': { text: '目标成员没有配置可用的模型。', params: [] },
  'team.member.consentMissing': {
    text: '目标成员所属模型 provider 尚未确认远端数据流告知。',
    params: [],
  },
  'team.member.credentialMissing': {
    text: '目标成员所属模型 provider 缺少凭证（{credential_env}）。',
    params: ['credential_env'],
  },
  'team.member.workspaceRootMissing': {
    text: '目标成员在目标上下文不可用：项目根不存在或不可读（workspace-root-missing）。',
    params: [],
  },
  'team.member.dockerUnavailable': {
    text: '目标成员在目标上下文不可用：Docker 后端不可用（docker-unavailable）。',
    params: [],
  },
  'team.member.dockerImageMissing': {
    text: '目标成员在目标上下文不可用：Docker 镜像不存在或无法拉取（docker-image-missing）。',
    params: [],
  },
  'team.member.dockerConsentMissing': {
    text: '目标成员在目标上下文不可用：镜像未确认远端数据流（docker-consent-missing）。',
    params: [],
  },
  // 分派的固定裁决顺序（D3.4）：先校验调用者与目标，再解析预算 target，
  // 再原子扣跳；失败落 failed / budget-exhausted，jump_consumed 定格。
  'team.assignment.reason.notLeader': {
    text: 'TeamAssign 只能由该频道的队长发起。',
    params: [],
  },
  'team.assignment.reason.self': {
    text: '不能把子任务分派给队长本人。',
    params: [],
  },
  'team.assignment.budgetExhausted': {
    text: '分派预算耗尽：本世代已用 {used}/{limit} 跳，本次分派未运行成员。',
    params: ['used', 'limit'],
  },
  'team.assignment.memberFailed': {
    text: '成员子轮次失败：{reason}',
    params: ['reason'],
  },
  'team.assignment.memberNoOutput': {
    text: '成员子轮次没有可用的产出。',
    params: [],
  },
  'team.assignment.truncated': { text: '…（摘录已截断）', params: [] },
  // Plan 工具的输入错误（#40）：工具结果的可读原因，不是 HTTP 错误文案。
  'plan.error.titleRequired': { text: '计划项标题不能为空。', params: [] },
  'plan.error.statusInvalid': {
    text: '计划项状态无效：{status}；只接受 pending / in_progress / completed。',
    params: ['status'],
  },
  // 运行面板的分派区块（#39）：assignment 是运行记录，不渲染成消息。
  'workspace.teamRuns.assignments.title': { text: '分派', params: [] },
  'workspace.teamRuns.assignments.jump': { text: '跳数', params: [] },
  'workspace.teamRuns.assignments.excerpt': { text: '摘录', params: [] },
  'workspace.teamRuns.assignments.reason': { text: '原因', params: [] },
  'workspace.teamRuns.assignments.state.running': { text: '运行中', params: [] },
  'workspace.teamRuns.assignments.state.completed': { text: '已完成', params: [] },
  'workspace.teamRuns.assignments.state.failed': { text: '失败', params: [] },
  'workspace.teamRuns.assignments.state.budgetExhausted': { text: '预算耗尽', params: [] },
  // 运行面板的 Plan 区块（#40）：plan_task 是自己的三词状态，不是任务五态。
  'workspace.plan.title': { text: '计划', params: [] },
  'workspace.plan.empty': { text: '暂无计划', params: [] },
  'workspace.plan.member': { text: '成员', params: [] },
  'workspace.plan.tasks': { text: '清单', params: [] },
  'workspace.plan.updatedAt': { text: '更新于', params: [] },
  'workspace.plan.status.pending': { text: '待开始', params: [] },
  'workspace.plan.status.inProgress': { text: '进行中', params: [] },
  'workspace.plan.status.completed': { text: '已完成', params: [] },
  // SOP 定义与启动（#41 / D4.2）：owner 显式启动的多步流程。定义不可变，
  // 运行按五 phase 只读呈现；它不是消息、任务或 team pipeline。
  'workspace.sop.title': { text: 'SOP 流程', params: [] },
  'workspace.sop.empty': { text: '暂无 SOP 定义', params: [] },
  'workspace.sop.archived': { text: '归档频道不能创建或启动 SOP。', params: [] },
  'workspace.sop.start': { text: '启动', params: [] },
  'workspace.sop.form.title': { text: '新建 SOP', params: [] },
  'workspace.sop.form.name': { text: '名称', params: [] },
  'workspace.sop.form.step': { text: '步骤 {index}', params: ['index'] },
  'workspace.sop.form.stepTitle': { text: '标题', params: [] },
  'workspace.sop.form.stepDescription': { text: '说明', params: [] },
  'workspace.sop.form.executor': { text: '执行者', params: [] },
  'workspace.sop.form.verifier': { text: '校验者', params: [] },
  'workspace.sop.form.maxAttempts': { text: '最大尝试', params: [] },
  'workspace.sop.form.addStep': { text: '添加步骤', params: [] },
  'workspace.sop.form.removeStep': { text: '删除步骤', params: [] },
  'workspace.sop.form.submit': { text: '创建定义', params: [] },
  'workspace.sop.form.agentsPending': { text: '成员表读取中。', params: [] },
  'workspace.sop.form.saveFailed': { text: 'SOP 定义创建失败。', params: [] },
  'workspace.sop.form.startFailed': { text: 'SOP 启动失败。', params: [] },
  'workspace.sop.runs.title': { text: '运行', params: [] },
  'workspace.sop.runs.empty': { text: '暂无运行', params: [] },
  'workspace.sop.runs.currentStep': { text: '当前步骤', params: [] },
  'workspace.sop.runs.startedAt': { text: '开始', params: [] },
  'workspace.sop.runs.finishedAt': { text: '结束', params: [] },
  'workspace.sop.phase.pending': { text: '待开始', params: [] },
  'workspace.sop.phase.running': { text: '运行中', params: [] },
  'workspace.sop.phase.awaiting': { text: '等待中', params: [] },
  'workspace.sop.phase.completed': { text: '已完成', params: [] },
  'workspace.sop.phase.failed': { text: '失败', params: [] },
  'workspace.sop.runs.attempt': { text: '尝试', params: [] },
  'workspace.sop.runs.waitingOn': { text: '等待', params: [] },
  'workspace.sop.runs.phaseStrip': { text: '阶段', params: [] },
  'workspace.sop.runs.executorExcerpt': { text: '执行者输出', params: [] },
  'workspace.sop.runs.verifierExcerpt': { text: '校验者输出', params: [] },
  'workspace.sop.runs.error': { text: '错误', params: [] },
  'workspace.sop.waiting.verifier': { text: '校验者判定', params: [] },
  'workspace.sop.waiting.approval': { text: '审批', params: [] },
  // SOP 运行收口与轮次失败的可读原因（后端）。
  'sop.run.interrupted': { text: 'SOP 运行因进程重启中断（interrupted）。', params: [] },
  'sop.run.verifier.noVerdict': {
    text: '校验者未返回结构化 sopVerdict，无法判定这一步。',
    params: [],
  },
  'sop.run.verifier.noReason': {
    text: '校验者判定为 fail，但没有给出可读说明。',
    params: [],
  },
  'sop.run.round.failed': { text: 'SOP 轮次失败：{reason}', params: ['reason'] },
  // 权限档 / 规则 / 审批（#44 / D5.5 / D5.6）：三档权限、规则集与 HITL 面。
  'permission.approval.timeout': {
    text: '审批等待超时（600 秒），本轮以失败收口。',
    params: [],
  },
  'workspace.permission.mode.label': { text: '权限档', params: [] },
  'workspace.permission.mode.readOnly': { text: '只读', params: [] },
  'workspace.permission.mode.askWrites': { text: '写前确认', params: [] },
  'workspace.permission.mode.trustedWrites': { text: '信任写入', params: [] },
  'workspace.permission.mode.followChannel': { text: '跟随频道', params: [] },
  'workspace.permission.rules.title': { text: '权限规则', params: [] },
  'workspace.permission.rules.empty': { text: '暂无规则', params: [] },
  'workspace.permission.rules.tool': { text: '工具', params: [] },
  'workspace.permission.rules.pattern': { text: '匹配', params: [] },
  'workspace.permission.rules.behavior': { text: '行为', params: [] },
  'workspace.permission.rules.add': { text: '添加规则', params: [] },
  'workspace.permission.rules.remove': { text: '删除', params: [] },
  'workspace.permission.rules.save': { text: '保存规则', params: [] },
  'workspace.permission.rules.saveFailed': { text: '规则保存失败。', params: [] },
  'workspace.permission.behavior.allow': { text: '放行', params: [] },
  'workspace.permission.behavior.ask': { text: '询问', params: [] },
  'workspace.permission.behavior.deny': { text: '拒绝', params: [] },
  'workspace.approval.title': { text: '审批', params: [] },
  'workspace.approval.empty': { text: '暂无审批', params: [] },
  'workspace.approval.open': { text: '打开审批面板', params: [] },
  'workspace.approval.status.pending': { text: '等待确认', params: [] },
  'workspace.approval.status.confirmed': { text: '已批准', params: [] },
  'workspace.approval.status.denied': { text: '已拒绝', params: [] },
  'workspace.approval.status.failed': { text: '已失败', params: [] },
  'workspace.approval.status.expired': { text: '已过期', params: [] },
  'workspace.approval.context.round': { text: '普通轮次', params: [] },
  'workspace.approval.context.teamAssignment': { text: 'team 分派', params: [] },
  'workspace.approval.context.sop': { text: 'SOP', params: [] },
  'workspace.approval.target': { text: '目标', params: [] },
  'workspace.approval.batch': { text: '批次 {index}', params: ['index'] },
  'workspace.approval.approve': { text: '批准', params: [] },
  'workspace.approval.deny': { text: '拒绝', params: [] },
  'workspace.approval.decided': { text: '已决策', params: [] },
  'workspace.approval.detail': { text: '审批详情', params: [] },
  'workspace.approval.back': { text: '返回列表', params: [] },
  'workspace.approval.shell.command': { text: '命令', params: [] },
  'workspace.approval.shell.cwd': { text: '工作目录', params: [] },
  // 后端诊断（D2.1 / D5.4 / D6）：这些文案由后端生成，按库内语言偏好渲染；
  // 键只描述事实，参数只带标识与可读细节，从不携带 env 值或凭据。
  'mcp.file.invalidJson': { text: 'mcp.json 不是合法 JSON', params: [] },
  'mcp.file.topNotObject': { text: 'mcp.json 顶层必须是对象', params: [] },
  'mcp.file.unknownTop': {
    text: 'mcp.json 含未知字段：{field}',
    params: ['field'],
  },
  'mcp.file.serversRequired': { text: 'mcp.json 必须含 servers 数组', params: [] },
  'mcp.file.duplicateName': {
    text: 'mcp.json 条目名重复：{name}',
    params: ['name'],
  },
  'mcp.file.entriesArray': { text: 'entries 必须是数组', params: [] },
  'mcp.file.duplicateEntry': { text: '条目名重复：{name}', params: ['name'] },
  'mcp.file.unreadable': { text: 'mcp.json 不可读：{path}', params: ['path'] },
  'mcp.file.bodyObject': { text: '请求体必须是对象', params: [] },
  'mcp.file.entriesOrRaw': {
    text: '请求体必须恰好给 entries 或 raw 之一',
    params: [],
  },
  'mcp.file.unknownField': { text: '未知字段：{field}', params: ['field'] },
  'mcp.file.rawString': { text: 'raw 必须是字符串', params: [] },
  'mcp.file.remoteUnconfirmed': {
    text: '远端 MCP 未确认数据面，运行期不会连接：{names}',
    params: ['names'],
  },
  'mcp.file.entryNotObject': {
    text: '第 {index} 个条目必须是对象',
    params: ['index'],
  },
  'mcp.file.entryTransport': {
    text: '第 {index} 个条目的 transport 必须是 stdio / http / sse',
    params: ['index'],
  },
  'mcp.file.entryStdioUrl': {
    text: '第 {index} 个条目是 stdio，不能带 url',
    params: ['index'],
  },
  'mcp.file.entryRemoteCommand': {
    text: '第 {index} 个条目是 {transport}，不能带 {field}',
    params: ['index', 'transport', 'field'],
  },
  'mcp.file.entryUnknownField': {
    text: '第 {index} 个条目含未知字段：{field}',
    params: ['index', 'field'],
  },
  'mcp.file.entryNameMissing': {
    text: '第 {index} 个条目缺少条目名',
    params: ['index'],
  },
  'mcp.file.entryNameChars': {
    text: '第 {index} 个条目的条目名不能含空白或 /：{name}',
    params: ['index', 'name'],
  },
  'mcp.file.entryEnabledBoolean': {
    text: '第 {index} 个条目（{name}）的 enabled 必须是布尔值',
    params: ['index', 'name'],
  },
  'mcp.file.entryCommandMissing': {
    text: '第 {index} 个条目（{name}）缺少 command',
    params: ['index', 'name'],
  },
  'mcp.file.entryArgsArray': {
    text: '第 {index} 个条目（{name}）的 args 必须是字符串数组',
    params: ['index', 'name'],
  },
  'mcp.file.entryUrlMissing': {
    text: '第 {index} 个条目（{name}）缺少 url',
    params: ['index', 'name'],
  },
  'mcp.file.entryUrlInvalid': {
    text: '第 {index} 个条目（{name}）的 url 不是合法 URL',
    params: ['index', 'name'],
  },
  'mcp.file.entryUrlProtocol': {
    text: '第 {index} 个条目（{name}）的 url 必须是 http / https',
    params: ['index', 'name'],
  },
  'mcp.file.entryEnvNames': {
    text: '第 {index} 个条目（{name}）的 env_names 必须是变量名数组',
    params: ['index', 'name'],
  },
  'mcp.runtime.permissionContextMissing': {
    text: 'MCP 装配失败：找不到 {target_id} 的权限上下文',
    params: ['target_id'],
  },
  'mcp.runtime.remoteUnconfirmed': {
    text: 'MCP 服务器 {name}（{transport}）未确认远端数据流，未连接',
    params: ['name', 'transport'],
  },
  'mcp.runtime.assembleFailed': {
    text: 'MCP 服务器 {name} 装配失败：{detail}',
    params: ['name', 'detail'],
  },
  'mcp.runtime.connectFailed': {
    text: 'MCP 服务器 {name} 连接失败：{detail}',
    params: ['name', 'detail'],
  },
  'mcp.runtime.serverMissing': {
    text: 'MCP 服务器未装配：{name}',
    params: ['name'],
  },
  'mcp.export.applyYes': {
    text: 'export-mcp：--apply 与 --yes 必须同时给出；未写入任何文件。',
    params: [],
  },
  'mcp.export.noRows': {
    text: 'export-mcp：没有可导出的 Agent 级 mcp_server 行。',
    params: [],
  },
  'mcp.export.rejectedHeader': {
    text: 'export-mcp：整次导出被拒绝，未写入任何文件：',
    params: [],
  },
  'mcp.export.dryRunLine': {
    text: '[dry-run] agent {agent_id}：{count} 条声明{status}',
    params: ['agent_id', 'count', 'status'],
  },
  'mcp.export.latestSuffix': { text: '（已是最新）', params: [] },
  'mcp.export.dryRunEnd': {
    text: 'export-mcp：dry-run，未写入；同时给出 --apply --yes 才会写入。',
    params: [],
  },
  'mcp.export.unchanged': {
    text: 'agent {agent_id}：mcp.json 已包含这些声明，未改写。',
    params: ['agent_id'],
  },
  'mcp.export.written': {
    text: 'agent {agent_id}：写入 {path}{backup}',
    params: ['agent_id', 'path', 'backup'],
  },
  'mcp.export.backupSuffix': { text: '（备份 {path}）', params: ['path'] },
  'mcp.export.done': {
    text: 'export-mcp：完成；mcp_server 行保留未删（{rows} 行），远端确认只保留旧行上已有的 {consents} 条。',
    params: ['rows', 'consents'],
  },
  'mcp.export.missingAgent': {
    text: 'agent {agent_id}：mcp_server 行指向不存在的 Agent，拒绝导出',
    params: ['agent_id'],
  },
  'mcp.export.invalidExisting': {
    text: 'agent {agent_id}：现有 mcp.json 不可用（{diagnostic}），拒绝覆盖',
    params: ['agent_id', 'diagnostic'],
  },
  'mcp.export.shapeConflict': {
    text: 'agent {agent_id} / {name}：同名条目在 mcp.json 中的形状与旧行不同，拒绝整次写入',
    params: ['agent_id', 'name'],
  },
  'mcp.export.configInvalidJson': { text: 'config 不是合法 JSON', params: [] },
  'mcp.export.configNotObject': { text: 'config 必须是对象', params: [] },
  'mcp.export.configUnsupported': {
    text: 'config 含 M2 不支持的字段：{field}',
    params: ['field'],
  },
  'skill.migrate.applyYes': {
    text: 'migrate-skills：--apply 与 --yes 必须同时给出；未写入任何文件。',
    params: [],
  },
  'skill.migrate.refused': {
    text: '拒绝执行：存在目标同名但内容不同或无法读取的条目。请先手动裁定；本命令不覆盖、不提供 --force；本次未写入任何文件。',
    params: [],
  },
  'skill.migrate.dryRunEnd': {
    text: '预演结束：未写入任何文件、未改动数据库、未创建备份或迁移清单。',
    params: [],
  },
  'skill.migrate.nothingToDo': {
    text: '技能迁移：没有需要写入的条目（全部已就位或没有成员级字节）；未写入任何文件。',
    params: [],
  },
  'skill.migrate.processedZero': {
    text: '处理条目： 0 条（已复制 0 / 只补行 0 / 跳过 {skipped}）',
    params: ['skipped'],
  },
  'skill.migrate.channelDeprecated': { text: '频道级已弃用，请按成员安装', params: [] },
  'skill.migrate.done': { text: '技能迁移完成', params: [] },
  'skill.migrate.backupLine': { text: '  数据目录备份： {path}', params: ['path'] },
  'skill.migrate.manifestLine': { text: '  迁移清单： {path}', params: ['path'] },
  'skill.migrate.processed': {
    text: '处理条目： {processed} 条（已复制 {copied} / 只补行 {rows_only} / 跳过 {skipped}）',
    params: ['processed', 'copied', 'rows_only', 'skipped'],
  },
  'skill.migrate.entryLine': {
    text: '  {action} {source} → {target}（{files} 个文件 / {bytes} 字节；hash {hash}）',
    params: ['action', 'source', 'target', 'files', 'bytes', 'hash'],
  },
  'skill.migrate.copy': { text: '复制', params: [] },
  'skill.migrate.rowOnly': { text: '只补行', params: [] },
  'skill.migrate.new': { text: '新建', params: [] },
  'skill.migrate.skip': { text: '跳过', params: [] },
  'skill.migrate.refuse': { text: '拒绝', params: [] },
  'skill.migrate.removable': {
    text: '可手工删除的源路径（确认后；本命令不删除任何源文件）：',
    params: [],
  },
  'skill.migrate.unknownPartitionMember': { text: '未匹配现行成员或频道', params: [] },
  'skill.migrate.unsafePartition': { text: '分区名不是安全 slug', params: [] },
  'skill.migrate.unsafeName': { text: '技能名不是安全 slug，拒绝迁移', params: [] },
  'skill.migrate.multiRootConflict': {
    text: '同一成员的同名旧技能在多个频道根内容不同，需人工裁定',
    params: [],
  },
  'skill.migrate.targetDiffers': {
    text: '目标已存在但内容不同，需人工裁定后再迁移（本命令不覆盖）',
    params: [],
  },
  'skill.migrate.targetUnreadable': {
    text: '目标已存在但不可读取：{detail}',
    params: ['detail'],
  },
  'skill.migrate.rowHashDiffers': { text: '库行已存在且 hash 不同，需人工裁定', params: [] },
  'skill.migrate.skippedPresent': { text: '目标字节与库行均已就位，跳过', params: [] },
  'skill.migrate.rowOnlyPresent': {
    text: '目标字节已存在且内容相同，只补写 Agent 级库行',
    params: [],
  },
  'skill.migrate.rowMissingBytes': {
    text: '库行已存在但目标字节缺失，补齐成员家目录副本',
    params: [],
  },
  'skill.migrate.copyNew': {
    text: '目标不存在，将复制字节并新建 Agent 级库行',
    params: [],
  },
  'skill.migrate.planTitle': { text: '技能迁移计划（migrate-skills，只读扫描）', params: [] },
  'skill.migrate.dataDirLine': { text: '数据目录： {path}', params: ['path'] },
  'skill.migrate.globalLayerLine': { text: '全局层根： {path}', params: ['path'] },
  'skill.migrate.empty': {
    text: '没有发现旧项目层技能字节；空操作（未写入任何文件、未改动数据库）。',
    params: [],
  },
  'skill.migrate.memberEntries': {
    text: '成员级技能： {total} 条（新建 {copy} / 只补行 {row} / 跳过 {skip} / 拒绝 {refuse}）',
    params: ['total', 'copy', 'row', 'skip', 'refuse'],
  },
  'skill.migrate.entryHead': {
    text: '  {action} {source} → {target}',
    params: ['action', 'source', 'target'],
  },
  'skill.migrate.entryDetail': {
    text: '（{files} 个文件 / {bytes} 字节；hash {hash}）',
    params: ['files', 'bytes', 'hash'],
  },
  'skill.migrate.reasonLine': { text: '    原因：{reason}', params: ['reason'] },
  'skill.migrate.channelSection': {
    text: '频道级技能（不迁移）： {partitions} 个分区 / {skills} 个技能 —— 频道级已弃用，请按成员安装',
    params: ['partitions', 'skills'],
  },
  'skill.migrate.channelLine': {
    text: '  频道 {channel_id}：{path}（{count} 个技能：{skills}）',
    params: ['channel_id', 'path', 'count', 'skills'],
  },
  'skill.migrate.channelNotice': { text: '    频道级已弃用，请按成员安装', params: [] },
  'skill.migrate.unknownSection': {
    text: '未匹配分区（不迁移）： {count} 个',
    params: ['count'],
  },
  'plan.error.limit': { text: 'limit 必须是 1 到 50 之间的整数', params: [] },
  'plan.error.targetNotFound': { text: 'target 不存在：{target_id}', params: ['target_id'] },

  // 工具结果回灌：截断与 Grep 封顶事实（#62 / D6）。只答复模型看到的那一份。
  'tool.result.truncated': {
    text: '（结果已截断：已给 {given} 字，共 {total} 字；其余内容未回灌）',
    params: ['given', 'total'],
  },
  'tool.grep.capped.matches': {
    text: '（命中数已封顶：只列出前 {limit} 条匹配，还有更多匹配未列出）',
    params: ['limit'],
  },
  'tool.grep.capped.files': {
    text: '（扫描文件数已封顶：只扫描了前 {limit} 个文件，还有文件未扫描）',
    params: ['limit'],
  },
  // Bash 输出上限（#75 / D6）：shell 侧已截断的事实必须显式回灌，否则模型会把
  // 「只看到一段」读成「命令就输出这么多」。
  'tool.bash.output.truncated': {
    text: '（输出已截断：单次调用的输出超过 {limit} 字节上限，超出部分未捕获）',
    params: ['limit'],
  },
} as const satisfies Record<string, CatalogEntry>;
