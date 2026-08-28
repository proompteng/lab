'use client'

import { Bot, CircleAlert, LoaderCircle, LogOut, Moon, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { TengriAgent, TengriCodexAccount, TengriUser } from '@/lib/tengri/types'

import { runTengriAction } from './client'
import { formatAgentDate, formatAgentResources, formatAgentUptime, shouldRefreshCodexAccount } from './settings-model'

type BusyAction = 'delete' | 'sign-out' | 'sleep' | null

type AccountState =
  | { agentId: string; status: 'loading' }
  | { account: TengriCodexAccount; agentId: string; status: 'ready' }
  | { agentId: string; message: string; status: 'error' }

export function SettingsApp({
  active,
  agent,
  busyAction,
  error,
  instanceId,
  lifecycleDisabled,
  onDelete,
  onGuestOperationChange,
  onSignOut,
  onSleep,
  user,
}: {
  active: boolean
  agent: TengriAgent
  busyAction: BusyAction
  error: string
  instanceId: string
  lifecycleDisabled: boolean
  onDelete: () => void
  onGuestOperationChange: (instanceId: string, active: boolean) => void
  onSignOut: () => void
  onSleep: () => void
  user: TengriUser
}) {
  const [accountState, setAccountState] = useState<AccountState>({ agentId: agent.id, status: 'loading' })
  const [accountRefreshing, setAccountRefreshing] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const refreshAbortRef = useRef<AbortController | null>(null)
  const refreshGenerationRef = useRef(0)
  const lifecycleBusy = busyAction !== null

  useEffect(() => {
    setNow(Date.now())
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const cancelAccountRefresh = useCallback(() => {
    const controller = refreshAbortRef.current
    if (!controller) return
    controller.abort()
    if (refreshAbortRef.current !== controller) return
    refreshAbortRef.current = null
    refreshGenerationRef.current += 1
    setAccountRefreshing(false)
    onGuestOperationChange(instanceId, false)
  }, [instanceId, onGuestOperationChange])

  const refreshAccount = useCallback(async () => {
    if (lifecycleBusy) return
    refreshAbortRef.current?.abort()
    const controller = new AbortController()
    const generation = ++refreshGenerationRef.current
    refreshAbortRef.current = controller
    setAccountRefreshing(true)
    onGuestOperationChange(instanceId, true)
    try {
      const account = await runTengriAction<TengriCodexAccount>(
        { action: 'codex-account', agentId: agent.id },
        controller.signal,
      )
      if (controller.signal.aborted || generation !== refreshGenerationRef.current) return
      setAccountState({ account, agentId: agent.id, status: 'ready' })
    } catch (cause) {
      if (controller.signal.aborted || generation !== refreshGenerationRef.current) return
      setAccountState({
        agentId: agent.id,
        message: cause instanceof Error ? cause.message : 'Codex account status is unavailable',
        status: 'error',
      })
    } finally {
      if (refreshAbortRef.current === controller) {
        refreshAbortRef.current = null
        setAccountRefreshing(false)
        onGuestOperationChange(instanceId, false)
      }
    }
  }, [agent.id, instanceId, lifecycleBusy, onGuestOperationChange])

  useEffect(() => {
    setAccountState({ agentId: agent.id, status: 'loading' })
  }, [agent.id])

  useEffect(() => {
    if (active && !lifecycleBusy) void refreshAccount()
    return cancelAccountRefresh
  }, [active, cancelAccountRefresh, lifecycleBusy, refreshAccount])

  useEffect(() => {
    if (!active || lifecycleBusy) return
    const refreshIfVisible = () => {
      if (shouldRefreshCodexAccount({ active, documentVisible: document.visibilityState === 'visible' })) {
        void refreshAccount()
      }
    }
    window.addEventListener('focus', refreshIfVisible)
    document.addEventListener('visibilitychange', refreshIfVisible)
    return () => {
      window.removeEventListener('focus', refreshIfVisible)
      document.removeEventListener('visibilitychange', refreshIfVisible)
    }
  }, [active, lifecycleBusy, refreshAccount])

  const currentAccountState: AccountState =
    accountState.agentId === agent.id ? accountState : { agentId: agent.id, status: 'loading' }
  const codexStatus =
    currentAccountState.status === 'loading'
      ? 'Checking login…'
      : currentAccountState.status === 'error'
        ? 'Unavailable'
        : currentAccountState.account.authenticated
          ? currentAccountState.account.email || currentAccountState.account.plan || 'Connected'
          : 'Not connected'
  const busy = lifecycleBusy
  const lifecycleBlocked = lifecycleBusy || accountRefreshing || lifecycleDisabled
  const hydrated = now !== null
  const agentHeadingId = `${instanceId}-settings-agent-heading`
  const lifecycleHeadingId = `${instanceId}-settings-lifecycle-heading`

  return (
    <div className="h-full overflow-auto bg-[#17191f] p-6 text-sm text-white/75">
      <div className="mx-auto max-w-xl space-y-5">
        <section aria-labelledby={agentHeadingId} className="rounded-2xl border border-white/8 bg-white/4 p-5">
          <div className="flex min-w-0 items-center gap-4">
            <div
              aria-hidden="true"
              className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#2574e8] to-[#8b5cf6] shadow-lg"
            >
              <Bot className="h-7 w-7 text-white" />
            </div>
            <div className="min-w-0">
              <h1 id={agentHeadingId} className="truncate text-lg font-semibold text-white/90">
                {agent.displayName}
              </h1>
              <p className="truncate text-xs text-white/42">{user.name || user.email || 'GitHub user'}</p>
            </div>
            <span className="ml-auto shrink-0 rounded-full bg-emerald-400/12 px-2.5 py-1 text-xs text-emerald-300">
              Ready
            </span>
          </div>
          {agent.message ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-100/80">
              <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{agent.message}</span>
            </p>
          ) : null}
        </section>

        <SettingsSection id={`${instanceId}-settings-agent-details`} title="Agent">
          <SettingRow label="GitHub account" value={user.email || user.name || '—'} />
          <SettingRow label="Created" value={formatAgentDate(agent.createdAt, hydrated)} />
          <SettingRow label="Uptime" value={formatAgentUptime(agent, now)} />
          <SettingRow label="Last activity" value={formatAgentDate(agent.lastActivityAt, hydrated)} />
          <SettingRow label="Idle sleep" value={formatAgentDate(agent.idleDeadline, hydrated)} />
          <SettingRow label="Hard expiry" value={formatAgentDate(agent.expiresAt, hydrated)} last />
        </SettingsSection>

        <SettingsSection id={`${instanceId}-settings-runtime-details`} title="Runtime">
          <SettingRow label="Isolation" value="Kata Firecracker (kata-fc)" />
          <SettingRow label="Architecture" value={agent.architecture === 'unknown' ? '—' : agent.architecture} />
          <SettingRow label="Resources" value={formatAgentResources(agent)} />
          <SettingRow label="Workspace" value={`${agent.workspaceGib} GiB persistent`} />
          <SettingRow label="Scheduled node" value={agent.nodeName || '—'} />
          <SettingRow label="Codex" value={codexStatus} last />
        </SettingsSection>

        {currentAccountState.status === 'error' ? (
          <p
            role="status"
            className="rounded-xl border border-amber-300/10 bg-amber-300/6 px-3 py-2 text-xs text-amber-100/70"
          >
            Codex status unavailable: {currentAccountState.message}
          </p>
        ) : null}

        <section aria-labelledby={lifecycleHeadingId} className="rounded-2xl border border-white/8 bg-white/4 p-4">
          <h2 id={lifecycleHeadingId} className="mb-3 flex items-center gap-2 text-xs font-medium text-white/50">
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-400" />
            Unprivileged guest · no cluster credential · private workspace
          </h2>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={lifecycleBlocked}
              className={secondaryButton}
              onClick={() => {
                if (!refreshAbortRef.current && !lifecycleDisabled) onSleep()
              }}
            >
              <Moon aria-hidden="true" className="h-4 w-4" /> Sleep Agent
            </button>
            <button
              type="button"
              disabled={lifecycleBlocked}
              className={secondaryButton}
              onClick={() => {
                if (!refreshAbortRef.current && !lifecycleDisabled) onSignOut()
              }}
            >
              <LogOut aria-hidden="true" className="h-4 w-4" /> Sign Out
            </button>
            <button
              type="button"
              disabled={lifecycleBlocked}
              className={dangerButton}
              onClick={() => {
                if (!refreshAbortRef.current && !lifecycleDisabled) onDelete()
              }}
            >
              <Trash2 aria-hidden="true" className="h-4 w-4" /> Delete Agent
            </button>
          </div>
          {busy ? (
            <p role="status" className="mt-4 inline-flex items-center gap-2 text-xs text-white/62">
              <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
              Applying {busyAction === 'sign-out' ? 'sign out' : `${busyAction} request`}…
            </p>
          ) : null}
          {error ? (
            <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          ) : null}
        </section>
      </div>
    </div>
  )
}

function SettingsSection({ children, id, title }: { children: ReactNode; id: string; title: string }) {
  return (
    <section aria-labelledby={id} className="space-y-2">
      <h2 id={id} className="px-2 text-xs font-medium text-white/42">
        {title}
      </h2>
      <dl className="overflow-hidden rounded-2xl border border-white/8 bg-white/4">{children}</dl>
    </section>
  )
}

function SettingRow({ label, last = false, value }: { label: string; last?: boolean; value: string }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 py-3 text-xs ${last ? '' : 'border-b border-white/7'}`}
    >
      <dt className="shrink-0 text-white/48">{label}</dt>
      <dd className="min-w-0 truncate text-right text-white/78" title={value}>
        {value}
      </dd>
    </div>
  )
}

const secondaryButton =
  'inline-flex items-center gap-2 rounded-lg bg-white/8 px-3 py-2 text-xs font-semibold text-white/78 outline-none hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-white/55 disabled:opacity-45'
const dangerButton =
  'ml-auto inline-flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 outline-none hover:bg-red-500/18 focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-45'
