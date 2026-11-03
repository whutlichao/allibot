import { t, type WorkspaceSettingsView } from '@allibot/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App.ts';

const DEFAULT_SETTINGS: WorkspaceSettingsView = {
  locale: 'zh-CN',
  density: 'comfortable',
  theme: 'system',
};

const rootElement = document.getElementById('root');
if (rootElement === null) {
  throw new Error('root element #root is missing');
}

const root = createRoot(rootElement);

/** 工作区设置落库、后端是唯一正本：壳启动时读同一份取值。 */
async function readSettings(): Promise<WorkspaceSettingsView> {
  const response = await fetch('/api/settings');
  if (!response.ok) {
    throw new Error(`GET /api/settings failed with ${response.status}`);
  }
  return (await response.json()) as WorkspaceSettingsView;
}

async function writeSettings(
  patch: Partial<WorkspaceSettingsView>,
): Promise<WorkspaceSettingsView> {
  const response = await fetch('/api/settings', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!response.ok) {
    throw new Error(`PATCH /api/settings failed with ${response.status}`);
  }
  return (await response.json()) as WorkspaceSettingsView;
}

function render(settings: WorkspaceSettingsView, failed: { load?: boolean; save?: boolean } = {}): void {
  root.render(
    <StrictMode>
      <App
        settings={settings}
        saveFailed={failed.save === true}
        onSettingsChange={(patch) => {
          // 先按返回值重渲染：后端是正本，不乐观地本地改写。
          writeSettings(patch)
            .then((saved) => render(saved))
            .catch(() => render(settings, { save: true }));
        }}
      />
    </StrictMode>,
  );
}

readSettings()
  .then((settings) => render(settings))
  .catch(() => {
    // 后端不可达时壳仍要显示可读文案；它说明设置没读到，而不是静默空白。
    console.error(t(DEFAULT_SETTINGS.locale, 'settings.error.load'));
    render(DEFAULT_SETTINGS, { load: true, save: true });
  });
