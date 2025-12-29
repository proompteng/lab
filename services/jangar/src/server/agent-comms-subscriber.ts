import { connect, type JetStreamClient, type JsMsg, StringCodec } from 'nats'

import { type AgentMessageInput, createAgentMessagesStore } from '~/server/agent-messages-store'

type AgentCommsSubscriber = {
  ready: Promise<void>
  close: () => Promise<void>
}

type SubscriberConfig = {
  natsUrl: string
  natsUser?: string
  natsPassword?: string
  streamName: string
  consumerName: string
  pullBatchSize: number
  pullExpiresMs: number
  pollDelayMs: number
}

const DEFAULT_CONFIG: SubscriberConfig = {
  natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
  streamName: 'agent-comms',
  consumerName: 'jangar-agent-comms',
  pullBatchSize: 250,
  pullExpiresMs: 1500,
  pollDelayMs: 250,
}

const globalState = globalThis as typeof globalThis & {
  __jangarAgentCommsSubscriber?: AgentCommsSubscriber
}

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

const toRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null

const safeParseJson = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

const parseSubject = (subject: string) => {
  const parts = subject.split('.')
  if (parts.length < 3 || parts[0] !== 'argo' || parts[1] !== 'workflow') return null
  if (parts[2] === 'general') {
    return { channel: 'general', kind: parts[3] ?? null }
  }
  const agentIndex = parts.indexOf('agent')
  if (agentIndex === -1) return null
  const [workflowNamespace, workflowName, workflowUid] = parts.slice(2, agentIndex)
  const agentId = parts[agentIndex + 1] ?? null
  const kind = parts[agentIndex + 2] ?? null
  return {
    workflowNamespace: workflowNamespace || null,
    workflowName: workflowName || null,
    workflowUid: workflowUid || null,
    agentId,
    kind,
    channel: null,
  }
}

