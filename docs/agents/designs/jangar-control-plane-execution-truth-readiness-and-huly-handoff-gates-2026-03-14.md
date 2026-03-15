# Jangar Control Plane Execution Truth, Readiness, and Huly Handoff Gates (2026-03-14)

Status: Proposed (2026-03-14)

## Summary

As of `2026-03-14 21:00 UTC`, the live `jangar-control-plane` and `torghut-quant` swarms are both `Frozen` with
`reason=StageStaleness`, their last successful stage runs are still from `2026-03-08`, and the Jangar swarm still has
five pending requirement signals. The main operator status route now reports remote controller rollout truth
correctly, but it still shows `workflows.recent_failed_jobs=0`, `workflows.backoff_limit_exceeded_jobs=0`, and no
`swarms` or `stages` section even while the monitored autonomous swarms are frozen.

At the same time, `/health` and `/ready` on the `agents` web surface still return `status=ok` while reporting
`agentsController.enabled=false` and `agentsController.started=false`, so readiness is not yet an execution-trust
gate. Huly collaboration is also not part of the contract: worker-scoped `account-info` calls timed out against the
live Huly transactor, but no control-plane surface records that collaboration impairment.

This design closes the next truth gap after the March 8 heartbeat work: Jangar must aggregate authoritative swarm
execution state, stage freshness, readiness semantics, and Huly handoff health into one operator contract that is safe
for autonomous planning and rollout decisions.

## Relationship to prior designs

This document is a follow-on to:

- `docs/agents/designs/jangar-control-plane-stage-outcome-confidence-and-quota-resilience.md`
- `docs/agents/designs/jangar-control-plane-capability-admission-failure-budgets-and-rollout-rings-2026-03-06.md`
- `docs/agents/designs/jangar-control-plane-admission-quorum-and-rollout-circuit-breaker-2026-03-06.md`
- `docs/agents/designs/jangar-control-plane-freeze-state-truth-and-provider-capacity-governor-2026-03-06.md`
- `docs/agents/designs/jangar-authoritative-controller-heartbeat-and-dependency-quorum-2026-03-08.md`

Those designs identified the right direction:

- outcome confidence instead of optimistic zeroes,
- admission and rollout classification before burning retries,
- freeze-state truth as a first-class contract, and
- heartbeat-backed controller authority for split deployments.

The March 8 heartbeat work addressed controller and runtime authority. The remaining live problem on March 14 is that
execution truth for monitored swarms and collaboration truth for Huly are still absent from the primary operator and
readiness surfaces.

## Assessment context

- Cluster scope: `agents`, `jangar`, and Huly transactor service access as observed from this workspace.
- Source scope: `services/jangar/src/server/**`, `services/jangar/src/routes/**`, and existing Jangar design docs.
- Database scope: service-owned status contract only; direct SQL was not required for the selected design slice.
- Evidence capture window: `2026-03-14 20:59 UTC` through `2026-03-14 21:06 UTC`.

## Live evidence

### Cluster execution evidence

- `kubectl get swarm,agentrun -n agents` shows:
  - `swarm/jangar-control-plane` in `PHASE=Frozen`, `READY=False`
  - `swarm/torghut-quant` in `PHASE=Frozen`, `READY=False`
  - fresh `codex-spark-smoke`, `torghut-swarm-discover-template`, `torghut-swarm-plan-template`, and
    `torghut-swarm-verify-template` failures while both monitored swarms remain frozen
- `kubectl get swarm jangar-control-plane -n agents -o yaml` shows:
  - `status.freeze.reason=StageStaleness`
  - `status.freeze.enteredAt=2026-03-11T15:36:12.630Z`
  - `status.freeze.until=2026-03-11T16:36:12.630Z`
  - stale `stageStaleness` evidence for all four stages
  - `lastDiscoverAt=2026-03-08T07:05:00Z`
  - `lastPlanAt=2026-03-08T07:20:00Z`
  - `lastImplementAt=2026-03-08T07:35:00Z`
  - `lastVerifyAt=2026-03-08T06:50:00Z`
  - `requirements.pending=5`
- `kubectl get swarm torghut-quant -n agents -o yaml` shows the same `StageStaleness` freeze pattern with March 8
  last-run timestamps across discover, plan, implement, and verify.
- `kubectl logs -n agents codex-spark-smoke-step-1-attempt-1-tl6b6 --all-containers --tail=200` failed with:
  - `You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try again at Mar 15th, 2026 9:01 AM.`
