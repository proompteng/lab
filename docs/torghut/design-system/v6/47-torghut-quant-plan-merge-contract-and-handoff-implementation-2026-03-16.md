# Torghut Quant plan-stage merge contract and implementation handoff (2026-03-16)

## Summary

This document is the merged architecture contract for the `torghut-quant` plan stage.
It closes the current discovery-to-plan loop by selecting one control-plane resilience design and one profitability architecture design, defining explicit implementation scope, and publishing deterministic rollout/rollback expectations for both engineer and deployer.

Primary outcomes:

- Jangar: reduce blast-radius failures during rollout churn by isolating segment-specific health and making rollout transitions explicit and scoped.
- Torghut: increase measurable profitability potential through evidence- and budget-governed hypothesis lanes with automatic demotion behavior.
- Operations: preserve fast execution under partial-surface failures through segment/lane-aware gating and bounded fallback.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base branch: `main`
- head branch: `codex/swarm-torghut-quant-plan`
- swarm name: `torghut-quant`
- swarm stage: `plan`
- owner channel: `swarm://owner/trading`

Success criteria for this mission are:

1. evidence-backed assessment for cluster, source, and database/data surfaces;
2. at least two ambitious architecture alternatives with tradeoffs and one selected per outcome domain;
3. merged implementation artifacts with measurable gates, rollout, and rollback expectations;
4. explicit handoff contract for engineer and deployer.

## Cluster/state assessment

### Rollout and health evidence (as observed on 2026-03-16)

- `kubectl get swarms.swarm.proompteng.ai -A` shows:
  - `agents/jangar-control-plane` with phase `Frozen`, freeze reason `StageStaleness`, and pending requirements `5`.
  - `agents/torghut-quant` with phase `Frozen`, freeze reason `StageStaleness`, and pending requirements `0`.
- `kubectl get pods -n torghut -o wide` shows mostly healthy core services with segment-local failures:
  - `ImagePullBackOff`: `torghut-options-ta`
  - `CrashLoopBackOff`: `torghut-options-catalog`, `torghut-options-enricher`
  - readiness/availability warnings: `torghut-ws-options` and `torghut-00143-deployment`.
- `kubectl get events -A --field-selector type!=Normal --sort-by='.lastTimestamp' | tail -n 80` shows:
  - repeated template restart/backoff windows in `agents` (`jangar-swarm-discover-template-step-1-attempt-1`, `jangar-swarm-plan-template-step-1-attempt-1`, `jangar-swarm-verify-template-step-1-attempt-1`, `torghut-swarm-discover-template-step-1-attempt-1`),
  - `ErrorNoBackup` for `jangar/jangar-db-daily-20260309110000` and `torghut/torghut-db-daily-20260310020000`,
  - restart and probe failures in options and deployment surfaces,
  - ClickHouse config map update bursts during the same period.

### Control-plane resilience implication

The cluster is not in full incident lockout, but failures are strongly segment-correlated. A single global stop policy would unnecessarily block healthy paths, while segment-scoped freeze provides the required blast-radius reduction.

## Source architecture assessment

### Jangar

- Existing status and rollout semantics are already in `services/jangar/src/server/control-plane-status.ts`, `services/jangar/src/server/orchestration-controller.ts`, `services/jangar/src/server/torghut-quant-runtime.ts`, and `services/jangar/src/server/torghut-quant-metrics.ts`.
- Existing control-plane semantics are sufficiently rich but still do not fully enforce segment-isolated lock behavior in all rollback and transition paths.
- Test coverage includes status helper behavior and controller primitives, but no comprehensive matrix for mixed segment failure + recovery behavior.
- Risk remains in the coupling between segment state and global canary decisions.

### Torghut

- Source already exposes hypothesis states and completion gates in:
  - `services/torghut/app/trading/hypotheses.py`
  - `services/torghut/app/completion.py`
  - `services/torghut/app/main.py`
  - `services/torghut/app/trading/empirical_jobs.py`
- Control-plane APIs already expose hypothesis and readiness inputs (`/trading/status`, `/trading/empirical-jobs`, `/db-check`).
- Missing is a fully unified per-hypothesis budget and continuity contract that enforces growth policy across all lanes.

### Source-risk posture

- Coupling risk remains: one degraded segment can still influence unrelated scheduling behavior through broad predicates.
- Documentation risk remains: there was no single merged handoff contract that bound cluster resilience, hypothesis governance, and deployer sequence in one place.
- This mission closes that gap with a merged architecture contract and rollout/rollback matrix.

## Database and data posture assessment

- Torghut migration chain is present with staged governance and execution persistence in `services/torghut/migrations/versions`, including hypothesis and empirical job control up through `0024_simulation_runtime_context.py`.
- Direct DB query verification remains limited by RBAC/pod-exec constraints.
- Runtime event evidence (`ErrorNoBackup`) reduces confidence in continuity windows and requires explicit continuity gating before scale.
- Schema-backed evidence lineage is therefore the safer gating source versus ad hoc manual state checks.

