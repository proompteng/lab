# Jangar Control-Plane Freeze-State Truth and Provider Capacity Governor (2026-03-06)

Status: Proposed

## Summary

As of 2026-03-06 09:16Z, the live `jangar-control-plane` swarm is `Frozen` and `Ready=False` because consecutive
stage runs are failing on provider quota, yet the main operator status surface still reports
`workflows.data_confidence=high`, `rollout_health.status=healthy`, and local controllers as merely `disabled`.
This design closes that execution-truth gap by making freeze state, stage failure classes, and provider-capacity
cooldowns first-class control-plane signals that feed status, readiness, scheduling, and rollout decisions together.

## Relationship to prior designs

This is a follow-on to:

- `docs/agents/designs/jangar-control-plane-stage-outcome-confidence-and-quota-resilience.md`
- `docs/agents/designs/jangar-control-plane-capability-admission-failure-budgets-and-rollout-rings-2026-03-06.md`
- `docs/agents/designs/jangar-control-plane-admission-quorum-and-rollout-circuit-breaker-2026-03-06.md`

Those documents established the need for outcome confidence, admission, and rollout rings. This document narrows the
next implementation slice to the live failure mode now present in-cluster: quota-driven stage failures can freeze the
swarm while the operator-facing status contract still looks healthy enough to keep trust high.

## Assessment context

- Cluster scope: `agents` and `jangar` namespaces on 2026-03-06.
- Source scope: `services/jangar/**`, `argocd/applications/agents/**`.
- Database scope: service-owned status checks through `/api/agents/control-plane/status`; direct SQL remained blocked
  by service-account RBAC.
- Evidence capture window: 2026-03-06 08:39Z through 2026-03-06 09:16Z.

## Live evidence

### Cluster evidence

- `kubectl get swarm,agentrun -n agents` shows `swarm/jangar-control-plane` in `phase=Frozen`, `Ready=False`, with
  `reason=ConsecutiveFailures` and `message=swarm frozen until 2026-03-06T10:10:15.399Z`.
- `kubectl get pods -n agents` shows repeated failing `jangar-control-plane-discover-*`, `plan-*`, `implement-*`, and
  `verify-*` pods across the same window, not an isolated single-stage failure.
- `kubectl logs -n agents jangar-control-plane-plan-sched-x6w98-step-1-attempt-1-25mfw` fails with a
  provider-capacity error: "You've hit your usage limit for GPT-5.3-Codex-Spark. Switch to another model now, or try
  again at Mar 8th, 2026 7:29 AM."
- `kubectl logs -n agents jangar-control-plane-verify-sched-gpw64-step-1-attempt-1-5kkkh` fails with the same
  provider-capacity message.
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -n 120` shows fresh
  `BackoffLimitExceeded` for `codex-spark-smoke`, `jangar-control-plane-discover-*`, `jangar-control-plane-implement-*`,
  and `jangar-control-plane-verify-*` jobs while the swarm remains frozen.
- `kubectl get events -n jangar --sort-by=.lastTimestamp | tail -n 120` shows concurrent rollout noise:
  readiness probe connection-refused events and `FailedAttachVolume` multi-attach errors for `jangar` and
  `jangar-worker`.

### Status and readiness evidence

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` returns:
  - `database.status=healthy` with `latency_ms=6` and migration parity (`registered_count=21`, `applied_count=21`)
  - `workflows.recent_failed_jobs=0`
  - `workflows.backoff_limit_exceeded_jobs=0`
  - `workflows.data_confidence=high`
  - `rollout_health.status=healthy`
  - `stages=null`
  - `swarms=null`
- `curl http://agents.agents.svc.cluster.local/health` and `/ready` both return `status=ok` while reporting:
  - `agentsController.enabled=false`
  - `agentsController.started=false`
  - `supportingController.enabled=false`
  - `orchestrationController.enabled=false`
- The remote `agents-controllers` deployment is healthy in Kubernetes at the same time, so the service-local health
  contract and the real execution topology are split.

### Source evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` computes `implementRuns` and uses only those runs as
  the consecutive-failure input for swarm freeze decisions; discover, plan, verify, and requirement-driven failures are
  not part of that trigger set.
