import { createFileRoute } from '@tanstack/react-router'
import { Duration, Effect } from 'effect'

import { subscribeAgentMessages } from '~/server/agent-messages-bus'
import { type AgentMessageRecord, createAgentMessagesStore } from '~/server/agent-messages-store'
import { safeJsonStringify } from '~/server/chat-text'
import { createCodexJudgeStore } from '~/server/codex-judge-store'
import { recordSseConnection, recordSseError } from '~/server/metrics'

export const Route = createFileRoute('/api/agents/events')({
  server: {
    handlers: {
      GET: async ({ request }) => getAgentEvents(request),
    },
  },
})

const HEARTBEAT_INTERVAL_MS = 5000
const DEFAULT_HISTORY_LIMIT = 500

const jsonResponse = (payload: unknown, status = 200) => {
  const body = JSON.stringify(payload)
  return new Response(body, {
    status,
    headers: {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body).toString(),
    },
  })
}

const normalizeLimit = (value: string | null) => {
  if (!value) return DEFAULT_HISTORY_LIMIT
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_HISTORY_LIMIT
  return Math.min(parsed, 1000)
}

const buildPayload = (record: AgentMessageRecord) => ({
  id: record.id,
  workflow_uid: record.workflowUid,
  workflow_name: record.workflowName,
  workflow_namespace: record.workflowNamespace,
  run_id: record.runId,
  step_id: record.stepId,
  agent_id: record.agentId,
  role: record.role,
  kind: record.kind,
  timestamp: record.timestamp,
  channel: record.channel,
  stage: record.stage,
  content: record.content,
  attrs: record.attrs,
  created_at: record.createdAt,
})

const resolveWorkflowUid = async (runId: string) => {
  const store = createCodexJudgeStore()
  try {
    await store.ready
    const run = await store.getRunById(runId)
    return run?.workflowUid ?? null
  } finally {
    await store.close()
  }
}

const resolveDbErrorStatus = (message: string) => {
  if (
    message.includes('DATABASE_URL') ||
    message.includes('ECONNREFUSED') ||
    message.includes('connect ECONNREFUSED') ||
    message.includes('Connection terminated unexpectedly')
  ) {
    return 503
  }
  return 500
}

const looksLikeTransientDbBlip = (message: string) => {
  const normalized = message.toLowerCase()
  return (
    normalized.includes('econnrefused') ||
    normalized.includes('connection terminated unexpectedly') ||
    normalized.includes('server closed the connection unexpectedly') ||
    normalized.includes('connection reset by peer')
  )
}

