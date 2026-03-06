# Jangar Control Plane Capability Admission, Failure Budgets, and Rollout Rings (2026-03-06)

Status: Proposed

## Summary

The current `jangar-control-plane` operating model admits work that is already known to be incompatible with the
selected provider/model contract, then discovers the incompatibility only after an `AgentRun` is launched. At the
same time, schedule liveness, controller health, and rollout health are still split across separate surfaces, so the
cluster can look `Ready` while the real execution path is burning through retries and quota. This design introduces a
single operating contract built on capability admission, stage-specific failure budgets, and rollout rings so the
control plane rejects known-bad work before launch, degrades safely under provider pressure, and rolls out only when
the service, controllers, and runner lanes are all proven healthy.

## Assessment context

- Cluster scope: `agents` and adjacent `jangar` namespaces on March 6, 2026.
- Source scope: `services/jangar/**`, `charts/agents/**`, `argocd/applications/agents/**`.
- Database scope: service-owned status checks for the control-plane database plus read-only cluster evidence where
  direct SQL was blocked by RBAC.

## Evidence

### Cluster evidence

- `kubectl get swarm,agentrun -n agents` shows both `jangar-control-plane` and `torghut-quant` swarms `Ready=True`,
  while the recent history is dominated by failed `jangar-control-plane-discover-*`, `plan-*`, `verify-*`, and
  requirement-driven `implement-*` runs.
- Recent logs from `pod/jangar-control-plane-plan-sched-6wfn5-step-1-attempt-1-rhw2t` failed with
  `Quota exceeded. Check your plan and billing details.` The cluster keeps scheduling fresh runs despite that failure
  class being external-capacity, not transient kube noise.
- Recent logs from `pod/codex-spark-smoke-manual-5-step-1-attempt-1-p9n6v` failed with
  `Unsupported value: 'xhigh' is not supported ... Supported values are: 'low', 'medium', and 'high'.`
- `curl http://${AGENTS_SERVICE_HOST}/health` returns `agentsController.enabled=false` and
  `agentsController.started=false`, even while `kubectl get pods -n agents` shows active `agents-controllers-*` pods.
  The operator read path for the control plane is therefore topology-split.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` shows recent rollout churn with
  `FailedAttachVolume` multi-attach errors and readiness probe connection-refused events during `jangar` and
  `jangar-worker` promotion.

### Source evidence

- `charts/agents/templates/deployment.yaml` disables controller workloads inside the service deployment when
  `.Values.controllers.enabled=true`, while `charts/agents/templates/deployment-controllers.yaml` starts the actual
  controller deployment. This split is intentional, but it means service-local health no longer represents full
  control-plane health.
- `services/jangar/src/routes/health.tsx` returns `agentsController` status from the service process only, which is
  `disabled` in the current topology.
- `services/jangar/src/server/control-plane-status.ts` similarly builds controller status from local env/health
  sources rather than from the controller deployment that is actually reconciling `AgentRun`s.
- `argocd/applications/agents/torghut-market-context-agentprovider.yaml` hard-codes
  `model_reasoning_effort = "xhigh"` for `model = "gpt-5.4"`, matching the live smoke failure above.
- `services/jangar/scripts/codex/__tests__/codex-implement.test.ts` already proves the runtime can fall back to a
  secondary model on transient quota/rate-limit failures, but the cluster configuration is not enforcing a compatible
  fallback chain before launch.

### Database and data evidence

- `curl http://${AGENTS_SERVICE_HOST}/api/agents/control-plane/status?namespace=agents` reports the control-plane DB
  as healthy with `registered_count=21`, `applied_count=21`, no unexpected migrations, and latency around `56ms`.
- Direct SQL verification from this workload was blocked by RBAC: `kubectl cnpg psql` and CNPG cluster reads are
  forbidden for `system:serviceaccount:agents:agents-sa`.
- The current operating gap is therefore not schema drift; it is that database health is not yet part of a complete
  rollout and admission decision for the whole control plane.

