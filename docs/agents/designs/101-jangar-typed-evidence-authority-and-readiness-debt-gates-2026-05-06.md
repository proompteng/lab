# 101. Jangar Typed Evidence Authority And Readiness Debt Gates (2026-05-06)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-06
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane evidence typing, database/source-schema authority, readiness-debt gates, dispatch
admission, rollout widening, merge-ready claims, and Torghut capital handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/105-torghut-capital-reentry-evidence-feed-and-readiness-debt-netting-2026-05-06.md`

Extends:

- `100-jangar-lease-reconciliation-clock-and-dispatch-expiry-contract-2026-05-06.md`
- `99-jangar-evidence-lease-cells-and-rollout-admission-arbiter-2026-05-06.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`

## Decision

I am choosing a **typed evidence authority with readiness-debt gates** as the next Jangar control-plane architecture
step.

The read-only evidence from this run shows a specific contradiction. The Jangar application database path is healthy:
the status route reports `configured=true`, `connected=true`, 22 ms latency, and 28 registered plus 28 applied Kysely
migrations with no drift. The same status route marks the database failure-domain lease `expired` and marks
`source_schema` `unknown` with `source_schema.database_unroutable`.

The evidence refs explain the mismatch. The lease projector used AgentRun pod names
`jangar-control-plane-plan-sched-cron-29634020-cndb7` and
`jangar-control-plane-plan-sched-zczg7-step-1-attempt-1-4dbnk` as database evidence because their generated suffixes
contained `db`. Those are not database pods. The actual Jangar database pod is `jangar-db-1`, and it is `1/1 Running`.

That is not a database outage. It is an evidence typing failure. I am tightening the classifier now, but the
architecture lesson is broader: Jangar cannot let arbitrary resource-name substrings act as authority for material
action gates. Every material gate needs typed evidence provenance, a conflict policy, a debt window, and a clear answer
for whether the action is allowed, repair-only, observed, held, or blocked.

The tradeoff is stricter projector complexity. I accept that because the alternative is worse: a least-privilege
deployer sees a projected holdback and has no reliable way to distinguish a real database outage from a bad evidence
join.

## Read-Only Evidence Snapshot

No Kubernetes resources or database rows were mutated while collecting this evidence.

### Runtime Scope

- Repository: `proompteng/lab`
- Base branch: `main`
- Head branch: `codex/swarm-jangar-control-plane-plan`
- Swarm: `jangar-control-plane`
- Stage: `plan`
- Runtime identity: `system:serviceaccount:agents:agents-sa`
- Runtime date: `2026-05-06`
- Progress issue: `#5612`

### Cluster And Rollout Evidence

