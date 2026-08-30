# Jangar Control-Plane Failure-Mode Reduction and Safer Rollout Safety (2026-03-15)

## Status

Status: Proposed
Date: 2026-03-15
Scope: Jangar control-plane reliability and rollout governance
Mission: jangar-control-plane / discover

## Executive summary

The discover-stage evidence shows the control plane has a correct core heartbeat strategy but still lacks a unified execution-trust gate for rollout safety. Swarm freeze and stage freshness are real sources of execution outage risk, yet they are not yet represented in the status-ready-rollback path. At the same time, rollout confidence currently depends heavily on noisy telemetry (watch errors, jobs window) and can miss silent staleness when no recent jobs run.

This design introduces an explicit, additive `execution-trust` envelope in `/api/agents/control-plane/status`, and reuses that envelope in `/ready` so readiness can be used as a deployment safety gate rather than just process liveness. It also separates rollout safety into deterministic guardrails with anti-flap behavior.

## Assessment evidence summary

### Cluster assessment

- RBAC in the observed run context is constrained: read-only account `system:serviceaccount:agents:agents-sa` cannot read `deployments.apps` / `replicasets.apps` / `jobs.batch` in `jangar` or `torghut` namespaces.
  - `kubectl auth can-i list deployments.apps -n jangar` -> `no`
  - `kubectl auth can-i list jobs.batch -n jangar` -> `yes`
- Current non-normal events indicate execution risk:
  - `jangar`: `ErrorNoBackup` for `cluster/jangar-db-restore` (missing `jangar-db-daily-20260309110000`)
  - `torghut`: repeated transient probe failures on `pod/torghut-00134-deployment...` (`Liveness`/`Readiness` probes timeouts)
  - `torghut`: `ErrorNoBackup` for `cluster/torghut-db-restore` (missing `torghut-db-daily-20260310020000`)
- Live pod health is generally healthy with isolated warning classes, but warnings are now part of rollout confidence and should not be ignored as “non-production noise”.

### Source assessment

- `services/jangar/src/server/control-plane-status.ts`
  - already aggregates controller/runway/rollout/workflow/database health and dependency quorum
  - has no first-class `swarms`/`stages` execution envelope even though `Swarm.status` is the authoritative execution truth for this mission.
  - `dependency_quorum` currently delays readiness when `watch_reliability` degrades, but does not down-scope by operational criticality for execution gates.
- `services/jangar/src/routes/ready.tsx`
  - remains local-controller centric and does not evaluate `buildControlPlaneStatus(...)`.
  - returns 200 when controllers are disabled in this run context even while `swarm` state can indicate frozen execution.
- `services/jangar/src/routes/health.tsx`
  - mostly liveness; does not represent execution trust.
- `services/agents/src/server/__tests__/control-plane-status.test.ts`
  - has good unit coverage for legacy readiness states but no explicit frozen-swarm/stage-staleness assertion.

### Database/source data assessment

- Jangar DB schema supports control-plane control tables (`agents_control_plane.component_heartbeats`, `torghut_control_plane.*`), rollout snapshots, and migration consistency checks.
  - `services/jangar/src/server/migrations/20260308_agents_control_plane_component_heartbeats.ts`
  - `services/jangar/src/server/migrations/20260212_torghut_quant_control_plane.ts`
  - `services/jangar/src/server/db.ts` maps migration metadata and trust signals.
- Data quality gap: source-of-truth execution state exists in `Swarm` CRs but is not currently surfaced in the primary status contract.
- No evidence of schema drift from source contract alone; migration coverage and mapping are complete in current code path.

## Problem statement

1. **Execution truth is split across surfaces.**
   - `Swarm` status can be frozen/stale while status/ready continue to report healthy controls.
2. **Readiness is not equivalent to execution safety.**
   - The current readiness gate can return `ok` with disabled controllers in run contexts.
3. **Rollout safety is over-sensitive to noisy signals and under-sensitive to frozen stages.**
   - `watch_reliability_degraded` and job counters are useful but insufficient when stage cadence is stale.
4. **No anti-flap policy exists for rollout admission.**
   - We can degrade repeatedly from transient one-off probe noise without proving persistent risk, or remain permissive with stage drift windows.

## Alternatives considered

### Option A – Keep current rollout criteria and tune thresholds only

- **Idea**: only adjust `watch_reliability_degraded`/workflow thresholds.
- **Pros**: minimal implementation effort.
- **Cons**: still misses source-of-truth stale-stage signals and does not make readiness represent execution truth.

### Option B – Add only rollout dashboards (operator UI only)

- **Idea**: publish charts/events while keeping `/ready` behavior untouched.
- **Pros**: low-risk change for endpoints.
- **Cons**: operators still face split-brain: probe says ready, execution may be frozen.

### Option C – Selected: execution-trust envelope + staged rollout safety gates

- **Idea**: extend status contract with authoritative swarm/stage execution state and enforce it in `/ready`.
- **Pros**: deterministic failure-mode reduction and explicit gates for deployers; preserves additive compatibility.
- **Cons**: requires cross-module changes and test updates.

## Decision

Select **Option C**.

The control plane will introduce a unified, additive execution-trust envelope that is explicitly fed by `Swarm` CR state and then used by `ready` as an execution-safety gate.

## Design

### 1) Add execution trust to status contract

