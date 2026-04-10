import { type Counter, diag, type Histogram, metrics as otelMetrics } from '@proompteng/otel/api'
import { OTLPMetricExporter } from '@proompteng/otel/exporter-metrics-otlp-http'
import { Resource } from '@proompteng/otel/resources'
import { MeterProvider, PeriodicExportingMetricReader, type ResourceMetrics } from '@proompteng/otel/sdk-metrics'
import {
  SEMRESATTRS_SERVICE_INSTANCE_ID,
  SEMRESATTRS_SERVICE_NAME,
  SEMRESATTRS_SERVICE_NAMESPACE,
} from '@proompteng/otel/semantic-conventions'
import { resolveMetricsConfig } from './metrics-config'

type JangarMetrics = {
  sseConnections: Counter
  sseErrors: Counter
  openWebUiDetailTurns: Counter
  openWebUiDetailLinks: Counter
  openWebUiDetailStagedBytes: Histogram
  openWebUiDetailPreviewTruncations: Counter
  openWebUiDetailFallbacks: Counter
  openWebUiDetailRouteRequests: Counter
  agentCommsInserted: Counter
  agentCommsIngestErrors: Counter
  agentCommsInsertDurationMs: Histogram
  agentCommsBatchSize: Histogram
  githubReviewsSubmitted: Counter
  githubMergeAttempts: Counter
  githubMergeFailures: Counter
  agentQueueDepth: Histogram
  agentRateLimitRejections: Counter
  agentConcurrency: Histogram
  agentRunOutcomes: Counter
  agentRunResyncAdoptions: Counter
  agentRunUntouchedBacklog: Histogram
  agentRunUntouchedOldestAgeSeconds: Histogram
  reconcileDurationMs: Histogram
  torghutQuantFrames: Counter
  torghutQuantStaleFrames: Counter
  torghutQuantComputeErrors: Counter
  torghutQuantComputeDurationMs: Histogram
  torghutMarketContextIngestRequests: Counter
  torghutMarketContextRunEvents: Counter
  torghutMarketContextBatchRuns: Counter
  torghutMarketContextBatchRunDurationMs: Histogram
  torghutMarketContextBatchRunSymbols: Histogram
  torghutMarketContextBatchFreshnessLagSeconds: Histogram
  kubeWatchEvents: Counter
  kubeWatchErrors: Counter
  kubeWatchRestarts: Counter
}

type MetricsState = {
  enabled: boolean
  metrics?: JangarMetrics
  shutdown?: () => void
  prometheusEnabled?: boolean
  prometheusPath?: string
  meterProvider?: MeterProvider
}

type SseStream = 'chat' | 'agent-events' | 'control-plane' | 'torghut-quant' | 'torghut-decision'

type AgentCommsErrorStage = 'fetch' | 'insert' | 'decode' | 'unknown'

type MetricsAttributes = Record<string, string>

const globalState = globalThis as typeof globalThis & {
  __jangarMetrics?: MetricsState
}

const recordCounter = (counter: Counter | undefined, value: number, attributes?: MetricsAttributes) => {
  if (!counter) return
  counter.add(value, attributes)
}

const recordHistogram = (histogram: Histogram | undefined, value: number, attributes?: MetricsAttributes) => {
  if (!histogram) return
  histogram.record(value, attributes)
}

const normalizeWatchLabel = (value: string) => {
  const trimmed = value.trim()
  return trimmed ? trimmed : 'unknown'
}

export const recordSseConnection = (stream: SseStream, state: 'opened' | 'closed') => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.sseConnections, 1, { stream, state })
}

export const recordSseError = (stream: SseStream, reason: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.sseErrors, 1, { stream, reason })
}

export const recordOpenWebUIDetailTurn = (mode: 'enabled' | 'text_only' | 'disabled') => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.openWebUiDetailTurns, 1, { mode })
}

export const recordOpenWebUIDetailLink = (outcome: 'created' | 'skipped' | 'failed', kind: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.openWebUiDetailLinks, 1, {
    outcome,
    kind: normalizeWatchLabel(kind),
  })
}

export const recordOpenWebUIDetailStagedBytes = (kind: string, bytes: number) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(bytes) && bytes >= 0) {
    recordHistogram(metricsState.metrics?.openWebUiDetailStagedBytes, bytes, {
      kind: normalizeWatchLabel(kind),
    })
  }
}

export const recordOpenWebUIDetailPreviewTruncation = (kind: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.openWebUiDetailPreviewTruncations, 1, {
    kind: normalizeWatchLabel(kind),
  })
}

