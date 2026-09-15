# 99. Jangar Evidence Lease Cells And Rollout Admission Arbiter (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, schedule admission, workspace storage proof, database/data freshness, rollout
holdbacks, observability export health, and Torghut profit-proof consumption.

Companion Torghut contract:

- `docs/torghut/design-system/v6/103-torghut-hypothesis-lease-arbiter-and-options-profit-runway-2026-05-06.md`

Extends:

- `98-jangar-action-slo-budget-and-profit-proof-exchange-2026-05-06.md`
- `97-jangar-discover-cutover-handoff-and-proof-debt-gates-2026-05-06.md`
- `95-jangar-evidence-settlement-slo-and-launch-escrow-runway-2026-05-05.md`
- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`

## Decision

I am choosing **evidence lease cells with a rollout admission arbiter** as the next Jangar control-plane direction.

The system is not down. Argo reports `jangar`, `agents`, `agents-ci`, `torghut`, `torghut-options`,
`symphony-jangar`, and `symphony-torghut` as `Synced` and `Healthy`. Jangar and Agents Deployments are available.
Controller heartbeats are fresh. The Jangar database can be read through application credentials. That is enough to keep
serving, observation, and bounded repair open.

The system is also not clean. The agents namespace still has failed scheduled pods, Jangar logs show Kubernetes 429
watch/list pressure, the controller still emits OTLP metric export failures to the `observability-mimir-nginx` path, and
GitHub review ingestion cannot resolve several active swarm and promotion refs. The database tells the same story:
`agents_control_plane.resources_current` has 3,155 failed `AgentRun` rows, while `public.agent_runs` has 141 failed,
107 succeeded, and 28 running rows. Green serving health does not prove that rollout widening, normal dispatch, or
capital-adjacent actions are safe.

The selected architecture turns each high-risk evidence surface into a short-lived lease cell, then makes the rollout
admission arbiter consume those leases before material action. The tradeoff is more explicit gating. Operators may see a
green app and still see normal dispatch or rollout widening held. I accept that. The failure mode to remove is not an
outage screen; it is the quiet conversion of stale, missing, or noisy evidence into new pods and capital risk.

## Evidence Snapshot

All cluster and database assessment was read-only. No Kubernetes resources or database records were changed. The local
kube context was bootstrapped from the in-cluster service-account token because `kubectl config current-context` was
unset.

### Runtime Inputs

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/swarm-jangar-control-plane-plan`
- Runtime date: `2026-05-06`
- Runtime identity: `system:serviceaccount:agents:agents-sa`
- Progress/audit issue: `#5612`

### Cluster, Rollout, And Event Evidence

- `kubectl get pods -n jangar -o wide` showed `jangar-7c4bbdd45-sgqpg` at `2/2 Running`, `jangar-db-1` at
  `1/1 Running`, and Bumba, Alloy, Redis, Open WebUI, and Symphony pods running.
- `kubectl get deploy -n jangar` showed `jangar`, `bumba`, `jangar-alloy`, `symphony`, and `symphony-jangar` all
  available at desired replicas.
- `kubectl get pods -n agents --no-headers | awk ...` counted `Completed=76`, `Error=30`, and `Running=8`.
- `kubectl get deploy -n agents` showed `agents` at `1/1`, `agents-alloy` at `1/1`, and `agents-controllers` at
  `2/2`.
- Failed agents pods were concentrated in scheduled plan/verify lanes, including Jangar verify runs such as `b5ddf`,
  `h9rx7`, `n26px`, `ngtd8`, `rqlm7`, `wbbzk`, `wppz5`, and Torghut quant verify/discover attempts.
- Recent Agents events showed schedule CronJobs continuing to create and complete runner jobs. That is useful progress,
  but it also proves failed-run debt is still part of the steady-state surface.
- `kubectl get pods -n torghut -o wide` showed the current live revision `torghut-00228` and simulation revision
  `torghut-sim-00309` at `2/2 Running`; ClickHouse, Keeper, Postgres, options catalog/enricher, options TA, websocket
  services, and TA jobs were running.
- Torghut events for the current rollout still included transient readiness/startup probe failures before
  `RevisionReady`; old revision shutdown also produced 503/readiness warnings.