- `kubectl auth whoami` resolved to `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed `jangar-d75944dff-4msq2` at `2/2 Running` and `jangar-db-1` at
  `1/1 Running`.
- `kubectl rollout status deploy/jangar -n jangar` returned `deployment "jangar" successfully rolled out`.
- `kubectl get deploy -n agents -o wide` showed `agents` at `1/1` and `agents-controllers` at `2/2`, both on image
  digest `0bba2aa8`.
- `kubectl rollout status deploy/agents -n agents` and
  `kubectl rollout status deploy/agents-controllers -n agents` both returned successfully rolled out.
- `kubectl get pods -n agents --no-headers` counted `Running 7`, `Completed 92`, and `Error 30`.
- `kubectl get jobs -n agents -o json` counted 26 failed Jobs retained from earlier plan/verify/discover attempts.
- Recent events still included readiness probe deadline failures for `agents-5578648768-bgw4l` and
  `agents-controllers-954b77448-*` about 23 minutes before this evidence snapshot.

### Database And Data Evidence

- `curl http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` generated a status
  payload at `2026-05-06T04:23:36.520Z`.
- Database status was healthy: configured, connected, 22 ms latency, migration table `kysely_migration`, 28 registered
  migrations, 28 applied migrations, zero unapplied migrations, zero unexpected migrations, and latest registered and
  applied migration `20260505_torghut_quant_pipeline_health_window_index`.
- Failure-domain leases were internally inconsistent:
  - `database` was `expired` with evidence refs pointing to non-database AgentRun pods.
  - `source_schema` was `unknown` with reason `source_schema.database_unroutable`.
  - `dispatch_normal`, `deploy_widen`, `merge_ready`, and `torghut_capital` were held.
  - `serve_readonly`, `dispatch_repair`, and `torghut_observe` were allowed.
- Direct database exec and secret reads are not available to this service account, so the deployer contract must rely on
  projected status that is correct enough for least-privilege operation.

### Source Evidence

- `services/jangar/src/server/control-plane-status.ts` gathers database status, rollout health, workflow reliability,
  watch reliability, empirical services, runtime admission, execution trust, and failure-domain leases into the status
  route.
- `services/jangar/src/server/control-plane-db-status.ts` verifies `select 1` and compares registered Kysely migrations
  with the applied migration table.
- `services/jangar/src/server/control-plane-failure-domain-leases.ts` builds material action holdbacks from database,
  route, rollout, registry, storage, workflow-artifact, NATS, and source-schema leases.
- Before this change, `isDatabasePod` treated any pod name containing `db` as database evidence. That matched random
  generated suffixes like `cndb7` and `4dbnk`.
- `services/jangar/src/server/supporting-primitives-controller.ts` already blocks schedule launch when runtime
  admission passports are missing or blocked, which is the right enforcement point after the evidence authority is
  trustworthy.
- `services/jangar/src/server/primitives-kube.ts` already supports `persistentvolumeclaim`, `persistentvolumeclaims`,
  `pvc`, and `pvcs`, so workspace storage evidence can remain typed rather than inferred from free text.

### Torghut Consumer Evidence

- Live Torghut `/readyz` returned HTTP 503 with healthy Postgres and ClickHouse, schema head
  `0029_whitepaper_embedding_dimension_4096`, zero promotion eligibility, three rollback-required hypotheses, and live
  submission blocked on `simple_submit_disabled`.
- Simulation Torghut `/readyz` returned HTTP 200, but only because it is non-live paper mode. It still had zero
  promotion eligibility and dependency quorum fetch/quant freshness gaps.
- Jangar dependency quorum remained `block` on `empirical_jobs_degraded`, with stale `benchmark_parity`,
  `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward`.

## Problem

Jangar is now making material action claims from projected evidence, not from direct human inspection. That is correct,
but it creates a higher bar for evidence quality:

1. A healthy application database check can be overruled by a loose Kubernetes pod classifier.
2. Retained failed pods and jobs can remain valuable for incident history but harmful as current gate authority.
3. Recent readiness probe failures can be current debt even after rollout status says healthy.
4. The source-schema lease can become unknown because a parent database lease was misclassified.
5. Torghut needs a compact capital decision, not a bundle of raw Jangar and Torghut status fields.

The failure mode I want to remove is false safety and false paralysis. A false allow can widen a bad rollout. A false
hold can freeze merge-ready and capital-adjacent work while the actual service is healthy. Both are expensive.

## Alternatives Considered

### Option A: Keep Broad Heuristics And Ask Humans To Interpret Them

Pros:

- No schema or reducer changes.
- Fast to operate when the projection happens to be right.
- Keeps the current failure-domain lease payload shape stable.

Cons:

- The observed false holdback proves the heuristic is too loose.
- Least-privilege deployers cannot inspect secrets or exec into databases to override a bad projection.
- Torghut receives noisy capital signals when the Jangar side is internally inconsistent.

Decision: reject.

### Option B: Turn Off Database Kubernetes Evidence

Pros:

- Removes the specific false positive immediately.
- Trusts the application database check, which is healthy in the current evidence.
- Low code churn.

Cons:

- Loses real pod-level evidence for CNPG disruption targets, terminating database pods, and split readiness.
- Makes rollout and database drain events invisible to material action gates.
- Pushes the system back to route/database query checks only.

Decision: reject as the architecture. The code fix narrows evidence typing without removing database pod evidence.

### Option C: Typed Evidence Authority With Readiness-Debt Gates

This option keeps the failure-domain model but requires every material action input to carry an evidence type,
authority class, freshness window, and debt policy. Readiness debt is tracked separately from current rollout status.

Pros:

- Prevents random resource names from becoming database authority.
- Keeps real database pod readiness and disruption evidence.
- Separates current rollout health from retained historical failures.
- Gives schedule admission and Torghut capital consumers a stable action-scoped contract.
- Aligns with the lease reconciliation clock in design 100.

Cons:

- Requires more explicit reducers and tests.
- Needs a short shadow period before enforcement moves beyond merge/capital gates.
- Requires deployer dashboards to display debt windows, not just health bits.

Decision: select Option C.

## Chosen Architecture

### Typed Evidence Authority

Every material-action input should normalize into a typed record before it affects a lease:

```text
typed_evidence_authority
  evidence_id
  authority_class          # app_db_probe, cnpg_pod, deployment_rollout, watch_stream,
                           # workflow_job, readiness_event, runtime_kit, torghut_proof
  subject_kind             # Service, Pod, Deployment, Job, Event, RuntimeKit, TorghutProof
  subject_namespace
  subject_name
  observed_at
  fresh_until
  confidence               # high, medium, low
  currentness              # current, historical, retained, expired
  action_classes[]
  reason_codes[]
  source_ref