export const recordOpenWebUITextOnlyFallback = (reason: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.openWebUiDetailFallbacks, 1, {
    reason: normalizeWatchLabel(reason),
  })
}

export const recordOpenWebUIDetailRouteRequest = (kind: string, outcome: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.openWebUiDetailRouteRequests, 1, {
    kind: normalizeWatchLabel(kind),
    outcome: normalizeWatchLabel(outcome),
  })
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

export const recordAgentQueueDepth = (depth: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(depth)) {
    recordHistogram(metricsState.metrics?.agentQueueDepth, depth, attributes)
  }
}

export const recordAgentRateLimitRejection = (scope: string, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.agentRateLimitRejections, 1, { scope, ...attributes })
}

export const recordAgentConcurrency = (count: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(count)) {
    recordHistogram(metricsState.metrics?.agentConcurrency, count, attributes)
  }
}

export const recordAgentRunOutcome = (outcome: string, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.agentRunOutcomes, 1, { outcome, ...attributes })
}

export const recordAgentRunResyncAdoptions = (count: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(count) && count > 0) {
    recordCounter(metricsState.metrics?.agentRunResyncAdoptions, count, attributes)
  }
}

export const recordAgentRunUntouchedBacklog = (count: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(count) && count >= 0) {
    recordHistogram(metricsState.metrics?.agentRunUntouchedBacklog, count, attributes)
  }
}

export const recordAgentRunUntouchedOldestAgeSeconds = (ageSeconds: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(ageSeconds) && ageSeconds >= 0) {
    recordHistogram(metricsState.metrics?.agentRunUntouchedOldestAgeSeconds, ageSeconds, attributes)
  }
}

export const recordReconcileDurationMs = (durationMs: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    recordHistogram(metricsState.metrics?.reconcileDurationMs, durationMs, attributes)
  }
}

export const recordTorghutQuantFrame = (window: string, freshnessSeconds: number, maxStalenessSeconds: number) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.torghutQuantFrames, 1, { window })
  if (freshnessSeconds > maxStalenessSeconds) {
    recordCounter(metricsState.metrics?.torghutQuantStaleFrames, 1, { window })
  }
}

export const recordTorghutQuantComputeError = (stage: string) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.torghutQuantComputeErrors, 1, { stage })
}

export const recordTorghutQuantComputeDurationMs = (durationMs: number, attributes?: MetricsAttributes) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    recordHistogram(metricsState.metrics?.torghutQuantComputeDurationMs, durationMs, attributes)
  }
}

export const recordTorghutMarketContextIngestRequest = (params: {
  outcome: 'accepted' | 'unauthorized' | 'invalid_payload' | 'ingest_error'
  domain?: string
  runStatus?: string
}) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.torghutMarketContextIngestRequests, 1, {
    outcome: params.outcome,
    domain: params.domain?.trim() ? params.domain.trim() : 'unknown',
    run_status: params.runStatus?.trim() ? params.runStatus.trim() : 'unknown',
  })
}

export const recordTorghutMarketContextRunEvent = (params: {
  endpoint: 'start' | 'progress' | 'evidence' | 'finalize' | 'status'
  outcome: 'accepted' | 'unauthorized' | 'invalid_payload' | 'not_found' | 'rejected' | 'error'
  domain?: string
}) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.torghutMarketContextRunEvents, 1, {
    endpoint: params.endpoint,
    outcome: params.outcome,
    domain: params.domain?.trim() ? params.domain.trim() : 'unknown',
  })
}

export const recordTorghutMarketContextBatchRun = (params: {
  domain: 'fundamentals' | 'news'
  outcome: 'succeeded' | 'partial' | 'failed' | 'skipped_market_closed'
}) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.torghutMarketContextBatchRuns, 1, params)
}

export const recordTorghutMarketContextBatchRunDurationMs = (
  durationMs: number,
  params: { domain: 'fundamentals' | 'news' },
) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(durationMs) && durationMs >= 0) {
    recordHistogram(metricsState.metrics?.torghutMarketContextBatchRunDurationMs, durationMs, params)
  }
}

export const recordTorghutMarketContextBatchRunSymbols = (
  count: number,
  params: {
    domain: 'fundamentals' | 'news'
    category: 'processed' | 'updated' | 'failed'
  },
) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(count) && count >= 0) {
    recordHistogram(metricsState.metrics?.torghutMarketContextBatchRunSymbols, count, params)
  }
}

