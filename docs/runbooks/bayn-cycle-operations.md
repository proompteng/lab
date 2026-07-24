# Bayn cycle operations

Bayn remains fail-closed. A healthy pod, a clear alert, or a terminal cycle does not grant broker or capital authority.

## Read the bounded state

1. Read `GET /v1/status` and record `build`, `qualification`, `cycle`, `authority`, and `broker`.
2. Confirm `authority.brokerOrders=false` and `authority.capitalPromotion=false` before any OBSERVE investigation.
3. Use `cycle.current.cycleId`, `cycle.last.cycleId`, the selected sessions, cutoff, phase, and reason to correlate
   structured Bayn logs. Cycle IDs are intentionally absent from Prometheus labels.
4. Compare the durable mutation event count before and after the observation window. Do not infer zero mutation from
   readiness alone.

## Alert actions

- `BaynMetricsUnavailable`: verify the Bayn pod, the observability Alloy pod-discovery target, and the NetworkPolicy.
  If Bayn failed before HTTP startup, inspect startup logs and compare configured provenance with the embedded
  source revision, image digest, strategy behavior hash, and strategy parameter hash.
- `BaynCycleObservationUnavailable`: inspect `cycle.error` in `GET /v1/status`, then restore the existing PostgreSQL
  projection path. Do not substitute cached or synthetic state.
- `BaynRuntimeDegraded`: inspect `operational`, all `dependencies` (including `cycleRunner`), `autonomousCycleLoop`,
  and the broker read/account-binding facts in `GET /v1/status`. Restore the failed dependency or the existing scoped
  loop; do not bypass OBSERVE or create a replacement scheduler.
- `BaynCycleStalled`: branch on `cycle.reason` in `GET /v1/status`. `submissionCutoffAt` is a deadline only while the
  cycle is `PENDING`; an `ACTIVE` cycle remains expected through `executionCloseAt`.
- `BaynCycleFailed`: preserve `cycle.reason` and the terminal cycle identity. Resolve the underlying authority,
  reconciliation, mutation, or durable-cycle state through its existing writer contract. When
  `cycle.reason=LAST_CYCLE_BLOCKED`, branch on the exact persisted `cycle.last.terminalReason`; never clear the alert
  by editing monitoring state.

An alert clears only when its source-of-truth state changes and the next bounded projection or health probe confirms
recovery.
