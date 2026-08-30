# 43. Jangar Execution Trust Safety Net and Safe Rollout Behavior (2026-03-15)

Status: Proposed (2026-03-15)

## Objective

Close the remaining control-plane truth gap by making stage freshness and freeze state explicit in the primary execution surface, then enforce rollout safety with deterministic, data-backed gates before canary progression or merge handoff.

## Assessment Summary

Collected at `2026-03-15T09:50:52Z`:

- `swarm/jangar-control-plane`: `phase=Frozen`, `ready=False`, `freeze.reason=StageStaleness`, `freeze.until=2026-03-11T16:36:12.630Z`.
- `swarm/torghut-quant`: `phase=Frozen`, `ready=False`, `freeze.reason=StageStaleness`, `freeze.until=2026-03-11T16:36:17.456Z`.
- `requirements.pending` for Jangar: `5`.
- `status?namespace=agents` returns `swarms=null`, `stages=null` while reporting `workflows.data_confidence=high`.
- `GET /ready` returns `{ "status": "ok", ... "agentsController.enabled": false }`, `orchestration` and `supporting` also false.
- Recent non-normal cluster events include repeated `FailedMount` for missing `codex-spark-swarm-*` and `jangar/torghut-swarm-*` template configmaps plus `BackoffLimitExceeded` for `jangar-swarm-verify-template-step-1-attempt-1`.
- No CNPG or PostgreSQL direct reads were possible from `agents-sa` (`pods/exec` and `cnpg status` are forbidden), so DB checks are limited to service-level contract signals.

