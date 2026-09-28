# 84. Jangar Material Action Settlement Ledger and SLO Arbiter (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, safe rollout behavior, least-privilege evidence settlement, and Torghut
capital-authority handoff.

Companion Torghut contract:

- `docs/torghut/design-system/v6/88-torghut-profit-slo-lanes-and-session-replay-governor-2026-05-05.md`

Extends:

- `83-jangar-lease-backed-proof-market-and-profit-aware-rollout-authority-2026-05-05.md`
- `83-jangar-clearance-repair-exchange-and-budgeted-proof-closures-2026-05-05.md`
- `82-jangar-authority-clearance-cells-and-negative-evidence-slas-2026-05-05.md`
- `81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`

## Decision

Jangar should add a **Material Action Settlement Ledger** and a **Cross-Plane SLO Arbiter** above action leases,
clearance cells, and repair warrants. The current lease-backed proof-market design is the right direction, but today
the lease is still too easy to read as a local allow/hold decision. The next durable object must settle evidence across
schedule dispatch, rollout widening, database route proof, watch reliability, execution-trust freshness, and Torghut
capital consumers into one action-class decision with an explicit service objective and rollback switch.

I am choosing this because the 2026-05-05 evidence is mixed in a way that local checks cannot safely resolve. Jangar is
serving on image `919848c1`, leader election is held, rollout health is healthy, watch reliability is healthy, and the
Jangar database route reports all 25 migrations applied. The same sample shows stale verify authority, dependency
quorum blocked by stale empirical jobs, older ImagePullBackOff pods, schedule-runner pods with missing ConfigMaps, a
recent Jangar DB readiness 500, and a least-privilege runtime that cannot read CNPG clusters or exec into either
database pod.

The decision is not to freeze the platform. Serving, observe, and bounded repair must stay open. The decision is to
make material actions settle through one ledger record before they can dispatch schedules, widen rollouts, or grant
Torghut paper/live capital authority.

## Scope and Success Metrics

This document is the implementation contract for the plan lane. It is intentionally larger than a patch note because
the current failure mode is system interpretation drift, not a missing condition on one route.

Success means:

1. Every `dispatch`, `widen`, `repair`, `paper_submit`, and `live_submit` action has a settlement record that names the
   subject, release digest, evidence cut, SLO budget, decision, and rollback switch.
2. Schedule dispatch can only settle `allow` when the schedule template ConfigMap was read back, the CronJob template
   hash matches the schedule digest, the runner image digest is current for the release, and required workspace storage
   proof is present.
3. Rollout widening can only settle `allow` when rollout health, execution-trust freshness, watch reliability,
   database route proof, and deployer evidence agree inside the same freshness window.
4. Least-privilege deployers can validate settlement by route projections and Kubernetes events, without CNPG reads,
   `pods/exec`, database credentials, Deployment reads, or secret access.
5. Torghut consumes the same settlement digest for capital authority and cannot reinterpret stale empirical proof as a
   local trading decision.
6. The first release runs in shadow mode for seven days and must show no false `allow` settlements before enforcement.

## Evidence Snapshot

All cluster and database assessment for this pass was read-only.

### Cluster, Rollout, and Event Evidence

- `kubectl auth whoami` identified this runtime as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar --sort-by=.status.startTime -o wide` showed the active Jangar pod
  `jangar-847d6d7f8d-zx5sq` as `2/2 Running`, with app and Docker sidecar restarts at zero for the current revision.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`, with leader election held by
  `jangar-847d6d7f8d-zx5sq`.
- `GET /api/agents/control-plane/status?namespace=agents` reported healthy controllers, healthy rollout for
  `agents` and `agents-controllers`, healthy watch reliability, healthy database migration consistency, and degraded
  execution trust because `jangar-control-plane:verify` is stale.
- The same status route reported `dependency_quorum.decision=block` with reason `empirical_jobs_degraded`.
- `kubectl get pods -A --field-selector=status.phase!=Running,status.phase!=Succeeded` showed stale failed work in
  `agents`: three old ImagePullBackOff pods, three Error pods, and pending shared-cluster capacity in `rook-ceph` and
  `temporal`.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed current digest jobs pulling successfully, but also old
  image-pull backoff for `eba3d511` and `86423d3e`, `BackoffLimitExceeded` for a plan attempt, and schedule pods with
  missing `*-spec` and `*-inputs` ConfigMaps.
- `kubectl get events -n jangar --sort-by=.lastTimestamp` showed the current rollout to `919848c1`, a transient
  startup readiness failure, a recent `jangar-db-1` readiness probe HTTP 500, and a Redis liveness timeout.
