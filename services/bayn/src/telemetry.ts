import { NodeHttpClient } from '@effect/platform-node'
import { Cause, Clock, Config, Context, Effect, Exit, Layer, Logger, Metric, Option } from 'effect'
import { OtlpMetrics, OtlpSerialization, OtlpTracer } from 'effect/observability'
import { HttpClient, type HttpClientError } from 'effect/http'
import { operationCurrentTimeMillis } from './operation-timeout'
import { embeddedBuildMetadata } from './build'
import { currentUtcInstant, nativeWallClock } from './time'

export type OtlpTraceEndpoint =
  | { readonly _tag: 'Disabled' }
  | { readonly _tag: 'Configured'; readonly url: string }
  | { readonly _tag: 'Invalid'; readonly reason: string }

export interface TelemetryRuntimeOptions {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly endpoint?: string
  readonly metricsEndpoint?: string
  readonly environment?: string
  readonly namespace?: string
  readonly instanceId?: string
}

interface TelemetryEnvironment {
  readonly sourceRevision: string | undefined
  readonly endpoint: string | undefined
  readonly metricsEndpoint: string | undefined
  readonly environment: string | undefined
  readonly namespace: string | undefined
  readonly instanceId: string | undefined
}

type SpanAttributes = Readonly<Record<string, string | number | boolean>>

export interface ActiveExecutionStage {
  readonly stage: string
  readonly dependency?: string
  readonly operation?: string
  readonly startedAt: number
}

export interface ExecutionStageTiming {
  readonly stage: string
  readonly dependency?: string
  readonly operation?: string
  readonly count: number
  readonly inclusiveElapsedMs: number
  readonly maxElapsedMs: number
  readonly failures: number
  readonly interruptions: number
}

export const ExecutionStageTimings = Context.Reference<Map<string, ExecutionStageTiming> | undefined>(
  'bayn/ExecutionStageTimings',
  { defaultValue: () => undefined },
)

export const ActiveExecutionStages = Context.Reference<Map<symbol, ActiveExecutionStage> | undefined>(
  'bayn/ActiveExecutionStages',
  { defaultValue: () => undefined },
)

const operationDuration = Metric.histogram('bayn_operation_duration_seconds', {
  description: 'Inclusive wall time of a named operation, including failures and interruptions.',
  boundaries: [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
})
export const telemetryHeartbeat = Metric.gauge('bayn_telemetry_heartbeat_timestamp_seconds')

const decodeOtlpEndpoint = (candidate: string | undefined, path: string): OtlpTraceEndpoint => {
  const value = candidate?.trim()
  if (value === undefined || value.length === 0) return { _tag: 'Disabled' }
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== path ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return { _tag: 'Invalid', reason: `endpoint must be an uncredentialed HTTP(S) ${path} URL` }
    }
    return { _tag: 'Configured', url: url.toString() }
  } catch {
    return { _tag: 'Invalid', reason: 'endpoint is not a valid URL' }
  }
}

export const decodeOtlpTraceEndpoint = (candidate: string | undefined) => decodeOtlpEndpoint(candidate, '/v1/traces')
export const decodeOtlpMetricsEndpoint = (candidate: string | undefined) =>
  decodeOtlpEndpoint(candidate, '/otlp/v1/metrics')

const resourceAttributes = (options: TelemetryRuntimeOptions): Record<string, string> => ({
  'service.namespace': 'bayn',
  ...(options.environment === undefined ? {} : { 'deployment.environment.name': options.environment }),
  ...(options.namespace === undefined ? {} : { 'k8s.namespace.name': options.namespace }),
  ...(options.instanceId === undefined ? {} : { 'service.instance.id': options.instanceId }),
})

