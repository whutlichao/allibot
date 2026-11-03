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
  'round.noBody': { text: '本轮没有产出可落库的正文', params: [] },
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
  'system.member.piercedJoin': {
    text: '{name} 加入了频道：它被点名时并不在频道里，回复时顺带加入（成员变化只随真实回复发生）',
    params: ['name'],
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

  // 频道里的指针消息正文：它是 system，不计未读、不唤醒。
  'task.pointer.body': { text: '已创建任务「{title}」，在这里进入任务线程。', params: ['title'] },

  // 任务状态在系统事件消息里的可读标签（承重词，不用看板列名替代）。
  'task.status.todo': { text: '待认领', params: [] },
  'task.status.inProgress': { text: '进行中', params: [] },
  'task.status.inReview': { text: '待审', params: [] },
  'task.status.done': { text: '完成', params: [] },
  'task.status.closed': { text: '已关闭', params: [] },
} as const satisfies Record<string, CatalogEntry>;