- `kubectl get pods -n torghut --sort-by=.status.startTime -o wide` showed Torghut live, sim, Postgres, ClickHouse,
  Flink task managers, options services, and exporters running.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` showed Torghut and Torghut-sim revisions ready, but also
  recent startup/readiness probe failures, scheduling pressure for backfills, Flink checkpoint exceptions, and repeated
  multiple-PDB warnings for ClickHouse pods.

Interpretation: Jangar can serve and report facts. It should not widen or dispatch material work from local green
signals alone.

### Source Architecture and Test Evidence

- `services/jangar/src/server/control-plane-status.ts` is 572 lines and aggregates controller health, rollout health,
  execution trust, workflow reliability, database status, watch reliability, runtime admission, and empirical services.
  It returns a status snapshot, not a settled material-action decision.
- `services/jangar/src/server/control-plane-execution-trust.ts` is 506 lines and evaluates stage freshness, failure
  windows, freezes, and stale evidence. Today it correctly degraded verify authority.
- `services/jangar/src/server/supporting-primitives-controller.ts` is 2878 lines and owns schedule ConfigMaps, runner
  CronJobs, admission traces, swarm schedules, workspace PVC lifecycle, and watches. It is the first enforcement point
  for dispatch settlement.
- `services/jangar/src/server/primitives-kube.ts` has built-in targets for ConfigMap, CronJob, Deployment, Event, Job,
  Lease, Namespace, and Pod, but not `PersistentVolumeClaim`; the supporting controller still uses
  `persistentvolumeclaim` for workspace proof. That mismatch is a storage evidence gap.
- `services/jangar/src/server/control-plane-workflows.ts` blocks dependency quorum on stale empirical jobs, but the
  block is still a status decision. It needs to become a settlement input that downstream consumers cannot reinterpret.
- Existing tests cover control-plane status, readiness, supporting schedules, schedule admission passports, Kubernetes
  resource helpers, and Torghut trading summaries. The missing regression shape is cross-surface settlement parity:
  the same evidence cut must drive `/ready`, control-plane status, schedule reconciliation, deploy verification, and
  Torghut capital authority.

### Database, Schema, and Data Evidence

- Direct CNPG cluster reads are blocked: `kubectl get clusters.postgresql.cnpg.io -n jangar` and the Torghut equivalent
  both returned `Forbidden`.
- Direct SQL is blocked: `kubectl cnpg psql -n jangar jangar-db -- -c 'select current_database();'` and the Torghut
  equivalent both failed because this service account cannot create `pods/exec`.
- The Jangar route-level database proof is healthy: `configured=true`, `connected=true`, `status=healthy`, 25
  registered migrations, 25 applied migrations, and latest applied migration `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, Alembic head
  `0029_whitepaper_embedding_dimension_4096`, and lineage ready, with historical parent-fork warnings.
- Torghut `/trading/health` returned degraded because `live_submission_gate.ok=false` and `simple_submit_disabled`,
  while scheduler, Postgres, ClickHouse, Alpaca, universe, and optional quant evidence were usable.
- Torghut `/trading/status` reported `mode=live`, `capital_stage=shadow`, three hypotheses, zero promotion eligible,
  three rollback required, and dependency quorum blocked on `empirical_jobs_degraded`.
- Torghut `/trading/empirical-jobs` reported four stale but truthful empirical jobs from
  `2026-03-21T09:03:22Z`.
- Jangar's Torghut quant-health proxy timed out after 12 seconds.

Interpretation: settlement must prefer application route proof over privileged database shell proof, and it must record
when the least-privilege path cannot validate a lower-level surface.

## Problem

Jangar now has leases, clearance cells, repair warrants, runtime kits, admission passports, rollout health, database
route proof, and Torghut dependency quorum. Each piece is useful. The problem is that material action authority still
requires a reader to assemble those pieces at the edge.

That creates five failure modes:

1. A schedule can be active while a prior attempt failed on image digest or lost ConfigMap evidence.
2. A rollout can be healthy while verify is stale or Torghut empirical proof blocks capital authority.
3. A workspace PVC can be reconciled through the supporting controller while the common Kubernetes resource map cannot
   target PVCs as first-class proof.
4. A least-privilege deployer can see healthy routes but cannot independently settle database or CNPG truth.
5. Torghut can be live and schema-current while all capital remains shadow because profitability evidence is stale.

The control plane needs one append-friendly settlement record per material action. It should record what was proven,
what was missing, what action is allowed, when that authority expires, and which rollback closes the lane.

## Alternatives Considered

### Option A: Patch Local Gaps Only

Add PVC support to `primitives-kube`, add ConfigMap readback before CronJob creation, tighten schedule runner image
checks, and document the Torghut stale empirical job blocker.

