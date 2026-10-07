'use client'

import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@proompteng/design/ui'
import { ArrowDown, ArrowUp, ArrowUpRight, Command, ExternalLink, LoaderCircle, Plus, Square, X } from 'lucide-react'
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { CodexEventCard } from './codex-event-card'
import { CodexCopyButton } from './codex-copy-button'
import { TengriMark } from './tengri-mark'
import {
  appendCodexEventAfterRestore,
  codexAccountRefreshIsCurrent,
  codexActiveTurnIdFromThread,
  codexApprovalDecisions,
  codexCanStartNewConversation,
  codexEventDisplayText,
  codexEventMatchesThread,
  codexEventShouldRender,
  codexEventSupersedesRestoredItem,
  codexLoginCompletionError,
  codexLoginCompletionIsUncorrelated,
  codexLoginCompletionMatches,
  codexReconciledActiveTurnId,
  codexResumeCommitIsCurrent,
  codexTranscriptFromThread,
  parseCodexEvent,
  reconcileCodexEventsWithRestoredHistory,
  type CodexApprovalDecision,
  type CodexBufferedEvent,
  type CodexTranscriptItem,
} from './codex-events'
import { runTengriAction, TengriRequestError } from './client'

type EventStreamState = 'connected' | 'connecting' | 'reconnecting'

type DraftImage = { id: string; name: string; size: number; input: TengriCodexImage | null }