- `kubectl logs -n agents torghut-swarm-plan-template-step-1-attempt-1-nkk25 --all-containers --tail=200` failed with
  the same provider-capacity error.
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -n 120` shows fresh
  `BackoffLimitExceeded` events for:
  - `job/codex-spark-smoke-step-1-attempt-1`
  - `job/torghut-swarm-discover-template-step-1-attempt-1`
  - `job/torghut-swarm-plan-template-step-1-attempt-1`
  - `job/torghut-swarm-verify-template-step-1-attempt-1`

### Status and readiness evidence

- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.'`
  returns:
  - healthy remote `controllers` and `runtime_adapters` derived from `agents-controllers`
  - `database.status=healthy`
  - `database.migration_consistency.registered_count=24`
  - `database.migration_consistency.applied_count=24`
  - `rollout_health.status=healthy`
  - `workflows.recent_failed_jobs=0`
  - `workflows.backoff_limit_exceeded_jobs=0`
  - `workflows.data_confidence=high`
  - no `swarms` section
  - no `stages` section
- `curl -fsS 'http://agents.agents.svc.cluster.local/ready' | jq '.'` returns HTTP `200` and:
  - `status=ok`
  - `agentsController.enabled=false`
  - `agentsController.started=false`
  - `orchestrationController.enabled=false`
  - `supportingController.enabled=false`
- `curl -fsS 'http://agents.agents.svc.cluster.local/health' | jq '.'` also returns HTTP `200` with
  `agentsController.enabled=false` and `agentsController.started=false`.

The resulting operator story is inconsistent:

- the status route says controllers and rollout are healthy,
- the readiness and health routes say local controllers are disabled but still report `ok`,
- the authoritative swarm CRs say autonomous execution has been frozen for days.

### Source evidence

- `services/jangar/src/server/control-plane-status.ts`
  - `resolveWorkflowsReliabilityStatus(...)` reads only `jobs.batch` resources within a bounded time window and does
    not read `Swarm.status.freeze`, `Swarm.status.stageStates`, or last stage timestamps.
  - `buildControlPlaneStatus(...)` degrades namespace status from controllers, runtime adapters, workflow counters,
    rollout health, database, watch reliability, and empirical services, but not from monitored swarm freeze state.
  - `ControlPlaneStatus` has no additive `swarms` or `stages` contract, so operators cannot consume freeze or
    staleness truth from the primary route.
- `services/jangar/src/routes/ready.tsx`
  - readiness is derived from controller CRD readiness, leader-election state, and local `assessAgentRunIngestion(...)`
  - it does not consult `buildControlPlaneStatus(...)`
  - it does not consult monitored swarm freeze or stage staleness
  - it does not consult Huly mission communication health
- `services/jangar/src/routes/health.tsx`
  - health remains local-process oriented and only checks `getAgentsControllerHealth()`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - current happy-path expectations assert workflow zeroes and namespace health without any swarm or stage envelope
  - no regression test currently requires frozen monitored swarms to degrade the status summary

### Database and collaboration evidence

- The database is healthy by the service-owned contract, and migration consistency is fully applied (`24/24`).
- The current problem is therefore not schema drift. It is contract incompleteness: authoritative swarm execution
  truth and collaboration health are still missing from the main operator surface.
- Huly worker-scoped access did not complete successfully from this workspace:
  - `python3 skills/huly-api/scripts/huly-api.py --operation account-info --worker-id "$SWARM_AGENT_WORKER_ID" --worker-identity "$SWARM_AGENT_IDENTITY" --require-worker-token --require-expected-actor-id --timeout-seconds 10`
  - failed with a Python `TimeoutError` while waiting for `GET /api/v1/account/<workspace-id>` on
    `http://transactor.huly.svc.cluster.local`

That timeout means the collaboration system required for thread-aware teammate updates is itself an operational
dependency, but Jangar does not yet surface it in readiness or status.

## Problem statement

Jangar has partially fixed topology authority, but it still lacks execution authority.

Today there are four separate truths for the same control-plane window:

1. swarm CR status is authoritative for freeze, stale stages, and pending requirements,
2. operator status is authoritative for database, rollout, and controller authority,
3. readiness and health are still local-route focused and can return `ok` while autonomous execution is frozen, and
4. Huly collaboration may be degraded without appearing in any control-plane gate.

This creates three concrete operational risks:

- a deployment can look healthy enough to trust even when the monitored autonomous swarms have been frozen for days,
- stale-stage incidents can disappear behind empty workflow counters because no recent scheduled Jobs exist, and
- requirement or mission handoff can silently lose teammate context when Huly is unavailable or slow.

## Decision

Adopt an execution-truth envelope for the Jangar control plane.

The control plane must aggregate monitored swarm freeze state, stage freshness, readiness trust, and Huly
collaboration health into one additive contract. Swarm CR status remains the source of record for swarm execution
state. `/api/agents/control-plane/status` becomes the primary aggregation surface. `/ready` becomes an execution-trust
gate rather than a local-controller gate. `/health` remains liveness-oriented.

## Selected architecture

### 1. Add monitored `swarms` execution snapshots to control-plane status

