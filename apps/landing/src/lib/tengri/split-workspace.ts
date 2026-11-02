import {
  APP_TITLES,
  MAX_DESKTOP_WINDOWS,
  type Bounds,
  type DesktopWindow,
  type WindowAction,
  type WindowManagerState,
  windowIdForOpen,
  windowReducer,
} from './window-manager'

export const WORKSPACE_APPS = { chrome: 'Browser', code: 'Code', finder: 'Files' } as const
export type WorkspaceApp = keyof typeof WORKSPACE_APPS
export type SplitWorkspace = { chatWindowId: string; workWindowId: string }

export function isWorkspaceApp(app: string): app is WorkspaceApp {
  return Object.hasOwn(WORKSPACE_APPS, app)
}

export function openSplitWorkspace(state: WindowManagerState, app: WorkspaceApp, viewport: Bounds) {
  const missing = ['tengri', app].filter((candidate) => !state.windows.some((window) => window.app === candidate))
  if (state.windows.length + missing.length > MAX_DESKTOP_WINDOWS) return null
  const actions: WindowAction[] = [
    { type: 'open', app: 'tengri', title: APP_TITLES.tengri, viewport },
    { type: 'open', app, title: APP_TITLES[app], viewport },
  ]
  const opened = actions.reduce(windowReducer, state)
  return {
    actions,
    selection: {
      chatWindowId: windowIdForOpen(opened, 'tengri'),
      workWindowId: windowIdForOpen(opened, app),
    },
  }
}

export function splitWorkspaceWindowAction(
  state: WindowManagerState,
  selection: SplitWorkspace | null,
  action: WindowAction,
): WindowAction {
  if (
    action.type === 'toggle-maximize' &&
    selection &&
    (selection.chatWindowId === action.id || selection.workWindowId === action.id) &&
    state.windows.some((window) => window.id === action.id && window.mode === 'maximized')
  ) {
    // The pane currently shows a Fill control. Its saved desktop may already fill the screen.
    return { type: 'focus', id: action.id }
  }
  return action
}

// Present the same keyed windows in two panes without overwriting their saved geometry or remounting their apps.
export function splitWorkspaceWindows(
  windows: readonly DesktopWindow[],
  selection: SplitWorkspace | null,
  viewport: Bounds | null,
  top = 48,
): Map<string, DesktopWindow> | null {
  if (!selection || !viewport || viewport.width < 960 || viewport.height < 440) return null
  const chat = windows.find((window) => window.id === selection.chatWindowId && window.app === 'tengri')
  const work = windows.find((window) => window.id === selection.workWindowId && isWorkspaceApp(window.app))
  if (!chat || !work) return null
  const availableWidth = viewport.width - 36
  const chatWidth = Math.min(520, Math.round(availableWidth * 0.4))
  const height = Math.max(0, viewport.height - top - 96)
  return new Map([
    [chat.id, { ...chat, mode: 'normal', bounds: { x: 12, y: top, width: chatWidth, height } }],
    [
      work.id,
      {
        ...work,
        mode: 'normal',
        bounds: { x: chatWidth + 24, y: top, width: availableWidth - chatWidth, height },
      },
    ],
  ])
}
