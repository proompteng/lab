# Jangar Control Plane Provider Capacity Arbitration and Template-Run Truth (2026-03-14)

Status: Proposed

Docs index: [README](../README.md)

## Summary

As of 2026-03-14, live `torghut-swarm-discover-template`, `torghut-swarm-plan-template`, and
`torghut-swarm-verify-template` AgentRuns are failing within seconds on `gpt-5.3-codex-spark` usage-limit errors,
while the same control plane still runs `jangar-swarm-*` templates against the shared `codex-spark` provider.
Despite those failures, `GET /api/agents/control-plane/status?namespace=agents` reports:

- `workflows.recent_failed_jobs=0`
- `workflows.backoff_limit_exceeded_jobs=0`
- `workflows.data_confidence=high`
- `dependency_quorum.decision=allow`
- `database.status=healthy`

The current status contract therefore misses the exact failure mode the autonomous control plane needs to handle:
shared provider capacity exhaustion on direct template/manual AgentRuns that are not schedule-labeled workflow Jobs.
This design introduces two linked changes:

1. shared provider-capacity arbitration before Job creation, and
2. additive execution-truth coverage for template/manual/requirement AgentRuns in the control-plane status surface.

The goal is to stop burning Kubernetes Jobs on known-exhausted provider lanes and make operator status reflect real
execution pressure across all autonomous swarms, not only schedule-owned Jobs for `jangar-control-plane`.

## Relationship to prior designs

This proposal narrows the next implementation slice after:

- `docs/agents/designs/jangar-control-plane-stage-outcome-confidence-and-quota-resilience.md`
- `docs/agents/designs/jangar-control-plane-freeze-state-truth-and-provider-capacity-governor-2026-03-06.md`
- `docs/agents/designs/jangar-control-plane-capability-admission-failure-budgets-and-rollout-rings-2026-03-06.md`
- `docs/agents/designs/throughput-backpressure-quotas.md`

Those documents established the need for stage outcome confidence, failure budgeting, and provider cooldown behavior.
This document focuses on the live March 14 gap that remains unresolved:

- shared `codex-spark` provider lanes are still unarbitrated across swarms, and
- the primary status endpoint still treats template/manual AgentRun failures as invisible if they are not backed by a
  schedule-labeled Job that matches the narrow workflow selector.

## Assessment context

- Cluster scope: `agents` and `jangar` namespaces.
- Source scope:
  - `services/jangar/src/server/control-plane-status.ts`
  - `services/jangar/src/server/supporting-primitives-controller.ts`
  - `services/jangar/scripts/codex/codex-implement.ts`
  - `argocd/applications/agents/swarm-instances.yaml`
  - `argocd/applications/agents/codex-spark-agentprovider.yaml`
  - `argocd/applications/agents/values.yaml`
- Database scope: service-owned read-only health from `/api/agents/control-plane/status`; direct SQL remained blocked by
  the current service account.
- Evidence window: 2026-03-14 20:59 UTC through 2026-03-14 21:06 UTC.

## Live evidence

### Cluster evidence

- `kubectl get job -n agents torghut-swarm-discover-template-step-1-attempt-1 -o yaml` shows:
  - `agents.proompteng.ai/provider=codex-spark`
  - `CODEX_MODEL=gpt-5.3-codex-spark`
  - `CODEX_MODEL_FALLBACKS=gpt-5.4`
  - `backoffLimit: 0`
  - `status.failed: 1`
- `kubectl logs -n agents job/torghut-swarm-discover-template-step-1-attempt-1 --tail=200` includes:
  - `You've hit your usage limit for GPT-5.3-Codex-Spark.`
- The same provider-capacity failure appears in:
  - `job/torghut-swarm-plan-template-step-1-attempt-1`
  - `job/torghut-swarm-verify-template-step-1-attempt-1`
  - `job/codex-spark-smoke-step-1-attempt-1`
- `kubectl get agentrun -n agents` during the same window shows:
  - `torghut-swarm-discover-template`, `torghut-swarm-plan-template`, and `torghut-swarm-verify-template`
    `phase=Failed`
  - `jangar-swarm-discover-template`, `jangar-swarm-plan-template`, and `jangar-swarm-verify-template`
    still `phase=Running`
- `argocd/applications/agents/swarm-instances.yaml` defines both `jangar-control-plane` and `torghut-quant` with
  hourly `discover`, `plan`, `implement`, and `verify` cadences, but no provider-lane reservation or weight metadata.
