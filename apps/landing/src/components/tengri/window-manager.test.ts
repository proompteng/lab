import { describe, expect, test } from 'bun:test'
import { initialWindowState, MAX_DESKTOP_WINDOWS, windowReducer } from './window-manager'

const viewport = { x: 0, y: 0, width: 1440, height: 870 }

describe('Tengri window manager', () => {
  test('boots with Finder behind frontmost Chrome', () => {
    const state = initialWindowState(viewport)
    expect(state.windows.map((window) => window.app)).toEqual(['finder', 'chrome'])
    expect(state.activeApp).toBe('chrome')
  })

  test('open focuses an existing app while new creates an independent window', () => {
    let state = initialWindowState(viewport)
    state = windowReducer(state, { type: 'open', app: 'terminal', title: 'Terminal', viewport })
    const firstId = state.activeWindowId
    state = windowReducer(state, { type: 'new', app: 'terminal', title: 'Terminal', viewport })
    const secondId = state.activeWindowId
    expect(firstId).not.toBe(secondId)
    expect(state.windows.filter((window) => window.app === 'terminal')).toHaveLength(2)

    state = windowReducer(state, { type: 'minimize', id: secondId })
    state = windowReducer(state, { type: 'open', app: 'terminal', title: 'Terminal', viewport })
    expect(state.activeWindowId).toBe(secondId)
    expect(state.windows.find((window) => window.id === secondId)?.mode).toBe('normal')
    expect(state.activeApp).toBe('terminal')
  })

  test('does not trust persisted titles, ids, modes, or unbounded window counts', () => {
    const base = initialWindowState(viewport)
    const hostile = {
      ...base,
      activeWindowId: 'hostile',
      nextWindowId: Number.MAX_VALUE,
      nextZ: Number.MAX_VALUE,
      windows: Array.from({ length: 30 }, (_, index) => ({
        ...base.windows[0]!,
        id: index < 2 ? 'hostile' : `finder-${index}`,
        title: '<script>',
        mode: 'unknown',
        z: Number.MAX_VALUE,
      })),
    }
    const state = windowReducer(base, { type: 'hydrate', state: hostile as typeof base, viewport })
    expect(state.windows).toHaveLength(20)
    expect(new Set(state.windows.map((window) => window.id)).size).toBe(20)
    expect(state.windows.every((window) => window.title === 'Finder')).toBe(true)
    expect(state.windows.every((window) => window.mode === 'normal')).toBe(true)
    expect(state.nextWindowId).toBeLessThan(1_000_000)
    expect(state.nextZ).toBe(1_000_001)
  })

  test('clamps windows when the viewport shrinks', () => {
    const state = windowReducer(initialWindowState(viewport), {
      type: 'viewport',
      viewport: { x: 0, y: 0, width: 720, height: 500 },
    })
    expect(state.windows.every((window) => window.bounds.width <= 704)).toBe(true)
    expect(state.windows.every((window) => window.bounds.height <= 484)).toBe(true)
  })

  test('clamps persisted windows before the first restored frame', () => {
    const base = initialWindowState(viewport)
    const persisted = {
      ...base,
      windows: base.windows.map((window) => ({
        ...window,
        bounds: { x: 50_000, y: 50_000, width: 4_000, height: 3_000 },
        restoredBounds: { x: 50_000, y: 50_000, width: 4_000, height: 3_000 },
      })),
    }
    const compact = { x: 0, y: 0, width: 720, height: 500 }
    const state = windowReducer(base, { type: 'hydrate', state: persisted, viewport: compact })
    expect(state.windows.every((window) => window.bounds.width <= 704)).toBe(true)
    expect(state.windows.every((window) => window.bounds.height <= 484)).toBe(true)
    expect(state.windows.every((window) => window.bounds.x <= 624)).toBe(true)
    expect(state.windows.every((window) => window.bounds.y <= 444)).toBe(true)
  })

  test('returns focus to Finder when every window is closed', () => {
    let state = initialWindowState(viewport)
    for (const window of state.windows) state = windowReducer(state, { type: 'close', id: window.id })
    expect(state.windows).toHaveLength(0)
    expect(state.activeApp).toBe('finder')
    expect(state.activeWindowId).toBe('')
  })

  test('hydrates an intentionally empty desktop with Finder as the frontmost application', () => {
    const empty = {
      ...initialWindowState(viewport),
      activeApp: 'chrome' as const,
      activeWindowId: '',
      windows: [],
    }
    const state = windowReducer(empty, { type: 'hydrate', state: empty, viewport })

    expect(state.windows).toEqual([])
    expect(state.activeApp).toBe('finder')
    expect(state.activeWindowId).toBe('')
  })

  test('restores original bounds after minimizing a maximized window', () => {
    let state = initialWindowState(viewport)
    const id = state.activeWindowId
    const original = state.windows.find((window) => window.id === id)?.bounds
    state = windowReducer(state, { type: 'toggle-maximize', id, viewport })
    state = windowReducer(state, { type: 'minimize', id })
    state = windowReducer(state, { type: 'restore', id })

    expect(state.windows.find((window) => window.id === id)).toMatchObject({ bounds: original, mode: 'normal' })
  })

  test('enforces the persisted window cap while creating windows', () => {
    let state = initialWindowState(viewport)
    for (let index = 0; index < MAX_DESKTOP_WINDOWS + 5; index += 1) {
      state = windowReducer(state, { type: 'new', app: 'terminal', title: 'Terminal', viewport })
    }

    expect(state.windows).toHaveLength(MAX_DESKTOP_WINDOWS)
    expect(state.windows.some((window) => window.id === state.activeWindowId)).toBe(true)
    expect(state.nextWindowId).toBe(MAX_DESKTOP_WINDOWS + 1)
  })
})
