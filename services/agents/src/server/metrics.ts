type MetricsAttributes = Record<string, string>

export type AgentsMetricsSink = {
  recordAgentConcurrency?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentQueueDepth?: (depth: number, attributes?: MetricsAttributes) => void
  recordAgentRateLimitRejection?: (scope: string, attributes?: MetricsAttributes) => void
  recordAgentRunOutcome?: (outcome: string, attributes?: MetricsAttributes) => void
  recordAgentRunResyncAdoptions?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentRunUntouchedBacklog?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentRunUntouchedOldestAgeSeconds?: (ageSeconds: number, attributes?: MetricsAttributes) => void
  recordRuntimeDebrisDeletedPods?: (count: number, attributes?: MetricsAttributes) => void
  recordRuntimeDebrisDeleteErrors?: (count: number, attributes?: MetricsAttributes) => void
  recordRuntimeDebrisOrphanPods?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentCommsBatch?: (count: number, durationMs: number, attributes?: MetricsAttributes) => void
  recordAgentCommsError?: (stage: string, attributes?: MetricsAttributes) => void
  recordReconcileDurationMs?: (durationMs: number, attributes?: MetricsAttributes) => void
  recordSseConnection?: (stream: string, state: string, attributes?: MetricsAttributes) => void
  recordSseError?: (stream: string, phase: string, attributes?: MetricsAttributes) => void
}

type MetricRecord = {
  labels: MetricsAttributes
  value: number
}

type HistogramRecord = {
  count: number
  labels: MetricsAttributes
  sum: number
}

type MetricDefinition = {
  help: string
  name: string
}

const externalMetricsSink: AgentsMetricsSink = {}

const counters = new Map<string, MetricRecord>()
const histograms = new Map<string, HistogramRecord>()

const METRICS = {
  agentConcurrency: {
    name: 'agents_active_concurrency',
    help: 'Observed active AgentRun concurrency.',
  },
  agentQueueDepth: {
    name: 'agents_agent_queue_depth',
    help: 'Observed queue depth for AgentRun admission control.',
  },
  agentRateLimitRejections: {
    name: 'agents_rate_limit_rejections_total',
    help: 'Count of AgentRun submissions rejected due to rate limits.',
  },
  agentRunOutcomes: {
    name: 'agents_agent_run_outcomes_total',
    help: 'Count of AgentRun terminal outcomes by phase.',
  },
  agentRunResyncAdoptions: {
    name: 'agents_agentrun_resync_adoptions_total',
    help: 'Count of AgentRuns adopted for reconciliation by controller resync sweeps.',
  },
  agentRunUntouchedBacklog: {
    name: 'agents_agentrun_untouched_backlog',
    help: 'Observed count of untouched AgentRuns detected by the controller.',
  },
  agentRunUntouchedOldestAgeSeconds: {
    name: 'agents_agentrun_untouched_oldest_age_seconds',
    help: 'Observed age in seconds of the oldest untouched AgentRun.',
  },
  runtimeDebrisDeletedPods: {
    name: 'agents_runtime_debris_deleted_pods_total',
    help: 'Count of stale terminal runtime Pods deleted by the Agents controller.',
  },
  runtimeDebrisDeleteErrors: {
    name: 'agents_runtime_debris_delete_errors_total',
    help: 'Count of stale terminal runtime Pod deletion errors observed by the Agents controller.',
  },
  runtimeDebrisOrphanPods: {
    name: 'agents_runtime_debris_orphan_pods',
    help: 'Observed count of stale terminal runtime Pods eligible for cleanup.',
  },
  agentCommsInserted: {
    name: 'agents_agent_comms_inserted_total',
    help: 'Count of agent communication messages inserted.',
  },
  agentCommsIngestErrors: {
    name: 'agents_agent_comms_ingest_errors_total',
    help: 'Count of agent communication ingest errors.',
  },
  agentCommsInsertDurationMs: {
    name: 'agents_agent_comms_insert_duration_ms',
    help: 'Time spent inserting agent communication message batches.',
  },
  agentCommsBatchSize: {
    name: 'agents_agent_comms_batch_size',
    help: 'Observed agent communication ingest batch sizes.',
  },
  reconcileDurationMs: {
    name: 'agents_reconcile_duration_ms',
    help: 'Time spent reconciling agents controller resources.',
  },
  sseConnections: {
    name: 'agents_sse_connections_total',
    help: 'Count of SSE connections opened/closed.',
  },
  sseErrors: {
    name: 'agents_sse_errors_total',
    help: 'Count of SSE errors emitted to clients.',
  },
} satisfies Record<string, MetricDefinition>

