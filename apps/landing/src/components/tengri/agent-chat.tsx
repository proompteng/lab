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
import { ArrowDown, ArrowUp, Command, ExternalLink, LoaderCircle, PanelLeft, Plus, Square, X } from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import {
  conversationTitleFromRegistry,
  markStoredConversationUnavailable,
  mergePersistedConversationRegistry,
  promoteAcceptedConversationTitle,
  readStoredConversations,
  resolveConversationTitle,
  touchStoredConversation,
  truncateConversationTitle,
  upsertStoredConversation,
  type StoredConversation,
} from './agent-conversation-storage'
import { CodexEventCard } from './codex-event-card'
import { CodexCopyButton } from './codex-copy-button'
import {
  appendCodexEvent,
  appendCodexEventAfterRestore,
  codexAccountRefreshIsCurrent,
  codexActiveTurnIdFromThread,
  codexApprovalDecisions,
  codexEventDisplayText,
  codexEventIsIndependentOfThreadSnapshot,
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
  type CodexApprovalDecision,
  type CodexBufferedEvent,
  type CodexTranscriptItem,
  type SubmittedPrompt,
} from './codex-events'
import { runTengriAction, TengriRequestError } from './client'
import { useModalFocus } from './modal-focus'

type EventStreamState = 'connected' | 'connecting' | 'reconnecting'

type DraftImage = { id: string; name: string; size: number; input: TengriCodexImage | null }

