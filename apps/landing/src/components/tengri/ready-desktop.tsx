'use client'

import { FileCode2, Folder, LoaderCircle, LogOut, Moon, Settings, SquareTerminal, Trash2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react'

import { tengriAuthClient } from '@/lib/tengri/auth-client'
import type { TengriAgent, TengriUser } from '@/lib/tengri/types'
import { cn } from '@/lib/utils'
import {
  APP_TITLES,
  initialWindowState,
  MAX_DESKTOP_WINDOWS,
  type Bounds,
  type DesktopWindow,
  type TengriApp,
  windowIdForOpen,
  windowReducer,
} from '@/lib/tengri/window-manager'
import { ChromeApp } from './chrome-app'
import {
  beginTengriLifecycleTransition,
  getTengriGuestOperationSnapshot,
  hasActiveTengriGuestOperations,
  runTengriAction,
  subscribeTengriGuestOperations,
} from './client'
import { CodeEditor } from './code-editor'
import { type CodeOpenRequest, updateDirtyCodeWindows } from './code-editor-model'
import { ConfirmationDialog } from './confirmation-dialog'
import { DesktopWindowFrame } from './desktop-window'
import { FinderApp, type FinderOpenRequest } from './finder-app'
import { MenuBar } from './menu-bar'
import { SettingsApp } from './settings-app'
import { commitDesktopLifecycleAction, selectSleepRequestError } from './settings-model'
import { Spotlight } from './spotlight'
import { TerminalApp } from './terminal-app'

type TargetedCodeOpenRequest = CodeOpenRequest & { targetWindowId: string }
type TargetedFinderOpenRequest = FinderOpenRequest & { targetWindowId: string }
type CommittedTransition = 'delete' | 'sign-out' | 'sleep'
type DesktopIdentity = { agentId: string; id: string }
type DesktopIdentityLease = {
  identity: Promise<string>
  references: number
  release: () => void
  releaseTimer: ReturnType<typeof setTimeout> | null
}

const getServerGuestOperationSnapshot = () => false
const DESKTOP_ID_PATTERN = /^[0-9a-f]{32}$/
const desktopIdentityLeases = new Map<string, DesktopIdentityLease>()

function newDesktopId() {
  return crypto.randomUUID().replaceAll('-', '')
}

function createDesktopIdentityLease(agentId: string): DesktopIdentityLease {
  let released = false
  let resolveIdentity = (_id: string) => undefined
  const identity = new Promise<string>((resolve) => {
    resolveIdentity = resolve
  })
  const lease: DesktopIdentityLease = {
    identity,
    references: 0,
    release: () => undefined,
    releaseTimer: null,
  }
  let handlePageHide = () => undefined
  const storageKey = `tengri:desktop:${agentId}`
  let storedId = ''
  try {
    const candidate = sessionStorage.getItem(storageKey) ?? ''
    if (DESKTOP_ID_PATTERN.test(candidate)) storedId = candidate
  } catch {
    // A random identity still isolates this tab when session storage is unavailable.
  }

  const commitIdentity = (id: string) => {
    if (released) return
    try {
      sessionStorage.setItem(storageKey, id)
    } catch {
      // Terminal identity remains valid for this document without persistence.
    }
    resolveIdentity(id)
  }

  const claimIdentity = (candidate: string) => {
    if (!navigator.locks) {
      commitIdentity(newDesktopId())
      return
    }
    void navigator.locks
      .request(`tengri-desktop:${agentId}:${candidate}`, { ifAvailable: true }, async (lock) => {
        if (released) return
        if (!lock) {
          claimIdentity(newDesktopId())
          return
        }
        commitIdentity(candidate)
        await lockReleased
      })
      .catch(() => commitIdentity(newDesktopId()))
  }

  const lockReleased = new Promise<void>((resolve) => {
    lease.release = () => {
      if (released) return
      released = true
      globalThis.removeEventListener('pagehide', handlePageHide)
      if (desktopIdentityLeases.get(agentId) === lease) desktopIdentityLeases.delete(agentId)
      resolve()
    }
  })
  handlePageHide = () => lease.release()
  globalThis.addEventListener('pagehide', handlePageHide, { once: true })
  claimIdentity(storedId || newDesktopId())
  return lease
}

function useDesktopIdentity(agentId: string) {
  const [identity, setIdentity] = useState<DesktopIdentity | null>(null)

  useEffect(() => {
    let disposed = false
    const lease = desktopIdentityLeases.get(agentId) ?? createDesktopIdentityLease(agentId)
    desktopIdentityLeases.set(agentId, lease)
    lease.references += 1
    if (lease.releaseTimer !== null) {
      clearTimeout(lease.releaseTimer)
      lease.releaseTimer = null
    }
    void lease.identity.then((id) => {
      if (!disposed) setIdentity({ agentId, id })
    })

    return () => {
      disposed = true
      lease.references = Math.max(0, lease.references - 1)
      if (lease.references > 0) return
      lease.releaseTimer = setTimeout(() => {
        lease.releaseTimer = null
        if (lease.references === 0) lease.release()
      }, 0)
    }
  }, [agentId])

  return identity?.agentId === agentId ? identity.id : null
}

export function ReadyDesktop({
  agent,
  connectionWarning = '',
  onChanged,
  previewGatewayOrigin,
  user,
}: {
  agent: TengriAgent
  connectionWarning?: string
  onChanged: () => Promise<void>
  previewGatewayOrigin: string
  user: TengriUser
}) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [windowState, dispatch] = useReducer(windowReducer, { x: 0, y: 0, width: 1_280, height: 760 }, (viewport) =>
    initialWindowState(viewport, ['finder', 'chrome']),
  )
  const [clock, setClock] = useState<Date | null>(null)
  const [busyAction, setBusyAction] = useState<'delete' | 'sign-out' | 'sleep' | null>(null)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [codeRequest, setCodeRequest] = useState<TargetedCodeOpenRequest | null>(null)
  const [finderRequest, setFinderRequest] = useState<TargetedFinderOpenRequest | null>(null)
  const [dirtyCodeWindows, setDirtyCodeWindows] = useState<Set<string>>(() => new Set())
  const [committedTransition, setCommittedTransition] = useState<CommittedTransition | null>(null)
  const [spotlightOpen, setSpotlightOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState<string | null>(null)
  const desktopId = useDesktopIdentity(agent.id)
  const codeRequestIdRef = useRef(0)
  const finderRequestIdRef = useRef(0)
  const lifecycleTransitionReleaseRef = useRef<(() => void) | null>(null)
  const terminalCloseHandlersRef = useRef(new Map<string, () => void>())
  const reducedMotion = useReducedMotion()

  const subscribeGuestOperations = useCallback(
    (listener: () => void) => subscribeTengriGuestOperations(agent.id, listener),
    [agent.id],
  )
  const getGuestOperationSnapshot = useCallback(() => getTengriGuestOperationSnapshot(agent.id), [agent.id])
  const guestOperationActive = useSyncExternalStore(
    subscribeGuestOperations,
    getGuestOperationSnapshot,
    getServerGuestOperationSnapshot,
  )

  const viewport = useCallback((): Bounds => {
    const rect = stageRef.current?.getBoundingClientRect()
    return {
      x: 0,
      y: 0,
      width: rect?.width ?? globalThis.innerWidth,
      height: rect?.height ?? Math.max(0, globalThis.innerHeight - 30),
    }
  }, [])

  const requireWindowCapacity = useCallback(
    (requiresNewWindow: boolean) => {
      if (!requiresNewWindow || windowState.windows.length < MAX_DESKTOP_WINDOWS) return true
      setError(`Tengri supports at most ${MAX_DESKTOP_WINDOWS} open windows. Close one before opening another.`)
      return false
    },
    [windowState.windows.length],
  )

  const appendDesktopWindow = useCallback(
    (app: TengriApp) => {
      if (!requireWindowCapacity(true)) return false
      dispatch({ type: 'new', app, title: APP_TITLES[app], viewport: viewport() })
      return true
    },
    [requireWindowCapacity, viewport],
  )

  const openDesktopApp = useCallback(
    (app: TengriApp) => {
      const alreadyOpen = windowState.windows.some((candidate) => candidate.app === app)
      if (!requireWindowCapacity(!alreadyOpen)) return false
      dispatch({ type: 'open', app, title: APP_TITLES[app], viewport: viewport() })
      return true
    },
    [requireWindowCapacity, viewport, windowState.windows],
  )

  const registerTerminalCloseHandler = useCallback((windowId: string, handler: () => void) => {
    terminalCloseHandlersRef.current.set(windowId, handler)
    return () => {
      if (terminalCloseHandlersRef.current.get(windowId) === handler) {
        terminalCloseHandlersRef.current.delete(windowId)
      }
    }
  }, [])

  useLayoutEffect(() => {
    const measuredViewport = viewport()
    dispatch({
      type: 'hydrate',
      state: initialWindowState(measuredViewport, ['finder', 'chrome']),
      viewport: measuredViewport,
    })
  }, [viewport])

  useEffect(
    () => () => {
      lifecycleTransitionReleaseRef.current?.()
      lifecycleTransitionReleaseRef.current = null
    },
    [agent.id],
  )

  const closeWindow = useCallback(
    (desktopWindow: Pick<DesktopWindow, 'app' | 'id'>) => {
      if (desktopWindow.app === 'code' && dirtyCodeWindows.has(desktopWindow.id)) {
        setError('Save or close every edited Code tab before closing the Code window.')
        dispatch({ type: 'focus', id: desktopWindow.id })
        return
      }
      if (desktopWindow.app === 'terminal') terminalCloseHandlersRef.current.get(desktopWindow.id)?.()
      dispatch({ type: 'close', id: desktopWindow.id })
    },
    [dirtyCodeWindows],
  )

  const handleCodeDirtyChange = useCallback((windowId: string, dirty: boolean) => {
    setDirtyCodeWindows((current) => updateDirtyCodeWindows(current, windowId, dirty))
  }, [])

  useEffect(() => {
    if (dirtyCodeWindows.size === 0) {
      setError((current) => (current.startsWith('Save or close every edited Code tab') ? '' : current))
    }
  }, [dirtyCodeWindows])

  useEffect(() => {
    setClock(new Date())
    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    let frame = 0
    const clampWindows = () => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(() => dispatch({ type: 'viewport', viewport: viewport() }))
    }
    clampWindows()
    window.addEventListener('resize', clampWindows)
    return () => {
      window.cancelAnimationFrame(frame)
      window.removeEventListener('resize', clampWindows)
    }
  }, [viewport])

  useEffect(() => {
    if (!committedTransition) return
    let stopped = false
    let timer = 0
    const refreshUntilObserved = async () => {
      try {
        await onChanged()
      } catch {
        if (!stopped) setError('The request was accepted, but the latest controller state is temporarily unavailable.')
      } finally {
        if (!stopped) timer = window.setTimeout(() => void refreshUntilObserved(), 1_000)
      }
    }
    timer = window.setTimeout(() => void refreshUntilObserved(), 1_000)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [committedTransition, onChanged])

  useEffect(() => {
    if (!menuOpen) return
    const closeOutside = (event: PointerEvent) => {
      const target = event.target instanceof Element ? event.target : null
      if (!target?.closest('[role="menubar"]')) setMenuOpen(null)
    }
    document.addEventListener('pointerdown', closeOutside)
    return () => document.removeEventListener('pointerdown', closeOutside)
  }, [menuOpen])

  const handleShortcut = useEffectEvent((event: KeyboardEvent) => {
    const command = event.metaKey
    if (command && event.code === 'Space') {
      event.preventDefault()
      setMenuOpen(null)
      if (spotlightOpen) setSpotlightOpen(false)
      else if (!document.querySelector('[data-tengri-modal="true"]')) setSpotlightOpen(true)
      return
    }
    if (event.key === 'Escape' && spotlightOpen) {
      event.preventDefault()
      setSpotlightOpen(false)
      return
    }
    if (document.querySelector('[data-tengri-modal="true"]')) return
    if (!command || event.defaultPrevented) return
    const active = windowState.windows.find((candidate) => candidate.id === windowState.activeWindowId)
    if (event.code === 'KeyO') {
      event.preventDefault()
      setSpotlightOpen(true)
      return
    }
    if (event.code === 'KeyN') {
      event.preventDefault()
      const app = active?.app ?? windowState.activeApp
      appendDesktopWindow(app)
      return
    }
    if (isEditableTarget(event.target)) return
    if (event.key === 'Tab') {
      event.preventDefault()
      const frontmostByApp = new Map<TengriApp, DesktopWindow>()
      for (const candidate of [...windowState.windows].sort((left, right) => right.z - left.z)) {
        if (!frontmostByApp.has(candidate.app)) frontmostByApp.set(candidate.app, candidate)
      }
      const running = [...frontmostByApp.values()]
      if (running.length < 2) return
      const current = running.findIndex((candidate) => candidate.app === windowState.activeApp)
      const next = running[(current + (event.shiftKey ? -1 : 1) + running.length) % running.length]
      if (next) dispatch({ type: 'restore', id: next.id, viewport: viewport() })
      return
    }
    if (!active) return
    if (event.code === 'KeyW') {
      event.preventDefault()
      closeWindow(active)
    } else if (event.code === 'KeyM') {
      event.preventDefault()
      dispatch({ type: 'minimize', id: active.id })
    } else if (event.ctrlKey && event.code === 'KeyF') {
      event.preventDefault()
      dispatch({ type: 'toggle-maximize', id: active.id, viewport: viewport() })
    } else if (event.code === 'Backquote') {
      event.preventDefault()
      const siblings = [...windowState.windows]
        .filter((candidate) => candidate.app === active.app)
        .sort((left, right) => right.z - left.z)
      const current = siblings.findIndex((candidate) => candidate.id === active.id)
      const next = siblings[(current + 1) % siblings.length]
      if (next) dispatch({ type: 'restore', id: next.id, viewport: viewport() })
    }
  })

  useEffect(() => {
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [])

  const openSettings = useCallback(() => void openDesktopApp('settings'), [openDesktopApp])

  const openChrome = useCallback(() => void openDesktopApp('chrome'), [openDesktopApp])

  const openFinder = useCallback(
    (path?: string) => {
      const targetWindowId = windowIdForOpen(windowState, 'finder')
      if (!openDesktopApp('finder')) return
      if (path) setFinderRequest({ path, requestId: ++finderRequestIdRef.current, targetWindowId })
    },
    [openDesktopApp, windowState],
  )

  const openCode = useCallback(
    (path?: string) => {
      const targetWindowId = windowIdForOpen(windowState, 'code')
      if (!openDesktopApp('code')) return
      if (path) setCodeRequest({ path, requestId: ++codeRequestIdRef.current, targetWindowId })
    },
    [openDesktopApp, windowState],
  )

  const openTerminal = useCallback(() => void openDesktopApp('terminal'), [openDesktopApp])

  const newAppWindow = useCallback(
    (app: TengriApp) => {
      appendDesktopWindow(app)
      setMenuOpen(null)
      setSpotlightOpen(false)
    },
    [appendDesktopWindow],
  )

  const openApp = useCallback(
    (app: TengriApp) => {
      if (app === 'chrome') openChrome()
      else if (app === 'finder') openFinder()
      else if (app === 'code') openCode()
      else if (app === 'terminal') openTerminal()
      else openSettings()
      setMenuOpen(null)
      setSpotlightOpen(false)
    },
    [openChrome, openCode, openFinder, openSettings, openTerminal],
  )

  const newActiveWindow = useCallback(() => {
    const active = windowState.windows.find((candidate) => candidate.id === windowState.activeWindowId)
    const app = active?.app ?? windowState.activeApp
    appendDesktopWindow(app)
    setMenuOpen(null)
  }, [appendDesktopWindow, windowState.activeApp, windowState.activeWindowId, windowState.windows])

  async function mutate(action: 'delete-agent' | 'sleep-agent') {
    if (lifecycleTransitionReleaseRef.current) return
    if (hasActiveTengriGuestOperations(agent.id)) {
      setError('Wait for the current guest request to finish before changing the agent lifecycle.')
      return
    }
    if (dirtyCodeWindows.size > 0) {
      setError('Save or close every edited Code tab before changing the agent lifecycle.')
      return
    }
    const releaseLifecycleTransition = beginTengriLifecycleTransition(agent.id)
    lifecycleTransitionReleaseRef.current = releaseLifecycleTransition
    setBusyAction(action === 'delete-agent' ? 'delete' : 'sleep')
    setError('')
    let committed = false
    try {
      await commitDesktopLifecycleAction({
        action,
        request: () => runTengriAction<TengriAgent | null>({ action, agentId: agent.id }),
        onCommitted: (committedAction) => {
          committed = true
          setCommittedTransition(committedAction === 'sleep-agent' ? 'sleep' : 'delete')
          if (committedAction === 'delete-agent') setConfirmOpen(false)
        },
      })
      if (action === 'delete-agent') await onChanged()
    } catch (cause) {
      setError(
        committed
          ? 'The lifecycle request was accepted, but the latest controller state could not be loaded.'
          : cause instanceof Error
            ? cause.message
            : 'The agent lifecycle request failed',
      )
    } finally {
      if (!committed) {
        releaseLifecycleTransition()
        if (lifecycleTransitionReleaseRef.current === releaseLifecycleTransition) {
          lifecycleTransitionReleaseRef.current = null
        }
      }
      setBusyAction(null)
    }
  }

  async function signOut() {
    if (lifecycleTransitionReleaseRef.current) return
    if (hasActiveTengriGuestOperations(agent.id)) {
      setError('Wait for the current guest request to finish before signing out.')
      return
    }
    if (dirtyCodeWindows.size > 0) {
      setError('Save or close every edited Code tab before signing out.')
      return
    }
    const releaseLifecycleTransition = beginTengriLifecycleTransition(agent.id)
    lifecycleTransitionReleaseRef.current = releaseLifecycleTransition
    setBusyAction('sign-out')
    setError('')
    let committed = false
    try {
      const result = await tengriAuthClient.signOut()
      if (result.error) throw new Error(result.error.message || 'Tengri could not sign out')
      committed = true
      setCommittedTransition('sign-out')
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tengri could not sign out')
    } finally {
      if (!committed) {
        releaseLifecycleTransition()
        if (lifecycleTransitionReleaseRef.current === releaseLifecycleTransition) {
          lifecycleTransitionReleaseRef.current = null
        }
      }
      setBusyAction(null)
    }
  }

  const chromeRunning = windowState.windows.some((candidate) => candidate.app === 'chrome')
  const codeRunning = windowState.windows.some((candidate) => candidate.app === 'code')
  const finderRunning = windowState.windows.some((candidate) => candidate.app === 'finder')
  const settingsRunning = windowState.windows.some((candidate) => candidate.app === 'settings')
  const terminalRunning = windowState.windows.some((candidate) => candidate.app === 'terminal')
  const activeWindow = windowState.windows.find((candidate) => candidate.id === windowState.activeWindowId)
  const activeApp = activeWindow?.app ?? windowState.activeApp

  if (committedTransition) {
    return (
      <LifecycleTransitionScreen
        agentName={agent.displayName}
        error={selectSleepRequestError(error, connectionWarning)}
        transition={committedTransition}
      />
    )
  }

  return (
    <>
      <main
        aria-hidden={confirmOpen || spotlightOpen || undefined}
        inert={confirmOpen || spotlightOpen || undefined}
        className="font-inter relative h-[100dvh] min-h-[520px] w-screen overflow-hidden bg-[#050914] text-white selection:bg-[#78a9ff]/35"
      >
        <DesktopWallpaper />
        <MenuBar
          activeApp={activeApp}
          agent={agent}
          clock={clock}
          connectionWarning={connectionWarning}
          menuOpen={menuOpen}
          onCloseActive={() => activeWindow && closeWindow(activeWindow)}
          onMenuChange={setMenuOpen}
          onMinimizeActive={() => activeWindow && dispatch({ type: 'minimize', id: activeWindow.id })}
          onNewWindow={newActiveWindow}
          onOpenApp={openApp}
          onOpenSpotlight={() => {
            setMenuOpen(null)
            setSpotlightOpen(true)
          }}
          onSignOut={() => void signOut()}
          onToggleMaximize={() =>
            activeWindow && dispatch({ type: 'toggle-maximize', id: activeWindow.id, viewport: viewport() })
          }
          userName={user.name}
        />

        <div ref={stageRef} className="absolute inset-x-0 top-[30px] bottom-0 overflow-hidden">
          {connectionWarning ? (
            <p
              role="status"
              className="absolute top-3 left-1/2 z-[1000] max-w-[min(36rem,calc(100%-2rem))] -translate-x-1/2 truncate rounded-full border border-amber-200/16 bg-amber-950/55 px-4 py-1.5 text-xs text-amber-100 shadow-lg backdrop-blur-xl"
              title={connectionWarning}
            >
              Connection interrupted. Using the last confirmed agent state.
            </p>
          ) : null}
          {error && activeWindow?.app !== 'settings' ? (
            <p
              role="alert"
              className="absolute top-3 left-1/2 z-[1001] max-w-[min(42rem,calc(100%-2rem))] -translate-x-1/2 truncate rounded-full border border-red-200/16 bg-red-950/65 px-4 py-1.5 text-xs text-red-100 shadow-lg backdrop-blur-xl"
              title={error}
            >
              {error}
            </p>
          ) : null}
          {windowState.windows.map((desktopWindow) => (
            <DesktopWindowFrame
              active={desktopWindow.id === windowState.activeWindowId}
              dispatch={dispatch}
              key={desktopWindow.id}
              onCloseRequest={() => closeWindow(desktopWindow)}
              stageRef={stageRef}
              window={desktopWindow}
            >
              {desktopWindow.app === 'finder' ? (
                <FinderApp
                  active={desktopWindow.id === windowState.activeWindowId}
                  agentId={agent.id}
                  onOpenFile={openCode}
                  request={finderRequest?.targetWindowId === desktopWindow.id ? finderRequest : null}
                />
              ) : desktopWindow.app === 'chrome' ? (
                <ChromeApp
                  active={desktopWindow.id === windowState.activeWindowId}
                  agentId={agent.id}
                  previewGatewayOrigin={previewGatewayOrigin}
                />
              ) : desktopWindow.app === 'code' ? (
                <CodeEditor
                  agentId={agent.id}
                  onDirtyChange={(dirty) => handleCodeDirtyChange(desktopWindow.id, dirty)}
                  request={codeRequest?.targetWindowId === desktopWindow.id ? codeRequest : null}
                />
              ) : desktopWindow.app === 'terminal' ? (
                desktopId ? (
                  <TerminalApp
                    agentId={agent.id}
                    desktopId={desktopId}
                    registerCloseHandler={registerTerminalCloseHandler}
                    windowId={desktopWindow.id}
                  />
                ) : (
                  <div className="flex h-full items-center justify-center gap-2 text-sm text-zinc-300" role="status">
                    <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
                    Preparing Terminal…
                  </div>
                )
              ) : (
                <SettingsApp
                  active={desktopWindow.id === windowState.activeWindowId}
                  agent={agent}
                  busyAction={busyAction}
                  error={error}
                  instanceId={desktopWindow.id}
                  lifecycleDisabled={guestOperationActive}
                  onDelete={() => {
                    setError('')
                    setConfirmOpen(true)
                  }}
                  onSignOut={() => void signOut()}
                  onSleep={() => void mutate('sleep-agent')}
                  user={user}
                />
              )}
            </DesktopWindowFrame>
          ))}

          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-[1500] flex justify-center">
            <nav
              aria-label="Dock"
              className="pointer-events-auto flex h-[72px] items-end gap-2 rounded-[24px] border border-white/20 bg-[rgba(28,33,45,0.5)] px-3 pb-2 shadow-[0_20px_60px_rgba(0,0,0,0.42),inset_0_1px_0_rgba(255,255,255,0.2)] backdrop-blur-3xl"
            >
              <motion.button
                type="button"
                aria-label="Open Finder"
                className="group relative flex flex-col items-center outline-none"
                onClick={() => openFinder()}
                whileHover={reducedMotion ? undefined : dockHoverAnimation}
                whileTap={reducedMotion ? undefined : dockTapAnimation}
                transition={dockTransition}
              >
                <DockTooltip label="Finder" />
                <span className="grid h-12 w-12 place-items-center rounded-[13px] border border-white/20 bg-gradient-to-br from-[#69b8ff] to-[#1266ce] shadow-[0_9px_22px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.35)]">
                  <Folder aria-hidden="true" className="h-7 w-7 fill-white/18 text-white" />
                </span>
                <DockIndicator running={finderRunning} />
              </motion.button>
              <motion.button
                type="button"
                aria-label="Open Chrome"
                className="group relative flex flex-col items-center outline-none"
                onClick={openChrome}
                whileHover={reducedMotion ? undefined : dockHoverAnimation}
                whileTap={reducedMotion ? undefined : dockTapAnimation}
                transition={dockTransition}
              >
                <DockTooltip label="Chrome" />
                <ChromeDockIcon />
                <DockIndicator running={chromeRunning} />
              </motion.button>
              <motion.button
                type="button"
                aria-label="Open Code"
                className="group relative flex flex-col items-center outline-none"
                onClick={() => openCode()}
                whileHover={reducedMotion ? undefined : dockHoverAnimation}
                whileTap={reducedMotion ? undefined : dockTapAnimation}
                transition={dockTransition}
              >
                <DockTooltip label="Code" />
                <span className="grid h-12 w-12 place-items-center rounded-[13px] border border-white/20 bg-gradient-to-br from-[#5f6fff] via-[#775dd8] to-[#312d7d] shadow-[0_9px_22px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.35)]">
                  <FileCode2 aria-hidden="true" className="h-7 w-7 text-white" />
                </span>
                <DockIndicator running={codeRunning} />
              </motion.button>
              <motion.button
                type="button"
                aria-label="Open Terminal"
                className="group relative flex flex-col items-center outline-none"
                onClick={openTerminal}
                whileHover={reducedMotion ? undefined : dockHoverAnimation}
                whileTap={reducedMotion ? undefined : dockTapAnimation}
                transition={dockTransition}
              >
                <DockTooltip label="Terminal" />
                <span className="grid h-12 w-12 place-items-center rounded-[13px] border border-white/20 bg-gradient-to-br from-[#323844] to-[#11141a] shadow-[0_9px_22px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.22)]">
                  <SquareTerminal aria-hidden="true" className="h-7 w-7 text-white" />
                </span>
                <DockIndicator running={terminalRunning} />
              </motion.button>
              <motion.button
                type="button"
                aria-label="Open Settings"
                className="group relative flex flex-col items-center outline-none"
                onClick={openSettings}
                whileHover={reducedMotion ? undefined : dockHoverAnimation}
                whileTap={reducedMotion ? undefined : dockTapAnimation}
                transition={dockTransition}
              >
                <DockTooltip label="Settings" />
                <span className="grid h-12 w-12 place-items-center rounded-[13px] border border-white/20 bg-gradient-to-br from-[#aeb8c8] to-[#596273] shadow-[0_9px_22px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.35)]">
                  <Settings aria-hidden="true" className="h-7 w-7 text-white" />
                </span>
                <DockIndicator running={settingsRunning} />
              </motion.button>
            </nav>
          </div>
        </div>
      </main>

      <AnimatePresence>
        {spotlightOpen ? (
          <Spotlight
            agentId={agent.id}
            onClose={() => setSpotlightOpen(false)}
            onNewApp={newAppWindow}
            onOpenApp={openApp}
            onOpenDirectory={openFinder}
            onOpenFile={(path) => openCode(path)}
          />
        ) : null}
      </AnimatePresence>

      <ConfirmationDialog
        busy={busyAction === 'delete'}
        description="This permanently removes the microVM and its persistent workspace, including files and Codex state. This cannot be undone."
        error={error}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void mutate('delete-agent')}
        open={confirmOpen}
        title={`Delete “${agent.displayName}”?`}
      />
    </>
  )
}

function LifecycleTransitionScreen({
  agentName,
  error,
  transition,
}: {
  agentName: string
  error: string
  transition: CommittedTransition
}) {
  const Icon = transition === 'sleep' ? Moon : transition === 'delete' ? Trash2 : LogOut
  const title =
    transition === 'sleep'
      ? `Putting ${agentName} to sleep`
      : transition === 'delete'
        ? `Deleting ${agentName}`
        : 'Signing out'
  const detail =
    transition === 'sleep'
      ? 'Guest applications are disconnected while the controller removes the microVM Pod. Your workspace is retained.'
      : transition === 'delete'
        ? 'Tengri is removing the microVM and its persistent workspace. This desktop will close when deletion is confirmed.'
        : 'Tengri is closing this authenticated desktop session.'

  return (
    <main className="font-inter relative grid h-[100dvh] min-h-[520px] w-screen place-items-center overflow-hidden bg-[#050914] px-5 text-white">
      <DesktopWallpaper />
      <header className="absolute inset-x-0 top-0 z-20 flex h-[30px] items-center border-b border-white/10 bg-[rgba(16,20,31,0.5)] px-4 text-xs font-semibold text-white/90 backdrop-blur-2xl">
        <span className="mr-2">
          <TengriMark />
        </span>
        Tengri
      </header>
      <section
        aria-live="polite"
        className="relative z-10 w-full max-w-md rounded-[24px] border border-white/16 bg-[rgba(25,29,42,0.72)] p-8 text-center shadow-2xl backdrop-blur-3xl"
      >
        <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-white/12 bg-white/7">
          <Icon aria-hidden="true" className="h-6 w-6 text-sky-200" />
        </span>
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.02em]">{title}</h1>
        <p className="mt-2 text-sm leading-6 text-white/52">{detail}</p>
        <p role="status" className="mt-5 inline-flex items-center gap-2 text-xs text-white/62">
          <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" /> Waiting for controller state
        </p>
        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-amber-300/12 bg-amber-400/8 px-3 py-2 text-xs text-amber-100"
          >
            {error}
          </p>
        ) : null}
      </section>
    </main>
  )
}

