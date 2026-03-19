import {
  DiagConsoleLogger,
  DiagLogLevel,
  diag,
  type Counter,
  type Gauge,
  type Histogram,
  type Span,
  SpanStatusCode,
  metrics,
  trace,
} from '@proompteng/otel/api'
import { getNodeAutoInstrumentations } from '@proompteng/otel/auto-instrumentations-node'
import { OTLPMetricExporter } from '@proompteng/otel/exporter-metrics-otlp-http'
import { OTLPTraceExporter } from '@proompteng/otel/exporter-trace-otlp-http'
import { Resource } from '@proompteng/otel/resources'
import { PeriodicExportingMetricReader } from '@proompteng/otel/sdk-metrics'
import { NodeSDK } from '@proompteng/otel/sdk-node'
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from '@proompteng/otel/semantic-conventions'
import { Effect } from 'effect'

type MetricAttributes = Record<string, string | number | boolean>

type SymphonyMetrics = {
  pollTicksTotal: Counter
  pollDurationMs: Histogram
  reconcileDurationMs: Histogram
  candidateFetchTotal: Counter
  issueDispatchTotal: Counter
  issueHandoffTotal: Counter
  workerOutcomesTotal: Counter
  workerDurationMs: Histogram
  runningIssues: Gauge
  retryQueueSize: Gauge
  targetHealthReady: Gauge
  leaderState: Gauge
  lastSuccessfulPollTimestampSeconds: Gauge
  codexInputTokensTotal: Counter
  codexOutputTokensTotal: Counter
  codexTotalTokensTotal: Counter
}

type TelemetryState = {
  initialized: boolean
  enabled: boolean
  instance: string
  tracer: ReturnType<typeof trace.getTracer>
  metrics: SymphonyMetrics
  sdk?: NodeSDK
}

const DEFAULT_TRACES_ENDPOINT = 'http://observability-tempo-gateway.observability.svc.cluster.local:4318/v1/traces'
const DEFAULT_METRICS_ENDPOINT = 'http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics'

const globalState = globalThis as typeof globalThis & {
  __symphonyTelemetry?: TelemetryState
}

const isTruthy = (value?: string) => {
  if (!value) return false
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase())
}

const isTestEnv = () => process.env.NODE_ENV === 'test' || Boolean(process.env.VITEST) || Boolean(process.env.BUN_TEST)

const parseNumber = (value?: string): number | undefined => {
  if (!value) return undefined
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : undefined
}

const formatUnknownError = (error: unknown): string => {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  try {
    return JSON.stringify(error)
  } catch {
    return 'unknown error'
  }
}

const resolveInstance = () =>
  process.env.OTEL_SERVICE_NAME?.trim() || process.env.SYMPHONY_INSTANCE_NAME?.trim() || 'symphony'

const recordCounter = (counter: Counter, value: number, attributes?: MetricAttributes) => {
  if (!Number.isFinite(value) || value < 0) return
  counter.add(value, attributes)
}

const recordHistogram = (histogram: Histogram, value: number, attributes?: MetricAttributes) => {
  if (!Number.isFinite(value) || value < 0) return
  histogram.record(value, attributes)
}

const setGauge = (gauge: Gauge, value: number, attributes?: MetricAttributes) => {
  if (!Number.isFinite(value)) return
  gauge.set(value, attributes)
}

