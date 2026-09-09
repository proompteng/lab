import { NodeHttpClient } from '@effect/platform-node'
import { Config, Effect, Layer, Logger, Option } from 'effect'
import { OtlpSerialization, OtlpTracer } from 'effect/unstable/observability'

export type OtlpTraceEndpoint =
  | { readonly _tag: 'Disabled' }
  | { readonly _tag: 'Configured'; readonly url: string }
  | { readonly _tag: 'Invalid'; readonly reason: string }

export interface TelemetryRuntimeOptions {
  readonly serviceName: string
  readonly serviceVersion?: string
  readonly endpoint?: string
  readonly environment?: string
  readonly namespace?: string
  readonly instanceId?: string
}

interface TelemetryEnvironment {
  readonly sourceRevision: string | undefined
  readonly endpoint: string | undefined
  readonly environment: string | undefined
  readonly namespace: string | undefined
  readonly instanceId: string | undefined
}

type SpanAttributes = Readonly<Record<string, string | number | boolean>>

const tracePath = '/v1/traces'

export const decodeOtlpTraceEndpoint = (candidate: string | undefined): OtlpTraceEndpoint => {
  const value = candidate?.trim()
  if (value === undefined || value.length === 0) return { _tag: 'Disabled' }
  try {
    const url = new URL(value)
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== '' ||
      url.pathname !== tracePath ||
      url.search !== '' ||
      url.hash !== ''
    ) {
      return { _tag: 'Invalid', reason: `endpoint must be an uncredentialed HTTP(S) ${tracePath} URL` }
    }
    return { _tag: 'Configured', url: url.toString() }
  } catch {
    return { _tag: 'Invalid', reason: 'endpoint is not a valid URL' }
  }
}

const resourceAttributes = (options: TelemetryRuntimeOptions): Record<string, string> => ({
  'service.namespace': 'bayn',
  ...(options.environment === undefined ? {} : { 'deployment.environment.name': options.environment }),
  ...(options.namespace === undefined ? {} : { 'k8s.namespace.name': options.namespace }),
  ...(options.instanceId === undefined ? {} : { 'service.instance.id': options.instanceId }),
})

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
  }).pipe(Layer.provide(Layer.mergeAll(NodeHttpClient.layerNodeHttp, OtlpSerialization.layerProtobuf)))

const optionalText = (name: string) =>
  Config.option(Config.string(name)).pipe(
    Config.map(Option.getOrUndefined),
    Config.map((value) => value?.trim() || undefined),
  )

const telemetryEnvironment = Config.all({
  sourceRevision: optionalText('BAYN_CODE_REVISION'),
  endpoint: optionalText('OTEL_EXPORTER_OTLP_TRACES_ENDPOINT'),
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
  return Layer.mergeAll(logger, telemetry.pipe(Layer.provide(logger)))
}

export const makeConfiguredTelemetryRuntimeLayer = (serviceName: string) =>
  Layer.unwrap(telemetryRuntimeConfig(serviceName).pipe(Effect.map(makeTelemetryRuntimeLayer)))

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
