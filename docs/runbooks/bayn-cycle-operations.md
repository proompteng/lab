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
- `BaynCycleObservationUnavailable`: inspect `cycle.error` in `GET /v1/status`, then restore the existing PostgreSQL
  projection path. Do not substitute cached or synthetic state.
- `BaynCycleStalled`: branch on `cycle.reason` in `GET /v1/status`. `submissionCutoffAt` is a deadline only while the
  cycle is `PENDING`; an `ACTIVE` cycle remains expected through `executionCloseAt`.
- `BaynCycleFailed`: preserve `cycle.reason` and the terminal cycle identity. Resolve the underlying authority,
  reconciliation, mutation, broker, or durable-cycle state through its existing writer contract; never clear the
  alert by editing monitoring state.

An alert clears only when its source-of-truth state changes and the next bounded projection confirms recovery.
