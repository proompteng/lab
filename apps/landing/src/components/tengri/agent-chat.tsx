'use client'

import { watchTengriEvents } from './event-stream'

import { reportBrowserFailure } from '@/lib/observability/client'
import { CodexHistoryInterruptedError } from '@/lib/tengri/codex-history'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
  Skeleton,
} from '@proompteng/design/ui'
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  Command,
  ExternalLink,
  LoaderCircle,
  PanelLeft,
  Plus,
  Square,
  Wrench,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useId, type ReactNode } from 'react'
import {
  codexOptionsForSelection,
  codexReasoningLabels,
  codexSelectionSchema,
  defaultCodexSelection,
  type TengriCodexModel,
  type TengriCodexModelPage,
  type TengriCodexOptions,
  type TengriCodexSelection,
} from '@/lib/tengri/codex-models'
import type {
  TengriCodexAccount,
  TengriCodexEvent,
  TengriCodexLogin,
  TengriCodexThread,
  TengriCodexTurn,
} from '@/lib/tengri/types'
import {
  MAX_CODEX_IMAGES,
  MAX_CODEX_TOTAL_IMAGE_BYTES,
  codexImageUrl,
  readCodexImage,
  type TengriCodexImage,
} from '@/lib/tengri/codex-images'
import { cn } from '@/lib/utils'
import { AgentSessionList } from './agent-session-list'
import { CodexQuestionCard } from './codex-question-card'
import { codexQuestionRequest } from './codex-question-model'
import { CodexEventCard } from './codex-event-card'
import { groupCodexActivity } from './codex-activity'
import { automaticApprovalDecision, readApprovalMode, writeApprovalMode, type ApprovalMode } from './approval-mode'
import {
  WorkspaceFileLinkProvider,
  WorkspaceFileTabs,
  WorkspacePinnedResources,
  useWorkspaceResources,
} from './workspace-file-link'
import { CodexCopyButton } from './codex-copy-button'
import {
  appendCodexEvent,
  appendCodexEventAfterRestore,
  codexAccountRefreshIsCurrent,
  codexThreadTurnState,
  codexEventClientTurnIds,
  codexApprovalDecisions,
  codexApprovalTitle,
  codexEventConfirmsRuntimeReady,
  codexEventDisplayText,
  codexEventActivityTitle,
  codexEventIsIndependentOfThreadSnapshot,
  codexEventIsRuntimeError,
  codexEventKey,
  codexEventMatchesThread,
  codexEventShouldRender,
  codexEventSupersedesRestoredItem,
  codexLoginCompletionError,
  codexLoginCompletionIsUncorrelated,
  codexLoginCompletionMatches,
  codexReconciledActiveTurnId,
  codexResolvedApprovalId,
  codexResumeCommitIsCurrent,
  codexTranscriptFromThread,
  parseCodexEvent,
  reconcileCodexEventsWithRestoredHistory,
  reconcileSubmittedPrompts,
  retainSubmittedPromptImages,
  type CodexApprovalDecision,
  type CodexBufferedEvent,
  type CodexTranscriptItem,
  type SubmittedPrompt,
} from './codex-events'
import { runTengriAction, TengriRequestError } from './client'
import { completeCodexOperation, prepareCodexOperation } from '@/lib/tengri/codex-operation'
import { codexRunIsTerminal, type TengriCodexRun } from '@/lib/tengri/codex-run'
import { useModalFocus } from './modal-focus'

type EventStreamState = 'connected' | 'connecting' | 'reconnecting'

type DraftImage = { id: string; name: string; size: number; input: TengriCodexImage | null }

class AgentConnectionError extends Error {}

class ApprovalDeliveryError extends Error {
  constructor(
    readonly approvalId: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : 'Approval could not be resolved', { cause })
  }
}

function runRecoveryError(cause: unknown, fallback: string): Error {
  if (retryableReadFailure(cause)) {
    return new AgentConnectionError('Reconnecting to your agent…', { cause })
  }
  return cause instanceof Error ? cause : new Error(fallback)
}

function codexRunActivity(state: TengriCodexRun['state']): string | null {
  switch (state.phase) {
    case 'waiting_for_guest':
      return 'Connecting'
    case 'recovering':
      return 'Reconnecting'
    case 'cancelling':
      return 'Stopping'
    case 'needs_reconciliation':
      return "The agent's last action could not be confirmed. Check the conversation before continuing."
    case 'accepted':
    case 'running':
    case 'waiting_for_approval':
    case 'succeeded':
    case 'failed':
    case 'cancelled':
    case 'rejected':
      return null
  }
}

