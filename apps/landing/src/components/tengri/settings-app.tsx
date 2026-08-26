'use client'

import { Bot, CircleAlert, LoaderCircle, Moon, Play, ShieldCheck, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'

import type { TengriAgent, TengriCodexAccount, TengriUser } from '@/lib/tengri/types'

import { runTengriAction } from './client'
import { ConfirmationDialog } from './confirmation-dialog'
import {
  formatAgentDate,
  formatAgentPhase,
  formatAgentResources,
  formatAgentUptime,
  lifecycleActionForPhase,
  type AgentLifecycleAction,
} from './settings-model'

type AccountState =
  | { agentId: string; status: 'loading' }
  | { account: TengriCodexAccount; agentId: string; status: 'ready' }
  | { agentId: string; message: string; status: 'error' }

export function SettingsApp({
  agent,
  user,
  onAgentChanged,
}: {
  agent: TengriAgent
  user: TengriUser
  onAgentChanged: () => Promise<void>
}) {
  const [busyAction, setBusyAction] = useState<'delete-agent' | AgentLifecycleAction | null>(null)
  const [error, setError] = useState('')
  const [accountState, setAccountState] = useState<AccountState>({ agentId: agent.id, status: 'loading' })
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    void runTengriAction<TengriCodexAccount>({ action: 'codex-account', agentId: agent.id }, controller.signal)
      .then((account) => setAccountState({ account, agentId: agent.id, status: 'ready' }))
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return
        setAccountState({
          agentId: agent.id,
          message: cause instanceof Error ? cause.message : 'Codex account status is unavailable',
          status: 'error',
        })
      })
    return () => controller.abort()
  }, [agent.id])

  const currentAccountState: AccountState =
    accountState.agentId === agent.id ? accountState : { agentId: agent.id, status: 'loading' }
  const lifecycleAction = lifecycleActionForPhase(agent.phase)
  const codexStatus =
    currentAccountState.status === 'loading'
      ? 'Checking login…'
      : currentAccountState.status === 'error'
        ? 'Unavailable'
        : currentAccountState.account.authenticated
          ? currentAccountState.account.email || currentAccountState.account.plan || 'Connected'
          : 'Not connected'

  async function runLifecycle(action: 'delete-agent' | AgentLifecycleAction) {
    setBusyAction(action)
    setError('')
    try {
      await runTengriAction({ action, agentId: agent.id })
      if (action === 'delete-agent') setDeleteConfirmationOpen(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent lifecycle action failed')
      setBusyAction(null)
      return
    }

    try {
      await onAgentChanged()
    } catch {
      setError('The action completed, but the latest agent status could not be loaded.')
    } finally {
      setBusyAction(null)
    }
  }

  return (
    <div className="h-full overflow-auto bg-[#17191f] p-6 text-sm text-white/75">
      <div className="mx-auto max-w-xl space-y-5">
        <section
          aria-labelledby="settings-agent-heading"
          className="rounded-2xl border border-white/8 bg-white/[0.035] p-5"
        >
          <div className="flex min-w-0 items-center gap-4">
            <div
              aria-hidden="true"
              className="grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-[#2574e8] to-[#8b5cf6] shadow-lg"
            >
              <Bot className="h-7 w-7 text-white" />
            </div>
            <div className="min-w-0">
              <h2 id="settings-agent-heading" className="truncate text-lg font-semibold text-white/90">
                {agent.displayName}
              </h2>
              <p className="truncate text-xs text-white/42">{user.name || user.email || 'GitHub user'}</p>
            </div>
            <span className={`ml-auto shrink-0 rounded-full px-2.5 py-1 text-xs ${phaseClassName(agent.phase)}`}>
              {formatAgentPhase(agent.phase)}
            </span>
          </div>
          {agent.message ? (
            <p className="mt-4 flex items-start gap-2 rounded-xl bg-amber-400/8 px-3 py-2 text-xs leading-5 text-amber-100/80">
              <CircleAlert aria-hidden="true" className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>{agent.message}</span>
            </p>
          ) : null}
        </section>

        <SettingsSection title="Agent">
          <SettingRow label="GitHub account" value={user.email || user.name || '—'} />
          <SettingRow label="Created" value={formatAgentDate(agent.createdAt)} />
          <SettingRow label="Uptime" value={formatAgentUptime(agent, now)} />
          <SettingRow label="Last activity" value={formatAgentDate(agent.lastActivityAt)} />
          <SettingRow label="Idle sleep" value={formatAgentDate(agent.idleDeadline)} />
          <SettingRow label="Hard expiry" value={formatAgentDate(agent.expiresAt)} last />
        </SettingsSection>

        <SettingsSection title="Runtime">
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

        <section
          aria-labelledby="settings-lifecycle-heading"
          className="rounded-2xl border border-white/8 bg-white/[0.035] p-4"
        >
          <h3
            id="settings-lifecycle-heading"
            className="mb-3 flex items-center gap-2 text-xs font-medium text-white/50"
          >
            <ShieldCheck aria-hidden="true" className="h-4 w-4 text-emerald-400" />
            Unprivileged guest · no cluster credential · private workspace
          </h3>
          <div className="flex flex-wrap gap-2">
            {lifecycleAction ? (
              <button
                type="button"
                aria-busy={busyAction === lifecycleAction}
                disabled={busyAction !== null}
                onClick={() => void runLifecycle(lifecycleAction)}
                className={`inline-flex items-center gap-2 rounded-lg px-3 py-2 text-xs font-semibold text-white disabled:opacity-45 ${
                  lifecycleAction === 'resume-agent'
                    ? 'bg-[#2574e8] hover:bg-[#3180ee]'
                    : 'bg-white/8 hover:bg-white/12'
                }`}
              >
                {busyAction === lifecycleAction ? (
                  <LoaderCircle aria-hidden="true" className="h-3.5 w-3.5 animate-spin" />
                ) : lifecycleAction === 'resume-agent' ? (
                  <Play aria-hidden="true" className="h-3.5 w-3.5" />
                ) : (
                  <Moon aria-hidden="true" className="h-3.5 w-3.5" />
                )}
                {lifecycleAction === 'resume-agent' ? 'Resume Agent' : 'Sleep Agent'}
              </button>
            ) : (
              <p className="self-center text-xs text-white/38">
                Lifecycle controls are unavailable while {agent.phase}.
              </p>
            )}
            <button
              type="button"
              disabled={busyAction !== null || agent.phase === 'terminating'}
              onClick={() => setDeleteConfirmationOpen(true)}
              className="ml-auto inline-flex items-center gap-2 rounded-lg bg-red-500/10 px-3 py-2 text-xs font-medium text-red-300 hover:bg-red-500/18 disabled:opacity-45"
            >
              <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
              Delete Agent
            </button>
          </div>
          {error ? (
            <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
              {error}
            </p>
          ) : null}
        </section>
      </div>

      <ConfirmationDialog
        busy={busyAction === 'delete-agent'}
        confirmLabel="Delete Agent"
        description="This permanently deletes the Firecracker microVM, its persistent workspace, Codex login, and all files. This action cannot be undone."
        error={error}
        onConfirm={() => void runLifecycle('delete-agent')}
        onOpenChange={(open) => {
          setDeleteConfirmationOpen(open)
          if (open) setError('')
        }}
        open={deleteConfirmationOpen}
        title={`Delete “${agent.displayName}”?`}
      />
    </div>
  )
}

function SettingsSection({ children, title }: { children: ReactNode; title: string }) {
  return (
    <section aria-labelledby={`settings-${title.toLowerCase()}-heading`} className="space-y-2">
      <h3 id={`settings-${title.toLowerCase()}-heading`} className="px-2 text-xs font-medium text-white/42">
        {title}
      </h3>
      <div className="overflow-hidden rounded-2xl border border-white/8 bg-white/[0.035]">{children}</div>
    </section>
  )
}

function SettingRow({ label, value, last = false }: { label: string; value: string; last?: boolean }) {
  return (
    <div
      className={`flex items-center justify-between gap-4 px-4 py-3 text-xs ${last ? '' : 'border-b border-white/7'}`}
    >
      <span className="shrink-0 text-white/48">{label}</span>
      <span className="min-w-0 truncate text-right text-white/78" title={value}>
        {value}
      </span>
    </div>
  )
}

function phaseClassName(phase: TengriAgent['phase']): string {
  if (phase === 'ready') return 'bg-emerald-400/12 text-emerald-300'
  if (phase === 'failed') return 'bg-red-400/12 text-red-200'
  if (phase === 'sleeping') return 'bg-sky-400/12 text-sky-200'
  return 'bg-amber-300/12 text-amber-200'
}
