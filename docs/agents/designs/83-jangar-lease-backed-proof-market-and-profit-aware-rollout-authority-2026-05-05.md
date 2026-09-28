# 83. Jangar Lease-Backed Proof Market and Profit-Aware Rollout Authority (2026-05-05)

Status: Accepted for engineer and deployer handoff
Date: 2026-05-05
Owner: Victor Chen, Jangar Engineering
Scope: Jangar control-plane resilience, least-privilege rollout authority, schedule dispatch safety, and Torghut
profit-aware capital recovery.

Companion Torghut contract:

- `docs/torghut/design-system/v6/87-torghut-capital-lease-consumer-and-profit-repair-marketplace-2026-05-05.md`

Extends:

- `82-jangar-proof-runway-cutover-and-consumer-authority-2026-05-05.md`
- `82-jangar-authority-clearance-cells-and-negative-evidence-slas-2026-05-05.md`
- `81-jangar-action-authority-ledger-and-repair-runway-2026-05-05.md`
- `79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`

## Decision

Jangar should turn the proof runway and clearance-cell designs into a lease-backed proof market. Every material action
class gets a short-lived `ControlPlaneActionLease` before it can launch a schedule, widen a rollout, clear a deployer
gate, or grant Torghut paper/live capital authority. A lease is not a ticket and not a dashboard badge. It is the
signed decision that says which proof was fresh enough, which negative evidence remains open, which repair budget is
allowed, and when the authority expires.

I am choosing this over either local hardening only or a global freeze model. The live evidence is mixed. Jangar is
serving, leader election is held, the Jangar database route reports current migrations, and the agents deployments are
available. The same sample shows stale verify authority, degraded watch reliability, image platform pull failures in
older scheduled pods, controller readiness probe failures, and RBAC that prevents database exec or CNPG reads from the
least-privilege agent identity. Torghut is also mixed: the service is live and schema-current, but empirical proof is
stale from 2026-03-21, live submission is disabled, all hypotheses are shadow or blocked, and the 72-hour runtime
window has decisions without executions or TCA samples.

The architecture therefore needs a precise middle state: serve, observe, and repair stay open, while dispatch, rollout
widening, and capital actuation require fresh leases. The tradeoff is one more persistence and route contract. I accept
that because the current failure mode is distributed interpretation, not lack of facts.

## Scope and Success Metrics

The engineer and deployer stages should treat this document as the implementation contract for the next six months of
Jangar control-plane resilience work.

Success means:

1. Schedule dispatch cannot create a runner CronJob unless a fresh `dispatch` lease exists for the schedule template,
   runtime image, service account, namespace, and workspace storage decision.
2. Rollout widening cannot proceed unless a fresh `widen` lease exists for the release digest, route probes,
   execution-trust state, watch reliability, and database schema route proof.
3. Least-privilege deployers can validate the lease bundle without Kubernetes Deployment reads, CNPG reads, database
   exec, or secret access.
4. Degraded proof creates or updates a clearance cell with owner, close condition, due time, rollback switch, and repair
   budget; it does not silently become a permanent block.
5. Torghut paper or live capital cannot exceed the lease decision for the same account, window, release digest, and
   hypothesis family.
6. The system emits shadow comparisons for at least seven days before hard enforcement changes dispatch or rollout
   behavior.

## Evidence Snapshot

All cluster and database checks for this pass were read-only.

### Cluster, Rollout, and Event Evidence

- `kubectl config current-context` was unset, so I initialized the in-cluster service-account context locally and
  confirmed identity as `system:serviceaccount:agents:agents-sa`.
- `kubectl get pods -n jangar --sort-by=.status.startTime` showed Jangar, Jangar Postgres, Redis, Bumba, Symphony,
  Open WebUI, and Alloy running. The current Jangar pod was `2/2 Running`.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned `status=ok`; leader election was enabled, required, and
  held by `jangar-584d75f4f6-zt9b2`.
