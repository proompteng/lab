# 42. Jangar Control-Plane Failure-Mode Reduction and Safe Rollout Contract (2026-03-15)

## Objective

Increase control-plane reliability through explicit failure-domain reduction, deterministic recovery behavior, and rollout safety defaults that prevent stale or partial mission progress from propagating changes to production.

This design is for the `jangar-control-plane` swarm lane and defines what is required for autonomy to continue while reducing the blast radius of:

- stale stage schedules,
- inconsistent run status, and
- rollout progress during unresolved dependency health regressions.

## Current Assessment Snapshot

Observations captured at `2026-03-15`:

- `jangar-control-plane` and `torghut-quant` are both `phase=Frozen` in `swarm` status.
- The active freeze reason on `jangar-control-plane` is `StageStaleness`.
- Stage cadence is `1h`, but evidence shows repeated last-run times and age windows from March 8, while freeze window started March 11, indicating stale progression.
- Deployment health is healthy at rollout level, but with `requirements.pending=5` and `stageStates.*.phase=Frozen`.
- Event history includes `BackoffLimitExceeded` for `torghut-swarm-verify-template-step-1-attempt-1`, showing stage-level failure recovery did occur but lacks a general safe recovery policy for all stage classes.
- `/api/agents/control-plane/status?namespace=agents` reports database migration health `healthy` with all migrations applied, plus watch stream health `status=healthy`.
- `/api/agents/control-plane/status` exposes a high failure potential in watch ingestion (`agentrun_ingestion.message="agents controller not started"` with null last event).

## Problem Definition

1. **Failure modes are detected but not codified into staged recovery lanes.**
   The system can freeze safely, but currently has to rely on operator intervention to re-arm when multiple stage timers drift.
2. **Safety gate conditions are broad, not failure-class aware.**
3. **Rollout behavior assumes green controller state, not green dependency state.**
   If critical dependency freshness degrades during rollout, the runbook lacks a hard guardrail that blocks canary progression preemptively.
4. **Evidence continuity between stage-level failures and cluster-level rollout is weak.**
   The control surface can read failures, but decision traceability between freeze cause and rollout effect is manual.

## Source Architecture Review (High-Risk Modules + Coverage Notes)

- `services/jangar/src/server/control-plane-status.ts` is the primary status spine, but it is only a read surface.
- `services/jangar/src/server/supporting-primitives-controller.ts` and
  `services/jangar/src/server/orchestration-controller.ts` control mission phase transitions and workflow scheduling.
- `services/jangar/src/server/control-plane-watch-reliability.ts` already tracks watch restarts but has no explicit contract for automatic stage recovery thresholds.
- `services/jangar/src/server/torghut-trading.ts` and `services/jangar/src/server/torghut-quant-runtime.ts` feed dependency and runtime signals used by `jangar-control-plane`.
- Test coverage is present for caching, controller APIs, and route responses, but there is no direct regression test proving:
  - freeze-to-recovery state transitions for mixed stage failures,
  - rollback precondition checks before canary step transitions, or
  - end-to-end dependency degradation blocking rollout steps.

These are the sources that need explicit design guardrails before production autonomy can be expanded safely.

## Architecture Alternatives

### Option A — Keep current freeze behavior, improve operator runbooks

- **Scope**: documentation only; no control-loop changes.
- **Pros**: fast to execute; predictable.
- **Cons**: no reduction in MTTR for repeated stage failures; still dependent on manual triage under sustained staleness.

### Option B — Introduce static guard constants only

- **Scope**: add one-time constants for max stale age and strict freeze thresholds.
- **Pros**: easy to reason about and quick to roll out.
- **Cons**: brittle under market/session drift and does not distinguish recoverable from non-recoverable failure classes.

### Option C — Implement a failure-class-aware reliability gate and release guardrail stack (recommended)

- **Scope**: model stage and rollout behavior as a failure-domain graph:
  - Stage failure class + age bucket determines automatic response.
  - Dependency degradation and watch health are explicit rollout gates.
  - Rollout is blocked by unresolved dependency classes even if deployment health looks green.
- **Pros**: highest control and lowest blast radius; supports autonomous recovery while staying fail-closed.
- **Cons**: requires coordinated changes to control-plane policy evaluation and controller tests.

## Decision

Adopt **Option C**. The design keeps the platform safe while still enabling measurable autonomy.

## Target Design

### 1) Failure-class model

Define three classes for stage failures:

- **Transient**: single-stage pod errors, short-lived watch restarts, one-off artifact fetch misses.
- **Systemic**: repeated run failures, repeated empty event windows, unresolved dependency quorum.
- **Critical**: security or policy violation, repeated freeze breaches above threshold, or controller initialization failure.

Each class maps to a deterministic response:

- Transient: automatic re-run with exponential delay and capped retries.
- Systemic: class-specific holdoff, auto-unfreeze once recovery evidence exists, and explicit stage re-open.
- Critical: lock freeze and publish incident/repair action with minimal privilege.

### 2) Stage recovery playbook

For each stage (`discover`, `plan`, `implement`, `verify`):

1. collect `last_success_at`, `last_error_at`, and `last_run_age`.
2. apply failure-class policy from above.
3. only escalate to freeze when:
   - age > configured fail-fast threshold, and
   - one of:
     - repeated same-class failures beyond max attempts,
     - unresolved dependency dependency quorum fail,
     - stale state persistence.
4. require evidence from control-plane status before unfreeze:
   - stage staleness reduced below configured upper bound,
   - dependency check class downgraded,
   - readiness report is available for at least one full cycle.

### 3) Safe rollout preconditions

Add rollout precondition predicates before any canary step executes:

- `dependency_quorum.decision` must be `allow`.
- `empirical_services.jobs.status` must not be in `degraded` (or be explicitly whitelisted with a written override).
- `agentrun_ingestion.status` not unknown; if unknown, block rollout and log required-fix.
- `watch_reliability.total_errors` must be within threshold for the window.

If any predicate fails, hold canary progression at current weight and execute rollback-preventive hold action.

### 4) Recovery evidence contract

Every unfreeze and every rollout resume must emit evidence bundle fields:

- `freeze.reason`, `freeze.threshold`, `freeze.durationMs`
- stage age recovery points
- dependency predicate verdicts
- rollback condition checks
- validation artifacts (tests and status snapshots)

These fields are written once and reused for mission artifact generation.

## Validation Gates

### Engineering gates

- New tests covering stage class transitions for all 4 stages.
- Regression tests for rollout precondition failures blocking canary advancement.
- Integration test for unfreeze path that shows stage recovery after dependency recovery.
- Unit tests ensuring dependency classes map deterministically to actions.

### Deployer gates

- Argo rollout blocked when dependency predicates fail.
- Canaries must pass one cycle at each step before auto-advancement.
- `service` endpoints in control-plane status must show healthy database and watch streams before merge gates open.
- Auto-rollback must restore previous weights when rollout preconditions fail mid-flight.

### Operations gates

- `stageStaleness.ageMs` never exceeds `3x` stage cadence after mitigation.
- No more than one freeze-trigger class per 24h without incident closure annotation.
- `requirements.pending` trend declines to zero in first successful recovery cycle.

## Rollout and Rollback Expectations

### For Engineer (implementation stage)

- First merge should include:
  - schema for failure-class records,
  - policy evaluator updates in status/watch stack,
  - controller-level recovery tests.
- Stage rollout should be feature-flagged.
- Ship with one controlled staging mission before any production branch freeze changes.

### For Deployer (production stage)

- Enable rollout preconditions and holdoff first in staging namespace.
- Observe one complete cycle:
  - one stage staleness event,
  - auto-recovery path,
  - rollback holdback and re-open,
  - healthy re-freeze clearance.
- Expand rollout to production only after zero regression signal in 2 consecutive cycles.

## Risks and Failure Modes

- **Over-constraining gates** can lengthen mission duration. Mitigation: staged thresholds and explicit override with expiry.
- **Incorrect classification of transient vs systemic failures** can cause unnecessary freezes. Mitigation: class counters with decay.
- **Dependency gate false positives** could block legitimate recoveries. Mitigation: allowlist + evidence expiry for known intermittent signals.
- **Incomplete historical linkage** if evidence bundles are not serialized consistently. Mitigation: mandatory evidence schema plus mandatory artifact references.

## Exit Criteria

- Both control-plane and deployer can show successful stage recovery with at least one documented stale-run instance per stage class.
- Rollout does not progress when dependency gates fail.
- Post-recovery mission logs include recovery reason + class + explicit recovery timestamp and evidence references.

## References

- `docs/agents/designs/28-` and `docs/agents/designs/29-` design line are the current production readyness context.
- This document extends and supersedes previous control-plane stage-readiness assumptions around static freeze handling.