export const recordTorghutMarketContextBatchFreshnessLagSeconds = (
  lagSeconds: number,
  params: { domain: 'fundamentals' | 'news' },
) => {
  if (!metricsState.enabled) return
  if (Number.isFinite(lagSeconds) && lagSeconds >= 0) {
    recordHistogram(metricsState.metrics?.torghutMarketContextBatchFreshnessLagSeconds, lagSeconds, params)
  }
}

export const recordKubeWatchEvent = (params: { resource: string; namespace: string; type: string }) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.kubeWatchEvents, 1, {
    resource: normalizeWatchLabel(params.resource),
    namespace: normalizeWatchLabel(params.namespace),
    event_type: normalizeWatchLabel(params.type),
  })
}

export const recordKubeWatchError = (params: { resource: string; namespace: string; reason: string }) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.kubeWatchErrors, 1, {
    resource: normalizeWatchLabel(params.resource),
    namespace: normalizeWatchLabel(params.namespace),
    reason: normalizeWatchLabel(params.reason),
  })
}

export const recordKubeWatchRestart = (params: { resource: string; namespace: string; reason: string }) => {
  if (!metricsState.enabled) return
  recordCounter(metricsState.metrics?.kubeWatchRestarts, 1, {
    resource: normalizeWatchLabel(params.resource),
    namespace: normalizeWatchLabel(params.namespace),
    reason: normalizeWatchLabel(params.reason),
  })
}

const sanitizePrometheusName = (name: string) => name.replace(/[^A-Za-z0-9_:]/g, '_')

const sanitizePrometheusLabelKey = (key: string) => key.replace(/[^A-Za-z0-9_]/g, '_')

const escapePrometheusValue = (value: string) => value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')

const formatPrometheusNumber = (value: unknown) => {
  const numeric = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : 0
  return Number.isFinite(numeric) ? `${numeric}` : '0'
}

type OtlpAttributeValue = {
  stringValue?: string
  intValue?: string
  doubleValue?: number
  boolValue?: boolean
  arrayValue?: { values?: OtlpAttributeValue[] }
}

type OtlpAttribute = {
  key?: string
  value?: OtlpAttributeValue
}

const otlpAttributeValueToString = (value: OtlpAttributeValue | undefined): string => {
  if (!value) return ''
  if (typeof value.stringValue === 'string') return value.stringValue
  if (typeof value.intValue === 'string') return value.intValue
  if (typeof value.doubleValue === 'number') return `${value.doubleValue}`
  if (typeof value.boolValue === 'boolean') return value.boolValue ? 'true' : 'false'
  if (value.arrayValue?.values && value.arrayValue.values.length > 0) {
    return `[${value.arrayValue.values.map((entry) => otlpAttributeValueToString(entry)).join(',')}]`
  }
  return ''
}

const toPrometheusLabelPairs = (attributes: unknown): Array<[string, string]> => {
  if (!Array.isArray(attributes)) return []
  const pairs: Array<[string, string]> = []
  for (const raw of attributes) {
    const attribute = raw as OtlpAttribute
    if (!attribute?.key) continue
    const key = sanitizePrometheusLabelKey(attribute.key)
    if (!key) continue
    const value = otlpAttributeValueToString(attribute.value)
    pairs.push([key, value])
  }
  return pairs
}

const formatPrometheusLabels = (pairs: Array<[string, string]>) => {
  if (pairs.length === 0) return ''
  const encoded = [...pairs]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}="${escapePrometheusValue(value)}"`)
  return `{${encoded.join(',')}}`
}

const serializeResourceMetricsToPrometheus = (resourceMetrics: ResourceMetrics | null): string => {
  if (!resourceMetrics) return '# no metrics collected\n'

  const lines: string[] = []
  const metadataSeen = new Set<string>()

  const appendMetadata = (metricName: string, type: 'counter' | 'histogram', description?: string) => {
    const key = `${metricName}:${type}`
    if (metadataSeen.has(key)) return
    metadataSeen.add(key)
    if (description) {
      lines.push(`# HELP ${metricName} ${escapePrometheusValue(description)}`)
    }
    lines.push(`# TYPE ${metricName} ${type}`)
  }

  for (const scope of resourceMetrics.scopeMetrics) {
    for (const metric of scope.metrics) {
      const metricName = sanitizePrometheusName(metric.name)
      if (metric.sum) {
        appendMetadata(metricName, 'counter', metric.description)
        for (const dataPoint of metric.sum.dataPoints) {
          const labels = formatPrometheusLabels(toPrometheusLabelPairs(dataPoint.attributes))
          lines.push(`${metricName}${labels} ${formatPrometheusNumber(dataPoint.asDouble)}`)
        }
        continue
      }

      if (!metric.histogram) continue
      appendMetadata(metricName, 'histogram', metric.description)
      for (const dataPoint of metric.histogram.dataPoints) {
        const labels = toPrometheusLabelPairs(dataPoint.attributes)
        const bucketLabels = formatPrometheusLabels([...labels, ['le', '+Inf']])
        const sharedLabels = formatPrometheusLabels(labels)
        const count = formatPrometheusNumber(dataPoint.count)
        lines.push(`${metricName}_bucket${bucketLabels} ${count}`)
        lines.push(`${metricName}_sum${sharedLabels} ${formatPrometheusNumber(dataPoint.sum)}`)
        lines.push(`${metricName}_count${sharedLabels} ${count}`)
      }
    }
  }

  if (lines.length === 0) return '# no metrics collected\n'
  return `${lines.join('\n')}\n`
}

