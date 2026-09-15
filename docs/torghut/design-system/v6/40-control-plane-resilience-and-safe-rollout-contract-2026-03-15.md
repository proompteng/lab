# 40. Control-Plane Resilience and Safe Rollout Contract for Torghut Quant (2026-03-15)

## Status

- Date: `2026-03-15`
- Maturity: `architecture decision + implementation contract`
- Owner: `torghut-quant swarm architecture stage`
- Scope: Jangar control-plane freshness quorum, dependency watch reliability, Knative rollout guardrails, and deployment-level rollback policy for the Torghut quant stack
- Depends on:
  - `docs/torghut/design-system/v6/39-freshness-ledger-and-hypothesis-proof-mesh-2026-03-14.md`
  - `docs/torghut/design-system/v6/24-knative-probe-port-normalization-and-rollout-stability-2026-03-04.md`
  - `docs/torghut/design-system/v6/25-knative-startup-probe-port-fix-2026-03-04.md`
  - `docs/torghut/design-system/v6/26-database-migration-lineage-and-readiness-contract-2026-03-05.md`

## Why this doc exists

The March 15 cluster read is still showing a pattern where control-plane availability appears healthy while operational truth is not. The failure domains are now better mapped and need explicit architectural isolation before any further optimization work is safe.

- `kubectl -n torghut get events ...` includes repeated probe and startup churn on the torghut Knative service.
- `kubectl -n jangar get events ...` includes recurring `ErrorNoBackup` on `cluster/jangar-db-restore`.
- `kubectl -n torghut get pods` shows one torghut pod cycling readiness under pressure.
- `/api/torghut/trading/control-plane/quant/health` still reports dependency delay and low freshness confidence while dependency components may be recoverable individually.

The control-plane is currently too coupled:

- a single stream warning (`watch_reliability_degraded`) influences capital decisions;
- fresh data errors can trigger broad dependency delays;
- and readiness output does not separate evidence freshness from rollout noise.

That coupling produces false negatives for profitable strategies and false positives for stability.

## Problem statement

The control-plane must absorb noisy runtime signals without turning them into irreversible platform-wide lockout. Three coupled failure modes currently dominate:

1. Probe flapping creates temporary dependency delays because there is no durable, component-scoped truth source.
2. Watch reliability is treated as a cross-cutting blocker, even when component-level continuity would support safe continuation.
3. Rollout and dependency checks are evaluated in lockstep, so rollout noise (for example, temporary Knative readiness oscillation) can mask otherwise healthy data pipelines.

## Evidence snapshot (March 15, 2026)

- Cluster surface: repeated probe readiness issues in torghut and error-no-backup markers on jangar restore jobs indicate unstable startup and recovery conditions.
- Source surface: `services/jangar/src/server/control-plane-status.ts` still includes `watch_reliability_degraded` as a direct quorum delay reason.
- Source surface: `services/jangar/src/server/torghut-quant-status.ts` and `services/jangar/src/server/torghut-quant-metrics.ts` still aggregate freshness as direct control-plane gating signals.
- Database surface: no explicit control-plane watcher durability ledger exists in the currently active `services/torghut/migrations/versions` lineage for producer-authored watch and rollout health rows.

## Alternatives considered

### Option A. Expand current probe tolerances

Adjust probe thresholds, timeouts, and backoff windows to reduce noise.

- Pros: quick and low-touch.
- Cons: noise suppression is reactive, not structural; does not define a durable recovery contract; does not isolate failure modes across watch, rollout, and freshness paths.

### Option B. Remove watch-reliability from gating entirely

Ignore `watch_reliability_degraded` from capital decision logic and rely solely on raw endpoint and freshness numbers.

- Pros: prevents one noisy stream from blocking all hypotheses.
- Cons: can hide real ingestion blind spots and shifts failure risk to silent drift.

### Option C. Chosen. Introduce a control-plane resilience spine with segment-local failure semantics

Split control-plane truth into three independently surfaced planes:

- rollout safety plane (`provision_readiness`, `startup_stability`);
- dependency-data truth plane (`component_observations`, `component_rollups`);
- authority plane (the schema and readiness reason bundle consumed by Torghut).

This keeps fail-closed behavior but reduces blast radius from single-surface failure.

## Decision

Implement `control-plane resilience spine v2` with:

- bounded, producer-authored freshness observation records,
- per-surface quorum thresholds,
- explicit degradation modes (`degraded`, `blocked`, `unknown`) with hard TTLs,
- and staged rollout gating where rollout noise cannot directly force capital lockouts unless evidence plane confirms it.

## Architecture

### 1) Control-plane observation contract

Define durable observations for Jangar control-plane components:

- `control_plane_component_observations` rows:
  - `component` in:
    - `knative_startup`,
    - `watch_ingest`,
    - `ta_signal_freshness`,
    - `market_context_bundle`,
    - `empirical_job_scheduler`.
  - `scope_key` for workload/component identifier,
  - `observation_ts`,
  - `status` (`healthy`, `degraded`, `blocked`, `unknown`),
  - `freshness_seconds`,
  - `ttl_seconds`,
  - `quality_score`,
  - `reason_code` and `reason_chain`,
  - `evidence_ref` list.

