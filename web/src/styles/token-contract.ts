/**
 * 视觉契约（Visual Contract）的固定 token 名清单。
 *
 * token 名由下游按名消费，改名或删除会同时扯断全部消费点；本清单是唯一正本，
 * 由 `web/test/visual-contract.test.ts` 对照实际加载的 CSS 校验。
 *
 * 外部 allibot-design-system/ 包未 vendored 到本仓（本机不可得），
 * `tokens.css` 是该包 colors_and_type.css + tokens.css 的仓内只读参照实现；
 * 产品角色族（--selected* / --unread* / --warn*）由产品扩展层
 * `product-roles.css` 声明。
 */

/**
 * 档位（Tier）后缀：族名沿用旧名，新增档位只允许这三个后缀。
 * 淡底档 = ''（族名）；填充档 = '-fill'；文字档 = '-deep'；图形档 = '-graphic'。
 */
export const TIER_SUFFIXES = ['', '-fill', '-deep', '-graphic'] as const;

/** 角色族（Role Family）：每个角色恰好一个色相。 */
export const ROLE_FAMILY_ROOTS = ['--accent', '--selected', '--unread', '--warn'] as const;

/** 状态点四态；头像色位不得读取这些 token 决定颜色。 */
export const STATUS_TOKENS = ['--online', '--working', '--error', '--offline'] as const;

/** 头像色位（Avatar Slot）：avatar_slot 0..4 的确定性色位。 */
export const AVATAR_SLOT_TOKENS = ['--av-0', '--av-1', '--av-2', '--av-3', '--av-4'] as const;

/** 新增档位不得使用 -light / -dark 等明暗别名。 */
export const FORBIDDEN_TIER_ALIASES = ['-light', '-dark'] as const;

/** 固定 token 名清单：下游按名字消费的完整集合。 */
export const VISUAL_CONTRACT_TOKENS = [
  // 系统面
  '--bg',
  '--surface',
  '--panel',
  '--panel-2',
  '--fg',
  '--muted',
  '--faint',
  '--border',
  '--border-strong',
  '--on-accent',
  // 角色族 accent：淡底 / 填充 / 文字 / 图形
  '--accent',
  '--accent-fill',
  '--accent-deep',
  '--accent-graphic',
  // 角色族 selected
  '--selected',
  '--selected-fill',
  '--selected-deep',
  '--selected-graphic',
  // 角色族 unread
  '--unread',
  '--unread-fill',
  '--unread-deep',
  '--unread-graphic',
  // 角色族 warn
  '--warn',
  '--warn-fill',
  '--warn-deep',
  '--warn-graphic',
  // 状态点
  '--online',
  '--working',
  '--error',
  '--offline',
  // 头像色位
  '--av-0',
  '--av-1',
  '--av-2',
  '--av-3',
  '--av-4',
] as const;
