import type { RunnerTelemetry } from '../runner-telemetry'

type MetricsAttributes = Record<string, string>

export type AgentsMetricsSink = {
  recordAgentConcurrency?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentQueueDepth?: (depth: number, attributes?: MetricsAttributes) => void
  recordAgentRateLimitRejection?: (scope: string, attributes?: MetricsAttributes) => void
  recordAgentRunOutcome?: (outcome: string, attributes?: MetricsAttributes) => void
  recordAgentRunRetentionDeleteErrors?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentRunRetentionDeletes?: (count: number, attributes?: MetricsAttributes) => void
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
  recordLinearMcpPolicyDenial?: (code: string, tool: string, attributes?: MetricsAttributes) => void
  recordLinearMcpUpstreamError?: (operation: string, attributes?: MetricsAttributes) => void
  recordLinearMcpOAuthRefresh?: (outcome: string, attributes?: MetricsAttributes) => void
  recordLinearMcpContractDrift?: (attributes?: MetricsAttributes) => void
  recordLinearMcpIndeterminateWrite?: (tool: string, attributes?: MetricsAttributes) => void
  recordLinearMcpRequestDurationMs?: (durationMs: number, attributes?: MetricsAttributes) => void
}

type MetricRecord = {
  labels: MetricsAttributes
  value: number
}

type HistogramRecord = {
  buckets: number[]
  count: number
  labels: MetricsAttributes
  sum: number
}

type MetricDefinition = {
  buckets?: readonly number[]
  help: string
  name: string
}

const externalMetricsSink: AgentsMetricsSink = {}

const counters = new Map<string, MetricRecord>()
const gauges = new Map<string, MetricRecord & { observedAt?: number; expiresAt?: number }>()
const histograms = new Map<string, HistogramRecord>()

const METRICS = {
  agentConcurrency: {
    name: 'agents_active_concurrency',
    help: 'Observed active AgentRun concurrency.',
  },
  agentConcurrencyLimit: {
    name: 'agents_concurrency_limit',
    help: 'Configured active AgentRun concurrency limit.',
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
  agentRunRetentionDeletes: {
    name: 'agents_agentrun_retention_deletes_total',
    help: 'Count of terminal AgentRuns deleted by retention cleanup.',
  },
  agentRunRetentionDeleteErrors: {
    name: 'agents_agentrun_retention_delete_errors_total',
    help: 'Count of terminal AgentRun retention cleanup delete errors.',
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
    buckets: [10, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000],
  },
  runnerTokens: {
    name: 'agents_runner_tokens_total',
    help: 'Tokens reported by completed runners; cached input and reasoning are subsets of input and output.',
  },
  runnerQuotaUsedPercent: {
    name: 'agents_runner_quota_used_percent',
    help: 'Observed weekly runner quota used as a percentage, by provider limit ID.',
  },
  runnerRunDurationSeconds: {
    name: 'agents_runner_run_duration_seconds',
    help: 'Elapsed time of completed runners in seconds.',
    buckets: [10, 30, 60, 120, 300, 600, 1200, 1800, 3600, 7200],
  },
  runnerTelemetryPublishErrors: {
    name: 'agents_runner_telemetry_publish_errors_total',
    help: 'Telemetry publish errors reported by completed runners.',
  },
  sseConnections: {
    name: 'agents_sse_connections_total',
    help: 'Count of SSE connections opened/closed.',
  },
  sseErrors: {
    name: 'agents_sse_errors_total',
    help: 'Count of SSE errors emitted to clients.',
  },
  linearMcpPolicyDenials: {
    name: 'agents_linear_mcp_policy_denials_total',
    help: 'Count of Linear MCP calls denied by source-bound policy.',
  },
  linearMcpUpstreamErrors: {
    name: 'agents_linear_mcp_upstream_errors_total',
    help: 'Count of Linear MCP upstream request failures.',
  },
  linearMcpOAuthRefreshes: {
    name: 'agents_linear_mcp_oauth_refresh_total',
    help: 'Count of Linear MCP OAuth client credential refresh outcomes.',
  },
  linearMcpContractDrift: {
    name: 'agents_linear_mcp_contract_drift_total',
    help: 'Count of incompatible Linear MCP upstream tool contracts.',
  },
  linearMcpIndeterminateWrites: {
    name: 'agents_linear_mcp_indeterminate_writes_total',
    help: 'Count of Linear MCP mutations whose result could not be proven.',
  },
  linearMcpRequestDurationMs: {
    name: 'agents_linear_mcp_request_duration_ms',
    help: 'Linear MCP gateway request duration in milliseconds.',
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

const recordGauge = (definition: MetricDefinition, value: number, attributes?: MetricsAttributes) => {
  const labels = normalizeAttributes(attributes)
  gauges.set(metricKey(definition, labels), { labels, value })
}

const recordHistogram = (definition: MetricDefinition, value: number, attributes?: MetricsAttributes) => {
  const labels = normalizeAttributes(attributes)
  const key = metricKey(definition, labels)
  const current = histograms.get(key)
  histograms.set(key, {
    labels,
    buckets: (definition.buckets ?? []).map((bound, index) => (current?.buckets[index] ?? 0) + Number(value <= bound)),
    count: (current?.count ?? 0) + 1,
    sum: (current?.sum ?? 0) + value,
  })
}

export const configureAgentsMetricsSink = (sink: AgentsMetricsSink) => {
  Object.assign(externalMetricsSink, sink)
}

export const recordAgentQueueDepth = (depth: number, attributes?: MetricsAttributes) => {
  recordGauge(METRICS.agentQueueDepth, depth, attributes)
  externalMetricsSink.recordAgentQueueDepth?.(depth, attributes)
}

export const recordAgentRateLimitRejection = (scope: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentRateLimitRejections, 1, { scope, ...attributes })
  externalMetricsSink.recordAgentRateLimitRejection?.(scope, attributes)
}

export const recordAgentConcurrency = (count: number, attributes?: MetricsAttributes) => {
  recordGauge(METRICS.agentConcurrency, count, attributes)
  externalMetricsSink.recordAgentConcurrency?.(count, attributes)
}

export const recordAgentConcurrencyLimit = (
  limit: number,
  attributes: { scope: 'cluster' | 'namespace'; namespace?: string },
) => {
  recordGauge(METRICS.agentConcurrencyLimit, limit, attributes)
}

export const clearAgentsControllerGauges = () => {
  // A former leader must not continue advertising an old fleet snapshot.
  gauges.clear()
}

export const recordAgentRunOutcome = (outcome: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentRunOutcomes, 1, { outcome, ...attributes })
  externalMetricsSink.recordAgentRunOutcome?.(outcome, attributes)
}

export const recordAgentRunRetentionDeletes = (count: number, attributes?: MetricsAttributes) => {
  if (count <= 0) return
  recordCounter(METRICS.agentRunRetentionDeletes, count, attributes)
  externalMetricsSink.recordAgentRunRetentionDeletes?.(count, attributes)
}

export const recordAgentRunRetentionDeleteErrors = (count: number, attributes?: MetricsAttributes) => {
  if (count <= 0) return
  recordCounter(METRICS.agentRunRetentionDeleteErrors, count, attributes)
  externalMetricsSink.recordAgentRunRetentionDeleteErrors?.(count, attributes)
}

export const recordAgentRunResyncAdoptions = (count: number, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.agentRunResyncAdoptions, count, attributes)
  externalMetricsSink.recordAgentRunResyncAdoptions?.(count, attributes)
}