## Architecture alternatives and tradeoffs

### Jangar resilience alternatives

Option A: threshold tuning only

- lower engineering cost
- does not materially reduce blast radius

Option B: manual runbook-only controls

- human-readable and low code change
- inconsistent and slow under repeated churn

Option C: segment-aware rollout gates and scoped rollbacks (selected)

- explicit segment contracts and scoped freeze logic
- higher implementation rigor but clear failure reduction and recoverability

### Torghut profitability alternatives

Option A: global gating only

- no per-hypothesis accountability
- weak guardrail coverage

Option B: static manual capital buckets

- explicit but too slow for regime shifts and not evidence-automatable

Option C: hypothesis and evidence mesh with demotion transitions (selected)

- explicit lane progression with measurable thresholds
- automatic demotion on recurring evidence erosion
- tighter continuity coupling to backup and proof lineage

## Decision

Select Option C for both domains.

- Jangar keeps rollout control scoped by segment and failure class.
- Torghut promotes by measurable evidence windows and enforces automatic hypothesis demotion on repeated guardrail breaches.

## Merged implementation architecture (plan scope)

### 1) Segment-scoped control-plane contract (Jangar)

Define per-segment trust state in control-plane responses:

- `segment`: `discover | plan | verify | implement | options | inference | data-plane`
- `status`: `allow | warn | block | hold | recoverable-fail`
- `freshness_ms`, `failure_class`, `failure_rate`, `evidence_refs`, `next_retry_at`, `cooldown_until`.

Transition behavior:

- segment `block` pauses only the impacted segment transitions,
- unrelated segments remain operational based on own state,
- recovery requires two consecutive `healthy` samples before clearing block.

### 2) Hypothesis profitability mesh (Torghut)

Define mandatory state fields for every candidate hypothesis:

- `hypothesis_id`, `strategy_family`, `target_regime`, `primary_metric`, `expected_minimum_effect`, `confidence_threshold`, `evidence_window`, `continuity_ratio_min`.
- lane lifecycle: `shadow -> canary -> live -> scale -> protect -> degrade -> decommissioned`.

Promotion rule set:

- no canary/live/scale transition without two consecutive complete evidence windows,
- no portfolio-scale without concentration and slippage checks,
- two consecutive guardrail breaches force immediate `degrade` and local capital pause.

### 3) Shared traceability and handoff contract

Both Jangar and Torghut status surfaces must carry a machine-readable evidence graph and freeze/recovery reasons:

- segment/lane state,
- continuity score,
- confidence and cap utilization,
- rollback lineage and operator acknowledgement token.

### 4) Rollout and rollback expectations

Rollout order:

1. schema compatibility and segment/lane observability in shadow mode,
2. one canary hypothesis family in one segment,
3. conservative scale on proven low-risk hypothesis.

Rollback sequence:

- two consecutive critical segment blockages: hold + cooldown + operator review,
- two consecutive hypothesis guardrail breaches: demotion to `degrade`/`shadow` and local capital cap,
- repeated high-loss conditions: decommission with explicit re-authorization required.

## Validation gates

### Engineering gates

- tests proving one-segment block does not block an unrelated healthy segment,
- tests proving per-hypothesis demotion after two violating windows,
- contract snapshot tests for control-plane status and trading status payloads,
- migration-coverage checks for policy fields and hypothesis evidence references.

### Deployer gates

- one scoped rollback drill showing no cross-segment global freeze,
- evidence bundle continuity checks before any canary scale,
- proof that demotion and resume events are persistent and auditable.

## Handoff acceptance

Engineer handoff:

- wire segment trust envelopes into Jangar status and orchestration paths,
- wire hypothesis-policy evaluation into Torghut promotion paths,
- add segment and hypothesis matrix tests,
- document rollout rollback and acceptance steps in source-ready runbooks.

Deployer handoff:

- apply one segment or one hypothesis change per wave,
- ensure operator review path for any cross-segment dependency breach,
- block scale until continuity, freshness, and evidence thresholds are passed.

## Merge references

- `docs/torghut/design-system/v6/40-control-plane-resilience-and-safer-rollout-for-torghut-quant-2026-03-15.md`
- `docs/torghut/design-system/v6/41-torghut-quant-profitability-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/42-torghut-quant-control-plane-and-profitability-program-2026-03-15.md`
- `docs/torghut/design-system/v6/44-torghut-quant-plan-design-document-and-handoff-contract-2026-03-15.md`
- `docs/torghut/design-system/v6/45-torghut-quant-profitability-hypothesis-and-guardrail-architecture-2026-03-15.md`
- `docs/torghut/design-system/v6/46-torghut-probability-and-capital-mesh-for-profitable-autonomy-2026-03-16.md`
- `docs/agents/designs/48-jangar-torghut-architecture-plan-and-profitability-mesh-contract-2026-03-16.md`

This document is the merged control-plane/profitability implementation contract for this plan stage and is intentionally explicit on rollout and rollback acceptance.