- Argo CD reported `agents`, `agents-ci`, `jangar`, `symphony-jangar`, `symphony-torghut`, `torghut`, and
  `torghut-options` as `Synced` and `Healthy`.
- RBAC prevented broad CNPG introspection and pod exec: `clusters.postgresql.cnpg.io is forbidden` and `pods/exec is
forbidden`. The service account could read the specific app DB secrets needed for read-only SQL.

### Source Evidence

- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule generation, swarm runtime admission,
  CRD watches, workspace PVC lifecycle, and status reconciliation. It is the right enforcement point for launch leases.
- The same controller calls the Kubernetes primitive client with `persistentvolumeclaim` for workspace reads, deletes,
  and watches.
- Before this PR, `services/jangar/src/server/primitives-kube.ts` supported common built-ins such as ConfigMap, Job,
  Pod, Secret, and Service, but not `persistentvolumeclaim`, `persistentvolumeclaims`, `pvc`, or `pvcs`.
- This PR patches that first actionable source gap and adds regression coverage in
  `services/jangar/src/server/__tests__/primitives-kube.test.ts`.
- `services/jangar/src/server/control-plane-status.ts` already composes controller heartbeats, database status, rollout
  health, workflow reliability, watch reliability, execution trust, runtime admission, failure-domain leases, and
  empirical service evidence. The missing piece is an admission object that says which evidence cells are fresh enough
  for which action.
- `services/jangar/src/server/metrics-config.ts` still defaults metrics to
  `http://observability-mimir-nginx.observability.svc.cluster.local/otlp/v1/metrics`. Current Agents controller logs
  show repeated `FailedToOpenSocket` and connection failures to that path, while the Jangar app Deployment also has a
  working Alloy endpoint configured for OTLP metrics. This should become an observability export lease, not background
  noise.
- Jangar app logs showed GitHub review ingestion failures for unresolved refs including
  `codex/swarm-jangar-control-plane-plan`, `codex/swarm-jangar-control-plane`, and Torghut promotion branches. That is
  negative source-ref evidence for review and merge-readiness automation.
- Jangar app logs also showed repeated `Too Many Requests` watch/list failures for `AgentRun` and `SignalDelivery`
  resources in `agents`, plus an HTTP 429 while collecting workflow reliability metrics.

### Database And Data Evidence

- Jangar SQL connected as `jangar` to database `jangar` at `2026-05-06T02:25:30.401Z`; table count was 99.
- `agents_control_plane.resources_current` had 3,340 rows, 115 active rows, and newest `last_seen_at`/`updated_at` at
  `2026-05-06T02:26:37.918Z`.
- `resources_current` by kind/status had 3,155 failed `AgentRun` rows, 109 succeeded `AgentRun` rows, 25 running
  `AgentRun` rows, 24 `ImplementationSpec` rows, 12 template `AgentRun` rows, 8 `Agent` rows, 6 `AgentProvider` rows,
  and 1 `VersionControlProvider` row.
- `agents_control_plane.component_heartbeats` had four healthy leader heartbeats: `agents-controller`,
  `orchestration-controller`, `supporting-controller`, and `workflow-runtime`, observed at
  `2026-05-06T02:26:37.170Z` and expiring at `2026-05-06T02:28:37.170Z`.
- `public.agent_runs` counted 141 `Failed`, 107 `Succeeded`, and 28 `Running` rows, with newest updates at
  `2026-05-06T02:26:38.716Z`.
- `workflow_comms.agent_messages` was fresh: `general/status` and `run/status` both had newest timestamps at
  `2026-05-06T02:25:24.153Z`.
- `torghut_control_plane.simulation_runs` in Jangar was stale: newest failed run evidence was March 19, and newest
  succeeded/running/submitted evidence was March 13-14. That store cannot currently authorize Torghut simulation
  claims by itself.

## Problem

Jangar currently mixes evidence collection, serving health, controller authority, launch permission, rollout readiness,
and consumer capital admission too loosely. The visible failure modes are specific:

1. **Serving health can over-authorize.** A healthy Deployment and fresh heartbeat do not prove schedule launch,
   rollout widening, merge readiness, or Torghut capital readiness.
2. **Negative evidence is not uniformly expiring.** Failed pods, failed AgentRuns, Git ref misses, metrics export
   errors, and stale simulation rows sit in different systems with different semantics.
