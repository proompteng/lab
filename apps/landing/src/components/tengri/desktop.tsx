'use client'

import { AnimatePresence, MotionConfig } from 'motion/react'
import type { ComponentType } from 'react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { tengriAuthClient } from '@/lib/tengri/auth-client'
import type { TengriAgent, TengriDesktopSnapshot, TengriUser } from '@/lib/tengri/types'
import { getDesktopSnapshot } from './client'
import { DesktopGate } from './desktop-gates'
import { DesktopWindowFrame } from './desktop-window'
import { Dock } from './dock'
import { MenuBar } from './menu-bar'
import { Spotlight } from './spotlight'
import { APP_TITLES, initialWindowState, type Bounds, type TengriApp, windowReducer } from './window-manager'

export type TengriDesktopApplicationProps = {
  agent: TengriAgent
  app: TengriApp
  onAgentChanged: () => Promise<void>
  onOpenFile: (path: string) => void
  selectedFile: string | null
  user: TengriUser
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
  const [selectedFile, setSelectedFile] = useState<string | null>(null)
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const [clock, setClock] = useState<Date | null>(null)
  const [hydratedLayoutKey, setHydratedLayoutKey] = useState('')
  const refreshInFlight = useRef<Promise<void> | null>(null)

  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current
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

  useEffect(() => {
    void refresh()
  }, [refresh])

  const agent = snapshot?.agents[0] ?? null
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

  const openFile = useCallback(
    (path: string) => {
      setSelectedFile(path)
      openApp('code')
    },
    [openApp],
  )

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const command = event.metaKey
      if (command && event.code === 'Space') {
        event.preventDefault()
        setSpotlightOpen((open) => !open)
        return
      }
      if (event.key === 'Escape' && spotlightOpen) {
        event.preventDefault()
        setSpotlightOpen(false)
        return
      }
      if (document.querySelector('[aria-modal="true"]')) return
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
        dispatch({ type: 'close', id: active.id })
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
  }, [newWindow, spotlightOpen, viewport, windowState.activeApp, windowState.activeWindowId, windowState.windows])

  const activeAgent = agent && snapshot?.user ? agent : null
  return (
    <MotionConfig reducedMotion="user">
      <main className="tengri-desktop relative h-[100dvh] min-h-[560px] w-screen overflow-hidden bg-[#050914] text-white selection:bg-[#78a9ff]/35">
        <div className="tengri-wallpaper absolute inset-0" aria-hidden="true" />
        <MenuBar
          activeApp={windowState.activeApp}
          agent={activeAgent}
          clock={clock}
          menuOpen={menuOpen}
          onMenuChange={setMenuOpen}
          onOpenApp={openApp}
          onNewWindow={() => newWindow(windowState.activeApp)}
          onOpenSpotlight={() => setSpotlightOpen(true)}
          onCloseActive={() =>
            windowState.activeWindowId && dispatch({ type: 'close', id: windowState.activeWindowId })
          }
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
              .then(() => window.location.reload())
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
                  dispatch={dispatch}
                  key={desktopWindow.id}
                  stageRef={stageRef}
                  window={desktopWindow}
                >
                  {snapshot?.user ? (
                    <Application
                      agent={activeAgent}
                      app={desktopWindow.app}
                      onAgentChanged={refresh}
                      onOpenFile={openFile}
                      selectedFile={selectedFile}
                      user={snapshot.user}
                    />
                  ) : null}
                </DesktopWindowFrame>
              ))}
              <Dock activeApp={windowState.activeApp} onOpen={openApp} windows={windowState.windows} />
            </>
          ) : null}
        </div>

        <AnimatePresence>
          {spotlightOpen && activeAgent?.phase === 'ready' ? (
            <Spotlight
              agentId={activeAgent.id}
              onClose={() => setSpotlightOpen(false)}
              onOpenApp={openApp}
              onOpenFile={openFile}
            />
          ) : null}
        </AnimatePresence>

        <DesktopGate agent={agent} error={snapshotError} onRefresh={refresh} snapshot={snapshot} />
      </main>
    </MotionConfig>
  )
}