const sanitizePrometheusName = (name: string) => {
  const sanitized = name.replace(/[^a-zA-Z0-9_:]/g, '_')
  return /^[a-zA-Z_:]/.test(sanitized) ? sanitized : `_${sanitized}`
}

const sanitizePrometheusLabelKey = (key: string) => {
  const sanitized = key.replace(/[^a-zA-Z0-9_]/g, '_')
  return /^[a-zA-Z_]/.test(sanitized) ? sanitized : `_${sanitized}`
}

const escapePrometheusValue = (value: string) =>
  value
    .replace(/\\/g, String.raw`\\`)
    .replace(/\n/g, String.raw`\n`)
    .replace(/"/g, String.raw`\"`)

const formatPrometheusNumber = (value: number) => {
  if (Number.isNaN(value)) return 'NaN'
  if (value === Number.POSITIVE_INFINITY) return '+Inf'
  if (value === Number.NEGATIVE_INFINITY) return '-Inf'
  return String(value)
}

const normalizeAttributes = (attributes: MetricsAttributes = {}) =>
  Object.fromEntries(
    Object.entries(attributes)
      .filter(([key, value]) => key.length > 0 && value !== undefined)
      .map(([key, value]) => [sanitizePrometheusLabelKey(key), value]),
  )

const labelsKey = (labels: MetricsAttributes) =>
  JSON.stringify(Object.entries(labels).sort(([left], [right]) => left.localeCompare(right)))

const metricKey = (definition: MetricDefinition, labels: MetricsAttributes) => `${definition.name}:${labelsKey(labels)}`

const formatPrometheusLabels = (labels: MetricsAttributes) => {
  const entries = Object.entries(labels).sort(([left], [right]) => left.localeCompare(right))
  if (entries.length === 0) return ''
  return `{${entries.map(([key, value]) => `${key}="${escapePrometheusValue(value)}"`).join(',')}}`
}

const recordCounter = (definition: MetricDefinition, increment: number, attributes?: MetricsAttributes) => {
  const labels = normalizeAttributes(attributes)
  const key = metricKey(definition, labels)
  const current = counters.get(key)
  counters.set(key, {
    labels,
    value: (current?.value ?? 0) + increment,
  })
}

const recordHistogram = (definition: MetricDefinition, value: number, attributes?: MetricsAttributes) => {
  const labels = normalizeAttributes(attributes)
  const key = metricKey(definition, labels)
  const current = histograms.get(key)
  histograms.set(key, {
    labels,
    count: (current?.count ?? 0) + 1,
    sum: (current?.sum ?? 0) + value,
  })
}

export const configureAgentsMetricsSink = (sink: AgentsMetricsSink) => {
  Object.assign(externalMetricsSink, sink)
}

export const recordAgentQueueDepth = (depth: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.agentQueueDepth, depth, attributes)
  externalMetricsSink.recordAgentQueueDepth?.(depth, attributes)
}

export const recordAgentRateLimitRejection = (scope: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentRateLimitRejections, 1, { scope, ...attributes })
  externalMetricsSink.recordAgentRateLimitRejection?.(scope, attributes)
}

export const recordAgentConcurrency = (count: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.agentConcurrency, count, attributes)
  externalMetricsSink.recordAgentConcurrency?.(count, attributes)
}

export const recordAgentRunOutcome = (outcome: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentRunOutcomes, 1, { outcome, ...attributes })
  externalMetricsSink.recordAgentRunOutcome?.(outcome, attributes)
}

export const recordAgentRunResyncAdoptions = (count: number, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentRunResyncAdoptions, count, attributes)
  externalMetricsSink.recordAgentRunResyncAdoptions?.(count, attributes)
}

export const recordAgentRunUntouchedBacklog = (count: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.agentRunUntouchedBacklog, count, attributes)
  externalMetricsSink.recordAgentRunUntouchedBacklog?.(count, attributes)
}

export const recordAgentRunUntouchedOldestAgeSeconds = (ageSeconds: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.agentRunUntouchedOldestAgeSeconds, ageSeconds, attributes)
  externalMetricsSink.recordAgentRunUntouchedOldestAgeSeconds?.(ageSeconds, attributes)
}