3. **Repair and normal dispatch need different treatment.** Repair needs to stay open to retire failed-run debt, while
   normal recurring work should be held when evidence cells are degraded.
4. **Storage proof is a real launch dependency.** Workspace PVC lifecycle is part of supporting-primitives launch
   safety, so the primitive resolver must address PVCs as first-class resources.
5. **Torghut needs a compact Jangar decision.** Torghut should not have to infer capital readiness from broad Jangar
   route health or stale simulation rows.

## Alternatives Considered

### Option A: Clean Up Failed Pods And Keep The Existing Status Model

This option treats the problem as operational backlog. We would prune old failed pods, improve TTL settings, and leave
the existing status route as the main authority.

Pros:

- Fast to execute.
- Reduces visual noise in `kubectl get pods`.
- Does not add a new object model.

Cons:

- Hides failure debt without pricing it into admission.
- Does not address source-ref misses, observability export failure, or stale database evidence.
- Leaves the supporting controller able to create new work based on partial truth.

Decision: reject as the architecture. Pod cleanup is useful hygiene, but it is not an admission system.

### Option B: Global Brownout Until All Surfaces Are Green

This option freezes all non-read-only Jangar work whenever any major evidence surface is degraded.

Pros:

- Conservative.
- Easy for operators to understand.
- Prevents unsafe widening while evidence is ambiguous.

Cons:

- Blocks bounded repair work needed to clear evidence debt.
- Treats metrics export failure and controller unavailability as equivalent.
- Encourages manual bypasses when teams need targeted recovery.

Decision: keep as an emergency override only.

### Option C: Evidence Lease Cells And Rollout Admission Arbiter

This option creates small, expiring evidence leases per failure domain and action class. The rollout admission arbiter
joins those leases before schedule creation, rollout widening, merge-ready claims, and Torghut capital consumption.

Pros:

- Reduces failure modes at the point where new work is admitted.
- Keeps serving and bounded repair open while holding unsafe actions.
- Gives every lease an expiry, owner, and rollback trigger.
- Lets least-privilege deployers verify safety without pod exec.
- Gives Torghut a compact Jangar-facing authority contract.

Cons:

- Adds new reducer and projection code.
- Requires a staged shadow period to avoid false holds.
- Requires disciplined dedupe so noisy logs do not produce noisy leases.

Decision: select Option C.

## Chosen Architecture

### EvidenceLeaseCell

Jangar materializes one current lease per namespace, producer, evidence class, and action scope.

```text
evidence_lease_cell
  lease_id
  namespace
  cell_type                 # cluster_watch, schedule_launch, workspace_storage, database_freshness,
                            # observability_export, source_ref, torghut_profit
  producer                  # jangar-app, agents-controllers, supporting-controller, torghut-consumer
  producer_revision
  observed_at
  fresh_until
  decision                  # allow, observe_only, repair_only, hold, block
  confidence                # high, medium, low
  evidence_digest
  positive_evidence[]
  negative_evidence[]
  allowed_action_classes[]
  blocked_action_classes[]
  rollback_triggers[]
  source_refs[]
```

The lease is intentionally compact. Full logs, rows, and artifacts stay in their source systems. The lease says what was
observed, how long it is fresh, and which action classes are allowed.

### Initial Lease Cells

- `cluster_watch`: controller heartbeats, watch 429s, list failures, workload availability, recent warning events.
- `schedule_launch`: recent schedule-runner failures, runtime admission passport, target namespace, ConfigMap and
  CronJob materialization, image digest, service-account scope.
- `workspace_storage`: PVC target resolution, PVC `Bound` state when required, RWO multi-attach risk, cleanup safety.
- `database_freshness`: Jangar control-plane tables, component heartbeats, failed-run debt, stale simulation rows, query
  budget pressure.
- `observability_export`: OTLP endpoint health, exporter error rate, metric freshness.
- `source_ref`: branch/ref resolution for review ingest, PR merge readiness, and code-search snapshots.
- `torghut_profit`: companion Torghut hypothesis leases and capital guardrail decisions.

### RolloutAdmissionArbiter

The arbiter consumes leases and emits one decision per action request:

```text
rollout_admission_decision
  decision_id
  action_class              # serve_readonly, observe, dispatch_repair, dispatch_normal, deploy_widen,
                            # merge_ready, torghut_shadow_capital, torghut_paper_capital, torghut_live_capital
  target
  generated_at
  fresh_until
  decision                  # allow, observe_only, repair_only, hold, block
  required_leases[]
  missing_leases[]
  blocking_leases[]
  repair_hints[]
  rollback_triggers[]
```

Default action mapping for the current evidence:

- `serve_readonly`: allow.
- `observe`: allow.
- `dispatch_repair`: allow when the request names the proof debt and has a bounded runtime.
- `dispatch_normal`: hold while failed-run debt and watch/list pressure remain active.
- `deploy_widen`: hold until rollout probe tail and observability export leases are fresh.
- `merge_ready`: hold for source-indexing-sensitive work when source refs cannot be resolved.
- `torghut_shadow_capital`: allow for zero-notional repair.
- `torghut_paper_capital`: hold until companion hypothesis leases prove account/window profit evidence.
- `torghut_live_capital`: block until paper evidence and rollback readiness are fresh.

### Failure-Mode Reduction

| Failure mode                                      | Current evidence                                             | Lease response                                         | Reduced behavior                                     |
| ------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------ | ---------------------------------------------------- |
| New work launched while failed-run debt grows     | 30 failed pods; 141 failed `agent_runs`                      | `schedule_launch=repair_only`                          | repair jobs allowed, normal schedules held           |
| Storage proof mismatch                            | PVC used by supporting controller but not primitive resolver | `workspace_storage=hold` until resolver and tests pass | PVC read/list/delete/watch can share one target      |
| Watch/list pressure hidden behind green readiness | Jangar logs show AgentRun and SignalDelivery 429s            | `cluster_watch=hold` for widen                         | no scope widening until watch budget recovers        |
| Metrics exporter noise ignored                    | Agents logs show OTLP failures to Mimir path                 | `observability_export=hold` for widen                  | deployer must fix or consciously waive metric export |
| Merge readiness with missing source refs          | review ingest cannot resolve active refs                     | `source_ref=hold` for merge-ready automation           | ref freshness becomes explicit                       |
| Torghut capital from route liveness               | Torghut services running but proof tables empty              | `torghut_profit=shadow_only`                           | capital stays closed while repair continues          |

## Engineer Scope

The engineer stage should implement this in three bounded slices:

1. **Lease projection in shadow mode.**
   Add `EvidenceLeaseCell` and `RolloutAdmissionDecision` builders inside the Jangar control-plane status path. The
   first version can be in-memory/status-only, backed by existing DB reads and Kubernetes summaries. It must not create
   new write pressure on hot request paths.
2. **Schedule and storage enforcement.**
   Gate supporting-primitives schedule creation on `dispatch_repair` versus `dispatch_normal`. Keep the PVC resolver
   patch from this PR and add coverage for read/list/delete/watch paths. A blocked lease must withhold or remove only
   the unsafe schedule-runner child, not the parent design artifact.
3. **Consumer contract.**
   Expose the compact decision in `/api/agents/control-plane/status` and provide a stable field for Torghut to consume:
   `actionAdmission.torghut.{shadow,paper,live}` with required leases and reason codes.

Initial required tests:

- Unit: PVC aliases resolve to core `v1` `PersistentVolumeClaim` targets.
- Unit: failed-run debt plus healthy heartbeats yields `dispatch_repair=allow` and `dispatch_normal=hold`.
- Unit: observability export failure blocks `deploy_widen` but not `serve_readonly`.
- Unit: missing source ref blocks `merge_ready` for source-indexing-sensitive actions.
- Unit: Torghut empty hypothesis lease blocks paper/live capital but allows shadow repair.
- Integration: supporting-primitives controller with a blocked normal dispatch decision does not create a new
  schedule-runner Job/CronJob.

## Deployer Scope

Roll out the lease system in rings:

1. **Shadow ring.** Deploy with enforcement disabled. Verify the status payload includes all lease cells, reason codes,
   expiry, and action decisions for at least two schedule windows.
2. **Repair-only ring.** Enforce only `dispatch_normal=hold` while allowing `dispatch_repair`. Verify no new failed
   normal runner pods are created and repair jobs still start.
3. **Widen ring.** Enforce `deploy_widen` and `merge_ready` holds. Require fresh observability and source-ref leases
   before promotion.