- `GET /api/agents/control-plane/status?namespace=agents` reported Jangar database `configured=true`,
  `connected=true`, `status=healthy`, 25 registered migrations, 25 applied migrations, and latest applied migration
  `20260418_embedding_dimension_4096`.
- The same status route reported `execution_trust.status=degraded` because `jangar-control-plane:verify` was stale.
- The same status route reported `watch_reliability.status=degraded` over a 15-minute window, with 2357 observed
  AgentRun events, 3 total errors, and 5 total restarts across watched streams.
- The same status route reported `rollout_health.status=healthy` for `agents` and `agents-controllers`, with 3 ready
  replicas across 3 desired replicas. This is useful rollout proof, but not enough material-action authority.
- `kubectl get pods -n agents --sort-by=.status.startTime` showed current agents serving pods running, while older
  scheduled work remained in `ImagePullBackOff`, `Error`, or long-running failed states.
- `kubectl get events -n agents --sort-by=.lastTimestamp` showed old image pull failures with `no match for platform in
manifest`, `BackoffLimitExceeded`, current CronJob completions, and recent readiness/liveness probe failures on
  `agents` and `agents-controllers`.
- `kubectl get pods -n torghut --sort-by=.status.startTime` showed Torghut live, Torghut sim, Postgres, ClickHouse,
  Keeper, TA workers, options services, websocket forwarders, and exporters running.
- `kubectl get events -n torghut --sort-by=.lastTimestamp` showed recent Knative live and sim revision readiness,
  completed bootstrap/backfill jobs, Flink options TA restart exceptions before returning to running, and multiple PDB
  matches on ClickHouse pods.

### Source Architecture and Test Evidence

- `services/jangar/src/server/control-plane-status.ts` is already the control-plane fact aggregator for database
  status, execution trust, rollout health, watch reliability, runtime admission, workflows, and dependency quorum.
  It returns facts, not a material action lease.
- `services/jangar/src/server/control-plane-runtime-admission.ts` already creates runtime kits and admission passports.
  The missing step is to bind those passports to release digest, image platform proof, schedule materialization proof,
  database route proof, and Torghut consumer proof.
- `services/jangar/src/server/supporting-primitives-controller.ts` owns schedule ConfigMaps, schedule runner CronJobs,
  workspace PVC lifecycle, and the schedule/PVC watches. That makes it the right first enforcement point for `dispatch`
  leases.
- `services/jangar/src/server/primitives-kube.ts` has common Kubernetes resource targets but no
  `PersistentVolumeClaim` or `persistentvolumeclaim` built-in target, while the supporting controller uses
  `persistentvolumeclaim` for workspace reads, deletes, and watches. That is a concrete storage proof gap.
- `services/jangar/src/server/control-plane-rollout-health.ts` can report green deployments while event and
  execution-trust evidence still blocks dispatch or widening. The lease needs to preserve that distinction.
- Existing tests cover readiness, status, runtime admission, watch reliability, supporting schedules, and primitives
  kube behavior. The missing tests are cross-surface lease parity tests that assert `/ready`, control-plane status,
  schedule reconciliation, deploy verification, and Torghut authority agree on the same lease digest.

### Database, Schema, and Data Evidence

- Direct CNPG reads are blocked for this runtime. `kubectl get clusters.postgresql.cnpg.io -n jangar` and
  `kubectl get clusters.postgresql.cnpg.io -n torghut` both failed with `Forbidden`.
- Direct SQL is blocked for this runtime. `kubectl cnpg psql -n jangar jangar-db -- -c 'select current_database();'`
  and the equivalent Torghut command both failed because `pods/exec` is forbidden.
- The Jangar database route is healthy and migration-current, so lease validation should depend on application-level
  schema proof rather than privileged database shell access.