export function AgentChat({ active = true, agentId }: { active?: boolean; agentId: string }) {
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
  const retainedEvents = useRef<CodexBufferedEvent[]>([])
  const [submittedPrompts, setSubmittedPrompts] = useState<SubmittedPrompt[]>([])
  const [prompt, setPrompt] = useState('')
  const [images, setImages] = useState<DraftImage[]>([])
  const imagesRef = useRef<DraftImage[]>([])
  const draftsRef = useRef(new Map<string, { text: string; images: DraftImage[] }>())
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
  const [conversations, setConversations] = useState<StoredConversation[]>([])
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
  const canChangeConversation = !submitting && !interrupting && !readingImages && resolvingApprovals.size === 0

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
    retainedEvents.current = []
    setSubmittedPrompts([])
    draftsRef.current.clear()
    lastScrollTop.current = 0
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
    setConversations(readStoredConversations(agentId))
  }, [agentId, setCurrentActiveTurnId])

  useEffect(() => {
    if (!conversationMissing || !threadId) return
    setConversations((current) => markStoredConversationUnavailable(agentId, threadId, current))
  }, [agentId, conversationMissing, threadId])

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
      setConversations((current) => {
        const registry = mergePersistedConversationRegistry(current, readStoredConversations(agentId))
        const title = resolveConversationTitle(
          conversationTitleFromRegistry(registry, thread.id),
          titleFromTranscript(restored.historyItems),
        )
        const existing = registry.find((conversation) => conversation.id === thread.id)
        const updatedAt = existing?.unavailable
          ? Math.max(Date.now(), existing.updatedAt + 1)
          : (existing?.updatedAt ?? Date.now())
        return upsertStoredConversation(agentId, { id: thread.id, title, updatedAt }, registry)
      })
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
            event.threadId === threadIdRef.current &&
            (!codexEventIsIndependentOfThreadSnapshot(event) || retainedKeys.has(codexEventKey(event)))
              ? appendCodexEventAfterRestore(
                  next,
                  event,
                  restoredHistoryRef.current,
                  restoredHistorySequenceRef.current,
                  restoredItemSequencesRef.current,
                )
              : next,
          current.filter((event) => event.kind !== 'approval' || retainedKeys.has(codexEventKey(event))),
        ),
      )
    }
    source.onmessage = (message) => {
      const parsed = parseCodexEvent(message.data)
      if (!parsed) {
        setError('Agent returned an invalid event')
        return
      }
      const currentThread = threadIdRef.current
      const event = { ...parsed, threadId: parsed.threadId || currentThread }
      lastEventSequence.current = Math.max(lastEventSequence.current, event.sequence)
      if (
        codexEventIsIndependentOfThreadSnapshot(event) ||
        codexResolvedApprovalId(event) ||
        event.method === 'turn/completed'
      ) {
        retainedEvents.current = appendCodexEvent(retainedEvents.current, event).filter(
          codexEventIsIndependentOfThreadSnapshot,
        )
      }
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
    return () => {
      source.close()
      flush()
    }
  }, [accountChecked, active, agentId, recoverThreadState, refreshAccount, setCurrentActiveTurnId])

  useEffect(() => {
    if (!active || !followingConversation) return
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
  }, [account?.authenticated, active, followingConversation])

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
          <CodexEventCard key={`wrap-${threadId}-${item.id}-${item.kind}`} kind={item.kind} text={item.text} />
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
  const {
    acknowledged,
    matchedItemIds,
    pending: pendingPrompts,
  } = reconcileSubmittedPrompts(
    transcriptCards,
    submittedPrompts.filter((prompt) => prompt.threadId === threadId),
  )
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
  for (const { prompt, beforeItemId } of pendingPrompts) {
    const index = transcriptCards.findIndex((item) => item.id === beforeItemId)
    transcriptCards.splice(index < 0 ? transcriptCards.length : index, 0, {
      id: prompt.id,
      kind: 'user-message',
      text: prompt.text,
      card: <CodexEventCard key={prompt.id} kind="user-message" text={prompt.text} />,
    })
  }

  function renderEvent({ event, text }: (typeof renderedEvents)[number]) {
    return (
      <CodexEventCard
        key={codexEventWrapperKey(event)}
        approvalDecisions={event.kind === 'approval' ? codexApprovalDecisions(event) : undefined}
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
    const previousItemIds = new Set(transcriptCards.map((item) => item.id))
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
      setSubmittedPrompts((current) => [
        ...current,
        {
          id: crypto.randomUUID(),
          threadId: currentThread.id,
          text: [text, ...inputImages.map(() => '[Image]')].filter(Boolean).join('\n'),
          previousItemIds,
        },
      ])
      setPrompt('')
      commitImages([])
      draftsRef.current.delete(currentThread.id)
      // The turn was accepted, so its prompt can now title a still-untitled conversation.
      if (text) {
        setConversations((current) => promoteAcceptedConversationTitle(agentId, currentThread.id, text, current))
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
    if (threadId && threadReady) {
      setConversations((current) => touchStoredConversation(agentId, threadId, current))
      return { id: threadId, activeTurnId: activeTurnIdRef.current }
    }
    const resumeSequence = lastEventSequence.current
    const thread = threadId
      ? await runTengriAction<TengriCodexThread>({ action: 'resume-thread', agentId, threadId, ...optionsRef.current })
      : await runTengriAction<TengriCodexThread>({ action: 'create-thread', agentId, ...optionsRef.current })
    if (!threadId) {
      draftsRef.current.delete('')
      const assignThread = (event: CodexBufferedEvent) => (event.threadId ? event : { ...event, threadId: thread.id })
      retainedEvents.current = retainedEvents.current.map(assignThread)
      const retained = retainedEvents.current.filter((event) => event.threadId === thread.id)
      setEvents((current) => retained.reduce((next, event) => appendCodexEvent(next, event), current.map(assignThread)))
    }
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
      retainedEvents.current = retainedEvents.current.filter((candidate) => candidate.approvalId !== event.approvalId)
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

  function resetTranscriptUi(nextThreadId: string) {
    if (!nextThreadId) retainedEvents.current = retainedEvents.current.filter((event) => event.threadId)
    if (!threadIdRef.current && !nextThreadId) {
      draftsRef.current.delete('')
    } else {
      draftsRef.current.set(threadIdRef.current, { text: prompt, images: imagesRef.current })
    }
    const draft = draftsRef.current.get(nextThreadId)
    setPrompt(draft?.text ?? '')
    commitImages(draft?.images ?? [])
    threadIdRef.current = nextThreadId
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
    setEvents(retainedEvents.current.filter((event) => event.threadId === nextThreadId))
    setFollowingConversation(true)
    setReplayRecovering(false)
    replayRecoveryRef.current = false
    setError('')
    completedTurns.current.clear()
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
    removeStoredThread(agentId)
    resetTranscriptUi('')
    focusComposerAfterConversationChange()
  }

  function switchConversation(nextThreadId: string) {
    if (!canChangeConversation) return
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

  const sortedConversations = useMemo(
    () => [...conversations].sort((a, b) => b.updatedAt - a.updatedAt),
    [conversations],
  )

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
          <span className="min-w-0 flex-1 truncate text-label-12 text-zinc-400 uppercase">Conversations</span>
          <button
            type="button"
            disabled={!canChangeConversation}
            onClick={newConversation}
            className="inline-flex size-7 items-center justify-center rounded-md text-zinc-400 outline-none transition-colors hover:bg-white/[0.04] hover:text-zinc-100 focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-35 motion-reduce:transition-none"
            aria-label="New conversation"
          >
            <Plus className="size-3.5" aria-hidden="true" />
          </button>
        </div>
        <nav aria-label="Conversations" className="min-h-0 flex-1 overflow-auto py-1 [scrollbar-gutter:stable]">
          {sortedConversations.length === 0 ? (
            <p className="px-3 py-2 text-label-12 text-zinc-400">No conversations yet</p>
          ) : (
            <ul className="px-1.5">
              {sortedConversations.map((conversation) => {
                const active = conversation.id === threadId
                return (
                  <li key={conversation.id}>
                    <button
                      type="button"
                      data-conversation-id={conversation.id}
                      disabled={!canChangeConversation}
                      aria-current={active ? 'true' : undefined}
                      onClick={() => switchConversation(conversation.id)}
                      className={cn(
                        'mb-0.5 flex w-full min-w-0 flex-col rounded-md px-2.5 py-2 text-left outline-none transition-colors focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-35 motion-reduce:transition-none',
                        active
                          ? 'bg-white/[0.06] text-zinc-100'
                          : 'text-zinc-400 hover:bg-white/[0.03] hover:text-zinc-200',
                      )}
                    >
                      <span className="truncate text-label-14">{conversation.title}</span>
                      {conversation.unavailable ? (
                        <span className="mt-0.5 text-label-12 text-zinc-400">Unavailable</span>
                      ) : null}
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </nav>
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

        <div className="relative min-h-0 flex-1">
          <div
            ref={conversationRef}
            data-testid="agent-conversation-scroll"
            className="h-full overflow-auto px-4 pt-5 pb-10 [scrollbar-gutter:stable] scroll-pb-8 @[540px]/agent:px-6"
            onScroll={(event) => {
              const conversation = event.currentTarget
              const atBottom = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 64
              if (atBottom) setFollowingConversation(true)
              else if (conversation.scrollTop < lastScrollTop.current) setFollowingConversation(false)
              lastScrollTop.current = conversation.scrollTop
            }}
          >
            {transcriptCards.length === 0 && !activeTurnId && !submitting ? (
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
              className="mx-auto w-full max-w-3xl space-y-4"
              role="log"
              aria-label="Conversation"
              aria-live="polite"
              aria-relevant="additions text"
            >
              {transcriptCards.map((item) => item.card)}
              {activeTurnId && !approvalPending ? (
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
                className="pointer-events-auto inline-flex min-h-7 items-center gap-1.5 rounded-full border border-white/[0.08] bg-zinc-950/95 px-2.5 text-label-12 text-zinc-300 outline-none transition-colors hover:bg-zinc-900 focus-visible:ring-1 focus-visible:ring-blue-400 motion-reduce:transition-none"
                onClick={() => setFollowingConversation(true)}
              >
                <ArrowDown className="size-3" aria-hidden="true" />
                Jump to latest
              </button>
            </div>
          ) : null}
        </div>

        <div className="shrink-0 px-3 pt-2 pb-3 @[540px]/agent:px-6">
          <div className="mx-auto w-full max-w-3xl">
            {selectionWarning ? (
              <p role="status" className="mb-2 text-label-12 text-amber-200/80">
                {selectionWarning}
              </p>
            ) : null}
            <StreamStatus error={errorMessage} state={eventStreamState} />
            {replayRecovering ? (
              <p className="mx-auto mb-2 w-full text-label-12 text-zinc-400" role="status">
                Recovering the active conversation…
              </p>
            ) : threadId && !threadReady ? (
              <div className="mx-auto mb-3 w-full text-label-12">
                {conversationMissing ? (
                  <p className="mb-2 text-zinc-400">
                    This saved conversation is no longer available. Start a new conversation to continue in this
                    workspace.
                  </p>
                ) : null}
                <div className="flex items-center justify-center gap-3">
                  <button
                    type="button"
                    className="rounded text-blue-400 outline-none hover:text-blue-300 focus-visible:ring-1 focus-visible:ring-blue-400"
                    onClick={() => void recoverThreadState()}
                  >
                    Retry conversation recovery
                  </button>
                  {conversationMissing ? (
                    <button
                      type="button"
                      disabled={!canChangeConversation}
                      className="rounded-md border border-white/[0.08] px-2.5 py-1.5 text-zinc-300 outline-none hover:bg-white/[0.04] focus-visible:ring-1 focus-visible:ring-blue-400 disabled:opacity-35"
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
              className="w-full rounded-2xl bg-zinc-900/60 transition-colors focus-within:bg-zinc-900/80 motion-reduce:transition-none"
              onSubmit={(event) => {
                event.preventDefault()
                void send()
              }}
            >
              <div className="px-3 pt-3 pb-1">
                <textarea
                  ref={promptRef}
                  data-window-default-focus
                  aria-label={activeTurnId ? 'Steer the current turn' : 'Message your agent'}
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
                          disabled={submitting}
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
                    'mb-0.5 grid size-7 shrink-0 place-items-center rounded-full outline-none transition-colors focus-visible:ring-1 focus-visible:ring-blue-400 disabled:bg-zinc-800 disabled:text-zinc-500 motion-reduce:transition-none',
                    showStopAction
                      ? 'bg-zinc-100 text-zinc-900 hover:bg-white'
                      : 'bg-zinc-100 text-zinc-900 hover:bg-white',
                  )}
                >
                  {submitting || interrupting ? (
                    <LoaderCircle className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" aria-hidden="true" />
                  ) : showStopAction ? (
                    <Square className="h-3 w-3 fill-current" aria-hidden="true" />
                  ) : (
                    <ArrowUp className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                </button>
              </div>
            </form>
          </div>
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
    'min-w-0 max-w-full gap-2 rounded-lg border-transparent bg-transparent px-2.5 text-button-12 text-zinc-400 data-[size=default]:h-8 hover:bg-white/5 hover:text-zinc-200 dark:bg-transparent dark:hover:bg-white/5 focus-visible:border-transparent focus-visible:ring-white/15 data-popup-open:bg-white/5 data-popup-open:text-zinc-200 motion-reduce:transition-none'
  const menuClass =
    'font-geist w-72 max-w-[calc(100vw-2rem)] rounded-lg border border-white/[0.08] bg-zinc-950 p-1 text-zinc-200 shadow-none motion-reduce:animate-none'
  const itemClass =
    'min-h-10 rounded-lg px-3 py-2 pr-8 text-label-14 focus:bg-white/8 focus:text-zinc-100 data-highlighted:bg-white/8 data-highlighted:text-zinc-100'
  const reasoningLabel =
    selection.reasoningEffort === 'default'
      ? model
        ? `Default (${codexReasoningLabels[model.defaultReasoningEffort]})`
        : 'Default'
      : `${codexReasoningLabels[selection.reasoningEffort]}${model?.supportedReasoningEfforts.some((effort) => effort.reasoningEffort === selection.reasoningEffort) ? '' : ' (unavailable)'}`
  return (
    <div className="min-w-0 flex-1 space-y-1">
      <div className="flex flex-wrap items-center justify-end gap-0.5 rounded-lg p-0.5">
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
              <SelectLabel className="px-3 pt-2 pb-1.5 text-label-12 text-zinc-400">Model</SelectLabel>
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
              <SelectLabel className="px-3 pt-2 pb-1.5 text-label-12 text-zinc-400">Reasoning effort</SelectLabel>
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
        <p role="status" className="mx-auto mb-2 w-full text-label-12 text-amber-200/80">
          Agent event stream is reconnecting
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

function codexEventWrapperKey(event: TengriCodexEvent) {
  if (event.approvalId) return `wrap-approval-${event.approvalId}`
  if (event.itemId) return `wrap-${event.threadId}-${event.itemId}-${event.kind}`
  return `wrap-${event.sequence}-${event.method}`
}

function titleFromTranscript(items: readonly CodexTranscriptItem[]) {
  const firstUser = items.find((item) => item.kind === 'user-message' && item.text.trim())
  return firstUser ? truncateConversationTitle(firstUser.text) : ''
}

function safeVerificationUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.toString() : ''
  } catch {
    return ''
  }
}