## Sources Reviewed

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/server/control-plane-watch-reliability.ts`
- Existing design stack in `docs/agents/designs/42-...` and `docs/agents/designs/jangar-control-plane-failure-mode-reduction-and-rollout-safety-2026-03-15.md`

## Problem

Current control-plane behavior can report healthy local controller + rollout state even when the monitored swarms are already frozen and stale:

1. Source-of-truth for autonomy execution lives in swarm status (`StageStaleness`, per-stage `last*At`, requirement queues), but that truth is not surfaced in the `/api/agents/control-plane/status` envelope.
2. `/ready` is still a local-process gate and does not model execution trust for autonomous stages.
3. Stage failure modes are conflated into recent workflow counters; empty windows can hide staleness-driven freezes.
4. Readiness and rollout gates do not consume persistent evidence classes; they may admit changes while autonomy is degraded.

## Alternatives

### Option A — Status doc + runbook only

- Scope: keep runtime surfaces unchanged.
- Pros: no control-plane code risk.
- Cons: same false-green behavior persists; no deterministic hardening.

### Option B — Add stage fields only

- Scope: add read-only `swarms` + `stages` to status, but keep readiness and rollout gates unchanged.
- Pros: faster deployment, better visibility.
- Cons: visibility-only approach; false-green behavior can remain at admission/rollout stage.

### Option C — Execution-trust envelope + rollout preconditions + rollback contract (recommended)

- Scope: add authoritative status for execution trust and freeze class + gate readiness/rollout by those fields.
- Pros: preserves autonomous safety under staleness/failure pressure and makes failure recovery measurable.
- Cons: introduces new gate paths and higher implementation/test burden, but high leverage and explicit blast-radius reduction.

## Decision

Adopt **Option C** as the next control-plane architecture step.

## Chosen Design

### 1) Extend control-plane status with execution trust

Add additive fields to `ControlPlaneStatus`:

- `execution_trust`
  - `status`: `healthy | degraded | blocked | unknown`
  - `reason`
  - `last_evaluated_at`
  - `blocking_windows`: list of `swarms`, `stages`, `dependencies`
  - `evidence_summary`: pointer hash list with bounded TTL
- `swarms[]` entries per monitored swarm (`name`, `namespace`, `phase`, `ready`, `updated_at`, `observed_generation`, `freeze`, `pending_requirements`, `requirements_pending_class`, `last_discover_at`, `last_plan_at`, `last_implement_at`, `last_verify_at`)
- `stages[]` entries (`swarm`, `stage`, `phase`, `last_run_at`, `next_expected_at`, `configured_every_ms`, `age_ms`, `stale_after_ms`, `stale`, `recent_failed_jobs`, `recent_backoff_limit_exceeded_jobs`, `last_failure_reason`, `data_confidence`)

Rules:

- Swarm status is authoritative on phase/ready/freeze; workflow counters enrich but cannot override it.
- If any tracked swarm is `Frozen` or stale beyond policy, `execution_trust` is `blocked` or `degraded` depending on age and severity class.
- `data_confidence` for status must downgrade from `high` to `low` if a required `swarms` / `stages` snapshot is missing.

### 2) Make `/ready` an execution-trust gate

- `getReadyHandler` should derive final readiness from:
  - readiness of local leaders/controllers (existing),
  - plus `execution_trust.status === healthy`.
- Return HTTP `503` with an explicit trust block when execution trust is not healthy.
- Keep `orchestration` and `supporting` controller checks as existing signals, but add explicit reasons: `"execution_trust.blocked:<reason>"`.

### 3) Rollout safety preconditions

Before any canary/rollout transition, enforce:

- `execution_trust.status === healthy`.
- `dependency_quorum.decision === allow`.
- `empirical_services.jobs.status !== blocked` unless explicit incident policy authorizes.
- `watch_reliability.status !== degraded` for a sustained window, unless already degraded due to known upstream incident and `resume_override` is present.

If any predicate fails:

- block rollouts,
- emit `execution_trust.blocking_windows` entry with class,
- preserve existing rollout configuration (no partial weight advance),
- require explicit evidence before resume.

### 4) Failure-class taxonomy and staged recovery

- `Transient`: configmap miss + short probe flake; allow one automatic remap/retry cycle with exponential holdoff.
- `Systemic`: repeated stage staleness + consecutive backoff failures; trigger freeze and require operator + evidence to clear.
- `Critical`: repeated dependency failures while in freeze; hold at `blocked`, route to incident path.

### 5) Required rollout recovery contract

Every freeze clear must include:

- freeze class + threshold cross event,
- stage-specific stage age reduction evidence,
- source evidence bundle (`swarms`, `events`, `jobs`, `controller status snapshot`) in artifact store,
- confirmatory control-plane status snapshot with `execution_trust.status === healthy`.

## Validation Gates

### Engineering gates

- Control-plane status unit tests include:
  - mapping from `Swarm` `StageStaleness` to `execution_trust.blocked`,
  - readiness fails on execution-trust block,
  - rollout precondition composition with one blocked dependency.
- Integration tests proving `workflows.data_confidence` degrades when `swarms`/`stages` data is stale or missing.
- Static schema docs + example snapshots for `status`, `ready`, and rollout contracts.

### Deployer gates

- Staging validation run must pass:
  - one controlled stale-stage event with freeze,
  - recovery path requiring status trust return before canary resume.
- Any `BackoffLimitExceeded` or probe timeout must not auto-clear freeze.
- `control-plane status` and `/ready` must be green only after trust and rollback preconditions return healthy.

## Rollout and Rollback Expectations

For engineer:

1. Merge implementation behind a feature gate (`JANGAR_CONTROL_PLANE_EXECUTION_TRUST=true`) first.
2. Validate in `agents-ci` style path with synthetic stale swarm object.
3. Expand to production rollout only when one full recovery cycle finishes without manual rollback.

For deployer:

1. Observe frozen-stage detection and no rollout weight movement during block.
2. Confirm evidence bundle produced and stored.
3. Open a manual incident note on first `Critical` class freeze.

Rollback:

- disable execution-trust gate by removing stage tracking from readiness/rollout path only if:
  - trust computation service is unhealthy for >15m with no alternate deployment,
  - incident ticket is opened and approved by owner,
  - explicit temporary override token is set and time-boxed.

## Risks and Mitigations

- **Over-tight gating extends MTTR on benign flakiness**: gate windows and class decay with explicit override.
- **Controller read amplification**: cache swarm snapshots per minute and cap event lookback windows.
- **Insufficient signal-to-noise in stale classification**: include confidence metadata and age thresholds to avoid repeated freeze loops.
- **Cross-surface drift**: add schema regression snapshot tests across control-plane status, ready, and docs contract references.

## Exit Criteria

- `/api/agents/control-plane/status` always includes authoritative `swarms` and `stages` under normal permissions.
- `/ready` can only return 200 when `execution_trust.status === healthy`.
- No rollout progression during unresolved `StageStaleness`.
- Freeze clearance event must include explicit evidence bundle and timestamp.