Extend `/api/agents/control-plane/status` with additive `swarms` entries for each configured monitored swarm.

Minimum fields per swarm:

- `name`
- `namespace`
- `mode`
- `phase`
- `ready`
- `updated_at`
- `observed_generation`
- `active_missions`
- `pending_requirements`
- `last_discover_at`
- `last_plan_at`
- `last_implement_at`
- `last_verify_at`
- `freeze.active`
- `freeze.reason`
- `freeze.until`
- `freeze.entered_at`
- `freeze.triggering_runs`
- `freeze.stage_staleness`
- `authority.mode`
- `authority.observed_at`
- `authority.message`

Resolution rules:

- Swarm CR status is authoritative for `phase`, `ready`, `freeze`, `stageStates`, and last-stage timestamps.
- Job-derived workflow counters remain supporting evidence, not the sole source of execution truth.
- If swarm reads fail, the swarm entry becomes `authority.mode=unknown` and overall status cannot remain `healthy`.

### 2. Add per-stage freshness and execution ledger under `stages`

Extend status with additive `stages` entries keyed by monitored swarm plus stage name.

Minimum fields per stage:

- `swarm`
- `stage`
- `phase`
- `enabled`
- `configured_every`
- `configured_every_ms`
- `last_run_at`
- `next_expected_at`
- `stale_after_ms`
- `age_ms`
- `stale`
- `recent_failed_jobs`
- `recent_backoff_limit_exceeded_jobs`
- `last_failure_class`
- `last_failure_reason`
- `data_confidence`
- `evidence_sources`

Critical behavior:

- stage staleness from `Swarm.status.freeze.evidence.stageStaleness` must flow into `stages` even if the recent
  workflow Job window is empty
- provider-capacity failures can continue to enrich stage evidence, but they no longer define whether execution truth
  exists
- `data_confidence=high` is not allowed when swarm CR status proves the stage is stale or frozen and the status route
  has not incorporated that evidence

### 3. Introduce explicit execution-trust semantics

The aggregated control-plane summary needs a new top-level execution-truth interpretation:

- `healthy`
  - remote controllers healthy
  - rollout healthy
  - database healthy
  - monitored swarms not frozen
  - no stage beyond staleness threshold
  - collaboration dependencies healthy enough for the active mission stage
- `degraded`
  - service reachable, but any monitored swarm is frozen, any stage is stale, Huly collaboration is degraded, or
    provider-capacity cooldowns are active
- `unknown`
  - status collection is incomplete or authoritative swarm/collaboration inputs cannot be read

This is intentionally stricter than current workflow-only degradation. A frozen monitored swarm must degrade the
control plane even if all workflow counters are zero.

### 4. Rebase `/ready` on execution truth and keep `/health` as liveness

Readiness contract:

- `/health`
  - process and minimal route liveness only
  - should not claim execution safety
- `/ready`
  - must consume the same execution-truth envelope as `/api/agents/control-plane/status`
  - should return `503` when:
    - any monitored autonomous swarm is frozen,
    - any critical stage is stale beyond policy,
    - authoritative swarm state is unreadable,
    - Huly collaboration is required for the stage and is unavailable,
    - execution-truth enforcement is enabled and trust is not `healthy`

This removes the current split where `/ready` is green because the web pod is reachable even while autonomous
execution is frozen.

### 5. Add Huly collaboration health and thread-awareness as first-class status

Introduce a `collaboration.huly` envelope that reflects whether the swarm can preserve thread-aware teammate
communication.

Minimum fields:

- `status`
- `workspace`
- `project`
- `teamspace`
- `channel`
- `worker_identity`
- `last_success_at`
- `last_error`
- `message`
- `thread_context_fresh`
- `latest_peer_message_id`
- `latest_peer_message_at`
- `latest_worker_reply_at`

Minimum behavior:

- worker-scoped account resolution, channel-history reads, and mission upserts become observable signals
- failures to resolve account identity or fetch recent channel history degrade collaboration health
- implementation and planning stages that require Huly handoff cannot be execution-trust `healthy` when collaboration
  is impaired
- status must preserve the last known good collaboration observation so operators can distinguish
  `unknown`, `degraded`, and recovered states

This does not make Huly a process liveness dependency. It makes Huly an explicit collaboration-trust dependency for
autonomous stages that promise human-thread continuity.

### 6. Preserve one operator story across surfaces

Required contract:

- Swarm CRs remain the source of record for swarm execution state.
- `/api/agents/control-plane/status` is the aggregated operator surface.
- `/ready` answers "is execution safe to trust right now?"
- `/health` answers "is this route serving at all?"
- Huly mission or thread updates must cite the same freeze, staleness, and collaboration taxonomy used in status.

This lets deployers, engineers, and Huly teammates discuss the same failure classes without custom interpretation.

