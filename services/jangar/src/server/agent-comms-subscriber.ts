import { Context, Effect, Layer, ManagedRuntime, pipe } from 'effect'
import {
  AckPolicy,
  type ConsumerConfig,
  connect,
  DeliverPolicy,
  ErrorCode,
  type JetStreamClient,
  type JetStreamManager,
  type JsMsg,
  NatsError,
  ReplayPolicy,
  StringCodec,
} from 'nats'

import { type AgentMessageInput, createAgentMessagesStore } from '~/server/agent-messages-store'
import { recordAgentCommsBatch, recordAgentCommsError } from '~/server/metrics'

export type AgentCommsSubscriberService = {
  ready: Effect.Effect<void, Error>
}

export class AgentCommsSubscriber extends Context.Tag('AgentCommsSubscriber')<
  AgentCommsSubscriber,
  AgentCommsSubscriberService
>() {}

type SubscriberConfig = {
  natsUrl: string
  natsUser?: string
  natsPassword?: string
  streamName: string
  consumerName: string
  pullBatchSize: number
  pullExpiresMs: number
  pollDelayMs: number
  reconnectDelayMs: number
  maxAckPending: number
  ackWaitMs: number
  consumerDescription: string
}

const DEFAULT_CONFIG: SubscriberConfig = {
  natsUrl: 'nats://nats.nats.svc.cluster.local:4222',
  streamName: 'agent-comms',
  consumerName: 'jangar-agent-comms',
  pullBatchSize: 250,
  pullExpiresMs: 1500,
  pollDelayMs: 250,
  reconnectDelayMs: 2000,
  maxAckPending: 20000,
  ackWaitMs: 30000,
  consumerDescription: 'Jangar agent communications ingestion',
}

const isSubscriberDisabled = () =>
  process.env.NODE_ENV === 'test' || process.env.VITEST || process.env.JANGAR_AGENT_COMMS_SUBSCRIBER_DISABLED === 'true'

const resolveConfig = (): SubscriberConfig => ({
  ...DEFAULT_CONFIG,
  natsUrl: process.env.NATS_URL?.trim() || DEFAULT_CONFIG.natsUrl,
  natsUser: process.env.NATS_USER?.trim() || undefined,
  natsPassword: process.env.NATS_PASSWORD?.trim() || undefined,
})

type DeferredPromise = {
  promise: Promise<void>
  resolve: () => void
  reject: (error: Error) => void
}

