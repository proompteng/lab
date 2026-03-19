import { Context, Effect, Layer } from 'effect'
import * as Fiber from 'effect/Fiber'
import * as Queue from 'effect/Queue'
import * as Ref from 'effect/Ref'

import { WorkflowService } from './workflow'
import type { Logger } from './logger'
import type { PostHogSummary } from './types'

const PROHIBITED_KEY_CHUNKS = ['api_key', 'authorization', 'password', 'secret', 'token']
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 50
const MAX_STRING_LENGTH = 8_000

type CaptureEnvelope = {
  event: '$ai_generation' | '$ai_span' | '$ai_trace'
  properties: Record<string, unknown>
}

export type TelemetryTraceEvent = {
  traceId: string
  sessionId: string
  spanName: string
  inputState: Record<string, unknown>
  properties?: Record<string, unknown>
}

export type TelemetrySpanEvent = {
  traceId: string
  sessionId?: string | null
  spanId: string
  parentId?: string | null
  spanName: string
  inputState?: Record<string, unknown> | null
  outputState?: Record<string, unknown> | null
  latencySeconds?: number | null
  error?: Record<string, unknown> | string | null
  properties?: Record<string, unknown>
}

export type TelemetryGenerationEvent = {
  traceId: string
  sessionId: string
  spanId: string
  parentId?: string | null
  model: string
  provider: string
  input: Array<Record<string, unknown>>
  outputChoices: Array<Record<string, unknown>>
  inputTokens?: number | null
  outputTokens?: number | null
  latencySeconds?: number | null
  timeToFirstTokenSeconds?: number | null
  stream?: boolean | null
  error?: Record<string, unknown> | string | null
  properties?: Record<string, unknown>
}

export interface PostHogTelemetryServiceDefinition {
  readonly captureTrace: (event: TelemetryTraceEvent) => Effect.Effect<void, never>
  readonly captureSpan: (event: TelemetrySpanEvent) => Effect.Effect<void, never>
  readonly captureGeneration: (event: TelemetryGenerationEvent) => Effect.Effect<void, never>
  readonly summary: Effect.Effect<PostHogSummary, never>
}

export class PostHogTelemetryService extends Context.Tag('symphony/PostHogTelemetryService')<
  PostHogTelemetryService,
  PostHogTelemetryServiceDefinition
>() {}