## Alternatives considered

### Option A: keep extending workflow Job counters only

- Pros: smallest change to current status code.
- Cons: does not solve the live March 14 failure, because the monitored swarms are frozen from stale stage cadence,
  not from fresh scheduled Jobs inside the current workflow window.

### Option B: add a UI-only swarm dashboard

- Pros: operators could at least see freeze state in one place.
- Cons: leaves readiness, remote consumers, and Huly handoff logic blind. The core contract remains split.

### Option C: keep readiness local and use status route for operators only

- Pros: minimal rollout risk for probes.
- Cons: still allows web-pod readiness to imply safety while autonomous execution is frozen.

### Option D: selected, execution-truth envelope plus collaboration gate

- Pros: aligns swarm CR truth, status, readiness, and Huly handoff into one operator contract.
- Cons: requires additive status types, new tests, and careful rollout sequencing so probe behavior changes do not
  cause avoidable churn.

## Implementation slices

### Slice 1. Add additive swarm and stage status contracts

Required areas:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- shared types in `services/jangar/src/data/agents-control-plane.ts` if needed

Expected outcome:

- status route emits `swarms` and `stages`
- frozen and stale swarm truth degrades namespace and top-level status
- existing consumers remain backward-compatible because fields are additive

### Slice 2. Align `/ready` to execution truth

Required areas:

- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/routes/ready.test.ts`
- any small helper extracted from `control-plane-status.ts`

Expected outcome:

- `/ready` remains green only when execution truth is healthy
- `/health` remains compact and liveness-only
- split web/controller topology no longer creates green readiness during frozen swarm execution

### Slice 3. Add collaboration health for Huly-backed stages

Required areas:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/scripts/codex/lib/huly-api-client.ts`
- any supporting status helper or cache used for collaboration probes
- tests for degraded and recovered collaboration states

Expected outcome:

- Huly timeouts or identity mismatches appear in status
- mission stages that promise Huly continuity degrade when collaboration is not working
- operator and teammate updates use the same execution-trust vocabulary

## Validation gates

Engineer acceptance gates:

1. A frozen monitored swarm degrades `/api/agents/control-plane/status` even when `workflows.recent_failed_jobs=0`.
2. `swarms[].freeze.reason=StageStaleness` and `stages[].stale=true` appear when swarm CR status carries stale-stage
   evidence.
3. `/ready` returns `503` while a monitored autonomous swarm is frozen and returns `200` only after the freeze or
   staleness condition clears or an explicit override is used.
4. Status remains backward-compatible for existing consumers: new fields are additive and old keys still resolve.
5. Huly collaboration timeouts or expected-actor mismatches appear as degraded collaboration health and are not
   silently ignored.

Deployer acceptance gates:

1. `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents' | jq '.swarms, .stages'`
   returns populated execution-truth data for monitored swarms.
2. `curl -i -fsS 'http://agents.agents.svc.cluster.local/ready'` returns `503` during a reproduced frozen-swarm or
   stale-stage condition when execution-truth enforcement is enabled.
3. `curl -i -fsS 'http://agents.agents.svc.cluster.local/health'` remains `200` during the same window, proving
   liveness and readiness have distinct semantics.
4. Huly collaboration failures degrade execution trust but do not crash the web surface or controller workloads.

## Rollout plan

1. Land additive `swarms` and `stages` fields first with no readiness enforcement.
2. Validate the new status contract live against:
   - `kubectl get swarm -n agents -o yaml`
   - `kubectl get events -n agents --sort-by=.lastTimestamp`
   - current Huly probe results
3. Introduce `/ready` execution-truth enforcement behind an explicit feature flag or environment toggle.
4. Turn on Huly collaboration degradation in observe-only mode first, then enforce it for stages that require
   thread-aware handoff after live evidence is stable.
5. Promote readiness enforcement only after at least one full thawed swarm cycle and one Huly-reachable cycle are
   observed in production.

## Rollback plan

1. Disable `/ready` execution-truth enforcement first while leaving additive `swarms`, `stages`, and collaboration
   status visible.
2. If swarm or Huly reads prove too expensive or too failure-prone, downgrade their authority to `unknown` but keep
   the fields present so operators can still diagnose the blind spot.
3. Revert collaboration gating before removing collaboration observability.
4. Revert additive status fields only as a last resort.

Rollback principle:

- remove enforcement before removing visibility.

## Handoff

- Engineer
  - implement slices in order: additive swarm or stage status, readiness alignment, then Huly collaboration health
  - keep fields additive and preserve current consumers while tightening trust semantics
- Deployer
  - validate live swarm freeze state, readiness behavior, and Huly collaboration health after each slice
  - do not treat green liveness as sufficient evidence for autonomous execution safety once this contract is enabled