const ensureTelemetryState = (): TelemetryState => {
  const existing = globalState.__symphonyTelemetry
  if (existing) return existing

  diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.ERROR)

  const instance = resolveInstance()
  const meter = metrics.getMeter('symphony')
  const tracer = trace.getTracer('symphony')

  const created: TelemetryState = {
    initialized: false,
    enabled: true,
    instance,
    tracer,
    metrics: {
      pollTicksTotal: meter.createCounter('symphony_poll_ticks_total', {
        description: 'Total Symphony poll ticks by result.',
      }),
      pollDurationMs: meter.createHistogram('symphony_poll_duration_ms', {
        description: 'Symphony poll tick duration.',
        unit: 'ms',
      }),
      reconcileDurationMs: meter.createHistogram('symphony_reconcile_duration_ms', {
        description: 'Symphony running-issue reconciliation duration.',
        unit: 'ms',
      }),
      candidateFetchTotal: meter.createCounter('symphony_candidate_fetch_total', {
        description: 'Total candidate issue fetch attempts by result.',
      }),
      issueDispatchTotal: meter.createCounter('symphony_issue_dispatch_total', {
        description: 'Total dispatched issues by state.',
      }),
      issueHandoffTotal: meter.createCounter('symphony_issue_handoff_total', {
        description: 'Total issue handoffs by reason.',
      }),
      workerOutcomesTotal: meter.createCounter('symphony_worker_outcomes_total', {
        description: 'Total Symphony worker outcomes.',
      }),
      workerDurationMs: meter.createHistogram('symphony_worker_duration_ms', {
        description: 'Symphony worker runtime by outcome.',
        unit: 'ms',
      }),
      runningIssues: meter.createGauge('symphony_running_issues', {
        description: 'Current number of running issues.',
      }),
      retryQueueSize: meter.createGauge('symphony_retry_queue_size', {
        description: 'Current number of retry-queued issues.',
      }),
      targetHealthReady: meter.createGauge('symphony_target_health_ready', {
        description: 'Whether target health currently allows dispatch (1 or 0).',
      }),
      leaderState: meter.createGauge('symphony_leader_state', {
        description: 'Whether this replica is currently the leader (1 or 0).',
      }),
      lastSuccessfulPollTimestampSeconds: meter.createGauge('symphony_last_successful_poll_timestamp_seconds', {
        description: 'Unix timestamp of the last successful poll tick.',
        unit: 's',
      }),
      codexInputTokensTotal: meter.createCounter('symphony_codex_input_tokens_total', {
        description: 'Total Codex input tokens consumed by Symphony.',
      }),
      codexOutputTokensTotal: meter.createCounter('symphony_codex_output_tokens_total', {
        description: 'Total Codex output tokens consumed by Symphony.',
      }),
      codexTotalTokensTotal: meter.createCounter('symphony_codex_total_tokens_total', {
        description: 'Total Codex tokens consumed by Symphony.',
      }),
    },
  }
  globalState.__symphonyTelemetry = created
  return created
}

const initializeSdk = () => {
  const state = ensureTelemetryState()
  if (state.initialized) return state

  const serviceName = process.env.OTEL_SERVICE_NAME ?? state.instance
  const serviceNamespace = process.env.OTEL_SERVICE_NAMESPACE ?? process.env.POD_NAMESPACE ?? 'default'
  const serviceInstanceId = process.env.OTEL_SERVICE_INSTANCE_ID ?? process.env.HOSTNAME ?? process.pid.toString()

  if (isTruthy(process.env.OTEL_SDK_DISABLED) || isTestEnv()) {
    state.enabled = false
    state.initialized = true
    return state
  }

  const tracesEndpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? DEFAULT_TRACES_ENDPOINT
  const metricsEndpoint = process.env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT ?? DEFAULT_METRICS_ENDPOINT
  const tracesTimeoutMs = Math.max(parseNumber(process.env.OTEL_EXPORTER_OTLP_TRACES_TIMEOUT) ?? 20_000, 1_000)
  const metricsTimeoutMs = Math.max(parseNumber(process.env.OTEL_EXPORTER_OTLP_METRICS_TIMEOUT) ?? 20_000, 1_000)
  const exportIntervalMillis = Math.max(parseNumber(process.env.OTEL_METRIC_EXPORT_INTERVAL) ?? 15_000, 5_000)
  const exportTimeoutMillis = Math.max(parseNumber(process.env.OTEL_METRIC_EXPORT_TIMEOUT) ?? metricsTimeoutMs, 5_000)

  const resource = Resource.default().merge(
    new Resource({
      [SEMRESATTRS_SERVICE_NAME]: serviceName,
      [SEMRESATTRS_SERVICE_NAMESPACE]: serviceNamespace,
      [SEMRESATTRS_SERVICE_INSTANCE_ID]: serviceInstanceId,
    }),
  )

  const metricReader = new PeriodicExportingMetricReader({
    exporter: new OTLPMetricExporter({
      url: metricsEndpoint,
      protocol: 'http/json',
      timeoutMillis: metricsTimeoutMs,
    }),
    exportIntervalMillis,
    exportTimeoutMillis,
  })

  const sdk = new NodeSDK({
    resource,
    traceExporter: new OTLPTraceExporter({
      url: tracesEndpoint,
      protocol: 'http/json',
      timeoutMillis: tracesTimeoutMs,
    }),
    metricReader,
    instrumentations: [
      getNodeAutoInstrumentations({
        '@opentelemetry/instrumentation-http': { enabled: true },
        '@opentelemetry/instrumentation-undici': { enabled: true },
      }),
    ],
  })

  state.sdk = sdk
  state.initialized = true

  try {
    Promise.resolve(sdk.start()).catch((error) => {
      diag.error('failed to start Symphony OpenTelemetry SDK', error)
    })
  } catch (error) {
    diag.error('failed to start Symphony OpenTelemetry SDK', error)
  }

  const shutdown = () => {
    void sdk.shutdown().catch((error) => {
      diag.error('failed to shutdown Symphony OpenTelemetry SDK', error)
    })
  }

  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)

  return state
}