Pros:

- directly fixes visible seams;
- small enough for independent implementation PRs;
- improves current schedule and workspace reliability quickly;
- reduces repeated ImagePullBackOff and missing ConfigMap windows.

Cons:

- does not give deployers or Torghut one action digest;
- still leaves `/ready`, status, schedules, and capital consumers to interpret separate facts;
- cannot prove least-privilege closure across database, rollout, and trading evidence.

Decision: required implementation work, but not enough as the architecture.

### Option B: Global Freeze on Any Degraded Settlement Input

Freeze schedule dispatch, rollout widening, and Torghut capital whenever verify, watch reliability, database route
proof, route proxies, or empirical jobs are degraded.

Pros:

- easy to operate during a severe incident;
- prevents accidental widening;
- simple mental model for oncall.

Cons:

- blocks the repair and proof-refresh work needed to recover;
- treats stale empirical jobs, image platform errors, and route timeouts as equivalent;
- increases pressure for manual bypass;
- wastes market-session time that could be used for zero-notional replay.

Decision: keep as emergency brake, reject as default behavior.

### Option C: Material Action Settlement Ledger and SLO Arbiter

Persist a settlement record for every material action. The arbiter evaluates evidence producers against explicit SLO
budgets and emits a decision that all consumers share.

Pros:

- creates one least-privilege proof surface for schedules, rollouts, deployers, and Torghut;
- preserves serving and repair while holding unsafe dispatch, widening, and capital;
- binds stale or missing evidence to an owner, SLO, budget, and rollback switch;
- makes profitability opportunity cost visible without weakening safety gates;
- gives engineer and deployer stages testable acceptance criteria.

Cons:

- adds one more persistence and projection layer;
- requires shadow rollout to avoid overblocking current automation;
- needs strict dedupe so settlements do not become another noisy status stream.

Decision: select Option C.

## Chosen Architecture

### MaterialActionSettlement

Jangar persists a settlement for each material action class, subject, namespace, release digest, and evidence cut:

```text
material_action_settlement
  settlement_id
  settlement_digest
  namespace
  action_class              # serve, observe, repair, verify, dispatch, widen, paper_submit, live_submit
  subject_kind              # schedule, rollout, swarm_stage, workspace, route, torghut_hypothesis_window
  subject_ref
  release_digest
  evidence_cut_digest
  decision                  # allow, allow_repair, degrade, hold, block
  enforcement_mode          # observe, shadow, enforce
  slo_budget_ref
  lease_refs
  clearance_cell_refs
  proof_bid_refs
  missing_proof_refs
  negative_evidence_refs
  rollback_switch_ref
  opened_at
  fresh_until
  producer_revision
```

Time expiry never turns `hold` into `allow`. Expiry opens a new proof request and keeps the last material action held
until fresh proof settles.

### SLO Budget Arbiter

The arbiter compares evidence to action-specific budgets:

```text
material_action_slo_budget
  budget_ref
  action_class
  max_evidence_age_seconds
  max_route_latency_ms
  max_watch_error_count
  max_recent_restart_count
  max_missing_readback_count
  max_repair_runtime_minutes
  max_repair_retries
  capital_stage_ceiling
  rollback_deadline_seconds
```

Initial budgets should be conservative:

- `dispatch`: schedule ConfigMap readback and CronJob readback inside 60 seconds; zero missing readbacks; runner image
  digest must match release; workspace PVC proof required when the template uses workspace storage.
- `widen`: rollout health healthy, watch reliability healthy, database route proof current, execution trust not stale,
  and no open image or ConfigMap settlement cells for the release.
- `repair`: allow bounded proof-refresh, route probe, and diagnostic runs even while dispatch is held, subject to retry
  and runtime budgets.
- `paper_submit`: Torghut schema current, capital stage at least shadow, fresh empirical jobs, zero open Jangar widen
  cells for the active revision, and hypothesis-specific guardrails satisfied.
- `live_submit`: all `paper_submit` proof plus fresh TCA, drift, market context, rollback dry-run, and human approval
  where policy requires it.

### Evidence Producers

The first implementation should settle from producers already present in the system:

- `/ready` and leader election for serving proof.
- `/api/agents/control-plane/status` for controllers, watch reliability, rollout health, execution trust, database
  route proof, workflows, runtime admission, and dependency quorum.
- Supporting controller readback for schedule ConfigMaps, CronJobs, and workspace PVCs.
- Kubernetes events for ImagePullBackOff, BackoffLimitExceeded, FailedMount, and readiness failures.
- Torghut `/db-check`, `/trading/health`, `/trading/status`, `/trading/empirical-jobs`, and runtime profitability
  routes for capital proof.