export const recordAgentRunUntouchedBacklog = (count: number, attributes?: MetricsAttributes) => {
  recordGauge(METRICS.agentRunUntouchedBacklog, count, attributes)
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
  recordGauge(METRICS.runtimeDebrisOrphanPods, count, attributes)
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

// Runners can report custom models and Agent names. Bound distinct values across a process lifetime.
const runnerModels = new Set<string>()
const runnerAgents = new Set<string>()
const runnerLimitIds = new Set<string>()
const runnerEfforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'])

const boundedLabel = (value: string | null | undefined, seen: Set<string>, limit: number) => {
  if (!value) return 'unknown'
  if (!/^[a-zA-Z0-9_.:/-]{1,128}$/.test(value)) return 'other'
  if (seen.has(value)) return value
  if (seen.size >= limit) return 'other'
  seen.add(value)
  return value
}

const recordRunnerWeeklyQuota = (telemetry: RunnerTelemetry, nowMs: number) => {
  const { quota } = telemetry
  if (!quota) return
  const window = [quota.primary, quota.secondary].find((candidate) => candidate?.windowDurationMins === 7 * 24 * 60)
  if (!window) return
  const observedAt = Date.parse(telemetry.heartbeatAt)
  // Without a reset timestamp, keep a limited observation rather than a week-long stale alert.
  const expiresAt = window.resetsAt === null ? observedAt + 60 * 60 * 1000 : window.resetsAt * 1000
  if (expiresAt <= nowMs) return
  const labels = { limit_id: boundedLabel(quota.limitId, runnerLimitIds, 8) }
  const key = metricKey(METRICS.runnerQuotaUsedPercent, labels)
  const current = gauges.get(key)
  if (current && window.resetsAt !== null && current.expiresAt === expiresAt) {
    // Another runner can finish later with an older, lower snapshot of the same shared quota.
    current.value = Math.max(current.value, window.usedPercent)
  } else if ((current?.observedAt ?? 0) <= observedAt) {
    gauges.set(key, { labels, value: window.usedPercent, observedAt, expiresAt })
  }
}

export const recordRunnerCompletion = (
  input: {
    outcome: 'Succeeded' | 'Failed' | 'Cancelled'
    agent?: string | null
    durationSeconds?: number
    model?: string | null
    effort?: string | null
    telemetry?: RunnerTelemetry
  },
  nowMs = Date.now(),
) => {
  const { telemetry, durationSeconds } = input
  const model = boundedLabel(telemetry?.model ?? input.model, runnerModels, 16)
  const effort = (telemetry?.effort ?? input.effort)?.trim().toLowerCase()
  const labels = { model, effort: !effort ? 'unknown' : runnerEfforts.has(effort) ? effort : 'other' }

  if (durationSeconds !== undefined && Number.isFinite(durationSeconds) && durationSeconds >= 0) {
    recordHistogram(METRICS.runnerRunDurationSeconds, durationSeconds, { ...labels, outcome: input.outcome })
  }
  if (!telemetry) return
  if (telemetry.usage) {
    const { inputTokens, cachedInputTokens, outputTokens, reasoningOutputTokens } = telemetry.usage
    for (const [direction, tokens] of Object.entries({
      input: inputTokens,
      cached_input: cachedInputTokens,
      output: outputTokens,
      reasoning: reasoningOutputTokens,
    })) {
      recordCounter(METRICS.runnerTokens, tokens, { ...labels, direction })
    }
  }
  recordCounter(METRICS.runnerTelemetryPublishErrors, telemetry.publishErrors, {
    agent: boundedLabel(input.agent, runnerAgents, 32),
  })
  recordRunnerWeeklyQuota(telemetry, nowMs)
}

export const recordSseConnection = (stream: string, state: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.sseConnections, 1, { stream, state, ...attributes })
  externalMetricsSink.recordSseConnection?.(stream, state, attributes)
}

