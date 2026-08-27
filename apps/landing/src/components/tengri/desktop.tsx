'use client'

import { AnimatePresence, MotionConfig } from 'motion/react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { tengriAuthClient } from '@/lib/tengri/auth-client'
import { MAX_DESKTOP_WINDOWS } from '@/lib/tengri/limits'
import type { TengriAgent, TengriDesktopSnapshot, TengriUser } from '@/lib/tengri/types'
import { getDesktopSnapshot } from './client'
import { DesktopGate, resolveDesktopGate } from './desktop-gates'
import { DesktopWindowFrame } from './desktop-window'
import { Dock } from './dock'
import { MenuBar } from './menu-bar'
import { Spotlight } from './spotlight'
import { APP_TITLES, initialWindowState, type Bounds, type TengriApp, windowReducer } from './window-manager'

export type TengriDesktopApplicationProps = {
  active: boolean
  agent: TengriAgent
  app: TengriApp
  hasUnsavedChanges: boolean
  onAgentChanged: () => Promise<void>
  onDirtyChange: (dirty: boolean) => void
  onOpenFile: (path: string) => void
  previewGatewayOrigin: string
  registerWindowCloseHandler: (windowId: string, handler: (() => void) | null) => void
  selectedDirectory: DesktopPathRequest | null
  selectedFile: DesktopPathRequest | null
  user: TengriUser
  windowId: string
}

export type DesktopPathRequest = {
  path: string
  requestId: number
}

type TargetedDesktopPathRequest = {
  request: DesktopPathRequest
  windowId: string
}

