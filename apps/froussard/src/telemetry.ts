import os from 'node:os'

import { DiagConsoleLogger, DiagLogLevel, diag, trace } from '@proompteng/otel/api'
import { getNodeAutoInstrumentations } from '@proompteng/otel/auto-instrumentations-node'
import { OTLPMetricExporter } from '@proompteng/otel/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@proompteng/otel/exporter-trace-otlp-http'
import { Resource } from '@proompteng/otel/resources'
import { type MetricReader, PeriodicExportingMetricReader } from '@proompteng/otel/sdk-metrics'
import { NodeSDK } from '@proompteng/otel/sdk-node'
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from '@proompteng/otel/semantic-conventions'

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)

type TelemetryState = {
  sdk: NodeSDK
  shuttingDown: boolean
}

const globalContext = globalThis as typeof globalThis & {
  __froussardTelemetryState?: TelemetryState
}

let telemetryState = globalContext.__froussardTelemetryState
if (!telemetryState) {
  telemetryState = createTelemetryState()
  globalContext.__froussardTelemetryState = telemetryState
}

function createTelemetryState(): TelemetryState {
  const serviceName = process.env.OTEL_SERVICE_NAME ?? process.env.LGTM_SERVICE_NAME ?? 'froussard'
  const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE ?? 'default'
  const serviceInstanceId = process.env.POD_NAME ?? process.env.HOSTNAME ?? os.hostname() ?? process.pid.toString()

  const tracesProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_TRACES_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
  )
  const metricsProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
  )

  const defaultTracesEndpoint =
    tracesProtocol === 'grpc'
      ? 'http://observability-tempo-gateway.observability.svc.cluster.local:4317'
      : 'http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces'
  const defaultMetricsEndpoint = 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'

  const tracesEndpoint =
    process.env.LGTM_TEMPO_TRACES_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ??
    resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'traces', tracesProtocol) ??
    defaultTracesEndpoint

  const metricsEndpoint =
    process.env.LGTM_MIMIR_METRICS_ENDPOINT ??
    process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ??
    resolveEndpoint(process.env.OTEL_EXPORTER_OTLP_ENDPOINT, 'metrics', metricsProtocol) ??
    defaultMetricsEndpoint

  const exportInterval = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? '15000', 10)

  const sharedHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
  const traceHeaders = mergeHeaders(sharedHeaders, parseHeaders(process.env.OTEL_EXPORTER_OTLP_TRACES_HEADERS))
  const metricHeaders = mergeHeaders(sharedHeaders, parseHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS))

  const resource = Resource.default().merge(
    new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_NAMESPACE]: serviceNamespace,
      [SEMRESATTRS_SERVICE_INSTANCE_ID]: serviceInstanceId,
    }),
  )

  const metricReader: MetricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: metricsEndpoint,
      headers: metricHeaders,
      protocol: metricsProtocol,
    }),
    exportIntervalMillis: Number.isFinite(exportInterval) ? Math.max(exportInterval, 5000) : 15000,
  })

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: tracesEndpoint,
      headers: traceHeaders,
      protocol: tracesProtocol,
    }),
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': {
          enabled: true,
        },
        '@opentelemetry/instrumentation-undici': {
          enabled: true,
        },
      }),
    ],
  })

  const state: TelemetryState = {
    sdk,
    shuttingDown: false,
  }

  try {
    Promise.resolve(sdk.start())
      .then(() => {
        const tracer = trace.getTracer('froussard')
        const span = tracer.startSpan('froussard.startup')
        span.end()
      })
      .catch((error) => {
        diag.error('failed to start OpenTelemetry SDK', error)
      })
  } catch (error) {
    diag.error('failed to start OpenTelemetry SDK', error)
  }

  const shutdown = () => {
    if (state.shuttingDown) {
      return
    }

    state.shuttingDown = true
    void sdk.shutdown().catch((error) => {
      diag.error('failed to gracefully shutdown OpenTelemetry SDK', error)
    })
  }

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return state
}

function parseHeaders(value?: string) {
  if (!value) {
    return undefined
  }

  const result: Record<string, string> = {}

  for (const pair of value.split(',')) {
    const [rawKey, ...rawRest] = pair.split('=')
    if (!rawKey || rawRest.length === 0) {
      continue
    }

    const key = rawKey.trim()
    const rawValue = rawRest.join('=').trim()
    if (!key || !rawValue) {
      continue
    }

    result[key] = rawValue
  }

  return Object.keys(result).length > 0 ? result : undefined
}

function mergeHeaders(...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined {
  const merged: Record<string, string> = {}

  for (const header of headers) {
    if (!header) {
      continue
    }
    Object.assign(merged, header)
  }

  return Object.keys(merged).length > 0 ? merged : undefined
}

type OtlpProtocol = 'http/json' | 'http/protobuf' | 'grpc'

function resolveOtlpProtocol(value: string | undefined): OtlpProtocol {
  if (!value) {
    return 'http/json'
  }
  const normalized = value.trim().toLowerCase()
  switch (normalized) {
    case 'http/protobuf':
    case 'http/proto':
    case 'protobuf':
    case 'proto':
    case 'http':
      return 'http/protobuf'
    case 'http/json':
    case 'json':
      return 'http/json'
    case 'grpc':
      return 'grpc'
    default:
      diag.warn(
        `Unknown OTLP protocol '${value}', expected grpc, http/protobuf, or http/json. Falling back to http/json.`,
      )
      return 'http/json'
  }
}

function resolveEndpoint(
  endpoint: string | undefined,
  signal: 'traces' | 'metrics',
  protocol: OtlpProtocol,
): string | undefined {
  if (!endpoint) {
    return undefined
  }
  const trimmed = endpoint.trim()
  if (!trimmed) {
    return undefined
  }
  if (protocol === 'grpc') {
    return stripEndpointPath(trimmed)
  }
  const base = trimmed.endsWith('/') ? trimmed.slice(0, -1) : trimmed
  return `${base}/v1/${signal}`
}

function stripEndpointPath(value: string): string {
  try {
    const url = new URL(value)
    url.pathname = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.replace(/\/+$/, '')
  }
}

export const telemetrySdk = telemetryState.sdk