- `argocd/applications/agents/codex-spark-agentprovider.yaml` configures one shared primary/fallback pair:
  - primary `gpt-5.3-codex-spark`
  - fallback `gpt-5.4`

### Status and readiness evidence

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` at
  `2026-03-14T21:05:00Z` returns:
  - `rollout_health.status=healthy`
  - `workflows.recent_failed_jobs=0`
  - `workflows.backoff_limit_exceeded_jobs=0`
  - `workflows.data_confidence=high`
  - `dependency_quorum.decision=allow`
  - `database.status=healthy`
  - `database.migration_consistency.registered_count=24`
  - `database.migration_consistency.applied_count=24`
- `curl http://agents.agents.svc.cluster.local/health` and `/ready` still return local `agentsController.enabled=false`
  and `started=false`, while the status endpoint promotes controller health from rollout-derived authority. That split is
  now intentional for topology awareness, but it also means operator trust depends heavily on the correctness of the
  higher-level status envelope.
- `kubectl get swarm -n agents -o yaml` still shows `jangar-control-plane status.updatedAt=2026-03-11T15:48:11Z`
  and `phase=Frozen` from an earlier stale-stage event, even though fresh March 14 template AgentRuns are being
  created. Swarm status is therefore not a sufficient source of current template-run truth.

### Source evidence

- `services/jangar/src/server/control-plane-status.ts`
  - `DEFAULT_WORKFLOWS_SWARMS = ['jangar-control-plane']`
  - `resolveWorkflowsReliabilityStatus(...)` filters Job reads with:
    - `schedules.proompteng.ai/schedule`
    - `swarm.proompteng.ai/name in (...)`
  - direct template/manual AgentRun Jobs such as `torghut-swarm-discover-template-step-1-attempt-1` are therefore out
    of scope for current workflow reliability.
- `buildDependencyQuorum(...)` relies on that narrow workflow reliability payload, so the control plane returns
  `allow` when schedule-labeled counters stay at zero even though live template runs are failing.
- `services/jangar/src/server/supporting-primitives-controller.ts` still computes freeze evidence from
  `implementRuns` only when counting consecutive failures. Non-implement stages and direct template/manual AgentRuns do
  not feed the current freeze trigger.
- `services/jangar/scripts/codex/codex-implement.ts` already detects quota/rate-limit/provider-capacity failures and
  supports runtime fallback. That fallback is useful, but it happens after a Kubernetes Job and pod already exist.
- `argocd/applications/agents/values.yaml` defines controller concurrency and queue limits per agent/repo, but not per
  provider lane, per model, or per swarm reservation class.

### Database and data evidence

- The current problem is not database drift:
  - `database.status=healthy`
  - `migration_consistency.status=healthy`
  - `registered_count=24`
  - `applied_count=24`
  - `latency_ms=12`
- Direct SQL verification from this workload is blocked by RBAC:
  - `kubectl cnpg psql -n jangar jangar-db -- ...` fails because `pods/exec` is forbidden for
    `system:serviceaccount:agents:agents-sa`.
- Because controllers run in split topology and can scale independently, any provider-capacity governor needs durable
  shared state, not an in-memory per-pod map.

## Problem statement

The live failure mode on 2026-03-14 exposes four gaps:

1. Shared provider capacity is global, but admission is still effectively local.
   - Two autonomous swarms compete for the same `codex-spark` lane with no reservation, fairness, or cooldown policy.
2. Template/manual AgentRuns are outside the current workflow truth surface.
   - Operator status stays healthy even while direct template runs fail.
3. Runtime fallback is too late in the control path.
   - The cluster still creates a Job, starts a pod, and records a failed run before fallback or retry logic can help.
4. Current freeze and dependency signals still overfit scheduled or implement-stage evidence.
   - They do not model cross-swarm provider starvation or template-run exhaustion as first-class control-plane state.

The result is avoidable churn:

- repeated failed Jobs for known-exhausted provider lanes,
- no protected capacity for critical platform work,
- misleading `allow` decisions from dependency quorum,
- and a growing mismatch between real swarm pressure and operator-facing status.

## Decision

Adopt shared provider-capacity arbitration and template-run truth as one control-plane contract.

The control plane must decide whether a provider lane is available before creating a Job, and it must expose capacity
pressure across scheduled, template, manual, and requirement-driven AgentRuns in the same status surface operators use
for readiness and rollout decisions.

## Selected architecture

### 1. Provider lane inventory and durable state

Define a lane key that reflects the actual scarce resource:

- `provider`
- `requested model`
- `reasoning profile`
- `runtime class`

Example lane:

- `codex-spark / gpt-5.3-codex-spark / xhigh / workflow`

Persist lane state in a durable store owned by the control plane. A database table is the preferred source of truth
because:

- controllers already use Postgres-backed state,
- split-topology controller replicas need one arbitration record,
- and cooldown windows must survive pod restarts.

Minimum state per lane:

- `lane_key`
- `total_slots`
- `reserved_slots_by_swarm`
- `borrowed_slots`
- `queued_requests`
- `cooldown_until`
- `last_failure_class`
- `last_failure_reason`
- `last_model_used`
- `last_fallback_used`
- `updated_at`

This table does not replace Job history. It records the arbitration state that Job history cannot express cleanly.

### 2. Unified admission for all autonomous AgentRuns

Every autonomous AgentRun that can launch Codex work must use the same admission decision path before Job creation:

- swarm schedules
- direct template runs
- manual control-plane runs
- requirement-dispatched runs
- smoke runs

Admission result:

- `allow`
  - lane capacity is available; create the Job and reserve the slot.
- `delay`
  - no slot is available yet; do not create a Job; record `next_retry_at`.
- `reroute`
  - the primary lane is cooling down; stamp the next compatible lane into the run payload before Job creation.
- `block`
  - no compatible lane or invalid policy; do not create a Job.

This is the key design change. Capacity exhaustion must become a scheduling decision, not a post-failure discovery
inside a Job log.

### 3. Per-swarm reservations and fairness

Add explicit per-swarm provider-capacity policy so shared lanes stop behaving as first-come, first-served global
resources.

Proposed policy fields:

- `reservedSlots`
- `maxBorrowedSlots`
- `priority`
- `fallbackPolicyRef`
- `degradeAfterDelays`
- `cooldownClassOverrides`

Recommended initial behavior:

- reserve at least one protected platform lane for `jangar-control-plane` architect/engineer work,
- allow `torghut-quant` to borrow unused capacity up to a bounded ceiling,
- and expire borrowed capacity automatically if the owner swarm becomes runnable again.

This does not require hard-coded product exceptions in code. It requires explicit policy in GitOps so platform and
trading teams can reason about the same rules.

### 4. Status truth for non-schedule execution

Keep the existing status endpoint, but make it tell the whole story.

Additive status sections:

- `provider_capacity`
  - `status`
  - `active_cooldowns`
  - `lanes`
  - `queued_delays`
  - `reservation_pressure`
  - `recent_capacity_failures`
- `execution`
  - `scheduled_runs`
  - `template_runs`
  - `manual_runs`
  - `requirement_runs`
  - `recent_failed_runs`
  - `top_failure_reasons`
  - `data_confidence`

`workflows` can remain for backward compatibility, but it should either:

- become a subset under the broader `execution` section, or
- be documented as `scheduled_workflows` while the new section covers direct template/manual truth.

Required status semantics:

- `healthy`
  - critical lanes have capacity or approved fallback.
- `degraded`
  - monitored swarms are delayed, cooling down, or consuming borrowed capacity at risk.
- `unknown`
  - lane or execution collection is incomplete.

Healthy-zero behavior is not allowed when direct template runs are failing in the same observation window.

### 5. Integration with runtime fallback

`services/jangar/scripts/codex/codex-implement.ts` already supports runtime fallback and already records:

- `modelRequested`
- `modelUsed`
- `fallbackUsed`
- `fallbackReason`

Keep that logic as the last-mile retry inside a running session, but move fallback selection policy to admission:

- admission chooses the preferred primary or fallback lane,
- runner executes that plan and reports what actually happened,
- controller reconciles the observed outcome back into lane state.

This avoids a split-brain fallback policy where admission assumes one lane and runtime invents another.

### 6. Readiness and rollout impact

`/ready` and deploy-time rollout checks must degrade when:

- all compatible lanes for a monitored swarm are cooling down,
- reserved platform capacity is exhausted by borrowers,
- or execution truth shows delayed/rerouted saturation beyond configured thresholds.

Rollout promotion must not depend only on deployment replica health when the promoted runtime cannot actually obtain a
provider lane.

## Alternatives considered

### Option A: Keep current per-agent/per-repo controller limits only

- Pros: smallest change.
- Cons: does not model provider/model scarcity and does not protect one swarm from another.

### Option B: Rely on runtime fallback only

- Pros: reuses existing `codex-implement.ts` behavior.
- Cons: capacity exhaustion is still discovered after Job creation, which is too late.

### Option C: Static cadence staggering only

