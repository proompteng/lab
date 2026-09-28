# Jangar Control Plane Admission Quorum and Rollout Circuit Breaker (2026-03-06)

Status: Proposed

## Summary

Jangar currently detects some runtime failures only after a stage Job has already been created, and the primary
control-plane health surface still overweights current replica counts versus recent crash-loop, probe-failure, and
preflight-failure history. The result is avoidable churn: stage runs burn retry budget on configuration or provider
errors that were knowable in advance, while rollout health can look green during a short-lived recovery window.

This design adds two system-level controls:

1. an admission quorum that classifies and blocks preflightable failures before Job creation, and
2. a rollout circuit breaker that treats recent restart/probe-failure history as first-class rollout health.

The intent is explicit failure-mode reduction and safer rollout behavior for the Jangar control plane.

## Assessment context

- Cluster scope: `agents` and `jangar` namespaces.
- Source scope: `services/jangar/**`, `argocd/applications/agents/**`.
- Database scope: Jangar status-owned migration consistency only; direct SQL was not required for the selected change.
- Time of live evidence capture: `2026-03-06 05:09 UTC` through `2026-03-06 05:32 UTC`.

## Live evidence

### Cluster and rollout evidence

- `kubectl -n agents get pods -o wide` at `2026-03-06 05:31 UTC` showed:
  - `agents-55496fc7c7-zm6sv` in `CrashLoopBackOff`
  - `agents-controllers-*` healthy
  - many recent `jangar-control-plane-*` and `torghut-quant-*` stage pods in `Error`
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 120` showed:
  - repeated `Liveness probe failed` and `BackOff` events for `pod/agents-55496fc7c7-zm6sv`
  - repeated `BackoffLimitExceeded` for stage Jobs
  - fresh `torghut-market-context-*` batch failures
- `kubectl -n jangar get events --sort-by=.lastTimestamp | tail -n 120` showed:
  - rollout-time `Readiness probe failed` on `pod/jangar-*`
  - `Multi-Attach error` events for both `jangar` and `jangar-worker` PVC-backed rollouts
- `curl http://agents.agents.svc.cluster.local/health` and `/ready` both returned `200` during the same window, even
  while the backing pod was still cycling through probe failures.
- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status` returned:
  - `rollout_health.status=healthy`
  - `workflows.recent_failed_jobs=0`
  - `workflows.backoff_limit_exceeded_jobs=0`
  - despite the concurrent pod and Job failure evidence above.

### Runtime failure evidence

- `kubectl -n agents logs jangar-control-plane-plan-sched-6wfn5-step-1-attempt-1-rhw2t`:
  - failed with `Quota exceeded. Check your plan and billing details.`
- `kubectl -n agents logs torghut-quant-discover-sched-f72cz-step-1-attempt-1-lff7w`:
  - failed with `Unsupported value: 'xhigh' is not supported ... reasoning.effort`
- `kubectl -n agents logs torghut-market-context-news-batch-template-job-mvxds`:
  - failed with `Missing repository metadata in event payload`
- `kubectl -n agents logs agents-55496fc7c7-zm6sv --previous`:
  - showed repeated Postgres connect timeouts before process exit.

### Source evidence

- `services/jangar/src/server/control-plane-status.ts`
  - `buildRolloutHealth(...)` models current deployment state only.
  - `resolveWorkflowsReliabilityStatus(...)` catches Kubernetes list failures and returns bounded zero counters.
  - namespace degradation only keys off current status objects, not recent restart/probe-failure windows.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - includes `keeps control-plane status healthy when workflow list lookup fails`, which currently codifies
    healthy-zero behavior when workflow collection is blind.
- `services/jangar/scripts/codex/codex-implement.ts`
  - already classifies transient provider throttling/quota failures and already throws on missing repository metadata.
  - this logic runs after a Job exists, so the cluster still pays the full scheduling/startup/backoff cost.
- `argocd/applications/agents/codex-spark-agentprovider.yaml`
  - pins `model_reasoning_effort = "xhigh"`.
- `argocd/applications/agents/torghut-market-context-agentprovider.yaml`
  - also pins `model_reasoning_effort = "xhigh"` while the runtime logs show at least one active model lane rejecting it.

### Database/data evidence

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status`
  reported `database.status=healthy` and `migration_consistency.status=healthy`.
- The selected change is not DB-schema-driven; database impact is on admission/rollout metadata emitted through status.

## Problem statement

Jangar currently has three separate truths for the same failure window:

1. cluster events show pods and stage Jobs failing,
2. per-run logs show provider quota, model capability mismatch, and missing metadata errors, and
3. the primary control-plane status surface can still look healthy enough to keep scheduling.

This is not just an observability gap. It increases failure volume and widens rollout blast radius:

- configuration and metadata errors are discovered too late,
- provider quota and capability errors consume retries instead of being delayed or rerouted,
- rollout evaluation lacks restart-history context, and
- operators cannot tell whether "healthy now" means "stable" or merely "briefly responding."

## Alternatives considered

### Option A: Improve status payload only

- Pros: smallest code change, low rollout risk.
- Cons: keeps avoidable failed Jobs and does not reduce failure volume.

### Option B: Rely on existing per-run provider fallback only

- Pros: reuses `codex-implement.ts` fallback logic.
- Cons: fallback is post-dispatch, does not catch capability mismatch or missing metadata early, and still burns Job
  retries plus cluster churn.

### Option C: Selected, admission quorum plus rollout circuit breaker

- Pros: reduces failures before dispatch, aligns status with recent rollout reality, and gives deployers a clean
  rollback trigger.
- Cons: requires additive status contract work plus controller/runtime template changes.

## Decision

Adopt an additive two-layer resilience envelope:

1. `admission_quorum`
   - a pre-dispatch check executed by the controller before stage Job creation.
2. `rollout_circuit_breaker`
   - a status and rollout gate that treats recent restart/probe-failure history as deploy health, not just
     instantaneous readiness.

The design deliberately builds on existing Jangar strengths:

- keep `codex-implement.ts` as the final runtime fallback and error-classification authority,
- keep status payloads additive and bounded,
- keep rollout logic non-blocking when Kubernetes reads are partially restricted,
- but stop treating runtime-discoverable failures as acceptable steady-state noise.

## Selected architecture

### 1. Admission quorum

Before the controller creates a stage Job, it must evaluate a bounded preflight contract and emit one decision:

- `allow`
- `delay`
- `block`

Required preflight checks:

1. provider capability
   - confirm requested model supports configured reasoning effort and other required knobs
2. provider capacity
   - inspect recent quota/rate-limit failures for the same provider/model lane
3. event payload completeness
   - repository, issue number, stage, and required swarm metadata present
4. collaboration prerequisites
   - required Huly credentials/channel contract resolvable for the stage
5. rollout breaker state
   - if the deployment is inside a recent instability window, delay new stage dispatches

Required classification codes:

- `provider_capability_mismatch`
- `provider_quota_exhausted`
- `provider_rate_limited`
- `missing_repository_metadata`
- `missing_stage_metadata`
- `huly_access_unavailable`
- `rollout_circuit_open`
- `unknown_preflight_error`

`allow` creates the Job normally.

`delay` requeues without consuming a Job attempt and records the next eligible retry time.

`block` marks the stage outcome as failed-fast without creating a Job and increments a control-plane admission metric.

### 2. Capability registry

Move provider capability knowledge from scattered config and log parsing into a controller-readable registry.

Minimum fields:

- `provider`
- `model`
- `supported_reasoning_efforts`
- `max_parallel_sessions`
- `fallback_provider_chain`
- `fallback_model_chain`
- `requires_repository_metadata`
- `requires_issue_number`

This registry should become the source of truth used by:

- schedule admission,
- runtime fallback selection,
- and deploy-time validation of `AgentProvider` configs.

### 3. Rollout circuit breaker

Extend rollout health from current deployment shape to recent rollout behavior.

Additive status fields:

- `restart_churn_window_minutes`
- `recent_container_restarts`
- `recent_probe_failures`
- `recent_admission_blocks`
- `recent_admission_delays`
- `recent_preflight_failure_reasons`
- `circuit_open`
- `circuit_reason`

Circuit-open rules:

- open if the control-plane deployment has more than `N` restarts in the last `M` minutes,
- open if probe failures continue after a rollout begins,
- open if admission failures cross a configured rate threshold during rollout,
- close only after a restart-free and probe-clean soak window.

### 4. Status semantics

`/api/agents/control-plane/status` must distinguish:

- `healthy`: stable now and stable over the configured observation window
- `degraded`: currently serving, but recent rollout/admission history indicates risk
- `unknown`: cluster read is incomplete; no healthy-zero fallback when evidence is missing

This replaces the current "healthy because counters are zero" bias during collection failures.

### 5. Safer rollout behavior

Use the circuit breaker as the deploy-time go/no-go gate:

1. roll out one canary replica,
2. observe admission and restart behavior for a soak window,
3. widen only when:
   - no restart churn beyond threshold,
   - no probe-failure burst,
   - no repeated `provider_capability_mismatch`,
   - no sustained quota-driven `delay` backlog,
