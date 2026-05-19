import { type Counter, type Histogram, metrics as otelMetrics } from '@proompteng/otel/api'

type MetricsAttributes = Record<string, string>

export type AgentsMetricsSink = {
  recordAgentConcurrency?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentQueueDepth?: (depth: number, attributes?: MetricsAttributes) => void
  recordAgentRateLimitRejection?: (scope: string, attributes?: MetricsAttributes) => void
  recordAgentRunOutcome?: (outcome: string, attributes?: MetricsAttributes) => void
  recordAgentRunResyncAdoptions?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentRunUntouchedBacklog?: (count: number, attributes?: MetricsAttributes) => void
  recordAgentRunUntouchedOldestAgeSeconds?: (ageSeconds: number, attributes?: MetricsAttributes) => void
  recordReconcileDurationMs?: (durationMs: number, attributes?: MetricsAttributes) => void
  recordSseConnection?: (stream: string, state: string, attributes?: MetricsAttributes) => void
  recordSseError?: (stream: string, phase: string, attributes?: MetricsAttributes) => void
}

type AgentsMetricInstruments = {
  agentConcurrency: Histogram
  agentQueueDepth: Histogram
  agentRateLimitRejections: Counter
  agentRunOutcomes: Counter
  agentRunResyncAdoptions: Counter
  agentRunUntouchedBacklog: Histogram
  agentRunUntouchedOldestAgeSeconds: Histogram
  reconcileDurationMs: Histogram
  sseConnections: Counter
  sseErrors: Counter
}

const globalState = globalThis as typeof globalThis & {
  __agentsMetrics?: {
    instruments?: AgentsMetricInstruments
  }
}

const configuredMetricsSink: AgentsMetricsSink = {}

export const configureAgentsMetricsSink = (sink: AgentsMetricsSink) => {
  Object.assign(configuredMetricsSink, sink)
}

const recordCounter = (counter: Counter | undefined, value: number, attributes?: MetricsAttributes) => {
  counter?.add(value, attributes)
}

const recordHistogram = (histogram: Histogram | undefined, value: number, attributes?: MetricsAttributes) => {
  if (!Number.isFinite(value)) return
  histogram?.record(value, attributes)
}

const getAgentsMetricInstruments = (): AgentsMetricInstruments => {
  globalState.__agentsMetrics ??= {}
  if (globalState.__agentsMetrics.instruments) {
    return globalState.__agentsMetrics.instruments
  }

  const meter = otelMetrics.getMeter('agents')
  const instruments: AgentsMetricInstruments = {
    agentConcurrency: meter.createHistogram('agents_active_concurrency', {
      description: 'Observed active AgentRun concurrency.',
    }),
    agentQueueDepth: meter.createHistogram('agents_queue_depth', {
      description: 'Observed queue depth for AgentRun admission control.',
    }),
    agentRateLimitRejections: meter.createCounter('agents_rate_limit_rejections_total', {
      description: 'Count of AgentRun submissions rejected due to rate limits.',
    }),
    agentRunOutcomes: meter.createCounter('agents_agent_run_outcomes_total', {
      description: 'Count of AgentRun terminal outcomes by phase.',
    }),
    agentRunResyncAdoptions: meter.createCounter('agents_agentrun_resync_adoptions_total', {
      description: 'Count of AgentRuns adopted for reconciliation by controller resync sweeps.',
    }),
    agentRunUntouchedBacklog: meter.createHistogram('agents_agentrun_untouched_backlog', {
      description: 'Observed count of untouched AgentRuns detected by the controller.',
    }),
    agentRunUntouchedOldestAgeSeconds: meter.createHistogram('agents_agentrun_untouched_oldest_age_seconds', {
      description: 'Observed age in seconds of the oldest untouched AgentRun.',
      unit: 's',
    }),
    reconcileDurationMs: meter.createHistogram('agents_reconcile_duration_ms', {
      description: 'Time spent reconciling agents controller resources.',
      unit: 'ms',
    }),
    sseConnections: meter.createCounter('agents_sse_connections_total', {
      description: 'Count of SSE connections opened/closed.',
    }),
    sseErrors: meter.createCounter('agents_sse_errors_total', {
      description: 'Count of SSE errors emitted to clients.',
    }),
  }
  globalState.__agentsMetrics.instruments = instruments
  return instruments
}

