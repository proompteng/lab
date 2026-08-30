# 176. Jangar Resource-Pressure Escrow And Runner QoS Gates (2026-05-08)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-08
Owner: Victor Chen, Jangar Engineering Architecture
Scope: Jangar runner resource pressure, node eviction debt, schedule launch safety, status latency, database projection
limits, Torghut proof-consumer handoff, validation, rollout, rollback, and acceptance gates.

Companion Torghut contract:

- `docs/torghut/design-system/v6/180-torghut-resource-priced-evidence-frontier-and-context-spend-escrow-2026-05-08.md`

Extends:

- `175-jangar-failure-debt-clearance-and-action-reentry-frontier-2026-05-08.md`
- `174-jangar-observer-rights-and-source-settled-capital-ledger-2026-05-08.md`
- `173-jangar-action-broker-and-proof-carrying-rollout-cells-2026-05-08.md`
- `docs/torghut/design-system/v6/179-torghut-capital-repair-frontier-and-route-yield-clearance-2026-05-08.md`

## Decision

I am selecting a **resource-pressure escrow with runner QoS action gates** as the next Jangar control-plane
architecture step.

The current cluster is serving, but the worker substrate is not yet trustworthy enough to be treated as background
noise. On 2026-05-08 at 03:05Z to 03:10Z, Jangar `deployment/jangar` was available on image `9e7b87d8`, the active
pod `jangar-665d446c8-jhcnb` was `2/2 Running`, and `/ready` returned `status=ok` with leader election held by that
pod. Agents `deployment/agents` and `deployment/agents-controllers` were also available on the same release family.
The Agents summary showed 456 AgentRuns: 417 succeeded, 21 failed, 6 running, and 12 templates. The system can serve
operators and schedule work.

The same pass showed an action-grade reliability gap. Recent Agents events recorded resource evictions caused by
node ephemeral-storage pressure. `jangar-control-plane-implement-sched-hp5jx-step-1-attempt-1` failed with
`BackoffLimitExceeded`; its `agent-runner` container had no resource requests or limits, QoS class `BestEffort`, and
was evicted after using about 3.7 GiB of ephemeral storage with request `0`. Two Torghut market-context news jobs
also failed from the same node pressure. One of them had CPU and memory requests, but no ephemeral-storage request,
and was evicted even after using only about 1.3 MiB because the node was below its eviction threshold. Current retries
and later market-context jobs completed, which makes the failure easy to dismiss. That is exactly the wrong lesson.

The decision is to make resource pressure an explicit escrowed input to action authority. A schedule launch, normal
dispatch, deploy widening, merge readiness, Torghut paper canary, or live capital request must cite a fresh runner QoS
lease and resource-pressure escrow result. The escrow records pod QoS class, CPU, memory, ephemeral-storage requests
and limits, `emptyDir` size limits, node pressure events, retry state, active runner age, status route latency, and
the evidence class produced by the run. Serving and observe-only repair can remain available. Launch-capable work
without a bounded ephemeral-storage budget stays repair-only until the deployer or engineer clears the resource debt.

The tradeoff is that some repaired source and rollout evidence will still be held when the cluster looks otherwise
green. I accept that. The six-month failure mode is not a broken pod. It is an action-authoritative control plane that
keeps retrying successful-looking jobs on a node with resource pressure, then lets incomplete or evicted proof runs
advance dispatch, merge, or capital decisions.

## Success Metrics

Success means:

- Jangar emits `resource_pressure_escrow` in shadow mode beside failure-debt clearance and material action verdicts.
- Each escrow record includes `escrow_id`, `namespace`, `pod_ref`, `job_ref`, `agent_run_ref`, `node_ref`,
  `image_ref`, `qos_class`, `resource_requests`, `resource_limits`, `empty_dir_limits`, `pressure_events`,
  `eviction_state`, `retry_state`, `evidence_class`, `decision`, `fresh_until`, and `rollback_target`.
- BestEffort launch-capable runs are never allowed to satisfy `dispatch_normal`, `deploy_widen`, `merge_ready`,
  `paper_canary`, `live_micro`, or `live_scale` material gates.
- A Burstable or Guaranteed run still holds action authority when it lacks an explicit ephemeral-storage request for
  an evidence class that writes worktrees, package caches, model artifacts, or provider payloads.
- Recent node `ephemeral-storage` evictions create action-blocking debt for new runs scheduled to the same node until
  a clean lease window clears.
- Retried runs may retire repair debt only when their replacement attempt cites a clean QoS lease and produces a
  completion receipt on the current release image.
- Full control-plane status reads have a latency budget; if `/api/agents/control-plane/status` times out, bounded
  summary/resources endpoints remain usable but material action evidence records `status_surface_timeout`.
- Engineer and deployer handoffs include exact tests, rollout phases, rollback levers, and Torghut consumer gates.

