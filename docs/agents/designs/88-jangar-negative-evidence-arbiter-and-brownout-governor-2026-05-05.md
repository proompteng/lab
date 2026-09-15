# 88. Jangar Negative Evidence Arbiter and Brownout Governor (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, schedule dispatch, rollout widening, database pressure, proof freshness,
negative evidence reconciliation, and Torghut capital dependency authority.

Companion Torghut contract:

- `docs/torghut/design-system/v6/92-torghut-proof-cost-market-and-options-catalog-firebreak-2026-05-05.md`

Extends:

- `87-jangar-database-pressure-fuses-and-capital-authority-backplane-2026-05-05.md`
- `86-jangar-query-budgeted-evidence-receipts-and-admission-firebreaks-2026-05-05.md`
- `75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`
- `72-jangar-materialized-run-proof-and-storage-backed-admission-contract-2026-05-05.md`

## Decision

Jangar should add a **NegativeEvidenceArbiter** and a **BrownoutGovernor** above the existing receipt, fuse, and
backplane contracts.

The previous decisions made positive evidence more durable: evidence receipts, database-pressure fuses, materialized
run proof, and capital authority receipts. The current failure mode is sharper. Positive receipts can still look fresh
while stronger negative evidence is present in Kubernetes events, pod states, database probe failures, application
logs, route timeouts, and consumer route payloads.

I am choosing a contradiction-first architecture: negative evidence that is current, material, and release-scoped must
overrule stale or incomplete positive receipts for material actions. Jangar may keep `serve` and `observe` available,
but `dispatch`, `widen`, `paper_submit`, and `live_submit` move to brownout states until a bounded repair lane produces
fresh proof that directly resolves the contradiction.

This is not another dashboard layer. It is the authority that answers: "What evidence says this action is unsafe even
though a route still returned HTTP 200?"

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster, Rollout, and Events

