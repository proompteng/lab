import { describe, expect, test } from 'bun:test'
import { createElement, createRef } from 'react'
import { renderToString } from 'react-dom/server'

import { DesktopWindowFrame } from '@/components/tengri/desktop-window'
import { initialWindowState, MAX_DESKTOP_WINDOWS, resizeBounds, windowReducer } from './window-manager'

const viewport = { x: 0, y: 0, width: 1440, height: 870 }

describe('Tengri desktop window manager', () => {
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

  test('reserves valid persisted ids before replacing malformed ids', () => {
    const base = initialWindowState(viewport)
    const malformedBounds = { x: 40, y: 40, width: 400, height: 300 }
    const validBounds = { x: 240, y: 120, width: 500, height: 400 }
    const persisted = {
      ...base,
      activeWindowId: 'finder-1',
      windows: [
        {
          ...base.windows[0]!,
          id: 'bad',
          bounds: malformedBounds,
          restoredBounds: malformedBounds,
        },
        {
          ...base.windows[0]!,
          id: 'finder-1',
          bounds: validBounds,
          restoredBounds: validBounds,
          z: 10,
        },
      ],
    }

    const state = windowReducer(base, { type: 'hydrate', state: persisted, viewport })
    expect(state.activeWindowId).toBe('finder-1')
    expect(state.windows.find((window) => window.id === 'finder-1')?.bounds).toEqual(validBounds)
    expect(state.windows[0]?.id).not.toBe('finder-1')
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
    state = windowReducer(state, { type: 'restore', id, viewport })

    expect(state.windows.find((window) => window.id === id)).toMatchObject({ bounds: original, mode: 'normal' })
  })

  test('preserves restore bounds across temporary compact viewports while maximized', () => {
    let state = initialWindowState(viewport)
    const id = state.activeWindowId
    const original = state.windows.find((window) => window.id === id)!.bounds
    state = windowReducer(state, { type: 'toggle-maximize', id, viewport })
    state = windowReducer(state, { type: 'viewport', viewport: { x: 0, y: 0, width: 300, height: 200 } })
    state = windowReducer(state, { type: 'viewport', viewport })
    state = windowReducer(state, { type: 'toggle-maximize', id, viewport })

    expect(state.windows.find((window) => window.id === id)).toMatchObject({
      bounds: original,
      restoredBounds: original,
      mode: 'normal',
    })

    let hydrated = initialWindowState(viewport)
    const hydratedId = hydrated.activeWindowId
    const hydratedOriginal = hydrated.windows.find((window) => window.id === hydratedId)!.bounds
    hydrated = windowReducer(hydrated, { type: 'toggle-maximize', id: hydratedId, viewport })
    hydrated = windowReducer(hydrated, {
      type: 'hydrate',
      state: hydrated,
      viewport: { x: 0, y: 0, width: 300, height: 200 },
    })
    hydrated = windowReducer(hydrated, { type: 'viewport', viewport })
    hydrated = windowReducer(hydrated, { type: 'toggle-maximize', id: hydratedId, viewport })
    expect(hydrated.windows.find((window) => window.id === hydratedId)?.bounds).toEqual(hydratedOriginal)
  })

  test('keeps maximized windows inside compact viewports', () => {
    const compact = { x: 0, y: 0, width: 320, height: 240 }
    let state = initialWindowState(viewport)
    const id = state.activeWindowId

    state = windowReducer(state, { type: 'toggle-maximize', id, viewport: compact })
    expectInsideViewport(state.windows.find((window) => window.id === id)!.bounds, compact)

    const smaller = { x: 0, y: 0, width: 300, height: 200 }
    state = windowReducer(state, { type: 'viewport', viewport: smaller })
    expectInsideViewport(state.windows.find((window) => window.id === id)!.bounds, smaller)

    state = windowReducer(state, { type: 'hydrate', state, viewport: compact })
    expectInsideViewport(state.windows.find((window) => window.id === id)!.bounds, compact)
  })

  test('fits normal windows inside compact viewports', () => {
    const compact = { x: 0, y: 0, width: 300, height: 200 }
    const initial = initialWindowState(compact)
    expect(initial.windows.every((window) => isInsideViewport(window.bounds, compact))).toBe(true)

    const resized = windowReducer(initialWindowState(viewport), { type: 'viewport', viewport: compact })
    expect(resized.windows.every((window) => isInsideViewport(window.bounds, compact))).toBe(true)

    const hydrated = windowReducer(initial, {
      type: 'hydrate',
      state: initialWindowState(viewport),
      viewport: compact,
    })
    expect(hydrated.windows.every((window) => isInsideViewport(window.bounds, compact))).toBe(true)

    const id = initial.activeWindowId
    const moved = windowReducer(initial, {
      type: 'move',
      id,
      bounds: { x: 0, y: 0, width: compact.width, height: compact.height },
    })
    expect(moved.windows.find((window) => window.id === id)?.bounds).toEqual({
      x: 0,
      y: 0,
      width: compact.width,
      height: compact.height,
    })
  })

  test('preserves the opposite edge while clamping resizes', () => {
    const base = { x: 100, y: 100, width: 400, height: 400 }
    const north = resizeBounds(base, 'n', 0, -200, viewport)
    expect(north.y).toBe(8)
    expect(north.y + north.height).toBe(base.y + base.height)

    const west = resizeBounds(base, 'w', -200, 0, viewport)
    expect(west.x).toBe(8)
    expect(west.x + west.width).toBe(base.x + base.width)

    const east = resizeBounds(base, 'e', 2_000, 0, viewport)
    expect(east.x).toBe(base.x)
    expect(east.x + east.width).toBe(viewport.width - 8)

    const leftEdge = { ...base, x: -896, width: 1_000 }
    const reachableEast = resizeBounds(leftEdge, 'e', -100, 0, viewport)
    expect(reachableEast.x + reachableEast.width).toBe(104)

    const rightEdge = { ...base, x: 1_336, width: 1_000 }
    const reachableWest = resizeBounds(rightEdge, 'w', 100, 0, viewport)
    expect(reachableWest.x).toBe(1_336)
  })

  test('server-renders a minimized frame without browser globals', () => {
    const minimized = { ...initialWindowState(viewport).windows[0]!, mode: 'minimized' as const }
    const frame = createElement(DesktopWindowFrame, {
      active: false,
      children: createElement('div'),
      dispatch: () => undefined,
      stageRef: createRef<HTMLDivElement>(),
      window: minimized,
    })

    expect(() => renderToString(frame)).not.toThrow()
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

function expectInsideViewport(
  bounds: { x: number; y: number; width: number; height: number },
  target: typeof viewport,
) {
  expect(bounds.x).toBeGreaterThanOrEqual(0)
  expect(bounds.y).toBeGreaterThanOrEqual(0)
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(target.width)
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(target.height)
}

function isInsideViewport(bounds: { x: number; y: number; width: number; height: number }, target: typeof viewport) {
  return (
    bounds.x >= 0 &&
    bounds.y >= 0 &&
    bounds.x + bounds.width <= target.width &&
    bounds.y + bounds.height <= target.height
  )
}
