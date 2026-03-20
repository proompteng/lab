import { Context, Effect, Layer } from 'effect'
import { PostHog } from 'posthog-node'
import * as Ref from 'effect/Ref'

import type { Logger } from './logger'
import type { PostHogSummary } from './types'
import { WorkflowService } from './workflow'

const PROHIBITED_KEY_CHUNKS = ['api_key', 'authorization', 'password', 'secret', 'token']
const ALLOWED_TOKEN_METRIC_KEYS = new Set(['$ai_input_tokens', '$ai_output_tokens', '$ai_time_to_first_token'])
const MAX_ARRAY_ITEMS = 20
const MAX_OBJECT_KEYS = 50
const MAX_STRING_LENGTH = 8_000
const SHUTDOWN_TIMEOUT_MS = 30_000

export type TelemetryTraceEvent = {
  traceId: string
  sessionId: string
  spanName: string
  inputState: Record<string, unknown>
  outputState?: Record<string, unknown> | null
  latencySeconds?: number | null
  error?: Record<string, unknown> | string | null
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
  spanName?: string | null
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
  value.length > MAX_STRING_LENGTH ? `${value.slice(0, MAX_STRING_LENGTH)}...` : value

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
      if (
        PROHIBITED_KEY_CHUNKS.some((chunk) => loweredKey.includes(chunk)) &&
        !ALLOWED_TOKEN_METRIC_KEYS.has(loweredKey)
      ) {
        continue
      }
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

const buildCommonProperties = (properties: Record<string, unknown> = {}) =>
  sanitizeRecord({
    $process_person_profile: false,
    ...properties,
  })

const buildErrorProperties = (error: Record<string, unknown> | string | null | undefined): Record<string, unknown> =>
  error == null
    ? {}
    : {
        $ai_is_error: true,
        $ai_error: sanitizeValue(error),
      }

export const buildTraceCaptureProperties = (event: TelemetryTraceEvent): Record<string, unknown> =>
  buildCommonProperties({
    $ai_trace_id: event.traceId,
    $ai_session_id: event.sessionId,
    $ai_span_name: event.spanName,
    $ai_input_state: event.inputState,
    $ai_output_state: event.outputState ?? null,
    $ai_latency: event.latencySeconds ?? null,
    ...buildErrorProperties(event.error),
    ...event.properties,
  })

export const buildSpanCaptureProperties = (event: TelemetrySpanEvent): Record<string, unknown> =>
  buildCommonProperties({
    $ai_trace_id: event.traceId,
    $ai_session_id: event.sessionId ?? null,
    $ai_span_id: event.spanId,
    $ai_parent_id: event.parentId ?? null,
    $ai_span_name: event.spanName,
    $ai_input_state: event.inputState ?? null,
    $ai_output_state: event.outputState ?? null,
    $ai_latency: event.latencySeconds ?? null,
    ...buildErrorProperties(event.error),
    ...event.properties,
  })

export const buildGenerationCaptureProperties = (event: TelemetryGenerationEvent): Record<string, unknown> =>
  buildCommonProperties({
    $ai_trace_id: event.traceId,
    $ai_session_id: event.sessionId,
    $ai_span_id: event.spanId,
    $ai_span_name: event.spanName ?? null,
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
    ...buildErrorProperties(event.error),
    ...event.properties,
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

      const posthogApiKey = config.posthog.apiKey
      const client = yield* Effect.try({
        try: () =>
          new PostHog(posthogApiKey, {
            host: config.posthog.host,
            flushAt: config.posthog.flushAt,
            flushInterval: config.posthog.flushIntervalMs,
            requestTimeout: config.posthog.requestTimeoutMs,
            disableGeoip: true,
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(
        Effect.tapError((error) =>
          Ref.set(lastErrorRef, error.message).pipe(
            Effect.zipRight(
              Effect.sync(() => {
                posthogLogger.log('warn', 'posthog_init_failed', {
                  error: error.message,
                  host: config.posthog.host,
                })
              }),
            ),
          ),
        ),
      )

      yield* Effect.addFinalizer(() =>
        Effect.tryPromise({
          try: async () => {
            await Promise.resolve(client.shutdown(SHUTDOWN_TIMEOUT_MS))
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.catchAll((error) =>
            Ref.set(lastErrorRef, error.message).pipe(
              Effect.zipRight(
                Effect.sync(() => {
                  posthogLogger.log('warn', 'posthog_shutdown_failed', {
                    error: error.message,
                    host: config.posthog.host,
                  })
                }),
              ),
            ),
          ),
        ),
      )

      const capture = (event: '$ai_generation' | '$ai_span' | '$ai_trace', properties: Record<string, unknown>) =>
        Effect.try({
          try: () => {
            client.capture({
              distinctId: config.posthog.distinctId,
              event,
              properties,
            })
          },
          catch: (error) => (error instanceof Error ? error : new Error(String(error))),
        }).pipe(
          Effect.tap(() => Ref.set(lastErrorRef, null)),
          Effect.catchAll((error) =>
            Ref.set(lastErrorRef, error.message).pipe(
              Effect.zipRight(
                Effect.sync(() => {
                  posthogLogger.log('warn', 'posthog_capture_failed', {
                    error: error.message,
                    event,
                    host: config.posthog.host,
                  })
                }),
              ),
            ),
          ),
        )

      return {
        captureTrace: (event) => capture('$ai_trace', buildTraceCaptureProperties(event)),
        captureSpan: (event) => capture('$ai_span', buildSpanCaptureProperties(event)),
        captureGeneration: (event) => capture('$ai_generation', buildGenerationCaptureProperties(event)),
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
