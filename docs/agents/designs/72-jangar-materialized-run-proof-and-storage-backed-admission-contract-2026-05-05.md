# 72. Jangar Materialized Run Proof and Storage-Backed Admission Contract (2026-05-05)

Status: Approved for implementation (`plan`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Scope: Jangar control-plane resilience, schedule dispatch reliability, workspace/PVC safety, partial-RBAC deploy
verification, and downstream Torghut profit-admission authority.

Companion doc:

- `docs/torghut/design-system/v6/77-torghut-profit-admission-cells-and-materialized-evidence-contract-2026-05-05.md`

Extends:

- `71-jangar-least-privilege-evidence-projection-broker-and-deploy-gates-2026-05-05.md`
- `70-jangar-actuation-escrow-and-deploy-proof-lanes-2026-05-05.md`
- `70-jangar-promotion-authority-ledger-and-rollout-rehearsal-cells-2026-05-05.md`
- `69-jangar-evidence-escrow-and-repair-cell-contract-2026-05-05.md`

## Executive Summary

The decision is to add a **materialized run proof** layer between Jangar admission and Kubernetes object creation.
Evidence projections decide whether an action may proceed. Materialized run proof decides whether the action was
actually made runnable: the schedule template exists, the target manifest is valid, the runtime image has required
collaboration tooling, workspace storage is attached under the right sharing contract, and downstream Torghut profit
consumers can cite the same proof before using Jangar evidence.

I am choosing this because the current May 5 evidence shows a remaining failure class that the existing evidence-clock,
actuation-escrow, authority-ledger, and projection-broker designs approach but do not close. Jangar is serving,
controller heartbeats are healthy, and the database/migration projection is healthy. At the same time, live schedule
pods are hitting missing ConfigMap mounts, Codex review jobs showed RWO PVC multi-attach contention, the workspace PVC
watcher is wired through a resource string that `primitives-kube` does not support, and deployed collaboration
admission is blocked on the missing `nats` CLI. Those are materialization failures: admission can be correct and the
resulting pod can still be unrunnable or unsafe to share storage.

The tradeoff is one more durable proof object. I am accepting that cost because the alternative is letting stage
dispatch, deploy verification, and Torghut capital checks infer materialization from pods and events after the fact.
That is too late. Jangar needs to prove runnable work before dispatch and preserve the proof after failure so engineer
and deployer stages can distinguish a bad decision from a bad materialization.

## Objective and Success Metrics

Runtime inputs for this lane:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarm: `jangar-control-plane`
- stage: `plan`
- channel: `general`

This design succeeds when:

1. every scheduled stage launch, manual stage launch, review job, and Torghut platform-proof read cites a
   `materialized_run_proof_id`;
2. schedule-runner pods are not created until the schedule ConfigMap, target manifest digest, namespace, service
   account, image digest, runtime-kit decision, and admission passport are sealed together;
3. workspace-backed runs cannot share an RWO PVC across concurrent pods unless the proof explicitly classifies the
   access mode as safe for that concurrency pattern;
4. Jangar's PVC watch and workspace status path use the same supported Kubernetes resource mapping as read, apply, and
   delete paths;
5. deploy verification can validate materialized proof under the existing restricted service account without listing
   deployments, reading Argo CD applications, or execing into database pods;
6. Torghut profit-admission checks consume materialized proof rather than treating route-time Jangar status as enough
   platform authority;
7. rollback can disable proof enforcement while preserving proof writes and failure evidence for audit.

## Assessment Evidence

All cluster and database checks in this run were read-only.

### NATS Shared State

The context soak from `workflow.general.>` included two useful updates. The earlier worker had confirmed this branch,
repaired the local NATS publish path by installing the missing local `nats` CLI, and found the first memory reads
failing with `ECONNRESET`. It also reported three evidence surfaces: Jangar serving pods running, hundreds of failed
pods in `agents`, old schedule-runner failures containing the pre-fix namespace expression, a Torghut-sim image-pull
issue that later recovered, source risk in supporting-primitives schedule generation and PVC handling, and data risk in
fresh current-state rows coexisting with huge quant tables and sparse Torghut promotion/autoresearch rows.

I reused that state and re-sampled the live system before making this decision.

### Cluster, Rollout, and Event Evidence

The assessment identity is `system:serviceaccount:agents:agents-sa`.

RBAC evidence:

- the worker can read pods, pod logs, services, events, jobs, CronJobs, PVCs, configmaps, Jangar CRDs, and selected
  secrets;
- it cannot list deployments in `jangar`, cannot read Argo CD Applications, and cannot exec into DB pods;
- this is the right default for a worker, so deploy gates must consume Jangar proofs instead of privileged shell access.

Runtime evidence sampled on `2026-05-05`:

- `kubectl get pods -n jangar` showed `Running 8`; Jangar, Jangar DB, Open WebUI, Redis, Bumba, Symphony, and
  Symphony-Jangar were running.
- `kubectl get pods -n torghut` showed `Running 23` and `Completed 1`; Torghut service, Torghut-sim, Torghut DB,
  ClickHouse, Keeper, TA workers, options workers, websocket forwarders, and exporters were running.
- `kubectl get pods -n agents` showed `Running 16`, `Completed 28`, and `Error 216`.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed missing ConfigMap mounts for current scheduled pods,
  multi-attach warnings for Codex review PVCs, current schedule CronJobs completing, and old failed swarm pods
  remaining in the same namespace.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` showed recent readiness probe failures for Jangar DB and
  Redis after the Jangar serving pod had recovered.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` showed Torghut revisions becoming ready after readiness
  warnings, repeated migration/backfill jobs completing, and ClickHouse PDB ambiguity warnings.

Route evidence:

- `GET /ready` on Jangar returned `status="ok"` and leader election healthy.
- The same response reported `execution_trust.status="degraded"` and collaboration runtime admission blocked on
  `runtime_kit_component_missing:nats_cli`.
- `GET /api/agents/control-plane/status?namespace=agents` returned healthy DB, watch, and rollout surfaces, with
  `25/25` Kysely migrations applied, controller heartbeats fresh, and rollout health healthy.
- The same status route blocked dependency quorum on `empirical_jobs_degraded` and reported all Jangar stages stale.
- `GET /healthz` on Torghut returned healthy and `GET /db-check` returned schema-current.
- `GET /readyz` on Torghut timed out during this pass.
- Jangar quant health for `account=paper&window=15m` returned `status="degraded"`, `latestMetricsCount=0`, and
  `emptyLatestStoreAlarm=true`.
- Jangar market-context health for `NVDA` returned `overallState="degraded"`, with stale technicals, fundamentals,
  news, and regime domains even though provider fetches were succeeding.

Interpretation: serving health is not the main problem. The main problem is that launch materialization and profit
proofs are not first-class authority.

### Source Architecture and High-Risk Modules

Relevant source surfaces:

- `services/jangar/src/server/control-plane-status.ts` composes heartbeats, rollout health, DB consistency, watch
  reliability, execution trust, runtime kits, workflow reliability, dependency quorum, and empirical service status. It
  is the right producer for admission context, but it does not prove that a specific launch has been fully materialized.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already detects collaboration runtime components,
  including `codex-nats-publish`, `codex-nats-soak`, `nats`, the worktree, and `NATS_URL`; the live system proves this
  must become a launch blocker for the deployed runtime image, not only a status fact.
- `services/jangar/src/server/supporting-primitives-controller.ts` builds schedule-runner CronJobs from `Schedule` and
  `Swarm` resources. Current code resolves namespace from `manifest.metadata.namespace`, then `JANGAR_POD_NAMESPACE`,
  then `agents`, which is the right direction, but old schedule pods and current event noise show why the rendered
  template digest must be part of proof.
- The same controller creates workspace PVCs and watches `persistentvolumeclaim` events for workspace reconciliation.
- `services/jangar/src/server/primitives-kube.ts` supports common built-ins and Jangar CRDs, but it does not define
  `persistentvolumeclaim` or `persistentvolumeclaims` in `BUILTIN_RESOURCE_TARGETS`, so the workspace PVC watch can
  fail with `unsupported kubernetes resource: persistentvolumeclaim`.
- `services/jangar/src/server/control-plane-workflows.ts` evaluates workflow reliability from scheduled jobs, but it
  still sees failure after pods exist; materialization proof needs to fail before the pod is created.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts` reports account/window-scoped latest
  metric count, empty-store alarms, and pipeline lag, which should feed Torghut profit admission.

Test gaps:

- no unit or integration test proves a Schedule cannot launch when its template ConfigMap is missing;
- no test proves `persistentvolumeclaim` is a supported first-class Kubernetes resource in `primitives-kube`;
- no admission parity test ties runtime-kit decision, schedule ConfigMap digest, PVC access mode, and AgentRun
  creation into one proof id;
- no route contract test proves Torghut profit admission rejects an empty quant latest store while serving stays up.

### Database, Data, Freshness, and Consistency Evidence

Jangar data evidence:

- Jangar DB status was healthy with latency around `6ms`.
- `kysely_migration` was the active migration table.
- registered migrations: `25`; applied migrations: `25`; latest applied:
  `20260418_embedding_dimension_4096`.
- watch reliability was healthy in the current 15-minute status window, but the live event stream still showed
  materialization failures that status summaries should not smooth over.
- memory-provider configuration was healthy, but the repo memory helper still failed with `ECONNRESET` against
  `/api/memories`, so memory availability must be treated as projected evidence, not assumed from config.

Torghut data evidence:

- Torghut DB check returned `ok=true`, current and expected Alembic head
  `0029_whitepaper_embedding_dimension_4096`, no duplicate revisions, no orphan parents, and
  `schema_graph_lineage_ready=true`.
- parent-fork warnings remain for
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- Torghut `/trading/status` showed the service in `mode="live"` with `live_submission_gate.allowed=true`, while
  `quant_evidence.required=false`, dependency quorum was `informational_only` in the submission gate but `block` in
  hypothesis readiness, all three configured hypotheses were shadow or blocked with `rollback_required=true`,
  empirical jobs were stale from March 2026, and signal lag was about `48314s`.
- Jangar quant health for the default `paper` account had no latest metrics, while Torghut status referenced account
  `PA3SX7FYNUTF`. That mismatch is enough to require account-scoped proof.

Interpretation: schema health is acceptable. Materialized data freshness and account-specific proof are not.

## Problem Statement

Jangar can now decide that a stage should be blocked, held, degraded, or allowed. The next reliability problem is that
the system still lacks a durable answer to: "If this action was allowed, did Jangar materialize exactly the runnable
Kubernetes and storage contract it intended?"

The open failure modes are:

1. a schedule can be active while its step pod cannot mount the generated ConfigMap;
2. a workspace PVC can be created, read, and deleted through ad hoc strings while the watcher rejects the same resource;
3. RWO storage can be attached by multiple pods during review or workflow steps without an explicit concurrency proof;
4. a deployed runtime can be missing `nats` while local workers publish successfully;
5. Torghut can treat Jangar as an informational dependency while a Jangar proof route is empty or stale;
6. route-time status can become healthy after the failure and still lose the exact materialization error needed for
   rollback analysis.

The control-plane contract needs to move from "admitted" to "admitted and materialized".

## Alternatives Considered

### Option A: Patch PVC Resource Support and Schedule ConfigMap Races Only

Add `persistentvolumeclaim` support to `primitives-kube`, tighten schedule-runner reconciliation, and leave existing
admission/projection semantics unchanged.

Pros:

- fastest path to reduce current event noise;
- small implementation surface;
- directly addresses the obvious PVC watcher defect.

Cons:

- does not prove the target manifest digest that launched a run;
- does not stop RWO multi-attach before pods are created;
- does not give Torghut a materialized Jangar proof id;
- does not preserve enough failure evidence for deploy rollback.

Decision: rejected as the architecture answer. The patches are required, but they are not the contract.

### Option B: Global Schedule Quarantine on Any Materialization Error

Freeze all schedules or all swarm stages when a schedule ConfigMap, PVC, or runtime-kit failure is observed.

Pros:

- operationally conservative;
- simple to reason about during an incident;
- reduces repeated failed pods quickly.

Cons:

- over-blocks unrelated stages and namespaces;
- makes repair work compete with normal control-plane progress;
- treats a missing ConfigMap and unsafe storage sharing as the same failure;
- still proves failure after pod creation.

Decision: rejected as the default, retained as an emergency operator action.

### Option C: Materialized Run Proof and Storage-Backed Admission

Compile a durable proof before creating a stage pod or review job. The proof binds admission, target manifest, schedule
template, runtime image, namespace, service account, PVC/workspace contract, and downstream profit-proof consumer
requirements. Dispatchers and deployers consume the proof instead of inferring materialization from events.

Pros:

- fails before pod creation for missing ConfigMaps, blocked runtime kits, and unsafe PVC sharing;
- keeps worker RBAC narrow;
- gives deployers and Torghut one proof id;
- separates storage/materialization failures from execution failures;
- preserves evidence after routes recover.

Cons:

- adds persistence, proof retention, and new enforcement points;
- requires careful compatibility mode while existing schedules are migrated;
- requires source changes in both Jangar schedule/workspace code and Torghut profit admission.

Decision: selected.

## Decision

Implement Materialized Run Proof and Storage-Backed Admission.

Jangar will write a materialized proof for each launchable action before creating workload pods. A proof is required
for these classes:

- `swarm_stage_schedule`
- `manual_stage_launch`
- `codex_review_job`
- `workspace_backed_job`
- `torghut_profit_projection_read`

The proof decision can be `allow`, `hold`, `quarantine`, `veto`, or `shadow`.

## Target Architecture

### Materialized Run Proof Ledger

Add an append-only Jangar read model:

```text
materialized_run_proofs
  proof_id
  action_class
  namespace
  subject_kind
  subject_name
  admission_passport_id
  evidence_projection_snapshot_id
  target_manifest_digest
  rendered_configmap_name
  rendered_configmap_digest
  runtime_image_ref
  runtime_kit_digest
  service_account_name
  workspace_ref
  pvc_name
  pvc_access_modes
  pvc_volume_name
  concurrency_class
  torghut_account
  torghut_window
  decision
  reason_codes
  issued_at
  fresh_until
  superseded_by
```

The ledger is append-only except supersession metadata. Failed proof is not deleted to make readiness green.

### Schedule Materialization Cell

Before a schedule-runner CronJob is active, the controller must prove:

- the generated run ConfigMap exists and contains the expected target manifest digest;
- `manifest.metadata.namespace` resolves to the intended namespace without falling back to a stale expression;
- the target resource is `AgentRun` or `OrchestrationRun`;
- the schedule service account is valid for the target namespace;
- runtime admission for the stage is `allow`;
- the rendered CronJob references the same ConfigMap digest and image digest recorded in the proof.

If any check fails, the Schedule status moves to `Quarantined` with reason code such as
`schedule_configmap_missing`, `schedule_manifest_digest_mismatch`, `runtime_kit_blocked`, or
`schedule_namespace_mismatch`.

### Workspace Storage Cell

Before a workspace-backed job launches, Jangar must classify storage:

- `exclusive_rwo`: one active pod may mount the PVC;
- `shared_rox`: multiple readers may mount;
- `shared_rwx`: multiple writers may mount if the storage class supports it;
- `ephemeral`: no durable PVC is used;
- `unsafe_unknown`: block or quarantine.

The cell also requires `persistentvolumeclaim` and `persistentvolumeclaims` to be supported resources in
`primitives-kube`, so apply/get/list/watch/delete all share one mapping.

### Torghut Profit-Proof Cell

For Torghut consumers, Jangar materializes a profit-read proof that records Jangar projection snapshot id, Torghut
account/window, quant-health status, latest-store count, market-context domain clocks, dependency-quorum decision,
empirical-service status, and freshness expiry.

Torghut may still own economic decisions, but non-observe capital cannot use Jangar evidence unless the Jangar
materialized profit-read proof is fresh and not vetoed.

## Implementation Scope

Engineer scope:

1. Add `persistentvolumeclaim` and `persistentvolumeclaims` to `BUILTIN_RESOURCE_TARGETS` in
   `services/jangar/src/server/primitives-kube.ts`.
2. Add materialized proof persistence and read APIs in Jangar, reusing the existing Kysely migration pattern and keeping
   the schema additive.
3. Extend `supporting-primitives-controller` schedule reconciliation to compile proof before applying CronJobs and to
   update Schedule status with proof ids and typed reason codes.
4. Extend workspace reconciliation to classify PVC access mode and active attachment risk before allowing
   workspace-backed launches.
5. Extend control-plane status and `/ready` to expose latest proof ids per action class while keeping serving readiness
   separate from dispatch/profit authority.
6. Add deploy verification that validates proof through Jangar APIs under the restricted service account.
7. Add a Torghut profit-read proof route or projection consumed by the companion Torghut admission cell.

Non-goals:

- no direct cluster mutation from architecture workers;
- no Argo CD read permission expansion for generic workers;
- no database exec requirement in deploy verification;
- no immediate live-capital promotion for Torghut.

## Validation Gates

Required tests and checks:

- Jangar unit test: `persistentvolumeclaim` resolves through `resolveKubernetesResourceTarget`.
- Jangar controller test: a Schedule with a missing rendered ConfigMap produces `Quarantined` proof and does not create
  a runnable CronJob.
- Jangar controller test: a blocked collaboration runtime kit blocks `swarm_plan`, `swarm_implement`, and
  `swarm_verify` proof.
- Jangar controller test: an RWO workspace with another active pod produces `workspace_pvc_multi_attach_risk`.
- Jangar route test: `/ready` stays serving `ok` while dispatch/profit proof is `hold` or `veto`.
- Jangar integration smoke: current `agents` service account can read proof APIs without deployment, Argo, or DB exec
  privileges.
- Torghut contract test: empty Jangar quant latest store and stale market context produce distinct non-observe capital
  veto reasons.

Local validation before merge:

- `bunx oxfmt --check` on changed TypeScript when code is touched;
- targeted Jangar tests for primitives, controller proof, and ready/status parity;
- targeted Torghut tests for submission council/profit admission if Python code is touched;
- doc-only changes may validate with repository markdown formatting checks and PR template hygiene.

## Rollout

Phase 0: shadow proof writes.

- Add schema and proof compiler.
- Write proof for schedules, workspaces, and Torghut profit reads.
- Do not block existing schedules yet.
- Compare proof decisions against live events for one day.

Phase 1: dispatch enforcement.

- Enforce proof for new Schedule creations and updated Swarm stages.
- Existing schedules continue in compatibility mode unless they are edited.
- Missing ConfigMap, namespace mismatch, blocked runtime kit, and unsafe storage sharing fail closed.

Phase 2: deploy and Torghut enforcement.

- Deploy verification requires proof ids for rollout widening.
- Torghut requires fresh materialized profit-read proof for non-observe capital.
- Jangar status surfaces proof expiry and reason-code counts.

## Rollback

Rollback is a feature-flag change, not data deletion:

1. disable enforcement and keep proof writes on;
2. leave existing proof records available for audit;
3. let schedules fall back to current admission behavior;
4. keep PVC resource support enabled because that is a correctness fix;
5. move Torghut profit-admission consumers back to observe/shadow if proof reads fail during rollback.

## Risks and Mitigations

Risk: proof compilation becomes another request-path bottleneck.

Mitigation: compile proof in controller reconciliation and cache the latest proof by subject; route handlers read the
projection, not Kubernetes live objects.

Risk: enforcement deadlocks all schedules during cutover.

Mitigation: shadow mode first, then enforce only new/updated schedules before widening to all scheduled stages.

Risk: proof retention grows without bound.

Mitigation: keep full payloads for recent windows, compact old successful proofs to digest rows, and retain failed or
vetoed proofs longer for rollback analysis.

Risk: Torghut treats Jangar materialization proof as economic approval.

Mitigation: the proof is platform authority only. Torghut still owns hypothesis, market, execution, and PnL decisions.

## Handoff to Engineer

Start with the low-risk correctness patch: add PVC resource mapping and a regression test. Then add proof shadow writes
for schedules and workspaces. Do not enforce until tests prove the current `jangar-control-plane` and `torghut-quant`
schedules receive proof ids without increasing failed pods.

Acceptance gates:

- PVC watcher no longer logs `unsupported kubernetes resource: persistentvolumeclaim`;
- every active Jangar and Torghut swarm schedule has a current materialized proof id;
- missing ConfigMap and unsafe RWO attachment are typed proof reasons;
- control-plane status exposes proof ids and expiry;
- deploy verification can validate proof with the current restricted service account.

## Handoff to Deployer

Roll out in shadow mode first. Watch schedule pod creation, `agents` Error pod growth, PVC attach events, and Jangar
status proof freshness. Enforce only after shadow proof has covered at least one full schedule cadence for discover,
plan, implement, and verify stages.

Rollback gate:

- disable proof enforcement if schedule creation stalls, proof freshness expires globally, or proof writes become a DB
  bottleneck. Do not delete proof records.