- The same controller writes freeze state into swarm status, but that information is not surfaced through
  `/api/agents/control-plane/status`.
- `services/jangar/src/server/control-plane-status.ts` derives runtime-adapter and controller health from the local
  service process, so deployed controller replicas show up as `disabled` whenever controllers are topology-split into a
  separate deployment.
- `services/jangar/src/server/control-plane-status.ts` reports workflow reliability from Kubernetes Job reads, but the
  current payload has no swarm-freeze object and no per-stage counters tied to the frozen swarm that operators actually
  care about.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts` already enforces data-confidence degradation when
  workflow collection fails, but it does not enforce degraded status when the monitored swarm itself is frozen.

### Database and data evidence

- The database is healthy and migrations are fully applied according to the service-owned status contract.
- The current problem is therefore not schema drift. It is that execution truth does not include swarm freeze state,
  provider-capacity cooldowns, or remote controller topology.
- Direct SQL verification remains blocked for this service account, so the chosen design must keep using additive,
  API-visible evidence instead of relying on privileged database reads.

## Problem statement

Jangar currently has a control-plane truth gap in exactly the failure mode autonomous operation needs most:

1. the swarm can be frozen by repeated stage failures,
2. the failing reason can be provider quota or capacity exhaustion rather than code or cluster correctness,
3. the status and readiness surfaces can still look healthy or merely locally disabled, and
4. rollout health can ignore the frozen execution path and recent stage failure window.

This causes two operational errors:

- engineers and deployers cannot tell whether a green status surface means "execution healthy" or only "service
  process reachable", and
- the scheduler keeps discovering quota problems by burning Job attempts instead of cooling down or rerouting before
  more failures accumulate.

## Decision

Adopt a freeze-state truth contract with a provider-capacity governor.

The control plane must treat frozen swarm state and quota-driven stage failure windows as first-class status and
readiness inputs, not as secondary evidence visible only in swarm CRs and pod logs.

## Selected architecture

### 1. Stage-wide freeze accounting

Replace implement-only freeze input with a stage-wide failure window that covers:

- `discover`
- `plan`
- `implement`
- `verify`
- requirement-dispatched runs linked to the same swarm

Each recorded run contributes:

- `stage`
- `result`
- `failure_class`
- `failure_reason`
- `provider_lane`
- `finished_at`

Required failure classes:

- `provider_capacity_exhausted`
- `provider_rate_limited`
- `provider_capability_invalid`
- `metadata_invalid`
- `cluster_infra`
- `runtime_unknown`

Freeze activation must be derived from policy, not a hard-coded stage subset. Default policy:

- `provider_capacity_exhausted` and `provider_rate_limited` trigger cooldown before freeze when a compatible fallback
  exists.
- `provider_capability_invalid` and `metadata_invalid` can block the affected lane immediately.
- `cluster_infra` retries within the configured backoff window and contributes to freeze only after threshold.

### 2. Provider-capacity governor

Add a governor layer between recent-failure evidence and fresh dispatch:

- if the same provider/model lane is quota-exhausted, mark the lane cooling down,
- delay new jobs for that lane without consuming another Job attempt,
- route to a compatible fallback lane when the capability registry allows it,
- expose the active cooldown, next eligible retry time, and fallback selection in status.

This changes current behavior from "spawn another Job and learn quota is still exhausted" to "cool down, reroute, or
block before scheduling."

### 3. Freeze-state truth in control-plane status

Extend `/api/agents/control-plane/status` with additive `swarms` and `stages` sections for monitored swarms.

Minimum swarm fields:

- `name`
- `phase`
- `ready`
- `freeze.active`
- `freeze.reason`
- `freeze.until`
- `freeze.entered_at`
- `freeze.triggering_runs`
- `active_cooldowns`

Minimum stage fields:

- `stage`
- `phase`
- `recent_failed_runs`
- `recent_backoff_limit_exceeded_runs`
- `top_failure_reasons`
- `top_failure_classes`
- `provider_lanes`
- `data_confidence`

Status semantics:

- `healthy`: service path, remote controllers, rollout ring, and monitored swarm execution are all healthy.
- `degraded`: service is reachable, but any monitored swarm is frozen, cooling down, or experiencing a stage failure
  burst.
- `unknown`: status collection is incomplete.

Healthy-zero behavior is no longer allowed for a frozen monitored swarm.

### 4. Readiness and rollout gates

`/health` may remain a liveness-oriented endpoint, but `/ready` and rollout promotion gates must include:

- remote controller deployment health, not only service-local controller wiring,
- monitored swarm freeze state,
- active provider-capacity cooldowns for critical autonomous lanes,
- recent stage failure windows for discover/plan/implement/verify,
- current rollout instability signals already tracked in Kubernetes events and deployment state.

Required rollout rule:

- control-plane rollout is not promotion-ready while a monitored lights-out swarm is frozen unless the frozen state is
  explicitly classified as an allowed external-capacity cooldown and a compatible fallback lane is serving the same
  objective.

### 5. Operator contract and handoff behavior

The design should keep one clear operator story across surfaces:

- swarm CR status remains the source of record for freeze state,
- `/api/agents/control-plane/status` becomes the aggregated operator surface,
- `/ready` reflects whether execution is safe to trust,
- Huly/PR handoff text can cite the same freeze and cooldown taxonomy without custom interpretation.

## Alternatives considered

### Option A: Keep freeze logic on implement runs only and improve dashboards

- Pros: smallest code change.
- Cons: does not match current failure mode, because the swarm is already frozen by plan/verify quota pressure while
  status looks healthy.

### Option B: Add only provider fallback

- Pros: reduces repeated quota failures when fallback is available.
- Cons: still leaves swarm freeze invisible in operator status and readiness surfaces.

### Option C: Selected, freeze-state truth plus provider-capacity governor

- Pros: aligns scheduling, status, readiness, and rollout behavior with current cluster truth.
- Cons: requires additive contract work across controller, status, and readiness surfaces.

## Implementation gates

Engineer acceptance gates:

1. A monitored swarm frozen by plan, discover, verify, or requirement-driven failures appears degraded in
   `/api/agents/control-plane/status` even if service-local controllers are disabled.
2. Provider-capacity failures are classified as `provider_capacity_exhausted` and create a cooldown before another Job
   is created for the same lane.
3. Compatible fallback lanes are selected before re-dispatch when capability policy allows them.
4. `/ready` returns a degraded reason when the remote controller deployment is healthy but a monitored swarm is frozen
   or blocked.
5. New status fields are additive and bounded, with regression coverage for:
   - frozen swarm visibility
   - stage-wide failure accounting
   - provider-capacity cooldown exposure
   - remote-controller-versus-local-controller topology split

Deployer acceptance gates:

1. GitOps rollout validation shows the new swarm and stage sections populated for `jangar-control-plane`.
2. A synthetic provider-capacity failure causes cooldown or fallback instead of another immediate `BackoffLimitExceeded`
   Job.
3. Promotion halts when a monitored lights-out swarm remains frozen without an approved fallback lane.
4. Rollback restores prior readiness behavior and removes enforcement before removing additive observability fields.

## Implementation scope

Primary source areas:

- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/routes/health.tsx`
- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`
- `services/jangar/scripts/codex/**`
- provider configuration under `argocd/applications/agents/**`

## Rollout plan

1. Ship additive swarm and stage status fields first.
2. Turn on remote-controller and frozen-swarm degradation in `/ready` after one release of additive status visibility.
3. Enable provider-capacity cooldown for `discover` and `plan` before extending it to `implement`, `verify`, and
   requirement-driven runs.
4. Make rollout promotion depend on freeze-state truth only after fallback lanes and cooldown telemetry are proven
   stable in-cluster.

## Rollback plan

1. Disable provider-capacity cooldown enforcement and fallback routing first.
2. Remove readiness and rollout enforcement while preserving additive freeze-state and stage evidence in status.
3. Revert stage-wide freeze accounting only if it causes unacceptable false positives after thresholds are tuned.

Rollback priority is enforcement first, observability last.

## Handoff guidance

- Engineer: implement status visibility before enforcement so deployers can compare new freeze-state truth against live
  swarm CRs and Job history.
- Deployer: verify rollout on a window that includes one forced provider-capacity failure and one clean fallback path;
  do not treat pod readiness alone as proof of control-plane readiness.