export const recordRuntimeDebrisDeletedPods = (count: number, attributes?: MetricsAttributes) => {
  if (count <= 0) return
  recordCounter(METRICS.runtimeDebrisDeletedPods, count, attributes)
  externalMetricsSink.recordRuntimeDebrisDeletedPods?.(count, attributes)
}

export const recordRuntimeDebrisDeleteErrors = (count: number, attributes?: MetricsAttributes) => {
  if (count <= 0) return
  recordCounter(METRICS.runtimeDebrisDeleteErrors, count, attributes)
  externalMetricsSink.recordRuntimeDebrisDeleteErrors?.(count, attributes)
}

export const recordRuntimeDebrisOrphanPods = (count: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.runtimeDebrisOrphanPods, count, attributes)
  externalMetricsSink.recordRuntimeDebrisOrphanPods?.(count, attributes)
}

export const recordAgentCommsBatch = (count: number, durationMs: number, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentCommsInserted, count, attributes)
  recordHistogram(METRICS.agentCommsBatchSize, count, attributes)
  recordHistogram(METRICS.agentCommsInsertDurationMs, durationMs, attributes)
  externalMetricsSink.recordAgentCommsBatch?.(count, durationMs, attributes)
}

export const recordAgentCommsError = (stage: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentCommsIngestErrors, 1, { stage, ...attributes })
  externalMetricsSink.recordAgentCommsError?.(stage, attributes)
}

export const recordReconcileDurationMs = (durationMs: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.reconcileDurationMs, durationMs, attributes)
  externalMetricsSink.recordReconcileDurationMs?.(durationMs, attributes)
}

export const recordSseConnection = (stream: string, state: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.sseConnections, 1, { stream, state, ...attributes })
  externalMetricsSink.recordSseConnection?.(stream, state, attributes)
}

export const recordSseError = (stream: string, phase: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.sseErrors, 1, { stream, phase, ...attributes })
  externalMetricsSink.recordSseError?.(stream, phase, attributes)
}

export const renderAgentsPrometheusMetrics = () => {
  if (counters.size === 0 && histograms.size === 0) return '# no metrics collected\n'

  const lines: string[] = []
  const metadataSeen = new Set<string>()

  const appendMetadata = (definition: MetricDefinition, type: 'counter' | 'histogram') => {
    const name = sanitizePrometheusName(definition.name)
    const key = `${name}:${type}`
    if (metadataSeen.has(key)) return name
    metadataSeen.add(key)
    lines.push(`# HELP ${name} ${escapePrometheusValue(definition.help)}`)
    lines.push(`# TYPE ${name} ${type}`)
    return name
  }

  for (const definition of Object.values(METRICS)) {
    const matchingCounters = [...counters.entries()].filter(([key]) => key.startsWith(`${definition.name}:`))
    if (matchingCounters.length > 0) {
      const name = appendMetadata(definition, 'counter')
      for (const [, record] of matchingCounters) {
        lines.push(`${name}${formatPrometheusLabels(record.labels)} ${formatPrometheusNumber(record.value)}`)
      }
    }

    const matchingHistograms = [...histograms.entries()].filter(([key]) => key.startsWith(`${definition.name}:`))
    if (matchingHistograms.length === 0) continue
    const name = appendMetadata(definition, 'histogram')
    for (const [, record] of matchingHistograms) {
      lines.push(
        `${name}_bucket${formatPrometheusLabels({ ...record.labels, le: '+Inf' })} ${formatPrometheusNumber(record.count)}`,
      )
      lines.push(`${name}_sum${formatPrometheusLabels(record.labels)} ${formatPrometheusNumber(record.sum)}`)
      lines.push(`${name}_count${formatPrometheusLabels(record.labels)} ${formatPrometheusNumber(record.count)}`)
    }
  }

  return `${lines.join('\n')}\n`
}

const resetMetricsForTest = () => {
  counters.clear()
  histograms.clear()
  for (const key of Object.keys(externalMetricsSink) as Array<keyof AgentsMetricsSink>) {
    delete externalMetricsSink[key]
  }
}

export const __private = {
  formatPrometheusLabels,
  renderAgentsPrometheusMetrics,
  resetMetricsForTest,
  sanitizePrometheusLabelKey,
  sanitizePrometheusName,
}
