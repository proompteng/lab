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
- `/v1/agent-runs` admission (`services/jangar/src/routes/v1/agent-runs.ts`) enforces namespace/cluster concurrency,
  queue depth, and rate limits using the same env vars and returns 429 responses with limit details. It records queue
  depth via `recordAgentQueueDepth`.
- Queue and rate settings exist in the chart (`controller.queue.*`, `controller.rate.*`) and are rendered into
  env vars in `charts/agents/templates/deployment.yaml`. They are consumed by the API admission path but are not
  enforced for AgentRuns created directly as CRs.
- Cluster: the `agents` deployment sets queue limits (200/50/1000) and rate limits (60s window, 120/30/600) via
  env vars, so API admission uses explicit values.

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

- Reuse the `/v1/agent-runs` admission logic in a validating webhook or controller-side check so direct CR creation
  is also gated by queue and rate limits.
- Emit `Blocked` conditions with reason `QueueLimit` or `RateLimit` when controller-side limits are exceeded.
- Add metrics for rate rejections and active concurrency alongside existing queue depth metrics.

## Operational Notes

- Concurrency controls live in the controller process and apply to all runtime types.
- Queue/rate limits are currently enforced only for API-submitted runs; direct CR creation bypasses them.
- Queue/rate limits should be enforced before runtime submission to avoid noisy Job creation.

## Validation

- Submit runs above the configured limits via `/v1/agent-runs` and confirm 429 responses with limit details.
- Submit AgentRuns as CRs and confirm `Blocked` conditions once controller-side enforcement is added.
- Verify queue depth and rate metrics in the metrics endpoint.

## Operational Considerations

- Keep configuration in the appropriate control plane (Helm values, CI, or code) and document overrides.
- Update runbooks with enable/disable steps, rollback guidance, and expected failure modes.

## Rollout

- Ship behind feature flags or conservative defaults; validate in non-prod or CI first.
- Verify deployment health (CI checks, ArgoCD sync, logs/metrics) before widening rollout.

## Risks and Mitigations

- Misconfiguration can cause deployment or runtime regressions; mitigate with schema validation and safe defaults.
- Additional load or latency can impact controller throughput or CI runtime; mitigate with caps and monitoring.
