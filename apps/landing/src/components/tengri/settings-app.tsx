'use client'

import {
  Bot,
  ChevronLeft,
  ChevronRight,
  Info,
  LogOut,
  Moon,
  Plug,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'

import type { TengriAgent, TengriCodexAccount, TengriUser } from '@/lib/tengri/types'
import { pendingConnectionKey } from '@/lib/tengri/connections'

import { runTengriAction } from './client'
import { DesktopAppIcon } from './desktop-app-icon'
import { PowerSettingsForm } from './power-settings-form'
import { PasskeyRegistration } from './passkey-registration'
import { AccessPanel } from './access-panel'
import { ConnectionsPanel } from './connections-panel'
import { formatAgentDate, formatAgentResources, formatAgentUptime, shouldRefreshCodexAccount } from './settings-model'

type BusyAction = 'delete' | 'sign-out' | 'sleep' | null

type AccountState =
  | { agentId: string; status: 'loading' }
  | { account: TengriCodexAccount; agentId: string; status: 'ready' }
  | { agentId: string; message: string; status: 'error' }

const settingsNavigation = [
  { id: 'general', label: 'General', icon: Settings, color: 'bg-zinc-500' },
  { id: 'power', label: 'Power & Sleep', icon: Moon, color: 'bg-indigo-500' },
  { id: 'codex', label: 'Codex', icon: Bot, color: 'bg-emerald-600' },
  { id: 'connections', label: 'Connections', icon: Plug, color: 'bg-cyan-600' },
  { id: 'access', label: 'Privacy & Security', icon: ShieldCheck, color: 'bg-blue-500' },
  { id: 'about', label: 'About', icon: Info, color: 'bg-zinc-500' },
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
  onChanged,
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
  onChanged: () => Promise<void>
  onSignOut: () => void
  onSleep: () => void
  user: TengriUser
}) {
  const [accountState, setAccountState] = useState<AccountState>({ agentId: agent.id, status: 'loading' })
  const [now, setNow] = useState<number | null>(null)
  const [selectedSection, setSelectedSection] = useState<SettingsSectionId>('general')
  const [powerSaving, setPowerSaving] = useState(false)
  const refreshAbortRef = useRef<AbortController | null>(null)
  const refreshGenerationRef = useRef(0)
  const [search, setSearch] = useState('')
  const [visitedSections, setVisitedSections] = useState<SettingsSectionId[]>(['general'])
  const contentRef = useRef<HTMLDivElement>(null)
  const lifecycleBusy = busyAction !== null
  const selectSection = (section: SettingsSectionId) => {
    setVisitedSections((visited) => (visited.includes(section) ? visited : [...visited, section]))
    setSelectedSection(section)
    if (contentRef.current) contentRef.current.scrollTop = 0
  }

  useEffect(() => {
    try {
      if (!sessionStorage.getItem(pendingConnectionKey(user.id, agent.uid))) return
    } catch {
      return
    }
    setVisitedSections((visited) => (visited.includes('connections') ? visited : [...visited, 'connections']))
    setSelectedSection('connections')
  }, [agent.uid, user.id])

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
  }, [])

  const refreshAccount = useCallback(async () => {
    if (lifecycleBusy) return
    refreshAbortRef.current?.abort()
    const controller = new AbortController()
    const generation = ++refreshGenerationRef.current
    refreshAbortRef.current = controller
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
      }
    }
  }, [agent.id, lifecycleBusy])

  useEffect(() => {
    setAccountState({ agentId: agent.id, status: 'loading' })
  }, [agent.id])

  useEffect(() => {
    if (active && selectedSection === 'codex' && !lifecycleBusy) void refreshAccount()
    return cancelAccountRefresh
  }, [active, cancelAccountRefresh, lifecycleBusy, refreshAccount, selectedSection])

  useEffect(() => {
    if (!active || selectedSection !== 'codex' || lifecycleBusy) return
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
  }, [active, lifecycleBusy, refreshAccount, selectedSection])

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
  const lifecycleBlocked = lifecycleBusy || lifecycleDisabled || powerSaving
  const hydrated = now !== null
  const pane = settingsNavigation.find((item) => item.id === selectedSection) ?? settingsNavigation[0]
  const headingId = `${instanceId}-settings-heading`

  return (
    <div className="@container/settings relative flex h-full min-h-0 bg-[#252527] text-[13px] text-zinc-100 [--primary:var(--color-blue-600)] [--primary-foreground:var(--color-white)] [--ring:var(--color-blue-400)]">
      <div
        data-window-drag-region
        className="absolute top-0 left-0 h-[52px] w-[218px] touch-none select-none @max-[560px]/settings:hidden"
      />
      <aside
        aria-label="Settings sidebar"
        className="flex w-[218px] shrink-0 flex-col border-r border-black/25 bg-zinc-700/65 px-3 pt-[58px] pb-4 @max-[560px]/settings:hidden"
      >
        <div className="relative mb-4">
          <Search aria-hidden="true" className="pointer-events-none absolute top-2 left-2 size-3.5 text-zinc-400" />
          <input
            aria-label="Search Settings"
            placeholder="Search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 w-full rounded-md border border-white/10 bg-black/15 pr-2 pl-7 text-[13px] placeholder:text-zinc-400 focus-visible:outline-2 focus-visible:outline-blue-400"
          />
        </div>
        <div className="mb-5 flex min-w-0 items-center gap-2.5 px-1">
          <div
            aria-hidden="true"
            className="grid size-10 shrink-0 place-items-center rounded-full bg-zinc-500/60 text-lg font-medium"
          >
            {(user.name || user.email || 'T').slice(0, 1).toUpperCase()}
          </div>
          <div className="min-w-0">
            <p className="truncate font-medium">{user.name || 'GitHub user'}</p>
            <p className="mt-0.5 truncate text-[11px] text-zinc-400">{user.email || 'GitHub account'}</p>
          </div>
        </div>
        <nav aria-label="Settings sections" className="space-y-1">
          {settingsNavigation
            .filter((item) => item.label.toLowerCase().includes(search.toLowerCase().trim()))
            .map((item) => (
              <button
                type="button"
                key={item.id}
                aria-current={selectedSection === item.id ? 'page' : undefined}
                onClick={() => selectSection(item.id)}
                className={`flex min-h-9 w-full items-center gap-2.5 rounded-md px-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-blue-400 ${selectedSection === item.id ? (active ? 'bg-blue-600 text-white' : 'bg-white/15') : 'hover:bg-white/[0.07]'}`}
              >
                <span
                  aria-hidden="true"
                  className={`grid size-[25px] shrink-0 place-items-center rounded-[6px] text-white shadow-sm ${item.color}`}
                >
                  <item.icon className="size-4" />
                </span>
                <span>{item.label}</span>
              </button>
            ))}
          {search &&
          !settingsNavigation.some((item) => item.label.toLowerCase().includes(search.toLowerCase().trim())) ? (
            <p className="px-2 py-3 text-xs text-zinc-400">No settings found</p>
          ) : null}
        </nav>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          data-window-drag-region
          className="flex h-[52px] shrink-0 touch-none select-none items-center gap-3 border-b border-black/20 bg-white/[0.025] px-4 @max-[560px]/settings:pl-[84px]"
        >
          <button
            type="button"
            aria-label="Back to General"
            disabled={selectedSection === 'general'}
            onClick={() => selectSection('general')}
            className="grid size-7 place-items-center rounded-md text-zinc-300 outline-none hover:bg-white/10 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-30"
          >
            <ChevronLeft aria-hidden="true" className="size-5" />
          </button>
          <h1 id={headingId} className="truncate text-[15px] font-semibold">
            {pane.label}
          </h1>
        </header>
        <div
          ref={contentRef}
          role="region"
          aria-labelledby={headingId}
          className="min-h-0 flex-1 overflow-y-auto p-5 @max-[560px]/settings:p-4"
        >
          <div className="mx-auto max-w-[620px] space-y-5">
            {selectedSection === 'general' ? (
              <>
                <div className={groupClass + ' flex flex-col items-center px-6 py-6 text-center'}>
                  <DesktopAppIcon app="settings" className="mb-3 size-14" />
                  <h2 className="text-[20px] font-semibold tracking-tight">General</h2>
                  <p className="mt-1.5 max-w-[290px] text-[13px] leading-5 text-zinc-400">
                    Manage your workspace, sleep preferences, and account.
                  </p>
                </div>
                <div className={groupClass}>
                  {settingsNavigation
                    .filter((item) => item.id !== 'general')
                    .map((item) => (
                      <button
                        key={item.id}
                        type="button"
                        aria-label={`Open ${item.label}`}
                        onClick={() => selectSection(item.id)}
                        className="flex min-h-12 w-full items-center gap-3 border-b border-white/[0.07] px-3 py-2 text-left last:border-0 hover:bg-white/[0.04] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-blue-400"
                      >
                        <span
                          aria-hidden="true"
                          className={`grid size-7 shrink-0 place-items-center rounded-md text-white ${item.color}`}
                        >
                          <item.icon className="size-[17px]" />
                        </span>
                        <span>{item.label}</span>
                        <ChevronRight aria-hidden="true" className="ml-auto size-4 text-zinc-500" />
                      </button>
                    ))}
                </div>
              </>
            ) : null}
            {visitedSections.includes('power') ? (
              <div hidden={selectedSection !== 'power'} className="space-y-5">
                <PowerSettingsForm
                  agent={agent}
                  disabled={lifecycleBusy}
                  instanceId={instanceId}
                  onChanged={onChanged}
                  onSavingChange={setPowerSaving}
                />
                <div className={groupClass + ' flex items-center justify-between gap-4 px-3 py-3'}>
                  <div>
                    <p>Sleep now</p>
                    <p className="mt-1 text-xs text-zinc-400">Resume whenever you’re ready to work.</p>
                  </div>
                  <button type="button" disabled={lifecycleBlocked} className={secondaryButton} onClick={onSleep}>
                    <Moon aria-hidden="true" className="size-3.5" />
                    Sleep
                  </button>
                </div>
              </div>
            ) : null}
            {selectedSection === 'codex' ? (
              <>
                <SettingsSection title="Codex account">
                  <SettingRow label="Account" value={codexStatus} />
                  <SettingRow
                    label="Status"
                    value={
                      currentAccountState.status === 'ready'
                        ? currentAccountState.account.authenticated
                          ? 'Connected'
                          : 'Not connected'
                        : codexStatus
                    }
                  />
                </SettingsSection>
                {currentAccountState.status === 'error' ? (
                  <p role="status" className="px-3 text-xs text-zinc-400">
                    {currentAccountState.message}
                  </p>
                ) : null}
              </>
            ) : null}
            {visitedSections.includes('connections') ? (
              <div hidden={selectedSection !== 'connections'}>
                <ConnectionsPanel
                  key={JSON.stringify([user.id, agent.uid])}
                  agent={agent}
                  principalId={user.id}
                  active={active && selectedSection === 'connections'}
                  disabled={lifecycleBusy}
                />
              </div>
            ) : null}
            {visitedSections.includes('access') ? (
              <div hidden={selectedSection !== 'access'} className="space-y-5">
                <AccessPanel workspaceUid={agent.uid} active={active && selectedSection === 'access'} />
                <details className={groupClass}>
                  <summary className="cursor-pointer px-3 py-3 text-xs font-medium">Sign-in & passkeys</summary>
                  <div className="space-y-4 border-t border-zinc-700/60 p-3">
                    <section aria-label="Passkeys">
                      <PasskeyRegistration />
                    </section>
                    <div className="flex items-center justify-between gap-4">
                      <span>GitHub account</span>
                      <button type="button" disabled={lifecycleBlocked} className={secondaryButton} onClick={onSignOut}>
                        <LogOut aria-hidden="true" className="size-3.5" />
                        Sign Out
                      </button>
                    </div>
                  </div>
                </details>
              </div>
            ) : null}
            {selectedSection === 'about' ? (
              <>
                <div className="flex flex-col items-center py-3 text-center">
                  <DesktopAppIcon app="tengri" className="mb-3 size-16" />
                  <h2 className="text-[22px] font-semibold">{agent.displayName}</h2>
                  <p className="mt-1 text-zinc-400">Your private workspace</p>
                </div>
                <SettingsSection title="Workspace">
                  <SettingRow label="Processor" value={agent.architecture === 'unknown' ? '—' : agent.architecture} />
                  <SettingRow label="Memory & CPU" value={formatAgentResources(agent)} />
                  <SettingRow label="Storage" value={`${agent.workspaceGib} GiB`} />
                  <SettingRow label="Virtualization" value="Firecracker" />
                </SettingsSection>
                <SettingsSection title="Activity">
                  <SettingRow label="Created" value={formatAgentDate(agent.createdAt, hydrated)} />
                  <SettingRow label="Uptime" value={formatAgentUptime(agent, now)} />
                  <SettingRow label="Last activity" value={formatAgentDate(agent.lastActivityAt, hydrated)} />
                  <SettingRow label="Files retained" value="Until you delete the agent" />
                </SettingsSection>
                <div className={groupClass + ' flex items-center justify-between gap-4 px-3 py-3'}>
                  <span>Delete this workspace</span>
                  <button
                    type="button"
                    disabled={lifecycleBlocked}
                    className={secondaryButton + ' text-red-300'}
                    onClick={onDelete}
                  >
                    <Trash2 aria-hidden="true" className="size-3.5" />
                    Delete Agent
                  </button>
                </div>
              </>
            ) : null}
            {lifecycleBusy ? (
              <p role="status" className="px-3 text-xs text-zinc-400">
                Applying {busyAction === 'sign-out' ? 'sign out' : `${busyAction} request`}…
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="px-3 text-xs text-red-300">
                {error}
              </p>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}

const groupClass = 'overflow-hidden rounded-[10px] border border-white/[0.07] bg-white/[0.045]'
const secondaryButton =
  'inline-flex shrink-0 items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-zinc-600/45 px-2.5 py-1 text-[12px] shadow-sm outline-none hover:bg-zinc-600/70 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-45'

function SettingsSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="px-3 text-[13px] font-medium">{title}</h2>
      <dl className={groupClass}>{children}</dl>
    </section>
  )
}

function SettingRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 border-b border-white/[0.07] px-3 py-2 text-[13px] last:border-0">
      <dt className="shrink-0">{label}</dt>
      <dd className="min-w-0 truncate text-right text-zinc-400" title={value}>
        {value}
      </dd>
    </div>
  )
}