async function waitForRunCompletion(agentId: string, runId: string, threadId: string) {
  const signal = AbortSignal.timeout(10_000)
  while (true) {
    const current = await runTengriAction<TengriCodexRun>({ action: 'codex-run', agentId, runId }, signal)
    if (current.agentId !== agentId || current.runId !== runId || current.threadId !== threadId)
      throw new Error('Run completion returned a different conversation')
    if (codexRunIsTerminal(current)) return current
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
}

export function AgentChat({ active = true, agentId }: { active?: boolean; agentId: string }) {
  return (
    <WorkspaceFileLinkProvider key={agentId} agentId={agentId}>
      <AgentChatView active={active} agentId={agentId} />
    </WorkspaceFileLinkProvider>
  )
}

function AgentChatView({ active, agentId }: { active: boolean; agentId: string }) {
  const { showChat } = useWorkspaceResources()
  const [account, setAccount] = useState<TengriCodexAccount | null>(null)
  const [login, setLogin] = useState<TengriCodexLogin | null>(null)
  const [models, setModels] = useState<TengriCodexModel[] | null>(null)
  const [modelError, setModelError] = useState('')
  const [modelReload, setModelReload] = useState(0)
  const [selection, setSelection] = useState<TengriCodexSelection>(defaultCodexSelection)
  const [selectionWarning, setSelectionWarning] = useState('')
  const [threadId, setThreadId] = useState('')
  const [threadReady, setThreadReady] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState('')
  const [runId, setRunId] = useState('')
  const [runRecovered, setRunRecovered] = useState(false)
  const recoverInitialRun = useRef(true)
  const [workspaceRun, setWorkspaceRun] = useState<TengriCodexRun | null>(null)
  const [run, setRun] = useState<TengriCodexRun | null>(null)
  const [historyItems, setHistoryItems] = useState<CodexTranscriptItem[]>([])
  const [restoredHistorySequence, setRestoredHistorySequence] = useState(0)
  const [events, setEvents] = useState<CodexBufferedEvent[]>([])
  const retainedEvents = useRef<CodexBufferedEvent[]>([])
  const [submittedPrompts, setSubmittedPrompts] = useState<SubmittedPrompt[]>([])
  const [approvalMode, setApprovalMode] = useState<ApprovalMode>('ask')
  const autoApprovalAttempts = useRef(new Set<string>())
  const resolvedApprovals = useRef(new Set<string>())
  const [prompt, setPrompt] = useState('')
  const [images, setImages] = useState<DraftImage[]>([])
  const imagesRef = useRef<DraftImage[]>([])
  const draftsRef = useRef(new Map<string, { text: string; images: DraftImage[] }>())
  const creatingDraftRef = useRef<{
    selection: number
    draft?: { text: string; images: DraftImage[] }
  } | null>(null)
  const [recoverableDrafts, setRecoverableDrafts] = useState<{ id: string; text: string; images: DraftImage[] }[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [replayRecovering, setReplayRecovering] = useState(false)
  const [threadResumeRevision, setThreadResumeRevision] = useState(0)
  const [recoveryFailed, setRecoveryFailed] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [resolvingApprovals, setResolvingApprovals] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | Error>('')
  const [connectionNotice, setConnectionNotice] = useState(false)
  const errorMessage =
    error instanceof AgentConnectionError && !connectionNotice ? '' : error instanceof Error ? error.message : error
  const conversationMissing = error instanceof TengriRequestError && error.code === 'conversation_not_found'
  const [eventStreamState, setEventStreamState] = useState<EventStreamState>('connecting')
  const [followingConversation, setFollowingConversation] = useState(true)
  const [sessionRevision, setSessionRevision] = useState(0)
  const [archivedThread, setArchivedThread] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(true)
  const [sidebarWide, setSidebarWide] = useState(true)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const lastScrollTop = useRef(0)
  const conversationContentRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const focusComposerRequested = useRef(false)
  const compactDrawerOpen = Boolean(account?.authenticated) && !sidebarWide && sidebarOpen
  const drawerFocus = useModalFocus<HTMLElement>(compactDrawerOpen)
  const accountRefreshGeneration = useRef(0)
  const completedTurns = useRef(new Set<string>())
  const clientTurnIds = useRef(new Map<string, string>())
  const loginIdRef = useRef('')
  const threadIdRef = useRef('')
  const activeTurnIdRef = useRef('')
  const lastEventSequence = useRef(0)
  const lastTurnLifecycleSequence = useRef(0)
  const restoredHistoryRef = useRef<ReadonlyMap<string, CodexTranscriptItem>>(new Map())
  const restoredItemSequencesRef = useRef<ReadonlyMap<string, number>>(new Map())
  const restoredHistorySequenceRef = useRef(0)
  const replayRecoveryRef = useRef(false)
  const threadResumeGeneration = useRef(0)
  const threadStartupController = useRef<AbortController | null>(null)
  const mountedRef = useRef(true)
  const conversationSelection = useRef(0)
  const submission = useRef<{
    threadId: string
    operation: Awaited<ReturnType<typeof prepareCodexOperation>> | null
  } | null>(null)
  const submittingHere = submitting && submission.current?.threadId === threadId
  const submittedOperation = submission.current?.operation
  const submittedTurnId =
    submittedOperation && (submittedOperation.turnId || clientTurnIds.current.get(submittedOperation.id))
  const submittedTurnCompleted = Boolean(submittedTurnId && completedTurns.current.has(submittedTurnId))
  const connectionInterrupted = eventStreamState === 'reconnecting' || error instanceof AgentConnectionError
  const selectedOptions = codexOptionsForSelection(selection, models ?? [])
  const runMatchesThread = Boolean(run && run.runId === runId && run.agentId === agentId && run.threadId === threadId)
  const runCanAcceptApprovals =
    runMatchesThread &&
    (run?.state.phase === 'running' || run?.state.phase === 'waiting_for_approval' || run?.state.phase === 'recovering')
  const canStartTurn =
    runRecovered &&
    Boolean(selectedOptions) &&
    (!run || codexRunIsTerminal(run)) &&
    (!workspaceRun || codexRunIsTerminal(workspaceRun))
  const optionsRef = useRef<TengriCodexOptions>({})
  optionsRef.current = selectedOptions ?? {}
  const accountChecked = account !== null
  const runTurnId =
    run && ('turnId' in run.state && run.state.turnId ? run.state.turnId : clientTurnIds.current.get(run.runId))
  const runPending = Boolean(
    runMatchesThread &&
    run &&
    !codexRunIsTerminal(run) &&
    (run.state.phase === 'cancelling' ||
      run.state.phase === 'needs_reconciliation' ||
      !(runTurnId && completedTurns.current.has(runTurnId))),
  )
  const showStopAction = Boolean(activeTurnId || runPending) && !prompt.trim() && images.length === 0
  const runActivity = runPending && run ? codexRunActivity(run.state) : null
  const responsePending = Boolean(activeTurnId || (submittingHere && !submittedTurnCompleted) || runPending)
  const readingImages = images.some((image) => image.input === null)
  const canChangeConversation = !readingImages

  useEffect(() => {
    if (!archivedThread || readingImages) return
    if (threadIdRef.current === archivedThread) newConversation()
    setArchivedThread('')
  }, [archivedThread, readingImages])

  useEffect(() => {
    if (!connectionInterrupted) {
      setConnectionNotice(false)
      return
    }
    const timer = window.setTimeout(() => setConnectionNotice(true), 3_000)
    return () => window.clearTimeout(timer)
  }, [connectionInterrupted])

  const setCurrentActiveTurnId = useCallback((turnId: string) => {
    activeTurnIdRef.current = turnId
    setActiveTurnId(turnId)
  }, [])

  const retireApproval = useCallback((approvalId: string) => {
    resolvedApprovals.current.add(approvalId)
    retainedEvents.current = retainedEvents.current.filter((event) => event.approvalId !== approvalId)
    setEvents((current) => current.filter((event) => event.approvalId !== approvalId))
    setError((current) =>
      current instanceof ApprovalDeliveryError && current.approvalId === approvalId ? '' : current,
    )
  }, [])

  useEffect(() => {
    setRun(null)
    setRunId('')
  }, [agentId, threadId])

  useEffect(() => {
    if (!account?.authenticated) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastRecoveryFailure: Error | undefined
    setRunRecovered(false)
    async function recover() {
      try {
        const active = await runTengriAction<TengriCodexRun | null>(
          { action: 'active-codex-run', agentId },
          controller.signal,
        )
        if (controller.signal.aborted) return
        if (active && active.agentId !== agentId) throw new Error('Active run belongs to another workspace')
        const recoveredFailure = lastRecoveryFailure
        setError((current) => (current === recoveredFailure ? '' : current))
        setWorkspaceRun(active)
        if (active && ((!threadId && recoverInitialRun.current) || active.threadId === threadId)) {
          if (!threadId) {
            resetTranscriptUi(active.threadId)
            writeStoredThread(agentId, active.threadId)
          }
          setRun(active)
          setRunId(active.runId)
        }
        recoverInitialRun.current = false
        setRunRecovered(true)
        if (active && active.threadId !== threadId) timer = setTimeout(() => void recover(), 2000)
      } catch (cause) {
        if (controller.signal.aborted) return
        lastRecoveryFailure = runRecoveryError(cause, 'Active run recovery failed')
        setError(lastRecoveryFailure)
        timer = setTimeout(() => void recover(), 3000)
      }
    }
    void recover()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [account?.authenticated, agentId, threadId])

  useEffect(() => {
    if (!runId || !threadId) return
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let lastRecoveryFailure: Error | undefined
    async function refresh() {
      try {
        const next = await runTengriAction<TengriCodexRun>({ action: 'codex-run', agentId, runId }, controller.signal)
        if (controller.signal.aborted) return
        if (next.threadId !== threadId || next.agentId !== agentId || next.runId !== runId) {
          throw new Error('Agent run recovery returned a different conversation')
        }
        const recoveredFailure = lastRecoveryFailure
        setError((current) => (current === recoveredFailure ? '' : current))
        setRun(next)
        if (next.state.phase === 'waiting_for_approval' && !completedTurns.current.has(next.state.turnId)) {
          for (const approval of next.state.approvals) {
            const raw = approval.raw as { method?: string; params?: { turnId?: string; itemId?: string } }
            const event = parseCodexEvent(
              JSON.stringify({
                sequence: 0,
                kind: 'approval',
                method: raw.method,
                threadId,
                turnId: raw.params?.turnId || '',
                itemId: raw.params?.itemId || '',
                text: '',
                approvalId: approval.approvalId,
                rawJson: JSON.stringify(raw),
              }),
            )
            if (event && !resolvedApprovals.current.has(event.approvalId))
              setEvents((current) =>
                resolvedApprovals.current.has(event.approvalId) ||
                current.some((candidate) => candidate.approvalId === event.approvalId)
                  ? current
                  : [...current, event],
              )
          }
        }
        if (
          'turnId' in next.state &&
          next.state.turnId &&
          !completedTurns.current.has(next.state.turnId) &&
          !codexRunIsTerminal(next)
        ) {
          setCurrentActiveTurnId(next.state.turnId)
        }
        if (codexRunIsTerminal(next)) {
          setWorkspaceRun((current) => (current?.runId === next.runId ? null : current))
          setCurrentActiveTurnId('')
          if ('reason' in next.state) setError(next.state.reason)
          return
        }
      } catch (cause) {
        if (controller.signal.aborted) return
        lastRecoveryFailure = runRecoveryError(cause, 'Agent run could not be recovered')
        setError(lastRecoveryFailure)
      }
      timer = setTimeout(() => void refresh(), 2000)
    }
    void refresh()
    return () => {
      controller.abort()
      if (timer) clearTimeout(timer)
    }
  }, [agentId, threadId, runId, runPending, setCurrentActiveTurnId])

  useEffect(() => {
    const prompt = promptRef.current
    if (active && prompt && !prompt.disabled && document.activeElement === prompt.closest('[data-window-id]')) {
      prompt.focus({ preventScroll: true })
    }
  }, [account?.authenticated, active, replayRecovering, threadReady])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshAccount = useCallback(
    async (signal?: AbortSignal, clearError = true, expectedLoginId = '') => {
      if (expectedLoginId && loginIdRef.current !== expectedLoginId) return null
      const generation = ++accountRefreshGeneration.current
      try {
        const next = await runTengriAction<TengriCodexAccount>({ action: 'codex-account', agentId }, signal)
        if (
          signal?.aborted ||
          !mountedRef.current ||
          !codexAccountRefreshIsCurrent(
            generation,
            accountRefreshGeneration.current,
            expectedLoginId,
            loginIdRef.current,
          )
        ) {
          return null
        }
        setAccount(next)
        if (next.authenticated) {
          loginIdRef.current = ''
          setLogin(null)
        }
        if (clearError) setError('')
        return next
      } catch (cause) {
        if (
          signal?.aborted ||
          !mountedRef.current ||
          !codexAccountRefreshIsCurrent(
            generation,
            accountRefreshGeneration.current,
            expectedLoginId,
            loginIdRef.current,
          )
        ) {
          return null
        }
        setError(cause instanceof Error ? cause.message : 'Codex account unavailable')
        return null
      }
    },
    [agentId],
  )

  const recoverLogin = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await runTengriAction<TengriCodexLogin | null>({ action: 'codex-login-status', agentId }, signal)
        if (signal?.aborted || !mountedRef.current || loginIdRef.current) return
        if (!next) {
          await refreshAccount(signal, false)
          return
        }
        const expiresAt = Date.parse(next.expiresAt)
        if (!Number.isFinite(expiresAt)) {
          setError('Codex returned an invalid device-login deadline. Start a new login.')
          return
        }
        if (expiresAt <= Date.now()) {
          await refreshAccount(signal, false)
          return
        }
        loginIdRef.current = next.loginId
        setLogin(next)
        setError('')
      } catch (cause) {
        if (!signal?.aborted && mountedRef.current) {
          setError(cause instanceof Error ? cause.message : 'Codex device login state is unavailable')
        }
      }
    },
    [agentId, refreshAccount],
  )

  const refreshAccountAndRecoverLogin = useCallback(
    async (signal?: AbortSignal) => {
      const next = await refreshAccount(signal)
      if (next && !next.authenticated && !signal?.aborted) await recoverLogin(signal)
      return next
    },
    [recoverLogin, refreshAccount],
  )

  useEffect(() => {
    recoverInitialRun.current = true
    setWorkspaceRun(null)
    setAccount(null)
    setModels(null)
    setModelError('')
    setSelection(readStoredSelection(agentId))
    setSelectionWarning('')
    loginIdRef.current = ''
    setLogin(null)
    setThreadReady(false)
    setCurrentActiveTurnId('')
    setHistoryItems([])
    setRestoredHistorySequence(0)
    setEvents([])
    retainedEvents.current = []
    setSubmittedPrompts([])
    setApprovalMode(readApprovalMode(agentId))
    autoApprovalAttempts.current.clear()
    resolvedApprovals.current.clear()
    draftsRef.current.clear()
    creatingDraftRef.current = null
    setRecoverableDrafts([])
    lastScrollTop.current = 0
    setPrompt('')
    setFollowingConversation(true)
    setReplayRecovering(false)
    setRecoveryFailed(false)
    setError('')
    setEventStreamState('connecting')
    completedTurns.current.clear()
    clientTurnIds.current.clear()
    lastEventSequence.current = 0
    lastTurnLifecycleSequence.current = 0
    restoredHistoryRef.current = new Map()
    restoredItemSequencesRef.current = new Map()
    restoredHistorySequenceRef.current = 0
    replayRecoveryRef.current = false
    threadResumeGeneration.current += 1
    const stored = readStoredThread(agentId)
    threadIdRef.current = stored
    setThreadId(stored)
    setSessionRevision(0)
    setArchivedThread('')
  }, [agentId, setCurrentActiveTurnId])

  useLayoutEffect(() => {
    const root = rootRef.current
    if (!root) return
    let previousWide = root.clientWidth >= 560
    setSidebarWide(previousWide)
    setSidebarOpen(previousWide)
    const sync = () => {
      const wide = root.clientWidth >= 560
      if (wide === previousWide) return
      previousWide = wide
      setSidebarWide(wide)
      setSidebarOpen(wide)
    }
    const observer = new ResizeObserver(sync)
    observer.observe(root)
    return () => observer.disconnect()
  }, [account?.authenticated])

  useEffect(() => {
    if (!focusComposerRequested.current || !active || compactDrawerOpen || promptRef.current?.disabled) return
    focusComposerRequested.current = false
    requestAnimationFrame(() => promptRef.current?.focus())
  }, [active, compactDrawerOpen, replayRecovering, submitting, threadId, threadReady])

  useEffect(() => {
    const controller = new AbortController()
    void refreshAccountAndRecoverLogin(controller.signal)
    return () => controller.abort()
  }, [refreshAccountAndRecoverLogin])

  useEffect(() => {
    if (!account?.authenticated) return
    const controller = new AbortController()
    let timer = 0
    let retryDelay = 1_000
    setModels(null)
    setModelError('')
    const load = async () => {
      try {
        const models = await loadCodexModels(agentId, controller.signal)
        if (!controller.signal.aborted) {
          setModels(models)
          setModelError('')
        }
      } catch (cause: unknown) {
        if (!controller.signal.aborted) {
          setModelError(cause instanceof Error ? cause.message : 'Codex models could not be loaded')
          if (retryableReadFailure(cause)) {
            timer = window.setTimeout(() => void load(), retryDelay)
            retryDelay = Math.min(retryDelay * 2, 30_000)
          }
        }
      }
    }
    void load()
    return () => {
      controller.abort()
      window.clearTimeout(timer)
    }
  }, [account?.authenticated, agentId, modelReload])

  useEffect(() => {
    if (!login || account?.authenticated) return
    const expiresAt = Date.parse(login.expiresAt)
    if (!Number.isFinite(expiresAt)) {
      loginIdRef.current = ''
      setLogin(null)
      setError('Codex returned an invalid device-login deadline. Start a new login.')
      return
    }
    let stopped = false
    let timer = 0
    const refresh = async () => {
      if (Date.now() >= expiresAt) {
        loginIdRef.current = ''
        setLogin(null)
        setError('The device code expired. Start a new Codex login.')
        return
      }
      await refreshAccount(undefined, false, login.loginId)
      if (!stopped) timer = window.setTimeout(() => void refresh(), 2_500)
    }
    timer = window.setTimeout(() => void refresh(), 2_500)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [account?.authenticated, login, refreshAccount])

  const commitThreadState = useCallback(
    (thread: TengriCodexThread, commitActiveTurn = true) => {
      const restored = commitThread(agentId, thread, threadIdRef, setThreadId, setHistoryItems)
      setRecoveryFailed(false)
      lastScrollTop.current = 0
      setFollowingConversation(true)
      const sequence = thread.eventSequence
      const restoredById = new Map(restored.historyItems.map((item) => [item.id, item]))
      const itemSequences = new Map(Object.entries(thread.itemEventSequences ?? {}))
      restoredHistoryRef.current = restoredById
      restoredItemSequencesRef.current = itemSequences
      restoredHistorySequenceRef.current = sequence
      setRestoredHistorySequence(sequence)
      retainedEvents.current = reconcileCodexEventsWithRestoredHistory(
        retainedEvents.current,
        restoredById,
        sequence,
        itemSequences,
      )
      setEvents((current) => reconcileCodexEventsWithRestoredHistory(current, restoredById, sequence, itemSequences))
      for (const [clientId, turnId] of restored.clientTurnIds) clientTurnIds.current.set(clientId, turnId)
      for (const turnId of restored.completedTurnIds) completedTurns.current.add(turnId)
      const activeTurnId = codexReconciledActiveTurnId(
        commitActiveTurn ? restored.activeTurnId : activeTurnIdRef.current,
        completedTurns.current,
      )
      setCurrentActiveTurnId(activeTurnId)
      return { ...restored, activeTurnId }
    },
    [agentId, setCurrentActiveTurnId],
  )

  useEffect(() => {
    if (!account?.authenticated || !threadId || threadReady || (!models && !modelError)) return
    const controller = new AbortController()
    threadStartupController.current = controller
    let timer = 0
    let retryDelay = 1_000
    controller.signal.addEventListener('abort', () => window.clearTimeout(timer), { once: true })
    const generation = ++threadResumeGeneration.current
    const current = () =>
      !controller.signal.aborted &&
      codexResumeCommitIsCurrent(generation, threadResumeGeneration.current, threadId, threadIdRef.current)
    const resume = async () => {
      if (!current()) return
      setRecoveryFailed(false)
      const resumeSequence = lastEventSequence.current
      try {
        const thread = await runTengriAction<TengriCodexThread>(
          { action: 'resume-thread', agentId, threadId, ...optionsRef.current },
          controller.signal,
        )
        if (!current()) return
        commitThreadState(thread, lastTurnLifecycleSequence.current <= resumeSequence)
        setThreadReady(true)
        replayRecoveryRef.current = false
        setReplayRecovering(false)
        setError('')
      } catch (cause: unknown) {
        if (current()) {
          setRecoveryFailed(true)
          setError(runRecoveryError(cause, 'This conversation could not be loaded.'))
          if (retryableReadFailure(cause)) {
            timer = window.setTimeout(() => void resume(), retryDelay)
            retryDelay = Math.min(retryDelay * 2, 30_000)
          } else {
            replayRecoveryRef.current = false
            setReplayRecovering(false)
          }
        }
      }
    }
    void resume()
    return () => {
      controller.abort()
      if (threadStartupController.current === controller) threadStartupController.current = null
    }
  }, [
    account?.authenticated,
    agentId,
    commitThreadState,
    modelError,
    models,
    threadId,
    threadReady,
    threadResumeRevision,
  ])

  const recoverThreadState = useCallback(() => {
    if (!threadIdRef.current || replayRecoveryRef.current) return
    threadStartupController.current?.abort()
    replayRecoveryRef.current = true
    setThreadReady(false)
    setReplayRecovering(true)
    setRecoveryFailed(false)
    setError('')
    setThreadResumeRevision((revision) => revision + 1)
  }, [])

  useEffect(() => {
    if (!accountChecked) return
    setEventStreamState('connecting')
    let pending: TengriCodexEvent[] = []
    let frame = 0
    const flush = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (!pending.length) return
      const batch = pending
      pending = []
      const retainedKeys = new Set(retainedEvents.current.map(codexEventKey))
      setEvents((current) =>
        batch.reduce(
          (next, event) =>
            codexEventMatchesThread(event, threadIdRef.current) &&
            !(event.kind === 'approval' && resolvedApprovals.current.has(event.approvalId)) &&
            (!codexEventIsIndependentOfThreadSnapshot(event) || retainedKeys.has(codexEventKey(event)))
              ? appendCodexEventAfterRestore(
                  next,
                  event,
                  restoredHistoryRef.current,
                  restoredHistorySequenceRef.current,
                  restoredItemSequencesRef.current,
                )
              : next,
          current.filter(
            (event) =>
              (event.kind !== 'approval' && !codexEventIsRuntimeError(event)) || retainedKeys.has(codexEventKey(event)),
          ),
        ),
      )
    }
    const onMessage = (message: MessageEvent<string>) => {
      const parsed = parseCodexEvent(message.data)
      if (!parsed) {
        setError('Agent returned an invalid event')
        return
      }
      const currentThread = threadIdRef.current
      const event = codexEventIsRuntimeError(parsed)
        ? parsed
        : { ...parsed, threadId: parsed.threadId || currentThread }
      lastEventSequence.current = Math.max(lastEventSequence.current, event.sequence)
      if (
        ['thread/started', 'thread/name/updated', 'thread/archived', 'thread/unarchived', 'turn/completed'].includes(
          event.method,
        )
      ) {
        setSessionRevision((current) => current + 1)
        if (event.method === 'thread/archived' && event.threadId) setArchivedThread(event.threadId)
      }
      const resolvedApprovalId = codexResolvedApprovalId(event)
      if (resolvedApprovalId) retireApproval(resolvedApprovalId)
      if (event.kind === 'approval' && resolvedApprovals.current.has(event.approvalId)) return
      if (
        codexEventIsIndependentOfThreadSnapshot(event) ||
        codexResolvedApprovalId(event) ||
        codexEventConfirmsRuntimeReady(event) ||
        event.method === 'turn/completed'
      ) {
        retainedEvents.current = appendCodexEvent(retainedEvents.current, event).filter(
          codexEventIsIndependentOfThreadSnapshot,
        )
      }
      if (!codexEventMatchesThread(event, currentThread)) return
      for (const [clientId, turnId] of codexEventClientTurnIds(event)) clientTurnIds.current.set(clientId, turnId)
      const eventMethod = event.method.toLowerCase()
      if (eventMethod === 'account/login/completed') {
        const activeLoginId = loginIdRef.current
        if (codexLoginCompletionIsUncorrelated(event)) {
          void refreshAccount(undefined, false, activeLoginId)
          return
        }
        if (!codexLoginCompletionMatches(event, activeLoginId)) return
      }
      pending.push(event)
      if (pending.length >= 100) flush()
      else if (!frame) frame = requestAnimationFrame(flush)
      if (eventMethod === 'account/login/completed') {
        const completionError = codexLoginCompletionError(event)
        loginIdRef.current = ''
        setLogin(null)
        void refreshAccount(undefined, !completionError).then((next) => {
          if (!next || next.authenticated || !mountedRef.current) return
          setError(completionError || 'Codex device login did not complete. Start a new login.')
        })
      } else if (event.method === 'tengri/replayWarning') {
        void recoverThreadState()
      } else if (event.method === 'turn/started' && event.turnId && !completedTurns.current.has(event.turnId)) {
        lastTurnLifecycleSequence.current = Math.max(lastTurnLifecycleSequence.current, event.sequence)
        setCurrentActiveTurnId(event.turnId)
      } else if (event.method === 'turn/completed' && event.turnId) {
        lastTurnLifecycleSequence.current = Math.max(lastTurnLifecycleSequence.current, event.sequence)
        completedTurns.current.add(event.turnId)
        if (activeTurnIdRef.current === event.turnId) setCurrentActiveTurnId('')
      }
    }
    const stop = watchTengriEvents(
      () => `/api/tengri/events?agentId=${encodeURIComponent(agentId)}&after=${lastEventSequence.current}`,
      {
        onMessage,
        onOpen: () => setEventStreamState('connected'),
        onError: () => {
          reportBrowserFailure('codex.events.reconnect')
          setEventStreamState('reconnecting')
        },
      },
    )
    return () => {
      stop()
      flush()
    }
  }, [accountChecked, agentId, recoverThreadState, refreshAccount, retireApproval, setCurrentActiveTurnId])

  useEffect(() => {
    if (!active || !followingConversation || (threadId && !threadReady)) return
    const conversation = conversationRef.current
    const content = conversationContentRef.current
    if (!conversation || !content) return
    let frame = 0
    const follow = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        conversation.scrollTop = conversation.scrollHeight
        lastScrollTop.current = conversation.scrollTop
      })
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(conversation)
    observer.observe(content)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
    }
  }, [account?.authenticated, active, followingConversation, threadId, threadReady])

  const resizePrompt = useCallback(() => {
    const textarea = promptRef.current
    if (!textarea) return
    const scrollTop = textarea.scrollTop
    textarea.style.height = 'auto'
    textarea.style.height = `${Math.min(textarea.scrollHeight, 160)}px`
    // Measuring a capped draft must not reset the reader's position inside it.
    textarea.scrollTop = scrollTop
  }, [])

  // Commit value and height together so wrapping never paints at the old height.
  useLayoutEffect(() => {
    resizePrompt()
  }, [account?.authenticated, prompt, resizePrompt])

  useEffect(() => {
    const textarea = promptRef.current
    if (!textarea) return
    let width = textarea.clientWidth
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || entry.contentRect.width === width) return
      width = entry.contentRect.width
      resizePrompt()
    })
    observer.observe(textarea)
    return () => observer.disconnect()
  }, [account?.authenticated, resizePrompt])

  const historyIds = useMemo(() => new Set(historyItems.map((item) => item.id)), [historyItems])
  const historyById = useMemo(() => new Map(historyItems.map((item) => [item.id, item])), [historyItems])
  const renderedEvents = useMemo(
    () =>
      events
        .filter((event) => codexEventShouldRender(event, threadId, historyIds, restoredHistorySequence))
        .map((event) => ({ event, text: codexEventDisplayText(event), activityTitle: codexEventActivityTitle(event) }))
        .filter(
          ({ event, text }) =>
            Boolean(text) || event.kind === 'approval' || event.kind === 'warning' || event.kind === 'error',
        ),
    [events, historyIds, restoredHistorySequence, threadId],
  )
  const restoredItemUpdates = useMemo(
    () =>
      new Map(
        renderedEvents
          .filter(({ event }) =>
            codexEventSupersedesRestoredItem(event, historyById.get(event.itemId), restoredHistorySequence),
          )
          .map((update) => [update.event.itemId, update]),
      ),
    [historyById, renderedEvents, restoredHistorySequence],
  )

  const transcriptCards = [
    ...historyItems.map((item) => {
      const update = restoredItemUpdates.get(item.id)
      return {
        id: item.id,
        kind: item.kind,
        text: update?.text ?? item.text,
        card: update ? (
          renderEvent(update)
        ) : (
          <CodexEventCard
            key={`wrap-${threadId}-${item.id}-${item.kind}`}
            agentId={agentId}
            activityTitle={item.activityTitle}
            kind={item.kind}
            text={item.text}
          />
        ),
      }
    }),
    ...renderedEvents
      .filter((update) => restoredItemUpdates.get(update.event.itemId) !== update)
      .map((update) => ({
        id: update.event.itemId || codexEventWrapperKey(update.event),
        kind: update.event.kind,
        text: update.text,
        card: renderEvent(update),
      })),
  ]
  const currentSubmissions = submittedPrompts.filter((prompt) => prompt.threadId === threadId)
  const { pending: pendingPrompts, matches: livePromptMatches } = reconcileSubmittedPrompts(
    transcriptCards,
    currentSubmissions,
  )
  // A live echo can be evicted or excluded by a later snapshot. Retire our accepted
  // copy only once authoritative history contains it, while suppressing live duplicates.
  const { acknowledged, matchedItemIds } = reconcileSubmittedPrompts(historyItems, currentSubmissions)
  useEffect(() => {
    if (acknowledged.size) {
      setSubmittedPrompts((current) =>
        current
          .filter((prompt) => !acknowledged.has(prompt.id))
          .map((prompt) =>
            prompt.threadId === threadId
              ? {
                  ...prompt,
                  previousItemIds: new Set([...prompt.previousItemIds, ...matchedItemIds]),
                }
              : prompt,
          ),
      )
    }
  }, [acknowledged, matchedItemIds, threadId])
  useEffect(() => {
    if (
      !currentSubmissions.some(
        (prompt) => retainSubmittedPromptImages(prompt, livePromptMatches.get(prompt.id)) !== prompt,
      )
    )
      return
    setSubmittedPrompts((current) =>
      current.map((prompt) =>
        prompt.threadId === threadId ? retainSubmittedPromptImages(prompt, livePromptMatches.get(prompt.id)) : prompt,
      ),
    )
  }, [currentSubmissions, livePromptMatches, threadId])
  useEffect(() => {
    if (approvalMode !== 'auto' || !runRecovered || !runCanAcceptApprovals) return
    for (const { event } of renderedEvents) {
      const decision = automaticApprovalDecision(event)
      if (
        !decision ||
        !event.approvalId ||
        autoApprovalAttempts.current.has(event.approvalId) ||
        resolvingApprovals.has(event.approvalId)
      )
        continue
      autoApprovalAttempts.current.add(event.approvalId)
      void resolveApproval(event, decision)
    }
  }, [approvalMode, renderedEvents, resolvingApprovals, resolveApproval, runRecovered, runId, runCanAcceptApprovals])
  for (const { prompt, beforeItemId } of pendingPrompts) {
    const index = transcriptCards.findIndex((item) => item.id === beforeItemId)
    transcriptCards.splice(index < 0 ? transcriptCards.length : index, 0, {
      id: prompt.id,
      kind: 'user-message',
      text: prompt.text,
      card: (
        <CodexEventCard
          key={prompt.id}
          agentId={agentId}
          kind="user-message"
          text={prompt.text}
          images={prompt.images}
        />
      ),
    })
  }

  function renderEvent({ event, text, activityTitle }: (typeof renderedEvents)[number]) {
    const question = codexQuestionRequest(event)
    if (question)
      return (
        <CodexQuestionCard
          key={event.approvalId}
          agentId={agentId}
          runId={runMatchesThread ? runId : ''}
          approvalId={event.approvalId}
          request={question}
          onAnswered={() => retireApproval(event.approvalId)}
        />
      )
    if (
      approvalMode === 'auto' &&
      automaticApprovalDecision(event) &&
      (!autoApprovalAttempts.current.has(event.approvalId) || resolvingApprovals.has(event.approvalId))
    )
      return null
    return (
      <CodexEventCard
        key={codexEventWrapperKey(event)}
        agentId={agentId}
        activityTitle={activityTitle}
        approvalDecisions={event.kind === 'approval' ? codexApprovalDecisions(event) : undefined}
        approvalTitle={codexApprovalTitle(event)}
        approvalId={event.approvalId}
        kind={event.kind}
        onResolveApproval={event.kind === 'approval' ? (decision) => void resolveApproval(event, decision) : undefined}
        resolvingApproval={resolvingApprovals.has(event.approvalId)}
        text={text}
      />
    )
  }

  function commitImages(next: DraftImage[]) {
    imagesRef.current = next
    setImages(next)
  }

  async function pasteImages(files: File[]) {
    if (replayRecovering || (threadId && !threadReady)) return
    const pending = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name || 'Pasted image',
      size: file.size,
      input: null,
    }))
    const next = [...imagesRef.current, ...pending]
    if (
      next.length > MAX_CODEX_IMAGES ||
      next.reduce((total, image) => total + image.size, 0) > MAX_CODEX_TOTAL_IMAGE_BYTES
    ) {
      setError('Attach at most 4 images and 8 MiB total.')
      return
    }
    setError('')
    commitImages(next)
    await Promise.all(
      files.map(async (file, index) => {
        const id = pending[index].id
        try {
          const input = await readCodexImage(file)
          if (mountedRef.current)
            commitImages(imagesRef.current.map((image) => (image.id === id ? { ...image, input } : image)))
        } catch (cause) {
          if (!mountedRef.current) return
          commitImages(imagesRef.current.filter((image) => image.id !== id))
          setError(cause instanceof Error ? cause.message : 'The image could not be read.')
        }
      }),
    )
  }

  async function send() {
    const text = prompt.trim()
    const draftImages = imagesRef.current
    const inputImages = draftImages.flatMap((image) => (image.input ? [image.input] : []))
    if (
      (!text && !inputImages.length) ||
      run?.state.phase === 'needs_reconciliation' ||
      inputImages.length !== draftImages.length ||
      submitting ||
      replayRecovering ||
      replayRecoveryRef.current ||
      (threadId && !threadReady) ||
      (!activeTurnIdRef.current &&
        !canStartTurn &&
        !(run && 'turnId' in run.state && run.state.turnId && completedTurns.current.has(run.state.turnId)))
    )
      return
    if (activeTurnIdRef.current && !runMatchesThread) return
    const selectedConversation = conversationSelection.current
    if (!threadId) creatingDraftRef.current = { selection: selectedConversation }
    submission.current = { threadId, operation: null }
    let submittedThread = threadId
    setSubmitting(true)
    setFollowingConversation(true)
    setError('')
    const previousItemIds = new Set(transcriptCards.map((item) => item.id))
    const submissionId = crypto.randomUUID()
    setSubmittedPrompts((current) => [
      ...current,
      {
        id: submissionId,
        threadId: threadIdRef.current,
        text: [text, ...inputImages.map(() => '[Image]')].filter(Boolean).join('\n'),
        images: inputImages,
        previousItemIds,
      },
    ])
    setPrompt('')
    commitImages([])
    draftsRef.current.delete(threadId)
    let sentOperation: { key: string; id: string } | undefined
    try {
      if (!activeTurnIdRef.current && run && !codexRunIsTerminal(run)) {
        await waitForRunCompletion(agentId, run.runId, threadId)
      }
      const currentThread = await ensureThread(selectedConversation)
      submittedThread = currentThread.id
      submission.current = { threadId: currentThread.id, operation: null }
      const operationKey = `tengri-operation:${agentId}:${currentThread.id}`
      let operation = await prepareCodexOperation(
        operationKey,
        { threadId: currentThread.id, text, images: inputImages },
        currentThread.activeTurnId || '',
        optionsRef.current,
      )
      sentOperation = { key: operationKey, id: operation.id }
      submission.current = { threadId: currentThread.id, operation }
      if (!operation.turnId && JSON.stringify(operation.options) !== JSON.stringify(optionsRef.current)) {
        setSelectionWarning('This retry uses the original message model and reasoning settings.')
      }
      setSubmittedPrompts((current) =>
        current.map((submitted) =>
          submitted.id === submissionId ? { ...submitted, threadId: currentThread.id } : submitted,
        ),
      )
      if (operation.turnId) {
        try {
          await runTengriAction<TengriCodexTurn>({
            action: 'steer-turn',
            runId,
            agentId,
            operationId: operation.id,
            threadId: currentThread.id,
            turnId: operation.turnId,
            text,
            images: inputImages,
          })
        } catch (cause) {
          if (!(cause instanceof TengriRequestError) || cause.code !== 'control_not_dispatched') throw cause
          completeCodexOperation(operationKey, operation.id)
          submission.current = { threadId: currentThread.id, operation: null }
          await waitForRunCompletion(agentId, runId, currentThread.id)
          completedTurns.current.add(operation.turnId)
          if (threadIdRef.current === currentThread.id) setCurrentActiveTurnId('')
          operation = await prepareCodexOperation(
            operationKey,
            { threadId: currentThread.id, text, images: inputImages },
            '',
            operation.options,
          )
          sentOperation = { key: operationKey, id: operation.id }
          submission.current = { threadId: currentThread.id, operation }
        }
      }
      if (!operation.turnId) {
        let accepted: TengriCodexRun
        try {
          accepted = await runTengriAction<TengriCodexRun>({
            action: 'send-turn',
            agentId,
            operationId: operation.id,
            threadId: currentThread.id,
            text,
            images: inputImages,
            ...operation.options,
          })
        } catch (cause) {
          if (!retryableReadFailure(cause)) throw cause
          try {
            const recovered = await runTengriAction<TengriCodexRun | null>({
              action: 'codex-run',
              agentId,
              runId: operation.id,
            })
            if (!recovered) throw cause
            accepted = recovered
          } catch {
            throw cause
          }
        }
        if (accepted.agentId !== agentId || accepted.threadId !== currentThread.id || accepted.runId !== operation.id)
          throw new Error('Message confirmation returned a different conversation')
        if (accepted.state.phase === 'rejected') {
          completeCodexOperation(operationKey, operation.id)
          throw new Error(accepted.state.reason)
        }
        setWorkspaceRun(accepted)
        if (threadIdRef.current === currentThread.id) {
          setRun(accepted)
          setRunId(accepted.runId)
          if (
            !codexRunIsTerminal(accepted) &&
            'turnId' in accepted.state &&
            accepted.state.turnId &&
            !completedTurns.current.has(accepted.state.turnId)
          ) {
            setCurrentActiveTurnId(accepted.state.turnId)
          }
        }
      }
      completeCodexOperation(operationKey, operation.id)
      setSessionRevision((current) => current + 1)
    } catch (cause) {
      if (cause instanceof TengriRequestError && cause.code === 'control_not_dispatched' && sentOperation)
        completeCodexOperation(sentOperation.key, sentOperation.id)
      const stillSelected =
        (submittedThread && threadIdRef.current === submittedThread) ||
        conversationSelection.current === selectedConversation
      if (!submittedThread && !stillSelected && creatingDraftRef.current?.selection === selectedConversation) {
        const nextDraft = creatingDraftRef.current.draft
        setRecoverableDrafts((current) => [
          ...current,
          { id: submissionId, text, images: draftImages },
          ...(nextDraft?.text || nextDraft?.images.length ? [{ id: `${submissionId}:next`, ...nextDraft }] : []),
        ])
        setSubmittedPrompts((current) => current.filter((submitted) => submitted.id !== submissionId))
        return
      }
      const draft = stillSelected
        ? { text: promptRef.current?.value ?? '', images: imagesRef.current }
        : draftsRef.current.get(submittedThread)
      const restoreDraft = !draft?.text && !draft?.images.length
      if (!submittedThread && !restoreDraft) {
        setRecoverableDrafts((current) => [...current, { id: submissionId, text, images: draftImages }])
        setSubmittedPrompts((current) => current.filter((submitted) => submitted.id !== submissionId))
      }
      if (restoreDraft) {
        setSubmittedPrompts((current) => current.filter((submitted) => submitted.id !== submissionId))
        draftsRef.current.set(submittedThread, { text, images: draftImages })
      }
      if (stillSelected) {
        setError(cause instanceof Error ? cause.message : 'Message could not be sent')
        if (restoreDraft) {
          setPrompt(text)
          commitImages(draftImages)
        }
      }
    } finally {
      if (creatingDraftRef.current?.selection === selectedConversation) creatingDraftRef.current = null
      setSubmitting(false)
      submission.current = null
    }
  }

  async function ensureThread(selectedConversation: number) {
    if (threadId && threadReady) {
      return { id: threadId, activeTurnId: activeTurnIdRef.current }
    }
    const resumeSequence = lastEventSequence.current
    const thread = threadId
      ? await runTengriAction<TengriCodexThread>({ action: 'resume-thread', agentId, threadId, ...optionsRef.current })
      : await runTengriAction<TengriCodexThread>({ action: 'create-thread', agentId, ...optionsRef.current })
    if (conversationSelection.current !== selectedConversation) {
      if (!threadId && creatingDraftRef.current?.selection === selectedConversation) {
        const draft = creatingDraftRef.current.draft
        if (draft) draftsRef.current.set(thread.id, draft)
        creatingDraftRef.current = null
      }
      return { id: thread.id, activeTurnId: codexThreadTurnState(thread.rawJson).activeTurnId }
    }
    if (!threadId) {
      creatingDraftRef.current = null
      draftsRef.current.delete('')
      const assignThread = (event: CodexBufferedEvent) =>
        event.threadId || codexEventIsRuntimeError(event) ? event : { ...event, threadId: thread.id }
      retainedEvents.current = retainedEvents.current.map(assignThread)
      const retained = retainedEvents.current.filter((event) => codexEventMatchesThread(event, thread.id))
      setEvents((current) => retained.reduce((next, event) => appendCodexEvent(next, event), current.map(assignThread)))
    }
    const state = commitThreadState(thread, lastTurnLifecycleSequence.current <= resumeSequence)
    setThreadReady(true)
    return { id: thread.id, activeTurnId: state.activeTurnId }
  }

  async function resolveApproval(event: TengriCodexEvent, decision: CodexApprovalDecision) {
    if (
      !event.approvalId ||
      resolvedApprovals.current.has(event.approvalId) ||
      resolvingApprovals.has(event.approvalId)
    )
      return
    const key = `tengri-control:${runId}:${event.approvalId}`
    let operationId: string | undefined
    setResolvingApprovals((current) => new Set(current).add(event.approvalId))
    setError('')
    try {
      if (!runMatchesThread)
        throw new Error('This approval has no durable run identity. Sleep the workspace before starting new work.')
      const op = await prepareCodexOperation(key, { decision }, '')
      operationId = op.id
      await runTengriAction({
        action: 'resolve-approval',
        agentId,
        runId,
        operationId: op.id,
        approvalId: event.approvalId,
        decision,
      })
      completeCodexOperation(key, op.id)
      retireApproval(event.approvalId)
    } catch (cause) {
      if (resolvedApprovals.current.has(event.approvalId)) {
        if (operationId) completeCodexOperation(key, operationId)
        return
      }
      if (cause instanceof TengriRequestError && cause.code === 'control_not_dispatched' && operationId) {
        completeCodexOperation(key, operationId)
        try {
          const current = await runTengriAction<TengriCodexRun>({ action: 'codex-run', agentId, runId })
          if (
            current.agentId === agentId &&
            current.runId === runId &&
            current.threadId === event.threadId &&
            codexRunIsTerminal(current)
          ) {
            retireApproval(event.approvalId)
            return
          }
        } catch {
          reportBrowserFailure('codex.approval.recovery')
        }
      }
      if (threadIdRef.current === event.threadId) setError(new ApprovalDeliveryError(event.approvalId, cause))
    } finally {
      setResolvingApprovals((current) => {
        const next = new Set(current)
        next.delete(event.approvalId)
        return next
      })
    }
  }

  async function startLogin() {
    setLoginBusy(true)
    setError('')
    try {
      const next = await runTengriAction<TengriCodexLogin>({ action: 'codex-login', agentId })
      loginIdRef.current = next.loginId
      setLogin(next)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Codex device login could not be started')
    } finally {
      setLoginBusy(false)
    }
  }

  async function interruptTurn() {
    if (!runMatchesThread || interrupting) return
    const interruptedThread = threadId
    setInterrupting(true)
    setError('')
    try {
      const op = await prepareCodexOperation(`tengri-stop:${runId}`, { runId }, '')
      await runTengriAction({
        action: 'interrupt-turn',
        agentId,
        runId,
        operationId: op.id,
      })
      completeCodexOperation(`tengri-stop:${runId}`, op.id)
    } catch (cause) {
      if (threadIdRef.current === interruptedThread)
        setError(cause instanceof Error ? cause.message : 'Turn could not be interrupted')
    } finally {
      setInterrupting(false)
    }
  }

  function recoverDraft(id: string) {
    if (submitting || !canChangeConversation) return
    const recovered = recoverableDrafts.find((draft) => draft.id === id)
    if (!recovered) return
    const displaced = threadIdRef.current ? draftsRef.current.get('') : { text: prompt, images: imagesRef.current }
    setRecoverableDrafts((current) => [
      ...current.filter((draft) => draft.id !== id),
      ...(displaced?.text || displaced?.images.length ? [{ id: crypto.randomUUID(), ...displaced }] : []),
    ])
    showChat()
    removeStoredThread(agentId)
    resetTranscriptUi('')
    draftsRef.current.delete('')
    setPrompt(recovered.text)
    commitImages(recovered.images)
    focusComposerAfterConversationChange()
  }

  function resetTranscriptUi(nextThreadId: string) {
    const creatingDraft = creatingDraftRef.current
    const leavingCreation = !threadIdRef.current && creatingDraft?.selection === conversationSelection.current
    if (leavingCreation) creatingDraft.draft = { text: prompt, images: imagesRef.current }
    conversationSelection.current += 1
    recoverInitialRun.current = false
    if (!nextThreadId)
      retainedEvents.current = retainedEvents.current.filter(
        (event) => event.threadId || codexEventIsRuntimeError(event),
      )
    if (leavingCreation || (!threadIdRef.current && !nextThreadId)) {
      draftsRef.current.delete('')
    } else {
      draftsRef.current.set(threadIdRef.current, { text: prompt, images: imagesRef.current })
    }
    const draft = draftsRef.current.get(nextThreadId)
    setPrompt(draft?.text ?? '')
    commitImages(draft?.images ?? [])
    threadIdRef.current = nextThreadId
    if (!nextThreadId) setSubmittedPrompts((current) => current.filter((submitted) => submitted.threadId))
    restoredHistoryRef.current = new Map()
    restoredItemSequencesRef.current = new Map()
    restoredHistorySequenceRef.current = 0
    lastScrollTop.current = 0
    threadResumeGeneration.current += 1
    setThreadId(nextThreadId)
    setThreadReady(false)
    setCurrentActiveTurnId('')
    setHistoryItems([])
    setRestoredHistorySequence(0)
    setEvents(retainedEvents.current.filter((event) => codexEventMatchesThread(event, nextThreadId)))
    setFollowingConversation(true)
    setReplayRecovering(false)
    setRecoveryFailed(false)
    replayRecoveryRef.current = false
    setError('')
    completedTurns.current.clear()
    clientTurnIds.current.clear()
  }

  function focusComposerAfterConversationChange() {
    focusComposerRequested.current = true
    // Compact overlay unmounts on the next paint after sidebarOpen flips; wait for that
    // before focusing so keyboard input is not trapped behind the drawer backdrop.
    if (!sidebarWide && sidebarOpen) {
      setSidebarOpen(false)
      return
    }
    requestAnimationFrame(() => {
      if (promptRef.current?.disabled) return
      focusComposerRequested.current = false
      promptRef.current?.focus()
    })
  }

  function newConversation() {
    if (!canChangeConversation) return
    showChat()
    removeStoredThread(agentId)
    resetTranscriptUi('')
    focusComposerAfterConversationChange()
  }

  function switchConversation(nextThreadId: string) {
    if (!canChangeConversation) return
    showChat()
    if (nextThreadId === threadIdRef.current) {
      focusComposerAfterConversationChange()
      return
    }
    writeStoredThread(agentId, nextThreadId)
    resetTranscriptUi(nextThreadId)
    focusComposerAfterConversationChange()
  }

  function selectOptions(next: TengriCodexSelection) {
    setSelection(next)
    const persisted = writeStoredSelection(agentId, next)
    setSelectionWarning(persisted ? '' : 'Browser storage is unavailable. This selection lasts until the tab closes.')
  }

  if (!account) {
    return (
      <div className="grid h-full place-items-center bg-zinc-950 p-8">
        {error ? (
          <div className="max-w-sm text-center">
            <p className="text-copy-14 text-red-200" role="alert">
              {errorMessage}
            </p>
            <button
              type="button"
              className="mt-4 rounded-xl bg-white/9 px-4 py-2 text-label-12 text-white/76 outline-none transition-colors hover:bg-white/13 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none"
              onClick={() => void refreshAccountAndRecoverLogin()}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-label-14 text-zinc-400" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" /> Checking
            Codex login…
          </div>
        )}
      </div>
    )
  }

  if (!account.authenticated) {
    return (
      <CodexLogin
        busy={loginBusy}
        error={errorMessage}
        login={login}
        onRefresh={() => void refreshAccount()}
        onStart={() => void startLogin()}
      />
    )
  }

  const approvalPending = renderedEvents.some(
    ({ event }) =>
      event.kind === 'approval' &&
      event.approvalId &&
      !(
        approvalMode === 'auto' &&
        automaticApprovalDecision(event) &&
        (!autoApprovalAttempts.current.has(event.approvalId) || resolvingApprovals.has(event.approvalId))
      ),
  )
  const conversationLoading = Boolean(
    threadId && !threadReady && (!recoveryFailed || error instanceof AgentConnectionError),
  )
  const agentStatus = connectionNotice
    ? 'Reconnecting'
    : replayRecovering
      ? 'Recovering'
      : renderedEvents.some(({ event }) => codexQuestionRequest(event))
        ? 'Input requested'
        : approvalPending
          ? 'Approval needed'
          : responsePending
            ? 'Working'
            : eventStreamState !== 'connected'
              ? 'Connecting'
              : 'Ready'
  return (
    <div ref={rootRef} className="@container/agent relative isolate flex h-full min-h-0 bg-zinc-950 text-zinc-100">
      {compactDrawerOpen ? (
        <div
          aria-hidden="true"
          className="absolute inset-0 z-20 bg-black/50"
          onClick={() => setSidebarOpen(false)}
          role="presentation"
        />
      ) : null}
      <aside
        ref={drawerFocus.ref}
        data-testid="agent-conversation-sidebar"
        role={compactDrawerOpen ? 'dialog' : undefined}
        aria-modal={compactDrawerOpen || undefined}
        aria-label="Conversations"
        tabIndex={compactDrawerOpen ? -1 : undefined}
        onKeyDown={
          compactDrawerOpen
            ? (event) => {
                drawerFocus.onKeyDown(event)
                if (event.key === 'Escape') {
                  event.preventDefault()
                  setSidebarOpen(false)
                }
              }
            : undefined
        }
        className={cn(
          'z-30 min-h-0 w-[240px] flex-col border-r border-white/[0.08] bg-zinc-950 @[720px]/agent:w-[260px]',
          sidebarOpen ? 'flex' : 'hidden',
          sidebarWide ? 'relative shrink-0' : 'absolute inset-y-0 left-0',
        )}
      >
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <button
            type="button"
            disabled={!canChangeConversation}
            onClick={newConversation}
            className="inline-flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-2 text-label-14 text-zinc-400 outline-none transition-colors hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-35 motion-reduce:transition-none"
            aria-label="New conversation"
          >
            <Plus className="size-3.5" aria-hidden="true" />
            New chat
          </button>
        </div>
        <WorkspacePinnedResources
          onOpen={() => {
            if (!sidebarWide) setSidebarOpen(false)
          }}
        />
        <AgentSessionList
          key={agentId}
          agentId={agentId}
          enabled={account.authenticated}
          selected={threadId ? { id: threadId, unavailable: conversationMissing } : null}
          busyThreadId={
            workspaceRun && !codexRunIsTerminal(workspaceRun)
              ? workspaceRun.threadId
              : activeTurnId || submittingHere
                ? threadId
                : ''
          }
          canSelect={canChangeConversation}
          revision={sessionRevision}
          onSelect={switchConversation}
          onArchived={setArchivedThread}
        />
      </aside>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col" inert={compactDrawerOpen || undefined}>
        <div className="flex h-11 shrink-0 items-center gap-2 px-3">
          <button
            type="button"
            aria-pressed={sidebarOpen}
            aria-label={sidebarOpen ? 'Hide conversations' : 'Show conversations'}
            onClick={() => setSidebarOpen((open) => !open)}
            className="inline-flex size-7 items-center justify-center rounded-md text-zinc-500 outline-none transition-colors hover:bg-white/[0.04] hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none"
          >
            <PanelLeft className="size-3.5" aria-hidden="true" />
          </button>
          <span className="text-heading-14 text-zinc-200">Codex</span>
          <span className="min-w-0 truncate text-label-12 text-zinc-400" aria-label="Agent status">
            {agentStatus}
          </span>
          {!sidebarOpen ? (
            <button
              type="button"
              disabled={!canChangeConversation}
              onClick={newConversation}
              aria-label="New conversation"
              className="ml-auto inline-flex min-h-7 shrink-0 items-center gap-1 rounded-md px-2 text-label-12 text-zinc-500 outline-none transition-colors hover:bg-white/[0.04] hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-35 motion-reduce:transition-none"
            >
              <Plus className="size-3.5" aria-hidden="true" />
              <span className="hidden @[420px]/agent:inline" aria-hidden="true">
                New
              </span>
            </button>
          ) : (
            <span className="ml-auto" />
          )}
        </div>

        <WorkspaceFileTabs>
          <div className="relative min-h-0 flex-1">
            <div
              ref={conversationRef}
              data-testid="agent-conversation-scroll"
              className="tengri-chat-scrollbar h-full overflow-auto px-4 pt-5 pb-10 [scrollbar-gutter:stable] scroll-pb-8 @[540px]/agent:px-6"
              onScroll={(event) => {
                const conversation = event.currentTarget
                if (threadId && !threadReady) {
                  lastScrollTop.current = conversation.scrollTop
                  return
                }
                const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 64
                if (atBottom) setFollowingConversation(true)
                else if (conversation.scrollTop < lastScrollTop.current) setFollowingConversation(false)
                lastScrollTop.current = conversation.scrollTop
              }}
            >
              {conversationLoading ? <ConversationSkeleton /> : null}
              {conversationMissing ? (
                <div
                  role="status"
                  aria-label="Conversation unavailable"
                  className="flex h-full flex-col items-center justify-center gap-3 pb-16 text-center"
                >
                  <p className="text-copy-14 text-zinc-400">This conversation is unavailable.</p>
                  <button
                    type="button"
                    className="rounded-md px-2.5 py-1.5 text-label-13 text-zinc-300 outline-none hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-blue-400"
                    onClick={() => void recoverThreadState()}
                  >
                    Retry
                  </button>
                </div>
              ) : null}
              {(!threadId || threadReady) && transcriptCards.length === 0 && !responsePending ? (
                <EmptyConversation
                  onSelectPrompt={(text) => {
                    setPrompt(text)
                    requestAnimationFrame(() => {
                      const textarea = promptRef.current
                      textarea?.focus()
                      textarea?.setSelectionRange(text.length, text.length)
                    })
                  }}
                />
              ) : null}
              <div
                ref={conversationContentRef}
                className="mx-auto w-full max-w-3xl space-y-6"
                role="log"
                aria-label="Conversation"
                aria-busy={conversationLoading || replayRecovering}
                aria-live="polite"
                aria-relevant="additions text"
              >
                {groupCodexActivity(transcriptCards).map((group) =>
                  group.activity ? (
                    <ToolActivityGroup key={`activity-${threadId}-${group.id}`} count={group.items.length}>
                      {group.items.map((item) => item.card)}
                    </ToolActivityGroup>
                  ) : (
                    group.items[0].card
                  ),
                )}
                {workspaceRun && workspaceRun.threadId !== threadId && !codexRunIsTerminal(workspaceRun) ? (
                  <p role="status" className="text-copy-14 text-zinc-400">
                    Another conversation has an active run.{' '}
                    <button
                      type="button"
                      className="underline"
                      onClick={() => switchConversation(workspaceRun.threadId)}
                    >
                      Open it to continue or stop it
                    </button>
                    .
                  </p>
                ) : null}
                {runActivity ? (
                  <p role="status" aria-label="Agent activity" className="text-copy-14 text-zinc-400">
                    {runActivity}
                  </p>
                ) : null}
                {responsePending && !approvalPending && !runActivity ? (
                  <div className="text-copy-14 text-zinc-400" role="status" aria-label="Agent activity">
                    <span className="tengri-thinking-shimmer inline-block">Thinking</span>
                  </div>
                ) : null}
              </div>
            </div>
            {!followingConversation ? (
              <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
                <button
                  type="button"
                  aria-label="Jump to latest"
                  className="group pointer-events-auto inline-flex size-8 items-center justify-center rounded-full border border-white/[0.08] bg-zinc-950/95 text-zinc-400 outline-none transition-colors hover:bg-zinc-900 hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none"
                  onClick={() => setFollowingConversation(true)}
                >
                  <span
                    aria-hidden="true"
                    data-testid="jump-to-latest-dots"
                    className="inline-flex items-center gap-1 group-hover:hidden group-focus-visible:hidden"
                  >
                    {[0, 1, 2].map((index) => (
                      <span
                        key={index}
                        className="size-1 rounded-full bg-current motion-safe:animate-bounce"
                        style={{ animationDelay: `${index * 150}ms` }}
                      />
                    ))}
                  </span>
                  <ArrowDown
                    aria-hidden="true"
                    data-testid="jump-to-latest-arrow"
                    className="hidden size-3.5 group-hover:block group-focus-visible:block"
                  />
                </button>
              </div>
            ) : null}
          </div>

          <div hidden={conversationMissing} className="shrink-0 px-3 pt-2 pb-3 @[540px]/agent:px-6">
            <div className="mx-auto w-full max-w-3xl">
              {selectionWarning ? (
                <p role="status" className="mb-2 text-label-12 text-amber-200/80">
                  {selectionWarning}
                </p>
              ) : null}
              <StreamStatus
                error={errorMessage}
                state={eventStreamState}
                reconnecting={connectionNotice && !errorMessage}
              />
              {recoverableDrafts.map((draft, index) => (
                <button
                  key={draft.id}
                  type="button"
                  disabled={submitting || !canChangeConversation}
                  className="mb-2 rounded px-1 text-label-12 text-zinc-400 hover:text-zinc-200"
                  onClick={() => recoverDraft(draft.id)}
                >
                  Recover unsent draft {index + 1}
                </button>
              ))}
              {threadId && !threadReady && recoveryFailed && !(error instanceof AgentConnectionError) ? (
                <button
                  type="button"
                  className="mb-2 rounded px-1 text-label-12 text-zinc-400 outline-none hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400"
                  onClick={() => void recoverThreadState()}
                >
                  Retry
                </button>
              ) : null}
              <form
                aria-label="Message composer"
                aria-busy={submittingHere || replayRecovering}
                className="w-full rounded-2xl bg-zinc-900/60 transition-colors focus-within:bg-zinc-900/80 motion-reduce:transition-none"
                onSubmit={(event) => {
                  event.preventDefault()
                  promptRef.current?.focus({ preventScroll: true })
                  void send()
                }}
              >
                <div className="px-3 pt-3 pb-1">
                  <textarea
                    ref={promptRef}
                    data-window-default-focus
                    aria-label={activeTurnId ? 'Steer the current turn' : 'Message your agent'}
                    disabled={replayRecovering || Boolean(threadId && !threadReady)}
                    value={prompt}
                    onChange={(event) => setPrompt(event.target.value)}
                    onPaste={(event) => {
                      const files = Array.from(event.clipboardData.items)
                        .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
                        .flatMap((item) => {
                          const file = item.getAsFile()
                          return file ? [file] : []
                        })
                      if (!files.length) return
                      event.preventDefault()
                      const text = event.clipboardData.getData('text/plain')
                      if (text) {
                        const start = event.currentTarget.selectionStart
                        const end = event.currentTarget.selectionEnd
                        setPrompt((current) => current.slice(0, start) + text + current.slice(end))
                      }
                      void pasteImages(files)
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                        event.preventDefault()
                        void send()
                      }
                    }}
                    rows={1}
                    placeholder={
                      replayRecovering
                        ? 'Recovering conversation…'
                        : activeTurnId
                          ? 'Steer the current turn…'
                          : 'Message your agent…'
                    }
                    className="block max-h-40 min-h-12 w-full min-w-0 resize-none bg-transparent py-1 text-copy-14 text-zinc-100 outline-none placeholder:text-zinc-400 disabled:opacity-60"
                  />
                  {images.length ? (
                    <ul aria-label="Image attachments" className="flex flex-wrap gap-2 pt-2 pb-1">
                      {images.map((image) => (
                        <li
                          key={image.id}
                          className="relative flex h-20 w-24 items-center justify-center overflow-hidden rounded-lg bg-white/[0.03] ring-1 ring-white/[0.08]"
                        >
                          {image.input ? (
                            <img
                              alt={image.name}
                              src={codexImageUrl(image.input)}
                              className="h-full w-full object-cover"
                            />
                          ) : (
                            <LoaderCircle
                              aria-label={`Reading ${image.name}`}
                              className="size-4 animate-spin text-zinc-500 motion-reduce:animate-none"
                            />
                          )}
                          <button
                            type="button"
                            aria-label={`Remove image ${image.name}`}
                            onClick={() =>
                              commitImages(imagesRef.current.filter((candidate) => candidate.id !== image.id))
                            }
                            className="absolute top-1 right-1 grid size-6 place-items-center rounded-full bg-zinc-950/90 text-zinc-200 outline-none ring-1 ring-white/[0.08] transition-colors hover:bg-zinc-800 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none"
                          >
                            <X className="size-3" aria-hidden="true" />
                          </button>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <div className="flex items-end gap-2 px-2 pt-1 pb-2">
                  <Select
                    value={approvalMode}
                    onValueChange={(value) => {
                      const next = value === 'auto' ? 'auto' : 'ask'
                      autoApprovalAttempts.current.clear()
                      setApprovalMode(next)
                      if (!writeApprovalMode(agentId, next))
                        setSelectionWarning(
                          'Browser storage is unavailable. Approval mode lasts until this tab closes.',
                        )
                    }}
                  >
                    <SelectTrigger
                      aria-label="Approvals"
                      title="Automatically approve command, file and connected-app actions while this chat is open. Questions still need your answer."
                      className={cn(composerSelectTriggerClass, 'mb-0.5 shrink-0')}
                    >
                      <SelectValue>{approvalMode === 'auto' ? 'Auto approve' : 'Ask first'}</SelectValue>
                    </SelectTrigger>
                    <SelectContent
                      side="top"
                      align="start"
                      sideOffset={8}
                      alignItemWithTrigger={false}
                      className={cn(composerSelectMenuClass, 'w-48')}
                    >
                      <SelectItem value="ask" className={composerSelectItemClass}>
                        Ask first
                      </SelectItem>
                      <SelectItem value="auto" className={composerSelectItemClass}>
                        Auto approve
                      </SelectItem>
                    </SelectContent>
                  </Select>
                  <CodexModelPicker
                    disabled={Boolean(activeTurnId) || submitting || replayRecovering}
                    error={modelError}
                    models={models}
                    onChange={selectOptions}
                    onRetry={() => setModelReload((version) => version + 1)}
                    selection={selection}
                  />
                  <button
                    type={showStopAction ? 'button' : 'submit'}
                    aria-label={showStopAction ? 'Stop response' : activeTurnId ? 'Steer turn' : 'Send message'}
                    disabled={
                      (showStopAction && !runMatchesThread) ||
                      (Boolean(activeTurnId) && !runMatchesThread) ||
                      (!showStopAction && !prompt.trim() && !images.length) ||
                      readingImages ||
                      submitting ||
                      interrupting ||
                      replayRecovering ||
                      (!showStopAction && !activeTurnId && !canStartTurn) ||
                      Boolean(threadId && !threadReady)
                    }
                    onClick={showStopAction ? () => void interruptTurn() : undefined}
                    className="mb-0.5 grid size-7 shrink-0 place-items-center rounded-full bg-zinc-100 text-zinc-900 outline-none transition-colors hover:bg-white focus-visible:ring-1 focus-visible:ring-blue-400 disabled:bg-zinc-800 disabled:text-zinc-500 motion-reduce:transition-none"
                  >
                    {showStopAction ? (
                      <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                    ) : (
                      <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                    )}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </WorkspaceFileTabs>
      </div>
    </div>
  )
}

export function CodexLogin({
  busy,
  error,
  login,
  onRefresh,
  onStart,
}: {
  busy: boolean
  error: string
  login: TengriCodexLogin | null
  onRefresh: () => void
  onStart: () => void
}) {
  const verificationUrl = safeVerificationUrl(login?.verificationUrl || '')
  return (
    <div className="grid h-full overflow-auto bg-zinc-950 px-6 py-8">
      <div className="m-auto w-full max-w-sm">
        <div className="mb-5 inline-flex size-9 items-center justify-center rounded-lg border border-white/[0.08] bg-zinc-900/60">
          <Command className="size-4 text-zinc-300" aria-hidden="true" />
        </div>
        <h2 className="text-heading-20 text-zinc-100">Connect Codex</h2>
        <p className="mt-2 text-copy-14 text-zinc-400">
          Sign in with your ChatGPT account. Your login stays in this workspace.
        </p>
        {login ? (
          <div className="mt-6 space-y-4">
            <p className="text-label-12 text-zinc-400 uppercase">1. Copy your device code</p>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.08] bg-zinc-950 px-3.5 py-2.5">
              <code className="font-mono text-lg tracking-widest text-zinc-100">{login.userCode}</code>
              <CodexCopyButton key={login.loginId} label="Copy code" value={login.userCode} />
            </div>
            <p className="pt-1 text-label-12 text-zinc-400 uppercase">2. Authorize Codex in your browser</p>
            {verificationUrl ? (
              <a
                className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-blue-600 px-3.5 text-button-14 text-white outline-none transition-colors hover:bg-blue-500 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none"
                href={verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open verification <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : (
              <p role="alert" className="text-label-12 text-amber-200">
                The verification link is unavailable. Restart device login to try again.
              </p>
            )}
            <p className="flex items-center gap-2 text-label-12 text-zinc-400" role="status">
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Waiting for device authorization…
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={onStart}
              className="inline-flex min-h-7 items-center gap-1.5 rounded-md text-label-12 text-zinc-400 outline-none hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40"
            >
              {busy ? (
                <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              ) : null}
              Restart device login
            </button>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onStart}
            className="mt-6 inline-flex min-h-9 items-center gap-2 rounded-lg bg-blue-600 px-4 text-button-14 text-white outline-none transition-colors hover:bg-blue-500 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-45 motion-reduce:transition-none"
          >
            {busy ? (
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            ) : null}
            Start device login
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          disabled={busy}
          className="mt-3 block min-h-7 rounded-md text-label-12 text-zinc-400 outline-none hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          I’ve completed login
        </button>
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-lg border border-red-400/20 bg-red-500/10 px-3 py-2 text-label-12 text-red-200"
          >
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function ConversationSkeleton() {
  return (
    <div className="mx-auto w-full max-w-3xl space-y-8" role="status" aria-label="Loading conversation">
      <span className="sr-only">Loading conversation…</span>
      <div aria-hidden="true" className="space-y-8">
        <div className="ml-auto w-2/3 space-y-2 rounded-2xl bg-zinc-900/60 p-4">
          <Skeleton className="h-3 w-full bg-zinc-800 motion-reduce:animate-none" />
          <Skeleton className="h-3 w-2/3 bg-zinc-800 motion-reduce:animate-none" />
        </div>
        <div className="space-y-3 py-2">
          {['w-5/6', 'w-full', 'w-4/5', 'w-1/2'].map((width) => (
            <Skeleton key={width} className={cn('h-3 bg-zinc-900 motion-reduce:animate-none', width)} />
          ))}
        </div>
      </div>
    </div>
  )
}

function EmptyConversation({ onSelectPrompt }: { onSelectPrompt: (text: string) => void }) {
  const suggestions = [
    { label: 'Explore the project', text: 'Explore this workspace and explain how the project is organized.' },
    {
      label: 'Build a feature',
      text: 'Help me build a feature in this workspace. Start by understanding the project.',
    },
    { label: 'Review recent changes', text: 'Review the recent changes in this workspace for bugs and regressions.' },
    {
      label: 'Fix a failing test',
      text: 'Find a failing test in this workspace, explain the failure, and propose a focused fix.',
    },
  ]
  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center py-10">
      <p className="text-label-14 text-zinc-400">Ask Codex to explore, change, or run something in this workspace.</p>
      <ul className="mt-4 space-y-1.5">
        {suggestions.map((suggestion) => (
          <li key={suggestion.label}>
            <button
              type="button"
              onClick={() => onSelectPrompt(suggestion.text)}
              className="rounded text-left text-label-14 text-zinc-400 outline-none transition-colors hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none"
            >
              {suggestion.label}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

const composerSelectTriggerClass =
  'min-w-0 max-w-full gap-2 rounded-lg border-transparent bg-transparent px-2.5 text-button-12 text-zinc-400 data-[size=default]:h-8 hover:bg-white/5 hover:text-zinc-200 dark:bg-transparent dark:hover:bg-white/5 focus-visible:border-transparent focus-visible:ring-white/15 data-popup-open:bg-white/5 data-popup-open:text-zinc-200 motion-reduce:transition-none'
const composerSelectMenuClass =
  'font-geist w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-white/[0.08] bg-zinc-950 p-1 text-zinc-200 shadow-none motion-reduce:animate-none'
const composerSelectItemClass =
  'min-h-10 rounded-lg px-3 py-2 pr-8 text-label-14 focus:bg-white/8 focus:text-zinc-100 data-highlighted:bg-white/8 data-highlighted:text-zinc-100'

function CodexModelPicker({
  disabled,
  error,
  models,
  onChange,
  onRetry,
  selection,
}: {
  disabled: boolean
  error: string
  models: TengriCodexModel[] | null
  onChange: (selection: TengriCodexSelection) => void
  onRetry: () => void
  selection: TengriCodexSelection
}) {
  const model = models?.find((model) => model.model === selection.model)
  const validSelection = models && codexOptionsForSelection(selection, models)
  const reasoningLabel = `${codexReasoningLabels[selection.reasoningEffort]}${model && !model.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === selection.reasoningEffort) ? ' (unavailable)' : ''}`
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center justify-end gap-0.5 rounded-lg p-0.5">
        <Select
          disabled={disabled || !models?.length}
          onValueChange={(value) => {
            const next = models?.find((model) => model.model === value)
            if (!next) return
            const reasoningEffort = next.supportedReasoningEfforts.some(
              (effort) => effort.reasoningEffort === selection.reasoningEffort,
            )
              ? selection.reasoningEffort
              : next.defaultReasoningEffort
            onChange({ model: next.model, reasoningEffort })
          }}
          value={selection.model}
        >
          <SelectTrigger
            aria-label="Model"
            className={composerSelectTriggerClass}
            title={
              disabled
                ? 'Model settings are available when the response and conversation recovery finish.'
                : model?.description
            }
          >
            <SelectValue>
              {model?.displayName ??
                (models ? `${selection.model} (unavailable)` : error ? 'Models unavailable' : 'Loading models…')}
            </SelectValue>
          </SelectTrigger>
          <SelectContent
            side="top"
            align="end"
            sideOffset={8}
            alignItemWithTrigger={false}
            className={composerSelectMenuClass}
          >
            <SelectGroup>
              <SelectLabel className="px-3 pt-2 pb-1.5 text-label-12 text-zinc-400">Model</SelectLabel>
              {models?.map((model) => (
                <SelectItem
                  key={model.model}
                  value={model.model}
                  className={composerSelectItemClass}
                  title={model.description}
                >
                  {model.displayName}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <Select
          disabled={disabled || !model}
          onValueChange={(value) => {
            if (value !== null) onChange(codexSelectionSchema.parse({ ...selection, reasoningEffort: value }))
          }}
          value={selection.reasoningEffort}
        >
          <SelectTrigger
            aria-label="Reasoning effort"
            className={composerSelectTriggerClass}
            title={
              disabled
                ? 'Reasoning settings are available when the response and conversation recovery finish.'
                : 'Reasoning effort'
            }
          >
            <SelectValue>{reasoningLabel}</SelectValue>
          </SelectTrigger>
          <SelectContent
            side="top"
            align="end"
            sideOffset={8}
            alignItemWithTrigger={false}
            className={`${composerSelectMenuClass} w-60`}
          >
            <SelectGroup>
              <SelectLabel className="px-3 pt-2 pb-1.5 text-label-12 text-zinc-400">Reasoning effort</SelectLabel>
              {model?.supportedReasoningEfforts.map((effort) => (
                <SelectItem
                  key={effort.reasoningEffort}
                  value={effort.reasoningEffort}
                  className={composerSelectItemClass}
                  title={effort.description}
                >
                  {codexReasoningLabels[effort.reasoningEffort]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>
      {error ? (
        <p className="text-label-12 text-amber-200/80" role="alert">
          {error}{' '}
          <button
            type="button"
            className="rounded underline outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            onClick={onRetry}
          >
            Retry models
          </button>
        </p>
      ) : models && !validSelection ? (
        <p className="text-label-12 text-amber-200/80" role="alert">
          {model
            ? 'Choose a supported reasoning effort.'
            : 'This model is unavailable for your Codex account. Choose another model or refresh.'}{' '}
          <button
            type="button"
            className="rounded underline outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
            onClick={onRetry}
          >
            Refresh models
          </button>
        </p>
      ) : null}
    </div>
  )
}

async function loadCodexModels(agentId: string, signal: AbortSignal): Promise<TengriCodexModel[]> {
  const models: TengriCodexModel[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  for (let pageIndex = 0; pageIndex < 8; pageIndex += 1) {
    const page = await runTengriAction<TengriCodexModelPage>({ action: 'codex-models', agentId, cursor }, signal)
    models.push(...page.models)
    if (!page.nextCursor) {
      if (new Set(models.map((model) => model.model)).size !== models.length) {
        throw new Error('The guest returned duplicate Codex models')
      }
      return models
    }
    if (cursors.has(page.nextCursor)) throw new Error('The guest repeated a Codex model page')
    cursors.add(page.nextCursor)
    cursor = page.nextCursor
  }
  throw new Error('The Codex model catalog exceeded its page limit')
}

function readStoredSelection(agentId: string): TengriCodexSelection {
  try {
    const value = localStorage.getItem(`tengri-codex-options:${agentId}`)
    if (value) return codexSelectionSchema.parse(JSON.parse(value))
  } catch {
    return defaultCodexSelection()
  }
  return defaultCodexSelection()
}

function writeStoredSelection(agentId: string, selection: TengriCodexSelection): boolean {
  try {
    localStorage.setItem(`tengri-codex-options:${agentId}`, JSON.stringify(selection))
    return true
  } catch {
    return false
  }
}

function StreamStatus({
  error,
  state,
  reconnecting,
}: {
  error: string
  state: EventStreamState
  reconnecting: boolean
}) {
  return (
    <>
      <span aria-live="polite" className="sr-only" data-state={state} data-testid="agent-event-stream">
        {state === 'connected'
          ? 'Agent event stream connected'
          : state === 'connecting'
            ? 'Agent event stream connecting'
            : 'Agent event stream reconnecting'}
      </span>
      {reconnecting ? (
        <p role="status" className="mx-auto mb-2 w-full text-label-12 text-amber-200/80">
          Reconnecting to your agent…
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mx-auto mb-2 w-full text-label-12 text-amber-200/80">
          {error}
        </p>
      ) : null}
    </>
  )
}

function commitThread(
  agentId: string,
  thread: TengriCodexThread,
  threadRef: { current: string },
  setThreadId: (threadId: string) => void,
  setHistoryItems: (items: CodexTranscriptItem[]) => void,
) {
  threadRef.current = thread.id
  setThreadId(thread.id)
  writeStoredThread(agentId, thread.id)
  const historyItems = codexTranscriptFromThread(thread.rawJson, thread.itemEventSequences)
  setHistoryItems(historyItems)
  return { ...codexThreadTurnState(thread.rawJson), historyItems }
}

function storageKey(agentId: string) {
  return `tengri-thread:${agentId}`
}

function readStoredThread(agentId: string) {
  try {
    return localStorage.getItem(storageKey(agentId)) || ''
  } catch {
    return ''
  }
}

function writeStoredThread(agentId: string, threadId: string) {
  try {
    localStorage.setItem(storageKey(agentId), threadId)
  } catch {
    // Thread resume still works for the current browser lifetime when storage is unavailable.
  }
}

function removeStoredThread(agentId: string) {
  try {
    localStorage.removeItem(storageKey(agentId))
  } catch {
    // A new in-memory conversation can still be created when storage is unavailable.
  }
}

function codexEventWrapperKey(event: TengriCodexEvent) {
  if (event.approvalId) return `wrap-approval-${event.approvalId}`
  if (event.itemId) return `wrap-${event.threadId}-${event.itemId}-${event.kind}`
  return `wrap-${event.sequence}-${event.method}`
}

function retryableReadFailure(cause: unknown) {
  return (
    cause instanceof CodexHistoryInterruptedError ||
    cause instanceof TypeError ||
    (cause instanceof DOMException && cause.name === 'AbortError') ||
    (cause instanceof TengriRequestError &&
      cause.code !== 'model_catalog_invalid' &&
      cause.code !== 'conversation_history_invalid' &&
      (cause.status === 408 || cause.status === 429 || cause.status >= 500))
  )
}

function safeVerificationUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}

function ToolActivityGroup({ count, children }: { count: number; children: ReactNode }) {
  const [expanded, setExpanded] = useState(true)
  const id = useId()
  return (
    <div className="py-1">
      {count > 1 ? (
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={id}
          onClick={() => setExpanded((value) => !value)}
          className="flex min-h-6 items-center gap-2 rounded px-1 py-0.5 text-label-14 text-zinc-400 outline-none hover:text-zinc-200 focus-visible:ring-1 focus-visible:ring-blue-400"
        >
          <Wrench className="size-3.5 shrink-0 opacity-80" aria-hidden="true" />
          Tools and commands
          <ChevronDown
            className={cn('size-3.5 transition-transform motion-reduce:transition-none', !expanded && '-rotate-90')}
            aria-hidden="true"
          />
        </button>
      ) : null}
      <div id={id} hidden={count > 1 && !expanded} className="space-y-0">
        {children}
      </div>
    </div>
  )
}