export const getAgentEvents = async (request: Request) => {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')?.trim() || null
  const workflowUid = url.searchParams.get('workflowUid')?.trim() || null
  const channel = url.searchParams.get('channel')?.trim() || null
  const limit = normalizeLimit(url.searchParams.get('limit'))

  if (!runId && !workflowUid && !channel) {
    return jsonResponse({ ok: false, error: 'runId, workflowUid, or channel is required' }, 400)
  }

  void import('~/server/agent-comms-subscriber')
    .then(({ startAgentCommsSubscriber }) => startAgentCommsSubscriber())
    .catch((error) => {
      console.warn('Agent comms subscriber failed to start', error)
    })

  const identifiers = new Set<string>()
  if (runId) identifiers.add(runId)
  if (workflowUid) identifiers.add(workflowUid)
  if (runId && !workflowUid) {
    try {
      const resolved = await resolveWorkflowUid(runId)
      if (resolved) identifiers.add(resolved)
    } catch (error) {
      console.warn('Failed to resolve workflow uid for run', error)
    }
  }

  let store: ReturnType<typeof createAgentMessagesStore>
  try {
    store = createAgentMessagesStore()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordSseError('agent-events', 'store')
    return jsonResponse({ ok: false, error: message }, resolveDbErrorStatus(message))
  }

  // Preflight the DB connection once before starting SSE.
  // If the DB is unreachable (common when port-forward is down), return a 503 instead of a 200 SSE
  // that immediately emits an error payload.
  let initialRecords: AgentMessageRecord[] = []
  let initialLastSeenAt: string | null = null
  try {
    const listOnce = () =>
      store.listMessages({
        identifiers: identifiers.size > 0 ? Array.from(identifiers) : undefined,
        channel,
        limit,
      })

    try {
      initialRecords = await listOnce()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!looksLikeTransientDbBlip(message)) throw error

      // Brief port-forward restart window; give it a moment and retry once.
      await Effect.runPromise(Effect.sleep(Duration.millis(750)))
      initialRecords = await listOnce()
    }

    for (const record of initialRecords) {
      if (!initialLastSeenAt || record.createdAt > initialLastSeenAt) {
        initialLastSeenAt = record.createdAt
      }
    }
    if (!initialLastSeenAt) {
      initialLastSeenAt = new Date().toISOString()
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    recordSseError('agent-events', 'initial')
    try {
      await store.close()
    } catch {
      // ignore
    }
    return jsonResponse({ ok: false, error: message }, resolveDbErrorStatus(message))
  }

  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let unsubscribe: (() => void) | null = null
  let isClosed = false
  let lastSeenAt: string | null = initialLastSeenAt
  const seenIds = new Set<string>()
  let connectionClosed = false

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      recordSseConnection('agent-events', 'opened')
      let cleanup: (reason: string, error?: unknown) => Promise<void> = async () => {}
      const safeEnqueue = (value: string) => {
        if (isClosed) return
        try {
          controller.enqueue(encoder.encode(value))
        } catch (error) {
          recordSseError('agent-events', 'enqueue')
          if (!isClosed) {
            void cleanup('enqueue-failed', error)
          }
        }
      }

      const push = (payload: unknown) => {
        safeEnqueue(`data: ${safeJsonStringify(payload)}\n\n`)
      }

      const comment = (value: string) => {
        safeEnqueue(`: ${value.replaceAll('\n', ' ')}\n\n`)
      }

      // Flush headers and establish the SSE connection immediately.
      safeEnqueue('retry: 1000\n\n')
      safeEnqueue(': connected\n\n')

      const pushRecord = (record: AgentMessageRecord) => {
        if (seenIds.has(record.id)) return
        seenIds.add(record.id)
        if (!lastSeenAt || record.createdAt > lastSeenAt) {
          lastSeenAt = record.createdAt
        }
        push(buildPayload(record))
      }

      const matchesRecord = (record: AgentMessageRecord) => {
        if (channel && record.channel !== channel) return false
        if (identifiers.size === 0) return true
        if (record.runId && identifiers.has(record.runId)) return true
        if (record.workflowUid && identifiers.has(record.workflowUid)) return true
        return false
      }

      let resolveKeepAlive: (() => void) | null = null
      const keepAlive = new Promise<void>((resolve) => {
        resolveKeepAlive = resolve
      })

      cleanup = async (reason: string, error?: unknown) => {
        if (isClosed) return
        isClosed = true
        request.signal.removeEventListener('abort', handleAbort)
        if (heartbeat) clearInterval(heartbeat)
        if (unsubscribe) unsubscribe()
        try {
          await store.close()
        } catch (error) {
          console.warn('Failed to close agent messages store', error)
        }
        if (!connectionClosed) {
          recordSseConnection('agent-events', 'closed')
          connectionClosed = true
        }
        try {
          controller.close()
        } catch {
          // ignore double-close
        }
        if (resolveKeepAlive) resolveKeepAlive()
        if (reason !== 'client-abort') {
          console.warn('Agent events stream closed', {
            reason,
            message: error instanceof Error ? error.message : error ? String(error) : undefined,
          })
        }
      }

      const handleAbort = () => {
        void cleanup('client-abort')
      }

      request.signal.addEventListener('abort', handleAbort)

      heartbeat = setInterval(() => {
        comment('keep-alive')
      }, HEARTBEAT_INTERVAL_MS)

      void (async () => {
        initialRecords.forEach(pushRecord)
        unsubscribe = subscribeAgentMessages((records) => {
          for (const record of records) {
            if (!matchesRecord(record)) continue
            pushRecord(record)
          }
        })
      })()

      await keepAlive
    },
    cancel() {
      if (isClosed) return
      isClosed = true
      if (heartbeat) clearInterval(heartbeat)
      if (unsubscribe) unsubscribe()
      void store.close()
      if (!connectionClosed) {
        recordSseConnection('agent-events', 'closed')
        connectionClosed = true
      }
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
