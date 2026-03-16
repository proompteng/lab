# Jangar Control Plane Failure-Mode Reduction and Safe Rollout Architecture (2026-03-16)

Status: Implemented (discover architecture finalization)
Owner: Victor Chen (Jangar Architecture)
Related objective: `codex/swarm-jangar-control-plane-discover` (`swarmStage: discover`)

## Summary

This document defines the architecture changes needed for `jangar-control-plane` to reduce silent control-plane failure modes and prevent unsafe rollout progression.

The change set is centered on:

- converting schedule liveness into execution truth,
- making stage failures, watch drift, and rollout health visible in admission decisions,
- and introducing safer rollout boundaries (graceful degradation, bounded retries, explicit rollback triggers).

The result is a system that degrades predictably, surfaces root causes earlier, and resumes only with measured confidence.

## Primary problem

Current read-only evidence shows `jangar-control-plane` can report schedule readiness while core execution surfaces are degraded:

- Swarm objects are `Frozen` with `StageStaleness` and repeated `queuedNeeds` growth in the cluster.
- implement jobs have consecutive failures (`BackoffLimitExceeded`), yet schedule metadata can still show readiness in stale forms.
- rollout health reads currently degrade to `unknown` in places where kube read permissions and error handling are weak.
- stage and freeze policy still heavily centers on implement-stage signals, leaving non-implement regressions under-represented.

These failure modes permit optimistic signals and delayed intervention.

## Source assessment

High-risk surfaces reviewed in `services/jangar`:

- `services/jangar/src/server/control-plane-status.ts`
  - already computes:
    - rollout deployment status,
    - workflow reliability counters,
    - migration consistency,
    - watch reliability.
  - but schedule/job outcome drift can still be interpreted as healthy if only liveness checks are treated as evidence of correctness.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - owns freeze/readiness behavior for swarm objects and schedules.
  - currently computes freeze from a subset of stage signals and has historically focused on implement-stage triggers.
- `services/jangar/src/data/agents-control-plane.ts`
  - health contract is already rich enough to carry additional confidence and rollout metadata without breaking the API shape.

Test surface exists in:

- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`
- `services/jangar/src/components/__tests__/agents-control-plane-status.test.tsx`

Gaps:

- Regression coverage is still lighter around multi-stage coordinated freeze behavior (discover/plan/implement/verify together).
- No explicit regression tests yet for quota-error fallback policy in schedule parameterization.
- no end-to-end assertion that rollout-safe gates block risky merges from schedule-controller feedback.

## Assessment evidence (discover run)

- Cluster evidence snapshot:
  - `jangar-control-plane` is `Frozen` with `StageStaleness`, `Ready: false`, `queuedNeeds > 0`.
  - `kubectl get events -n agents` repeatedly contains stage-level churn and `BackoffLimitExceeded` entries in the inspected window.
- Source evidence:
  - decision and status logic paths are already present in `services/jangar/src/server/control-plane-status.ts` and `services/jangar/src/server/supporting-primitives-controller.ts`.
  - existing fallback/readiness behavior is centralized and can be tightened with minimal contract break risk.
- Data contract evidence:
  - migration consistency and watch reliability are already carried in `services/jangar/src/server/control-plane-status.ts`,
  - freshness checks exist through migration and watch surfaces and are directly testable without schema migration.

## Database/source-data assessment

- Migration state contracts are present and currently healthy per status:
  - `services/jangar/src/server/kysely-migrations.ts` lists migrations through `20260312_torghut_simulation_control_plane_v2`.
  - `services/jangar/src/server/control-plane-status.ts` already reports `migration_consistency` with unapplied/unexpected drift detection.
- Required extensions are enforced (`vector`, `pgcrypto`) during migration checks.
- External SQL-level query path is read-restricted from this runtime in places; live assessment here therefore uses status API evidence and migration registry tests.

## Proposed architecture changes

### 1) Execution truth envelope (selected)

Introduce a first-class `stage_outcome` object in `/api/agents/control-plane/status` that is computed from recent run outcomes and used by dependency decisions.

Schema additions:

- `stage_outcome.confidence` (`high | degraded | unknown`)
- `stage_outcome.samples`
- `stage_outcome.recent_failures`
- `stage_outcome.top_failure_reasons`
- `stage_outcome.max_staleness_ms`
- `stage_outcome.next_probe_backoff_ms`

This is additive and safe for existing clients.

### 2) Stage-aware freeze and recover policy

Replace single-stage freeze policy with stage-vector policy:

- Each stage (discover/plan/implement/verify) has independent:
  - `failure_window_minutes`
  - `failure_threshold`
  - `stale_after_minutes`
  - `cooldown_minutes`
- Freeze trigger is generated when:
  - stage consecutive failures exceed threshold, or
  - no successful outcome is observed and staleness window passes.
- Recovery requires explicit success path plus confidence restoration; stale `queuedNeeds` must return to zero before unfreeze.

### 3) Safer rollout feedback loop

Split rollout gates into two levels:

- **Allow**: keep schedule readiness for planning/implementation when confidence is stable.
- **Delay**: pause non-critical actions and keep existing run history, but still collect evidence.
- **Block**: prevent new runs and disable schedule dispatch when confidence degrades below threshold.

Decision sources:

- `dependency_quorum` output from `control-plane-status.ts`,
- rollout health (`DeploymentRolloutStatus`) from `JANGAR_CONTROL_PLANE_ROLLOUT_DEPLOYMENTS`,
- workflow collection confidence and backoff pressure.

### 4) Quota-classified failure signaling and fallback routing

Define explicit classification tags in swarm schedule parameters:

- `provider.quota_exhausted`
- `provider.rate_limited`
- `model.unavailable`
- `payload_validation`

When these appear:

- failover provider order can rotate automatically for the same stage,
- fallback must be explicit in run records and emitted into Huly requirement scope (where available),
- fallback outcomes are counted separately from hard failures.

### 5) Rollout rollback envelope

Controller-level rollback contract:

- If block state is active for >2 windows or deployment rollout is materially degraded, automatically suspend `jangar-control-plane` rollout channel.
- Require a manual verify run and refreshed confidence envelope before unfreezing.
- Store last good rollout fingerprint (`config fingerprint`, `deployment names`, `rollout hash`) to allow repeatable rollback.

## Alternatives considered

### A) Keep schedule ready/phase as-is and rely on external incident tooling

- Pros: no API contract change.
- Cons: continues split-brain, delays root-cause attribution, increases incident MTTR.

### B) Add separate `/api/agents/control-plane/outcome`

- Pros: rich data surface and minimal coupling with current status payload.
- Cons: creates another contract and duplicate UI/alert surfaces.

### C) Add additive execution truth + unified admission gates (selected)

- Pros:
  - immediate operator visibility where it already looks.
  - minimal client integration work.
  - deterministic freeze and rollout behavior with measurable thresholds.
- Cons:
  - adds one extra control-plane synthesis path and requires new thresholds.

## Implementation sequence

1. Data contract extension in `services/jangar/src/data/agents-control-plane.ts`.
2. Confidence aggregation and decision wiring in `services/jangar/src/server/control-plane-status.ts`.
3. Stage-aware freeze logic updates in `services/jangar/src/server/supporting-primitives-controller.ts`.
4. Schedule parameter propagation for classified failure context.
5. Unit/integration tests for:
   - confidence downgrade on stale stage outcomes,
   - stage-specific freeze transitions,
   - rollout block/delay/allow transitions.
6. UI/UX update for rollout and stage confidence in control-plane panel.

No hard schema migration required for status envelope (derived runtime contract), but migration consistency checks remain unchanged.

## Validation and acceptance gates

Engineering gate (pre-merge):

- `services/jangar/src/server/control-plane-status`:
  - `dependency_quorum.decision !== block` under steady healthy conditions.
  - `stage_outcome.confidence === 'high'` required for run admission.
  - stale backoff and rollout degraded events must surface in `namespaces`/`degraded_components`.
- Controller gate:
  - freeze duration and reason are visible in swarm status,
  - implement/plan/verify stale timers reduce `queuedNeeds`.
- Tests:
  - new `control-plane-status` coverage includes confidence transitions,
  - new controller coverage includes stage-specific freeze trigger matrix.

Data gate (pre-merge):

- migration consistency must remain healthy and include unapplied/unexpected counts in control-plane status.
- watch reliability must report stable totals for ingestion, and unknown must require explicit operator override in this stage.

Deployment gate:

- 2 consecutive stage windows with no confidence regression and no `StageStaleness`.
- rollout deployment health message contains full mismatch details if status drifts (`ready/updated/reason`).
- `watch_reliability` must report `status=healthy` before enabling automatic unfreeze.

Rollout scope for engineer/deployer:

- Scope to source modules:
  - `services/jangar/src/data/agents-control-plane.ts`
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/supporting-primitives-controller.ts`
  - `services/jangar/src/server/torghut-trading.ts`
- Scope to validations:
  - stage-confidence transition tests,
  - freeze/recover matrix tests,
  - end-to-end rollout precondition integration test.

Rollback gate:

- If any single gate fails after rollout: block further schedule dispatch, preserve run history, run recovery playbook, and restore previous schedule parameters from artifact.

## Rollout and rollback expectations

- Rollout is safe only when:
  - all enabled stages report bounded confidence,
  - no freeze active,
  - rollout health is healthy or degraded only in non-material components.
- Immediate rollback policy:
  - revert schedule parameter changes,
  - clear temporary fallback order overrides,
  - release frozen runs only after verification rerun confirms fresh stage outcomes.

## Risks

- Excessively strict thresholds can stall autonomous progress during transitory upstream instability.
- Classification drift could incorrectly route to fallback providers if reason parsing is not strict.
- Deployment RBAC limits can still reduce rollout observability; confidence must remain explicit and bounded.

## Handoff contract for implementers

For engineer stage:

1. Ship stage-aware confidence fields and admission logic first with default off-ramp values.
2. Add stage-specific freeze tests and document failure signatures.
3. Add rollout health assertions to CI checks.
4. Publish proof: pre/post snapshots for
   - one frozen swarm transition,
   - one delayed transition,
   - one recovered transition.

For deployer stage:

1. Apply rollout CR/manifest updates in one change.
2. Validate control-plane status contract from runtime (`/api/agents/control-plane/status`) in both target and standby windows.
3. Trigger a verify run manually if any `StageStaleness` appears after deploy.
4. Do not remove feature flags until gate evidence passes in two consecutive windows.
