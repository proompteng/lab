# Jangar Control-Plane Watch Telemetry

Status: Draft (2026-03-04)

## Current State

- Controllers that reconcile Agents, Orchestrations, and supporting primitives use a shared `startResourceWatch()` helper (`services/jangar/src/server/kube-watch.ts`).
- Watch behavior includes restart-on-close and basic error callbacks, but no explicit observability for event volume, parse errors, or restart loops.
- The recent cluster assessment observed repeated readiness churn and a high frequency of short-lived controller-related pods, increasing operational uncertainty during watch-driven event storms.
- Database-related work in the source has no direct control-plane watch observability; cache freshness and staleness remain separate concerns.

## Problem

- A watch storm or noisy stream can create high controller churn without clear early signal at the service layer.
- Existing logs are sparse at the watch layer and hard to aggregate across resource namespaces and controllers.
- Operations need a low-friction way to distinguish “normal high activity” from control-plane regressions.

## Goals

- Add shared watch instrumentation across all consumers of `startResourceWatch`.
- Record event-level counters, watch errors, and restarts with low-cardinality labels (`resource`, `namespace`, `event_type`/`reason`).
- Preserve existing watch behavior and restart semantics; avoid changing controller logic.
- Keep implementation confined to observability plumbing in shared modules.

## Non-Goals

- Changing reconciliation semantics.
- Adding per-controller event payload introspection.
- Adding any database schema changes.

## Design

- Extend `services/jangar/src/server/metrics.ts` with:
  - `jangar_kube_watch_events_total`
  - `jangar_kube_watch_errors_total`
  - `jangar_kube_watch_restarts_total`
- Add typed helpers:
  - `recordKubeWatchEvent`
  - `recordKubeWatchError`
  - `recordKubeWatchRestart`
- Update `services/jangar/src/server/kube-watch.ts` to invoke:
  - Event metrics for each parsed non-bookmark watch event.
  - Error metrics for parse failures, stream availability issues, stderr messages, non-zero exits, and spawn/close errors.
  - Restart metrics when a watch loop schedules a restart.
- Add regression coverage in `services/jangar/src/server/__tests__/kube-watch.test.ts`.

## Alternatives and tradeoffs

- A) Add metrics in each controller callback path instead of shared watch helper.
  - Pros: very explicit to controller semantics.
  - Cons: duplicate instrumentation, inconsistent labels, blind spots for parse/restart failures in shared layer.
- B) Add watch-level instrumentation in `kube-watch.ts` (selected).
  - Pros: centralized and consistent across resources; captures parse/restart blind spots.
  - Cons: requires label design discipline to avoid cardinality issues; no controller-specific context.
- C) Add an external controller-side watcher service instead of in-process instrumentation.
  - Pros: can inspect cluster-wide patterns with independent storage.
  - Cons: heavier operational footprint and not necessary for immediate reliability gains.

## Validation

- Unit tests cover event forwarding, parse failure handling, and non-zero exit restart behavior.
- Existing metrics surface is used by the service’s Prometheus exposition, so these counters become visible without new scrape config.
- This design is additive and does not alter controller outcomes.

## Rollout and Risks

- Rollout is additive; no migration required.
- Risk: metric labels become high-cardinality if uncontrolled string values are passed as labels.
- Mitigation: use normalized, bounded label set for `resource`, `namespace`, and constrained enums-like string reasons at the watch boundary.

## Handoff Notes

- Primary code updates:
  - `services/jangar/src/server/kube-watch.ts`
  - `services/jangar/src/server/metrics.ts`
  - `services/jangar/src/server/__tests__/kube-watch.test.ts`
- Reviewers can validate with:
  - `bun run --filter @proompteng/jangar test -- services/jangar/src/server/__tests__/kube-watch.test.ts`
  - `bun run --filter @proompteng/jangar lint`
