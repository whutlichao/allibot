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
  'cli.migrate.already_current': {
    text: '数据目录 {data_dir} 已是 Schema 版本 {schema_version}。',
    params: ['data_dir', 'schema_version'],
  },
  'cli.data_dir.legacy_warning': {
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
  'settings.locale.zh-CN': { text: '简体中文', params: [] },
  'settings.density.label': { text: '消息密度', params: [] },
  'settings.density.comfortable': { text: '舒适', params: [] },
  'settings.density.compact': { text: '紧凑', params: [] },
  'settings.theme.label': { text: '主题', params: [] },
  'settings.theme.light': { text: '浅色', params: [] },
  'settings.theme.dark': { text: '深色', params: [] },
  'settings.theme.system': { text: '跟随系统', params: [] },
  'settings.error.load': { text: '设置读取失败，请确认后端已启动。', params: [] },
  'settings.error.save': { text: '设置未保存，请重试。', params: [] },

  // 示例文案：用来看消息密度在壳里的呈现。
  'message.sample.author': { text: '示例成员', params: [] },
  'message.sample.body': { text: '{author} 的消息示例：正文按消息密度呈现。', params: ['author'] },
} as const satisfies Record<string, CatalogEntry>;