Extend `services/jangar/src/server/control-plane-status.ts` with additive sections:

- `execution_trust` object:
  - `decision: healthy|degraded|blocked|unknown`
  - `message`
  - `failing_components[]`
  - `confidence: high|medium|low|degraded`
- `swarms[]` entries per monitored swarm (`name`, `namespace`, `phase`, `ready`, `freeze`, `last_*`, `stage_staleness`, `requirements.pending`).
- `stages[]` entries per stage (`swarm`, `stage`, `phase`, `enabled`, `last_run_at`, `stale`, `next_expected_at`, `stale_after_ms`, `recent_backoff_limit_exceeded_jobs`, `data_confidence`, `failure_reasons`).
- `rollout_safety` object:
  - `hysteresis_window_minutes`
  - `degrade_count`
  - `flap_window_minutes`
  - `degrade_reasons[]`

### 2) Resolution precedence and failure-mode reduction

- Source of truth order:
  1. `Swarm` status (authoritative for freeze/staleness and stage execution state)
  2. deployment/workflow evidence (`buildRolloutHealth`, workflow counters)
  3. local process/controller state
- If read of swarm/stage evidence fails, do not silently drop to healthy.
  - Enter `execution_trust.confidence=degraded`
  - append reason `execution_state_unknown`
- `watch_reliability_degraded` becomes a scoped warning reason, not an immediate global block.

### 3) Safer rollout behavior with deterministic states

- Add `/api/agents/control-plane/status` fields:
  - `rollout_admission.decision` with `allow|delay|hold|block`.
- Use staged thresholds:
  - `delay`: first `watch_reliability_degraded` or isolated probe warnings.
  - `hold`: repeated Backoff-limit and stage-staleness in same swarm.
  - `block`: any frozen swarm stage or repeated hold breaches + confidence low.
- Add anti-flap logic:
  - reason counters clear only after a configurable stability window.
  - avoid repeated `delay` flicker for one-off probe spikes.

### 4) Align readiness to execution trust

- Update `services/jangar/src/routes/ready.tsx` to use the new execution-trust envelope.
- `/health` remains liveness and process-level; `/ready` becomes execution-trust gate.

### 5) Operational transparency

- Keep new fields additive to prevent consumer breakage.
- Add explicit reason codes:
  - `swarms_frozen`, `stage_stale`, `stage_backoff_hold`, `execution_state_unknown`, `watch_degraded_scope`, `probe_noise_flap`

## Measurable targets (discover stage)

1. **False-safe avoidance target**: During a frozen-stage condition, `/ready` must return 503 and include `execution_trust.decision != healthy`.
2. **Late-stage staleness detection**: If `stage_staleness=true` appears with no new failures in job window, status still degrades with explicit reason.
3. **No blind spots under restricted RBAC**: when `deployments` reads are denied, status uses `execution_trust.confidence=degraded` instead of healthy fallback.
4. **Rollout flap control**: isolated one-off probe warnings should not permanently block after stability window.

## Implementation slices

### Slice 1

- Add additive types and builders for `execution_trust`, `swarms`, `stages`, and `rollout_safety`.
- Add unit tests covering:
  - frozen swarm degrades status
  - stage staleness degrades even with zero recent workflow failures
  - unknown swarm read becomes degraded/partial confidence.

### Slice 2

- Rebase `/ready` on this envelope.
- Add tests for:
  - readiness blocked on frozen swarm
  - readiness degrades to 503 with `execution_state_unknown`
  - readiness returns 200 when execution trust healthy and stable.

### Slice 3

- Add rollout safety anti-flap tests and integration smoke checklist in runbook.

## Rollout and rollout gating

- **Rollout gate 1 (observe-only)**: ship status contract fields first.
- **Rollout gate 2 (partial enforce)**: enforce `execution_trust.decision` in `/ready` under non-blocking feature flag.
- **Rollout gate 3 (full enforce)**: remove flag after one full thaw cycle and one stale-stage rehearsal.

## Rollback

- Rollback order:
  1. Disable `/ready` execution trust enforcement.
  2. Keep `execution_trust` fields visible for diagnosis.
  3. Revert reason scoping only if false-positive risk rises.
  4. Last resort: revert additive status additions.

## Validation gates

### Engineer gates

1. A frozen or stale swarm entry is present in `/api/agents/control-plane/status` and drives `execution_trust.decision=degraded|blocked`.
2. `/ready` remains green only when execution trust is healthy.
3. Rollout decisions for `block/hold/delay` are deterministic and test-covered.

### Deployer gates

1. `curl .../api/agents/control-plane/status?namespace=agents` returns populated `execution_trust`, `swarms`, `stages` fields.
2. During simulated stage-staleness or freeze, `ready` returns HTTP 503.
3. `/health` remains 200 during the same window, proving separation of liveness and execution readiness.

## Risks and mitigations

- **Risk**: tighter readiness could slow rollout in unstable labs.
  - Mitigation: phased flag + anti-flap hold window.
- **Risk**: additional status payload increases cognitive load.
  - Mitigation: additive schema and concise reason codes with one-line runbook mapping.
- **Risk**: if Huly remains inaccessible, collaboration enrichment is delayed.
  - Mitigation: keep Huly failure as explicit degraded trust reason while still reporting last known healthy state.
