import {
  type Counter,
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  type Histogram,
  metrics as otelMetrics,
} from '@proompteng/otel/api'
import { OTLPMetricExporter } from '@proompteng/otel/exporter-metrics-otlp-http'
import { Resource } from '@proompteng/otel/resources'
import { MeterProvider, PeriodicExportingMetricReader } from '@proompteng/otel/sdk-metrics'
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from '@proompteng/otel/semantic-conventions'

type JangarMetrics = {
  sseConnections: Counter
  sseErrors: Counter
  agentCommsInserted: Counter
  agentCommsIngestErrors: Counter
  agentCommsInsertDurationMs: Histogram
  agentCommsBatchSize: Histogram
  githubReviewsSubmitted: Counter
  githubMergeAttempts: Counter
  githubMergeFailures: Counter
}

type MetricsState = {
  enabled: boolean
  metrics?: JangarMetrics
  shutdown?: () => void
}

type SseStream = 'chat' | 'agent-events' | 'control-plane'

type AgentCommsErrorStage = 'fetch' | 'insert' | 'decode' | 'unknown'

type MetricsAttributes = Record<string, string>

const DEFAULT_METRICS_ENDPOINT = 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'

const globalState = globalThis as typeof globalThis & {
  __jangarMetrics?: MetricsState
}

diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)

const recordCounter = (counter: Counter | undefined, value: number, attributes?: MetricsAttributes) => {
  if (!counter) return
  counter.add(value, attributes)
}

const recordHistogram = (histogram: Histogram | undefined, value: number, attributes?: MetricsAttributes) => {
  if (!histogram) return
  histogram.record(value, attributes)
}

export const recordSseConnection = (stream: SseStream, state: 'opened' | 'closed') => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.sseConnections, 1, { stream, state })
}

export const recordSseError = (stream: SseStream, reason: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.sseErrors, 1, { stream, reason })
}

export const recordAgentCommsBatch = (count: number, durationMs: number) => {
  if (!metricsState.enabled) return
  if (count > 0) {
    recordCounter(metricsState.metrics?.agentCommsInserted, count)
    recordHistogram(metricsState.metrics?.agentCommsBatchSize, count)
  }
  if (durationMs >= 0) {
    recordHistogram(metricsState.metrics?.agentCommsInsertDurationMs, durationMs)
  }
}

export const recordAgentCommsError = (stage: AgentCommsErrorStage) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.agentCommsIngestErrors, 1, { stage })
}

export const recordGithubReviewSubmitted = (outcome: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.githubReviewsSubmitted, 1, { outcome })
}

export const recordGithubMergeAttempt = () => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.githubMergeAttempts, 1)
}

export const recordGithubMergeFailure = () => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.githubMergeFailures, 1)
}

type OtlpProtocol = 'http/json' | 'http/protobuf' | 'grpc'

