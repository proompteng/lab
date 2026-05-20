import { Context, Data, Effect, Layer } from 'effect'

import { publishAgentMessages } from './agent-messages-bus'
import {
  type AgentMessageRecord,
  type AgentMessageInput,
  type AgentMessagesStore,
  createAgentMessagesStore,
} from './agent-messages-store'
import { asRecord, asString } from './primitives'

export class AgentMessagesInvalidPayloadError extends Data.TaggedError('AgentMessagesInvalidPayloadError')<{
  readonly message: string
}> {}

export class AgentMessagesStorageError extends Data.TaggedError('AgentMessagesStorageError')<{
  readonly operation: string
  readonly message: string
  readonly causeCode: 'missing-config' | 'transient-db' | 'unknown'
  readonly retryable: boolean
  readonly httpStatusCode: 500 | 503
}> {}

export type AgentMessagesStoreFactoryService = {
  create: Effect.Effect<AgentMessagesStore, AgentMessagesStorageError>
}

export class AgentMessagesStoreFactory extends Context.Tag('AgentMessagesStoreFactory')<
  AgentMessagesStoreFactory,
  AgentMessagesStoreFactoryService
>() {}

export type AgentMessagesPublisherService = {
  publish: (records: AgentMessageRecord[]) => Effect.Effect<void>
}

export class AgentMessagesPublisher extends Context.Tag('AgentMessagesPublisher')<
  AgentMessagesPublisher,
  AgentMessagesPublisherService
>() {}

export type AgentMessagesSkipIfExisting = {
  runId?: string | null
  agentRunUid?: string | null
}

export type IngestAgentMessagesInput = {
  messages: AgentMessageInput[]
  skipIfExisting?: AgentMessagesSkipIfExisting
}

const MAX_INGEST_BATCH_SIZE = 2_000

const toErrorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

const classifyStorageError = (message: string) => {
  const normalized = message.toLowerCase()
  if (normalized.includes('database_url')) {
    return { causeCode: 'missing-config' as const, retryable: false, httpStatusCode: 503 as const }
  }
  if (
    normalized.includes('econnrefused') ||
    normalized.includes('connection terminated unexpectedly') ||
    normalized.includes('server closed the connection unexpectedly') ||
    normalized.includes('connection reset by peer') ||
    normalized.includes('timeout') ||
    normalized.includes('timed out')
  ) {
    return { causeCode: 'transient-db' as const, retryable: true, httpStatusCode: 503 as const }
  }
  return { causeCode: 'unknown' as const, retryable: false, httpStatusCode: 500 as const }
}

const storageError = (operation: string) => (error: unknown) => {
  const message = toErrorMessage(error)
  return new AgentMessagesStorageError({ operation, message, ...classifyStorageError(message) })
}

const readNullableString = (value: unknown) => {
  if (value == null) return null
  return asString(value)
}

const readTimestamp = (value: unknown) => {
  if (value instanceof Date) return value
  const timestamp = asString(value)
  if (!timestamp) {
    throw new AgentMessagesInvalidPayloadError({ message: 'message timestamp is required' })
  }
  return timestamp
}

const readAttrs = (value: unknown) => asRecord(value) ?? {}

const parseMessage = (value: unknown, index: number): AgentMessageInput => {
  const record = asRecord(value)
  if (!record) {
    throw new AgentMessagesInvalidPayloadError({ message: `messages[${index}] must be an object` })
  }

  const content = asString(record.content)
  if (!content) {
    throw new AgentMessagesInvalidPayloadError({ message: `messages[${index}].content is required` })
  }

  return {
    agentRunUid: readNullableString(record.agentRunUid ?? record.agent_run_uid),
    agentRunName: readNullableString(record.agentRunName ?? record.agent_run_name),
    agentRunNamespace: readNullableString(record.agentRunNamespace ?? record.agent_run_namespace),
    runId: readNullableString(record.runId ?? record.run_id),
    stepId: readNullableString(record.stepId ?? record.step_id),
    agentId: readNullableString(record.agentId ?? record.agent_id),
    role: asString(record.role) ?? 'assistant',
    kind: asString(record.kind) ?? 'message',
    timestamp: readTimestamp(record.timestamp),
    channel: readNullableString(record.channel),
    stage: readNullableString(record.stage),
    content,
    attrs: readAttrs(record.attrs),
    dedupeKey: readNullableString(record.dedupeKey ?? record.dedupe_key),
  }
}

const parseSkipIfExisting = (value: unknown): AgentMessagesSkipIfExisting | undefined => {
  const record = asRecord(value)
  if (!record) return undefined
  const runId = readNullableString(record.runId ?? record.run_id)
  const agentRunUid = readNullableString(record.agentRunUid ?? record.agent_run_uid)
  if (!runId && !agentRunUid) return undefined
  return { runId, agentRunUid }
}

export const parseAgentMessagesIngestPayload = (payload: Record<string, unknown>): IngestAgentMessagesInput => {
  if (!Array.isArray(payload.messages)) {
    throw new AgentMessagesInvalidPayloadError({ message: 'messages array is required' })
  }
  if (payload.messages.length > MAX_INGEST_BATCH_SIZE) {
    throw new AgentMessagesInvalidPayloadError({
      message: `messages batch exceeds ${MAX_INGEST_BATCH_SIZE} entries`,
    })
  }

  return {
    messages: payload.messages.map(parseMessage),
    skipIfExisting: parseSkipIfExisting(payload.skipIfExisting ?? payload.skip_if_existing),
  }
}

export const ingestAgentMessagesEffect = (input: IngestAgentMessagesInput) =>
  Effect.gen(function* () {
    const factory = yield* AgentMessagesStoreFactory
    const publisher = yield* AgentMessagesPublisher

    return yield* Effect.acquireUseRelease(
      factory.create,
      (activeStore) =>
        Effect.gen(function* () {
          if (input.skipIfExisting) {
            const hasMessages = yield* Effect.tryPromise({
              try: () => activeStore.hasMessages(input.skipIfExisting ?? {}),
              catch: storageError('hasMessages'),
            })
            if (hasMessages) {
              return { inserted: [], skipped: true }
            }
          }

          const inserted = yield* Effect.tryPromise({
            try: () => activeStore.insertMessages(input.messages),
            catch: storageError('insertMessages'),
          })
          if (inserted.length > 0) {
            yield* publisher.publish(inserted)
          }
          return { inserted, skipped: false }
        }),
      (activeStore) =>
        Effect.promise(() => activeStore.close()).pipe(
          Effect.catchAll((error) =>
            Effect.sync(() => {
              console.warn('[agents] failed to close agent messages store', error)
            }),
          ),
        ),
    )
  })

export const AgentMessagesStoreFactoryLive = Layer.succeed(AgentMessagesStoreFactory, {
  create: Effect.try({
    try: () => createAgentMessagesStore(),
    catch: storageError('createStore'),
  }),
})

export const AgentMessagesPublisherLive = Layer.succeed(AgentMessagesPublisher, {
  publish: (records) => Effect.sync(() => publishAgentMessages(records)),
})

export const AgentMessagesApiLive = Layer.merge(AgentMessagesStoreFactoryLive, AgentMessagesPublisherLive)

export const describeAgentMessagesIngestError = (error: unknown) => {
  if (error instanceof AgentMessagesInvalidPayloadError) {
    return { status: 400, message: error.message }
  }

  if (error instanceof AgentMessagesStorageError) {
    return { status: error.httpStatusCode, message: error.message }
  }

  return { status: 500, message: toErrorMessage(error) }
}
