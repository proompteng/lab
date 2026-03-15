# Jangar control-plane resilience and safer rollout contract (2026-03-15)

## Problem

The torghut quant control plane has repeatedly shown mixed-failure behavior where single subsystem failures propagate into broad orchestration degradation. This can be seen in production signals:

- `jangar-control-plane` and `torghut-quant` swarms currently report `READY=False`, `lightweight` and `Frozen` in namespace `agents`.
- Worker history includes `BackoffLimitExceeded` and `error` patterns on multiple swarm run templates.
- A known rollout issue is recurring `FailedMount` for missing configmaps in the torghut/jangar discover templates.
- Pod health noise includes repeated probe timeouts on `torghut-00134-deployment` and intermittent DB restore events (`ErrorNoBackup`) on ClickHouse restore jobs.

These symptoms indicate one controller outage can cause:

1. Ingestion starvation (agent runs not observed, run state stale).
2. Rollout churn (jobs backoff/retry without global visibility).
3. Increased time-to-repair due to non-reversible failure mode and weak rollback signals.

## Context and evidence

- Source control-plane orchestration paths currently include explicit heartbeat authority, rollout summary, migration checks, watch reliability, and dependency quorum logic:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/control-plane-runtime.ts`
  - `services/jangar/src/server/control-plane-watch-reliability.ts`
- Source metrics and readiness indicators are already segmented but remain coupled to global fail-open behavior:
  - `services/jangar/src/server/torghut-quant-metrics.ts`
  - `services/jangar/src/server/torghut-quant-runtime.ts`
  - `services/jangar/src/server/torghut-market-context.ts`
- Hypothesis-driven gating and promotion contracts exist but have room for stricter isolation and explicit rollback contracts:
  - `services/torghut/app/trading/hypotheses.py`

## Desired state

- Explicit failure containment so a bad rollout in one surface cannot mask unrelated healthy surfaces.
- Safer rollout behavior with deterministic gates and bounded blast radius.
- Verifiable recovery behavior from every critical control-plane path (controller, rollouts, empirical dependencies, agentrun ingestion, DB).

## Option set considered

### Option 1: Keep current pattern and tune alerting only

Pros:

- Lowest change cost.
- Minimal schema/code impact.

Cons:

- Does not reduce blast radius at the decision boundary.
- Backoff/retry churn still saturates run queues and can hide healthy path recovery.
- No explicit per-surface rollback contract.

### Option 2: Add manual runbook-only gates

Pros:

- No architectural dependency changes.
- Easy rollback by operator action.

Cons:

- Does not improve autonomous control.
- Response-time dependent on human intervention.
- Inconsistent apply across all swarms/schedules.

### Option 3: Segment-by-segment control plane with bounded rollout and explicit dependency gates (chosen)

Pros:

- Reduces correlated failure spread by enforcing per-segment state machines.
- Enables fail-fast and fail-safe transitions with predictable recovery.
- Supports automatic rollback with explicit guardrails and evidence checks.

Cons:

- Requires new contract fields and a few runtime checks.
- Requires disciplined rollout sequencing and migration of existing observers.

### Option 4: Replace orchestrator core (defer)

Pros:

- Maximum control and future-proofing.

Cons:

- Highest risk, long lead-time.
- Unnecessary for current maturity stage.

## Decision

Choose Option 3.

We will implement a control-plane contract that:

1. Enforces segment-aware health and rollout decisions:
   - `control-plane-status` exposes segment-level state and explicit gate reasons.
   - Rollout behavior is suppressed when segment readiness drops below threshold, instead of allowing silent global "proceed".
2. Applies deterministic rollout gates:
   - controller readiness gate,
   - migration consistency gate,
   - empirical dependency gate,
   - watch ingestion freshness gate,
   - and rollout health gate.
3. Enables fast recovery by codifying rollback criteria before each deployment step.
4. Makes failures machine-readable with severity classes (`block`, `delay`, `proceed`, `warn`) instead of ad-hoc boolean checks.

## Architecture changes

### 1) Control-plane failure-domain segmentation

Control decisions for `discover`, `plan`, `verify`, and `implement` must no longer collapse into one global fail-open gate. Each run surface:

- consumes independent status inputs,
- records degradation reasons independently,
- emits one canonical health envelope to be interpreted by the scheduler.

### 2) Rollout gate contract

Each rollout step must satisfy gate checks before progressing:

- dependency quorum confidence above the minimum threshold for the target segment,
- stable rollout signal for target namespace(s) (deployments + replica health),
- stable watch stream or local fallback with explicit authority tags,
- no sustained freshness violation on critical telemetry windows.

If any gate is blocking:

- block the rollout at source segment boundary,
- emit a structured event with:
  - segment,
  - failing gate,
  - threshold breached,
  - expected recovery condition,
- open a short-lived maintenance cooldown window before retry.

### 3) Heartbeat and config reliability contract

- `resolveHeartbeatStore` failures must not block status assembly for unaffected segments.
- ConfigMap expectations are versioned and validated before job creation:
  - checksum pinning in run payload,
  - required manifest hash in job-level metadata,
  - explicit failure if manifest not found rather than silent template reuse.

### 4) Ingestion and watch reliability partitioning

- `agentrun` ingestion and watch reliability are tracked by namespace with separate tolerances.
- Recovery playbooks should prioritize:
  1. ingestion and watch segments,
  2. rollout and dependency segments,
  3. policy updates only after the first two are stable.

## Validation gates

### Discovery gate (pre-implementation)

- Design document accepted with measurable hypotheses.
- Evidence package includes:
  - cluster rollup snapshots,
  - source high-risk module list,
  - schema freshness/freshness query checks.

### Implementation gate

- Static checks for any touched source files pass format/linting.
- Unit tests for changed control-plane status and metrics modules include:
  - gate reason propagation,
  - segmentation behavior under partial failure,
  - stable fallback behavior when dependency status is stale.

### Operational gate (before production rollout)

- staging replay of a mixed-failure canary:
  - failed mount in one template should not degrade healthy template rollout.
- runtemplate backoff rate and recover-time reduction compared to baseline.

## Rollout and rollback expectations

Rollout:

1. Merge architecture doc and publish to discover contract.
2. Add schema and runtime support in two phases:
   - phase A: status payload extension and gate reason fields,
   - phase B: rollout scheduler honoring gates per segment.
3. Deploy in `agents` namespace with canary template first.
4. Escalate to all torghut swarms if metrics remain within gate thresholds.

Rollback:

- If rollback condition met (`watch degradation > threshold`, `dependency gate blocked`, `migration gate unstable`, or repeated rollout `BackoffLimitExceeded`), revert to last known-good segment policy.
- Keep canary lanes disabled while non-canary surfaces remain running to preserve revenue safety.
- Preserve previous status endpoint schema for backward compatibility during one release cycle.

## Risks

- Partial-segment migration may temporarily change operator intuition if statuses become more explicit than before.
- Additional gate checks can initially increase blocking in edge cases if windows are too strict.
- ConfigMap checksum enforcement increases failure specificity; rollout pipelines must ship correct manifests for each segment.

## Measurement and success criteria

- Reduction in control-plane incident propagation:
  - fewer than 1 cross-segment blast event per 10 deploy attempts for first 30 days.
- Rollout recovery:
- median failed rollout recovery to healthy status ≤ 90 minutes after first block event.
- Stability:
  - no unbounded event loop from repeated template backoff when one segment remains healthy.

## Open implementation notes

This document is actionable for implementation stage and intentionally requires source changes in `services/jangar` and corresponding run-template contracts before production use.
