# Jangar control-plane resilience and safer rollout contract (2026-03-16)

## Objective and success criteria

Primary objective

- Remove correlated failure blast radius in torghut quant control-plane operations where a degraded subsystem disables unrelated surfaces.
- Keep deployment actions deterministic under mixed-failure conditions while preserving fast recovery.
- Expose machine-readable gates, rollback actions, and handoff signals that engineering and deployer stages can execute independently.

Success criteria

- Reduce cross-surface incidents during rollout churn by at least 40% from current baseline over 14 days.
- Achieve deterministic recovery: failed segment recovery to healthy status under 90 minutes after first gate block.
- Keep non-failing segments available during segment-local failures (no full-runbook stop).
- Maintain backward-compatible `/control-plane/status` output for one release cycle.

## Evidence snapshot (as of 2026-03-16)

### Cluster health, rollout, and events

- `kubectl get events -n torghut --field-selector type!=Normal --sort-by=.lastTimestamp` recorded persistent rollout instability in sim surfaces: `Unhealthy` startup/readiness on `pod/torghut-sim-00239...`, `route/torghut-sim` internal resource conflicts, and repeated `UpdateCompleted` bursts from ClickHouse CM changes.
- `kubectl get events -n jangar --field-selector type!=Normal` shows recovery-relevant DB restore warning `ErrorNoBackup` for `jangar-db-restore` and no active blocking deployment-level health warnings.
- `kubectl get events -n agents --field-selector type!=Normal` shows `BackoffLimitExceeded` and `FailedMount` on run-template helper pods (`codex-spark-smoke...`) pointing to shared dependency readiness issues.
- `kubectl get pods -n torghut` shows current steady state with `torghut-sim-00239-deployment` pods running while transient readiness churn is still present in prior revisions.

### Source architecture and test surface

- Segment behavior already exists in `services/jangar/src/server/control-plane-status.ts`, but it is still consumed as broad health context for most rollout actions.
- Rollout and migration checks are present in the same runtime (`services/jangar/src/server/torghut-quant-runtime.ts`) and same metrics surface (`services/jangar/src/server/torghut-quant-metrics.ts`), so single-segment degradation can still influence scheduling for multiple surfaces.
- Unit coverage currently validates helper behavior for status and dependency quorum, but does not fully pin mixed-failure rollback boundaries around segment-scoped segments in one integrated test.

### Database / data quality and consistency assumptions

- Readiness and evidence APIs in `services/torghut/app/main.py` already expose schema-fingerprint and `db-check` diagnostics.
- Direct in-cluster data inspection is blocked by RBAC (`pods/exec forbidden`) in this environment, so architecture decisions rely on API-contract evidence plus existing readiness contract surfaces.
- `ErrorNoBackup` events for restore jobs remain evidence that migration-lineage recovery workflows need explicit gating.

## Option set and tradeoffs

### Option A: Only adjust monitoring/alerting thresholds

Pros

- Lowest engineering burden.
- Immediate deployment with minimal runtime impact.

Cons

- Does not change failure semantics; correlated rollout failures still propagate globally.
- Does not create deterministic rollback actions or segment-specific recovery expectations.

### Option B: Keep architecture unchanged and use manual operator runbooks only

Pros

- No API contract changes.
- Operator retains strict manual control.

Cons

- Recovery remains human-latent and inconsistent by shift.
- Human-only intervention in mixed failures delays guardrail restoration and increases blast radius.

### Option C: Segment-scoped control-plane and rollout circuits with explicit gate contracts (chosen)

Pros

- Breaks failure propagation by giving each surface its own failure domain.
- Preserves progress on healthy surfaces while non-critical gates are blocked.
- Makes rollback deterministic and auditable via structured gate reasons.

Cons

- Requires contract additions to status payload, rollout scheduling, and rollout decision tests.
- Requires phased rollout and operator adjustment in initial stage.

### Option D: Replace orchestrator stack

Pros

- Maximum strategic flexibility.

Cons

- Largest delivery risk and unacceptable for current discovery constraints.

## Decision

Choose Option C.

We will treat each control-plane workflow as a segment domain and enforce explicit gates before segment rollout transitions occur.

Chosen architecture components:

- Segment-scoped health envelope with stable schema:
  - `segment`, `status`, `severity`, `dependencies`, `gates`, `rollout_decision`.
- Segment-local gate evaluation:
  - controller readiness, migration consistency, watch ingestion freshness, and rollout health.
- Structured rollback actions emitted at gate block level:
  - `hold`, `cooldown`, `rollback`, `escalate`.

## Detailed architecture

### 1) Segment-specific control-plane status envelope

`services/jangar/src/server/control-plane-status.ts` will represent status as independent segments:

- `discover` (readiness + rollout readiness)
- `plan` (model and hypothesis build health)
- `verify` (validation queue and migration checks)
- `implement` (infra job template readiness + run execution capacity)

Each segment will report:

- `score` (0-100 normalized)
- `decision` (`allow`, `warn`, `block`, `hold`)
- `gate_failures[]` with reason, timestamp, and expected recovery condition
- `last_recovery_at` and `next_retry_at`

### 2) Rollout scheduler gate semantics

`services/jangar/src/server/torghut-quant-runtime.ts` will consume these segment gates.

Gate preconditions before segment transition:

- `dependency_quorum >= configured_min` for segment symbol/asset scope.
- watch ingestion age under segment freshness bound.
- migration consistency check green for schema/mapping scope touched by that segment.
- no sustained `BackoffLimitExceeded` for segment-local runtime jobs.

If any gate blocks:

- abort only the affected segment transition,
- keep unrelated segments unchanged,
- emit a one-line structured maintenance event with gate IDs and recovery expectations.

### 3) Rollback contract

Rollback is triggered when one of these repeats within one control-cycle:

- same segment has `gate_block_count >= 3` with no freshness improvement,
- migration gate remains blocked after first full cooldown,
- critical rollout job health remains unhealthy for 2 consecutive checks.

Rollback action matrix:

- `hold` segment and leave active surface untouched.
- `cooldown` segment for bounded backoff window.
- `rollback` segment to prior-good version.
- `escalate` to operator alert once two hold cycles occur.

### 4) Readiness and dependency isolation

`services/jangar/src/server/torghut-quant-runtime.ts` will preserve existing global readiness behavior for observability but will never convert one segment failure into global `block`.

- failed segment readiness => `block_segment`
- unrelated segment readiness => unaffected until touched

## Validation gates and acceptance criteria

### Discovery stage acceptance

- Design contract published and signed.
- Evidence package includes
  - cluster event tails for `torghut`, `jangar`, and `agents`,
  - source module list and known blind spots,
  - schema-check behavior and DB-check availability.

### Pre-merge acceptance (implementation stage)

- Unit tests for segment status envelope and gate propagation.
- `bun run --filter @proompteng/backend lint` (or equivalent code lint step in CI matrix) for touched JS/TS sources.
- No regressions in existing control-plane tests (`services/jangar/src/server/__tests__/control-plane-status.test.ts`, `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`).

### Post-merge rollout acceptance

- During staged rollout, cross-surface impact should drop:
  - fewer than 1 full-surface failure lockout per 10 deploy attempts.
  - no more than one unrelated segment blocked by a single gate failure.
- Recovery SLO: median control-plane segment recovery under 90 minutes.

## Rollout and rollback expectations

Rollout

1. Publish merged design and implementation PR in discover-stage contract form.
2. Implement contract fields and scheduler reads in a canary scope first.
3. Run one controlled mixed-failure simulation and compare pre/post gate behavior.
4. Promote to all torghut-associated surfaces only when gate-block counts are below threshold.

Rollback

- If a segment remains blocked after 2 cooldown cycles, keep segment at `hold`, keep healthy segments active, and provide explicit operator handoff evidence (gate IDs, last recovery timestamps, rollout commit).
- Preserve schema compatibility for one release while deployers observe two full run cycles.

## Handover contract

Engineering

- Implement segment status schema and gate decision evaluator.
- Add tests for segment isolation, mixed-failure transition, and rollback actions.
- Update rollout metrics with gate fields and failure lineage.

Deployer

- Deploy in canary scope first and verify gate behavior in `agents` and `torghut` namespaces.
- Confirm event volume reduction and segment recovery times in PostHog / cluster logs.
- Escalate only on `escalate` gate state transitions.