## Problem statement

The control plane currently has three distinct failure classes with no unified contract:

1. Capability failures: invalid provider/model combinations, unsupported flags, missing fallback chains.
2. Capacity failures: quota exhaustion, rate limits, or external provider pressure that should burn budget and trigger
   lane degradation, not endless retries.
3. Rollout topology failures: service pods, controller pods, and runner pods can each be healthy or unhealthy
   independently, but there is no single promotion gate that understands all three.

Because these classes are separate, the system can look healthy from one surface while actively failing from another.
That increases incident duration, wastes cluster capacity, and makes autonomous stages unsafe to trust.

## Decision

Adopt a three-part operating contract:

1. Capability admission before launch.
2. Failure-budgeted execution lanes during runtime.
3. Rollout rings for promotion and rollback.

This is the smallest design that addresses the real failure modes without requiring a full rewrite of the controller
stack.

## Chosen design

### 1. Capability admission registry

Add a declarative capability registry for every agent-provider lane used by autonomous schedules and requirement runs.
For each provider/model pairing, store:

- supported reasoning efforts and verbosity values,
- supported session-resume behavior,
- fallback chain and failure classes that are allowed to trigger fallback,
- quota class and concurrency ceiling,
- validation schema version for generated config files.

Admission happens in two places:

- CI and GitOps validation: reject manifests or provider files that declare unsupported settings.
- Runtime admission: before creating the execution workload, Jangar validates the resolved provider config against the
  capability registry and fails fast with `ConfigInvalid`, not `BackoffLimitExceeded`.

This closes the `xhigh`-for-`gpt-5.4` class of failures before a job is even spawned.

### 2. Failure-budgeted execution lanes

Extend stage management beyond liveness/freshness and treat each lane (`discover`, `plan`, `implement`, `verify`,
plus requirement-driven runs) as a budgeted queue with explicit error classes:

- `config_invalid`
- `provider_quota`
- `provider_rate_limit`
- `auth_failure`
- `cluster_infra`
- `unknown`

Each lane receives:

- a rolling failure budget,
- an automatic degrade action when a budget is exhausted,
- a freeze action only after the degrade action is consumed or the error class is non-recoverable.

Examples:

- `provider_quota` burns the provider budget first, then reroutes to the next compatible fallback lane if one exists.
- `config_invalid` does not retry and instead blocks the lane until config is corrected.
- `cluster_infra` retries within a bounded backoff window but does not poison provider capacity metrics.

This changes control-plane behavior from "retry until job history proves the problem is real" to "classify, budget,
and degrade immediately."

### 3. Rollout rings

Promotions and rollbacks must happen in ordered rings:

1. Service ring: control-plane API pod(s), DB health, and cache/status routes.
2. Controller ring: `agents-controllers` deployment, leader election, CRD readiness, reconciliation smoke.
3. Runner ring: one promoted-image smoke run plus one representative provider bootstrap run.

Each ring produces an explicit gate result that must be visible in `/health`, `/ready`, and
`/api/agents/control-plane/status`.

Required gate inputs:

- database consistency and latency,
- controller deployment health from the actual controllers deployment,
- one capability-validation smoke for every promoted autonomous provider family,
- rollout-specific infrastructure checks for PVC attachability and node placement where workloads rely on RWO volumes.

Promotion is not complete until all three rings pass. Rollback happens ring-by-ring in reverse order.

### 4. Unified status contract

The existing status endpoint remains the main operator surface, but it must now publish:

- local service ring health,
- remote controller ring health,
- active capability-registry version,
- per-lane failure-budget consumption,
- selected degrade action,
- current rollout ring gate state.

`/health` and `/ready` stay intentionally compact, but they should link their degraded reason to the same ring and
budget taxonomy so service health no longer contradicts controller reality.

## Alternatives considered

### Alternative A: Keep the current model and patch provider configs ad hoc