export default function TengriDesktop({ Application }: { Application: ComponentType<TengriDesktopApplicationProps> }) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const mounted = useRef(true)
  const [snapshot, setSnapshot] = useState<TengriDesktopSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState('')
  const [windowState, dispatch] = useReducer(
    windowReducer,
    { x: 0, y: 0, width: 1280, height: 760 },
    initialWindowState,
  )
  const [selectedDirectory, setSelectedDirectory] = useState<TargetedDesktopPathRequest | null>(null)
  const [selectedFile, setSelectedFile] = useState<TargetedDesktopPathRequest | null>(null)
  const pathRequestId = useRef(0)
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [desktopNotice, setDesktopNotice] = useState('')
  const [dirtyWindowIds, setDirtyWindowIds] = useState<Set<string>>(() => new Set())
  const [clock, setClock] = useState<Date | null>(null)
  const [hydratedLayoutKey, setHydratedLayoutKey] = useState('')
  const refreshInFlight = useRef<Promise<void> | null>(null)
  const windowCloseHandlers = useRef(new Map<string, () => void>())
  const dirtyChangeHandlers = useRef(new Map<string, (dirty: boolean) => void>())

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(async (afterCurrent = false) => {
    const current = refreshInFlight.current
    if (current) {
      if (!afterCurrent) return current
      await current
    }
    const request = getDesktopSnapshot()
      .then((next) => {
        if (!mounted.current) return
        setSnapshot(next)
        setSnapshotError('')
      })
      .catch((cause: unknown) => {
        if (!mounted.current) return
        setSnapshotError(cause instanceof Error ? cause.message : 'Tengri could not be reached')
      })
      .finally(() => {
        if (refreshInFlight.current === request) refreshInFlight.current = null
      })
    refreshInFlight.current = request
    return request
  }, [])
  const refreshAfterMutation = useCallback(() => refresh(true), [refresh])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const agent = snapshot?.agents[0] ?? null
  const activeAgent = agent && snapshot?.user ? agent : null
  const desktopReady = resolveDesktopGate(snapshot, agent, snapshotError).kind === 'ready'
  const pollingDelay = agent && ['booting', 'pending', 'terminating'].includes(agent.phase) ? 2_000 : 10_000

  useEffect(() => {
    const timer = window.setInterval(() => void refresh(), pollingDelay)
    return () => window.clearInterval(timer)
  }, [pollingDelay, refresh])

  useEffect(() => {
    setClock(new Date())
    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  const layoutKey = snapshot?.user && agent ? `tengri:desktop:${snapshot.user.id}:${agent.id}` : ''
  useEffect(() => {
    if (!layoutKey || layoutKey === hydratedLayoutKey) return
    const stage = stageRef.current?.getBoundingClientRect()
    const viewport = { x: 0, y: 0, width: stage?.width || innerWidth, height: stage?.height || innerHeight - 30 }
    try {
      const saved = localStorage.getItem(layoutKey)
      dispatch({ type: 'hydrate', state: saved ? JSON.parse(saved) : initialWindowState(viewport), viewport })
    } catch {
      dispatch({ type: 'hydrate', state: initialWindowState(viewport), viewport })
    }
    setHydratedLayoutKey(layoutKey)
  }, [hydratedLayoutKey, layoutKey])

  useEffect(() => {
    if (!layoutKey || hydratedLayoutKey !== layoutKey) return
    try {
      localStorage.setItem(layoutKey, JSON.stringify(windowState))
    } catch {
      // The desktop remains usable when private browsing or storage quotas disable persistence.
    }
  }, [hydratedLayoutKey, layoutKey, windowState])

  const viewport = useCallback((): Bounds => {
    const rect = stageRef.current?.getBoundingClientRect()
    return { x: 0, y: 0, width: rect?.width || innerWidth, height: rect?.height || innerHeight - 30 }
  }, [])

  useEffect(() => {
    let frame = 0
    const clampWindows = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => dispatch({ type: 'viewport', viewport: viewport() }))
    }
    window.addEventListener('resize', clampWindows)
    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('resize', clampWindows)
    }
  }, [viewport])

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('[role="menubar"]')) setMenuOpen(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  const openApp = useCallback(
    (app: TengriApp) => {
      dispatch({ type: 'open', app, title: APP_TITLES[app], viewport: viewport() })
      setSpotlightOpen(false)
      setMenuOpen(null)
    },
    [viewport],
  )

  const newWindow = useCallback(
    (app: TengriApp) => {
      dispatch({ type: 'new', app, title: APP_TITLES[app], viewport: viewport() })
      setSpotlightOpen(false)
      setMenuOpen(null)
    },
    [viewport],
  )

  const requestCloseWindow = useCallback(
    (id: string) => {
      if (dirtyWindowIds.has(id)) {
        setDesktopNotice('Save or close the pending Code tabs before closing this window.')
        return
      }
      const closeHandler = windowCloseHandlers.current.get(id)
      windowCloseHandlers.current.delete(id)
      dirtyChangeHandlers.current.delete(id)
      setSelectedDirectory((current) => (current?.windowId === id ? null : current))
      setSelectedFile((current) => (current?.windowId === id ? null : current))
      closeHandler?.()
      dispatch({ type: 'close', id })
    },
    [dirtyWindowIds],
  )

  const registerWindowCloseHandler = useCallback((windowId: string, handler: (() => void) | null) => {
    if (handler) windowCloseHandlers.current.set(windowId, handler)
    else windowCloseHandlers.current.delete(windowId)
  }, [])

  const dirtyChangeHandlerFor = useCallback((windowId: string) => {
    const current = dirtyChangeHandlers.current.get(windowId)
    if (current) return current
    const handler = (dirty: boolean) => {
      setDirtyWindowIds((windowIds) => {
        if (windowIds.has(windowId) === dirty) return windowIds
        const next = new Set(windowIds)
        if (dirty) next.add(windowId)
        else next.delete(windowId)
        return next
      })
    }
    dirtyChangeHandlers.current.set(windowId, handler)
    return handler
  }, [])

  const openFile = useCallback(
    (path: string) => {
      const codeWindow = [...windowState.windows]
        .filter((desktopWindow) => desktopWindow.app === 'code')
        .sort((left, right) => right.z - left.z)[0]
      if (!codeWindow && windowState.windows.length >= MAX_DESKTOP_WINDOWS) {
        setDesktopNotice('Close a window before opening this file in Code.')
        setSpotlightOpen(false)
        setMenuOpen(null)
        return
      }
      pathRequestId.current += 1
      setDesktopNotice('')
      setSelectedFile({
        request: { path, requestId: pathRequestId.current },
        windowId: codeWindow?.id ?? `code-${windowState.nextWindowId}`,
      })
      openApp('code')
    },
    [openApp, windowState.nextWindowId, windowState.windows],
  )

  const openDirectory = useCallback(
    (path: string) => {
      const finderWindow = [...windowState.windows]
        .filter((desktopWindow) => desktopWindow.app === 'finder')
        .sort((left, right) => right.z - left.z)[0]
      if (!finderWindow && windowState.windows.length >= MAX_DESKTOP_WINDOWS) {
        setDesktopNotice('Close a window before opening this folder in Finder.')
        setSpotlightOpen(false)
        setMenuOpen(null)
        return
      }
      pathRequestId.current += 1
      setDesktopNotice('')
      setSelectedDirectory({
        request: { path, requestId: pathRequestId.current },
        windowId: finderWindow?.id ?? `finder-${windowState.nextWindowId}`,
      })
      openApp('finder')
    },
    [openApp, windowState.nextWindowId, windowState.windows],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey
      if (command && event.code === 'Space' && spotlightOpen) {
        event.preventDefault()
        setSpotlightOpen(false)
        return
      }
      if (event.key === 'Escape' && spotlightOpen) {
        event.preventDefault()
        setSpotlightOpen(false)
        return
      }
      if (document.querySelector('[aria-modal="true"]') || !desktopReady) return
      if (command && event.code === 'Space') {
        event.preventDefault()
        setSpotlightOpen(true)
        return
      }
      if (command && event.key === 'Tab') {
        event.preventDefault()
        const frontmostByApp = new Map<TengriApp, (typeof windowState.windows)[number]>()
        for (const candidate of [...windowState.windows].sort((left, right) => right.z - left.z)) {
          if (!frontmostByApp.has(candidate.app)) frontmostByApp.set(candidate.app, candidate)
        }
        const running = [...frontmostByApp.values()]
        if (running.length < 2) return
        const current = running.findIndex((candidate) => candidate.app === windowState.activeApp)
        const next = running[(current + (event.shiftKey ? -1 : 1) + running.length) % running.length]
        if (next) dispatch({ type: 'restore', id: next.id })
        return
      }
      const active = windowState.windows.find((candidate) => candidate.id === windowState.activeWindowId)
      if (!active || !command) return
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        requestCloseWindow(active.id)
      } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault()
        dispatch({ type: 'minimize', id: active.id })
      } else if (event.key.toLowerCase() === 'f' && event.ctrlKey) {
        event.preventDefault()
        dispatch({ type: 'toggle-maximize', id: active.id, viewport: viewport() })
      } else if (event.key.toLowerCase() === 'o') {
        event.preventDefault()
        setSpotlightOpen(true)
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault()
        newWindow(active.app)
      } else if (event.key === '`') {
        event.preventDefault()
        const siblings = [...windowState.windows]
          .filter((candidate) => candidate.app === active.app)
          .sort((left, right) => right.z - left.z)
        const current = siblings.findIndex((candidate) => candidate.id === active.id)
        const next = siblings[(current + 1) % siblings.length]
        if (next) dispatch({ type: 'restore', id: next.id })
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [
    desktopReady,
    newWindow,
    requestCloseWindow,
    spotlightOpen,
    viewport,
    windowState.activeApp,
    windowState.activeWindowId,
    windowState.windows,
  ])

  return (
    <MotionConfig reducedMotion="user">
      <main className="tengri-desktop relative h-[100dvh] min-h-[560px] w-screen overflow-hidden bg-[#050914] text-white selection:bg-[#78a9ff]/35">
        <div className="tengri-wallpaper absolute inset-0" aria-hidden="true" />
        <div
          className="absolute inset-0"
          aria-hidden={!desktopReady || spotlightOpen || undefined}
          inert={!desktopReady || spotlightOpen || undefined}
        >
          <MenuBar
            activeApp={windowState.activeApp}
            agent={activeAgent}
            clock={clock}
            menuOpen={menuOpen}
            onMenuChange={setMenuOpen}
            onOpenApp={openApp}
            onNewWindow={() => newWindow(windowState.activeApp)}
            onOpenSpotlight={() => setSpotlightOpen(true)}
            onCloseActive={() => windowState.activeWindowId && requestCloseWindow(windowState.activeWindowId)}
            onMinimizeActive={() =>
              windowState.activeWindowId && dispatch({ type: 'minimize', id: windowState.activeWindowId })
            }
            onToggleMaximize={() =>
              windowState.activeWindowId &&
              dispatch({ type: 'toggle-maximize', id: windowState.activeWindowId, viewport: viewport() })
            }
            onSignOut={() => {
              void tengriAuthClient
                .signOut()
                .then((result) => {
                  if (result.error) throw new Error(result.error.message || 'Tengri could not sign out')
                  window.location.reload()
                })
                .catch((cause: unknown) =>
                  setSnapshotError(cause instanceof Error ? cause.message : 'Tengri could not sign out'),
                )
            }}
            userName={snapshot?.user?.name || ''}
          />
          <div ref={stageRef} className="absolute inset-x-0 top-[30px] bottom-0 overflow-hidden">
            {activeAgent && activeAgent.phase === 'ready' ? (
              <>
                {windowState.windows.map((desktopWindow) => (
                  <DesktopWindowFrame
                    active={desktopWindow.id === windowState.activeWindowId}
                    dispatch={(action) => {
                      if (action.type === 'close') requestCloseWindow(action.id)
                      else dispatch(action)
                    }}
                    key={desktopWindow.id}
                    stageRef={stageRef}
                    window={desktopWindow}
                  >
                    {snapshot?.user ? (
                      <Application
                        active={desktopWindow.id === windowState.activeWindowId && desktopWindow.mode !== 'minimized'}
                        agent={activeAgent}
                        app={desktopWindow.app}
                        hasUnsavedChanges={dirtyWindowIds.size > 0}
                        key={`${activeAgent.id}:${desktopWindow.id}`}
                        onAgentChanged={refreshAfterMutation}
                        onDirtyChange={dirtyChangeHandlerFor(desktopWindow.id)}
                        onOpenFile={openFile}
                        previewGatewayOrigin={snapshot.previewGatewayOrigin}
                        registerWindowCloseHandler={registerWindowCloseHandler}
                        selectedDirectory={
                          selectedDirectory?.windowId === desktopWindow.id ? selectedDirectory.request : null
                        }
                        selectedFile={selectedFile?.windowId === desktopWindow.id ? selectedFile.request : null}
                        user={snapshot.user}
                        windowId={desktopWindow.id}
                      />
                    ) : null}
                  </DesktopWindowFrame>
                ))}
                <Dock activeApp={windowState.activeApp} onOpen={openApp} windows={windowState.windows} />
              </>
            ) : null}
          </div>
        </div>

        <AnimatePresence>
          {spotlightOpen && activeAgent?.phase === 'ready' ? (
            <Spotlight
              agentId={activeAgent.id}
              onClose={() => setSpotlightOpen(false)}
              onNewApp={newWindow}
              onOpenApp={openApp}
              onOpenDirectory={openDirectory}
              onOpenFile={openFile}
            />
          ) : null}
        </AnimatePresence>

        <DesktopGate agent={agent} error={snapshotError} onRefresh={refreshAfterMutation} snapshot={snapshot} />
        {desktopNotice ? (
          <div
            role="status"
            className="fixed right-5 bottom-5 z-[8000] flex max-w-sm items-center gap-3 rounded-xl border border-amber-200/20 bg-[#231d12]/95 px-4 py-3 text-xs text-amber-100 shadow-2xl"
          >
            <span>{desktopNotice}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="shrink-0 rounded-lg px-2 py-1 text-amber-50/70 hover:bg-white/8 hover:text-amber-50"
              onClick={() => setDesktopNotice('')}
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </main>
    </MotionConfig>
  )
}
