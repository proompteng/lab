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

const metricsSink: AgentsMetricsSink = {}

export const configureAgentsMetricsSink = (sink: AgentsMetricsSink) => {
  Object.assign(metricsSink, sink)
}

export const recordAgentQueueDepth = (depth: number, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentQueueDepth?.(depth, attributes)
}

export const recordAgentRateLimitRejection = (scope: string, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentRateLimitRejection?.(scope, attributes)
}

export const recordAgentConcurrency = (count: number, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentConcurrency?.(count, attributes)
}

export const recordAgentRunOutcome = (outcome: string, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentRunOutcome?.(outcome, attributes)
}

export const recordAgentRunResyncAdoptions = (count: number, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentRunResyncAdoptions?.(count, attributes)
}

export const recordAgentRunUntouchedBacklog = (count: number, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentRunUntouchedBacklog?.(count, attributes)
}

export const recordAgentRunUntouchedOldestAgeSeconds = (ageSeconds: number, attributes?: MetricsAttributes) => {
  metricsSink.recordAgentRunUntouchedOldestAgeSeconds?.(ageSeconds, attributes)
}

export const recordReconcileDurationMs = (durationMs: number, attributes?: MetricsAttributes) => {
  metricsSink.recordReconcileDurationMs?.(durationMs, attributes)
}

export const recordSseConnection = (stream: string, state: string, attributes?: MetricsAttributes) => {
  metricsSink.recordSseConnection?.(stream, state, attributes)
}

export const recordSseError = (stream: string, phase: string, attributes?: MetricsAttributes) => {
  metricsSink.recordSseError?.(stream, phase, attributes)
}