const exporterHttpClient = (options: TelemetryRuntimeOptions, signal: 'traces' | 'metrics') => {
  let failedAttempts = 0
  let firstFailureAt: number | undefined
  const exportLoggers = new Set([Logger.withConsoleError(Logger.formatJson)])
  const exportFailure = (
    failureReason: 'http-status' | HttpClientError.HttpClientError['reason']['_tag'],
    httpStatus?: number,
  ) =>
    Effect.gen(function* () {
      failedAttempts++
      firstFailureAt ??= yield* operationCurrentTimeMillis
      yield* Effect.logWarning(`Bayn OTLP ${signal === 'traces' ? 'trace' : 'metrics'} export attempt failed`).pipe(
        Effect.annotateLogs({ consecutiveFailedAttempts: failedAttempts }),
      )
    }).pipe(
      Effect.annotateLogs({
        stage: 'bayn.telemetry.export',
        dependency: 'telemetry',
        signal,
        serviceName: options.serviceName,
        ...(options.serviceVersion === undefined ? {} : { sourceRevision: options.serviceVersion }),
        failureReason,
        ...(httpStatus === undefined ? {} : { httpStatus }),
      }),
      Effect.provideService(Logger.CurrentLoggers, exportLoggers),
    )
  const httpClient = Layer.effect(
    HttpClient.HttpClient,
    Effect.map(HttpClient.HttpClient, (client) =>
      client.pipe(
        HttpClient.tap((response) =>
          response.status >= 200 && response.status < 300
            ? Effect.gen(function* () {
                if (failedAttempts === 0) return
                const checkedAt = yield* operationCurrentTimeMillis
                yield* Effect.logInfo(
                  `Bayn OTLP ${signal === 'traces' ? 'trace' : 'metrics'} export request recovered`,
                ).pipe(
                  Effect.annotateLogs({
                    stage: 'bayn.telemetry.export',
                    dependency: 'telemetry',
                    signal,
                    serviceName: options.serviceName,
                    failedAttempts,
                    outageElapsedMs: firstFailureAt === undefined ? 0 : checkedAt - firstFailureAt,
                    httpStatus: response.status,
                  }),
                  Effect.provideService(Logger.CurrentLoggers, exportLoggers),
                )
                failedAttempts = 0
                firstFailureAt = undefined
              })
            : exportFailure('http-status', response.status),
        ),
        HttpClient.tapError((error) => exportFailure(error.reason._tag)),
      ),
    ),
  ).pipe(Layer.provide(NodeHttpClient.layerNodeHttp))
  return httpClient
}

const traceLayer = (options: TelemetryRuntimeOptions, endpoint: string) =>
  OtlpTracer.layer({
    url: endpoint,
    resource: {
      serviceName: options.serviceName,
      ...(options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion }),
      attributes: resourceAttributes(options),
    },
    exportInterval: '1 second',
    maxBatchSize: 128,
    shutdownTimeout: '3 seconds',
  }).pipe(Layer.provide(Layer.mergeAll(exporterHttpClient(options, 'traces'), OtlpSerialization.layerProtobuf)))

const metricsLayer = (options: TelemetryRuntimeOptions, endpoint: string) =>
  Layer.mergeAll(
    OtlpMetrics.layer({
      url: endpoint,
      resource: {
        serviceName: options.serviceName,
        ...(options.serviceVersion === undefined ? {} : { serviceVersion: options.serviceVersion }),
        attributes: resourceAttributes(options),
      },
      exportInterval: '15 seconds',
      shutdownTimeout: '3 seconds',
    }).pipe(Layer.provide(Layer.mergeAll(exporterHttpClient(options, 'metrics'), OtlpSerialization.layerProtobuf))),
    Layer.effectDiscard(
      Effect.gen(function* () {
        const record = Clock.currentTimeMillis.pipe(
          Effect.flatMap((now) =>
            Metric.update(
              telemetryHeartbeat.pipe(
                Metric.withAttributes({
                  namespace: options.namespace ?? 'bayn',
                  service: options.serviceName,
                  source_revision: options.serviceVersion ?? 'development',
                }),
              ),
              now / 1000,
            ),
          ),
        )
        yield* record
        yield* Effect.sleep('15 seconds').pipe(Effect.andThen(record), Effect.forever, Effect.forkScoped)
      }),
    ),
  )

