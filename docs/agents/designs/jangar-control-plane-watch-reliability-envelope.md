# Jangar Control Plane Watch Reliability Envelope (Design)

Status: Discover (2026-03-04)

## Summary

This design captures operationally relevant watch-layer reliability signals and surfaces them in
`/api/agents/control-plane/status` so operators can distinguish a healthy control plane from one that is repeatedly
restarting or erroring watches. The implementation reuses the existing in-process watch machinery and keeps the payload
compatible with current control-plane status consumers while extending it with a bounded reliability envelope.

## Objectives

- Preserve existing status behavior for controllers, runtime adapters, DB, and gRPC.
- Add a deterministic, low-cardinality watch reliability signal (`watch_reliability`) to status responses.
- Keep risk low: no cluster mutation; no schema migrations; failure in status enrichment never blocks status endpoint responses.

## Problem statement

Cluster events show transient pod-level readiness churn and watch-activity failures (for example, multi-attach retries and
watch-close events), but those signals were previously only available via manual `kubectl get events`, making them
reactive and non-actionable during sustained incidents.

Control-plane code currently increments global kube-watch counters for events, errors, and restarts, but there was no single
service-level rollup tied to the operator-facing status surface.

## Proposed design

- Add `services/jangar/src/server/control-plane-watch-reliability.ts` as an in-memory collector:
  - Tracks per `(resource, namespace)` watch events, errors, and restarts.
  - Applies a rolling window (default 15 minutes) and drops observations outside the window.
  - Exposes:
    - `status` (`healthy|degraded|unknown`)
    - `window_minutes`
    - `observed_streams`
    - `total_events`
    - `total_errors`
    - `total_restarts`
    - `streams` top offenders (bounded).
- Wire `startResourceWatch()` to record reliability observations in parallel with existing metric counters.
- Extend `ControlPlaneStatus` with `watch_reliability` and include `watch_reliability` in degraded-component calculations when
  the watch envelope is degraded.
- Show watch reliability in the control-plane UI panel, with concise stream-level detail.

## Configuration

- `JANGAR_CONTROL_PLANE_WATCH_HEALTH_WINDOW_MINUTES` (default: `15`)
- `JANGAR_CONTROL_PLANE_WATCH_HEALTH_STREAM_LIMIT` (default: `20`)

## Alternatives considered

- A) Keep current status payload unchanged and rely solely on manual event review.
  - Pros: zero implementation and rollout risk.
  - Cons: no operator-facing reliability signal for sustained watch issues.
- B) Add a brand-new `/api/agents/control-plane/watch-health` endpoint.
  - Pros: specialized interface for watch metrics and alerting.
  - Cons: requires new client work, increased discoverability burden, and duplicated rendering in UI.
- C) (Selected) Add `watch_reliability` to existing status envelope.
  - Pros: immediate visibility in already used panel; minimal client/API surface changes; incremental rollout risk.
  - Cons: status consumers that do not expect the field will ignore it, but new schema is additive.

## Validation plan

- Unit tests for watch reliability collector.
- Existing kube-watch tests remain aligned and continue verifying event/error/restart recording.
- Control-plane-status unit tests verify degraded-component propagation (`watch_reliability`).
- Manual smoke: exercise a short-lived watch error in staging and confirm status stream/reporting changes within the window.

## Rollout notes

- This is an additive code-only change; no database migration required.
- In degraded mode, status now reports watch failures without failing control-plane status endpoint execution.