function DockTooltip({ label }: { label: string }) {
  return (
    <span className="pointer-events-none absolute -top-10 rounded-md border border-white/10 bg-black/65 px-2 py-1 text-[10px] text-white opacity-0 backdrop-blur-md transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100">
      {label}
    </span>
  )
}

function DockIndicator({ running }: { running: boolean }) {
  return (
    <span aria-hidden="true" className={cn('mt-1 h-1 w-1 rounded-full', running ? 'bg-white' : 'bg-transparent')} />
  )
}

function ChromeDockIcon() {
  return (
    <span className="grid h-12 w-12 place-items-center rounded-[13px] border border-white/20 bg-[conic-gradient(from_210deg,#ef4b45_0_33%,#f4c447_33%_66%,#42b76a_66%_100%)] shadow-[0_9px_22px_rgba(0,0,0,0.35),inset_0_1px_0_rgba(255,255,255,0.3)]">
      <span className="grid h-6 w-6 place-items-center rounded-full border-2 border-white/80 bg-[#4f8ee8] shadow-inner">
        <span className="h-2 w-2 rounded-full bg-white/28" />
      </span>
    </span>
  )
}

function isEditableTarget(target: EventTarget | null) {
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    (target instanceof HTMLElement && target.isContentEditable)
  )
}

