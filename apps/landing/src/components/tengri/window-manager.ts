import { MAX_DESKTOP_WINDOWS } from '@/lib/tengri/limits'

export type TengriApp = 'chrome' | 'code' | 'finder' | 'settings' | 'terminal'
export type WindowMode = 'maximized' | 'minimized' | 'normal'

export type Bounds = { x: number; y: number; width: number; height: number }
export type DesktopWindow = {
  id: string
  app: TengriApp
  title: string
  bounds: Bounds
  restoredBounds: Bounds
  mode: WindowMode
  z: number
}

export type WindowManagerState = {
  activeApp: TengriApp
  activeWindowId: string
  nextWindowId: number
  nextZ: number
  windows: DesktopWindow[]
}

export type WindowAction =
  | { type: 'close'; id: string }
  | { type: 'focus'; id: string }
  | { type: 'hydrate'; state: WindowManagerState; viewport: Bounds }
  | { type: 'minimize'; id: string }
  | { type: 'move'; id: string; bounds: Bounds }
  | { type: 'new'; app: TengriApp; title: string; viewport: Bounds }
  | { type: 'open'; app: TengriApp; title: string; viewport: Bounds }
  | { type: 'restore'; id: string }
  | { type: 'toggle-maximize'; id: string; viewport: Bounds }
  | { type: 'viewport'; viewport: Bounds }

export const APP_TITLES: Record<TengriApp, string> = {
  finder: 'Finder',
  chrome: 'Chrome',
  code: 'Code',
  terminal: 'Terminal',
  settings: 'Settings',
}

export function initialWindowState(viewport: Bounds): WindowManagerState {
  const finder = newWindow('finder', APP_TITLES.finder, viewport, 1, 1)
  const chrome = newWindow('chrome', APP_TITLES.chrome, viewport, 2, 2)
  chrome.bounds = offsetBounds(chrome.bounds, 64, 28, viewport)
  chrome.restoredBounds = chrome.bounds
  return {
    activeApp: 'chrome',
    activeWindowId: chrome.id,
    nextWindowId: 3,
    nextZ: 3,
    windows: [finder, chrome],
  }
}

export function windowReducer(state: WindowManagerState, action: WindowAction): WindowManagerState {
  if (action.type === 'hydrate') return sanitizeState(action.state, action.viewport)
  if (action.type === 'open') {
    const existing = [...state.windows].filter((window) => window.app === action.app).sort((a, b) => b.z - a.z)[0]
    if (existing) return focusWindow(state, existing.id, existing.mode === 'minimized')
    return appendWindow(state, action.app, action.title, action.viewport)
  }
  if (action.type === 'new') {
    return appendWindow(state, action.app, action.title, action.viewport)
  }
  if (action.type === 'close') {
    const windows = state.windows.filter((window) => window.id !== action.id)
    return activateFrontmost({ ...state, windows })
  }
  if (action.type === 'focus') return focusWindow(state, action.id)
  if (action.type === 'restore') return focusWindow(state, action.id, true)
  if (action.type === 'minimize') {
    const windows = state.windows.map((window) =>
      window.id === action.id
        ? {
            ...window,
            bounds: window.mode === 'maximized' ? window.restoredBounds : window.bounds,
            mode: 'minimized' as const,
          }
        : window,
    )
    return activateFrontmost({ ...state, windows })
  }
  if (action.type === 'move') {
    return {
      ...state,
      windows: state.windows.map((window) =>
        window.id === action.id
          ? { ...window, bounds: clampBounds(action.bounds), restoredBounds: clampBounds(action.bounds) }
          : window,
      ),
    }
  }
  if (action.type === 'toggle-maximize') {
    const focused = focusWindow(state, action.id)
    return {
      ...focused,
      windows: focused.windows.map((window) => {
        if (window.id !== action.id) return window
        if (window.mode === 'maximized') {
          return { ...window, bounds: window.restoredBounds, mode: 'normal' as const }
        }
        return {
          ...window,
          bounds: {
            x: 8,
            y: 8,
            width: Math.max(320, action.viewport.width - 16),
            height: Math.max(240, action.viewport.height - 16),
          },
          restoredBounds: window.bounds,
          mode: 'maximized' as const,
        }
      }),
    }
  }
  if (action.type === 'viewport') {
    return {
      ...state,
      windows: state.windows.map((window) => ({
        ...window,
        bounds:
          window.mode === 'maximized'
            ? {
                x: 8,
                y: 8,
                width: Math.max(320, action.viewport.width - 16),
                height: Math.max(220, action.viewport.height - 16),
              }
            : clampToViewport(window.bounds, action.viewport),
        restoredBounds: clampToViewport(window.restoredBounds, action.viewport),
      })),
    }
  }
  return state
}

function appendWindow(state: WindowManagerState, app: TengriApp, title: string, viewport: Bounds): WindowManagerState {
  if (state.windows.length >= MAX_DESKTOP_WINDOWS) return state
  const created = newWindow(app, title, viewport, state.nextZ, state.nextWindowId)
  return {
    ...state,
    activeApp: created.app,
    activeWindowId: created.id,
    nextWindowId: state.nextWindowId + 1,
    nextZ: state.nextZ + 1,
    windows: [...state.windows, created],
  }
}

