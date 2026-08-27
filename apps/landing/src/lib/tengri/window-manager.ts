export type TengriApp = 'chrome' | 'code' | 'finder' | 'settings' | 'terminal'
export type WindowMode = 'maximized' | 'minimized' | 'normal'
export type ResizeEdge = 'e' | 'n' | 'ne' | 'nw' | 's' | 'se' | 'sw' | 'w'

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
  | { type: 'restore'; id: string; viewport: Bounds }
  | { type: 'toggle-maximize'; id: string; viewport: Bounds }
  | { type: 'viewport'; viewport: Bounds }

export const MAX_DESKTOP_WINDOWS = 20
const MAX_WINDOW_ID = 999_999
const MIN_WINDOW_HEIGHT = 220
const MIN_WINDOW_WIDTH = 320
const MIN_VISIBLE_HEIGHT = 56
const MIN_VISIBLE_WIDTH = 96
const WINDOW_INSET = 8

export const APP_TITLES: Record<TengriApp, string> = {
  finder: 'Finder',
  chrome: 'Chrome',
  code: 'Code',
  terminal: 'Terminal',
  settings: 'Settings',
}

export function initialWindowState(
  viewport: Bounds,
  initialApps: readonly TengriApp[] = ['finder', 'chrome'],
): WindowManagerState {
  const apps = initialApps.slice(0, MAX_DESKTOP_WINDOWS)
  const windows = apps.map((app, index) => {
    const created = newWindow(app, APP_TITLES[app], viewport, index + 1, index + 1)
    if (index === 0) return created
    created.bounds = offsetBounds(created.bounds, index * 42 + 22, index * 16 + 12, viewport)
    created.restoredBounds = created.bounds
    return created
  })
  const active = windows.at(-1)
  return {
    activeApp: active?.app || 'finder',
    activeWindowId: active?.id || '',
    nextWindowId: windows.length + 1,
    nextZ: windows.length + 1,
    windows,
  }
}

export function windowIdForOpen(state: WindowManagerState, app: TengriApp): string {
  const existing = [...state.windows].filter((window) => window.app === app).sort((left, right) => right.z - left.z)[0]
  if (existing) return existing.id
  return `${app}-${nextAvailableWindowId(state.windows, state.nextWindowId)}`
}

export function windowReducer(state: WindowManagerState, action: WindowAction): WindowManagerState {
  if (action.type === 'hydrate') return sanitizeState(action.state, action.viewport)
  if (action.type === 'open') {
    const targetId = windowIdForOpen(state, action.app)
    const existing = state.windows.find((window) => window.id === targetId)
    if (existing) return focusWindow(state, existing.id, existing.mode === 'minimized', action.viewport)
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
  if (action.type === 'restore') return focusWindow(state, action.id, true, action.viewport)
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
        window.id === action.id && validBounds(action.bounds)
          ? {
              ...window,
              bounds: nonNegativeBounds(action.bounds),
              restoredBounds: nonNegativeBounds(action.bounds),
            }
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
          const restoredBounds = clampToViewport(window.restoredBounds, action.viewport)
          return { ...window, bounds: restoredBounds, restoredBounds, mode: 'normal' as const }
        }
        return {
          ...window,
          bounds: maximizedBounds(action.viewport),
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
            ? maximizedBounds(action.viewport)
            : clampToViewport(window.bounds, action.viewport),
        restoredBounds:
          window.mode === 'normal' ? clampToViewport(window.restoredBounds, action.viewport) : window.restoredBounds,
      })),
    }
  }
  return state
}

function appendWindow(state: WindowManagerState, app: TengriApp, title: string, viewport: Bounds): WindowManagerState {
  if (state.windows.length >= MAX_DESKTOP_WINDOWS) return state
  const id = nextAvailableWindowId(state.windows, state.nextWindowId)
  const created = newWindow(app, title, viewport, state.nextZ, id)
  const windows = [...state.windows, created]
  return {
    ...state,
    activeApp: created.app,
    activeWindowId: created.id,
    nextWindowId: nextAvailableWindowId(windows, incrementWindowId(id)),
    nextZ: state.nextZ + 1,
    windows,
  }
}