- `GET http://torghut.torghut.svc.cluster.local/db-check` returned `ok=true`, `schema_current=true`, current and
  expected Alembic head `0029_whitepaper_embedding_dimension_4096`, and lineage ready. It still reported historical
  parent-fork warnings for `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- `GET /trading/health` returned HTTP 503 with `status=degraded` because `live_submission_gate.ok=false` and
  `simple_submit_disabled`, while scheduler, Postgres, ClickHouse, Alpaca, universe, empirical job route health, DSPy
  route status, and optional quant evidence were usable.
- `GET /trading/status` reported `mode=live`, `execution_lane=simple`, `live_submission_gate.allowed=false`,
  `capital_stage=shadow`, three hypotheses, zero promotion eligible, and three rollback required.
- `GET /trading/empirical-jobs` reported four stale but truthful empirical jobs from `2026-03-21T09:03:22Z`.
- `GET /trading/profitability/runtime?hours=72` reported an active 72-hour window with 8 decisions, 0 executions, 0
  TCA samples, zero realized PnL proxy, and live submission still blocked.

## Problem

Jangar has accurate local facts, but material authority is still assembled by readers at the edge. The serving route,
status route, schedule controller, deployer checks, and Torghut capital consumers each see a different slice of truth.
That produces five concrete failure modes:

1. a schedule runner can be materialized before image platform proof, ConfigMap readback, service account, and storage
   proof are known to be runnable;
2. rollout health can be green while verify, watch reliability, route proof, or empirical freshness still block a
   higher-risk action class;
3. least-privilege agents cannot prove deployment safety when the only authoritative path requires database exec or
   privileged Kubernetes reads;
4. Torghut can be live and schema-current while no profitable capital authority exists;
5. negative evidence can become either folklore or a global freeze because no short-lived action authority names its
   owner, repair budget, and close proof.

The control plane does not need another status field. It needs a lease that binds facts to action classes, expires
quickly, and settles open debt into repair work.

## Alternatives Considered

### Option A: Harden Local Seams Only

Patch `PersistentVolumeClaim` support in `primitives-kube`, add image platform checks before schedule creation, make
verify freshness stricter, and add more route probes.

Pros:

- removes known sharp edges quickly;
- fits small implementation PRs;
- improves current schedule and storage reliability;
- reduces the chance of another image-platform `ImagePullBackOff` loop.

Cons:

- does not give deployers one least-privilege authority object;
- does not bind schedule, rollout, database, and Torghut proof to one digest;
- leaves Torghut to reinterpret Jangar facts for capital;
- does not convert held actions into owned repair work.

Decision: required as implementation work, but insufficient as the architecture.

### Option B: Global Freeze on Any Degraded Signal

Freeze schedules, rollout widening, and Torghut capital whenever execution trust, watch reliability, database proof,
or empirical proof is degraded.

Pros:

- simple incident posture;
- prevents accidental widening;
- easy to explain during a severe outage.

Cons:

- blocks the repair work needed to recover;
- treats stale empirical proof, image platform errors, route timeouts, and readiness probe blips as equivalent;
- encourages manual bypass because it is too blunt;
- still depends on humans to decide when the freeze can clear.

Decision: keep a global emergency brake, but reject it as the default model.

### Option C: Lease-Backed Proof Market

Materialize short-lived action leases from proof bids and repair bids. Lease consumers fail closed for material action
classes but remain open for serve, observe, replay, and bounded repair.

Pros:

- creates one digest for schedule, rollout, deployer, and Torghut consumers;
- supports least-privilege verification through route projections;
- gives negative evidence an owner, deadline, repair budget, and close proof;
- lets healthy serving coexist with held dispatch or capital;
- turns Torghut opportunity cost into a first-class prioritization input.

Cons:

- adds persistence, deduplication, and route work;
- requires a shadow period to avoid breaking current schedule behavior;
- needs strict language so a lease is not mistaken for a profit guarantee.

Decision: select Option C.

## Chosen Architecture

### ControlPlaneActionLease

Jangar persists one lease per action class, subject, release digest, namespace, and evidence cut:

```text
control_plane_action_lease
  lease_id
  lease_digest
  namespace
  action_class              # serve, observe, repair, verify, dispatch, widen, paper_submit, live_submit
  subject_kind              # release, schedule, rollout, route, swarm_stage, torghut_account_window
  subject_ref
  release_digest
  evidence_cut_digest
  decision                  # allow, degrade, hold, block
  enforcement_mode          # observe, shadow, enforce
  opened_at
  fresh_until
  producer_revision
  required_proof_refs
  negative_evidence_refs
  clearance_cell_refs
  repair_budget_ref
  rollback_switch_ref
