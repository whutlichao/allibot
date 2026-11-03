import {
  t,
  type Locale,
  type MessageDensity,
  type Theme,
  type WorkspaceSettingsView,
} from '@allibot/shared';
import { createElement } from 'react';

/** 三档设置的取值，按词条表渲染；顺序即呈现顺序。 */
const DENSITY_OPTIONS = ['comfortable', 'compact'] as const;
const THEME_OPTIONS = ['light', 'dark', 'system'] as const;

/**
 * 每个取值的文案都逐档写成词条表的键，不拼字符串：键是稳定标识，拼接会让
 * 用法扫描看不见真实用量。
 */
function densityLabel(locale: Locale, density: MessageDensity): string {
  switch (density) {
    case 'comfortable':
      return t(locale, 'settings.density.comfortable');
    case 'compact':
      return t(locale, 'settings.density.compact');
  }
}

function themeLabel(locale: Locale, theme: Theme): string {
  switch (theme) {
    case 'light':
      return t(locale, 'settings.theme.light');
    case 'dark':
      return t(locale, 'settings.theme.dark');
    case 'system':
      return t(locale, 'settings.theme.system');
  }
}

export interface SettingsPanelProps {
  settings: WorkspaceSettingsView;
  onChange?: (patch: Partial<WorkspaceSettingsView>) => void;
  saveFailed?: boolean;
}

/**
 * 工作区设置面板：语言偏好 / 消息密度 / 主题三档。
 *
 * 文案全部从词条表按当前语言偏好渲染，组件内不写死任何用户可见文字；
 * 语言偏好只有一个可选值（M1 只交付简体中文），所以它呈现为当前取值，
 * 密度与主题是可改的两档。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function SettingsPanel({ settings, onChange, saveFailed = false }: SettingsPanelProps) {
  const locale = settings.locale;
  const change = onChange ?? (() => undefined);

  return createElement(
    'section',
    { className: 'settings-panel', 'aria-label': t(locale, 'settings.title') },
    createElement('h2', { className: 'settings-panel__title' }, t(locale, 'settings.title')),
    createElement(
      'div',
      { className: 'settings-panel__field' },
      createElement(
        'span',
        { className: 'settings-panel__label' },
        t(locale, 'settings.locale.label'),
      ),
      createElement(
        'span',
        { className: 'settings-panel__value', 'data-locale': locale },
        t(locale, 'settings.locale.zhCN'),
      ),
    ),
    createElement(
      'label',
      { className: 'settings-panel__field' },
      createElement(
        'span',
        { className: 'settings-panel__label' },
        t(locale, 'settings.density.label'),
      ),
      createElement(
        'select',
        {
          name: 'density',
          value: settings.density,
          onChange: (event: { currentTarget: { value: string } }) => {
            const density = DENSITY_OPTIONS.find((option) => option === event.currentTarget.value);
            if (density !== undefined) {
              change({ density });
            }
          },
        },
        DENSITY_OPTIONS.map((option) =>
          createElement('option', { key: option, value: option }, densityLabel(locale, option)),
        ),
      ),
    ),
    createElement(
      'label',
      { className: 'settings-panel__field' },
      createElement(
        'span',
        { className: 'settings-panel__label' },
        t(locale, 'settings.theme.label'),
      ),
      createElement(
        'select',
        {
          name: 'theme',
          value: settings.theme,
          onChange: (event: { currentTarget: { value: string } }) => {
            const theme = THEME_OPTIONS.find((option) => option === event.currentTarget.value);
            if (theme !== undefined) {
              change({ theme });
            }
          },
        },
        THEME_OPTIONS.map((option) =>
          createElement('option', { key: option, value: option }, themeLabel(locale, option)),
        ),
      ),
    ),
    saveFailed
      ? createElement(
          'p',
          { className: 'settings-panel__error', role: 'alert' },
          t(locale, 'settings.error.save'),
        )
      : null,
  );
}
