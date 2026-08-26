'use client'

import { Bot, Check, CircleAlert, CircleUserRound, Cloud, LoaderCircle, Moon, Play } from 'lucide-react'
import { motion, useReducedMotion } from 'motion/react'
import { useState } from 'react'
import { tengriAuthClient } from '@/lib/tengri/auth-client'
import type { TengriAgent, TengriDesktopSnapshot } from '@/lib/tengri/types'
import { runTengriAction } from './client'
import { ConfirmationDialog } from './confirmation-dialog'
import { useModalFocus } from './modal-focus'

export type DesktopGateState =
  | { kind: 'auth-unconfigured' }
  | { kind: 'control-plane-unconfigured' }
  | { kind: 'create' }
  | { kind: 'error'; detail: string }
  | { kind: 'failed'; agent: TengriAgent }
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'sign-in' }
  | { kind: 'sleeping'; agent: TengriAgent }
  | { kind: 'transitioning'; agent: TengriAgent }
  | { kind: 'unknown'; agent: TengriAgent }

export function resolveDesktopGate(
  snapshot: TengriDesktopSnapshot | null,
  agent: TengriAgent | null,
  error: string,
): DesktopGateState {
  if (!snapshot && !error) return { kind: 'loading' }
  if (error) return { kind: 'error', detail: error }
  if (!snapshot?.authConfigured) return { kind: 'auth-unconfigured' }
  if (!snapshot.authenticated) return { kind: 'sign-in' }
  if (!snapshot.controlPlaneConfigured) return { kind: 'control-plane-unconfigured' }
  if (!agent) return { kind: 'create' }
  if (agent.phase === 'ready') return { kind: 'ready' }
  if (agent.phase === 'sleeping') return { kind: 'sleeping', agent }
  if (agent.phase === 'failed') return { kind: 'failed', agent }
  if (agent.phase === 'unknown') return { kind: 'unknown', agent }
  return { kind: 'transitioning', agent }
}

export function DesktopGate({
  agent,
  error,
  onRefresh,
  snapshot,
}: {
  agent: TengriAgent | null
  error: string
  onRefresh: () => Promise<void>
  snapshot: TengriDesktopSnapshot | null
}) {
  const gate = resolveDesktopGate(snapshot, agent, error)
  if (gate.kind === 'loading')
    return (
      <CenteredPanel
        icon={<LoaderCircle className="h-7 w-7 animate-spin" />}
        title="Starting Tengri"
        detail="Loading your desktop…"
      />
    )
  if (gate.kind === 'error')
    return (
      <CenteredPanel
        icon={<CircleAlert className="h-7 w-7 text-red-300" />}
        title="Tengri is unavailable"
        detail={gate.detail}
        actionLabel="Try Again"
        onAction={() => void onRefresh()}
      />
    )
  if (gate.kind === 'auth-unconfigured')
    return (
      <CenteredPanel
        icon={<CircleAlert className="h-7 w-7 text-amber-300" />}
        title="Authentication is not configured"
        detail="Connect the GitHub OAuth and Better Auth secrets before exposing Tengri."
      />
    )
  if (gate.kind === 'sign-in')
    return (
      <CenteredPanel
        icon={<CircleUserRound className="h-7 w-7" />}
        title="Sign in to Tengri"
        detail="Your GitHub identity owns one private Firecracker agent and its persistent workspace."
        actionLabel="Continue with GitHub"
        onAction={() => void tengriAuthClient.signIn.social({ provider: 'github', callbackURL: '/' })}
      />
    )
  if (gate.kind === 'control-plane-unconfigured')
    return (
      <CenteredPanel
        icon={<Cloud className="h-7 w-7 text-amber-200" />}
        title="Control plane is not configured"
        detail="The public desktop is ready, but its internal Tengri gRPC endpoint and signing secret are unavailable."
      />
    )
  if (gate.kind === 'create') return <CreateAgent onCreated={onRefresh} />
  if (gate.kind === 'ready') return null
  if (gate.kind === 'sleeping') return <WakeAgent agent={gate.agent} onChanged={onRefresh} />
  if (gate.kind === 'failed') return <FailedAgent agent={gate.agent} onChanged={onRefresh} />
  if (gate.kind === 'unknown')
    return (
      <CenteredPanel
        icon={<CircleAlert className="h-7 w-7 text-amber-300" />}
        title="Agent state is unavailable"
        detail={gate.agent.message || 'Tengri returned an unknown agent phase.'}
        actionLabel="Refresh"
        onAction={() => void onRefresh()}
      />
    )
  return (
    <CenteredPanel
      icon={<LoaderCircle className="h-7 w-7 animate-spin text-[#79b8ff]" />}
      title={gate.agent.phase === 'terminating' ? 'Deleting agent' : 'Booting your microVM'}
      detail={gate.agent.message || 'Kata is starting a private Firecracker guest and waiting for Nanoagent readiness.'}
      progress
    />
  )
}

