import { Link } from '@tanstack/react-router'
import * as React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'

import { cn } from '@/lib/utils'

export type AgentMessage = {
  id: string | null
  workflowUid: string | null
  workflowName: string | null
  workflowNamespace: string | null
  runId: string | null
  stepId: string | null
  agentId: string | null
  role: string | null
  kind: string | null
  timestamp: string | null
  channel: string | null
  stage: string | null
  content: string | null
  tool: Record<string, unknown> | null
  attrs: Record<string, unknown> | null
}

export type AgentStreamStatus = 'connecting' | 'open' | 'error' | 'closed'

type AgentStreamConfig = {
  runId?: string | null
  channel?: string | null
  maxMessages?: number
}

type AgentStreamState = {
  messages: AgentMessage[]
  status: AgentStreamStatus
  error: string | null
  lastEventAt: string | null
}

const DEFAULT_MAX_MESSAGES = 300

const coerceString = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const coerceNonEmptyString = (value: unknown): string | null => {
  const raw = coerceString(value)
  if (!raw) return null
  const trimmed = raw.trim()
  return trimmed.length > 0 ? trimmed : null
}

const coerceContent = (value: unknown): string | null => {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const normalizeAgentMessage = (payload: unknown): AgentMessage | null => {
  const rootRecord = toRecord(payload)
  if (!rootRecord) return null
  const candidate = toRecord(rootRecord.message) ?? toRecord(rootRecord.data) ?? rootRecord

  const contentFallback = typeof candidate.message === 'string' ? candidate.message : null
  const statusFallback = coerceNonEmptyString(candidate.status) ?? coerceNonEmptyString(candidate.error)
  const content = coerceContent(candidate.content ?? candidate.text ?? contentFallback ?? statusFallback)
  const kind = coerceNonEmptyString(candidate.kind)
  const role =
    coerceNonEmptyString(candidate.role) ??
    (kind === 'status' || kind === 'error' ? 'system' : kind === 'tool_call' || kind === 'tool_result' ? 'tool' : null)

  const message: AgentMessage = {
    id: coerceNonEmptyString(candidate.id ?? candidate.message_id ?? candidate.messageId),
    workflowUid: coerceNonEmptyString(candidate.workflow_uid ?? candidate.workflowUid),
    workflowName: coerceNonEmptyString(candidate.workflow_name ?? candidate.workflowName),
    workflowNamespace: coerceNonEmptyString(candidate.workflow_namespace ?? candidate.workflowNamespace),
    runId: coerceString(candidate.run_id ?? candidate.runId),
    stepId: coerceNonEmptyString(
      candidate.step_id ?? candidate.stepId ?? candidate.workflow_step ?? candidate.workflowStep,
    ),
    agentId: coerceNonEmptyString(candidate.agent_id ?? candidate.agentId),
    role,
    kind,
    timestamp: coerceNonEmptyString(
      candidate.timestamp ?? candidate.sent_at ?? candidate.created_at ?? candidate.createdAt,
    ),
    channel: coerceNonEmptyString(candidate.channel),
    stage: coerceNonEmptyString(candidate.stage ?? candidate.workflow_stage ?? candidate.workflowStage),
    content,
    tool: toRecord(candidate.tool ?? candidate.tool_call ?? candidate.toolCall),
    attrs: toRecord(candidate.attrs ?? candidate.attributes ?? candidate.meta),
  }

  if (!message.content && !message.kind && !message.agentId && !message.timestamp) {
    return null
  }

  return message
}

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const buildMessageKey = (message: AgentMessage): string => {
  if (message.id) return message.id
  const parts = [
    message.runId,
    message.workflowUid,
    message.stepId,
    message.agentId,
    message.kind,
    message.timestamp,
    message.content,
  ].filter(Boolean)
  return parts.join('|')
}

const parseTimestamp = (value: string | null): number | null => {
  if (!value) return null
  const parsed = new Date(value).getTime()
  return Number.isNaN(parsed) ? null : parsed
}

const formatTimestamp = (value: string | null): string => {
  if (!value) return 'Unknown time'
  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleString()
}

const truncateText = (value: string, maxLength = 140): string => {
  if (value.length <= maxLength) return value
  if (maxLength <= 3) return value.slice(0, maxLength)
  return `${value.slice(0, maxLength - 3)}...`
}

export const useAgentEventStream = ({ runId, channel, maxMessages }: AgentStreamConfig): AgentStreamState => {
  const [messages, setMessages] = React.useState<AgentMessage[]>([])
  const [status, setStatus] = React.useState<AgentStreamStatus>('connecting')
  const [error, setError] = React.useState<string | null>(null)
  const [lastEventAt, setLastEventAt] = React.useState<string | null>(null)
  const messageKeysRef = React.useRef<Set<string>>(new Set())

  React.useEffect(() => {
    const shouldConnect = Boolean(runId?.trim()) || Boolean(channel?.trim())
    if (!shouldConnect) {
      setMessages([])
      setStatus('closed')
      setError(null)
      setLastEventAt(null)
      messageKeysRef.current.clear()
      return
    }

    setMessages([])
    setStatus('connecting')
    setError(null)
    setLastEventAt(null)
    messageKeysRef.current.clear()

    const params = new URLSearchParams()
    if (runId?.trim()) params.set('runId', runId.trim())
    if (channel?.trim()) params.set('channel', channel.trim())
    if (maxMessages) params.set('limit', String(maxMessages))
    const url = `/api/agents/events?${params.toString()}`
    const source = new EventSource(url)

    source.onopen = () => {
      setStatus('open')
      setError(null)
    }

    source.onerror = () => {
      if (source.readyState === EventSource.CLOSED) {
        setStatus('error')
        setError('Stream disconnected. Retrying...')
        return
      }
      setStatus('connecting')
      setError(null)
    }

    source.onmessage = (event) => {
      if (!event.data || event.data === '[DONE]') return
      const parsed = safeParseJson(event.data)
      const message = normalizeAgentMessage(parsed)
      if (!message) return
      const key = buildMessageKey(message)
      if (!key || messageKeysRef.current.has(key)) return
      messageKeysRef.current.add(key)

      setMessages((current) => {
        const next = [...current, message]
        const limit = maxMessages ?? DEFAULT_MAX_MESSAGES
        if (next.length <= limit) return next
        const trimmed = next.slice(next.length - limit)
        messageKeysRef.current = new Set(trimmed.map(buildMessageKey))
        return trimmed
      })

      setLastEventAt(message.timestamp ?? new Date().toISOString())
    }

    return () => {
      source.close()
      setStatus('closed')
    }
  }, [channel, maxMessages, runId])

  return { messages, status, error, lastEventAt }
}

const markdownComponents: Components = {
  p: ({ children }) => <p className="text-xs leading-relaxed text-foreground">{children}</p>,
  a: ({ href, children }) => (
    <a
      href={href ?? '#'}
      target="_blank"
      rel="noreferrer"
      className="text-xs text-primary underline-offset-4 hover:underline"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => <ul className="ml-4 list-disc space-y-1 text-xs text-foreground">{children}</ul>,
  ol: ({ children }) => <ol className="ml-4 list-decimal space-y-1 text-xs text-foreground">{children}</ol>,
  li: ({ children }) => <li className="text-xs text-foreground">{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="pl-3 border-l border-border text-xs text-muted-foreground">{children}</blockquote>
  ),
  code: ({ className, children }) => {
    const isBlock = typeof className === 'string' && className.length > 0
    return (
      <code
        className={cn(
          isBlock
            ? 'text-[11px] leading-relaxed text-foreground'
            : 'px-1 py-0.5 rounded-sm border border-border text-[11px]',
          className,
        )}
      >
        {children}
      </code>
    )
  },
  pre: ({ children }) => (
    <pre className="overflow-x-auto p-2 rounded-none border border-border bg-muted/30 text-[11px] text-foreground">
      {children}
    </pre>
  ),
}

const chipBaseClassName =
  'inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium uppercase tracking-wide'

const chipTone = (tone?: 'default' | 'accent' | 'muted' | 'danger') => {
  switch (tone) {
    case 'accent':
      return 'border-primary/40 text-primary'
    case 'danger':
      return 'border-destructive/40 text-destructive'
    case 'muted':
      return 'border-border text-muted-foreground'
    default:
      return 'border-border text-foreground'
  }
}

const kindTone = (kind: string | null) => {
  switch (kind) {
    case 'error':
      return 'danger'
    case 'tool_call':
    case 'tool_result':
      return 'accent'
    case 'status':
      return 'muted'
    default:
      return 'default'
  }
}

const StreamStatusBadge = ({ status, lastEventAt }: { status: AgentStreamStatus; lastEventAt: string | null }) => {
  const statusLabel =
    status === 'open' ? 'Live' : status === 'connecting' ? 'Connecting' : status === 'error' ? 'Disconnected' : 'Closed'
  const tone = status === 'error' ? 'danger' : status === 'open' ? 'accent' : 'muted'

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className={cn(chipBaseClassName, chipTone(tone))}>
        <span className="inline-flex mr-1 size-1.5 rounded-full bg-current" />
        {statusLabel}
      </span>
      {lastEventAt ? (
        <span className="text-xs text-muted-foreground">Last update {formatTimestamp(lastEventAt)}</span>
      ) : null}
    </div>
  )
}

const MessageMetaChip = ({ label, tone }: { label: string; tone?: 'default' | 'accent' | 'muted' | 'danger' }) => (
  <span className={cn(chipBaseClassName, chipTone(tone))}>{label}</span>
)

const MessagePayload = ({ label, payload }: { label: string; payload: Record<string, unknown> }) => (
  <details className="space-y-2">
    <summary className="cursor-pointer text-xs text-muted-foreground">{label}</summary>
    <pre className="overflow-x-auto p-2 rounded-none border border-border bg-muted/30 text-[11px] text-foreground">
      {JSON.stringify(payload, null, 2)}
    </pre>
  </details>
)

const RunLink = ({ runId }: { runId: string }) => (
  <Link to="/agents/$runId" params={{ runId }} className={cn(chipBaseClassName, chipTone('accent'), 'hover:underline')}>
    Run {runId}
  </Link>
)

export const AgentMessageCard = ({ message, showRunLink }: { message: AgentMessage; showRunLink?: boolean }) => {
  const fallbackAgent = message.agentId ?? 'unknown-agent'
  const roleLabel = message.role ?? 'assistant'
  const kindLabel = message.kind ?? 'message'
  const timestampLabel = formatTimestamp(message.timestamp)

  return (
    <article className="space-y-3 p-4 rounded-none border border-border bg-card">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs font-semibold text-foreground">{fallbackAgent}</span>
          <MessageMetaChip label={roleLabel} tone="muted" />
          <MessageMetaChip label={kindLabel} tone={kindTone(kindLabel)} />
          {message.channel ? <MessageMetaChip label={`channel:${message.channel}`} tone="muted" /> : null}
          {showRunLink && message.runId ? <RunLink runId={message.runId} /> : null}
        </div>
        <span className="text-xs text-muted-foreground">{timestampLabel}</span>
      </header>

      {message.content ? (
        <ReactMarkdown components={markdownComponents}>{message.content}</ReactMarkdown>
      ) : (
        <p className="text-xs text-muted-foreground">No message content.</p>
      )}

      {message.tool ? <MessagePayload label="Tool payload" payload={message.tool} /> : null}
      {message.attrs ? <MessagePayload label="Attributes" payload={message.attrs} /> : null}
    </article>
  )
}

export const AgentMessageList = ({
  messages,
  emptyLabel,
  showRunLink,
}: {
  messages: AgentMessage[]
  emptyLabel: string
  showRunLink?: boolean
}) => {
  if (messages.length === 0) {
    return (
      <div className="p-6 rounded-none border border-border bg-card text-xs text-muted-foreground">{emptyLabel}</div>
    )
  }

  return (
    <div className="space-y-3">
      {messages.map((message, index) => {
        const key = message.id ?? `${buildMessageKey(message)}-${index}`
        return <AgentMessageCard key={key} message={message} showRunLink={showRunLink} />
      })}
    </div>
  )
}

export const buildRunSummaries = (messages: AgentMessage[]) => {
  const sorted = [...messages].sort((a, b) => {
    const aTime = parseTimestamp(a.timestamp) ?? 0
    const bTime = parseTimestamp(b.timestamp) ?? 0
    return bTime - aTime
  })

  const runMap = new Map<string, { message: AgentMessage; count: number }>()
  const workflowMap = new Map<string, { message: AgentMessage; count: number }>()

  for (const message of sorted) {
    const runId = message.runId?.trim()
    if (runId) {
      const existing = runMap.get(runId)
      if (existing) {
        existing.count += 1
      } else {
        runMap.set(runId, { message, count: 1 })
      }
      continue
    }

    const workflowUid = message.workflowUid?.trim()
    if (!workflowUid) continue
    const existing = workflowMap.get(workflowUid)
    if (existing) {
      existing.count += 1
    } else {
      workflowMap.set(workflowUid, { message, count: 1 })
    }
  }

  const summarize = (entry: { message: AgentMessage; count: number }) => {
    const preview = entry.message.content ? truncateText(entry.message.content.trim(), 120) : 'No content yet.'
    return {
      runId: entry.message.runId,
      workflowUid: entry.message.workflowUid,
      workflowName: entry.message.workflowName,
      workflowNamespace: entry.message.workflowNamespace,
      lastAgent: entry.message.agentId,
      lastKind: entry.message.kind,
      lastMessageAt: entry.message.timestamp,
      preview,
      count: entry.count,
    }
  }

  return {
    runs: Array.from(runMap.values()).map(summarize),
    workflows: Array.from(workflowMap.values()).map(summarize),
  }
}

export const sortMessagesByTimestamp = (messages: AgentMessage[], direction: 'asc' | 'desc' = 'desc') =>
  [...messages].sort((a, b) => {
    const aTime = parseTimestamp(a.timestamp) ?? 0
    const bTime = parseTimestamp(b.timestamp) ?? 0
    return direction === 'asc' ? aTime - bTime : bTime - aTime
  })

export const AgentStreamStatusBadge = StreamStatusBadge
