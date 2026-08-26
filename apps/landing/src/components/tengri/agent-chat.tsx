'use client'

import { Bot, CircleStop, Copy, ExternalLink, LoaderCircle, Plus, Send } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  TengriCodexAccount,
  TengriCodexEvent,
  TengriCodexLogin,
  TengriCodexThread,
  TengriCodexTurn,
} from '@/lib/tengri/types'
import { CodexEventCard } from './codex-event-card'
import {
  appendCodexEvent,
  codexEventDisplayText,
  codexTranscriptFromThread,
  parseCodexEvent,
  type CodexTranscriptItem,
} from './codex-events'
import { runTengriAction } from './client'

type ApprovalDecision = 'approve-once' | 'approve-session' | 'deny'
type EventStreamState = 'connected' | 'connecting' | 'reconnecting'

export function AgentChat({ agentId }: { agentId: string }) {
  const [account, setAccount] = useState<TengriCodexAccount | null>(null)
  const [login, setLogin] = useState<TengriCodexLogin | null>(null)
  const [threadId, setThreadId] = useState('')
  const [threadReady, setThreadReady] = useState(false)
  const [activeTurnId, setActiveTurnId] = useState('')
  const [historyItems, setHistoryItems] = useState<CodexTranscriptItem[]>([])
  const [events, setEvents] = useState<TengriCodexEvent[]>([])
  const [prompt, setPrompt] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [interrupting, setInterrupting] = useState(false)
  const [loginBusy, setLoginBusy] = useState(false)
  const [resolvingApprovals, setResolvingApprovals] = useState<Set<string>>(() => new Set())
  const [error, setError] = useState('')
  const [eventStreamState, setEventStreamState] = useState<EventStreamState>('connecting')
  const endRef = useRef<HTMLDivElement | null>(null)
  const completedTurns = useRef(new Set<string>())
  const threadIdRef = useRef('')
  const lastEventSequence = useRef(0)
  const replayRecoveryRef = useRef(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const refreshAccount = useCallback(
    async (signal?: AbortSignal) => {
      try {
        const next = await runTengriAction<TengriCodexAccount>({ action: 'codex-account', agentId }, signal)
        if (signal?.aborted || !mountedRef.current) return null
        setAccount(next)
        if (next.authenticated) setLogin(null)
        setError('')
        return next
      } catch (cause) {
        if (signal?.aborted || !mountedRef.current) return null
        setError(cause instanceof Error ? cause.message : 'Codex account unavailable')
        return null
      }
    },
    [agentId],
  )

  useEffect(() => {
    const controller = new AbortController()
    setAccount(null)
    setLogin(null)
    setThreadReady(false)
    setActiveTurnId('')
    setHistoryItems([])
    setEvents([])
    setPrompt('')
    setError('')
    setEventStreamState('connecting')
    completedTurns.current.clear()
    lastEventSequence.current = 0
    const stored = readStoredThread(agentId)
    threadIdRef.current = stored
    setThreadId(stored)
    void refreshAccount(controller.signal)
    return () => controller.abort()
  }, [agentId, refreshAccount])

  useEffect(() => {
    if (!login || account?.authenticated) return
    const expiresAt = Date.parse(login.expiresAt)
    let stopped = false
    let timer = 0
    const refresh = async () => {
      if (Number.isFinite(expiresAt) && Date.now() >= expiresAt) {
        setLogin(null)
        setError('The device code expired. Start a new Codex login.')
        return
      }
      await refreshAccount()
      if (!stopped) timer = window.setTimeout(() => void refresh(), 2_500)
    }
    timer = window.setTimeout(() => void refresh(), 2_500)
    return () => {
      stopped = true
      window.clearTimeout(timer)
    }
  }, [account?.authenticated, login, refreshAccount])

  useEffect(() => {
    if (!account?.authenticated || !threadId || threadReady) return
    const controller = new AbortController()
    void runTengriAction<TengriCodexThread>({ action: 'resume-thread', agentId, threadId }, controller.signal)
      .then((thread) => {
        if (controller.signal.aborted) return
        commitThread(agentId, thread, threadIdRef, setThreadId, setHistoryItems)
        setThreadReady(true)
        setError('')
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : 'Codex thread could not be resumed')
        }
      })
    return () => controller.abort()
  }, [account?.authenticated, agentId, threadId, threadReady])

  const recoverThreadState = useCallback(async () => {
    const currentThread = threadIdRef.current
    if (!currentThread || replayRecoveryRef.current) return
    replayRecoveryRef.current = true
    try {
      const thread = await runTengriAction<TengriCodexThread>({
        action: 'resume-thread',
        agentId,
        threadId: currentThread,
      })
      if (!mountedRef.current || threadIdRef.current !== currentThread) return
      commitThread(agentId, thread, threadIdRef, setThreadId, setHistoryItems)
      setThreadReady(true)
      setError('')
    } catch (cause) {
      if (mountedRef.current) {
        setError(cause instanceof Error ? cause.message : 'Codex thread state could not be refreshed')
      }
    } finally {
      replayRecoveryRef.current = false
    }
  }, [agentId])

  useEffect(() => {
    if (!account?.authenticated) return
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
      if (event.threadId && event.threadId !== currentThread) return
      setEvents((current) => appendCodexEvent(current, event))
      if (event.method === 'tengri/replayWarning') {
        void recoverThreadState()
      } else if (event.method === 'turn/started' && event.turnId) {
        setActiveTurnId(event.turnId)
      } else if (event.method === 'turn/completed' && event.turnId) {
        completedTurns.current.add(event.turnId)
        setActiveTurnId((current) => (current === event.turnId ? '' : current))
      }
    }
    source.onopen = () => setEventStreamState('connected')
    source.onerror = () => setEventStreamState('reconnecting')
    return () => source.close()
  }, [account?.authenticated, agentId, recoverThreadState])

  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      block: 'end',
    })
  }, [events, historyItems])

  const historyIds = useMemo(() => new Set(historyItems.map((item) => item.id)), [historyItems])
  const renderedEvents = useMemo(
    () =>
      events
        .filter(
          (event) =>
            (!event.threadId || event.threadId === threadId) && (!event.itemId || !historyIds.has(event.itemId)),
        )
        .map((event) => ({ event, text: codexEventDisplayText(event) }))
        .filter(
          ({ event, text }) =>
            Boolean(text) || event.kind === 'approval' || event.kind === 'warning' || event.kind === 'error',
        ),
    [events, historyIds, threadId],
  )

  async function send() {
    const text = prompt.trim()
    if (!text || submitting) return
    setSubmitting(true)
    setError('')
    setPrompt('')
    try {
      const currentThread = await ensureThread()
      if (activeTurnId) {
        await runTengriAction<TengriCodexTurn>({
          action: 'steer-turn',
          agentId,
          threadId: currentThread,
          turnId: activeTurnId,
          text,
        })
      } else {
        const turn = await runTengriAction<TengriCodexTurn>({
          action: 'send-turn',
          agentId,
          threadId: currentThread,
          text,
        })
        if (!completedTurns.current.has(turn.id)) setActiveTurnId(turn.id)
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Message could not be sent')
      setPrompt(text)
    } finally {
      setSubmitting(false)
    }
  }

  async function ensureThread() {
    if (threadId && threadReady) return threadId
    const thread = threadId
      ? await runTengriAction<TengriCodexThread>({ action: 'resume-thread', agentId, threadId })
      : await runTengriAction<TengriCodexThread>({ action: 'create-thread', agentId })
    commitThread(agentId, thread, threadIdRef, setThreadId, setHistoryItems)
    setThreadReady(true)
    return thread.id
  }

  async function resolveApproval(event: TengriCodexEvent, decision: ApprovalDecision) {
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
      setLogin(await runTengriAction<TengriCodexLogin>({ action: 'codex-login', agentId }))
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
    if (activeTurnId || submitting) return
    removeStoredThread(agentId)
    threadIdRef.current = ''
    setThreadId('')
    setThreadReady(false)
    setActiveTurnId('')
    setHistoryItems([])
    setEvents([])
    setError('')
    completedTurns.current.clear()
  }

  if (!account) {
    return (
      <div className="grid h-full place-items-center p-8">
        {error ? (
          <div className="text-center">
            <p className="text-sm text-red-200" role="alert">
              {error}
            </p>
            <button
              type="button"
              className="mt-4 rounded-xl bg-white/9 px-4 py-2 text-xs text-white/76 hover:bg-white/13"
              onClick={() => void refreshAccount()}
            >
              Retry
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2 text-sm text-white/45" role="status">
            <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> Checking Codex login…
          </div>
        )}
      </div>
    )
  }

  if (!account.authenticated) {
    return (
      <CodexLogin
        busy={loginBusy}
        error={error}
        login={login}
        onRefresh={() => void refreshAccount()}
        onStart={() => void startLogin()}
      />
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#0a0d13]">
      <div className="flex h-10 shrink-0 items-center border-b border-white/8 px-4 text-xs text-white/48">
        <Bot className="mr-2 h-3.5 w-3.5 text-[#9ccfd8]" aria-hidden="true" />
        Agent Chat
        {account.plan ? <span className="ml-2 text-white/55">{account.plan}</span> : null}
        <button
          type="button"
          disabled={Boolean(activeTurnId) || submitting}
          onClick={newConversation}
          className="ml-auto inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-white/55 outline-none hover:bg-white/7 hover:text-white/82 focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-35"
        >
          <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New conversation
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-[max(20px,8vw)] py-6">
        {historyItems.length === 0 && renderedEvents.length === 0 ? <EmptyConversation /> : null}
        <div className="mx-auto max-w-3xl space-y-3" role="log" aria-live="polite" aria-relevant="additions text">
          {historyItems.map((item) => (
            <CodexEventCard key={`history-${item.id}`} kind={item.kind} text={item.text} />
          ))}
          {renderedEvents.map(({ event, text }) => (
            <CodexEventCard
              approvalId={event.approvalId}
              key={`${event.sequence}-${event.method}-${event.itemId}`}
              kind={event.kind}
              onResolveApproval={(decision) => void resolveApproval(event, decision)}
              resolvingApproval={resolvingApprovals.has(event.approvalId)}
              text={text}
            />
          ))}
          <div ref={endRef} />
        </div>
      </div>
      <div className="shrink-0 px-[max(20px,8vw)] pb-5">
        <StreamStatus error={error} state={eventStreamState} />
        <form
          className="mx-auto flex max-w-3xl items-end gap-2 rounded-2xl border border-white/10 bg-white/[0.055] p-2 shadow-[0_18px_55px_rgba(0,0,0,0.3)] backdrop-blur-xl"
          onSubmit={(event) => {
            event.preventDefault()
            void send()
          }}
        >
          <textarea
            aria-label={activeTurnId ? 'Steer the current turn' : 'Message your agent'}
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault()
                void send()
              }
            }}
            rows={1}
            placeholder={activeTurnId ? 'Steer the current turn…' : 'Message your agent…'}
            className="max-h-36 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm text-white/82 outline-none placeholder:text-white/28"
          />
          {activeTurnId ? (
            <button
              type="button"
              aria-label="Interrupt turn"
              disabled={interrupting}
              className="grid h-9 w-9 place-items-center rounded-xl bg-white/8 outline-none hover:bg-white/12 focus-visible:ring-2 focus-visible:ring-white/50 disabled:opacity-40"
              onClick={() => void interruptTurn()}
            >
              {interrupting ? (
                <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <CircleStop className="h-4 w-4" aria-hidden="true" />
              )}
            </button>
          ) : null}
          <button
            type="submit"
            aria-label={activeTurnId ? 'Steer turn' : 'Send message'}
            disabled={!prompt.trim() || submitting}
            className="grid h-9 w-9 place-items-center rounded-xl bg-[#2574e8] outline-none hover:bg-[#3981e9] focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-30"
          >
            {submitting ? (
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <Send className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </form>
      </div>
    </div>
  )
}