- Pros: no new state store.
- Cons: reduces collision probability but does not solve burst traffic, smoke runs, manual runs, or cooldown windows.

### Option D: Dedicated provider per swarm

- Pros: strongest isolation.
- Cons: expensive, less flexible, and unnecessary if shared-lane arbitration works.

### Option E: Selected, shared capacity arbitration plus template-run truth

- Pros: addresses the exact live failure mode while preserving shared provider efficiency.
- Cons: requires a durable state model and additive status work.

## Implementation scope

Primary code/config surfaces:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/data/agents-control-plane.ts`
- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/server/agents-controller/**`
- `services/jangar/scripts/codex/codex-implement.ts`
- `argocd/applications/agents/swarm-instances.yaml`
- `argocd/applications/agents/codex-spark-agentprovider.yaml`
- `argocd/applications/agents/values.yaml`

New or extended contracts:

- provider-lane arbitration state
- per-swarm reservation policy
- execution-truth schema for template/manual AgentRuns
- readiness and dependency-quorum integration

Non-goals for this slice:

- changing the model provider itself,
- removing runtime fallback from `codex-implement.ts`,
- or redesigning the entire swarm CRD surface.

## Engineer acceptance gates

1. A quota-exhausted direct template AgentRun no longer creates a fresh failed Job when the lane is already cooling
   down.
2. `jangar-control-plane` can retain reserved capacity during `torghut-quant` bursts according to explicit policy.
3. `/api/agents/control-plane/status?namespace=agents` reports template/manual failure truth within one polling window.
4. `dependency_quorum` returns `delay` or `block` when no compatible lane is available, even if schedule-only counters
   remain zero.
5. Regression tests cover:
   - template-run telemetry inclusion,
   - provider-lane cooldowns,
   - reservation borrowing and reclaim,
   - reroute-before-Job behavior,
   - and bounded status output.

## Deployer acceptance gates

1. GitOps config defines provider-capacity reservations and fallback policy explicitly for each monitored swarm.
2. Report-only mode is enabled first, and status evidence is compared against live Jobs before enforcement begins.
3. A canary drill forces one `provider_capacity_exhausted` event and proves:
   - `torghut-quant` is delayed or rerouted without a failed Job loop,
   - `jangar-control-plane` still dispatches against its reserved lane,
   - and status shows the same cooldown truth operators saw in the drill.
4. Rollback can disable enforcement without deleting the additive status sections.

## Validation plan

Implementation validation:

- unit tests for arbitration policy, delay/reroute decisions, and reservation accounting
- status contract tests for template/manual inclusion
- integration tests for admission-before-Job creation

Read-only cluster validation after rollout:

- compare `provider_capacity` and `execution.template_runs` counters against:
  - `kubectl get job -n agents`
  - `kubectl get agentrun -n agents`
  - sampled Job logs for provider-capacity messages

Operational validation:

- confirm a synthetic quota event produces `delay` or `reroute` before another Job is created
- confirm reservation reclaim when the owner swarm becomes runnable

## Rollout plan

1. Add status-only telemetry for template/manual runs and provider lanes.
2. Land the durable lane-state store in report-only mode.
3. Enable arbitration for `discover` and `plan` template runs first.
4. Add explicit reservations for `jangar-control-plane` and `torghut-quant`.
5. Expand enforcement to `implement`, `verify`, smoke, and requirement-driven runs after canary proof.
6. Make readiness and rollout promotion depend on lane truth only after the report-only phase stays stable.

## Rollback plan

1. Disable arbitration enforcement first and return to report-only mode.
2. Preserve additive `provider_capacity` and `execution` status sections for diagnosis.
3. Remove per-swarm reservation policy only if it proves destabilizing.
4. Revert readiness gating last, after enforcement is already off.

Rollback should prefer disabling policy over deleting observability.

## Risks and mitigations

- Risk: reservations are too strict and strand idle capacity.
  - Mitigation: bounded borrowing with expiry and report-only calibration first.
- Risk: arbitration state becomes stale after controller restart.
  - Mitigation: durable store with lease expiry and reconcile-on-start.
- Risk: additive status payload grows too much.
  - Mitigation: bounded lane lists, capped failure reasons, and explicit sampling limits.
- Risk: runtime fallback and admission reroute disagree.
  - Mitigation: admission owns policy, runner reports execution, controller reconciles both.

## Handoff guidance

- Engineer: implement status truth before enforcement so operators can compare old and new views side by side.
- Deployer: do not enable reservation enforcement until a forced quota drill proves protected platform capacity and
  accurate status reporting in the same rollout window.