export function AgentChat({ active = true, agentId }: { active?: boolean; agentId: string }) {
  const composerHelpId = useId()
  const [account, setAccount] = useState<TengriCodexAccount | null>(null)
  const [login, setLogin] = useState<TengriCodexLogin | null>(null)
  const [models, setModels] = useState<TengriCodexModel[] | null>(null)
  const [modelError, setModelError] = useState('')
  const [modelSelectionUnavailable, setModelSelectionUnavailable] = useState(false)
  const [modelReload, setModelReload] = useState(0)
  const [selection, setSelection] = useState<TengriCodexSelection>(defaultCodexSelection)
  const [selectionWarning, setSelectionWarning] = useState('')
  const [threadId, setThreadId] = useState('')
  const [threadReady, setThreadReady] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState('')
  const [historyItems, setHistoryItems] = useState<CodexTranscriptItem[]>([])
  const [restoredHistorySequence, setRestoredHistorySequence] = useState(0)
  const [events, setEvents] = useState<CodexBufferedEvent[]>([])
  const [prompt, setPrompt] = useState('')
  const [images, setImages] = useState<DraftImage[]>([])
  const imagesRef = useRef<DraftImage[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [replayRecovering, setReplayRecovering] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [resolvingApprovals, setResolvingApprovals] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState<string | Error>('')
  const errorMessage = error instanceof Error ? error.message : error
  const conversationMissing = error instanceof TengriRequestError && error.code === 'conversation_not_found'
  const [eventStreamState, setEventStreamState] = useState<EventStreamState>('connecting')
  const [followingConversation, setFollowingConversation] = useState(true)
  const conversationRef = useRef<HTMLDivElement | null>(null)
  const promptRef = useRef<HTMLTextAreaElement | null>(null)
  const accountRefreshGeneration = useRef(0)
  const completedTurns = useRef(new Set<string>())
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
  const mountedRef = useRef(true)
  const selectedOptions = codexOptionsForSelection(selection, models ?? [])
  const canStartTurn = Boolean(selectedOptions) || modelSelectionUnavailable
  const optionsRef = useRef<TengriCodexOptions>({})
  optionsRef.current = selectedOptions ?? {}
  const accountChecked = account !== null
  const showStopAction = Boolean(activeTurnId) && !prompt.trim() && images.length === 0
  const readingImages = images.some((image) => image.input === null)
  const canStartNewConversation = codexCanStartNewConversation({
    activeTurnId,
    recovering: replayRecovering,
    submitting,
    threadReady,
  })

  const setCurrentActiveTurnId = useCallback((turnId: string) => {
    activeTurnIdRef.current = turnId
    setActiveTurnId(turnId)
  }, [])

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
    setAccount(null)
    setModels(null)
    setModelError('')
    setModelSelectionUnavailable(false)
    setSelection(readStoredSelection(agentId))
    setSelectionWarning('')
    loginIdRef.current = ''
    setLogin(null)
    setThreadReady(false)
    setCurrentActiveTurnId('')
    setHistoryItems([])
    setRestoredHistorySequence(0)
    setEvents([])
    setPrompt('')
    setFollowingConversation(true)
    setReplayRecovering(false)
    setError('')
    setEventStreamState('connecting')
    completedTurns.current.clear()
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
  }, [agentId, setCurrentActiveTurnId])

  useEffect(() => {
    if (!active) return
    const controller = new AbortController()
    void refreshAccountAndRecoverLogin(controller.signal)
    return () => controller.abort()
  }, [active, refreshAccountAndRecoverLogin])

  useEffect(() => {
    if (!active || !account?.authenticated) return
    const controller = new AbortController()
    setModels(null)
    setModelError('')
    setModelSelectionUnavailable(false)
    void loadCodexModels(agentId, controller.signal)
      .then((models) => {
        if (!controller.signal.aborted) setModels(models)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setModelSelectionUnavailable(
            cause instanceof TengriRequestError && cause.code === 'model_selection_unavailable',
          )
          setModelError(cause instanceof Error ? cause.message : 'Codex models could not be loaded')
        }
      })
    return () => controller.abort()
  }, [account?.authenticated, active, agentId, modelReload])

  useEffect(() => {
    if (!active || !login || account?.authenticated) return
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
  }, [account?.authenticated, active, login, refreshAccount])

  const commitThreadState = useCallback(
    (thread: TengriCodexThread, commitActiveTurn = true) => {
      const restored = commitThread(agentId, thread, threadIdRef, setThreadId, setHistoryItems)
      const sequence = thread.eventSequence
      const restoredById = new Map(restored.historyItems.map((item) => [item.id, item]))
      const itemSequences = new Map(Object.entries(thread.itemEventSequences ?? {}))
      restoredHistoryRef.current = restoredById
      restoredItemSequencesRef.current = itemSequences
      restoredHistorySequenceRef.current = sequence
      setRestoredHistorySequence(sequence)
      setEvents((current) => reconcileCodexEventsWithRestoredHistory(current, restoredById, sequence, itemSequences))
      const restoredActiveTurnId = codexReconciledActiveTurnId(restored.activeTurnId, completedTurns.current)
      const activeTurnId = commitActiveTurn ? restoredActiveTurnId : activeTurnIdRef.current
      if (commitActiveTurn) setCurrentActiveTurnId(activeTurnId)
      return { ...restored, activeTurnId }
    },
    [agentId, setCurrentActiveTurnId],
  )

  useEffect(() => {
    if (
      !active ||
      !account?.authenticated ||
      !threadId ||
      threadReady ||
      replayRecoveryRef.current ||
      (!models && !modelError)
    )
      return
    const controller = new AbortController()
    const resumeSequence = lastEventSequence.current
    const generation = ++threadResumeGeneration.current
    void runTengriAction<TengriCodexThread>(
      { action: 'resume-thread', agentId, threadId, ...optionsRef.current },
      controller.signal,
    )
      .then((thread) => {
        if (
          controller.signal.aborted ||
          !codexResumeCommitIsCurrent(generation, threadResumeGeneration.current, threadId, threadIdRef.current)
        ) {
          return
        }
        commitThreadState(thread, lastTurnLifecycleSequence.current <= resumeSequence)
        setThreadReady(true)
        setError('')
      })
      .catch((cause: unknown) => {
        if (
          !controller.signal.aborted &&
          codexResumeCommitIsCurrent(generation, threadResumeGeneration.current, threadId, threadIdRef.current)
        ) {
          setError(cause instanceof Error ? cause : 'Codex thread could not be resumed')
        }
      })
    return () => controller.abort()
  }, [account?.authenticated, active, agentId, commitThreadState, modelError, models, threadId, threadReady])

  const recoverThreadState = useCallback(async () => {
    const currentThread = threadIdRef.current
    if (!currentThread || replayRecoveryRef.current) return
    const recoverySequence = lastEventSequence.current
    replayRecoveryRef.current = true
    const generation = ++threadResumeGeneration.current
    setThreadReady(false)
    setReplayRecovering(true)
    try {
      const thread = await runTengriAction<TengriCodexThread>({
        action: 'resume-thread',
        agentId,
        threadId: currentThread,
        ...optionsRef.current,
      })
      if (
        !mountedRef.current ||
        !codexResumeCommitIsCurrent(generation, threadResumeGeneration.current, currentThread, threadIdRef.current)
      ) {
        return
      }
      commitThreadState(thread, lastTurnLifecycleSequence.current <= recoverySequence)
      setThreadReady(true)
      setError('')
    } catch (cause) {
      if (
        mountedRef.current &&
        codexResumeCommitIsCurrent(generation, threadResumeGeneration.current, currentThread, threadIdRef.current)
      ) {
        setError(cause instanceof Error ? cause : 'Codex thread state could not be refreshed')
      }
    } finally {
      if (generation === threadResumeGeneration.current) {
        replayRecoveryRef.current = false
        if (mountedRef.current && threadIdRef.current === currentThread) setReplayRecovering(false)
      }
    }
  }, [agentId, commitThreadState])

  useEffect(() => {
    if (!active || !accountChecked) return
    setEventStreamState('connecting')
    const source = new EventSource(
      `/api/tengri/events?agentId=${encodeURIComponent(agentId)}&after=${lastEventSequence.current}`,
    )
    source.onmessage = (message) => {
      const event = parseCodexEvent(message.data)
      if (!event) {
        setError('Agent returned an invalid event')
        return
      }
      lastEventSequence.current = Math.max(lastEventSequence.current, event.sequence)
      const currentThread = threadIdRef.current
      if (!codexEventMatchesThread(event, currentThread)) return
      const eventMethod = event.method.toLowerCase()
      if (eventMethod === 'account/login/completed') {
        const activeLoginId = loginIdRef.current
        if (codexLoginCompletionIsUncorrelated(event)) {
          void refreshAccount(undefined, false, activeLoginId)
          return
        }
        if (!codexLoginCompletionMatches(event, activeLoginId)) return
      }
      setEvents((current) =>
        appendCodexEventAfterRestore(
          current,
          event,
          restoredHistoryRef.current,
          restoredHistorySequenceRef.current,
          restoredItemSequencesRef.current,
        ),
      )
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
      } else if (event.method === 'turn/started' && event.turnId) {
        lastTurnLifecycleSequence.current = Math.max(lastTurnLifecycleSequence.current, event.sequence)
        setCurrentActiveTurnId(event.turnId)
      } else if (event.method === 'turn/completed' && event.turnId) {
        lastTurnLifecycleSequence.current = Math.max(lastTurnLifecycleSequence.current, event.sequence)
        completedTurns.current.add(event.turnId)
        if (activeTurnIdRef.current === event.turnId) setCurrentActiveTurnId('')
      }
    }
    source.onopen = () => setEventStreamState('connected')
    source.onerror = () => setEventStreamState('reconnecting')
    return () => source.close()
  }, [accountChecked, active, agentId, recoverThreadState, refreshAccount, setCurrentActiveTurnId])

  useEffect(() => {
    if (!active || !followingConversation) return
    const conversation = conversationRef.current
    if (!conversation) return
    const follow = () => {
      conversation.scrollTop = conversation.scrollHeight
    }
    follow()
    const observer = new ResizeObserver(follow)
    observer.observe(conversation)
    return () => observer.disconnect()
  }, [active, events, followingConversation, historyItems])

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
        .map((event) => ({ event, text: codexEventDisplayText(event) }))
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

  function renderEvent({ event, text }: (typeof renderedEvents)[number]) {
    return (
      <CodexEventCard
        approvalDecisions={codexApprovalDecisions(event)}
        approvalId={event.approvalId}
        key={
          event.approvalId
            ? `approval-${event.approvalId}`
            : event.itemId
              ? `${event.threadId}-${event.itemId}-${event.kind}`
              : `${event.sequence}-${event.method}`
        }
        kind={event.kind}
        onResolveApproval={(decision) => void resolveApproval(event, decision)}
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
    if (submitting || replayRecovering || (threadId && !threadReady)) return
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
      inputImages.length !== draftImages.length ||
      submitting ||
      replayRecovering ||
      replayRecoveryRef.current ||
      (threadId && !threadReady) ||
      (!activeTurnIdRef.current && !canStartTurn)
    )
      return
    setSubmitting(true)
    setFollowingConversation(true)
    setError('')
    setPrompt('')
    commitImages([])
    try {
      const currentThread = await ensureThread()
      if (currentThread.activeTurnId) {
        await runTengriAction<TengriCodexTurn>({
          action: 'steer-turn',
          agentId,
          threadId: currentThread.id,
          turnId: currentThread.activeTurnId,
          text,
          images: inputImages,
        })
      } else {
        const turn = await runTengriAction<TengriCodexTurn>({
          action: 'send-turn',
          agentId,
          threadId: currentThread.id,
          text,
          images: inputImages,
          ...optionsRef.current,
        })
        if (!completedTurns.current.has(turn.id)) setCurrentActiveTurnId(turn.id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message could not be sent')
      setPrompt(text)
      commitImages(draftImages)
    } finally {
      setSubmitting(false)
    }
  }

  async function ensureThread() {
    if (threadId && threadReady) return { id: threadId, activeTurnId: activeTurnIdRef.current }
    const resumeSequence = lastEventSequence.current
    const thread = threadId
      ? await runTengriAction<TengriCodexThread>({ action: 'resume-thread', agentId, threadId, ...optionsRef.current })
      : await runTengriAction<TengriCodexThread>({ action: 'create-thread', agentId, ...optionsRef.current })
    const state = commitThreadState(thread, lastTurnLifecycleSequence.current <= resumeSequence)
    setThreadReady(true)
    return { id: thread.id, activeTurnId: state.activeTurnId }
  }

  async function resolveApproval(event: TengriCodexEvent, decision: CodexApprovalDecision) {
    if (!event.approvalId || resolvingApprovals.has(event.approvalId)) return
    setResolvingApprovals((current) => new Set(current).add(event.approvalId))
    setError('')
    try {
      await runTengriAction({ action: 'resolve-approval', agentId, approvalId: event.approvalId, decision })
      setEvents((current) => current.filter((candidate) => candidate.approvalId !== event.approvalId))
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Approval could not be resolved')
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
    if (!activeTurnId || interrupting) return
    setInterrupting(true)
    setError('')
    try {
      await runTengriAction({ action: 'interrupt-turn', agentId, threadId, turnId: activeTurnId })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Turn could not be interrupted')
    } finally {
      setInterrupting(false)
    }
  }

  function newConversation() {
    if (
      !codexCanStartNewConversation({
        activeTurnId,
        recovering: replayRecovering || replayRecoveryRef.current,
        submitting,
        threadReady,
      })
    ) {
      return
    }
    removeStoredThread(agentId)
    threadIdRef.current = ''
    restoredHistoryRef.current = new Map()
    restoredItemSequencesRef.current = new Map()
    restoredHistorySequenceRef.current = 0
    threadResumeGeneration.current += 1
    setThreadId('')
    setThreadReady(false)
    setCurrentActiveTurnId('')
    setHistoryItems([])
    setRestoredHistorySequence(0)
    setEvents([])
    setFollowingConversation(true)
    setReplayRecovering(false)
    setError('')
    completedTurns.current.clear()
    requestAnimationFrame(() => promptRef.current?.focus())
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
            <p className="text-sm leading-6 text-red-200" role="alert">
              {errorMessage}
            </p>
            <button
              type="button"
              className="mt-4 rounded-xl bg-white/9 px-4 py-2 text-xs text-white/76 outline-none transition-colors hover:bg-white/13 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none"
              onClick={() => void refreshAccountAndRecoverLogin()}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-zinc-400" role="status">
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

  const approvalPending = renderedEvents.some(({ event }) => event.kind === 'approval' && event.approvalId)
  const agentStatus =
    eventStreamState === 'reconnecting'
      ? 'Reconnecting'
      : replayRecovering
        ? 'Recovering'
        : approvalPending
          ? 'Approval needed'
          : activeTurnId || submitting
            ? 'Working'
            : eventStreamState === 'connecting'
              ? 'Connecting'
              : 'Ready'
  const agentStatusTone =
    agentStatus === 'Approval needed' || agentStatus === 'Reconnecting' || agentStatus === 'Recovering'
      ? 'amber'
      : agentStatus === 'Working'
        ? 'blue'
        : agentStatus === 'Connecting'
          ? 'zinc'
          : 'ready'

  return (
    <div className="@container/agent flex h-full min-h-0 flex-col bg-zinc-950">
      <div className="flex min-h-12 shrink-0 items-center gap-3 border-b border-zinc-800/90 px-4">
        <span className="text-sm font-medium tracking-tight text-zinc-100">Codex</span>
        <span
          className={cn(
            'inline-flex min-w-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium ring-1',
            agentStatusTone === 'amber' && 'bg-amber-300/10 text-amber-100 ring-amber-300/20',
            agentStatusTone === 'blue' && 'bg-blue-400/10 text-blue-100 ring-blue-400/20',
            agentStatusTone === 'zinc' && 'bg-zinc-800/80 text-zinc-300 ring-zinc-700/80',
            agentStatusTone === 'ready' && 'bg-zinc-900/80 text-zinc-400 ring-zinc-800',
          )}
          aria-label="Agent status"
        >
          <span
            className={cn(
              'size-1.5 shrink-0 rounded-full',
              agentStatusTone === 'amber' && 'bg-amber-300',
              agentStatusTone === 'blue' && 'bg-blue-400 motion-safe:animate-pulse',
              agentStatusTone === 'zinc' && 'bg-zinc-400 motion-safe:animate-pulse',
              agentStatusTone === 'ready' && 'bg-emerald-400/80',
            )}
            aria-hidden="true"
          />
          {agentStatus}
        </span>
        <button
          type="button"
          disabled={!canStartNewConversation}
          onClick={newConversation}
          className="ml-auto inline-flex min-h-8 shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-xs text-zinc-400 outline-none transition-colors hover:bg-zinc-800/90 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-35 motion-reduce:transition-none"
        >
          <Plus className="size-3.5" aria-hidden="true" />{' '}
          <span className="hidden @[420px]/agent:inline">New conversation</span>
          <span className="@[420px]/agent:hidden">New</span>
          <span className="sr-only @[420px]/agent:hidden"> conversation</span>
        </button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-10 h-7 bg-gradient-to-b from-zinc-950 via-zinc-950/70 to-transparent"
        />
        <div
          ref={conversationRef}
          data-testid="agent-conversation-scroll"
          className="h-full overflow-auto px-4 pt-6 pb-12 [scrollbar-gutter:stable] scroll-pb-8 @[540px]/agent:px-8"
          onScroll={(event) => {
            const conversation = event.currentTarget
            setFollowingConversation(
              conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 64,
            )
          }}
        >
          {historyItems.length === 0 && renderedEvents.length === 0 && !activeTurnId && !submitting ? (
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
            className="mx-auto w-full max-w-3xl space-y-5"
            role="log"
            aria-label="Conversation"
            aria-live="polite"
            aria-relevant="additions text"
          >
            {[
              ...historyItems.map((item) => {
                const update = restoredItemUpdates.get(item.id)
                return update ? (
                  <div key={`history-${item.id}`} className="tengri-message-enter">
                    {renderEvent(update)}
                  </div>
                ) : (
                  <div key={`${threadId}-${item.id}-${item.kind}`} className="tengri-message-enter">
                    <CodexEventCard kind={item.kind} text={item.text} />
                  </div>
                )
              }),
              ...renderedEvents
                .filter((update) => restoredItemUpdates.get(update.event.itemId) !== update)
                .map((update) => (
                  <div
                    key={
                      update.event.approvalId
                        ? `wrap-approval-${update.event.approvalId}`
                        : update.event.itemId
                          ? `wrap-${update.event.threadId}-${update.event.itemId}-${update.event.kind}`
                          : `wrap-${update.event.sequence}-${update.event.method}`
                    }
                    className="tengri-message-enter"
                  >
                    {renderEvent(update)}
                  </div>
                )),
            ]}
            {activeTurnId && !approvalPending ? (
              <div
                className="tengri-message-enter text-sm leading-6 text-zinc-400"
                role="status"
                aria-label="Agent activity"
              >
                <span className="tengri-thinking-shimmer inline-block">Thinking</span>
                <span
                  aria-hidden="true"
                  className="tengri-thinking-activity mt-2.5 block h-px w-16 rounded-full bg-zinc-500/70"
                />
              </div>
            ) : null}
          </div>
        </div>
        {!followingConversation ? (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center">
            <button
              type="button"
              className="pointer-events-auto inline-flex min-h-8 items-center gap-2 rounded-full border border-white/10 bg-zinc-900/75 px-3 text-xs text-zinc-200 shadow-[0_8px_28px_rgba(0,0,0,0.35)] outline-none backdrop-blur-md transition-colors hover:bg-zinc-800/90 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none"
              onClick={() => setFollowingConversation(true)}
            >
              <ArrowDown className="size-3.5" aria-hidden="true" />
              Jump to latest
            </button>
          </div>
        ) : null}
      </div>
      <div className="shrink-0 border-t border-zinc-900/80 bg-zinc-950/95 px-4 pt-3 pb-4 @[540px]/agent:px-8">
        <div className="mx-auto w-full max-w-3xl">
          {selectionWarning ? (
            <p role="status" className="mb-2 text-xs text-amber-200/80">
              {selectionWarning}
            </p>
          ) : null}
          <StreamStatus error={errorMessage} state={eventStreamState} />
          {replayRecovering ? (
            <p className="mx-auto mb-2 w-full text-xs text-white/45" role="status">
              Recovering the active conversation…
            </p>
          ) : threadId && !threadReady ? (
            <div className="mx-auto mb-3 w-full text-xs">
              {conversationMissing ? (
                <p className="mb-2 text-white/60">
                  This saved conversation is no longer available. Start a new conversation to continue in this
                  workspace.
                </p>
              ) : null}
              <div className="flex items-center justify-center gap-3">
                <button
                  type="button"
                  className="rounded text-[#79b8ff] outline-none hover:text-[#9bcaff] focus-visible:ring-2 focus-visible:ring-white/50"
                  onClick={() => void recoverThreadState()}
                >
                  Retry conversation recovery
                </button>
                {conversationMissing ? (
                  <button
                    type="button"
                    disabled={!canStartNewConversation}
                    className="rounded-lg bg-white/10 px-3 py-2 text-white/85 outline-none hover:bg-white/15 focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-35"
                    onClick={newConversation}
                  >
                    Start a new conversation
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          <form
            aria-label="Message composer"
            aria-busy={replayRecovering}
            className="w-full rounded-2xl border border-white/[0.07] bg-zinc-900/70 shadow-[0_10px_36px_rgba(0,0,0,0.28)] transition-[border-color,box-shadow] focus-within:border-blue-400/35 focus-within:shadow-[0_0_0_1px_rgba(96,165,250,0.18),0_12px_40px_rgba(0,0,0,0.34)] motion-reduce:transition-none"
            onSubmit={(event) => {
              event.preventDefault()
              void send()
            }}
          >
            <div className="px-4 pt-3.5 pb-1">
              <textarea
                ref={promptRef}
                data-window-default-focus
                aria-label={activeTurnId ? 'Steer the current turn' : 'Message your agent'}
                aria-describedby={composerHelpId}
                disabled={submitting || replayRecovering || Boolean(threadId && !threadReady)}
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
                className="block max-h-40 min-h-12 w-full min-w-0 resize-none bg-transparent py-1 text-sm leading-6 text-zinc-100 outline-none placeholder:text-zinc-500 disabled:opacity-60"
              />
              {images.length ? (
                <ul aria-label="Image attachments" className="flex flex-wrap gap-2 pt-2 pb-1">
                  {images.map((image) => (
                    <li
                      key={image.id}
                      className="relative flex h-20 w-24 items-center justify-center overflow-hidden rounded-xl bg-white/5 ring-1 ring-white/10"
                    >
                      {image.input ? (
                        <img alt={image.name} src={codexImageUrl(image.input)} className="h-full w-full object-cover" />
                      ) : (
                        <LoaderCircle
                          aria-label={`Reading ${image.name}`}
                          className="size-4 animate-spin text-zinc-400 motion-reduce:animate-none"
                        />
                      )}
                      <button
                        type="button"
                        aria-label={`Remove image ${image.name}`}
                        disabled={submitting}
                        onClick={() => commitImages(imagesRef.current.filter((candidate) => candidate.id !== image.id))}
                        className="absolute top-1 right-1 grid size-7 place-items-center rounded-full bg-zinc-950/90 text-zinc-100 outline-none ring-1 ring-white/15 transition-colors hover:bg-zinc-700 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none"
                      >
                        <X className="size-3.5" aria-hidden="true" />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <div className="flex items-end gap-2 border-t border-white/[0.04] px-2 pt-1.5 pb-2">
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
                  (!showStopAction && !prompt.trim() && !images.length) ||
                  readingImages ||
                  submitting ||
                  interrupting ||
                  replayRecovering ||
                  (!activeTurnId && !canStartTurn) ||
                  Boolean(threadId && !threadReady)
                }
                onClick={showStopAction ? () => void interruptTurn() : undefined}
                className={cn(
                  'mb-0.5 grid size-8 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-2 focus-visible:ring-blue-400 disabled:bg-zinc-700 disabled:text-zinc-400 motion-reduce:transition-none',
                  showStopAction
                    ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
                    : 'bg-zinc-100 text-zinc-900 hover:bg-white enabled:shadow-[0_0_0_1px_rgba(255,255,255,0.08)]',
                )}
              >
                {submitting || interrupting ? (
                  <LoaderCircle className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                ) : showStopAction ? (
                  <Square className="h-3.5 w-3.5 fill-current" aria-hidden="true" />
                ) : (
                  <ArrowUp className="h-4 w-4" aria-hidden="true" />
                )}
              </button>
            </div>
          </form>
          <p id={composerHelpId} className="mt-2 text-center text-[11px] leading-4 text-zinc-600">
            {activeTurnId
              ? 'Enter to steer · Stop ends the response'
              : 'Enter to send · Shift + Enter for a new line · Paste images to attach'}
          </p>
        </div>
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
    <div className="relative grid h-full overflow-auto bg-zinc-950 px-6 py-8">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-48 bg-[radial-gradient(ellipse_at_top,rgba(59,130,246,0.12),transparent_65%)]"
      />
      <div className="relative m-auto w-full max-w-sm">
        <div className="mb-6 inline-flex size-11 items-center justify-center rounded-2xl border border-white/10 bg-zinc-900/80 shadow-[inset_0_1px_0_rgba(255,255,255,0.04)]">
          <Command className="size-5 text-zinc-200" aria-hidden="true" />
        </div>
        <h2 className="text-2xl font-semibold tracking-tight text-zinc-50">Connect Codex</h2>
        <p className="mt-3 text-sm leading-6 text-zinc-400">
          Sign in with your ChatGPT account. Your login stays in this workspace.
        </p>
        {login ? (
          <div className="mt-7 space-y-4">
            <p className="text-xs font-medium tracking-wide text-zinc-500 uppercase">1. Copy your device code</p>
            <div className="flex items-center justify-between gap-3 rounded-xl border border-zinc-700/80 bg-zinc-900/70 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.03)]">
              <code className="font-mono text-xl tracking-widest text-zinc-50">{login.userCode}</code>
              <CodexCopyButton key={login.loginId} label="Copy code" value={login.userCode} />
            </div>
            <p className="pt-2 text-xs font-medium tracking-wide text-zinc-500 uppercase">
              2. Authorize Codex in your browser
            </p>
            {verificationUrl ? (
              <a
                className="inline-flex min-h-10 items-center gap-2 rounded-xl bg-blue-600 px-4 text-sm font-medium text-white outline-none transition-colors hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300 motion-reduce:transition-none"
                href={verificationUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Open verification <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            ) : (
              <p role="alert" className="text-xs text-amber-200">
                The verification link is unavailable. Restart device login to try again.
              </p>
            )}
            <p className="flex items-center gap-2 text-xs text-zinc-400" role="status">
              <LoaderCircle className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Waiting for device authorization…
            </p>
            <button
              type="button"
              disabled={busy}
              onClick={onStart}
              className="inline-flex min-h-8 items-center gap-1.5 rounded-md text-xs text-zinc-400 outline-none hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
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
            className="mt-7 inline-flex min-h-11 items-center gap-2 rounded-xl bg-blue-600 px-5 text-sm font-medium text-white outline-none transition-colors hover:bg-blue-500 focus-visible:ring-2 focus-visible:ring-blue-300 disabled:opacity-45 motion-reduce:transition-none"
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
          className="mt-4 block min-h-8 rounded-md text-xs text-zinc-400 outline-none hover:text-zinc-200 focus-visible:ring-2 focus-visible:ring-blue-400 disabled:opacity-40"
        >
          I’ve completed login
        </button>
        {error ? (
          <p
            role="alert"
            className="mt-3 rounded-xl bg-red-500/10 px-3 py-2 text-xs text-red-200 ring-1 ring-red-400/20"
          >
            {error}
          </p>
        ) : null}
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
    <div className="relative mx-auto flex min-h-full w-full max-w-3xl flex-col items-center justify-center py-8 text-center">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-56 w-56 -translate-x-1/2 -translate-y-[62%] rounded-full bg-[radial-gradient(circle,rgba(96,165,250,0.14),transparent_68%)] blur-2xl"
      />
      <div className="relative mb-5 inline-flex size-12 items-center justify-center rounded-2xl border border-white/10 bg-zinc-900/70 shadow-[0_12px_40px_rgba(0,0,0,0.35)]">
        <TengriMark />
      </div>
      <h2 className="relative text-2xl font-semibold tracking-tight text-zinc-50">Let’s build</h2>
      <p className="relative mt-2 max-w-md text-sm leading-6 text-zinc-400">
        Explore, change, or run something in your workspace. Pick a starter or write your own.
      </p>
      <div className="relative mt-7 grid w-full max-w-xl grid-cols-1 gap-2 sm:grid-cols-2">
        {suggestions.map((suggestion) => (
          <button
            key={suggestion.label}
            type="button"
            onClick={() => onSelectPrompt(suggestion.text)}
            className="group inline-flex min-h-11 items-center justify-between gap-3 rounded-2xl border border-zinc-800/90 bg-zinc-900/45 px-3.5 text-left text-xs text-zinc-300 outline-none transition-colors hover:border-zinc-700 hover:bg-zinc-800/70 hover:text-zinc-100 focus-visible:ring-2 focus-visible:ring-blue-400 motion-reduce:transition-none"
          >
            <span className="min-w-0 font-medium">{suggestion.label}</span>
            <ArrowUpRight
              className="size-3.5 shrink-0 text-zinc-500 transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-zinc-300 motion-reduce:transition-none"
              aria-hidden="true"
            />
          </button>
        ))}
      </div>
    </div>
  )
}

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
  const triggerClass =
    'min-w-0 max-w-full gap-2 rounded-lg border-transparent bg-transparent px-2.5 text-xs text-zinc-500 data-[size=default]:h-8 hover:bg-white/5 hover:text-zinc-200 dark:bg-transparent dark:hover:bg-white/5 focus-visible:border-transparent focus-visible:ring-white/15 data-popup-open:bg-white/5 data-popup-open:text-zinc-200 motion-reduce:transition-none'
  const menuClass =
    'font-system w-72 max-w-[calc(100vw-2rem)] rounded-xl bg-zinc-900/95 p-1 text-zinc-200 shadow-[0_12px_40px_rgba(0,0,0,0.45)] ring-white/10 backdrop-blur-xl motion-reduce:animate-none'
  const itemClass =
    'min-h-10 rounded-lg px-3 py-2 pr-8 text-sm focus:bg-white/8 focus:text-zinc-100 data-highlighted:bg-white/8 data-highlighted:text-zinc-100'
  const reasoningLabel =
    selection.reasoningEffort === 'default'
      ? model
        ? `Default (${codexReasoningLabels[model.defaultReasoningEffort]})`
        : 'Default'
      : `${codexReasoningLabels[selection.reasoningEffort]}${model?.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === selection.reasoningEffort) ? '' : ' (unavailable)'}`
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center justify-end gap-0.5 rounded-xl bg-white/[0.02] p-0.5">
        <Select
          disabled={disabled || !models?.length}
          onValueChange={(value) => {
            const next = models?.find((model) => model.model === value)
            if (!next) return
            const reasoningEffort =
              selection.reasoningEffort === 'default' ||
              next.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === selection.reasoningEffort)
                ? selection.reasoningEffort
                : 'default'
            onChange({ model: next.model, reasoningEffort })
          }}
          value={selection.model}
        >
          <SelectTrigger
            aria-label="Model"
            className={triggerClass}
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
          <SelectContent side="top" align="end" sideOffset={8} alignItemWithTrigger={false} className={menuClass}>
            <SelectGroup>
              <SelectLabel className="px-3 pt-2 pb-1.5 text-[11px] font-medium text-zinc-400">Model</SelectLabel>
              {models?.map((model) => (
                <SelectItem key={model.model} value={model.model} className={itemClass} title={model.description}>
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
            className={triggerClass}
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
            className={`${menuClass} w-60`}
          >
            <SelectGroup>
              <SelectLabel className="px-3 pt-2 pb-1.5 text-[11px] font-medium text-zinc-400">
                Reasoning effort
              </SelectLabel>
              <SelectItem value="default" className={itemClass}>
                {model ? `Default (${codexReasoningLabels[model.defaultReasoningEffort]})` : 'Default'}
              </SelectItem>
              {model?.supportedReasoningEfforts.map((effort) => (
                <SelectItem
                  key={effort.reasoningEffort}
                  value={effort.reasoningEffort}
                  className={itemClass}
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
        <p className="text-xs text-amber-200/80" role="alert">
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
        <p className="text-xs text-amber-200/80" role="alert">
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

function StreamStatus({ error, state }: { error: string; state: EventStreamState }) {
  return (
    <>
      <span aria-live="polite" className="sr-only" data-state={state} data-testid="agent-event-stream">
        {state === 'connected'
          ? 'Agent event stream connected'
          : state === 'connecting'
            ? 'Agent event stream connecting'
            : 'Agent event stream reconnecting'}
      </span>
      {state === 'reconnecting' ? (
        <p role="status" className="mx-auto mb-2 w-full text-xs text-amber-200/80">
          Agent event stream is reconnecting
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mx-auto mb-2 w-full text-xs text-amber-200/80">
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
  return { activeTurnId: codexActiveTurnIdFromThread(thread.rawJson), historyItems }
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

function safeVerificationUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}