function focusWindow(state: WindowManagerState, id: string, restore = false): WindowManagerState {
  const target = state.windows.find((window) => window.id === id)
  if (!target) return state
  return {
    ...state,
    activeApp: target.app,
    activeWindowId: id,
    nextZ: state.nextZ + 1,
    windows: state.windows.map((window) =>
      window.id === id ? { ...window, mode: restore ? 'normal' : window.mode, z: state.nextZ } : window,
    ),
  }
}

function activateFrontmost(state: WindowManagerState): WindowManagerState {
  const target = [...state.windows]
    .filter((window) => window.mode !== 'minimized')
    .sort((left, right) => right.z - left.z)[0]
  return target
    ? { ...state, activeApp: target.app, activeWindowId: target.id }
    : { ...state, activeApp: 'finder', activeWindowId: '' }
}

function newWindow(app: TengriApp, title: string, viewport: Bounds, z: number, id: number): DesktopWindow {
  const preferred = preferredSize(app)
  const bounds = clampToViewport(
    {
      x: Math.max(12, (viewport.width - preferred.width) / 2 + (z % 4) * 22),
      y: Math.max(12, (viewport.height - preferred.height) / 2 + (z % 3) * 18),
      width: Math.min(preferred.width, viewport.width - 24),
      height: Math.min(preferred.height, viewport.height - 24),
    },
    viewport,
  )
  return { id: `${app}-${id}`, app, title, bounds, restoredBounds: bounds, mode: 'normal', z }
}

function preferredSize(app: TengriApp) {
  if (app === 'settings') return { width: 720, height: 560 }
  if (app === 'terminal') return { width: 900, height: 590 }
  return { width: 1060, height: 700 }
}

export function clampToViewport(bounds: Bounds, viewport: Bounds): Bounds {
  const width = Math.min(Math.max(bounds.width, 320), Math.max(320, viewport.width - 16))
  const height = Math.min(Math.max(bounds.height, 220), Math.max(220, viewport.height - 16))
  return {
    x: Math.min(Math.max(bounds.x, 8 - width + 96), Math.max(8, viewport.width - 96)),
    y: Math.min(Math.max(bounds.y, 8), Math.max(8, viewport.height - 56)),
    width,
    height,
  }
}

function clampBounds(bounds: Bounds): Bounds {
  return { ...bounds, width: Math.max(320, bounds.width), height: Math.max(220, bounds.height) }
}

function offsetBounds(bounds: Bounds, x: number, y: number, viewport: Bounds) {
  return clampToViewport({ ...bounds, x: bounds.x + x, y: bounds.y + y }, viewport)
}

function sanitizeState(state: WindowManagerState, viewport: Bounds): WindowManagerState {
  if (!state || !Array.isArray(state.windows)) return initialWindowState(viewport)
  let generatedId = 1
  const usedIds = new Set<string>()
  const windows = state.windows.slice(0, MAX_DESKTOP_WINDOWS).flatMap((window) => {
    if (!window || !isTengriApp(window.app) || !validBounds(window.bounds) || !validBounds(window.restoredBounds)) {
      return []
    }
    const z = Number.isFinite(window.z) ? Math.min(1_000_000, Math.max(1, Math.trunc(window.z))) : 1
    let id = validWindowId(window.id, window.app) ? window.id : `${window.app}-${generatedId}`
    while (usedIds.has(id)) id = `${window.app}-${++generatedId}`
    usedIds.add(id)
    generatedId += 1
    const mode = isWindowMode(window.mode) ? window.mode : ('normal' as const)
    const restoredBounds = clampToViewport(window.restoredBounds, viewport)
    return [
      {
        app: window.app,
        bounds:
          mode === 'maximized'
            ? {
                x: 8,
                y: 8,
                width: Math.max(320, viewport.width - 16),
                height: Math.max(220, viewport.height - 16),
              }
            : clampToViewport(window.bounds, viewport),
        id,
        mode,
        restoredBounds,
        title: APP_TITLES[window.app],
        z,
      },
    ]
  })
  const frontmost = [...windows]
    .filter((window) => window.mode !== 'minimized')
    .sort((left, right) => right.z - left.z)[0]
  const requested = windows.find((window) => window.id === state.activeWindowId && window.mode !== 'minimized')
  const active = requested || frontmost
  const largestZ = windows.reduce((largest, window) => Math.max(largest, window.z), 0)
  const largestId = windows.reduce((largest, window) => {
    const numericId = Number(window.id.slice(window.id.lastIndexOf('-') + 1))
    return Number.isFinite(numericId) ? Math.max(largest, numericId) : largest
  }, 0)
  return {
    activeApp: active?.app || 'finder',
    activeWindowId: active?.id || '',
    nextWindowId: Math.max(largestId + 1, 1),
    nextZ: largestZ + 1,
    windows,
  }
}

function validWindowId(value: unknown, app: TengriApp) {
  return typeof value === 'string' && new RegExp(`^${app}-[1-9][0-9]{0,5}$`).test(value)
}

function isTengriApp(value: unknown): value is TengriApp {
  return typeof value === 'string' && Object.hasOwn(APP_TITLES, value)
}

function isWindowMode(value: unknown): value is WindowMode {
  return value === 'normal' || value === 'minimized' || value === 'maximized'
}

function validBounds(value: unknown): value is Bounds {
  if (!value || typeof value !== 'object') return false
  const bounds = value as Partial<Bounds>
  return [bounds.x, bounds.y, bounds.width, bounds.height].every((number) => Number.isFinite(number))
}