- The worker ran as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar -o wide` showed all Jangar namespace pods Running, but
  `jangar-847d6d7f8d-zx5sq` had eight app restarts with the latest restart 9 minutes before the sample.
- Jangar warning events included app restart backoff, app readiness connection refusal, and `jangar-db-1` readiness
  probe HTTP 500.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 in 0.018s. It reported leader election healthy,
  collaboration runtime kit healthy, and execution trust degraded for stale plan and verify stages.
- `GET /api/agents/control-plane/status?namespace=agents` returned HTTP 200 in 2.116s. It reported database connected,
  25 registered and 25 applied Kysely migrations through `20260418_embedding_dimension_4096`, watch reliability
  healthy with 571 events and zero errors, and admission passports holding swarm stages because execution trust was
  degraded.
- The same status payload reported `rollout_health.status=degraded` because `agents-controllers` had desired replicas
  2, ready replicas 1, available replicas 1, and unavailable replicas 1.
- `kubectl get pods -n agents -o wide` showed `agents-controllers-649b8656d6-8gjmm` in `CrashLoopBackOff`, the other
  controller replica recently restarting, and stale schedule pods in `Error`, `ImagePullBackOff`, or completed states.
- Agents warning events included controller `/ready` and `/health` failures, `BackoffLimitExceeded`, missing schedule
  input ConfigMaps, `etcdserver: request timed out`, unexpected CronJob children, and stale image `ImagePullBackOff`.
- Direct Deployment reads are forbidden in `jangar` and `agents`, so the design must work from least-privilege pod,
  event, route, and status projections.

### Route, Log, and Database Evidence

- Jangar application logs from the active pod repeatedly showed Postgres connection-slot exhaustion:
  `remaining connection slots are reserved for roles with the SUPERUSER attribute` with SQLSTATE `53300`.
- The same logs showed `sorry, too many clients already`, heartbeat read failures, heartbeat publish failures,
  ClickHouse quant freshness timeouts, and metrics exporter failures to
  `observability-mimir-nginx.observability.svc.cluster.local`.
- `kubectl cnpg psql` was blocked in both `jangar` and `torghut` because this identity cannot create `pods/exec`.
  The smallest unblocker for direct SQL evidence is read-only CNPG exec or a read-only SQL export route.
- `GET /api/torghut/trading/control-plane/quant/health` for both live and sim accounts timed out after 20 seconds with
  HTTP 000. This is negative evidence even when the status route's migration check is green.
- The memory service retrieve path timed out with HTTP 500 during this run. Memory health projected by `/ready` is not
  enough to prove write-path survivability under current database pressure.

### Torghut Consumer Evidence

- Torghut live revision `torghut-00222` had its pod Running and returned HTTP 200 for `/healthz`.
- Live `/readyz` returned HTTP 503 in 3.143s. It showed Postgres, ClickHouse, Alpaca, schema, and universe checks OK,
  but live submission blocked by `simple_submit_disabled`, active capital stage `shadow`, zero promotion-eligible
  hypotheses, and three rollback-required hypotheses.
- Live `/trading/status` returned HTTP 200 in 3.535s and reported `last_decision_at=2026-05-04T17:25:57.901670Z`,
  current loop activity, 12-symbol Jangar universe cache, stale empirical jobs from 2026-03-21 artifacts, and
  dependency quorum blocked on Jangar/database/empirical reasons.
- Torghut `/db-check` returned HTTP 200 in 0.091s with current Alembic head `0029_whitepaper_embedding_dimension_4096`
  and known parent-fork lineage warnings.
- Sim `/trading/health` returned HTTP 200, but alpha readiness was `unknown` because Jangar status fetch timed out and
  quant evidence reported `quant_health_fetch_failed`.
- `torghut-options-catalog /readyz` returned HTTP 503 because a catalog cycle query was canceled with an
  `ANY(%(symbols)s)` parameter payload truncated at 224,790 characters.
- Torghut warning events included Flink recovery suppression, multiple ClickHouse PodDisruptionBudget matches,
  startup/readiness probe churn, options-catalog startup failures, and latest revision readiness timeouts.

### Source Architecture and Test Surface

- `services/jangar/src/server/control-plane-status.ts` composes heartbeat, rollout health, database status, execution
  trust, empirical services, dependency quorum, runtime kits, and admission passports. It is the right projection
  surface, but it can still emit positive receipt fields beside stronger negative evidence.
- `services/jangar/src/server/control-plane-heartbeat-store.ts` calls `ensureMigrations(db)` before heartbeat reads and
  writes. Under connection pressure, heartbeat evidence can fail because the proof path participates in the same
  database pressure it is meant to detect.
- `services/jangar/src/server/db.ts` creates a shared `pg` pool with connect and query timeouts, but no explicit
  action-class or producer-class pool partition in the pool constructor.
- `services/jangar/src/server/memory-provider.ts` creates separate Postgres pools for memory connections without an
  explicit `max` cap in source.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns swarm schedules, runner ConfigMaps, CronJobs,
  workspace PVC reconciliation, and runtime admission traces. It is the dispatch enforcement point for brownout holds.
- `services/jangar/src/server/primitives-kube.ts` knows common built-in resources but still does not expose
  PersistentVolumeClaim in its built-in target map; workspace reconciliation uses `persistentvolumeclaim` directly.
- `services/torghut/app/main.py::_build_live_submission_gate_payload` still has a simple-lane branch that bypasses the
  proof-aware `submission_council` for live mode when simple pipeline mode is active.

## Problem

Jangar can currently hold stale stages, serve `/ready`, report database migration consistency, and still have the active
pod repeatedly fail heartbeat reads because the database rejects connections. The controller status route can cite a
recent heartbeat while Kubernetes reports one controller replica in `CrashLoopBackOff` and the rollout degraded. Torghut
can be schema-current and broker-connected while capital is correctly held and the options catalog is failing on query
shape.

That is a contradiction problem, not a missing-facts problem.

The platform needs an action authority that treats negative evidence as first-class data:

1. a route timeout is evidence, not absence of evidence;
2. a CrashLoopBackOff outranks a stale heartbeat for new dispatch;
3. a database readiness HTTP 500 outranks a green migration count for rollout widening;
4. a canceled proof query should lower proof producer priority before it starves the database;
5. Torghut capital must cite current Jangar authority, not infer safety from local schema health.

## Alternatives Considered

### Option A: Expand the Existing Status Route

Add more fields to `/api/agents/control-plane/status` and ask consumers to inspect them.

Pros:

- Low implementation cost.
- Keeps the current operational surface.
- Easy to roll out without new storage.

Cons:

- Leaves contradiction resolution to every consumer.
- Does not define which source wins when route proof and Kubernetes proof disagree.
- Encourages more expensive request-time proof work on the same route.
- Does not create a bounded repair posture.

Decision: reject as architecture. Keep the status route as a projection, not the arbiter.

### Option B: Global Freeze on Any Negative Evidence

Freeze dispatch, rollout widening, proof jobs, and Torghut capital whenever any critical warning appears.

Pros:

- Conservative.
- Easy to explain during incidents.
- Prevents unsafe expansion during ambiguity.

Cons:

- Blocks repair jobs that need to run to clear evidence.
- Treats stale options catalog proof the same as active controller CrashLoopBackOff.
- Creates pressure for manual bypasses because it is too blunt.
- Does not rank proof producers by value or cost.

Decision: keep only as emergency posture.

### Option C: NegativeEvidenceArbiter and BrownoutGovernor

Collect negative evidence, score contradictions against positive receipts, and emit action-scoped brownout decisions.
Serving and observation remain open when possible. Repair lanes stay open under explicit budgets. Dispatch, rollout
widening, and Torghut capital stay held until the contradiction is repaired.

Pros:

- Reduces repeated failure modes before they create new pods, jobs, or orders.
- Lets negative evidence overrule stale positive receipts without shutting down all repair work.
- Gives engineers a single object to cite before dispatch or rollout widening.
- Gives Torghut a platform authority input for capital decisions.
- Works with least-privilege Kubernetes access because pod, event, log, and route probes are enough.

Cons:

- Adds a new reconciliation object and scoring rules.
- Needs careful expiry so old warnings do not permanently hold the system.
- Requires shadow comparison before enforcement.
- Requires dedupe so the negative evidence stream does not become another noisy queue.

Decision: select Option C.

## Chosen Architecture

### NegativeEvidence

Jangar records compact negative evidence with freshness and action scope.

```text
negative_evidence
  evidence_id
  source_kind                 # kube_event, pod_state, route_probe, app_log, db_probe, consumer_payload
  source_ref
  namespace
  subject_kind                # pod, deployment, route, database, proof_producer, consumer
  subject_ref
  release_digest
  observed_at
  fresh_until
  severity                    # info, warning, material, critical
  reason_code                 # postgres_53300, crash_loop, route_timeout, db_readiness_500, query_canceled
  action_classes              # serve, observe, repair, dispatch, widen, paper_submit, live_submit
  contradicts_receipt_digest
  sample_count
  summary
