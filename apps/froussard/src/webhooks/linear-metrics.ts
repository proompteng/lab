import { metrics } from '@proompteng/otel/api'

export type LinearWebhookDownstream = 'agents' | 'kafka' | 'processing'

export interface LinearWebhookMetrics {
  recordVerificationFailure: (reason: string) => void
  recordDownstreamFailure: (dependency: LinearWebhookDownstream, reason: string) => void
  recordDeliveryLatencyMs: (durationMs: number, outcome: string) => void
}

const meter = metrics.getMeter('froussard-linear-webhook', '1.0.0')
const verificationFailures = meter.createCounter('froussard_linear_webhook_verification_failures_total', {
  description: 'Rejected Linear webhook deliveries before trusted processing',
})
const downstreamFailures = meter.createCounter('froussard_linear_webhook_downstream_failures_total', {
  description: 'Verified Linear webhook deliveries that failed a downstream dependency',
})
const deliveryLatency = meter.createHistogram('froussard_linear_webhook_delivery_latency_ms', {
  description: 'End-to-end Linear webhook response latency',
  unit: 'ms',
})

export const linearWebhookMetrics: LinearWebhookMetrics = {
  recordVerificationFailure: (reason) => verificationFailures.add(1, { reason }),
  recordDownstreamFailure: (dependency, reason) => downstreamFailures.add(1, { dependency, reason }),
  recordDeliveryLatencyMs: (durationMs, outcome) => deliveryLatency.record(durationMs, { outcome }),
}
