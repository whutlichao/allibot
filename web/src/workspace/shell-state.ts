/**
 * The shell's presentation state. It is not a business reading: the target
 * selection names which thread the one chat binds, and the drawer names which
 * secondary face is open. Neither writes a message, wakes a member nor spends
 * response budget (ADR 0002).
 */

/** The secondary faces that open in the drawer / as an independent route. */
export const WORKSPACE_PANELS = [
  'context',
  'task-board',
  'members',
  'roster',
  'agent-detail',
] as const;

export type WorkspacePanel = (typeof WORKSPACE_PANELS)[number];

/** The drawer hosts one panel, or the navigation itself on a narrow screen. */
export type WorkspaceDrawer = WorkspacePanel | 'navigation';

export interface WorkspaceShellState {
  /** The selected target id; null when the reading has no target yet. */
  activeTargetId: string | null;
  /** At most one drawer; the navigation and the panels replace each other. */
  drawer: WorkspaceDrawer | null;
}

/**
 * The one docked sidebar rule: below this width the navigation stops docking
 * and moves into the drawer, so no two docked sidebars can compete for the
 * document layout.
 */
export const NARROW_VIEWPORT_MAX_WIDTH = 900;

export interface WorkspaceLayout {
  /** At most one docked sidebar; the context column is always a drawer. */
  dockedSidebar: 'navigation' | null;
  /** Narrow screens reach the navigation through the always-visible toggle. */
  navigationInDrawer: boolean;
}

export function resolveWorkspaceLayout(viewportWidth: number): WorkspaceLayout {
  if (viewportWidth < NARROW_VIEWPORT_MAX_WIDTH) {
    return { dockedSidebar: null, navigationInDrawer: true };
  }
  return { dockedSidebar: 'navigation', navigationInDrawer: false };
}

export function openWorkspacePanel(
  state: WorkspaceShellState,
  panel: WorkspacePanel,
): WorkspaceShellState {
  return { ...state, drawer: panel };
}

export function openNavigation(state: WorkspaceShellState): WorkspaceShellState {
  return { ...state, drawer: 'navigation' };
}

export function closeDrawer(state: WorkspaceShellState): WorkspaceShellState {
  return { ...state, drawer: null };
}

/**
 * Selecting a target is the only state move that changes the chat's thread
 * identity; it also returns the chat to the front.
 */
export function selectWorkspaceTarget(
  state: WorkspaceShellState,
  targetId: string,
): WorkspaceShellState {
  return { ...state, activeTargetId: targetId, drawer: null };
}
