# Bayn cycle operations

Bayn remains fail-closed. A healthy pod, a clear alert, or a terminal cycle does not grant broker or capital authority.

## Read the bounded state

1. Read `GET /v1/status` and record `build`, `qualification`, `cycle`, `authority`, and `broker`.
2. Confirm `authority.brokerOrders=false` and `authority.capitalPromotion=false` before any OBSERVE investigation.
3. Use `cycle.current.cycleId`, `cycle.last.cycleId`, the selected sessions, cutoff, phase, and reason to correlate
   structured Bayn logs. Cycle IDs are intentionally absent from Prometheus labels.
4. Compare the durable mutation event count before and after the observation window. Do not infer zero mutation from
   readiness alone.

## Trace one lifecycle pass

1. Query Tempo for `resource.service.name = "restate"`, `"bayn-execution-controller"`, and `"bayn"` over the same
   bounded window.
2. Follow the `BaynExecutionController/tick` Restate attempt into the native execution advance and
   `bayn.reconciliation.run` spans. Broker and mutation spans remain children of the Bayn execution trace.
3. Use the emitted `trace_id` and `span_id` fields to move between Tempo and the correlated JSON logs in Loki. Never
   use account identifiers, credentials, order payloads, or other high-cardinality business data as trace attributes.
   Query the bounded log stream with `{job="bayn", namespace="bayn"} |= "<trace_id>"`; the trace ID stays in the JSON
   payload rather than becoming a high-cardinality Loki label.
4. Treat a missing segment as an observability failure: verify the workload's exact source revision, its OTLP endpoint,
   and the namespace-scoped NetworkPolicy path to the Tempo distributor. A partial trace is not execution proof.

## Alert actions

- `BaynMetricsUnavailable`: verify the Bayn pod, the observability Alloy pod-discovery target, and the NetworkPolicy.
  If Bayn failed before HTTP startup, inspect startup logs and compare configured provenance with the embedded
  source revision, image digest, strategy behavior hash, and strategy parameter hash.
- `BaynStatusReplicaTargetMissed`: compare the `bayn` Deployment's desired and available replicas. One surviving
  READY status pod is not full read-plane availability. Restore the missing replica and hostname spread; do not
  compensate by changing execution ownership or authority.
- `BaynEgressProxyReplicaTargetMissed`: compare the `bayn-egress-proxy` Deployment's desired and available replicas.
  Preserve both stateless proxy replicas and their hostname spread so one node loss does not remove broker read
  connectivity. Do not bypass the proxy or broaden broker egress.
- `BaynExecutionWorkerUnavailable`: inspect the Restate-managed `bayn-execution-controller-*` ReplicaSets and pods,
  then the active Restate worker revision and controller projection. Keep trading fail-closed until at least one
  configured worker is Ready; never create a second scheduler or bypass Restate to recover execution.
- `BaynExecutionWorkerReplicaTargetMissed`: compare the summed desired and Ready replicas across the
  Restate-managed `bayn-execution-controller-*` ReplicaSets. A healthy active controller with fewer Ready workers than
  desired has lost failover capacity. Restore the missing worker while preserving Restate serialization and the
  PostgreSQL writer fence; do not promote a pod to an independent writer.
- `BaynExecutionControllerOverdue`: compare the active controller's `lastSequence`, `completedAt`, and `nextDueAt` in
  `GET /v1/status`, then inspect Restate for a paused or retrying `BaynExecutionController/.../tick` invocation. Ready
  worker replicas do not prove durable execution progress. Restore the existing Restate invocation path; never create
  a replacement scheduler or bypass the PostgreSQL writer fence.
- `BaynExecutionSessionAdmissionMissed`: inspect `autonomousCycleLoop.lastPass` in `GET /v1/status` and require the
  durable Restate pass to report `NOT_DUE / STALE_CAPITAL_BOOTSTRAP` with the expected signal and execution session.
  Confirm the research-capital activation is still realized, then verify whether the finalized signal publication
  arrived before that session's publication/submission-open deadline. Do not force late admission, move the deadline,
  or synthesize a cycle after the cutoff. Preserve the missed-session evidence and repair publication/bootstrap timing
  so the next eligible session is admitted normally; repeated misses are an execution-liveness incident.
- `BaynExecutionWindowUnready`: inspect the current ACTIVE cycle, its immutable `submissionOpenAt`, and
  `bayn_execution_session_preflight_ready`. From ten minutes before submission opens until its cutoff, preflight
  requires the realized capital activation, durable execution authority with clear kill state, exact reconciliation
  covering the latest mutation, zero unresolved mutations, an account-bound/readable broker, and an active readable
  Restate controller. Repair the failed prerequisite through its existing owner. Do not move the session window,
  force a decision, or create another execution process.
- `BaynExecutionDecisionLagging`: the session preflight is healthy and submission has opened, but the ACTIVE cycle is
  still missing its immutable `decisionHash`. Follow the current Restate tick trace through decision construction,
  risk evaluation, and the PostgreSQL decision bind. Do not synthesize a decision or submit directly to the broker.
  If no decision is durably bound by `submissionCutoffAt`, Bayn must classify the cycle as
  `MISSED_SUBMISSION_CUTOFF` and close readiness rather than wait until execution close.
- `BaynCycleObservationUnavailable`: inspect `cycle.error` in `GET /v1/status`, then restore the existing PostgreSQL
  projection path. Do not substitute cached or synthetic state.
- `BaynRuntimeDegraded`: inspect `operational`, all `dependencies` (including `cycleRunner`), `autonomousCycleLoop`,
  and the broker read/account-binding facts in `GET /v1/status`. Restore the failed dependency or the existing scoped
  loop; do not bypass OBSERVE or create a replacement scheduler.
- `BaynCycleStalled`: branch on `cycle.reason` in `GET /v1/status`. `submissionCutoffAt` remains a hard deadline for an
  ACTIVE cycle until its immutable decision is bound. A decision-bound ACTIVE cycle may continue broker recovery and
  reconciliation through `executionCloseAt`; an unbound ACTIVE cycle at the cutoff is a missed-submission incident.
- `BaynCycleFailed`: preserve `cycle.reason` and the terminal cycle identity. Resolve the underlying authority,
  reconciliation, mutation, or durable-cycle state through its existing writer contract. When
  `cycle.reason=LAST_CYCLE_BLOCKED`, branch on the exact persisted `cycle.last.terminalReason`; never clear the alert
  by editing monitoring state.

An alert clears only when its source-of-truth state changes and the next bounded projection or health probe confirms
recovery.