const createDeferredPromise = (): DeferredPromise => {
  let resolve: (() => void) | undefined
  let reject: ((error: Error) => void) | undefined
  let settled = false

  const promise = new Promise<void>((innerResolve, innerReject) => {
    resolve = () => {
      if (settled) return
      settled = true
      innerResolve()
    }
    reject = (error: Error) => {
      if (settled) return
      settled = true
      innerReject(error)
    }
  })

  if (!resolve || !reject) {
    throw new Error('Deferred promise executor did not initialize')
  }

  return { promise, resolve, reject }
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
    ...(payload.repository ? { repository: payload.repository } : {}),
    ...(payload.issueNumber ? { issueNumber: payload.issueNumber } : {}),
    ...(payload.branch ? { branch: payload.branch } : {}),
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

const msToNanos = (ms: number) => Math.max(1, Math.floor(ms)) * 1_000_000

const isNatsError = (error: unknown): error is NatsError => error instanceof NatsError

const buildConsumerConfig = (config: SubscriberConfig): ConsumerConfig => ({
  durable_name: config.consumerName,
  name: config.consumerName,
  ack_policy: AckPolicy.Explicit,
  deliver_policy: DeliverPolicy.All,
  replay_policy: ReplayPolicy.Instant,
  max_ack_pending: config.maxAckPending,
  ack_wait: msToNanos(config.ackWaitMs),
  description: config.consumerDescription,
})

const isMissingConsumer = (error: unknown) => {
  if (!isNatsError(error)) return false
  const apiError = error.jsError() ?? error.api_error
  return apiError?.code === 404
}

const isAlreadyExists = (error: unknown) => {
  if (!isNatsError(error)) return false
  const apiError = error.jsError() ?? error.api_error
  return apiError?.code === 409
}

const shouldReconnect = (error: unknown) => {
  if (!isNatsError(error)) return false
  return (
    error.code === ErrorCode.ConnectionClosed ||
    error.code === ErrorCode.ConnectionDraining ||
    error.code === ErrorCode.ConnectionRefused ||
    error.code === ErrorCode.ConnectionTimeout ||
    error.code === ErrorCode.Disconnect ||
    error.code === ErrorCode.ServerOptionNotAvailable ||
    error.code === ErrorCode.JetStreamNotEnabled
  )
}

const isNoMessageError = (error: unknown) => {
  if (!isNatsError(error)) return false
  return error.code === ErrorCode.JetStream404NoMessages || error.code === ErrorCode.JetStream408RequestTimeout
}

const ensureConsumer = async (manager: JetStreamManager, config: SubscriberConfig) => {
  try {
    const info = await manager.consumers.info(config.streamName, config.consumerName)
    const expected = buildConsumerConfig(config)
    const mismatches: string[] = []

    if (info.config.ack_policy !== expected.ack_policy) mismatches.push('ack_policy')
    if (info.config.deliver_policy !== expected.deliver_policy) mismatches.push('deliver_policy')
    if (info.config.max_ack_pending !== expected.max_ack_pending) mismatches.push('max_ack_pending')
    if (info.config.durable_name !== expected.durable_name) mismatches.push('durable_name')

    if (mismatches.length > 0) {
      console.warn('Agent comms consumer config mismatch', {
        consumer: config.consumerName,
        stream: config.streamName,
        mismatches,
      })
    }

    return
  } catch (error) {
    if (!isMissingConsumer(error)) {
      throw error
    }
  }

  try {
    await manager.consumers.add(config.streamName, buildConsumerConfig(config))
    console.info('Created agent comms consumer', {
      stream: config.streamName,
      consumer: config.consumerName,
    })
  } catch (error) {
    if (isAlreadyExists(error)) return
    throw error
  }
}

const consumeBatch = async (
  js: JetStreamClient,
  sc: ReturnType<typeof StringCodec>,
  store: ReturnType<typeof createAgentMessagesStore>,
  config: SubscriberConfig,
  abort: AbortSignal,
) => {
  const batchInputs: AgentMessageInput[] = []
  const ackables: JsMsg[] = []
  let stage: 'fetch' | 'insert' | 'unknown' = 'fetch'

  try {
    const iterator = js.fetch(config.streamName, config.consumerName, {
      batch: config.pullBatchSize,
      expires: config.pullExpiresMs,
    })

    for await (const msg of iterator) {
      if (abort.aborted) break
      const decoded = sc.decode(msg.data)
      const input = normalizePayload(decoded, msg.subject)
      if (input) {
        batchInputs.push(input)
        ackables.push(msg)
      } else {
        recordAgentCommsError('decode')
        msg.ack()
      }
    }

    if (batchInputs.length > 0) {
      stage = 'insert'
      const insertStart = Date.now()
      await store.insertMessages(batchInputs)
      recordAgentCommsBatch(batchInputs.length, Date.now() - insertStart)
      for (const msg of ackables) {
        msg.ack()
      }
    }
  } catch (error) {
    recordAgentCommsError(stage)
    throw error
  }
}

const consumeLoop = async (
  js: JetStreamClient,
  sc: ReturnType<typeof StringCodec>,
  store: ReturnType<typeof createAgentMessagesStore>,
  config: SubscriberConfig,
  abort: AbortSignal,
) => {
  while (!abort.aborted) {
    try {
      await consumeBatch(js, sc, store, config, abort)
    } catch (error) {
      if (abort.aborted) return
      if (isNoMessageError(error)) {
        // no-op
      } else if (shouldReconnect(error)) {
        throw error
      } else {
        console.warn('Agent comms subscriber error', error)
      }
    }

    if (!abort.aborted) {
      await sleep(config.pollDelayMs)
    }
  }
}

const runSubscriberLoop = async (config: SubscriberConfig, abort: AbortSignal, markReady: () => void) => {
  const store = createAgentMessagesStore()
  const sc = StringCodec()

  try {
    while (!abort.aborted) {
      let nc: Awaited<ReturnType<typeof connect>> | null = null
      try {
        nc = await connect({
          servers: config.natsUrl,
          name: 'jangar-agent-comms-subscriber',
          user: config.natsUser,
          pass: config.natsPassword,
        })
        const js = nc.jetstream()
        const jsm = await nc.jetstreamManager()
        await ensureConsumer(jsm, config)
        markReady()
        await consumeLoop(js, sc, store, config, abort)
      } catch (error) {
        if (!abort.aborted) {
          console.warn('Agent comms subscriber connection error', error)
        }
      } finally {
        try {
          await nc?.close()
        } catch (error) {
          console.warn('Failed to close NATS connection', error)
        }
      }

      if (!abort.aborted) {
        await sleep(config.reconnectDelayMs)
      }
    }
  } finally {
    try {
      await store.close()
    } catch (error) {
      console.warn('Failed to close agent comms store', error)
    }
  }
}

export const AgentCommsSubscriberLive = Layer.scoped(
  AgentCommsSubscriber,
  Effect.gen(function* () {
    if (isSubscriberDisabled()) {
      return { ready: Effect.void }
    }

    const abortController = new AbortController()
    const readyGate = createDeferredPromise()
    const config = resolveConfig()

    yield* Effect.addFinalizer(() => Effect.sync(() => abortController.abort()))

    yield* Effect.forkScoped(
      pipe(
        Effect.tryPromise({
          try: () => runSubscriberLoop(config, abortController.signal, readyGate.resolve),
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }),
        Effect.catchAll((error) => {
          readyGate.reject(error)
          return Effect.sync(() => {
            console.warn('Agent comms subscriber stopped', error)
          })
        }),
      ),
    )

    return {
      ready: Effect.tryPromise({
        try: () => readyGate.promise,
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }),
    }
  }),
)

const subscriberRuntime = ManagedRuntime.make(AgentCommsSubscriberLive)
const startAgentCommsSubscriberEffect = Effect.flatMap(AgentCommsSubscriber, (service) => service.ready)
let startPromise: Promise<void> | null = null

export const startAgentCommsSubscriber = () => {
  if (!startPromise) {
    startPromise = subscriberRuntime.runPromise(startAgentCommsSubscriberEffect).catch((error) => {
      startPromise = null
      throw error
    })
  }

  return startPromise
}
