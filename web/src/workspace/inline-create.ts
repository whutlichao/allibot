import { t, type Locale } from '@allibot/shared';
import { createElement, type ReactNode } from 'react';
import type { AsyncAction1 } from '../async-action.ts';

/**
 * 空状态里的单行创建表单：无频道与无 Agent 两处共用一个形状 —— 一个名字输入
 * 加一个按钮。名字就是用户输入的名字：空名字（含只有空白）不能提交，任何情况下
 * 都不回落到默认名。写路径由宿主注入的动作承担，表单自己不拼 fetch。
 */

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
 * 提交的唯一路径，`canCreateInline` 也只在这里判一次：空名字什么都不发，
 * 草稿也不动 —— 返回的是传进来的**同一个对象**，调用方据此知道什么都没发生。
 * 能提交时先通过 `onSubmitting` 挂上「提交中」（按钮随之禁用，避免二次提交），
 * 再把最终草稿返回给调用方写回：成功后清空输入（宿主已刷新读数），失败时把
 * 名字留在原地并标记失败 —— 错误显示在这条空状态内，不静默吞掉。
 */
export async function submitInlineCreate(
  state: InlineCreateState,
  create: AsyncAction1<string>,
  onSubmitting?: (next: InlineCreateState) => void,
): Promise<InlineCreateState> {
  if (!canCreateInline(state)) {
    return state;
  }
  onSubmitting?.({ ...state, submitting: true, failed: false });
  try {
    await create(state.name.trim());
    return initialInlineCreate();
  } catch {
    return { ...state, submitting: false, failed: true };
  }
}

/**
 * 表单按钮与提交事件的落点：把「提交中」与最终草稿两个状态写回表单。能否提交
 * 不在这里判 —— 那个守卫只在 `submitInlineCreate` 里存在；空名字时它原样返回
 * 传进来的状态，所以这里一次也不写，草稿不会白闪一下。
 */
export async function runInlineCreate(
  state: InlineCreateState,
  create: AsyncAction1<string>,
  setState: (next: InlineCreateState) => void,
): Promise<void> {
  const settled = await submitInlineCreate(state, create, setState);
  if (settled !== state) {
    setState(settled);
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