```

Leases must expire. Time alone must never turn a hold into allow. Expiry creates a new proof request, not implicit
authority.

### ProofBid

A proof bid is an input to the lease market. It says what a producer can prove without privileged access:

```text
proof_bid
  bid_id
  producer
  subject_ref
  proof_kind                # database_schema, image_platform, schedule_template, route_health, watch_window, tca
  proof_digest
  observed_at
  fresh_until
  confidence
  source_route_or_resource
  least_privilege_safe
  blocked_reasons
```

Initial proof producers should be the existing Jangar status route, runtime admission snapshot, watch reliability
collector, rollout health collector, schedule controller, and Torghut status/profitability routes.

### RepairBid

A repair bid is the bounded work allowed while a material action is held:

```text
repair_bid
  bid_id
  clearance_cell_id
  owner
  repair_action             # proof_refresh, retry, image_rebuild, route_probe, empirical_backfill, manual_review
  budget_class              # low, bounded, expensive, manual
  max_attempts
  due_at
  close_condition
  rollback_switch_ref
  expected_risk_reduction
  expected_profit_recovery
```

The market is internal prioritization, not currency. It chooses what to repair first when multiple negative evidence
items compete for the same operator or compute budget.

### LeaseBundle Route

Expose a least-privilege route:

```text
GET /api/agents/control-plane/lease-bundle?namespace=agents&release_digest=...
```

The bundle returns the latest leases, proof bids, repair bids, clearance cells, and consumer projections. It must not
require database credentials, secret reads, Deployment list permission, CNPG access, or pod exec.

### Schedule Dispatch Enforcement

`supporting-primitives-controller.ts` should request or read a `dispatch` lease before it writes a schedule runner
CronJob. Shadow mode records the would-block decision and still reconciles. Enforce mode deletes or withholds the
runner resources when no valid lease exists.

The first dispatch lease must include:

- schedule template digest and ConfigMap readback;
- runtime image ref, image digest, and observed platform compatibility;
- service account and namespace;
- workspace storage decision, including `PersistentVolumeClaim` target support;
- runtime kit and admission passport digest;
- execution-trust and watch-window digest.

### Rollout and Deployer Enforcement

The deployer should require a `widen` lease before widening an agents or Jangar release. The lease must include serving
readiness, rollout health, execution trust, watch reliability, database route proof, and recent event-window proof.

Rollback is simple: set enforcement to `shadow` or `observe` for the release digest, or apply the existing GitOps
rollback. The lease route must keep the previous hold/block evidence visible after rollback.

### Torghut Consumer Enforcement

Torghut receives `paper_submit` and `live_submit` leases through the companion contract. Jangar does not decide that a
strategy is profitable. It decides whether the control-plane evidence allows Torghut to use fresh profit proof for a
capital action. Missing or expired Jangar leases hold capital even when Torghut route health is green.

## Implementation Plan

1. Add Jangar persistence for leases, proof bids, repair bids, and lease settlement events.
2. Add a lease builder that consumes `control-plane-status.ts`, runtime admission, rollout health, watch reliability,
   database route proof, schedule proof, and Torghut route proof.
3. Add the least-privilege lease bundle route and tests for redaction, expiry, and digest stability.
4. Add `PersistentVolumeClaim` targets in `primitives-kube.ts` and regression tests for workspace proof reads.
5. Add shadow-only schedule dispatch evaluation in `supporting-primitives-controller.ts`.
6. Add deployer validation that requires a `widen` lease before rollout widening.
7. Add Torghut lease consumption for paper/live capital decisions.
8. Run shadow comparisons for seven days, publish mismatches, then move dispatch and widen to enforce.

## Validation Gates

Engineer acceptance:

- Unit tests prove lease digest stability, expiry behavior, and fail-closed decisions for missing proof.
- Schedule tests prove a missing or held `dispatch` lease blocks CronJob creation in enforce mode and records a shadow
  decision in shadow mode.
- `primitives-kube` tests prove `PersistentVolumeClaim` and `persistentvolumeclaim` resolve to core `v1` PVC targets.
- Route tests prove the lease bundle is available without privileged Kubernetes or database access.
- Torghut contract tests prove capital decisions consume the Jangar lease for the same account, window, and release.

Deployer acceptance:

- A release candidate publishes a lease bundle with `serve=allow`, `observe=allow`, `repair=allow`, and explicit
  decisions for `dispatch`, `widen`, `paper_submit`, and `live_submit`.
- Widening is blocked if verify is stale, watch reliability is degraded beyond policy, database route proof is missing,
  or route proof expires.
- Rollback leaves the previous lease and negative evidence queryable for post-incident analysis.
- No gate requires `pods/exec`, secret reads, database credentials, CNPG cluster reads, or cluster-admin privileges.

Torghut acceptance:

- Shadow decisions and repair auctions continue while paper/live leases are held.
- Paper canary requires fresh Jangar `paper_submit` lease, fresh empirical proof, at least 40 paper executions in the
  current hypothesis window, average absolute slippage under 12 bps, and post-cost expectancy above 6 bps.
- Live canary requires all paper gates plus a Jangar `live_submit` lease, no open high-severity clearance cells, and a
  rollback bundle that proves kill switch, GitOps revert, and strategy-disable dry runs.

## Rollout

Phase 0 is documentation and PR merge.

Phase 1 adds persistence and routes in observe mode. No runtime behavior changes.

Phase 2 enables shadow evaluation for schedules, rollout widening, and Torghut capital. Every would-block result must
name its lease digest and close condition.

Phase 3 enforces `widen` leases for deployer widening and keeps schedule dispatch in shadow.

Phase 4 enforces `dispatch` leases for schedule runner creation.

Phase 5 lets Torghut move from shadow to paper only when the Jangar lease and Torghut profit proof both pass.

## Rollback

- Set lease enforcement mode to `observe` for the affected namespace or release digest.
- Disable schedule dispatch enforcement while retaining shadow logging.
- Disable Torghut paper/live lease enforcement while preserving capital shadow defaults.
- Revert the GitOps release if the route or persistence layer causes serving degradation.
- Keep lease, proof bid, repair bid, and clearance cell history for the failed release digest.

## Risks

- Lease objects can become another noisy status layer unless deduplication is strict.
- Shadow mode must be long enough to catch false holds before enforcement.
- Proof freshness windows need product-specific tuning. Jangar rollout proof and Torghut capital proof should not use
  the same TTL by default.
- Profit repair bids can prioritize the wrong hypothesis if opportunity-cost estimates are treated as realized PnL.
- Least-privilege route proof is only useful if it is faster and more reliable than direct cluster inspection.

## Handoff Contract

Engineer stage owns persistence, lease builder, route projection, schedule shadow evaluation, PVC target support,
deployer lease validation, and Torghut consumer tests.

Deployer stage owns shadow telemetry, enforcement mode rollout, rollback rehearsal, and CI evidence that the lease
bundle can be validated without privileged cluster or database access.

The next accepted implementation PR should cite this document and the Torghut companion contract, then close with a
lease bundle sample showing at least one allowed serve action, one held material action, one open clearance cell, and
one repair bid.
