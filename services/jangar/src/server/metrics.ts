import {
  type Counter,
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  type Histogram,
  metrics as otelMetrics,
} from '@opentelemetry/api'
import { ExportResultCode } from '@opentelemetry/core'
import { JsonMetricsSerializer } from '@opentelemetry/otlp-transformer'
import { Resource } from '@opentelemetry/resources'
import {
  Aggregation,
  AggregationTemporality,
  InstrumentType,
  MeterProvider,
  PeriodicExportingMetricReader,
  type PushMetricExporter,
  type ResourceMetrics,
} from '@opentelemetry/sdk-metrics'
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from '@opentelemetry/semantic-conventions'

type JangarMetrics = {
  sseConnections: Counter
  sseErrors: Counter
  agentCommsInserted: Counter
  agentCommsIngestErrors: Counter
  agentCommsInsertDurationMs: Histogram
  agentCommsBatchSize: Histogram
}

type MetricsState = {
  enabled: boolean
  metrics?: JangarMetrics
  shutdown?: () => void
}

type SseStream = 'chat' | 'agent-events'

type AgentCommsErrorStage = 'fetch' | 'insert' | 'decode' | 'unknown'

type MetricsAttributes = Record<string, string>

const DEFAULT_METRICS_ENDPOINT = 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'

type FetchTimeout = { signal?: AbortSignal; cancel: () => void }

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

const resolveMetricsEndpoint = (): string | null => {
  const explicit = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT?.trim()
  if (explicit) return explicit
  const lgtm = process.env.LGTM_MIMIR_METRICS_ENDPOINT?.trim()
  if (lgtm) return lgtm
  const base = process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim()
  if (base) {
    if (base.endsWith('/v1/metrics')) return base
    const trimmed = base.replace(/\/+$/, '')
    return `${trimmed}/v1/metrics`
  }
  return DEFAULT_METRICS_ENDPOINT
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

const createTimeoutSignal = (timeoutMillis?: number): FetchTimeout => {
  if (!timeoutMillis) return { cancel: () => {} }
  const controller = new AbortController()
  const timeoutId = setTimeout(() => controller.abort(), timeoutMillis)
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timeoutId),
  }
}

class FetchMetricExporter implements PushMetricExporter {
  readonly #url: string
  readonly #headers?: Record<string, string>
  readonly #timeoutMillis?: number
  #shutdown = false

  constructor(url: string, headers?: Record<string, string>, timeoutMillis?: number) {
    this.#url = url
    this.#headers = headers
    this.#timeoutMillis = timeoutMillis
  }

  export(metrics: ResourceMetrics, resultCallback: (result: { code: ExportResultCode; error?: Error }) => void): void {
    if (this.#shutdown) {
      resultCallback({ code: ExportResultCode.FAILED })
      return
    }

    const body = JsonMetricsSerializer.serializeRequest([metrics])
    void this.#send(body)
      .then(() => {
        resultCallback({ code: ExportResultCode.SUCCESS })
      })
      .catch((error) => {
        resultCallback({ code: ExportResultCode.FAILED, error })
      })
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {
    this.#shutdown = true
  }

  selectAggregationTemporality(_instrumentType: InstrumentType): AggregationTemporality {
    return AggregationTemporality.CUMULATIVE
  }

  selectAggregation(_instrumentType: InstrumentType): Aggregation {
    return Aggregation.Default()
  }

  async #send(body: Uint8Array): Promise<void> {
    const { signal, cancel } = createTimeoutSignal(this.#timeoutMillis)
    try {
      const response = await fetch(this.#url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.#headers ?? {}),
        },
        body,
        signal,
      })
      if (!response.ok) {
        const text = await response.text()
        throw new Error(`OTLP metrics export failed: ${response.status} ${response.statusText} ${text}`.trim())
      }
    } finally {
      cancel()
    }
  }
}

const createMetricsState = (): MetricsState => {
  if (process.env.NODE_ENV === 'test' || process.env.VITEST) {
    return { enabled: false }
  }

  const exporter = (process.env.OTEL_METRICS_EXPORTER ?? '').trim().toLowerCase()
  if (exporter === 'none' || exporter === 'false' || exporter === '0') {
    return { enabled: false }
  }

  const metricsEndpoint = resolveMetricsEndpoint()
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
    const exporterInstance = new FetchMetricExporter(metricsEndpoint, metricHeaders, timeoutMillis)

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