4. otherwise halt and roll back.

## Implementation scope

Primary code/config surfaces:

- `services/jangar/src/server/control-plane-status.ts`
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
- `services/jangar/src/server/supporting-primitives-controller.ts`
- `services/jangar/src/server/__tests__/supporting-primitives-controller.test.ts`
- `services/jangar/scripts/codex/codex-implement.ts`
- `services/jangar/scripts/codex/__tests__/codex-implement.test.ts`
- `argocd/applications/agents/codex-spark-agentprovider.yaml`
- `argocd/applications/agents/torghut-market-context-agentprovider.yaml`

Recommended implementation slices:

1. Status contract
   - add admission and restart-window fields
   - degrade on workflow/admission collection blindness
2. Controller preflight
   - evaluate capability, metadata, Huly, and rollout breaker before Job creation
3. Capability registry
   - centralize supported reasoning-effort metadata and fallback chain defaults
4. Rollout breaker
   - derive recent restart/probe-failure health from pod conditions and events
5. Config validation
   - fail CI/GitOps validation when provider config requests unsupported reasoning effort

## Validation gates

### Engineer acceptance gates

1. Unit tests prove `provider_capability_mismatch` and `missing_repository_metadata` are blocked before Job creation.
2. Unit tests prove quota/rate-limit conditions return `delay`, not immediate failed Job creation.
3. Status tests prove collection failures report `unknown` or `degraded`, never healthy-zero.
4. Rollout-health tests prove restart churn and probe-failure history open the circuit.
5. Config validation catches unsupported `model_reasoning_effort` at review time.

### Deployer acceptance gates

1. During canary rollout, `circuit_open=false` for a full soak window.
2. `recent_container_restarts=0` and `recent_probe_failures=0` for the active deployment set.
3. `recent_admission_blocks` is zero for capability/metadata classes after config promotion.
4. No new stage Jobs are created while the circuit is open.
5. Control-plane status and cluster events agree on whether the system is degraded.

## Rollout plan

1. Ship status contract first, additive only.
2. Enable admission quorum in observe-only mode:
   - log classifications
   - do not block yet
3. Turn on `block` for metadata and capability mismatches.
4. Turn on `delay` for quota/rate-limit failures once fallback policy is validated.
5. Enable rollout circuit breaker gating for the `agents` deployment.
6. Extend the same contract to `jangar` and `jangar-worker` after one clean rollout window.

## Rollback plan

If rollout blocks healthy traffic or classification is too aggressive:

1. disable admission enforcement and revert to observe-only mode,
2. keep additive status fields but mark circuit state informational,
3. revert provider capability validation changes if a safe registry is not ready,
4. retain runtime fallback inside `codex-implement.ts` so stage execution still has a last-resort recovery path.

## Risks and mitigations

- Risk: overly strict capability registry blocks a valid model lane.
  - Mitigation: observe-only warmup plus explicit allowlist overrides.
- Risk: event-based restart history is noisy under RBAC constraints.
  - Mitigation: combine pod restart counts, probe failures, and current deployment state; degrade to `unknown` when data is partial.
- Risk: quota-driven `delay` creates a hidden backlog.
  - Mitigation: expose queue age, delayed-stage count, and provider-specific delay reasons in status.

## Relationship to existing designs

This document extends, rather than replaces:

- `docs/agents/designs/jangar-control-plane-capability-admission-failure-budgets-and-rollout-rings-2026-03-06.md`
- `docs/agents/designs/jangar-control-plane-rollout-health-envelope.md`
- `docs/agents/designs/jangar-control-plane-stage-outcome-confidence-and-quota-resilience.md`
- `docs/agents/designs/jangar-control-plane-watch-reliability-envelope.md`
- `docs/agents/designs/chart-deployment-strategy-rollingupdate.md`

## Engineer handoff

Implement the admission quorum before changing rollout automation. The fastest path is:

1. status contract and tests,
2. preflight classification in the controller,
3. capability registry and config validation,
4. rollout circuit breaker,
5. deploy-time soak policy.

Do not ship rollout gating without the new status fields and tests; operators need the explainability first.

## Deployer handoff

Treat this as a safety feature, not a throughput feature. Promotion is successful only when:

- canary stays restart-free,
- admission decisions match observed failure classes,
- quota/capability failures become `delay` or `block` events instead of failed Jobs,
- and `/api/agents/control-plane/status` no longer reports healthy when the rollout window is unstable.