```

Rules:

- Database pod evidence must come from CNPG labels, explicit database labels, or tokenized names such as `jangar-db-1`.
  Generated suffixes like `cndb7` and `4dbnk` are not database evidence.
- Application database probes are authoritative for connectivity and migration consistency but not for pod disruption
  state.
- Kubernetes events are readiness debt, not hard current state, unless they repeat inside the active debt window.
- Retained failed Jobs are historical unless the same swarm/stage/head pair fails inside the current workflow window.
- Torghut proof evidence is consumed as a compact capital proof record, not inferred from route liveness.

### Readiness-Debt Gates

Readiness debt should be projected beside failure-domain leases:

```text
readiness_debt_gate
  namespace
  component
  action_class
  debt_state              # none, observing, repair_only, hold, block
  debt_reason_codes[]
  current_evidence_ids[]
  retained_evidence_ids[]
  debt_opened_at
  fresh_until
  retirement_condition
```

Initial gate policy:

- `serve_readonly` ignores retained Job failures unless route/auth/data corruption evidence is current.
- `dispatch_repair` stays open when storage and collaboration runtime kits are healthy.
- `dispatch_normal` is held only by current workflow failure debt, current source-schema disagreement, or blocked
  runtime admission.
- `deploy_widen` is held by current rollout debt, repeated readiness probe failures in the active window, or current
  registry/image-pull debt.
- `merge_ready` is held by current database/source-schema disagreement on the PR branch, not by stale pod-name
  misclassification.
- `torghut_capital` is held until Jangar typed evidence is clean and Torghut publishes a current proof decision.

### Immediate Code Guard

This PR hardens the current database classifier:

- Keep CNPG labels and database/postgres labels as database evidence.
- Keep tokenized database pod names such as `jangar-db-1`.
- Reject arbitrary name substrings inside generated suffixes.
- Add a regression test with the exact false-positive shape from this run.

This is intentionally small. The broader typed evidence projection should follow as a first-class reducer, not as a
large inline rewrite of failure-domain leases.

## Engineer Handoff

Implement the architecture in four slices:

1. Add a pure typed-evidence normalizer under `services/jangar/src/server/` and unit tests for pod, event, job,
   deployment, runtime-kit, and Torghut proof evidence.
2. Add readiness-debt gate projection to `/api/agents/control-plane/status` in advisory mode.
3. Wire the existing failure-domain lease reducer to consume typed evidence instead of raw pod/event arrays.
4. Enable enforcement in this order: `merge_ready`, `torghut_capital`, `deploy_widen`, then `dispatch_normal`.

Acceptance gates:

- `bunx vitest run --config vitest.config.ts src/server/__tests__/control-plane-failure-domain-leases.test.ts`
- A regression fixture where `cndb7` and `4dbnk` AgentRun pods do not expire the database lease.
- An in-cluster status payload where healthy DB plus 28/28 migrations yields valid database/source-schema leases unless
  a real database pod or app DB probe is degraded.
- Readiness debt appears as advisory status for one release cycle before it changes schedule launch.

## Deployer Handoff

Roll out in advisory-first mode.

1. Deploy the classifier fix and verify the status payload no longer points database evidence at AgentRun suffix pods.
2. Confirm `serve_readonly` and `dispatch_repair` stay allowed while retained failed Jobs exist.
3. Confirm `merge_ready` and `torghut_capital` are held only for current typed debt or current Torghut proof debt.
4. Do not delete retained failed pods as a workaround. Retention is audit evidence; the reducer must age it correctly.
5. If the status route emits conflicting evidence again, stop widening and collect the typed evidence payload before
   changing cluster state.

Rollback:

- Revert the classifier or typed-evidence projection commit.
- Keep schedule admission enforcement at the previous failure-domain lease behavior.
- Keep Torghut capital held until Jangar and Torghut proof evidence agree.

## Risks

- Too narrow a database classifier could miss non-standard database pods without labels. The mitigation is to require
  database deployments to carry explicit labels, not to reopen substring matching.
- Readiness debt can over-hold if events are not deduped by component, rollout revision, and window.
- Enforcement before one clean advisory cycle can freeze normal dispatch on projection bugs.
- Torghut capital depends on the companion proof feed landing with compatible freshness semantics.

## Open Questions

- Should readiness-debt windows be one workflow window, one swarm cadence, or one release cycle for deploy widening?
- Should `merge_ready` be blocked by global control-plane debt, or only by debt that touches the active PR branch and
  its deployment target?
- Should deployers be allowed to acknowledge typed readiness debt for `deploy_widen`, or should only fresh evidence
  retire it?