function FailedAgent({ agent, onChanged }: { agent: TengriAgent; onChanged: () => Promise<void> }) {
  const modalFocus = useModalFocus<HTMLElement>()
  const [busy, setBusy] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleteConfirmationOpen, setDeleteConfirmationOpen] = useState(false)

  function deleteAgent() {
    setBusy(true)
    setDeleteError('')
    void runTengriAction({ action: 'delete-agent', agentId: agent.id })
      .then(() => {
        setDeleteConfirmationOpen(false)
        return onChanged()
      })
      .catch((cause: unknown) =>
        setDeleteError(cause instanceof Error ? cause.message : 'The failed agent could not be deleted'),
      )
      .finally(() => setBusy(false))
  }

  return (
    <div className="fixed inset-0 z-[3000] grid place-items-center bg-black/15 p-5 backdrop-blur-sm">
      <section
        ref={modalFocus.ref}
        role="alertdialog"
        aria-modal="true"
        aria-label="Agent could not start"
        aria-busy={busy}
        aria-hidden={deleteConfirmationOpen || undefined}
        inert={deleteConfirmationOpen || undefined}
        tabIndex={-1}
        className="tengri-panel w-full max-w-lg rounded-[28px] border border-red-300/18 p-7 text-center shadow-[0_40px_120px_rgba(0,0,0,0.5)] backdrop-blur-3xl"
        onKeyDown={modalFocus.onKeyDown}
      >
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-red-300/15 bg-red-500/8">
          <CircleAlert className="h-7 w-7 text-red-300" />
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-white/94">Agent could not start</h1>
        <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-white/48">
          {agent.message || agent.conditions.at(-1)?.message || 'Tengri reported an exact guest startup failure.'}
        </p>
        {deleteError ? (
          <p role="alert" className="mt-4 text-xs text-red-200">
            {deleteError}
          </p>
        ) : null}
        <button
          type="button"
          disabled={busy}
          className="mt-6 inline-flex items-center gap-2 rounded-xl bg-red-500/14 px-4 py-2.5 text-sm font-semibold text-red-100 disabled:opacity-45"
          onClick={() => setDeleteConfirmationOpen(true)}
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <CircleAlert className="h-4 w-4" />}
          Delete Failed Agent
        </button>
      </section>
      <ConfirmationDialog
        busy={busy}
        confirmLabel="Delete Agent"
        description="This permanently removes the failed microVM and its persistent workspace so you can create a clean agent. This cannot be undone."
        error={deleteError}
        onConfirm={deleteAgent}
        onOpenChange={setDeleteConfirmationOpen}
        open={deleteConfirmationOpen}
        title={`Delete “${agent.displayName}”?`}
      />
    </div>
  )
}

