# 44. Jangar Control-Plane Segmented Failure Domains and Safe Rollout Contract (2026-03-16)

## Status

Status: Approved for implementation by architecture lane (`discover` -> `plan`)
Date: `2026-03-16`

## Objective

Close the control-plane reliability gap where frozen/aged swarms can pass partial readiness and still permit rollout movement. The contract converts stage and dependency signals into explicit execution trust classes, enforces deterministic rollout holdoff states, and preserves production safety during mixed-failure events.

## Assessment evidence captured

### Cluster health / rollout / events

- Namespace: `agents`
- Pods include stable control-plane controllers plus active run-template jobs.
- Recent non-normal events:
  - `BackoffLimitExceeded` on `jangar-swarm-plan-template-step-1-attempt-1`.
  - `FailedMount` on missing configmaps for `codex-spark-*` template input/spec configmaps.
- `status` snapshots from API CRs show:
  - `jangar-control-plane` and `torghut-quant` both in `phase=Frozen`.
  - freeze reason `StageStaleness` with stale ages ~`289-291M ms` and `staleAfterMs=7200000` for discover/plan/implement/verify.
  - `requirements.pending` on `jangar-control-plane=5`.
- Controller rollout remains partially in-flight (template pods at `Running`, some `Completed`, several `Error`) under failure conditions.

### Source architecture / high-risk module assessment

- `services/jangar/src/server/control-plane-status.ts`
  - authoritative source for rollout and watch health signals, but currently lacks explicit per-stage execution classing and deterministic rollback state transitions.
- `services/jangar/src/routes/ready.tsx`
  - still oriented toward controller liveness and not full execution trust under stale/frozen stage conditions.
- `services/jangar/src/server/control-plane-watch-reliability.ts`
  - provides meaningful retry/degraded heuristics; currently contributes to global signals without failure-class partitioning.
- `services/jangar/src/server/orchestration-controller.ts` + `services/jangar/src/server/supporting-primitives-controller.ts`
  - orchestration state machines exist but do not yet encode stage-class-specific throttle + cooldown contracts.

### Database / data schema-quality-freshness-consistency assessment

- Read-only access from runtime context is constrained (no pod exec / limited direct DB shell access), so validation is source-contract + migration-level.
- `services/jangar/src/server/migrations/20260308_agents_control_plane_component_heartbeats.ts` and `services/jangar/src/server/migrations/20260212_torghut_quant_control_plane.ts` demonstrate the current schema surface for control-plane and Torghut trust signals.
- Evidence indicates schema surface is present, but trust state must be explicitly serialized as new typed contract fields for downstream rollout/engineer-deployer handoff instead of deriving from implicit controller combinations.

## Problem and failure-mode reduction target

Current behavior allows noisy or stale subsystems to obscure explicit stage truth while rollout logic can still advance or attempt recoveries through limited scoped checks. This creates two risks:

1. Mixed failures (one or two stages stale, others healthy) become ambiguous and can produce inconsistent readiness interpretations.
2. Recovery logic is not failure-class aware enough to distinguish transient infra flake from systemic control-plane degradation.

The target architecture is to make execution decisions failure-class deterministic and scoped by stage + surface rather than single-shot global booleans.

## Ambitious options considered

### Option A — Status-only observability upgrade (minimal)

- Add more metrics and dashboards, no control-plane gate changes.
- Lower implementation risk but does not reduce blast radius or prevent incorrect rollout movement.

### Option B — Add coarse blocked state to rollout controller only

- Add one additional `blocked|degraded|healthy` gate in rollout coordinator.
- Better than no gating, but still conflates transient and systemic failures and does not preserve per-surface recovery details.

### Option C — Failure-domain segmentation + staged trust envelope (chosen)

- Introduce explicit failure classes (Transient/Systemic/Critical) with per-stage and per-surface confidence scoring.
- Route readiness/rollout to this trust envelope.
- Persist deterministic evidence bundle for every block/hold/recovery transition.

## Decision

Adopt **Option C** for discover-stage implementation due to higher fault isolation and lower future regression cost.

## Proposed architecture changes

### 1) Execution-trust envelope as first-class status

Add additive status fragments under `/api/agents/control-plane/status` and internal runtime model:

- `executionTrust`
  - `decision`: `healthy|degraded|blocked|unknown`
  - `effectiveMode`: `observed|override`
  - `blockingWindows`: list of `{surface, start, severity, reasonCode, windowMs, evidenceRefs}`
  - `confidence`: `high|medium|low`