## Evidence Snapshot

All evidence in this pass was collected read-only. I did not mutate Kubernetes resources or database records.

### Cluster And Rollout Evidence

- Workspace branch: `codex/swarm-jangar-control-plane-discover`, fast-forwarded to `origin/main` at `19432a44f`
  before edits.
- `kubectl auth whoami` resolved to `system:serviceaccount:agents:agents-sa` after the in-cluster context was
  bootstrapped from the mounted service-account token.
- Jangar deployments `bumba`, `jangar`, `jangar-alloy`, `symphony`, and `symphony-jangar` were available.
- `deployment/jangar` ran image
  `registry.ide-newton.ts.net/lab/jangar:9e7b87d8@sha256:758e880b2e9ec439d2dfceb41a170c2352ca63108c90be81be321f8d56cafda4`.
- Jangar events showed the current pod `jangar-665d446c8-jhcnb` created and started cleanly, followed by one startup
  readiness probe failure while `/health` was still refusing connections.
- Agents deployments `agents`, `agents-alloy`, and `agents-controllers` were available. The current controller pods
  had one recent restart each, and events showed readiness/liveness probe failures during rollout.
- The Agents summary endpoint returned 456 AgentRuns: 417 `Succeeded`, 21 `Failed`, 6 `Running`, and 12 `Template`.
- `jangar-control-plane-implement-sched-hp5jx-step-1-attempt-1` failed at 2026-05-08T02:45Z with
  `BackoffLimitExceeded` after an ephemeral-storage eviction.
- The failed Jangar implement attempt had `resources: {}`, QoS `BestEffort`, `backoffLimit=0`, and
  `ttlSecondsAfterFinished=86400`.
- `torghut-market-context-news-amd-fcv2j-job` and `torghut-market-context-news-googl-wcz7h-job` failed from the same
  node pressure window. The AMD job had CPU and memory resources but no ephemeral-storage request or limit.