const truncateString = (value: string): string =>
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}…` : value

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value)

const sanitizeValue = (value: unknown): unknown => {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') return truncateString(value)
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (value instanceof Date) return value.toISOString()
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((item) => sanitizeValue(item))
  }
  if (isPlainObject(value)) {
    const sanitized: Record<string, unknown> = {}
    for (const [key, rawValue] of Object.entries(value).slice(0, MAX_OBJECT_KEYS)) {
      const normalizedKey = key.trim()
      if (normalizedKey.length === 0) continue
      const loweredKey = normalizedKey.toLowerCase()
      if (PROHIBITED_KEY_CHUNKS.some((chunk) => loweredKey.includes(chunk))) continue
      sanitized[normalizedKey] = sanitizeValue(rawValue)
    }
    return sanitized
  }
  try {
    return truncateString(JSON.stringify(value))
  } catch {
    return '[unserializable]'
  }
}

const sanitizeRecord = (value: Record<string, unknown>): Record<string, unknown> =>
  sanitizeValue(value) as Record<string, unknown>

const joinUrl = (host: string): string => `${host.replace(/\/+$/, '')}/i/v0/e/`

const sendCaptureRequest = (
  url: string,
  apiKey: string,
  timeoutMs: number,
  envelope: CaptureEnvelope,
): Effect.Effect<void, Error, never> =>
  Effect.tryPromise({
    try: async () => {
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), Math.max(1, timeoutMs))
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json',
          },
          body: JSON.stringify({
            api_key: apiKey,
            event: envelope.event,
            properties: envelope.properties,
          }),
          signal: controller.signal,
        })
        if (!response.ok) {
          throw new Error(`posthog_capture_failed:${response.status}`)
        }
      } finally {
        clearTimeout(timeout)
      }
    },
    catch: (error) => (error instanceof Error ? error : new Error(String(error))),
  })

const buildCommonProperties = (distinctId: string, properties: Record<string, unknown> = {}) =>
  sanitizeRecord({
    distinct_id: distinctId,
    $process_person_profile: false,
    ...properties,
  })

export const makePostHogTelemetryLayer = (logger: Logger) =>
  Layer.scoped(
    PostHogTelemetryService,
    Effect.gen(function* () {
      const workflow = yield* WorkflowService
      const { config } = yield* workflow.current
      const posthogLogger = logger.child({ component: 'posthog-telemetry' })
      const lastErrorRef = yield* Ref.make<string | null>(null)

      if (!config.posthog.enabled || !config.posthog.apiKey) {
        return {
          captureTrace: () => Effect.void,
          captureSpan: () => Effect.void,
          captureGeneration: () => Effect.void,
          summary: Ref.get(lastErrorRef).pipe(
            Effect.map(
              (lastError) =>
                ({
                  enabled: false,
                  host: config.posthog.host,
                  projectId: config.posthog.projectId,
                  distinctId: config.posthog.distinctId,
                  lastError,
                }) satisfies PostHogSummary,
            ),
          ),
        } satisfies PostHogTelemetryServiceDefinition
      }

      const captureUrl = joinUrl(config.posthog.host)
      const posthogApiKey = config.posthog.apiKey
      const queue = yield* Queue.unbounded<CaptureEnvelope>()

      const sendEnvelope = (envelope: CaptureEnvelope) =>
        sendCaptureRequest(captureUrl, posthogApiKey, config.posthog.requestTimeoutMs, envelope).pipe(
          Effect.tap(() => Ref.set(lastErrorRef, null)),
          Effect.catchAll((error) =>
            Ref.set(lastErrorRef, error.message).pipe(
              Effect.zipRight(
                Effect.sync(() => {
                  posthogLogger.log('warn', 'posthog_capture_failed', {
                    error: error.message,
                    event: envelope.event,
                    host: config.posthog.host,
                  })
                }),
              ),
            ),
          ),
        )

      const workerFiber = yield* Effect.forever(Queue.take(queue).pipe(Effect.flatMap(sendEnvelope))).pipe(Effect.fork)

      yield* Effect.addFinalizer(() =>
        Fiber.interrupt(workerFiber).pipe(
          Effect.catchAll(() => Effect.void),
          Effect.zipRight(
            Queue.takeAll(queue).pipe(
              Effect.flatMap((pending) => Effect.forEach(pending, sendEnvelope, { concurrency: 1, discard: true })),
              Effect.catchAll(() => Effect.void),
            ),
          ),
        ),
      )

      const enqueue = (envelope: CaptureEnvelope) =>
        Queue.offer(queue, envelope).pipe(
          Effect.asVoid,
          Effect.catchAll((error) =>
            Ref.set(lastErrorRef, String(error)).pipe(
              Effect.zipRight(
                Effect.sync(() => {
                  posthogLogger.log('warn', 'posthog_enqueue_failed', { error: String(error), event: envelope.event })
                }),
              ),
            ),
          ),
        )

      return {
        captureTrace: (event) =>
          enqueue({
            event: '$ai_trace',
            properties: buildCommonProperties(config.posthog.distinctId, {
              $ai_trace_id: event.traceId,
              $ai_session_id: event.sessionId,
              $ai_span_name: event.spanName,
              $ai_input_state: event.inputState,
              ...event.properties,
            }),
          }),
        captureSpan: (event) =>
          enqueue({
            event: '$ai_span',
            properties: buildCommonProperties(config.posthog.distinctId, {
              $ai_trace_id: event.traceId,
              $ai_session_id: event.sessionId ?? null,
              $ai_span_id: event.spanId,
              $ai_parent_id: event.parentId ?? null,
              $ai_span_name: event.spanName,
              $ai_input_state: event.inputState ?? null,
              $ai_output_state: event.outputState ?? null,
              $ai_latency: event.latencySeconds ?? null,
              error: event.error ?? null,
              ...event.properties,
            }),
          }),
        captureGeneration: (event) =>
          enqueue({
            event: '$ai_generation',
            properties: buildCommonProperties(config.posthog.distinctId, {
              $ai_trace_id: event.traceId,
              $ai_session_id: event.sessionId,
              $ai_span_id: event.spanId,
              $ai_parent_id: event.parentId ?? null,
              $ai_model: event.model,
              $ai_provider: event.provider,
              $ai_input: event.input,
              $ai_output_choices: event.outputChoices,
              $ai_input_tokens: event.inputTokens ?? null,
              $ai_output_tokens: event.outputTokens ?? null,
              $ai_latency: event.latencySeconds ?? null,
              $ai_time_to_first_token: event.timeToFirstTokenSeconds ?? null,
              $ai_stream: event.stream ?? null,
              error: event.error ?? null,
              ...event.properties,
            }),
          }),
        summary: Ref.get(lastErrorRef).pipe(
          Effect.map(
            (lastError) =>
              ({
                enabled: config.posthog.enabled,
                host: config.posthog.host,
                projectId: config.posthog.projectId,
                distinctId: config.posthog.distinctId,
                lastError,
              }) satisfies PostHogSummary,
          ),
        ),
      } satisfies PostHogTelemetryServiceDefinition
    }),
  )