```

Rules:

- Fresh `critical` or `material` negative evidence always beats an older positive receipt for the same subject and
  action class.
- A route timeout is `material` for the route's action class even if another route is healthy.
- CrashLoopBackOff is `critical` for `dispatch` and `widen` until a fresh rollout receipt proves the new pod is ready.
- Database `53300`, `too many clients`, or readiness HTTP 500 is `critical` for `dispatch`, `widen`, and capital, but
  may allow `repair` under a separate query budget.
- Query-canceled proof producer evidence is `material` for that producer and should lower its priority until the query
  shape is repaired.

### ContradictionSet

The arbiter groups positive and negative evidence into a current contradiction set.

```text
contradiction_set
  contradiction_id
  namespace
  release_digest
  subject_ref
  positive_receipt_digests
  negative_evidence_ids
  dominant_reason_codes
  decision                 # no_contradiction, observe, repair_only, hold, block
  affected_action_classes
  repair_hints
  observed_at
  fresh_until
```

Examples from the current pass:

- `database.status=healthy` plus repeated `postgres_53300` and DB readiness 500 becomes `repair_only` for database
  proof and `hold` for dispatch/widen/capital.
- `agents-controller heartbeat fresh` plus controller CrashLoopBackOff and rollout unavailable replica becomes `hold`
  for dispatch and rollout widening.
- `torghut db-check schema_current` plus options catalog query cancellation becomes `repair_only` for catalog proof and
  `hold` for options promotion.
- `torghut sim health ok` plus Jangar quant health timeout becomes `observe` for sim and `hold` for paper/live capital.

### BrownoutGovernor

The governor emits one current action posture per namespace, release digest, and consumer class.

```text
brownout_governor
  governor_id
  namespace
  release_digest
  consumer_class              # serving, swarm_plan, swarm_implement, swarm_verify, rollout_widen, torghut_capital
  posture                     # normal, observe, repair_only, dispatch_hold, capital_hold, block
  allowed_action_classes
  held_action_classes
  contradiction_ids
  required_repair_receipts
  expires_at
  reason_codes