- Pros: lowest immediate implementation cost.
- Cons: repeated rediscovery of the same failure classes; no systemic rollout safety improvement.

### Alternative B: Add only better status fields

- Pros: faster operator diagnosis.
- Cons: still admits known-bad work and still burns quota or cluster capacity before detection.

### Alternative C: Add fallback chains only

- Pros: directly improves continuity during provider pressure.
- Cons: does nothing for invalid config or rollout split-brain; can hide bad config behind fallback churn.

### Alternative D: Capability admission + failure budgets + rollout rings (selected)

- Pros: addresses config, capacity, and promotion safety together; provides explicit engineer and deployer contracts.
- Cons: requires contract work across CI, controller status, and GitOps validation.

## Implementation scope

### Required source areas

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/routes/health.tsx`
- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/server/agents-controller/**`
- `services/jangar/scripts/codex/**`
- `charts/agents/templates/deployment.yaml`
- `charts/agents/templates/deployment-controllers.yaml`
- `argocd/applications/agents/values.yaml`
- provider manifests under `argocd/applications/agents/**`

### Required new contracts

- capability registry schema and validation rules,
- error-class taxonomy for lane budgets,
- rollout ring result schema,
- CI/GitOps validation for provider config compatibility.

### Non-goals

- Replacing the current controller architecture.
- Replacing CronJob-based scheduling in this phase.
- Solving every Jangar UI rollout problem outside the control-plane contract.

## Validation plan

Engineer acceptance gates:

1. A provider manifest with unsupported reasoning settings is rejected before job launch.
2. Quota/rate-limit failures decrement the correct budget and trigger compatible fallback when configured.
3. `config_invalid` failures do not retry and produce explicit blocked status.
4. `/api/agents/control-plane/status` distinguishes service ring health from controller ring health.
5. One promoted-image smoke run and one provider bootstrap run are mandatory before rollout is considered healthy.

Deployer acceptance gates:

1. GitOps render validates capability registry and provider compatibility.
2. Post-sync smoke proves all three rollout rings green.
3. If controller ring fails after service ring passes, rollout halts without promoting runner traffic.
4. Rollback returns the previous capability registry version and clears any new lane budget policies.

Suggested checks:

- `bun run --filter services/jangar lint`
- `bun run --filter services/jangar test -- services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `bun run --filter services/jangar test -- services/jangar/scripts/codex/__tests__/codex-implement.test.ts`
- `mise exec helm@3 -- kustomize build --enable-helm argocd/applications/agents >/tmp/agents.yaml`

## Rollout plan

1. Land capability registry validation in CI first, with warning mode for one release.
2. Add runtime admission checks and lane-budget reporting in additive mode.
3. Turn on fallback + degrade actions for `discover` and `plan` before `implement` and requirement-driven runs.
4. Require rollout-ring gates for the `agents` GitOps app once smoke coverage is proven stable.

## Rollback plan

1. Disable capability admission enforcement while leaving observability fields in place.
2. Revert lane budgets to report-only mode.
3. Drop rollout-ring enforcement and return to the prior service/controller split if promotion stability regresses.

Rollback must preserve the new status fields as additive diagnostics whenever possible; only enforcement should be
removed first.

## Risks

- Capability metadata can drift from provider runtime behavior if not validated in CI and smoke tests.
- Failure budgets that are too strict can freeze useful work; initial thresholds must be conservative.
- Rollout rings increase promotion ceremony and will surface latent dependencies that are currently implicit.

## Handoff contract

Engineer:

- Implement capability registry, lane budgets, and rollout-ring status in that order.
- Keep all new API fields additive.
- Add regression tests for invalid provider configs, quota fallback, and controller/service health divergence.

Deployer:

- Treat capability-registry validation failures as rollout blockers.
- Require a passing runner-ring smoke before declaring the control plane healthy.
- Watch for PVC attach and node-placement issues during ring promotion; rollback runner ring first if attachability is
  unstable.