function DesktopWallpaper() {
  return (
    <div aria-hidden="true" className="absolute inset-0 overflow-hidden bg-[#07101d]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_24%_18%,rgba(57,128,206,0.34),transparent_34%),radial-gradient(circle_at_75%_72%,rgba(116,79,196,0.28),transparent_40%),linear-gradient(145deg,#07111f_0%,#12182c_48%,#0b0918_100%)]" />
      <div className="absolute top-[-22%] left-[14%] h-[74%] w-[66%] -rotate-12 rounded-[50%] bg-[linear-gradient(115deg,rgba(96,179,255,0.16),rgba(115,82,220,0.05))] blur-3xl" />
      <div className="absolute inset-0 opacity-20 [background-size:56px_56px] [background-image:linear-gradient(rgba(255,255,255,.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.018)_1px,transparent_1px)]" />
    </div>
  )
}

function TengriMark() {
  return (
    <span aria-hidden="true" className="relative grid h-4 w-4 place-items-center rounded-full border border-white/60">
      <span className="h-1.5 w-1.5 rounded-full bg-white/85" />
      <span className="absolute -top-1 h-1.5 w-px bg-white/60" />
    </span>
  )
}

const dockHoverAnimation = { scale: 1.18, y: -8 }
const dockTapAnimation = { scale: 0.96 }
const dockTransition = { damping: 28, stiffness: 520, type: 'spring' as const }
