import { t, type Locale } from '@allibot/shared';
import { createElement, type ReactNode } from 'react';

/**
 * 空状态里的单行创建表单：无频道与无 Agent 两处共用一个形状 —— 一个名字输入
 * 加一个按钮。名字就是用户输入的名字：空名字（含只有空白）不能提交，任何情况下
 * 都不回落到默认名。写路径由宿主注入的动作承担，表单自己不拼 fetch。
 */

/** 宿主注入的创建动作：成功即兑现，失败即拒绝。 */
export interface InlineCreateAction {
  (name: string): Promise<unknown>;
}

export interface InlineCreateState {
  name: string;
  submitting: boolean;
  failed: boolean;
}

export function initialInlineCreate(): InlineCreateState {
  return { name: '', submitting: false, failed: false };
}

export function editInlineCreateName(state: InlineCreateState, name: string): InlineCreateState {
  return { ...state, name };
}

/** 空名字不能提交；提交中的那一次也不能再提交一次。 */
export function canCreateInline(state: InlineCreateState): boolean {
  return !state.submitting && state.name.trim().length > 0;
}

/**
 * 提交的唯一路径：成功后清空输入（宿主已刷新读数），失败时把名字留在原地并
 * 标记失败 —— 错误显示在这条空状态内，不静默吞掉。
 */
export async function submitInlineCreate(
  state: InlineCreateState,
  create: InlineCreateAction,
): Promise<InlineCreateState> {
  if (!canCreateInline(state)) {
    return state;
  }
  try {
    await create(state.name.trim());
    return initialInlineCreate();
  } catch {
    return { ...state, submitting: false, failed: true };
  }
}

export interface InlineCreateFormProps {
  state: InlineCreateState;
  locale: Locale;
  /** 名字输入的无障碍标签。 */
  nameLabel: string;
  /** 创建按钮的文案。 */
  submitLabel: string;
  /** 按钮的 `data-action`，与其它动作入口同一套命名。 */
  action: string;
  onChange: (name: string) => void;
  onSubmit: () => void;
}

/**
 * 单行创建表单的呈现：输入 + 按钮 + 就地错误。它不持有草稿也不发请求，
 * 状态与动作都由调用方（空状态所在的导航）给出。
 */
export function InlineCreateForm({
  state,
  locale,
  nameLabel,
  submitLabel,
  action,
  onChange,
  onSubmit,
}: InlineCreateFormProps): ReactNode {
  return createElement(
    'form',
    {
      className: 'inline-create',
      'data-inline-create': action,
      onSubmit: (event: { preventDefault: () => void }) => {
        event.preventDefault();
        onSubmit();
      },
    },
    createElement('input', {
      className: 'inline-create__name',
      type: 'text',
      name: 'name',
      value: state.name,
      'aria-label': nameLabel,
      onChange: (event: { currentTarget: { value: string } }) =>
        onChange(event.currentTarget.value),
    }),
    createElement(
      'button',
      {
        type: 'submit',
        className: 'inline-create__submit',
        'data-action': action,
        disabled: !canCreateInline(state),
      },
      submitLabel,
    ),
    state.failed
      ? createElement(
          'p',
          { className: 'inline-create__error', role: 'alert' },
          t(locale, 'workspace.nav.createFailed'),
        )
      : null,
  );
}