const optionalText = (name: string) =>
  Config.option(Config.String(name)).pipe(
    Config.map(Option.getOrUndefined),
    Config.map((value) => value?.trim() || undefined),
  )

const telemetryEnvironment = Config.all({
  sourceRevision:
    embeddedBuildMetadata === undefined
      ? optionalText('BAYN_CODE_REVISION')
      : Config.succeed(embeddedBuildMetadata.sourceRevision),
  endpoint: optionalText('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'),
  metricsEndpoint: optionalText('OTEL_EXPORTER_OTLP_METRICS_ENDPOINT'),
  environment: optionalText('NODE_ENV'),
  namespace: optionalText('POD_NAMESPACE'),
  instanceId: optionalText('HOSTNAME'),
})

export const telemetryRuntimeOptions = (
  serviceName: string,
  environment: TelemetryEnvironment,
): TelemetryRuntimeOptions => ({
  serviceName,
  ...(environment.sourceRevision === undefined ? {} : { serviceVersion: environment.sourceRevision }),
  ...(environment.endpoint === undefined ? {} : { endpoint: environment.endpoint }),
  ...(environment.metricsEndpoint === undefined ? {} : { metricsEndpoint: environment.metricsEndpoint }),
  ...(environment.environment === undefined ? {} : { environment: environment.environment }),
  ...(environment.namespace === undefined ? {} : { namespace: environment.namespace }),
  ...(environment.instanceId === undefined ? {} : { instanceId: environment.instanceId }),
})

export const telemetryRuntimeConfig = (serviceName: string) =>
  telemetryEnvironment.pipe(Config.map((environment) => telemetryRuntimeOptions(serviceName, environment)))

export const makeTelemetryRuntimeLayer = (options: TelemetryRuntimeOptions) => {
  const logger = Logger.layer([Logger.consoleJson])
  const endpoint = decodeOtlpTraceEndpoint(options.endpoint)
  const telemetry =
    endpoint._tag === 'Configured'
      ? traceLayer(options, endpoint.url)
      : endpoint._tag === 'Invalid'
        ? Layer.effectDiscard(
            Effect.logWarning('Bayn OTLP tracing is disabled because its endpoint is invalid').pipe(
              Effect.annotateLogs({ reason: endpoint.reason }),
            ),
          )
        : Layer.empty
  return Layer.mergeAll(
    logger,
    telemetry.pipe(Layer.provide(logger)),
    Layer.succeed(Metric.CurrentMetricAttributes, {
      namespace: options.namespace ?? 'bayn',
      service: options.serviceName,
      source_revision: options.serviceVersion ?? 'development',
    }),
  )
}

export const makeMetricsRuntimeLayer = (options: TelemetryRuntimeOptions) => {
  const endpoint = decodeOtlpMetricsEndpoint(options.metricsEndpoint)
  return endpoint._tag === 'Configured'
    ? metricsLayer(options, endpoint.url)
    : endpoint._tag === 'Invalid'
      ? Layer.effectDiscard(
          Effect.logWarning('Bayn OTLP metrics are disabled because their endpoint is invalid').pipe(
            Effect.annotateLogs({ reason: endpoint.reason }),
          ),
        )
      : Layer.empty
}

export const makeConfiguredTelemetryRuntimeLayer = (serviceName: string) =>
  Layer.unwrap(telemetryRuntimeConfig(serviceName).pipe(Effect.map(makeTelemetryRuntimeLayer)))

export const makeConfiguredMetricsRuntimeLayer = (serviceName: string) =>
  Layer.unwrap(telemetryRuntimeConfig(serviceName).pipe(Effect.map(makeMetricsRuntimeLayer)))

export const withObservedSpan =
  (name: string, attributes?: SpanAttributes) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.withSpan(
      Effect.gen(function* () {
        const span = yield* Effect.currentSpan.pipe(Effect.orDie)
        return yield* effect.pipe(
          Effect.annotateLogs({
            trace_id: span.traceId,
            span_id: span.spanId,
          }),
        )
      }),
      name,
      attributes === undefined ? undefined : { attributes },
    )