const metricAttrs = (attributes: MetricAttributes = {}): MetricAttributes => ({
  instance: ensureTelemetryState().instance,
  ...attributes,
})

const spanAttrs = (attributes: MetricAttributes = {}): MetricAttributes => ({
  'service.name': ensureTelemetryState().instance,
  instance: ensureTelemetryState().instance,
  ...attributes,
})

export const initializeSymphonyInstrumentation = () => initializeSdk()

export const startSymphonySpan = (
  name: string,
  attributes: MetricAttributes = {},
  options: { parentSpan?: Span } = {},
) =>
  ensureTelemetryState().tracer.startSpan(name, { attributes: spanAttrs(attributes), parentSpan: options.parentSpan })

export const finishSymphonySpan = (span: Span, error?: unknown) => {
  if (error) {
    span.setStatus({
      code: SpanStatusCode.ERROR,
      message: formatUnknownError(error),
    })
    if (error instanceof Error) {
      span.recordException(error)
    }
  } else {
    span.setStatus({ code: SpanStatusCode.OK })
  }
  span.end()
}

export const withSymphonyEffectSpan = <A, E, R>(
  name: string,
  attributes: MetricAttributes,
  effect: Effect.Effect<A, E, R>,
  options: { parentSpan?: Span } = {},
) =>
  Effect.suspend(() => {
    const span = startSymphonySpan(name, attributes, options)
    return effect.pipe(
      Effect.matchEffect({
        onFailure: (error) =>
          Effect.sync(() => {
            finishSymphonySpan(span, error)
          }).pipe(Effect.zipRight(Effect.fail(error))),
        onSuccess: (result) =>
          Effect.sync(() => {
            finishSymphonySpan(span)
          }).pipe(Effect.as(result)),
      }),
    )
  })

export const recordPollTick = (result: string, durationMs: number) => {
  const state = ensureTelemetryState()
  recordCounter(state.metrics.pollTicksTotal, 1, metricAttrs({ result }))
  recordHistogram(state.metrics.pollDurationMs, durationMs, metricAttrs({ result }))
}

export const recordReconcileDuration = (durationMs: number) => {
  const state = ensureTelemetryState()
  recordHistogram(state.metrics.reconcileDurationMs, durationMs, metricAttrs())
}

export const recordCandidateFetch = (result: string) => {
  const state = ensureTelemetryState()
  recordCounter(state.metrics.candidateFetchTotal, 1, metricAttrs({ result }))
}

export const recordIssueDispatch = (stateName: string) => {
  const state = ensureTelemetryState()
  recordCounter(state.metrics.issueDispatchTotal, 1, metricAttrs({ state: stateName }))
}

export const recordIssueHandoff = (reason: string) => {
  const state = ensureTelemetryState()
  recordCounter(state.metrics.issueHandoffTotal, 1, metricAttrs({ reason }))
}

export const recordWorkerOutcome = (outcome: string, durationMs: number) => {
  const state = ensureTelemetryState()
  recordCounter(state.metrics.workerOutcomesTotal, 1, metricAttrs({ outcome }))
  recordHistogram(state.metrics.workerDurationMs, durationMs, metricAttrs({ outcome }))
}

export const recordCodexTokenUsage = (inputTokens: number, outputTokens: number, totalTokens: number) => {
  const state = ensureTelemetryState()
  recordCounter(state.metrics.codexInputTokensTotal, inputTokens, metricAttrs())
  recordCounter(state.metrics.codexOutputTokensTotal, outputTokens, metricAttrs())
  recordCounter(state.metrics.codexTotalTokensTotal, totalTokens, metricAttrs())
}

export const updateRuntimeGauges = (params: {
  runningIssues: number
  retryQueueSize: number
  targetHealthReady?: boolean
  leaderState?: boolean
  lastSuccessfulPollTimestampSeconds?: number
}) => {
  const state = ensureTelemetryState()
  setGauge(state.metrics.runningIssues, params.runningIssues, metricAttrs())
  setGauge(state.metrics.retryQueueSize, params.retryQueueSize, metricAttrs())
  if (params.targetHealthReady !== undefined) {
    setGauge(state.metrics.targetHealthReady, params.targetHealthReady ? 1 : 0, metricAttrs())
  }
  if (params.leaderState !== undefined) {
    setGauge(state.metrics.leaderState, params.leaderState ? 1 : 0, metricAttrs())
  }
  if (params.lastSuccessfulPollTimestampSeconds !== undefined) {
    setGauge(state.metrics.lastSuccessfulPollTimestampSeconds, params.lastSuccessfulPollTimestampSeconds, metricAttrs())
  }
}

initializeSymphonyInstrumentation()