- `swarms[]`
  - authoritative per-swarm state: `name`, `namespace`, `phase`, `ready`, `pending`, `freeze`, `staleness`, `stageRunAges`.
- `stages[]`
  - per-stage state: `swarm`, `stage`, `phase`, `enabled`, `failureClass`, `lastRunAt`, `ageMs`, `stale`, `staleAfterMs`, `recentFailureCount`, `evidenceRefs`.

### 2) Failure-class model and state machine

- `Transient`: one-off infra or transient startup/restart signals.
  - Action: exponential retry, short holdoff, no hard freeze unless threshold repeats.
- `Systemic`: repeated stale/failure on the same stage or repeated backoff with no recovery.
  - Action: controlled rollout `hold`, explicit freeze evidence required before resume.
- `Critical`: prolonged frozen or control surface with missing evidence + degraded trust across two or more surfaces.
  - Action: block all canary progression and require engineer confirmation.

### 3) Rollout safe progression contract

Before each canary step transition, evaluate:

1. `executionTrust.decision === healthy` OR explicit tested override.
2. stage-level class check for active swarm(s).
3. watch/ingest error window within configured class budgets.
4. dependent status confidence not `unknown`.

If any predicate fails:

- decision becomes `hold` or `block` according to class.
- do not advance rollout weights.
- emit structured evidence bundle in status for engineer or deployer handoff.

### 4) Cross-surface anti-flap policy

- `flapWindowMinutes`: failure-class hysteresis for one-off warnings.
- hold counters decay linearly after stable windows.
- only transition `blocked->degraded->healthy` if two consecutive healthy samples observed per stage.

### 5) Ready gate alignment

Update `/ready` to return non-200 when execution trust is `degraded|blocked|unknown`, while preserving liveness `/health` semantics.

## Validation gates

### Engineer gates

- Unit tests in `services/jangar/src/server/control-plane-status.test.ts` and `services/jangar/src/routes/ready.tsx` for:
  - `StageStaleness` maps to `executionTrust.blocked`.
  - single failed mount creates a transient hold, not full block.
  - repeated systemic failures move to blocked.
- Integration test proving no canary weight change while class is `hold`/`block`.
- Snapshot tests for schema extension (`executionTrust`, `swarms`, `stages`) to prevent silent drift.

### Deployer gates

- `status` and `/ready` must show `executionTrust` and `blockingWindows` entries during staged canary rehearsals.
- A staged `stageStaleness` simulation must keep rollout paused and produce evidence refs.
- Emergency clear of freeze must include a timestamped evidence bundle and `requirements.pending` reduction over one cycle.

## Rollout expectations and handoff

### Engineer handoff

- Implement status model + rollout predicate changes behind existing config flags.
- Add structured evidence writer + tests.
- Publish migration or compatibility notes for consuming clients.
- Verify with at least one synthetic and one real-run freeze case.

### Deployer handoff

- Deploy first in canary namespace and enforce staged rollout hold logic.
- Confirm no canary movement during systemic block windows.
- Confirm evidence bundle is attached to every block/hold and recovery event.

## Rollback policy

- Rollback to previous control-plane behavior is only via feature flag for `executionTrust` enforcement.
- If confidence drops below `low` for >15m due to evaluator faults, temporarily disable trust enforcement with explicit incident annotation and runbook reference.
- Keep emitted evidence and historical blocking windows for post-mortem; do not clear state on rollback.

## Tradeoffs and risks

- Over-constraint can increase recovery latency in high-noise windows; mitigated by anti-flap decays and class thresholds.
- Added state complexity increases schema review burden; mitigated with snapshot tests and migration notes.
- Potential mismatch between controller signal cadence and stage truth intervals; mitigated by class-specific hold windows and evidence references.

## Success criteria

- zero canary progression during any `executionTrust.decision=blocked` window.
- no mixed-stage incident where one stale stage causes silent ready=200.
- each block/hold transition persists with evidence and owner-readable reason in status.
- first two release cycles reduce recovery variance versus historical `BackoffLimitExceeded` handling.

## Merge-ready implementation scope

- Status implementation: `services/jangar/src/server/control-plane-status.ts`
- Readiness alignment: `services/jangar/src/routes/ready.tsx`
- Orchestration predicate updates: `services/jangar/src/server/orchestration-controller.ts`
- Controller watch integration: `services/jangar/src/server/control-plane-watch-reliability.ts`
- Supporting tests:
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - `services/jangar/src/routes/__tests__/ready.test.ts`