function focusWindow(state: WindowManagerState, id: string, restore = false, viewport?: Bounds): WindowManagerState {
  const target = state.windows.find((window) => window.id === id)
  if (!target) return state
  const restoredBounds = restore && viewport ? clampToViewport(target.restoredBounds, viewport) : target.bounds
  return {
    ...state,
    activeApp: target.app,
    activeWindowId: id,
    nextZ: state.nextZ + 1,
    windows: state.windows.map((window) => {
      if (window.id !== id) return window
      return restore
        ? { ...window, bounds: restoredBounds, restoredBounds, mode: 'normal' as const, z: state.nextZ }
        : { ...window, z: state.nextZ }
    }),
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

function maximizedBounds(viewport: Bounds): Bounds {
  const horizontal = viewportAxis(viewport.width, MIN_WINDOW_WIDTH)
  const vertical = viewportAxis(viewport.height, MIN_WINDOW_HEIGHT)
  return {
    x: horizontal.inset,
    y: vertical.inset,
    width: horizontal.available,
    height: vertical.available,
  }
}

export function clampToViewport(bounds: Bounds, viewport: Bounds): Bounds {
  const horizontal = viewportAxis(viewport.width, MIN_WINDOW_WIDTH)
  const vertical = viewportAxis(viewport.height, MIN_WINDOW_HEIGHT)
  const width = clamp(bounds.width, Math.min(MIN_WINDOW_WIDTH, horizontal.available), horizontal.available)
  const height = clamp(bounds.height, Math.min(MIN_WINDOW_HEIGHT, vertical.available), vertical.available)
  return {
    x:
      width === horizontal.available
        ? horizontal.inset
        : clamp(
            bounds.x,
            horizontal.inset - width + Math.min(MIN_VISIBLE_WIDTH, width),
            Math.max(horizontal.inset, horizontal.size - horizontal.inset - Math.min(MIN_VISIBLE_WIDTH, width)),
          ),
    y:
      height === vertical.available
        ? vertical.inset
        : clamp(
            bounds.y,
            vertical.inset,
            Math.max(vertical.inset, vertical.size - vertical.inset - Math.min(MIN_VISIBLE_HEIGHT, height)),
          ),
    width,
    height,
  }
}

export function resizeBounds(base: Bounds, edge: ResizeEdge, dx: number, dy: number, viewport: Bounds): Bounds {
  const next = { ...base }
  if (edge.includes('w')) {
    const horizontal = resizeAxis(base.x, base.width, dx, true, viewport.width, MIN_WINDOW_WIDTH, MIN_VISIBLE_WIDTH)
    next.x = horizontal.start
    next.width = horizontal.size
  } else if (edge.includes('e')) {
    const horizontal = resizeAxis(base.x, base.width, dx, false, viewport.width, MIN_WINDOW_WIDTH, MIN_VISIBLE_WIDTH)
    next.x = horizontal.start
    next.width = horizontal.size
  }
  if (edge.includes('n')) {
    const vertical = resizeAxis(base.y, base.height, dy, true, viewport.height, MIN_WINDOW_HEIGHT, MIN_VISIBLE_HEIGHT)
    next.y = vertical.start
    next.height = vertical.size
  } else if (edge.includes('s')) {
    const vertical = resizeAxis(base.y, base.height, dy, false, viewport.height, MIN_WINDOW_HEIGHT, MIN_VISIBLE_HEIGHT)
    next.y = vertical.start
    next.height = vertical.size
  }
  return next
}

function offsetBounds(bounds: Bounds, x: number, y: number, viewport: Bounds) {
  return clampToViewport({ ...bounds, x: bounds.x + x, y: bounds.y + y }, viewport)
}

function resizeAxis(
  start: number,
  size: number,
  delta: number,
  fromStart: boolean,
  viewportSize: number,
  minimumSize: number,
  minimumVisible: number,
) {
  const viewport = viewportAxis(viewportSize, minimumSize)
  const anchor = fromStart ? start + size : start
  const visibleBoundary = fromStart
    ? viewport.size - viewport.inset - Math.min(minimumVisible, viewport.available)
    : viewport.inset + Math.min(minimumVisible, viewport.available)
  const visibleMinimum = fromStart ? anchor - visibleBoundary : visibleBoundary - anchor
  const minimum = Math.min(viewport.available, Math.max(Math.min(minimumSize, viewport.available), visibleMinimum))
  const distanceToBoundary = fromStart ? anchor - viewport.inset : viewport.size - viewport.inset - anchor
  const maximum = Math.max(minimum, Math.min(viewport.available, Math.max(0, distanceToBoundary)))
  const nextSize = clamp(fromStart ? size - delta : size + delta, minimum, maximum)
  return { start: fromStart ? anchor - nextSize : anchor, size: nextSize }
}

function viewportAxis(viewportSize: number, minimumSize: number) {
  const size = Math.max(0, viewportSize)
  const inset = Math.min(WINDOW_INSET, Math.max(0, (size - minimumSize) / 2))
  return { available: Math.max(0, size - inset * 2), inset, size }
}

function clamp(value: number, minimum: number, maximum: number) {
  return Math.min(Math.max(value, minimum), maximum)
}

function nonNegativeBounds(bounds: Bounds): Bounds {
  return { ...bounds, width: Math.max(0, bounds.width), height: Math.max(0, bounds.height) }
}

function sanitizeState(state: WindowManagerState, viewport: Bounds): WindowManagerState {
  if (!state || !Array.isArray(state.windows)) return initialWindowState(viewport)
  let generatedId = 1
  const usedIds = new Set<string>()
  const persistedWindows = state.windows.slice(0, MAX_DESKTOP_WINDOWS)
  const reservedIds = new Set(
    persistedWindows.flatMap((window) =>
      window &&
      isTengriApp(window.app) &&
      validBounds(window.bounds) &&
      validBounds(window.restoredBounds) &&
      validWindowId(window.id, window.app)
        ? [window.id]
        : [],
    ),
  )
  const windows = persistedWindows.flatMap((window) => {
    if (!window || !isTengriApp(window.app) || !validBounds(window.bounds) || !validBounds(window.restoredBounds)) {
      return []
    }
    const z = Number.isFinite(window.z) ? Math.min(1_000_000, Math.max(1, Math.trunc(window.z))) : 1
    let id = window.id
    if (!validWindowId(id, window.app) || usedIds.has(id)) {
      do {
        id = `${window.app}-${generatedId++}`
      } while (usedIds.has(id) || reservedIds.has(id))
    }
    usedIds.add(id)
    const mode = isWindowMode(window.mode) ? window.mode : ('normal' as const)
    const restoredBounds =
      mode === 'normal' ? clampToViewport(window.restoredBounds, viewport) : nonNegativeBounds(window.restoredBounds)
    return [
      {
        app: window.app,
        bounds: mode === 'maximized' ? maximizedBounds(viewport) : clampToViewport(window.bounds, viewport),
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
    nextWindowId: nextAvailableWindowId(windows, incrementWindowId(largestId)),
    nextZ: largestZ + 1,
    windows,
  }
}

function nextAvailableWindowId(windows: DesktopWindow[], requested: number) {
  const usedIds = new Set(
    windows.map((window) => Number(window.id.slice(window.id.lastIndexOf('-') + 1))).filter(Number.isInteger),
  )
  let candidate = normalizeWindowId(requested)
  for (let attempt = 0; attempt <= usedIds.size; attempt += 1) {
    if (!usedIds.has(candidate)) return candidate
    candidate = incrementWindowId(candidate)
  }
  return candidate
}

function normalizeWindowId(value: number) {
  if (!Number.isFinite(value)) return 1
  return ((((Math.trunc(value) - 1) % MAX_WINDOW_ID) + MAX_WINDOW_ID) % MAX_WINDOW_ID) + 1
}

function incrementWindowId(value: number) {
  return normalizeWindowId(value + 1)
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
