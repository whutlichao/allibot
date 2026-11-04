import {
  t,
  type Locale,
  type PermissionBehavior,
  type PermissionRuleInput,
  type PermissionRuleView,
} from '@allibot/shared';
import { createElement, useEffect, useState, type ReactNode } from 'react';
import {
  permissionBehaviorOptions,
  permissionRuleDrafts,
  permissionRuleInputs,
  type PermissionRuleDraft,
} from './permissions.ts';

export interface PermissionRulesEditorProps {
  /** The scope's current set; undefined means the read has not landed yet. */
  rules: readonly PermissionRuleView[] | undefined;
  locale: Locale;
  /** The host's full-replacement write; absent = read-only display. */
  onSave?: (rules: PermissionRuleInput[]) => void | Promise<void>;
  /** The fold's summary already names the section, so the inner title yields. */
  showTitle?: boolean;
}

/**
 * 权限规则集编辑器 (#44 / D5.5): 全量替换，空数组合法。控件只编辑草稿；
 * 保存把完整数组交给宿主的 `PUT`，后端才是正本。任一行非法由后端拒绝并保持
 * 旧集合，前端只呈现失败。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX。
 */
export function PermissionRulesEditor({
  rules,
  locale,
  onSave,
  showTitle = true,
}: PermissionRulesEditorProps) {
  const [drafts, setDrafts] = useState<PermissionRuleDraft[]>(() =>
    permissionRuleDrafts(rules),
  );
  const [saving, setSaving] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);
  const signature = JSON.stringify(rules ?? null);

  // The backend reading is the source of truth: a re-read replaces the draft.
  useEffect(() => {
    setDrafts(permissionRuleDrafts(rules));
  }, [signature]);

  const behaviors = permissionBehaviorOptions(locale);

  function edit(index: number, patch: Partial<PermissionRuleDraft>): void {
    setDrafts((current) =>
      current.map((draft, position) => (position === index ? { ...draft, ...patch } : draft)),
    );
  }

  function add(): void {
    setDrafts((current) => [
      ...current,
      { tool_name: 'Write', pattern: '', behavior: 'ask' },
    ]);
  }

  function remove(index: number): void {
    setDrafts((current) => current.filter((_draft, position) => position !== index));
  }

  function save(): void {
    if (onSave === undefined || saving) {
      return;
    }
    setSaving(true);
    setSaveFailed(false);
    void Promise.resolve(onSave(permissionRuleInputs(drafts)))
      .then(() => setSaving(false))
      .catch(() => {
        setSaving(false);
        setSaveFailed(true);
      });
  }

  const rows: ReactNode[] = drafts.map((draft, index) =>
    createElement(
      'li',
      { key: index, className: 'permission-rules__row', 'data-permission-rule': index },
      createElement('input', {
        className: 'permission-rules__tool',
        'data-field': 'tool_name',
        value: draft.tool_name,
        placeholder: 'Read',
        onChange: (event: { target: { value: string } }) =>
          edit(index, { tool_name: event.target.value }),
      }),
      createElement('input', {
        className: 'permission-rules__pattern',
        'data-field': 'pattern',
        value: draft.pattern,
        placeholder: 'src/**',
        onChange: (event: { target: { value: string } }) =>
          edit(index, { pattern: event.target.value }),
      }),
      createElement(
        'select',
        {
          className: 'permission-rules__behavior',
          'data-field': 'behavior',
          value: draft.behavior,
          onChange: (event: { target: { value: string } }) =>
            edit(index, { behavior: event.target.value as PermissionBehavior }),
        },
        ...behaviors.map((behavior) =>
          createElement('option', { key: behavior.value, value: behavior.value }, behavior.label),
        ),
      ),
      createElement(
        'button',
        {
          type: 'button',
          className: 'permission-rules__remove',
          'data-action': 'remove-permission-rule',
          onClick: () => remove(index),
        },
        t(locale, 'workspace.permission.rules.remove'),
      ),
    ),
  );

  return createElement(
    'section',
    { className: 'permission-rules', 'data-permission-rules': '' },
    showTitle
      ? createElement(
          'h4',
          { className: 'permission-rules__title' },
          t(locale, 'workspace.permission.rules.title'),
        )
      : null,
    rules === undefined
      ? createElement('p', { className: 'workspace-panel__pending' }, t(locale, 'workspace.status.loading'))
      : drafts.length === 0
        ? createElement(
            'p',
            { className: 'permission-rules__empty', 'data-permission-rules-empty': 'true' },
            t(locale, 'workspace.permission.rules.empty'),
          )
        : createElement(
            'ul',
            { className: 'permission-rules__list' },
            createElement(
              'li',
              { className: 'permission-rules__head' },
              createElement('span', null, t(locale, 'workspace.permission.rules.tool')),
              createElement('span', null, t(locale, 'workspace.permission.rules.pattern')),
              createElement('span', null, t(locale, 'workspace.permission.rules.behavior')),
              createElement('span', null, ''),
            ),
            ...rows,
          ),
    onSave === undefined
      ? null
      : createElement(
          'div',
          { className: 'permission-rules__actions' },
          createElement(
            'button',
            {
              type: 'button',
              className: 'permission-rules__add',
              'data-action': 'add-permission-rule',
              onClick: add,
            },
            t(locale, 'workspace.permission.rules.add'),
          ),
          createElement(
            'button',
            {
              type: 'button',
              className: 'permission-rules__save',
              'data-action': 'save-permission-rules',
              disabled: saving,
              onClick: save,
            },
            t(locale, 'workspace.permission.rules.save'),
          ),
          saveFailed
            ? createElement(
                'p',
                { className: 'permission-rules__error', 'data-permission-rules-error': 'true' },
                t(locale, 'workspace.permission.rules.saveFailed'),
              )
            : null,
        ),
  );
}
