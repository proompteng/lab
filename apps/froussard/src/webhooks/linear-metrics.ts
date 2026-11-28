import { type ManagedRuntime, Metric } from 'effect'

export type LinearWebhookDownstream = 'agents' | 'kafka' | 'processing'

export interface LinearWebhookMetrics {
  recordVerificationFailure: (reason: string) => void
  recordDownstreamFailure: (dependency: LinearWebhookDownstream, reason: string) => void
  recordDeliveryLatencyMs: (durationMs: number, outcome: string) => void
}

const verificationFailures = Metric.counter('froussard_linear_webhook_verification_failures_total', {
  description: 'Rejected Linear webhook deliveries before trusted processing',
  incremental: true,
})
const downstreamFailures = Metric.counter('froussard_linear_webhook_downstream_failures_total', {
  description: 'Verified Linear webhook deliveries that failed a downstream dependency',
  incremental: true,
})
const deliveryLatency = Metric.histogram('froussard_linear_webhook_delivery_latency_ms', {
  description: 'End-to-end Linear webhook response latency',
  attributes: { unit: 'milliseconds' },
  boundaries: [1, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000],
})

export const makeLinearWebhookMetrics = (
  runtime: Pick<ManagedRuntime.ManagedRuntime<never, never>, 'runSync'>,
): LinearWebhookMetrics => ({
  recordVerificationFailure: (reason) =>
    runtime.runSync(Metric.update(Metric.withAttributes(verificationFailures, { reason }), 1)),
  recordDownstreamFailure: (dependency, reason) =>
    runtime.runSync(Metric.update(Metric.withAttributes(downstreamFailures, { dependency, reason }), 1)),
  recordDeliveryLatencyMs: (durationMs, outcome) =>
    runtime.runSync(Metric.update(Metric.withAttributes(deliveryLatency, { outcome }), durationMs)),
})
