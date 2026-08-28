'use client'

import { zodResolver } from '@hookform/resolvers/zod'
import { Bot, CircleAlert, CircleUserRound, Cloud, LoaderCircle, Moon, Play, RotateCw, Trash2 } from 'lucide-react'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import type { ReactNode } from 'react'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { useForm } from 'react-hook-form'

import { tengriAuthClient } from '@/lib/tengri/auth-client'
import { desktopRefreshDelay, resolveDesktopGate, type DesktopGateState } from '@/lib/tengri/desktop-gate'
import type { TengriAgent, TengriDesktopSnapshot } from '@/lib/tengri/types'
import { createAgentFormSchema, type CreateAgentFormValues } from '@/schemas/tengri-agent'
import { getDesktopSnapshot, runTengriAction } from './client'
import { ConfirmationDialog } from './confirmation-dialog'
import { useModalFocus } from './modal-focus'
import { ReadyDesktop } from './ready-desktop'

export default function DesktopOnboarding() {
  const mounted = useRef(false)
  const requestSequence = useRef(0)
  const [snapshot, setSnapshot] = useState<TengriDesktopSnapshot | null>(null)
  const [snapshotError, setSnapshotError] = useState('')

  const refresh = useCallback(async () => {
    const sequence = ++requestSequence.current
    try {
      const next = await getDesktopSnapshot()
      if (!mounted.current || sequence !== requestSequence.current) return
      setSnapshot(next)
      setSnapshotError('')
    } catch (cause) {
      if (!mounted.current || sequence !== requestSequence.current) return
      setSnapshotError(cause instanceof Error ? cause.message : 'Tengri could not be reached')
    }
  }, [])

  useEffect(() => {
    mounted.current = true
    void refresh()
    return () => {
      mounted.current = false
      requestSequence.current += 1
    }
  }, [refresh])

  const gate = resolveDesktopGate(snapshot, snapshotError)
  useEffect(() => {
    const refreshDelay = desktopRefreshDelay(gate, Date.now())
    if (refreshDelay === null) return
    const timer = window.setTimeout(() => void refresh(), refreshDelay)
    return () => window.clearTimeout(timer)
  }, [gate, refresh])

  if (gate.kind === 'ready' && snapshot?.user) {
    return (
      <ReadyDesktop agent={gate.agent} connectionWarning={snapshotError} onChanged={refresh} user={snapshot.user} />
    )
  }

  return (
    <main className="relative min-h-[100svh] overflow-hidden bg-[#080b13] text-white selection:bg-[#6da8ff]/35">
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-[radial-gradient(circle_at_18%_12%,rgba(76,118,196,0.28),transparent_38%),radial-gradient(circle_at_82%_78%,rgba(104,72,178,0.24),transparent_42%),linear-gradient(145deg,#0a1222_0%,#15172c_52%,#0b0a18_100%)]"
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 opacity-30 [background-size:48px_48px] [background-image:linear-gradient(rgba(255,255,255,.018)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,.018)_1px,transparent_1px)]"
      />
      <header className="absolute inset-x-0 top-0 z-20 flex h-8 items-center justify-between border-b border-white/10 bg-white/[0.055] px-4 text-[12px] text-white/72 backdrop-blur-2xl">
        <div className="flex items-center gap-2 font-semibold text-white/90">
          <TengriMark />
          Tengri
        </div>
        <span>{snapshot?.authenticated ? snapshot.user?.name || 'GitHub user' : 'Private microVM workspace'}</span>
      </header>
      <div className="relative z-10 grid min-h-[100svh] place-items-center px-5 pt-12 pb-8">
        <AnimatePresence mode="wait">
          <DesktopGate key={gate.kind} gate={gate} onRefresh={refresh} />
        </AnimatePresence>
      </div>
    </main>
  )
}

function DesktopGate({ gate, onRefresh }: { gate: DesktopGateState; onRefresh: () => Promise<void> }) {
  if (gate.kind === 'loading') {
    return (
      <StatusWindow
        icon={<LoaderCircle className="h-7 w-7 animate-spin" />}
        title="Starting Tengri"
        detail="Loading your workspace…"
        progress
      />
    )
  }
  if (gate.kind === 'error') {
    return (
      <ActionWindow
        icon={<CircleAlert className="h-7 w-7 text-red-200" />}
        title="Tengri is unavailable"
        detail={gate.detail}
        actionLabel="Try Again"
        onAction={() => void onRefresh()}
      />
    )
  }
  if (gate.kind === 'auth-unconfigured') {
    return (
      <StatusWindow
        icon={<CircleAlert className="h-7 w-7 text-amber-200" />}
        title="Authentication is not configured"
        detail="GitHub OAuth and the Better Auth session secret must be configured before Tengri can accept sign-ins."
      />
    )
  }
  if (gate.kind === 'sign-in') return <SignInWindow />
  if (gate.kind === 'control-plane-unconfigured') {
    return (
      <StatusWindow
        icon={<Cloud className="h-7 w-7 text-amber-200" />}
        title="Control plane is not configured"
        detail="Authentication is ready, but the internal Tengri gRPC endpoint and request-signing secret are unavailable."
      />
    )
  }
  if (gate.kind === 'create') return <CreateAgentWindow onCreated={onRefresh} />
  if (gate.kind === 'ready') {
    return (
      <ActionWindow
        icon={<CircleAlert className="h-7 w-7 text-red-200" />}
        title="Session identity is unavailable"
        detail="Tengri received an agent without an authenticated user. Refresh the session before continuing."
        actionLabel="Refresh"
        onAction={() => void onRefresh()}
      />
    )
  }
  if (gate.kind === 'sleeping') return <SleepingAgentWindow agent={gate.agent} onChanged={onRefresh} />
  if (gate.kind === 'failed') return <FailedAgentWindow agent={gate.agent} onChanged={onRefresh} />
  if (gate.kind === 'unknown') {
    return (
      <ActionWindow
        icon={<CircleAlert className="h-7 w-7 text-amber-200" />}
        title="Agent state is unavailable"
        detail={gate.agent.message || 'Tengri returned an unknown agent phase.'}
        actionLabel="Refresh"
        onAction={() => void onRefresh()}
      />
    )
  }
  return (
    <StatusWindow
      icon={<LoaderCircle className="h-7 w-7 animate-spin text-[#8abfff]" />}
      title={gate.agent.phase === 'terminating' ? 'Deleting agent' : 'Booting your microVM'}
      detail={gate.agent.message || 'Waiting for the private Firecracker guest and Nanoagent to become ready.'}
      progress
    />
  )
}

function SignInWindow() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  function signIn() {
    setBusy(true)
    setError('')
    void tengriAuthClient.signIn
      .social({ provider: 'github', callbackURL: '/' })
      .then((result) => {
        if (result.error) {
          setError(result.error.message || 'Tengri could not start GitHub sign-in')
          setBusy(false)
        }
      })
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : 'Tengri could not start GitHub sign-in')
        setBusy(false)
      })
  }

  return (
    <ActionWindow
      icon={busy ? <LoaderCircle className="h-7 w-7 animate-spin" /> : <CircleUserRound className="h-7 w-7" />}
      title="Sign in to Tengri"
      detail="Your GitHub identity owns one private Firecracker agent and its persistent workspace."
      error={error}
      actionIcon={<CircleUserRound aria-hidden="true" className="h-4 w-4" />}
      actionBusy={busy}
      actionLabel="Continue with GitHub"
      onAction={signIn}
    />
  )
}