export const withObservedStage =
  (
    stage: string,
    options: {
      readonly dependency?: string
      readonly operation?: string
      readonly slowAfterMs?: number
      readonly recordCompletion?: boolean
      readonly attributes?: SpanAttributes
    } = {},
  ) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.gen(function* () {
      const nativeStartedAt = yield* currentUtcInstant
      yield* Effect.annotateCurrentSpan({
        'bayn.native_wall.clock': nativeWallClock,
        'bayn.native_wall.started_at': nativeStartedAt,
      })
      const startedAt = yield* operationCurrentTimeMillis
      const activeStages = yield* ActiveExecutionStages
      const stageTimings = yield* ExecutionStageTimings
      const identity = {
        stage,
        ...(options.dependency === undefined ? {} : { dependency: options.dependency }),
        ...(options.operation === undefined ? {} : { operation: options.operation }),
      }
      const stageId = Symbol(stage)
      activeStages?.set(stageId, { ...identity, startedAt })
      return yield* effect.pipe(
        Effect.onExit((exit) =>
          operationCurrentTimeMillis.pipe(
            Effect.flatMap((finishedAt) =>
              Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan('bayn.native_wall.finished_at', yield* currentUtcInstant)
                const elapsedMs = Math.max(0, finishedAt - startedAt)
                const outcome = Exit.isSuccess(exit)
                  ? 'succeeded'
                  : Cause.hasInterruptsOnly(exit.cause)
                    ? 'interrupted'
                    : 'failed'
                yield* Metric.update(
                  operationDuration.pipe(
                    Metric.withAttributes({
                      namespace: 'bayn',
                      stage,
                      operation: options.operation ?? 'none',
                      dependency: options.dependency ?? 'none',
                      outcome,
                    }),
                  ),
                  elapsedMs / 1000,
                )
                if (stageTimings !== undefined) {
                  const key = `${stage}:${options.operation ?? ''}`
                  const previous = stageTimings.get(key)
                  stageTimings.set(key, {
                    ...identity,
                    count: (previous?.count ?? 0) + 1,
                    inclusiveElapsedMs: (previous?.inclusiveElapsedMs ?? 0) + elapsedMs,
                    maxElapsedMs: Math.max(previous?.maxElapsedMs ?? 0, elapsedMs),
                    failures: (previous?.failures ?? 0) + (outcome === 'failed' ? 1 : 0),
                    interruptions: (previous?.interruptions ?? 0) + (outcome === 'interrupted' ? 1 : 0),
                  })
                }
                const slow = elapsedMs >= (options.slowAfterMs ?? 1_000)
                if (Exit.isSuccess(exit) && !slow && options.recordCompletion !== true) return
                const log = Exit.isFailure(exit)
                  ? Effect.logWarning('Bayn execution stage did not complete')
                  : slow
                    ? Effect.logWarning('Bayn operation exceeded its diagnostic threshold')
                    : Effect.logInfo('Bayn execution stage completed')
                return yield* Effect.currentSpan.pipe(
                  Effect.orDie,
                  Effect.flatMap((span) => {
                    const backendPid = span.attributes.get('postgresql.pid')
                    return log.pipe(
                      Effect.annotateLogs({
                        service: 'bayn',
                        ...identity,
                        elapsedMs,
                        outcome,
                        ...(typeof backendPid === 'number' && Number.isInteger(backendPid) && backendPid > 0
                          ? { 'postgresql.pid': backendPid }
                          : {}),
                      }),
                    )
                  }),
                )
              }),
            ),
          ),
        ),
        Effect.ensuring(Effect.sync(() => activeStages?.delete(stageId))),
      )
    }).pipe(
      withObservedSpan(stage, {
        ...options.attributes,
        ...(options.dependency === undefined ? {} : { 'bayn.dependency': options.dependency }),
        ...(options.operation === undefined ? {} : { 'bayn.operation': options.operation }),
      }),
    )
