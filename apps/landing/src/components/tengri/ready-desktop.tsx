'use client'

import { CheckCircle2, LoaderCircle, LogOut, Moon, Settings, Trash2, Wifi } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'

import { tengriAuthClient } from '@/lib/tengri/auth-client'
import type { TengriAgent, TengriUser } from '@/lib/tengri/types'
import { cn } from '@/lib/utils'
import { APP_TITLES, initialWindowState, type Bounds, windowReducer } from '@/lib/tengri/window-manager'
import { ChromeAgentWindow } from './chrome-agent-window'
import { runTengriAction } from './client'
import { ConfirmationDialog } from './confirmation-dialog'
import { DesktopWindowFrame } from './desktop-window'

export function ReadyDesktop({
  agent,
  connectionWarning = '',
  onChanged,
  user,
}: {
  agent: TengriAgent
  connectionWarning?: string
  onChanged: () => Promise<void>
  user: TengriUser
}) {
  const stageRef = useRef<HTMLDivElement | null>(null)
  const [windowState, dispatch] = useReducer(windowReducer, { x: 0, y: 0, width: 1_280, height: 760 }, (viewport) =>
    initialWindowState(viewport, ['settings', 'chrome']),
  )
  const [clock, setClock] = useState<Date | null>(null)
  const [busyAction, setBusyAction] = useState<'delete' | 'sign-out' | 'sleep' | null>(null)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)
  const reducedMotion = useReducedMotion()

  const viewport = useCallback((): Bounds => {
    const rect = stageRef.current?.getBoundingClientRect()
    return {
      x: 0,
      y: 0,
      width: rect?.width ?? globalThis.innerWidth,
      height: rect?.height ?? Math.max(0, globalThis.innerHeight - 30),
    }
  }, [])

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
    const handleShortcut = (event: KeyboardEvent) => {
      if (!event.metaKey || event.defaultPrevented || isEditableTarget(event.target)) return
      const active = windowState.windows.find((candidate) => candidate.id === windowState.activeWindowId)
      if (!active) return
      if (event.key.toLowerCase() === 'w') {
        event.preventDefault()
        dispatch({ type: 'close', id: active.id })
      } else if (event.key.toLowerCase() === 'm') {
        event.preventDefault()
        dispatch({ type: 'minimize', id: active.id })
      } else if (event.ctrlKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        dispatch({ type: 'toggle-maximize', id: active.id, viewport: viewport() })
      }
    }
    window.addEventListener('keydown', handleShortcut)
    return () => window.removeEventListener('keydown', handleShortcut)
  }, [viewport, windowState.activeWindowId, windowState.windows])

  const openSettings = useCallback(() => {
    dispatch({ type: 'open', app: 'settings', title: APP_TITLES.settings, viewport: viewport() })
  }, [viewport])

  const openChrome = useCallback(() => {
    dispatch({ type: 'open', app: 'chrome', title: APP_TITLES.chrome, viewport: viewport() })
  }, [viewport])

  async function mutate(action: 'delete-agent' | 'sleep-agent') {
    setBusyAction(action === 'delete-agent' ? 'delete' : 'sleep')
    setError('')
    try {
      await runTengriAction<TengriAgent | null>({ action, agentId: agent.id })
      setConfirmOpen(false)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The agent lifecycle request failed')
    } finally {
      setBusyAction(null)
    }
  }

  async function signOut() {
    setBusyAction('sign-out')
    setError('')
    try {
      const result = await tengriAuthClient.signOut()
      if (result.error) throw new Error(result.error.message || 'Tengri could not sign out')
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Tengri could not sign out')
    } finally {
      setBusyAction(null)
    }
  }

  const chromeRunning = windowState.windows.some((candidate) => candidate.app === 'chrome')
  const settingsRunning = windowState.windows.some((candidate) => candidate.app === 'settings')
  const activeWindow = windowState.windows.find((candidate) => candidate.id === windowState.activeWindowId)
  const activeAppTitle = activeWindow ? APP_TITLES[activeWindow.app] : 'Tengri'

  return (
    <>
      <main
        aria-hidden={confirmOpen || undefined}
        inert={confirmOpen || undefined}
        className="font-inter relative h-[100dvh] min-h-[520px] w-screen overflow-hidden bg-[#050914] text-white selection:bg-[#78a9ff]/35"
      >
        <DesktopWallpaper />
        <header className="absolute inset-x-0 top-0 z-[2000] flex h-[30px] items-center justify-between border-b border-white/10 bg-[rgba(16,20,31,0.5)] px-3 text-[12px] shadow-sm backdrop-blur-2xl">
          <nav aria-label="Application menu" className="flex h-full items-center gap-1">
            <button
              type="button"
              aria-label="Open Tengri Settings"
              className="flex h-6 items-center rounded-md px-2 font-semibold text-white/90 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/50"
              onClick={openSettings}
            >
              <TengriMark />
            </button>
            <button
              type="button"
              className="flex h-6 items-center rounded-md px-2 font-semibold text-white/88 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-white/50"
              onClick={activeWindow?.app === 'chrome' ? openChrome : openSettings}
            >
              {activeAppTitle}
            </button>
          </nav>
          <div className="flex min-w-0 items-center gap-3 text-white/72">
            <span className="hidden items-center gap-1.5 sm:flex">
              <span
                aria-hidden="true"
                className={cn('h-1.5 w-1.5 rounded-full', connectionWarning ? 'bg-amber-300' : 'bg-emerald-400')}
              />
              <span className="max-w-36 truncate">{agent.displayName}</span>
            </span>
            <span aria-label={connectionWarning ? 'Connection degraded' : 'Connected'}>
              <Wifi aria-hidden="true" className="h-3.5 w-3.5" />
            </span>
            <span className="hidden max-w-32 truncate md:inline">{user.name || 'GitHub user'}</span>
            <time className="tabular-nums" dateTime={clock?.toISOString()}>
              {clock
                ? new Intl.DateTimeFormat(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(
                    clock,
                  )
                : '\u00a0'}
            </time>
          </div>
        </header>

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
          {windowState.windows.map((desktopWindow) => (
            <DesktopWindowFrame
              active={desktopWindow.id === windowState.activeWindowId}
              dispatch={dispatch}
              key={desktopWindow.id}
              stageRef={stageRef}
              window={desktopWindow}
            >
              {desktopWindow.app === 'chrome' ? (
                <ChromeAgentWindow agentId={agent.id} />
              ) : (
                <AgentSettings
                  agent={agent}
                  busyAction={busyAction}
                  error={error}
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

function AgentSettings({
  agent,
  busyAction,
  error,
  onDelete,
  onSignOut,
  onSleep,
  user,
}: {
  agent: TengriAgent
  busyAction: 'delete' | 'sign-out' | 'sleep' | null
  error: string
  onDelete: () => void
  onSignOut: () => void
  onSleep: () => void
  user: TengriUser
}) {
  const busy = busyAction !== null
  return (
    <div className="grid h-full min-h-0 grid-cols-[176px_minmax(0,1fr)] bg-[rgba(15,18,25,0.62)]">
      <aside className="border-r border-white/8 bg-white/[0.035] p-3">
        <p className="px-3 pt-2 pb-3 text-[10px] font-semibold tracking-[0.12em] text-white/35 uppercase">Tengri</p>
        <div className="flex items-center gap-2 rounded-lg bg-white/10 px-3 py-2 text-xs font-medium text-white/90">
          <Settings aria-hidden="true" className="h-4 w-4" /> Agent
        </div>
      </aside>
      <section aria-labelledby="agent-settings-title" className="min-h-0 overflow-auto p-7">
        <div className="flex items-start justify-between gap-6">
          <div>
            <p className="text-xs font-medium text-emerald-300">Ready</p>
            <h1 id="agent-settings-title" className="mt-1 text-2xl font-semibold tracking-[-0.025em] text-white/95">
              {agent.displayName}
            </h1>
            <p className="mt-2 text-sm leading-6 text-white/48">Private Firecracker workspace for {user.name}.</p>
          </div>
          <div
            aria-hidden="true"
            className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl border border-emerald-200/12 bg-emerald-400/8 shadow-inner"
          >
            <CheckCircle2 className="h-7 w-7 text-emerald-300" />
          </div>
        </div>

        <dl className="mt-7 divide-y divide-white/8 overflow-hidden rounded-2xl border border-white/9 bg-black/16 px-4 text-sm">
          <Detail label="Runtime" value="Firecracker via kata-fc" />
          <Detail label="Resources" value={`${formatCpu(agent.cpuMillis)} · ${formatGib(agent.memoryMib)} GiB RAM`} />
          <Detail label="Workspace" value={`${agent.workspaceGib} GiB persistent`} />
          <Detail label="Node" value={agent.nodeName || 'Scheduling'} />
          <Detail label="Idle sleep" value={formatTimestamp(agent.idleDeadline)} />
          <Detail label="Hard expiry" value={formatTimestamp(agent.expiresAt)} />
        </dl>

        {error ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-300/12 bg-red-500/8 px-3 py-2 text-xs text-red-100"
          >
            {error}
          </p>
        ) : null}
        {busy ? (
          <p role="status" className="mt-4 inline-flex items-center gap-2 text-xs text-white/62">
            <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
            Applying {busyAction === 'sign-out' ? 'sign out' : `${busyAction} request`}…
          </p>
        ) : null}

        <div className="mt-7 flex flex-wrap gap-2 border-t border-white/8 pt-5">
          <button type="button" disabled={busy} className={secondaryButton} onClick={onSleep}>
            <Moon aria-hidden="true" className="h-4 w-4" /> Sleep Agent
          </button>
          <button type="button" disabled={busy} className={secondaryButton} onClick={onSignOut}>
            <LogOut aria-hidden="true" className="h-4 w-4" /> Sign Out
          </button>
          <button type="button" disabled={busy} className={dangerButton} onClick={onDelete}>
            <Trash2 aria-hidden="true" className="h-4 w-4" /> Delete Agent
          </button>
        </div>
      </section>
    </div>
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

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-5 py-3">
      <dt className="text-white/46">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-white/78">{value}</dd>
    </div>
  )
}

function formatCpu(millis: number) {
  if (!Number.isFinite(millis)) return '0 CPU'
  const cores = Math.round((millis / 1_000) * 10) / 10
  return `${cores} CPU`
}

function formatGib(mebibytes: number) {
  return Number.isFinite(mebibytes) ? Math.round((mebibytes / 1_024) * 10) / 10 : 0
}

function formatTimestamp(value: string) {
  const timestamp = new Date(value)
  if (!value || Number.isNaN(timestamp.getTime())) return 'Not reported'
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp)
}

const secondaryButton =
  'inline-flex items-center gap-2 rounded-xl border border-white/12 bg-white/7 px-3.5 py-2 text-sm font-medium text-white/76 outline-none transition hover:bg-white/11 focus-visible:ring-2 focus-visible:ring-white/55 disabled:opacity-40'
const dangerButton =
  'ml-auto inline-flex items-center gap-2 rounded-xl border border-red-300/12 bg-red-500/8 px-3.5 py-2 text-sm font-medium text-red-100 outline-none transition hover:bg-red-500/14 focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-40'
const dockHoverAnimation = { scale: 1.18, y: -8 }
const dockTapAnimation = { scale: 0.96 }
const dockTransition = { damping: 28, stiffness: 520, type: 'spring' as const }
