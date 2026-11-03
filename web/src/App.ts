import { t, type WorkspaceSettingsView } from '@allibot/shared';
import { createElement } from 'react';
import { Avatar } from './components/Avatar.ts';
import { SettingsPanel } from './components/SettingsPanel.ts';

export interface AppProps {
  settings: WorkspaceSettingsView;
  onSettingsChange?: (patch: Partial<WorkspaceSettingsView>) => void;
  saveFailed?: boolean;
}

/**
 * 工作台壳：density 与 theme 作为壳上的状态呈现，设置面板改的就是这两档。
 *
 * 文案从词条表按语言偏好渲染（与后端同一份取值）；示例消息用来观察
 * 消息密度在壳里的呈现差异。
 *
 * 这里用 createElement 而不是 JSX：Node 的类型剥离不处理 JSX，
 * 组件级 SSR 契约测试需要直接 import 本文件。
 */
export function App({ settings, onSettingsChange, saveFailed = false }: AppProps) {
  const locale = settings.locale;
  const author = t(locale, 'message.sample.author');

  return createElement(
    'main',
    {
      className: 'app-shell',
      'data-density': settings.density,
      'data-theme': settings.theme,
      'data-locale': locale,
    },
    createElement(SettingsPanel, { settings, onChange: onSettingsChange, saveFailed }),
    createElement(
      'section',
      { className: 'sample-message', 'data-density': settings.density },
      createElement(Avatar, { slot: 0, name: author }),
      createElement(
        'div',
        { className: 'sample-message__body' },
        createElement('span', { className: 'sample-message__author' }, author),
        createElement(
          'p',
          { className: 'sample-message__text' },
          t(locale, 'message.sample.body', { author }),
        ),
      ),
    ),
  );
}