function CodexLogin({
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
    <div className="grid h-full place-items-center bg-[#0a0d13] p-8">
      <div className="max-w-sm rounded-3xl border border-white/9 bg-white/[0.035] p-7 text-center shadow-2xl">
        <div className="mx-auto mb-4 grid h-14 w-14 place-items-center rounded-2xl bg-gradient-to-br from-[#2574e8] to-[#8b5cf6]">
          <Bot className="h-7 w-7" aria-hidden="true" />
        </div>
        <h2 className="text-lg font-semibold text-white/90">Connect Codex in this microVM</h2>
        <p className="mt-2 text-sm leading-6 text-white/48">
          Your device login is stored only in this agent’s persistent workspace.
        </p>
        {login ? (
          <div className="mt-5 rounded-xl bg-black/30 p-4">
            <p className="text-[10px] tracking-wider text-white/35 uppercase">Device code</p>
            <p className="mt-1 font-mono text-xl tracking-[0.2em] text-white">{login.userCode}</p>
            <div className="mt-3 flex justify-center gap-3">
              <button
                type="button"
                className="inline-flex items-center gap-1 text-xs text-white/48 hover:text-white/76"
                onClick={() => void navigator.clipboard.writeText(login.userCode).catch(() => undefined)}
              >
                <Copy className="h-3 w-3" aria-hidden="true" /> Copy code
              </button>
              {verificationUrl ? (
                <a
                  className="inline-flex items-center gap-1 text-xs text-[#79b8ff] hover:text-[#9bcaff]"
                  href={verificationUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  Open verification <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
            </div>
            <p className="mt-3 text-[11px] text-white/34" role="status">
              Waiting for device authorization…
            </p>
          </div>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={onStart}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[#2574e8] px-4 py-2.5 text-sm font-semibold outline-none hover:bg-[#3981e9] focus-visible:ring-2 focus-visible:ring-white/60 disabled:opacity-45"
          >
            {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : null}
            Start device login
          </button>
        )}
        <button
          type="button"
          onClick={onRefresh}
          className="mt-4 block w-full text-xs text-white/38 hover:text-white/62"
        >
          I’ve completed login
        </button>
        {error ? (
          <p role="alert" className="mt-3 rounded-lg bg-red-500/10 px-3 py-2 text-xs text-red-200">
            {error}
          </p>
        ) : null}
      </div>
    </div>
  )
}

function EmptyConversation() {
  return (
    <div className="mx-auto mt-[12vh] max-w-xl text-center">
      <div className="mx-auto mb-5 grid h-16 w-16 place-items-center rounded-[22px] bg-gradient-to-br from-[#2574e8] to-[#8b5cf6] shadow-[0_18px_50px_rgba(37,116,232,0.28)]">
        <Bot className="h-8 w-8" aria-hidden="true" />
      </div>
      <h2 className="text-2xl font-semibold tracking-tight text-white/92">What should we build?</h2>
      <p className="mt-2 text-sm leading-6 text-white/56">
        This conversation, terminal, editor, and files share the same Firecracker microVM.
      </p>
    </div>
  )
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
        <p role="status" className="mx-auto mb-2 max-w-3xl text-xs text-amber-200/80">
          Agent event stream is reconnecting
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mx-auto mb-2 max-w-3xl text-xs text-amber-200/80">
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
  setHistoryItems(codexTranscriptFromThread(thread.rawJson))
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