const resolveOtlpProtocol = (value: string | undefined): OtlpProtocol => {
  if (!value) return 'http/json'
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

const resolveMetricsEndpoint = (protocol: OtlpProtocol): string | null => {
  const explicit = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim()
  if (explicit) return protocol === 'grpc' ? stripEndpointPath(explicit) : explicit
  const lgtm = process.env.LGTM_MIMIR_METRICS_ENDPOINT?.trim()
  if (lgtm) return protocol === 'grpc' ? stripEndpointPath(lgtm) : lgtm
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (base) {
    if (protocol === 'grpc') {
      return stripEndpointPath(base)
    }
    if (base.endsWith('/v1/metrics')) return base
    const trimmed = base.replace(/\/+$/, '')
    return `${trimmed}/v1/metrics`
  }
  return protocol === 'grpc' ? stripEndpointPath(DEFAULT_METRICS_ENDPOINT) : DEFAULT_METRICS_ENDPOINT
}

const stripEndpointPath = (value: string): string => {
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

const parseHeaders = (value?: string) => {
  if (!value) return undefined
  const result: Record<string, string> = {}
  for (const pair of value.split(',')) {
    const [rawKey, ...rawRest] = pair.split('=')
    if (!rawKey || rawRest.length === 0) continue
    const key = rawKey.trim()
    const rawValue = rawRest.join('=').trim()
    if (!key || !rawValue) continue
    result[key] = rawValue
  }
  return Object.keys(result).length > 0 ? result : undefined
}

const mergeHeaders = (...headers: Array<Record<string, string> | undefined>): Record<string, string> | undefined => {
  const merged: Record<string, string> = {}
  for (const header of headers) {
    if (!header) continue
    Object.assign(merged, header)
  }
  return Object.keys(merged).length > 0 ? merged : undefined
}

const parseTimeoutMillis = (value?: string) => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined
  return parsed
}

const createMetricsState = (): MetricsState => {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return { enabled: false }
  }

  const exporter = (process.env.OTEL_METRICS_EXPORTER ?? '').trim().toLowerCase()
  if (exporter === 'none' || exporter === 'false' || exporter === '0') {
    return { enabled: false }
  }

  const metricsProtocol = resolveOtlpProtocol(
    process.env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL ?? process.env.OTEL_EXPORTER_OTLP_PROTOCOL,
  )
  const metricsEndpoint = resolveMetricsEndpoint(metricsProtocol)
  if (!metricsEndpoint) {
    return { enabled: false }
  }

  try {
    const serviceName = process.env.OTEL_SERVICE_NAME ?? 'jangar'
    const serviceNamespace =
      process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE ?? process.env.KUBERNETES_NAMESPACE ?? 'default'
    const serviceInstanceId =
      process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.POD_NAME ?? process.env.HOSTNAME ?? process.pid.toString()

    const resource = Resource.default().merge(
      new Resource({
        [SEMRESATTRS_SERVICE_NAME]: serviceName,
        [SEMRESATTRS_SERVICE_NAMESPACE]: serviceNamespace,
        [SEMRESATTRS_SERVICE_INSTANCE_ID]: serviceInstanceId,
      }),
    )

    const exportInterval = parseInt(process.env.OTEL_METRIC_EXPORT_INTERVAL ?? '15000', 10)
    const exportIntervalMillis = Number.isFinite(exportInterval) ? Math.max(exportInterval, 5000) : 15000

    const sharedHeaders = parseHeaders(process.env.OTEL_EXPORTER_OTLP_HEADERS)
    const metricHeaders = mergeHeaders(sharedHeaders, parseHeaders(process.env.OTEL_EXPORTER_OTLP_METRICS_HEADERS))

    const timeoutMillis =
      parseTimeoutMillis(process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT) ??
      parseTimeoutMillis(process.env.OTEL_EXPORTER_OTLP_TIMEOUT)
    const exporterInstance = new OTLPMetricExporter({
      url: metricsEndpoint,
      headers: metricHeaders,
      protocol: metricsProtocol,
      ...(timeoutMillis ? { timeoutMillis } : {}),
    })

    const reader = new PeriodicExportingMetricReader({
      exporter: exporterInstance,
      exportIntervalMillis,
    })

    const meterProvider = new MeterProvider({ resource })
    meterProvider.addMetricReader(reader)
    otelMetrics.setGlobalMeterProvider(meterProvider)

    const meter = otelMetrics.getMeter('jangar')

    const metrics: JangarMetrics = {
      sseConnections: meter.createCounter('jangar_sse_connections_total', {
        description: 'Count of SSE connections opened/closed.',
      }),
      sseErrors: meter.createCounter('jangar_sse_errors_total', {
        description: 'Count of SSE errors emitted to clients.',
      }),
      agentCommsInserted: meter.createCounter('jangar_agent_comms_inserted_total', {
        description: 'Count of agent comms messages inserted into Postgres.',
      }),
      agentCommsIngestErrors: meter.createCounter('jangar_agent_comms_ingest_errors_total', {
        description: 'Count of agent comms ingestion errors.',
      }),
      agentCommsInsertDurationMs: meter.createHistogram('jangar_agent_comms_insert_duration_ms', {
        description: 'Time spent inserting agent comms batches into Postgres.',
        unit: 'ms',
      }),
      agentCommsBatchSize: meter.createHistogram('jangar_agent_comms_batch_size', {
        description: 'Batch size for agent comms inserts.',
      }),
      githubReviewsSubmitted: meter.createCounter('jangar_github_review_submitted_total', {
        description: 'Count of GitHub review submissions by outcome.',
      }),
      githubMergeAttempts: meter.createCounter('jangar_github_merge_attempts_total', {
        description: 'Count of GitHub merge attempts initiated from Jangar.',
      }),
      githubMergeFailures: meter.createCounter('jangar_github_merge_failures_total', {
        description: 'Count of GitHub merge attempts that failed.',
      }),
    }

    let shuttingDown = false
    const shutdown = () => {
      if (shuttingDown) return
      shuttingDown = true
      void meterProvider.shutdown().catch((error) => {
        diag.error('failed to shutdown metrics provider', error)
      })
    }

    process.once('SIGTERM', shutdown)
    process.once('SIGINT', shutdown)

    return {
      enabled: true,
      metrics,
      shutdown,
    }
  } catch (error) {
    diag.error('failed to initialize metrics', error)
    return { enabled: false }
  }
}

const metricsState = globalState.__jangarMetrics ?? createMetricsState()
if (!globalState.__jangarMetrics) {
  globalState.__jangarMetrics = metricsState
}