export const recordSseError = (stream: string, phase: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.sseErrors, 1, { stream, phase, ...attributes })
  externalMetricsSink.recordSseError?.(stream, phase, attributes)
}

export const recordLinearMcpPolicyDenial = (code: string, tool: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.linearMcpPolicyDenials, 1, { code, tool, ...attributes })
  externalMetricsSink.recordLinearMcpPolicyDenial?.(code, tool, attributes)
}

export const recordLinearMcpUpstreamError = (operation: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.linearMcpUpstreamErrors, 1, { operation, ...attributes })
  externalMetricsSink.recordLinearMcpUpstreamError?.(operation, attributes)
}

export const recordLinearMcpOAuthRefresh = (outcome: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.linearMcpOAuthRefreshes, 1, { outcome, ...attributes })
  externalMetricsSink.recordLinearMcpOAuthRefresh?.(outcome, attributes)
}

export const recordLinearMcpContractDrift = (attributes?: MetricsAttributes) => {
  recordCounter(METRICS.linearMcpContractDrift, 1, attributes)
  externalMetricsSink.recordLinearMcpContractDrift?.(attributes)
}

export const recordLinearMcpIndeterminateWrite = (tool: string, attributes?: MetricsAttributes) => {
  recordCounter(METRICS.linearMcpIndeterminateWrites, 1, { tool, ...attributes })
  externalMetricsSink.recordLinearMcpIndeterminateWrite?.(tool, attributes)
}

export const recordLinearMcpRequestDurationMs = (durationMs: number, attributes?: MetricsAttributes) => {
  recordHistogram(METRICS.linearMcpRequestDurationMs, durationMs, attributes)
  externalMetricsSink.recordLinearMcpRequestDurationMs?.(durationMs, attributes)
}

export const renderAgentsPrometheusMetrics = (nowMs = Date.now()) => {
  const lines: string[] = []
  const metadataSeen = new Set<string>()

  const appendMetadata = (definition: MetricDefinition, type: 'counter' | 'gauge' | 'histogram') => {
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

    for (const [key, record] of gauges) {
      if (!key.startsWith(`${definition.name}:`)) continue
      if (record.expiresAt !== undefined && record.expiresAt <= nowMs) continue
      const name = appendMetadata(definition, 'gauge')
      lines.push(`${name}${formatPrometheusLabels(record.labels)} ${formatPrometheusNumber(record.value)}`)
    }

    const matchingHistograms = [...histograms.entries()].filter(([key]) => key.startsWith(`${definition.name}:`))
    if (matchingHistograms.length === 0) continue
    const name = appendMetadata(definition, 'histogram')
    for (const [, record] of matchingHistograms) {
      const buckets = 'buckets' in definition ? definition.buckets : []
      for (const [index, bound] of buckets.entries()) {
        lines.push(
          `${name}_bucket${formatPrometheusLabels({ ...record.labels, le: String(bound) })} ${record.buckets[index]}`,
        )
      }
      lines.push(
        `${name}_bucket${formatPrometheusLabels({ ...record.labels, le: '+Inf' })} ${formatPrometheusNumber(record.count)}`,
      )
      lines.push(`${name}_sum${formatPrometheusLabels(record.labels)} ${formatPrometheusNumber(record.sum)}`)
      lines.push(`${name}_count${formatPrometheusLabels(record.labels)} ${formatPrometheusNumber(record.count)}`)
    }
  }

  return lines.length ? `${lines.join('\n')}\n` : '# no metrics collected\n'
}

const resetMetricsForTest = () => {
  counters.clear()
  gauges.clear()
  histograms.clear()
  runnerModels.clear()
  runnerAgents.clear()
  runnerLimitIds.clear()
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
