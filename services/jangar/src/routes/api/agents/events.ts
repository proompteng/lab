import { createFileRoute } from '@tanstack/react-router'

import { ensureAgentCommsSubscriber } from '~/server/agent-comms-subscriber'
import { type AgentMessageRecord, createAgentMessagesStore } from '~/server/agent-messages-store'
import { safeJsonStringify } from '~/server/chat-text'
import { createCodexJudgeStore } from '~/server/codex-judge-store'

export const Route = createFileRoute('/api/agents/events')({
  server: {
    handlers: {
      GET: async ({ request }) => getAgentEvents(request),
    },
  },
})

const HEARTBEAT_INTERVAL_MS = 15000
const POLL_INTERVAL_MS = 1500
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

export const getAgentEvents = async (request: Request) => {
  const url = new URL(request.url)
  const runId = url.searchParams.get('runId')?.trim() || null
  const workflowUid = url.searchParams.get('workflowUid')?.trim() || null
  const channel = url.searchParams.get('channel')?.trim() || null
  const limit = normalizeLimit(url.searchParams.get('limit'))

  if (!runId && !workflowUid && !channel) {
    return jsonResponse({ ok: false, error: 'runId, workflowUid, or channel is required' }, 400)
  }

  const subscriber = ensureAgentCommsSubscriber()
  subscriber.ready.catch((error) => {
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
    return jsonResponse({ ok: false, error: message }, message.includes('DATABASE_URL') ? 503 : 500)
  }
  const encoder = new TextEncoder()
  let heartbeat: ReturnType<typeof setInterval> | null = null
  let poller: ReturnType<typeof setInterval> | null = null
  let isClosed = false
  let lastSeenAt: string | null = null
  const seenIds = new Set<string>()

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const push = (payload: unknown) => {
        controller.enqueue(encoder.encode(`data: ${safeJsonStringify(payload)}\n\n`))
      }

      const pushRecord = (record: AgentMessageRecord) => {
        if (seenIds.has(record.id)) return
        seenIds.add(record.id)
        if (!lastSeenAt || record.createdAt > lastSeenAt) {
          lastSeenAt = record.createdAt
        }
        push(buildPayload(record))
      }

      const cleanup = async () => {
        if (isClosed) return
        isClosed = true
        request.signal.removeEventListener('abort', handleAbort)
        if (heartbeat) clearInterval(heartbeat)
        if (poller) clearInterval(poller)
        try {
          await store.close()
        } catch (error) {
          console.warn('Failed to close agent messages store', error)
        }
        controller.close()
      }

      const handleAbort = () => {
        void cleanup()
      }

      heartbeat = setInterval(() => {
        controller.enqueue(encoder.encode(': keep-alive\n\n'))
      }, HEARTBEAT_INTERVAL_MS)

      void (async () => {
        try {
          const records = await store.listMessages({
            identifiers: identifiers.size > 0 ? Array.from(identifiers) : undefined,
            channel,
            limit,
          })
          records.forEach(pushRecord)
          if (!lastSeenAt) {
            lastSeenAt = new Date().toISOString()
          }

          poller = setInterval(() => {
            void (async () => {
              try {
                const next = await store.listMessages({
                  identifiers: identifiers.size > 0 ? Array.from(identifiers) : undefined,
                  channel,
                  since: lastSeenAt,
                  limit,
                })
                next.forEach(pushRecord)
              } catch (error) {
                if (!isClosed) {
                  push({ error: error instanceof Error ? error.message : String(error) })
                }
              }
            })()
          }, POLL_INTERVAL_MS)
        } catch (error) {
          push({ error: error instanceof Error ? error.message : String(error) })
        }
      })()
    },
    cancel() {
      if (isClosed) return
      isClosed = true
      if (heartbeat) clearInterval(heartbeat)
      if (poller) clearInterval(poller)
      void store.close()
    },
  })

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  })
}
