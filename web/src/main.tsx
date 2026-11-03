import {
  t,
  type WorkspaceSettingsView,
  type WorkspaceView,
} from '@allibot/shared';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import './styles/index.css';
import { App } from './App.ts';
import {
  allNavEntries,
  buildWorkspaceNav,
  initialTargetId,
} from './workspace/model.ts';
import { shouldRefreshWorkspace } from './workspace/message-sync.ts';

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

/** The shell's whole state: one workspace reading, one selected target. */
let currentWorkspace: WorkspaceView | null = null;
let currentSettings: WorkspaceSettingsView = DEFAULT_SETTINGS;
let currentTargetId: string | null = null;
let currentViewportWidth = window.innerWidth;
let refreshGeneration = 0;

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

function render(saveFailed = false): void {
  root.render(
    <StrictMode>
      <App
        settings={currentSettings}
        workspace={currentWorkspace ?? undefined}
        activeTargetId={currentTargetId}
        viewportWidth={currentViewportWidth}
        saveFailed={saveFailed}
        onSelectTarget={(targetId) => {
          currentTargetId = targetId;
          render();
        }}
        onSettingsChange={(patch) => {
          // 后端是正本：先读返回值，再重渲染。
          writeSettings(patch)
            .then((saved) => {
              currentSettings = saved;
              if (currentWorkspace !== null) {
                currentWorkspace = { ...currentWorkspace, settings: saved };
              }
              render();
            })
            .catch(() => render(true));
        }}
        onLiveEvent={(event) => {
          if (shouldRefreshWorkspace(event.event)) {
            void refreshWorkspace().catch((error: unknown) => {
              console.error('workspace refresh failed', error);
            });
          }
        }}
      />
    </StrictMode>,
  );
}

/**
 * Re-read the one workspace reading (D1.9): SSE frames carry facts, not the
 * reading itself, so unread / task / status changes re-fetch the snapshot
 * instead of growing a local count.
 */
async function refreshWorkspace(): Promise<void> {
  const generation = ++refreshGeneration;
  const response = await fetch('/api/workspace');
  if (!response.ok) {
    throw new Error(`GET /api/workspace failed with ${response.status}`);
  }
  const reading = (await response.json()) as WorkspaceView;
  if (generation !== refreshGeneration) {
    return;
  }

  currentWorkspace = reading;
  currentSettings = reading.settings;
  const targets = new Set(allNavEntries(buildWorkspaceNav(reading)).map((entry) => entry.targetId));
  if (currentTargetId === null || !targets.has(currentTargetId)) {
    currentTargetId = initialTargetId(reading);
  }
  render();
}

window.addEventListener('resize', () => {
  currentViewportWidth = window.innerWidth;
  render();
});

refreshWorkspace().catch(() => {
  // 后端不可达时壳仍显示可读文案；它说明读数没读到，而不是静默空白。
  console.error(t(DEFAULT_SETTINGS.locale, 'settings.error.load'));
  render(true);
});