export const recordAgentQueueDepth = (depth: number, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentQueueDepth) {
    configuredMetricsSink.recordAgentQueueDepth(depth, attributes)
    return
  }
  recordHistogram(getAgentsMetricInstruments().agentQueueDepth, depth, attributes)
}

export const recordAgentRateLimitRejection = (scope: string, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentRateLimitRejection) {
    configuredMetricsSink.recordAgentRateLimitRejection(scope, attributes)
    return
  }
  recordCounter(getAgentsMetricInstruments().agentRateLimitRejections, 1, { scope, ...attributes })
}

export const recordAgentConcurrency = (count: number, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentConcurrency) {
    configuredMetricsSink.recordAgentConcurrency(count, attributes)
    return
  }
  recordHistogram(getAgentsMetricInstruments().agentConcurrency, count, attributes)
}

export const recordAgentRunOutcome = (outcome: string, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentRunOutcome) {
    configuredMetricsSink.recordAgentRunOutcome(outcome, attributes)
    return
  }
  recordCounter(getAgentsMetricInstruments().agentRunOutcomes, 1, { outcome, ...attributes })
}

export const recordAgentRunResyncAdoptions = (count: number, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentRunResyncAdoptions) {
    configuredMetricsSink.recordAgentRunResyncAdoptions(count, attributes)
    return
  }
  if (Number.isFinite(count) && count > 0) {
    recordCounter(getAgentsMetricInstruments().agentRunResyncAdoptions, count, attributes)
  }
}

export const recordAgentRunUntouchedBacklog = (count: number, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentRunUntouchedBacklog) {
    configuredMetricsSink.recordAgentRunUntouchedBacklog(count, attributes)
    return
  }
  if (count >= 0) {
    recordHistogram(getAgentsMetricInstruments().agentRunUntouchedBacklog, count, attributes)
  }
}

export const recordAgentRunUntouchedOldestAgeSeconds = (ageSeconds: number, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordAgentRunUntouchedOldestAgeSeconds) {
    configuredMetricsSink.recordAgentRunUntouchedOldestAgeSeconds(ageSeconds, attributes)
    return
  }
  if (ageSeconds >= 0) {
    recordHistogram(getAgentsMetricInstruments().agentRunUntouchedOldestAgeSeconds, ageSeconds, attributes)
  }
}

export const recordReconcileDurationMs = (durationMs: number, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordReconcileDurationMs) {
    configuredMetricsSink.recordReconcileDurationMs(durationMs, attributes)
    return
  }
  if (durationMs >= 0) {
    recordHistogram(getAgentsMetricInstruments().reconcileDurationMs, durationMs, attributes)
  }
}

export const recordSseConnection = (stream: string, state: string, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordSseConnection) {
    configuredMetricsSink.recordSseConnection(stream, state, attributes)
    return
  }
  recordCounter(getAgentsMetricInstruments().sseConnections, 1, { stream, state, ...attributes })
}

export const recordSseError = (stream: string, phase: string, attributes?: MetricsAttributes) => {
  if (configuredMetricsSink.recordSseError) {
    configuredMetricsSink.recordSseError(stream, phase, attributes)
    return
  }
  recordCounter(getAgentsMetricInstruments().sseErrors, 1, { stream, phase, ...attributes })
}

export const __private = {
  resetForTests: () => {
    delete globalState.__agentsMetrics
    for (const key of Object.keys(configuredMetricsSink) as Array<keyof AgentsMetricsSink>) {
      delete configuredMetricsSink[key]
    }
  },
}