const createMetricsState = (): MetricsState => {
  const config = resolveMetricsConfig()
  if (config.disabledForTest) {
    return { enabled: false }
  }

  if (!config.enabled) {
    return {
      enabled: false,
      prometheusEnabled: config.prometheusEnabled,
      prometheusPath: config.prometheusPath,
    }
  }

  try {
    const resource = Resource.default().merge(
      new Resource({
        [SEMRESATTRS_SERVICE_NAME]: config.serviceName,
        [SEMRESATTRS_SERVICE_NAMESPACE]: config.serviceNamespace,
        [SEMRESATTRS_SERVICE_INSTANCE_ID]: config.serviceInstanceId,
      }),
    )

    const meterProvider = new MeterProvider({ resource })
    let exporterInstance: OTLPMetricExporter | null = null
    let reader: PeriodicExportingMetricReader | null = null
    if (config.otlpEnabled && config.metricsEndpoint) {
      exporterInstance = new OTLPMetricExporter({
        url: config.metricsEndpoint,
        headers: config.headers,
        protocol: config.metricsProtocol,
        ...(config.timeoutMillis ? { timeoutMillis: config.timeoutMillis } : {}),
      })

      reader = new PeriodicExportingMetricReader({
        exporter: exporterInstance,
        exportIntervalMillis: config.exportIntervalMillis,
      })

      meterProvider.addMetricReader(reader)
    }

    otelMetrics.setGlobalMeterProvider(meterProvider)

    const meter = otelMetrics.getMeter('jangar')

    const metrics: JangarMetrics = {
      sseConnections: meter.createCounter('jangar_sse_connections_total', {
        description: 'Count of SSE connections opened/closed.',
      }),
      sseErrors: meter.createCounter('jangar_sse_errors_total', {
        description: 'Count of SSE errors emitted to clients.',
      }),
      openWebUiDetailTurns: meter.createCounter('jangar_openwebui_detail_turns_total', {
        description: 'Count of OpenWebUI chat turns by detail-link mode.',
      }),
      openWebUiDetailLinks: meter.createCounter('jangar_openwebui_detail_links_total', {
        description: 'Count of OpenWebUI detail-link creation attempts by outcome and kind.',
      }),
      openWebUiDetailStagedBytes: meter.createHistogram('jangar_openwebui_detail_staged_bytes', {
        description: 'Bytes staged into the OpenWebUI detail render store by kind.',
        unit: 'By',
      }),
      openWebUiDetailPreviewTruncations: meter.createCounter('jangar_openwebui_detail_preview_truncations_total', {
        description: 'Count of OpenWebUI activity previews truncated in the assistant transcript by kind.',
      }),
      openWebUiDetailFallbacks: meter.createCounter('jangar_openwebui_detail_fallbacks_total', {
        description: 'Count of OpenWebUI requests that fell back to text-only mode by reason.',
      }),
      openWebUiDetailRouteRequests: meter.createCounter('jangar_openwebui_detail_route_requests_total', {
        description: 'Count of OpenWebUI detail-route requests by kind and outcome.',
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
      agentQueueDepth: meter.createHistogram('jangar_agents_queue_depth', {
        description: 'Observed queue depth for AgentRun admission control.',
      }),
      agentRateLimitRejections: meter.createCounter('jangar_agents_rate_limit_rejections_total', {
        description: 'Count of AgentRun submissions rejected due to rate limits.',
      }),
      agentConcurrency: meter.createHistogram('jangar_agents_active_concurrency', {
        description: 'Observed active AgentRun concurrency.',
      }),
      agentRunOutcomes: meter.createCounter('jangar_agent_run_outcomes_total', {
        description: 'Count of AgentRun terminal outcomes by phase.',
      }),
      agentRunResyncAdoptions: meter.createCounter('jangar_agentrun_resync_adoptions_total', {
        description: 'Count of AgentRuns adopted for reconciliation by controller resync sweeps.',
      }),
      agentRunUntouchedBacklog: meter.createHistogram('jangar_agentrun_untouched_backlog', {
        description: 'Observed count of untouched AgentRuns detected by the controller.',
      }),
      agentRunUntouchedOldestAgeSeconds: meter.createHistogram('jangar_agentrun_untouched_oldest_age_seconds', {
        description: 'Observed age in seconds of the oldest untouched AgentRun.',
        unit: 's',
      }),
      reconcileDurationMs: meter.createHistogram('jangar_reconcile_duration_ms', {
        description: 'Time spent reconciling agents controller resources.',
        unit: 'ms',
      }),
      torghutQuantFrames: meter.createCounter('jangar_torghut_quant_frames_total', {
        description: 'Count of torghut quant control-plane frames computed (per window).',
      }),
      torghutQuantStaleFrames: meter.createCounter('jangar_torghut_quant_stale_frames_total', {
        description: 'Count of torghut quant frames that were stale according to max staleness threshold.',
      }),
      torghutQuantComputeErrors: meter.createCounter('jangar_torghut_quant_compute_errors_total', {
        description: 'Count of torghut quant compute errors.',
      }),
      torghutQuantComputeDurationMs: meter.createHistogram('jangar_torghut_quant_compute_duration_ms', {
        description: 'Time spent computing torghut quant control-plane frames.',
        unit: 'ms',
      }),
      torghutMarketContextIngestRequests: meter.createCounter('jangar_torghut_market_context_ingest_requests_total', {
        description: 'Count of market-context ingest callback requests by outcome/domain.',
      }),
      torghutMarketContextRunEvents: meter.createCounter('jangar_torghut_market_context_run_events_total', {
        description: 'Count of market-context run lifecycle endpoint requests by endpoint/outcome/domain.',
      }),
      torghutMarketContextBatchRuns: meter.createCounter('jangar_torghut_market_context_batch_runs_total', {
        description: 'Count of market-context batch runs by domain/outcome.',
      }),
      torghutMarketContextBatchRunDurationMs: meter.createHistogram(
        'jangar_torghut_market_context_batch_run_duration_ms',
        {
          description: 'Duration of market-context batch runs.',
          unit: 'ms',
        },
      ),
      torghutMarketContextBatchRunSymbols: meter.createHistogram('jangar_torghut_market_context_batch_run_symbols', {
        description: 'Symbol counts per market-context batch run category.',
      }),
      torghutMarketContextBatchFreshnessLagSeconds: meter.createHistogram(
        'jangar_torghut_market_context_batch_freshness_lag_seconds',
        {
          description: 'Freshness lag seconds for symbols updated by market-context batch runs.',
          unit: 's',
        },
      ),
      kubeWatchEvents: meter.createCounter('jangar_kube_watch_events_total', {
        description: 'Count of Kubernetes watch events observed by resource/namespace/type.',
      }),
      kubeWatchErrors: meter.createCounter('jangar_kube_watch_errors_total', {
        description: 'Count of Kubernetes watch processing errors by resource/namespace/reason.',
      }),
      kubeWatchRestarts: meter.createCounter('jangar_kube_watch_restarts_total', {
        description: 'Count of Kubernetes watch restarts by resource/namespace/reason.',
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
      prometheusEnabled: config.prometheusEnabled,
      prometheusPath: config.prometheusPath,
      meterProvider,
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

export const isPrometheusMetricsEnabled = () => Boolean(metricsState.prometheusEnabled)

export const getPrometheusMetricsPath = () => metricsState.prometheusPath ?? '/metrics'

export const renderPrometheusMetrics = async (): Promise<
  { ok: true; body: string } | { ok: false; message: string }
> => {
  if (!metricsState.prometheusEnabled || !metricsState.meterProvider) {
    return { ok: false, message: 'prometheus metrics disabled' }
  }

  try {
    const body = serializeResourceMetricsToPrometheus(metricsState.meterProvider.collect())
    return { ok: true, body }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return { ok: true, body: `# failed to export metrics: ${message}\n` }
  }
}

export const __private = {
  serializeResourceMetricsToPrometheus,
}