- `control_plane_component_rollups` rows:
  - same keying and a fixed set of `status_by_surface`,
  - `effective_at`,
  - `degradation_budget_remaining`,
  - `quorum_decision`,
  - `last_good_until`.

Producer responsibility:

- write all high-value observations directly from producers (watchers, schedulers, ta pipelines),
- attach explicit evidence references for every status transition.

Consumer responsibility:

- read rollups for live gating,
- surface legacy compatibility fields for staged cutover,
- degrade only the relevant plane when a single observation is stale.

### 2) Dependency quorum rewrite

Replace direct `watch_reliability_degraded` hard dependency behavior with:

- `surface_health = blocked` only when both:
  - watch replay freshness exceeds `watch_staleness_budget_seconds`, and
  - no valid `last_good_until` exists.
- else mark `surface_health = degraded` and continue with explicit warning reasons.

### 3) Rollout safety gates

Add staged rollout guardrail:

- `rollout_gate_level=preview`:
  - no capital gating,
  - require 2 consecutive successful readiness reports.
- `rollout_gate_level=shadow`:
  - compute shadow dependency decision,
  - no hard block,
  - export mismatch telemetry.
- `rollout_gate_level=enforced`:
  - enable hard block only for components whose quorum and freshness budgets expired.

### 4) Failure-mode reduction and self-healing

Each failing surface gets one explicit recovery strategy:

- `watch_ingest`: bounded stale-window fallback and per-stream grace period,
- `knative_startup`: container-specific restart suppression during expected cold start windows plus readiness probe budget,
- `empirical_job_scheduler`: automatic recovery task with idempotent re-run marker,
- `market_context_bundle`: source-of-true bundle missing triggers `market_context_bundle_stale` rather than global delay.

## Implementation contract

### Engineering stage

1. Add observation and rollup table definitions in Jangar source-of-truth persistence path with strict schema migration.
2. Emit producer observations for at least:
   - watch stream partitions,
   - ta freshness snapshot completion,
   - market-context bundle materialization,
   - empirical job completion.
3. Split dependency quorum logic into per-surface thresholds.
4. Add explicit comparison output in control-plane status response:
   - legacy decision,
   - spine decision,
   - mismatch reason set.
5. Add rollout gate feature flags:
   - `control_plane_rollout.preview.enabled`,
   - `control_plane_rollout.shadow.enabled`,
   - `control_plane_rollout.enforced.enabled`.

### Validation gates (engineering)

- Jangar readiness remains safe under stale watch stream without whole-system lockout.
- `watch_reliability_degraded` no longer hard-blocks all hypotheses unless its surface decision and freshness budget require it.
- No repeated emergency dependency blocks during stable one-market-session operation.
- Hot-path query fallback to broad scans is gone; control-plane path relies on rollup read and bounded lookbacks.

### Deployer stage

1. Deploy dual-write mode for 1 full regular session.
2. Move to shadow mode and compare legacy vs rollup decision divergence.
3. Enable enforced gate only when no critical mismatch persists for at least one session.

## Rollout plan

1. **Wave 1 (safe dual-write):** keep existing semantics but begin recording control-plane observations and rollups.
2. **Wave 2 (shadow read):** add comparison telemetry and maintain existing control decision as source of truth.
3. **Wave 3 (enforced gates):** enable surface-scoped gate semantics with stricter safety toggles and rollback plan active.
4. **Wave 4 (steady-state cleanup):** remove deprecated global reason paths, keep compatibility aliases for one release train.

## Rollback plan

- Disable the spine read path and return to legacy `watch_reliability_degraded` path.
- Preserve observation tables for forensics, do not delete rows.
- If control-plane false negatives rise above threshold, disable `control_plane_rollout.enforced.enabled` within 15 minutes and revert to shadow mode.

Hard rollback triggers:

- enforced gate differs from legacy on two consecutive sessions with no source correction,
- startup flaps increase by more than 2x while table writes remain healthy,
- control-plane schema check fails or migration lineage mismatch appears.

## Risks

- More moving parts means more schema maintenance.
- Incorrect TTLs could amplify unknown states if not tuned.
- Without strict evidence references, false confidence can persist in dashboards.
- Too-strongly partitioned gates can over-fragment operator interpretation.

## Expected outcomes

- Immediate resilience improvement from failure isolation.
- Lower false negatives from control-plane noise.
- Safer, staged rollout with explicit rollback path and measured activation criteria.

## Engineer handoff acceptance

1. Observation producers and rollup consumers are implemented with migration lineage tracked.
2. Control-plane status includes legacy-vs-spine decision comparison.
3. Rollout gate toggles exist and can be switched by deployers without schema changes.
4. One full session completed in dual-write + shadow mode with no unresolved safety mismatch.

## Deployer handoff acceptance

1. Rollout gates are controlled through config and documented in GitOps.
2. A minimum of one production session runs in shadow mode and one in enforced mode.
3. Emergency rollback command path and monitoring runbook exist before enforced mode enablement.
4. No unresolved hard mismatches between legacy and spine decisions by the end of enforced rollout.
