'use client'

import { Bot, CircleAlert, Cpu, LoaderCircle, LogOut, Moon, Settings, ShieldCheck, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { TengriAgent, TengriCodexAccount, TengriUser } from '@/lib/tengri/types'

import { runTengriAction } from './client'
import { DesktopAppIcon } from './desktop-app-icon'
import { formatAgentDate, formatAgentResources, formatAgentUptime, shouldRefreshCodexAccount } from './settings-model'

type BusyAction = 'delete' | 'sign-out' | 'sleep' | null

type AccountState =
  | { agentId: string; status: 'loading' }
  | { account: TengriCodexAccount; agentId: string; status: 'ready' }
  | { agentId: string; message: string; status: 'error' }

const settingsNavigation = [
  { id: 'general', label: 'General', icon: Settings, color: 'bg-[#6c8dd0]/20 text-[#a9c4ff]' },
  { id: 'agent', label: 'Agent', icon: Bot, color: 'bg-[#8f79c8]/20 text-[#c4b8ff]' },
  { id: 'runtime', label: 'Runtime', icon: Cpu, color: 'bg-[#59a48c]/20 text-[#9fe2c7]' },
  { id: 'lifecycle', label: 'Lifecycle', icon: ShieldCheck, color: 'bg-[#c69a5b]/20 text-[#e7c88e]' },
] as const

type SettingsSectionId = (typeof settingsNavigation)[number]['id']

export function SettingsApp({
  active,
  agent,
  busyAction,
  error,
  instanceId,
  lifecycleDisabled,
  onDelete,
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
  onSignOut: () => void
  onSleep: () => void
  user: TengriUser
}) {
  const [accountState, setAccountState] = useState<AccountState>({ agentId: agent.id, status: 'loading' })
  const [accountRefreshing, setAccountRefreshing] = useState(false)
  const [now, setNow] = useState<number | null>(null)
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>('general')
  const refreshAbortRef = useRef<AbortController | null>(null)
  const refreshGenerationRef = useRef(0)
  const sectionRefs = useRef<Record<SettingsSectionId, HTMLElement | null>>({
    agent: null,
    general: null,
    lifecycle: null,
    runtime: null,
  })
  const lifecycleBusy = busyAction !== null

  const selectSection = useCallback((section: SettingsSectionId) => {
    setSelectedSection(section)
    sectionRefs.current[section]?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

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
  }, [])

  const refreshAccount = useCallback(async () => {
    if (lifecycleBusy) return
    refreshAbortRef.current?.abort()
    const controller = new AbortController()
    const generation = ++refreshGenerationRef.current
    refreshAbortRef.current = controller
    setAccountRefreshing(true)
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
      }
    }
  }, [agent.id, lifecycleBusy])

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
  const generalHeadingId = `${instanceId}-settings-general-heading`
  const lifecycleHeadingId = `${instanceId}-settings-lifecycle-heading`

  return (
    <div className="@container/settings flex h-full min-h-0 bg-[#1f2022] text-[13px] text-white/78">
      <aside className="flex w-[190px] shrink-0 flex-col border-r border-white/[0.08] bg-[#292a2c]/76 p-2.5 backdrop-blur-xl @max-[640px]/settings:w-[148px] @max-[480px]/settings:hidden">
        <div className="mb-3 rounded-[10px] border border-white/[0.08] bg-white/[0.045] p-2">
          <div className="flex min-w-0 items-center gap-2">
            <div
              aria-hidden="true"
              className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-[#6c8dd0]/20 text-[#a9c4ff]"
            >
              <Bot className="h-4 w-4" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-[12px] font-medium text-white/86">
                {user.name || user.email || 'GitHub user'}
              </p>
              <p className="truncate text-[10px] text-white/55">{user.email || 'Connected account'}</p>
            </div>
          </div>
        </div>
        <nav aria-label="Settings sections" className="space-y-0.5">
          {settingsNavigation.map((item) => (
            <button
              type="button"
              key={item.id}
              aria-current={selectedSection === item.id ? 'page' : undefined}
              onClick={() => selectSection(item.id)}
              className={`flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-[12px] transition-colors focus-visible:ring-2 focus-visible:ring-white/35 focus-visible:outline-none ${selectedSection === item.id ? 'bg-white/[0.12] text-white shadow-[inset_0_0_0_1px_rgba(255,255,255,0.06)]' : 'text-white/56 hover:bg-white/[0.07] hover:text-white/82'}`}
            >
              <span aria-hidden="true" className={`grid h-6 w-6 shrink-0 place-items-center rounded-md ${item.color}`}>
                <item.icon className="h-3.5 w-3.5" />
              </span>
              <span className="truncate">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="min-w-0 flex-1 overflow-auto bg-[#202123]">
        <div className="mx-auto w-full max-w-[660px] space-y-5 px-6 py-7 @max-[640px]/settings:px-4 @max-[640px]/settings:py-5">
          <section
            ref={(element) => {
              sectionRefs.current.general = element
            }}
            aria-labelledby={generalHeadingId}
            className="scroll-mt-5"
          >
            <header className="mb-5 flex flex-col items-center text-center">
              <DesktopAppIcon app="settings" className="mb-2 size-14" />
              <h1 id={generalHeadingId} className="text-[21px] font-semibold tracking-[-0.02em] text-white/90">
                General
              </h1>
              <p className="mt-1 text-[12px] text-white/55">{agent.displayName} workspace</p>
            </header>

            <section
              aria-labelledby={agentHeadingId}
              className="rounded-[10px] border border-white/[0.08] bg-[#2a2b2d]/78 p-3"
            >
              <div className="flex min-w-0 items-center gap-3">
                <div
                  aria-hidden="true"
                  className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-[#7b91d0]/22 text-[#b7caff]"
                >
                  <Bot className="h-4 w-4" />
                </div>
                <div className="min-w-0">
                  <h2 id={agentHeadingId} className="truncate text-[13px] font-semibold text-white/90">
                    {agent.displayName}
                  </h2>
                  <p className="truncate text-[11px] text-white/55">{user.name || user.email || 'GitHub user'}</p>
                </div>
                <span className="ml-auto shrink-0 rounded-full bg-emerald-400/12 px-2 py-1 text-[11px] text-emerald-300">
                  Ready
                </span>
              </div>
              {agent.message ? (
                <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-400/8 px-3 py-2 text-[11px] leading-5 text-amber-100/80">
                  <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{agent.message}</span>
                </p>
              ) : null}
            </section>
          </section>

          <SettingsSection
            id={`${instanceId}-settings-agent-details`}
            sectionRef={(element) => {
              sectionRefs.current.agent = element
            }}
            title="Agent"
          >
            <SettingRow label="GitHub account" value={user.email || user.name || '—'} />
            <SettingRow label="Created" value={formatAgentDate(agent.createdAt, hydrated)} />
            <SettingRow label="Uptime" value={formatAgentUptime(agent, now)} />
            <SettingRow label="Last activity" value={formatAgentDate(agent.lastActivityAt, hydrated)} />
            <SettingRow label="Idle sleep" value={formatAgentDate(agent.idleDeadline, hydrated)} />
            <SettingRow label="Hard expiry" value={formatAgentDate(agent.expiresAt, hydrated)} last />
          </SettingsSection>

          <SettingsSection
            id={`${instanceId}-settings-runtime-details`}
            sectionRef={(element) => {
              sectionRefs.current.runtime = element
            }}
            title="Runtime"
          >
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
              className="rounded-[10px] border border-amber-300/10 bg-amber-300/6 px-3 py-2 text-[11px] text-amber-100/70"
            >
              Codex status unavailable: {currentAccountState.message}
            </p>
          ) : null}

          <section
            ref={(element) => {
              sectionRefs.current.lifecycle = element
            }}
            aria-labelledby={lifecycleHeadingId}
            className="scroll-mt-5 rounded-[10px] border border-white/[0.08] bg-[#2a2b2d]/78 p-3"
          >
            <h2 id={lifecycleHeadingId} className="mb-3 flex items-center gap-2 text-[11px] font-medium text-white/50">
              <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-400/80" />
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
              <p role="status" className="mt-3 inline-flex items-center gap-2 text-[11px] text-white/62">
                <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                Applying {busyAction === 'sign-out' ? 'sign out' : `${busyAction} request`}…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-[11px] text-red-200">
                {error}
              </p>
            ) : null}
          </section>
        </div>
      </div>
    </div>
  )
}