4. **Consumer ring.** Let Torghut consume `torghut_shadow_capital`, `torghut_paper_capital`, and
   `torghut_live_capital` decisions from Jangar.

No direct cluster mutation is required for the architecture PR. Deployer changes should continue through GitOps.

## Validation Gates

Engineer acceptance gates:

- `bunx oxfmt --check services/jangar/src/server/primitives-kube.ts services/jangar/src/server/__tests__/primitives-kube.test.ts`
- `bun run --filter @proompteng/jangar test -- src/server/__tests__/primitives-kube.test.ts`
- New lease reducer tests pass with fixtures for the current evidence snapshot.
- Status payload documents every blocking action with a lease id, reason code, freshness, and repair hint.
- Supporting controller tests prove blocked normal dispatch withholds schedule-runner resources while repair dispatch
  remains allowed.

Deployer acceptance gates:

- Argo apps for `jangar`, `agents`, and `torghut` remain `Synced` and `Healthy`.
- Jangar and Agents controller Deployments remain available through a two-schedule-window stability check.
- `agents` failed pod count does not increase after enforcement is enabled.
- `agents_control_plane.component_heartbeats` remains fresh with all four healthy leader components.
- `workflow_comms.agent_messages` remains fresh for the live channel.
- No new metrics export failure lease is present before `deploy_widen` is allowed.
- Torghut paper/live capital decisions remain held until the companion hypothesis leases pass.

## Rollout

- Feature flags: introduce `JANGAR_EVIDENCE_LEASE_CELLS_ENABLED` and
  `JANGAR_ROLLOUT_ADMISSION_ARBITER_ENFORCEMENT`.
- Default posture: status-only shadow mode.
- First enforcement target: `dispatch_normal`, because it reduces failed-run growth without blocking repair.
- Second enforcement target: `deploy_widen` and `merge_ready`.
- Third enforcement target: Torghut capital actions, after the companion Torghut contract is implemented.
- Observability: emit counters for lease decision by cell type, action class, reason code, and namespace. Emit one
  event only on decision transition, not on every sample.

## Rollback

- Disable `JANGAR_ROLLOUT_ADMISSION_ARBITER_ENFORCEMENT` to return to advisory-only mode.
- If lease construction itself increases route latency or database pressure, disable
  `JANGAR_EVIDENCE_LEASE_CELLS_ENABLED` and revert to the prior status path.
- If a rollout blocks repair incorrectly, disable enforcement for `dispatch_repair` only and keep shadow decisions
  visible.
- If the PVC resolver patch regresses Kubernetes primitive behavior, revert this PR or the specific aliases; the
  expected failure signal is a primitives-kube unit failure or supporting controller workspace-storage error.
- If Torghut consumes a bad decision, fail closed for paper/live and allow shadow repair from local Torghut gates.

## Risks And Tradeoffs

- A lease system can become another dashboard if it is not wired to admission. The first implementation must block at
  least one low-risk action class, `dispatch_normal`, after shadow validation.
- More status computation can increase database pressure. The builders must reuse existing snapshots and avoid new
  expensive reads on request paths.
- Source-ref failures may be caused by branches that have not been pushed yet. The arbiter should distinguish "missing
  because local work not pushed" from "missing after PR creation".
- Observability export failures should not stop repair. They should stop widening until the operator can see the
  system again.
- Historical failed `AgentRun` rows should not block forever. The lease must use windows, debt classifications, and
  explicit repair credits.

## Handoff Contract

Engineer:

- Implement `EvidenceLeaseCell` and `RolloutAdmissionDecision` builders in the Jangar control-plane status layer.
- Keep the PVC resolver aliases and tests from this PR.
- Add reducer tests for the exact current evidence: fresh heartbeats, failed-run debt, watch 429s, metrics export
  failure, missing source refs, and Torghut proof absence.
- Gate supporting-primitives normal schedule creation on the admission decision after one shadow window.

Deployer:

- Roll out shadow mode first and capture two consecutive schedule windows.
- Enforce normal-dispatch hold only after the lease payload is stable.
- Do not widen controller scope or Torghut capital while `cluster_watch`, `observability_export`, `source_ref`, or
  `torghut_profit` leases are `hold` or `block`.
- Roll back by disabling enforcement flags before reverting GitOps manifests.