function CreateAgentWindow({ onCreated }: { onCreated: () => Promise<void> }) {
  const {
    formState: { errors, isSubmitting },
    handleSubmit,
    register,
    setError,
  } = useForm<CreateAgentFormValues>({
    defaultValues: { displayName: 'Tengri' },
    mode: 'onChange',
    resolver: zodResolver(createAgentFormSchema),
  })

  const createAgent = handleSubmit(async ({ displayName }) => {
    try {
      await runTengriAction<TengriAgent>({ action: 'create-agent', displayName })
      await onCreated()
    } catch (cause) {
      setError('root.server', { message: cause instanceof Error ? cause.message : 'Agent could not be created' })
    }
  })

  return (
    <LifecycleWindow title="Create your agent" interactive>
      <form noValidate onSubmit={createAgent}>
        <WindowHero
          icon={<Bot className="h-7 w-7" />}
          title="Create your agent"
          detail="One isolated Firecracker microVM with a persistent workspace."
        />
        <label className="mt-6 block text-xs font-medium text-white/62">
          Agent name
          <input
            autoFocus
            aria-describedby={errors.displayName ? 'create-agent-name-error' : undefined}
            aria-invalid={Boolean(errors.displayName)}
            maxLength={64}
            required
            {...register('displayName')}
            className="mt-2 block w-full rounded-xl border border-white/14 bg-black/20 px-3 py-2.5 text-sm text-white outline-none transition focus:border-[#79b8ff]/65 focus:ring-2 focus:ring-[#2574e8]/25"
          />
        </label>
        {errors.displayName ? (
          <p id="create-agent-name-error" role="alert" className="mt-2 text-xs text-red-200">
            {errors.displayName.message}
          </p>
        ) : null}
        <dl className="mt-5 grid grid-cols-3 gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 text-center">
          <Resource label="CPU" value="2 cores" />
          <Resource label="Memory" value="4 GiB" />
          <Resource label="Workspace" value="16 GiB" />
        </dl>
        {errors.root?.server ? (
          <p
            role="alert"
            className="mt-4 rounded-xl border border-red-300/12 bg-red-500/8 px-3 py-2 text-xs text-red-100"
          >
            {errors.root.server.message}
          </p>
        ) : null}
        <button
          type="submit"
          disabled={isSubmitting}
          className="mt-6 flex w-full items-center justify-center gap-2 rounded-xl bg-[#1769d2] px-4 py-2.5 text-sm font-semibold text-white outline-none transition hover:bg-[#1d6fd8] focus-visible:ring-2 focus-visible:ring-[#9bc8ff] disabled:opacity-40"
        >
          {isSubmitting ? (
            <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
          ) : (
            <Play aria-hidden="true" className="h-4 w-4 fill-current" />
          )}
          Create Agent
        </button>
      </form>
    </LifecycleWindow>
  )
}