function SettingsSection({
  children,
  id,
  sectionRef,
  title,
}: {
  children: ReactNode
  id: string
  sectionRef?: (element: HTMLElement | null) => void
  title: string
}) {
  return (
    <section ref={sectionRef} aria-labelledby={id} className="scroll-mt-5 space-y-2">
      <h2 id={id} className="px-2 text-[11px] font-medium text-white/55">
        {title}
      </h2>
      <dl className="overflow-hidden rounded-[10px] border border-white/[0.08] bg-[#2a2b2d]/78">{children}</dl>
    </section>
  )
}

function SettingRow({ label, last = false, value }: { label: string; last?: boolean; value: string }) {
  return (
    <div
      className={`flex min-h-11 items-center justify-between gap-4 px-3 py-2 text-[12px] ${last ? '' : 'border-b border-white/[0.07]'}`}
    >
      <dt className="shrink-0 text-white/55">{label}</dt>
      <dd className="min-w-0 truncate text-right text-white/78" title={value}>
        {value}
      </dd>
    </div>
  )
}

const secondaryButton =
  'inline-flex items-center gap-2 rounded-md bg-white/[0.1] px-3 py-1.5 text-[12px] font-semibold text-white/78 outline-none hover:bg-white/[0.16] focus-visible:ring-2 focus-visible:ring-white/45 disabled:opacity-45'
const dangerButton =
  'ml-auto inline-flex items-center gap-2 rounded-md bg-red-500/10 px-3 py-1.5 text-[12px] font-medium text-red-300 outline-none hover:bg-red-500/18 focus-visible:ring-2 focus-visible:ring-red-200 disabled:opacity-45'
