import { context, isSpanContextValid, propagation, trace } from '@opentelemetry/api'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { BatchSpanProcessor, NodeTracerProvider } from '@opentelemetry/sdk-trace-node'
import type { HooksProvider } from '@restatedev/restate-sdk'
import { openTelemetryHook } from '@restatedev/restate-sdk-opentelemetry'
import { Effect } from 'effect'

import { decodeOtlpTraceEndpoint, type TelemetryRuntimeOptions } from '../telemetry'

export interface TraceContextHeaders {
  readonly traceparent?: string
  readonly tracestate?: string
}

export interface RestateTelemetry {
  readonly hooks: readonly HooksProvider[]
  readonly traceHeaders: () => TraceContextHeaders
}

interface RestateTelemetryResource extends RestateTelemetry {
  readonly shutdown: () => Promise<void>
}

const disabledTelemetry: RestateTelemetryResource = {
  hooks: [],
  traceHeaders: () => ({}),
  shutdown: () => Promise.resolve(),
}

const currentTraceHeaders = (): TraceContextHeaders => {
  const carrier: Record<string, string> = {}
  propagation.inject(context.active(), carrier)
  return {
    ...(carrier['traceparent'] === undefined ? {} : { traceparent: carrier['traceparent'] }),
    ...(carrier['tracestate'] === undefined ? {} : { tracestate: carrier['tracestate'] }),
  }
}

export const currentOpenTelemetryLogAnnotations = (): Readonly<Record<string, string>> => {
  const spanContext = trace.getSpan(context.active())?.spanContext()
  return spanContext === undefined || !isSpanContextValid(spanContext)
    ? {}
    : { trace_id: spanContext.traceId, span_id: spanContext.spanId }
}

const configuredTelemetry = (options: TelemetryRuntimeOptions, endpoint: string): RestateTelemetryResource => {
  const exporter = new OTLPTraceExporter({ url: endpoint, timeoutMillis: 3_000 })
  const processor = new BatchSpanProcessor(exporter, {
    maxQueueSize: 1_024,
    maxExportBatchSize: 128,
    scheduledDelayMillis: 1_000,
    exportTimeoutMillis: 3_000,
  })
  const provider = new NodeTracerProvider({
    resource: resourceFromAttributes({
      'service.name': options.serviceName,
      'service.namespace': 'bayn',
      ...(options.serviceVersion === undefined ? {} : { 'service.version': options.serviceVersion }),
      ...(options.environment === undefined ? {} : { 'deployment.environment.name': options.environment }),
      ...(options.namespace === undefined ? {} : { 'k8s.namespace.name': options.namespace }),
      ...(options.instanceId === undefined ? {} : { 'service.instance.id': options.instanceId }),
    }),
    spanProcessors: [processor],
  })
  provider.register()
  return {
    hooks: [
      openTelemetryHook({
        tracer: provider.getTracer('bayn-restate-execution', options.serviceVersion),
        runSpans: true,
        suppressSpanEventsDuringReplay: true,
        additionalAttemptAttributes: { 'service.namespace': 'bayn' },
      }),
    ],
    traceHeaders: currentTraceHeaders,
    shutdown: () => provider.shutdown(),
  }
}

export const acquireRestateTelemetry = (
  options: TelemetryRuntimeOptions,
): Effect.Effect<RestateTelemetry, never, import('effect').Scope.Scope> => {
  const endpoint = decodeOtlpTraceEndpoint(options.endpoint)
  if (endpoint._tag === 'Disabled') return Effect.succeed(disabledTelemetry)
  if (endpoint._tag === 'Invalid') {
    return Effect.logWarning('Bayn Restate tracing is disabled because its OTLP endpoint is invalid').pipe(
      Effect.annotateLogs({ reason: endpoint.reason }),
      Effect.as(disabledTelemetry),
    )
  }
  const acquire: Effect.Effect<RestateTelemetryResource> = Effect.try({
    try: () => configuredTelemetry(options, endpoint.url),
    catch: () => 'INITIALIZATION_FAILED' as const,
  }).pipe(
    Effect.catch(() =>
      Effect.logWarning('Bayn Restate tracing failed to initialize and is disabled').pipe(Effect.as(disabledTelemetry)),
    ),
  )
  return Effect.acquireRelease(acquire, (telemetry) =>
    Effect.promise(() => telemetry.shutdown()).pipe(Effect.timeout('3 seconds'), Effect.ignore),
  )
}