- Current schedules were not globally down: later Jangar discover cron completed, retries were running, and a later
  AMD news job completed. This is a resource-pressure clearance problem, not a serving outage.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` has 793 lines and already aggregates the control-plane decision
  surface. It should consume the new escrow as one bounded section rather than grow into a resource-policy module.
- `services/jangar/src/server/supporting-primitives-controller.ts` has 3314 lines and owns schedule, swarm, workspace,
  PVC, and watch actuation. It is the right enforcement point for schedule launch gates, but not the right place to
  implement scoring rules.
- `services/jangar/scripts/codex/agent-runner.ts` has 369 lines and `services/jangar/scripts/codex/codex-implement.ts`
  has 4348 lines. These runners can generate large worktrees, dependency caches, and logs, so the workload spec must
  advertise storage budgets before the controller treats their evidence as action-grade.
- `services/jangar/api/agents/v1alpha1/types.go` already supports `spec.workload.resources.requests` and
  `spec.workload.resources.limits` with arbitrary resource keys, including `ephemeral-storage`.
- `argocd/applications/agents/swarm-agentrun-templates.yaml` gives swarm workflow templates no workload resources,
  so the observed Jangar implement job rendered as `BestEffort`.
- `argocd/applications/agents/torghut-market-context-batch.yaml` gives market-context jobs CPU and memory budgets but
  not ephemeral-storage budgets.
- The tests already cover control-plane status, material action verdicts, source rollout truth, runtime proof, route
  stability, and supporting primitives. The missing test surface is a pure resource-pressure reducer plus controller
  rendering tests that prove storage budgets and QoS decisions are preserved in generated Jobs.

### Database And Data Evidence

- Direct CNPG metadata is still outside this service account's observer surface:
  `clusters.postgresql.cnpg.io is forbidden` in the `jangar` namespace.
- Jangar `/ready` was healthy and leader election was current, but it did not include database or control-plane
  status details in this sample.
- The full Jangar control-plane status endpoint timed out after 10 seconds with no bytes returned. The bounded
  summary/resources endpoints succeeded and provided resource counts and AgentRun samples.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, current Alembic head
  `0029_whitepaper_embedding_dimension_4096`, `schema_graph_lineage_ready=true`, and known historical parent-fork
  warnings.
- Torghut `/readyz` and `/trading/health` were degraded with proof floor `repair_only`, route state `repair_only`,
  capital state `zero_notional`, blockers `hypothesis_not_promotion_eligible`,
  `execution_tca_route_universe_incomplete`, and `simple_submit_disabled`.
- Torghut market context was informational with market-closed staleness, but the failed news jobs prove provider
  evidence can be resource-degraded even when the final domain state is not a hard capital blocker.

## Problem

Jangar currently treats runner resource pressure as a Kubernetes event and retained failure-debt item. That is not
strong enough for an autonomous control plane.

The current failure modes are:

1. A BestEffort runner can generate or fail to generate source, implementation, verification, or market-context
   evidence without its missing resource budget being visible in action verdicts.
2. A job with CPU and memory limits can still be unbudgeted for ephemeral storage, which is the resource that caused
   the observed evictions.
3. Backoff-limited failed attempts can be followed by successful retries, but the replacement evidence does not prove
   that the resource class was fixed.
4. Node pressure is local, but schedule launch and capital consumers need to know whether their evidence came from a
   pressure-clean window.
5. Full status reads can time out while bounded summary reads work, so consumers need a latency-aware proof surface
   instead of one monolithic status dependency.
6. Torghut can receive fresh-looking context or proof receipts from jobs whose resource budget would not be acceptable
   for paper or live capital.

The control plane needs to escrow runner resource truth before it lets those runners produce action authority.

## Alternatives Considered

### Option A: Raise Default Cluster Capacity

Add more node storage or increase eviction thresholds so current runners fail less often.

Advantages:

- Fast operational mitigation.
- Does not require new API shapes.
- Helps all workloads on the affected node.

Disadvantages:

- Does not tell Jangar which evidence was produced under resource pressure.
- Lets BestEffort or unbounded jobs remain action-authoritative.
- Moves the failure from frequent eviction to rare, larger blast-radius eviction.

Decision: useful as operations work, but not sufficient architecture.

### Option B: Add Static Resource Requests To Every Template

Patch swarm and market-context templates with CPU, memory, and ephemeral-storage requests.

Advantages:

- Directly addresses the observed missing requests.
- Easy for deployers to validate in rendered Job specs.
- Reduces immediate eviction risk.

Disadvantages:

- Treats one template patch as proof for all future evidence classes.
- Does not score node pressure, retry state, status latency, or evidence criticality.
- Cannot tell Torghut whether a specific receipt is resource-clean.

Decision: required implementation work, but it must feed an escrow rather than stand alone.

### Option C: Resource-Pressure Escrow With Runner QoS Gates

Create a resource-pressure escrow that records per-run resource budgets, observed pressure, retry cleanliness, and
evidence class. Material action gates consume the escrow before accepting runner evidence.

Advantages:

- Converts node pressure from an event log into action authority.
- Lets safe read-only service continue while launch-capable work is held.
- Distinguishes BestEffort, unbudgeted Burstable, clean Burstable, and Guaranteed evidence.
- Gives Torghut one upstream resource-clean receipt for context, proof, paper, and live gates.

Disadvantages:

- Adds a reducer and status section.
- Requires controller render tests and rollout policy for existing templates.
- May hold useful repair after transient node pressure until a clean lease window is observed.

Decision: select Option C.

## Architecture

Jangar adds a shadow `resource_pressure_escrow` reducer. It consumes Kubernetes pods, jobs, events, AgentRun status,
rendered workload specs, runner artifact metadata, and status-read latency samples.

```text
resource_pressure_escrow
  escrow_id
  generated_at
  namespace
  node_ref
  pod_ref
  job_ref
  agent_run_ref
  image_ref
  evidence_class              # status | source | implementation | verification | market_context | torghut_capital
  qos_class                   # BestEffort | Burstable | Guaranteed
  resource_requests
  resource_limits
  empty_dir_limits
  storage_request_bytes
  storage_limit_bytes
  pressure_events
  eviction_state              # none | evicted | retrying_after_eviction | clean_retry | unresolved
  retry_state                 # none | failed_no_retry | retry_running | retry_succeeded | retry_failed
  status_latency_state        # ok | slow | timeout | not_required
  decision                    # clean | observe_only | repair_only | hold | block
  reasons
  fresh_until
  rollback_target
```

Material action verdicts consume the escrow:

```text
runner_qos_action_gate
  action_class
  required_evidence_classes
  required_qos_floor
  require_ephemeral_storage_request
  max_recent_node_evictions
  required_status_latency_state
  escrow_refs
  decision                    # allow | allow_repair | hold | block
