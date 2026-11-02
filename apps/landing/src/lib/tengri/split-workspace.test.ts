import { describe, expect, test } from 'bun:test'
import { openSplitWorkspace, splitWorkspaceWindowAction, splitWorkspaceWindows } from './split-workspace'
import { initialWindowState, MAX_DESKTOP_WINDOWS, windowReducer } from './window-manager'

const viewport = { x: 0, y: 0, width: 1440, height: 870 }

describe('Chat and work workspace', () => {
  test('opens missing panes with distinct stable IDs and respects desktop capacity atomically', () => {
    const empty = initialWindowState(viewport, [])
    const plan = openSplitWorkspace(empty, 'code', viewport)!
    const opened = plan.actions.reduce(windowReducer, empty)
    expect(opened.windows).toHaveLength(2)
    expect(plan.selection.chatWindowId).not.toBe(plan.selection.workWindowId)
    expect(opened.windows.find((window) => window.id === plan.selection.chatWindowId)?.app).toBe('tengri')
    expect(opened.windows.find((window) => window.id === plan.selection.workWindowId)?.app).toBe('code')
    const full = initialWindowState(
      viewport,
      Array.from({ length: MAX_DESKTOP_WINDOWS - 1 }, () => 'terminal' as const),
    )
    expect(openSplitWorkspace(full, 'code', viewport)).toBeNull()
    expect(full.windows).toHaveLength(MAX_DESKTOP_WINDOWS - 1)
  })

  test('switches work views without replacing windows or their saved desktop geometry', () => {
    let state = initialWindowState(viewport, ['code', 'tengri', 'chrome'])
    const codeId = state.windows[0]!.id
    state = windowReducer(state, { type: 'toggle-maximize', id: codeId, viewport })
    const plan = openSplitWorkspace(state, 'code', viewport)!
    state = plan.actions.reduce(windowReducer, state)
    const before = structuredClone(state)
    const split = splitWorkspaceWindows(state.windows, plan.selection, viewport)!
    expect(split.get(codeId)?.mode).toBe('normal')
    expect(split.get(codeId)?.bounds).not.toEqual(state.windows[0]!.bounds)
    expect(state).toEqual(before)
    const next = openSplitWorkspace(state, 'chrome', viewport)!
    const switched = next.actions.reduce(windowReducer, state)
    expect(switched.windows.map((window) => window.id)).toEqual(state.windows.map((window) => window.id))
    expect(next.selection.chatWindowId).toBe(plan.selection.chatWindowId)
    expect(switched.windows.find((window) => window.id === codeId)).toEqual(before.windows[0])
    expect(splitWorkspaceWindows(state.windows, null, viewport)).toBeNull()
  })

  test('fits both panes with a gap, toolbar room and dock room as the viewport changes', () => {
    const state = initialWindowState(viewport, ['tengri', 'finder'])
    const plan = openSplitWorkspace(state, 'finder', viewport)!
    for (const size of [{ width: 960, height: 640 }, viewport, { width: 3840, height: 2160 }]) {
      const bounds = { x: 0, y: 0, ...size }
      const split = splitWorkspaceWindows(state.windows, plan.selection, bounds)!
      const chat = split.get(plan.selection.chatWindowId)!.bounds
      const work = split.get(plan.selection.workWindowId)!.bounds
      expect(chat.x + chat.width).toBeLessThan(work.x)
      expect(work.x + work.width).toBeLessThanOrEqual(bounds.width)
      expect(chat.y).toBeGreaterThanOrEqual(48)
      expect(chat.y + chat.height).toBeLessThanOrEqual(bounds.height - 96)
      expect(work.height).toBe(chat.height)
    }
    expect(splitWorkspaceWindows(state.windows, plan.selection, { ...viewport, width: 390 })).toBeNull()
    expect(splitWorkspaceWindows(state.windows, plan.selection, { ...viewport, height: 300 })).toBeNull()
    expect(splitWorkspaceWindows(state.windows, plan.selection, null)).toBeNull()
  })

  test('returns to the desktop if either selected pane no longer exists', () => {
    const state = initialWindowState(viewport, ['tengri', 'finder'])
    const plan = openSplitWorkspace(state, 'finder', viewport)!
    const closed = windowReducer(state, { type: 'close', id: plan.selection.workWindowId })
    expect(splitWorkspaceWindows(closed.windows, plan.selection, viewport)).toBeNull()
  })

  test('Fill from a split pane fills the screen for both normal and already maximized saved windows', () => {
    for (const maximized of [false, true]) {
      let state = initialWindowState(viewport, ['tengri', 'code'])
      const id = state.activeWindowId
      const originalBounds = state.windows.find((window) => window.id === id)!.bounds
      if (maximized) state = windowReducer(state, { type: 'toggle-maximize', id, viewport })
      const plan = openSplitWorkspace(state, 'code', viewport)!
      state = plan.actions.reduce(windowReducer, state)
      const action = { type: 'toggle-maximize', id, viewport } as const
      const filled = windowReducer(state, splitWorkspaceWindowAction(state, plan.selection, action))
      expect(filled.windows.find((window) => window.id === id)).toMatchObject({
        mode: 'maximized',
        bounds: viewport,
        restoredBounds: originalBounds,
      })
      const restored = windowReducer(filled, splitWorkspaceWindowAction(filled, null, action))
      expect(restored.windows.find((window) => window.id === id)).toMatchObject({
        mode: 'normal',
        bounds: originalBounds,
      })
    }
  })
})