function SleepingAgentWindow({ agent, onChanged }: { agent: TengriAgent; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function resume() {
    setBusy(true)
    setError('')
    try {
      await runTengriAction<TengriAgent>({ action: 'resume-agent', agentId: agent.id })
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Agent could not be resumed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <ActionWindow
      icon={busy ? <LoaderCircle className="h-7 w-7 animate-spin" /> : <Moon className="h-7 w-7 text-[#b7a6ff]" />}
      title={busy ? 'Waking your agent' : `${agent.displayName} is sleeping`}
      detail="The microVM Pod is stopped. Your workspace and Codex state remain on persistent storage."
      error={error}
      actionIcon={<Play aria-hidden="true" className="h-4 w-4 fill-current" />}
      actionBusy={busy}
      actionLabel="Resume Agent"
      onAction={() => void resume()}
    />
  )
}

function FailedAgentWindow({ agent, onChanged }: { agent: TengriAgent; onChanged: () => Promise<void> }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [confirmOpen, setConfirmOpen] = useState(false)

  async function deleteAgent() {
    setBusy(true)
    setError('')
    try {
      await runTengriAction<null>({ action: 'delete-agent', agentId: agent.id })
      setConfirmOpen(false)
      await onChanged()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'The failed agent could not be deleted')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div aria-hidden={confirmOpen || undefined} inert={confirmOpen || undefined}>
        <ActionWindow
          icon={<CircleAlert className="h-7 w-7 text-red-200" />}
          title="Agent could not start"
          detail={agent.message || agent.conditions.at(-1)?.message || 'Tengri reported a guest startup failure.'}
          error={error}
          actionIcon={<Trash2 aria-hidden="true" className="h-4 w-4" />}
          actionBusy={busy}
          actionLabel="Delete Failed Agent"
          danger
          onAction={() => setConfirmOpen(true)}
        />
      </div>
      <ConfirmationDialog
        busy={busy}
        description="This removes the failed microVM and its persistent workspace so a clean agent can be created. This cannot be undone."
        error={error}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={() => void deleteAgent()}
        open={confirmOpen}
        title={`Delete “${agent.displayName}”?`}
      />
    </>
  )
}

function StatusWindow({ icon, title, detail, progress = false }: WindowMessageProps & { progress?: boolean }) {
  return (
    <LifecycleWindow title={title}>
      <WindowHero icon={icon} title={title} detail={detail} />
      {progress ? <ProgressBar /> : null}
    </LifecycleWindow>
  )
}

function ActionWindow({
  actionBusy = false,
  actionIcon,
  actionLabel,
  danger = false,
  detail,
  error = '',
  icon,
  onAction,
  title,
}: WindowMessageProps & {
  actionBusy?: boolean
  actionIcon?: ReactNode
  actionLabel: string
  danger?: boolean
  error?: string
  onAction: () => void
}) {
  return (
    <LifecycleWindow title={title} interactive>
      <WindowHero icon={icon} title={title} detail={detail} />
      {error ? <InlineError message={error} /> : null}
      <button
        type="button"
        aria-busy={actionBusy}
        disabled={actionBusy}
        onClick={onAction}
        className={`mt-6 inline-flex items-center gap-2 rounded-xl px-4 py-2.5 text-sm font-semibold text-white outline-none transition focus-visible:ring-2 disabled:opacity-40 ${danger ? 'bg-red-700 hover:bg-red-600 focus-visible:ring-red-200' : 'bg-[#1769d2] hover:bg-[#1d6fd8] focus-visible:ring-[#9bc8ff]'}`}
      >
        {actionBusy ? (
          <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />
        ) : (
          actionIcon || <RotateCw aria-hidden="true" className="h-4 w-4" />
        )}
        {actionLabel}
      </button>
    </LifecycleWindow>
  )
}

function LifecycleWindow({
  children,
  interactive = false,
  title,
}: {
  children: ReactNode
  interactive?: boolean
  title: string
}) {
  const modalFocus = useModalFocus<HTMLElement>(interactive)
  const reducedMotion = useHydratedReducedMotion()
  return (
    <motion.section
      ref={modalFocus.ref}
      role={interactive ? 'dialog' : 'status'}
      aria-modal={interactive ? 'true' : undefined}
      data-tengri-modal={interactive ? 'true' : undefined}
      aria-label={title}
      tabIndex={interactive ? -1 : undefined}
      className="w-full max-w-lg overflow-hidden rounded-[28px] border border-white/18 bg-[rgba(27,30,39,0.88)] text-white shadow-[0_48px_140px_rgba(0,0,0,0.58),inset_0_1px_0_rgba(255,255,255,0.17)] backdrop-blur-3xl"
      initial={reducedMotion ? false : { opacity: 0, scale: 0.97, y: 14 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={reducedMotion ? undefined : { opacity: 0, scale: 0.985, y: -6 }}
      transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.22, 1, 0.36, 1] }}
      onKeyDown={interactive ? modalFocus.onKeyDown : undefined}
    >
      <div className="relative flex h-11 items-center border-b border-white/9 bg-white/[0.035] px-4">
        <div aria-hidden="true" className="flex gap-2">
          <span className="h-3 w-3 rounded-full bg-[#ff5f57]" />
          <span className="h-3 w-3 rounded-full bg-[#febc2e]" />
          <span className="h-3 w-3 rounded-full bg-[#28c840]" />
        </div>
        <span className="pointer-events-none absolute inset-x-24 truncate text-center text-xs font-semibold text-white/54">
          {title}
        </span>
      </div>
      <div className="p-7">{children}</div>
    </motion.section>
  )
}

function WindowHero({ detail, icon, title }: WindowMessageProps) {
  return (
    <div>
      <div
        aria-hidden="true"
        className="grid h-14 w-14 place-items-center rounded-2xl border border-white/12 bg-white/8 shadow-inner"
      >
        {icon}
      </div>
      <h1 className="mt-5 text-2xl font-semibold tracking-[-0.025em] text-white/95">{title}</h1>
      <p className="mt-2 max-w-md text-sm leading-6 text-white/52">{detail}</p>
    </div>
  )
}

function Resource({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-black/20 px-2 py-3">
      <dt className="text-[10px] uppercase tracking-[0.12em] text-white/52">{label}</dt>
      <dd className="mt-1 text-xs font-medium text-white/76">{value}</dd>
    </div>
  )
}

function InlineError({ message }: { message: string }) {
  return (
    <p role="alert" className="mt-4 rounded-xl border border-red-300/12 bg-red-500/8 px-3 py-2 text-xs text-red-100">
      {message}
    </p>
  )
}

function ProgressBar() {
  const reducedMotion = useHydratedReducedMotion()
  return (
    <div className="mt-6 h-1 overflow-hidden rounded-full bg-white/8">
      <motion.div
        className={`h-full rounded-full bg-[#79b8ff] ${reducedMotion ? 'w-full' : 'w-1/3'}`}
        animate={reducedMotion ? undefined : { x: ['-100%', '300%'] }}
        transition={reducedMotion ? undefined : { repeat: Number.POSITIVE_INFINITY, duration: 1.2, ease: 'easeInOut' }}
      />
    </div>
  )
}

function useHydratedReducedMotion() {
  const reducedMotion = useReducedMotion()
  const hydrated = useSyncExternalStore(
    subscribeToHydration,
    () => true,
    () => false,
  )
  return hydrated && Boolean(reducedMotion)
}

function subscribeToHydration() {
  return () => {}
}

function TengriMark() {
  return (
    <span aria-hidden="true" className="relative grid h-4 w-4 place-items-center rounded-full border border-white/60">
      <span className="h-1.5 w-1.5 rounded-full bg-white/85" />
      <span className="absolute -top-1 h-1.5 w-px bg-white/60" />
    </span>
  )
}

type WindowMessageProps = { detail: string; icon: ReactNode; title: string }