const normalizePayload = (raw: string, subject: string): AgentMessageInput | null => {
  const parsed = safeParseJson(raw)
  const record = toRecord(parsed)
  const subjectInfo = parseSubject(subject)
  const candidate = record ? (toRecord(record.message) ?? toRecord(record.data) ?? record) : null

  const payload = candidate ?? {}
  const attrsPayload = toRecord(payload.attrs ?? payload.attributes ?? payload.meta) ?? {}
  const toolPayload = toRecord(payload.tool ?? payload.tool_call ?? payload.toolCall)

  const messageId = coerceNonEmptyString(payload.message_id ?? payload.messageId ?? payload.id)
  const timestamp =
    coerceNonEmptyString(payload.timestamp ?? payload.sent_at ?? payload.created_at ?? payload.createdAt) ??
    new Date().toISOString()
  const kind = coerceNonEmptyString(payload.kind) ?? subjectInfo?.kind ?? 'message'
  const role = coerceNonEmptyString(payload.role) ?? (kind === 'status' || kind === 'error' ? 'system' : 'assistant')
  const content =
    coerceNonEmptyString(payload.content ?? payload.text ?? payload.message ?? payload.status ?? payload.error) ??
    (kind === 'status' ? 'status update' : null)

  if (!content) return null

  const runId = coerceString(payload.run_id ?? payload.runId ?? payload.runID)
  const workflowUid =
    coerceNonEmptyString(payload.workflow_uid ?? payload.workflowUid) ?? subjectInfo?.workflowUid ?? null
  const workflowName =
    coerceNonEmptyString(payload.workflow_name ?? payload.workflowName) ?? subjectInfo?.workflowName ?? null
  const workflowNamespace =
    coerceNonEmptyString(payload.workflow_namespace ?? payload.workflowNamespace) ??
    subjectInfo?.workflowNamespace ??
    null
  const stepId = coerceNonEmptyString(
    payload.step_id ?? payload.stepId ?? payload.workflow_step ?? payload.workflowStep,
  )
  const agentId = coerceNonEmptyString(payload.agent_id ?? payload.agentId) ?? subjectInfo?.agentId ?? null
  const channel = coerceNonEmptyString(payload.channel) ?? subjectInfo?.channel ?? null
  const stage = coerceNonEmptyString(payload.stage ?? payload.workflow_stage ?? payload.workflowStage)

  const attrs: Record<string, unknown> = {
    ...attrsPayload,
    ...(toolPayload ? { tool: toolPayload } : {}),
    ...(payload.status ? { status: payload.status } : {}),
    ...(payload.exit_code ? { exit_code: payload.exit_code } : {}),
    ...(subject ? { nats_subject: subject } : {}),
  }

  return {
    workflowUid,
    workflowName,
    workflowNamespace,
    runId,
    stepId,
    agentId,
    role,
    kind,
    timestamp,
    channel,
    stage,
    content,
    attrs,
    dedupeKey: messageId ?? null,
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const startSubscriber = async (config: SubscriberConfig, abort: AbortSignal) => {
  const store = createAgentMessagesStore()
  const sc = StringCodec()
  let nc: Awaited<ReturnType<typeof connect>> | null = null
  let js: JetStreamClient | null = null

  try {
    nc = await connect({
      servers: config.natsUrl,
      name: 'jangar-agent-comms-subscriber',
      user: config.natsUser,
      pass: config.natsPassword,
    })
    js = nc.jetstream()
  } catch (error) {
    await store.close()
    throw error
  }

  try {
    while (!abort.aborted) {
      const batchInputs: AgentMessageInput[] = []
      const ackables: JsMsg[] = []
      try {
        const iterator = js.fetch(config.streamName, config.consumerName, {
          batch: config.pullBatchSize,
          expires: config.pullExpiresMs,
        })

        for await (const msg of iterator) {
          const decoded = sc.decode(msg.data)
          const input = normalizePayload(decoded, msg.subject)
          if (input) {
            batchInputs.push(input)
            ackables.push(msg)
          } else {
            msg.ack()
          }
        }

        if (batchInputs.length > 0) {
          await store.insertMessages(batchInputs)
          for (const msg of ackables) {
            msg.ack()
          }
        }
      } catch (error) {
        if (!abort.aborted) {
          console.warn('Agent comms subscriber error', error)
          await sleep(config.pollDelayMs)
        }
      }

      if (!abort.aborted) {
        await sleep(config.pollDelayMs)
      }
    }
  } finally {
    try {
      await store.close()
    } catch (error) {
      console.warn('Failed to close agent comms store', error)
    }
    try {
      await nc?.close()
    } catch (error) {
      console.warn('Failed to close NATS connection', error)
    }
  }
}

export const ensureAgentCommsSubscriber = (): AgentCommsSubscriber => {
  if (globalState.__jangarAgentCommsSubscriber) {
    return globalState.__jangarAgentCommsSubscriber
  }

  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    const noop: AgentCommsSubscriber = {
      ready: Promise.resolve(),
      close: async () => {},
    }
    globalState.__jangarAgentCommsSubscriber = noop
    return noop
  }

  if (process.env.JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED === 'true') {
    const noop: AgentCommsSubscriber = {
      ready: Promise.resolve(),
      close: async () => {},
    }
    globalState.__jangarAgentCommsSubscriber = noop
    return noop
  }

  const abortController = new AbortController()
  const config: SubscriberConfig = {
    ...DEFAULT_CONFIG,
    natsUrl: process.env.NATS_URL?.trim() || DEFAULT_CONFIG.natsUrl,
    natsUser: process.env.NATS_USER?.trim() || undefined,
    natsPassword: process.env.NATS_PASSWORD?.trim() || undefined,
  }

  const ready = startSubscriber(config, abortController.signal)

  const handle: AgentCommsSubscriber = {
    ready,
    close: async () => {
      abortController.abort()
      try {
        await ready
      } catch {
        // ignore errors on shutdown
      }
    },
  }

  globalState.__jangarAgentCommsSubscriber = handle
  return handle
}
