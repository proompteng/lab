# Throughput Backpressure and Admission Control

Status: Partial (2026-02-05)

## Purpose
Prevent high-volume AgentRuns from overwhelming the controller or the cluster by enforcing concurrency, queue, and
rate limits.

## Current State
- Concurrency is enforced in `services/jangar/src/server/agents-controller.ts`:
  - `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_NAMESPACE` (default 10)
  - `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_AGENT` (default 5)
  - `JANGAR_AGENTS_CONTROLLER_CONCURRENCY_CLUSTER` (default 100)
  - Exceeded limits set `AgentRun.status.conditions[type=Blocked]` with `ConcurrencyLimit`.
- Queue and rate settings exist in the chart (`controller.queue.*`, `controller.rate.*`) and are rendered into
  env vars in `charts/agents/templates/deployment.yaml`, but they are not currently consumed by the controller.
- Cluster: the `agents` deployment sets the three concurrency env vars but does not include queue/rate env vars.

## Design
- Keep concurrency enforcement as the first line of defense.
- Add queue depth enforcement to bound pending AgentRuns per namespace, repo, and cluster.
- Add rate limits to smooth burst traffic from automation or external event sources.

## Configuration
`charts/agents/values.yaml` already defines:
- `controller.queue.perNamespace`, `controller.queue.perRepo`, `controller.queue.cluster`
- `controller.rate.windowSeconds`, `controller.rate.perNamespace`, `controller.rate.perRepo`, `controller.rate.cluster`

These should map to:
- `JANGAR_AGENTS_CONTROLLER_QUEUE_NAMESPACE`
- `JANGAR_AGENTS_CONTROLLER_QUEUE_REPO`
- `JANGAR_AGENTS_CONTROLLER_QUEUE_CLUSTER`
- `JANGAR_AGENTS_CONTROLLER_RATE_WINDOW_SECONDS`
- `JANGAR_AGENTS_CONTROLLER_RATE_NAMESPACE`
- `JANGAR_AGENTS_CONTROLLER_RATE_REPO`
- `JANGAR_AGENTS_CONTROLLER_RATE_CLUSTER`

## Implementation Plan
1. Add queue counters keyed by namespace and repository, updated when AgentRuns enter/exit the pending queue.
2. Add rate counters using a fixed window or token bucket with the above env vars.
3. Emit `Blocked` conditions with reason `QueueLimit` or `RateLimit` when limits are exceeded.
4. Add metrics for queue depth, rate rejections, and active concurrency.

## Operational Notes
- Concurrency controls live in the controller process and apply to all runtime types.
- Queue/rate limits should be enforced before runtime submission to avoid noisy Job creation.

## Validation
- Submit runs above the configured limits and confirm `Blocked` conditions in AgentRun status.
- Verify queue depth and rate metrics in the controller logs/metrics endpoint.