- Deployer post-merge verification summaries for release digest and route proof.

### Consumers

Consumers must fail closed for material action classes and remain open for serving:

- The supporting controller may create or keep schedule runner CronJobs only when `dispatch` settlement is `allow`, or
  when a matching `repair` settlement authorizes a bounded repair runner.
- Deployer gates may widen only when `widen` settlement is `allow`.
- Torghut may paper-submit or live-submit only up to the capital stage ceiling on the current settlement digest.
- Jangar UI and NATS updates may display degraded settlements without changing serving readiness.

## Implementation Scope

Phase 0, shadow projection:

- Add settlement types and route projection without enforcement.
- Project current route/status facts into deterministic settlement digests.
- Emit degraded/hold reasons for stale verify, stale empirical jobs, image-pull failures, missing ConfigMaps, DB route
  proof, and quant-health route timeouts.

Phase 1, dispatch proof:

- Add `PersistentVolumeClaim` and `persistentvolumeclaim` built-in targets in `primitives-kube`.
- Add schedule ConfigMap and CronJob readback hashes before dispatch settles `allow`.
- Add tests that a missing ConfigMap or stale runner image blocks `dispatch` while `repair` remains allowed.

Phase 2, deployer and database proof:

- Add deployer verification consumption of settlement digests.
- Record route-level database proof as the supported least-privilege proof path when CNPG reads and SQL exec are
  unavailable.
- Add a rollback switch reference to each widen settlement.

Phase 3, Torghut capital consumer:

- Bind Torghut paper/live authority to Jangar settlement digest and the companion profit SLO lane.
- Keep enforcement in shadow for seven days, then fail closed for new material actions.

## Validation Gates

Engineer acceptance:

- Unit tests cover settlement digest stability, stale verify, stale empirical jobs, missing ConfigMap readback, stale
  runner image, PVC proof, database route proof, and Torghut capital holds.
- Supporting-controller tests prove normal schedule dispatch is held when `dispatch` settlement is not `allow`, and
  repair dispatch is allowed only with a matching repair settlement.
- Control-plane status tests prove dependency quorum and settlement decisions share reason codes.
- Torghut consumer tests prove stale empirical jobs and no execution/TCA samples keep paper/live settlement held.

Deployer acceptance:

- `GET /ready` remains ok during a degraded material settlement when serving is safe.
- `GET /api/agents/control-plane/status?namespace=agents` exposes settlement digests and reason codes.
- A post-merge verification run records the release digest, Jangar database route proof, rollout health, and settlement
  decision.
- No new non-repair schedule pod enters ImagePullBackOff or FailedMount during the shadow window.
- Torghut `/trading/status` and `/trading/profitability/runtime?hours=72` cite the same settlement digest before any
  paper/live capital authority is granted.

## Rollout and Rollback

Rollout:

1. Ship route projection and storage target support with `enforcement_mode=observe`.
2. Run seven days of shadow settlement and compare it against existing schedule, deployer, and Torghut decisions.
3. Move schedule dispatch to shadow fail-closed warnings, then enforce only for newly created schedule runners.
4. Move rollout widening and Torghut capital consumers to enforce after shadow false-positive count is zero.

Rollback:

- Toggle settlement enforcement back to `observe`; do not delete settlement records.
- Revert the enforcing PR if schedule dispatch, deployer verification, or Torghut capital authority regresses.
- If route proof fails but cluster evidence is healthy, keep serving open and disable only material-action enforcement.
- If settlement persistence is corrupt, disable settlement consumers and fall back to existing leases and clearance
  cells until the ledger is repaired.

## Risks

- The ledger can become noisy if every repeated route timeout creates a new settlement. Dedupe by action class, subject,
  release digest, and reason set.
- Too-strict SLOs can block useful repair. Keep `repair` separate from `dispatch` and `widen`.
- Too-loose SLOs can normalize stale proof. `fresh_until` must be enforced and time must not grant authority.
- Least-privilege proof may miss facts that privileged operators can see. The design intentionally treats privileged
  proof as supplemental, not required for routine deployer lanes.
- Torghut profitability evidence is observational. Settlement can authorize a bounded capital lane; it cannot guarantee
  future returns.

## Handoff to Engineer and Deployer

Engineer stage should implement Phase 0 and Phase 1 first. The smallest production-quality slice is settlement digest
projection, PVC target support, schedule readback proof, and tests for stale verify plus stale empirical jobs.

Deployer stage should validate the route projection and shadow settlement against live evidence before any enforcement
toggle. A rollout is ready only when serving remains healthy, material holds match the evidence, and the handoff report
shows no false `allow` decisions.