```

The governor should project into `/ready` and `/api/agents/control-plane/status`, but enforcement belongs at material
action boundaries:

- supporting-primitives schedule reconciliation;
- runner ConfigMap and CronJob creation;
- rollout widening and deployer gates;
- Torghut submission council consumption;
- proof producer admission for high-cost scans.

## Engineer Scope

1. Add pure builders for `NegativeEvidence`, `ContradictionSet`, and `BrownoutGovernor` with fixture-driven tests.
2. Ingest negative evidence from Kubernetes pod state, warning events, route probes, Jangar log classifiers, database
   readiness samples, and Torghut consumer payloads.
3. Add expiry and dedupe keys so repeated `53300`, CrashLoopBackOff, and query-canceled samples collapse into bounded
   evidence.
4. Project the current governor into control-plane status without adding deep request-time proof scans.
5. Wire supporting-primitives schedule reconciliation in shadow mode: record whether the governor would hold schedule
   materialization, runner ConfigMap writes, or CronJob writes.
6. Add first-class PersistentVolumeClaim support to `primitives-kube` so workspace storage proof can use the same
   resource target path as other primitives.
7. Add Torghut consumer fields for Jangar brownout posture to the proof-aware submission council.
8. Add options-catalog query-canceled samples to negative evidence ingestion through the Torghut companion contract.

## Validation Gates

- Unit test: fresh CrashLoopBackOff for an `agents-controllers` pod holds `dispatch` even when a heartbeat receipt is
  fresh.
- Unit test: Postgres SQLSTATE `53300` maps to `repair_only` for database proof and `hold` for dispatch, widen, paper,
  and live.
- Unit test: HTTP 000 from Jangar quant-health route holds Torghut paper/live capital but leaves zero-notional repair
  proof open.
- Unit test: a stale warning expires and no longer holds a release after a fresh positive repair receipt arrives.
- Unit test: PVC get/list/apply parity works through `primitives-kube`.
- Integration test: `/ready` can return HTTP 200 while `swarm_plan` and `rollout_widen` are held by brownout posture.
- Integration test: supporting-primitives records shadow hold decisions without creating new schedule jobs when the
  governor is in `dispatch_hold`.
- Deployer smoke: status projection includes governor ID, release digest, posture, allowed/held action classes,
  contradiction IDs, expiry, and reason codes.

## Rollout Plan

1. Ship pure builders and route projection only.
2. Run shadow comparison for one full swarm schedule cycle and one market session.
3. Enforce `dispatch_hold` for new non-repair schedules when controller CrashLoopBackOff or database `53300` evidence
   is fresh.
4. Enforce `rollout_widen` holds after deployer smoke proves brownout projection is stable.
5. Let Torghut consume the governor in shadow for paper/live capital.
6. Enforce Torghut paper before live after two market sessions with zero false allows.

## Rollback Plan

- Disable governor enforcement and keep projection in observe mode.
- If route projection regresses readiness, remove it from `/ready` and keep the dedicated status projection.
- If negative evidence writes amplify database pressure, switch the arbiter to in-memory latest-state mode with short
  expiry and no persistence.
- If schedule enforcement blocks repair, allow only schedules annotated as repair and continue holding normal dispatch.
- If Torghut consumption regresses, keep local submission council blocks and ignore Jangar brownout posture.

## Handoff Contract

Engineer acceptance:

- The implementation must prove contradictions with deterministic fixture tests before touching enforcement.
- The first enforcement gate is schedule shadow mode, then dispatch hold, then rollout hold. Do not start with Torghut
  live capital.
- Every negative evidence producer must declare expiry, dedupe key, severity, and affected action classes.

Deployer acceptance:

- Before widening, verify `brownout_governor.posture` is not `dispatch_hold`, `capital_hold`, or `block` for the target
  release.
- A rollout is not clean while Jangar app restarts increase, DB readiness is HTTP 500, or controller replicas are
  unavailable, even if `/ready` is HTTP 200.
- Roll back by disabling enforcement first; revert code only if projection itself is destabilizing serving routes.

Open risks:

- The current service account cannot read Deployments or exec into CNPG. The design intentionally works without that
  access, but direct SQL would improve database diagnosis.
- Application log classification must stay narrow. It should capture known fatal patterns like `53300`, route timeout,
  and query canceled, not arbitrary log text.
- Negative evidence must expire aggressively enough to avoid permanently punishing already-repaired releases.