function CreateAgent({ onCreated }: { onCreated: () => Promise<void> }) {
  const modalFocus = useModalFocus<HTMLFormElement>()
  const [displayName, setDisplayName] = useState('Tengri')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="fixed inset-0 z-[3000] grid place-items-center bg-black/16 p-5 backdrop-blur-sm">
      <form
        ref={modalFocus.ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-agent-title"
        aria-busy={busy}
        tabIndex={-1}
        className="tengri-panel w-full max-w-md rounded-[28px] border border-white/18 p-7 shadow-[0_40px_120px_rgba(0,0,0,0.5)] backdrop-blur-3xl"
        onKeyDown={modalFocus.onKeyDown}
        onSubmit={(event) => {
          event.preventDefault()
          setBusy(true)
          setError('')
          void runTengriAction<TengriAgent>({ action: 'create-agent', displayName })
            .then(onCreated)
            .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Agent could not be created'))
            .finally(() => setBusy(false))
        }}
      >
        <div className="mb-5 flex items-center gap-4">
          <div className="grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-[#2574e8] to-[#8b5cf6] shadow-xl">
            <Bot className="h-7 w-7" />
          </div>
          <div>
            <h1 id="create-agent-title" className="text-xl font-semibold tracking-tight">
              Create your agent
            </h1>
            <p className="mt-1 text-xs text-white/45">One isolated Firecracker microVM</p>
          </div>
        </div>
        <label className="block text-xs font-medium text-white/62">
          Agent name
          <input
            autoFocus
            value={displayName}
            maxLength={64}
            onChange={(event) => setDisplayName(event.target.value)}
            className="mt-2 block w-full rounded-xl border border-white/12 bg-black/20 px-3 py-2.5 text-sm text-white outline-none focus:border-[#79b8ff]/60 focus:ring-2 focus:ring-[#2574e8]/20"
          />
        </label>
        <div className="mt-4 grid grid-cols-3 gap-2 text-center text-[10px] text-white/42">
          <span className="rounded-lg bg-white/5 px-2 py-2">2 CPU</span>
          <span className="rounded-lg bg-white/5 px-2 py-2">4 GiB RAM</span>
          <span className="rounded-lg bg-white/5 px-2 py-2">16 GiB disk</span>
        </div>
        {error ? (
          <p role="alert" className="mt-4 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={busy || !displayName.trim()}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#2574e8] px-4 py-2.5 text-sm font-semibold shadow-lg shadow-[#2574e8]/20 disabled:opacity-40"
        >
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
          Create Agent
        </button>
      </form>
    </div>
  )
}

function WakeAgent({ agent, onChanged }: { agent: TengriAgent; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <CenteredPanel
      icon={busy ? <LoaderCircle className="h-7 w-7 animate-spin" /> : <Moon className="h-7 w-7 text-[#b7a6ff]" />}
      title={busy ? 'Waking your desktop' : 'Your agent is sleeping'}
      detail="Your windows, files, Codex login, and threads are preserved on the persistent workspace."
      error={error}
      actionLabel={busy ? undefined : 'Resume Agent'}
      onAction={() => {
        setBusy(true)
        setError('')
        void runTengriAction<TengriAgent>({ action: 'resume-agent', agentId: agent.id })
          .then(onChanged)
          .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : 'Agent could not be resumed'))
          .finally(() => setBusy(false))
      }}
      progress={busy}
    />
  )
}

function CenteredPanel({
  actionLabel,
  detail,
  error,
  icon,
  onAction,
  progress = false,
  title,
}: {
  actionLabel?: string
  detail: string
  error?: string
  icon: React.ReactNode
  onAction?: () => void
  progress?: boolean
  title: string
}) {
  const interactive = Boolean(actionLabel && onAction)
  const modalFocus = useModalFocus<HTMLElement>(interactive)
  const reducedMotion = useReducedMotion()
  return (
    <div className="fixed inset-0 z-[3000] grid place-items-center bg-black/15 p-5 backdrop-blur-sm">
      <section
        ref={modalFocus.ref}
        role={interactive ? 'dialog' : 'status'}
        aria-modal={interactive ? 'true' : undefined}
        aria-label={title}
        tabIndex={interactive ? -1 : undefined}
        className="tengri-panel w-full max-w-md rounded-[28px] border border-white/18 p-7 text-center shadow-[0_40px_120px_rgba(0,0,0,0.5)] backdrop-blur-3xl"
        onKeyDown={interactive ? modalFocus.onKeyDown : undefined}
      >
        <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl border border-white/12 bg-white/8">
          {icon}
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-tight text-white/94">{title}</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-white/48">{detail}</p>
        {error ? (
          <p role="alert" className="mx-auto mt-3 max-w-sm rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        ) : null}
        {progress ? (
          <div className="mt-5 h-1 overflow-hidden rounded-full bg-white/8">
            <motion.div
              className={`h-full rounded-full bg-[#79b8ff] ${reducedMotion ? 'w-full' : 'w-1/3'}`}
              animate={reducedMotion ? undefined : { x: ['-100%', '300%'] }}
              transition={
                reducedMotion ? undefined : { repeat: Number.POSITIVE_INFINITY, duration: 1.2, ease: 'easeInOut' }
              }
            />
          </div>
        ) : null}
        {actionLabel && onAction ? (
          <button
            type="button"
            onClick={onAction}
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-[#2574e8] px-4 py-2.5 text-sm font-semibold shadow-lg shadow-[#2574e8]/20"
          >
            {title.includes('Sign in') ? <CircleUserRound className="h-4 w-4" /> : <Check className="h-4 w-4" />}
            {actionLabel}
          </button>
        ) : null}
      </section>
    </div>
  )
}