```

Decision rules:

- `serve_readonly` can allow when serving health is good and the bounded status surface is responsive.
- `torghut_observe` can allow when resource-degraded receipts are marked informational and no capital action is
  implied.
- `dispatch_repair` can allow only when the run declares resource budgets and targets a named debt item.
- `dispatch_normal`, `deploy_widen`, and `merge_ready` require no unresolved node pressure for their runner class, no
  BestEffort evidence, and a clean status latency sample.
- `paper_canary`, `live_micro`, and `live_scale` require a clean Jangar escrow plus Torghut proof-floor clearance.
- A retry after eviction must carry a new escrow id; it cannot inherit authority from the failed attempt.

## Implementation Scope

1. Add a pure reducer under `services/jangar/src/server/control-plane-resource-pressure-escrow.ts`.
2. Add unit tests for BestEffort workflow jobs, Burstable jobs without ephemeral-storage, clean retries, failed retries,
   node pressure windows, and status timeout handling.
3. Extend the controller Job rendering path so generated jobs preserve `ephemeral-storage` requests and limits from
   `AgentRun.spec.workload.resources`.
4. Add template defaults for swarm workflow runs and market-context jobs with explicit CPU, memory, and
   ephemeral-storage requests.
5. Add a compact status projection and UI section that reports only current debt, not every historical pod.
6. Feed the escrow into material action verdicts and failure-debt clearance in shadow mode.
7. Emit Torghut consumer fields: `jangar_resource_escrow_ref`, `resource_clean`, `resource_decision`, and
   `resource_reasons`.

The first implementation should stay status-first. Persist the escrow only after shadow data proves which fields are
stable. If persisted, use a TTL table keyed by `escrow_id` and indexed by `agent_run_ref`, `job_ref`, `node_ref`, and
`evidence_class`.

## Validation Gates

Local validation:

- Unit reducer: BestEffort Jangar implement job with an eviction produces `decision=block` for launch-capable actions.
- Unit reducer: market-context job with CPU/memory but no ephemeral-storage produces `decision=repair_only` for
  Torghut capital evidence.
- Controller render test: `ephemeral-storage` requests and limits survive from AgentRun spec to Job pod template.
- Status test: full status timeout records `status_surface_timeout` while summary/resources remain usable.
- Material verdict test: `dispatch_normal`, `deploy_widen`, `merge_ready`, `paper_canary`, and `live_micro` hold when
  required resource escrow is missing or dirty.

Cluster validation:

- `kubectl -n agents get job <sample> -o json` shows non-empty `resources.requests["ephemeral-storage"]`.
- `kubectl -n agents describe pod <sample>` shows QoS `Burstable` or `Guaranteed`, not `BestEffort`, for launch-capable
  runners.
- A 30 minute shadow window has zero resource evictions for current Jangar and Torghut evidence jobs before widening.
- `/api/agents/control-plane/summary?namespace=agents` remains under its latency budget while full status degradation
  is recorded instead of silently blocking operators.

## Rollout

1. Shadow: compute escrow and log/status decisions with no enforcement.
2. Template hardening: add explicit resource defaults and verify generated Jobs.
3. Repair enforcement: require escrow for `dispatch_repair` jobs that claim to retire resource or evidence debt.
4. Normal dispatch enforcement: hold `dispatch_normal`, `deploy_widen`, and `merge_ready` without a clean escrow.
5. Torghut enforcement: require a clean escrow for `paper_canary`, `live_micro`, and `live_scale`.

## Rollback

Rollback is policy-level first:

- Disable escrow enforcement and keep shadow projection.
- Revert template resource defaults only if they create unschedulable pods.
- Keep failed resource evidence visible in the clearance book; do not delete the historical debt.
- If the status section itself causes latency, disable full escrow expansion and keep aggregate counters plus latest
  action-blocking reasons.

The safe fallback is `serve_readonly`, `torghut_observe`, and explicitly targeted `dispatch_repair` only.

## Risks

- Resource defaults can make pods pending if requests exceed available node capacity.
- A strict storage gate can slow repair during a transient pressure window.
- Status projections can become expensive if they scan too many old pods; the implementation must cap age, count, and
  fields.
- A successful retry can mask an earlier evicted attempt unless retry lineage is explicit.
- Torghut may over-discount context evidence during expected market-closed staleness if resource and freshness reasons
  are conflated.

## Handoff To Engineer

Build the reducer before changing enforcement. The first PR should own `services/jangar/src/server/` reducer/tests,
the Job render path, and minimal status projection. Keep the scoring pure and deterministic. Do not bury policy inside
`supporting-primitives-controller.ts`; have that controller provide observed facts and consume decisions.

Acceptance gates:

- Reducer tests cover the failed Jangar implement job shape and the failed Torghut market-context job shape described
  in this document.
- Generated Job specs preserve `ephemeral-storage`.
- Material action verdicts cannot promote launch-capable actions from BestEffort or unbudgeted resource evidence.
- Status latency failures become evidence, not uncaught operator timeouts.

## Handoff To Deployer

Start with shadow metrics and template defaults. Verify rendered Jobs in `agents` before enabling holds. Watch for
pending pods after adding resource requests; if capacity is insufficient, adjust node capacity or template budgets
before enabling normal dispatch gates.

Acceptance gates:

- No current launch-capable Jangar swarm job renders as QoS `BestEffort`.
- Market-context jobs include CPU, memory, and ephemeral-storage requests.
- A clean 30 minute window has no `Evicted` events for current Jangar or Torghut evidence jobs.
- Torghut paper/live gates remain zero-notional unless Jangar resource escrow is clean.
