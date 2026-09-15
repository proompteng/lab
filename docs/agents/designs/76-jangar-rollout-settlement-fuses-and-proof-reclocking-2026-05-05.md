# Jangar Rollout Settlement Fuses and Proof Reclocking

Date: 2026-05-05

Author: Victor Chen, Jangar Engineering

Status: Accepted for implementation planning

Companion Torghut contract:

- `docs/torghut/design-system/v6/80-torghut-capital-proof-reclocking-and-live-submission-fuses-2026-05-05.md`

Extends:

- `docs/agents/designs/75-jangar-failure-domain-leases-and-database-routability-holdbacks-2026-05-05.md`
- `docs/agents/designs/73-jangar-evidence-settlement-and-runtime-freshness-leases-2026-05-05.md`
- `docs/agents/designs/68-jangar-evidence-clock-arbiter-and-rollout-veto-contract-2026-05-05.md`
- `docs/agents/designs/jangar-control-plane-failure-mode-reduction-and-safe-rollout-architecture-2026-03-16.md`

## Decision

Jangar should introduce rollout settlement fuses and proof reclocking before it lets any fresh rollout, workflow
dispatch, or downstream capital consumer use a green status as promotion authority. I am choosing a settlement layer
because the current control plane is serving, but the evidence is not settled: controller heartbeats are fresh, database
migrations are healthy, and rollout health says the configured deployments are healthy, while execution trust remains
degraded, watch streams are restarting, recent events show image-pull and probe instability, and Torghut empirical jobs
are stale.

The selected architecture keeps serving available, but it stops treating route readiness, deployment availability, and
database migration parity as a single clock. A rollout is not promotion-safe until its settlement receipt proves four
fresh clocks at the same cut: rollout events, execution-trust stages, database/schema authority, and workflow artifact
materialization. If any clock is stale, the fuse allows only read-only serving, repair, and verify work. Normal swarm
dispatch, rollout widening, and Torghut non-shadow capital remain held.

The tradeoff is stricter delay after an apparently successful rollout. That is intentional. A rollout that becomes
available after registry 502s or readiness probe timeouts has not proven it can safely widen until the recent-failure
window ages out or a repair receipt closes it.

## Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarm: `jangar-control-plane`
- stage: `discover`
- owner channel: `swarm://owner/platform`
- NATS channel: `general`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  reliability and Torghut profitability.

Success for this artifact means the next engineer can implement one action contract that tells Jangar whether a rollout
is settled, which action classes are allowed, what proof must refresh next, and how the deployer backs out without
mutating database or cluster state during assessment.

## Evidence Captured

All assessment commands were read-only.

### Cluster, Rollout, and Events

- `curl http://jangar.jangar.svc.cluster.local/ready` returned `status: ok`; Jangar is serving and leader election is
  healthy.
- The same readiness payload shows split topology: local `agentsController` and `supportingController` are disabled in
  the serving pod, while `/api/agents/control-plane/status?namespace=agents` uses heartbeat authority and reports
  `agents-controller`, `supporting-controller`, and `orchestration-controller` healthy from
  `agents-controllers-5447c576db-x6nkd`.
- `/api/agents/control-plane/status` reports `database.status: healthy`, `connected: true`, and migration consistency
  `registered_count: 25`, `applied_count: 25`, latest `20260418_embedding_dimension_4096`.
- The same status blocks dependency quorum with `watch_reliability_blocked` and `empirical_jobs_degraded`.
- Watch reliability is degraded in a 15 minute window: `orchestrationruns` had 9 errors and 10 restarts;
  `orchestrations` had 3 errors and 4 restarts.
- Execution trust is degraded for `jangar-control-plane`: 5 pending requirements and stale
  discover/plan/implement/verify stages.
- Rollout health reports 2 configured deployments healthy, but direct Kubernetes events in `agents` show recent
  registry 502 image pulls, `ImagePullBackOff`, readiness probe timeouts, and `BackoffLimitExceeded` jobs.
- From this runtime, direct `kubectl get deployments -n agents` and `kubectl get deployments -n jangar` are forbidden,
  while pod, cronjob, job, and event reads work. Settlement must therefore not depend on one read surface only.
- `bun run --filter memories retrieve-memory` failed with `ECONNRESET` against the Jangar memory API even though the
  status payload reports the memory provider configured and healthy. Route-specific proof remains necessary.

### Source Architecture and Test Surface

The code already has the primitives needed for settlement, but they are not one proof object yet:

- `services/jangar/src/server/control-plane-status.ts` is 572 lines and already assembles controller heartbeats,
  database status, watch reliability, workflow reliability, rollout health, empirical services, execution trust, and
  runtime admission passports.
- `services/jangar/src/server/control-plane-workflows.ts` is 499 lines and already builds dependency quorum and
  workflow reliability windows.
- `services/jangar/src/server/control-plane-execution-trust.ts` is 480 lines and evaluates stage clocks, freeze state,
  pending requirements, and confidence.
- `services/jangar/src/server/control-plane-rollout-health.ts` is 238 lines and models deployment health but not the
  event/probe settlement window.
- `services/jangar/src/server/control-plane-db-status.ts` is 160 lines and checks migration consistency when the
  database is reachable.
- `services/jangar/src/server/control-plane-watch-reliability.ts` is 181 lines and records watch errors and restarts in
  process memory.
- `services/jangar/src/server/__tests__` has 119 test files. Coverage is strong for local contracts, but no regression
  proves that rollout health, event instability, stale stage clocks, route resets, and empirical staleness settle into
  one action fuse.

### Database, Schema, Freshness, and Consistency

- Jangar database connectivity and Kysely migration consistency are healthy through the application status contract.
- The latest applied and registered migration is `20260418_embedding_dimension_4096`; no unapplied or unexpected
  migrations are reported.
- Database health alone is not enough. The same status payload has stale execution clocks and degraded watch streams,
  while memory retrieval through the Jangar API reset from this runtime.
- Torghut data freshness consumed by Jangar is not settled. Torghut reports stale empirical jobs and Jangar dependency
  quorum blocks because `empirical_services.jobs.status === degraded`.

## Problem

Jangar has multiple truthful clocks that can disagree after a rollout:

- Serving readiness can be green while execution trust is degraded.
- Controller heartbeats can be healthy while watch streams are restarting.
- Deployment rollout health can be healthy while recent events still show image-pull and probe failures.
- Database migrations can be current while route-specific API calls reset.
- CronJobs can complete while AgentRun children, ConfigMaps, or workflow artifacts still fail later.
- Torghut can continue to run while the empirical proof Jangar needs for downstream capital is stale.

The missing contract is not another dashboard field. The missing contract is a settled proof cut that every admission
consumer uses for action, with explicit expiry and action classes.

## Options Considered

### Option A: Keep Current Status as the Arbiter

Use `/api/agents/control-plane/status` directly. Consumers read `dependency_quorum`, `rollout_health`, and
`execution_trust` and make local decisions.

Pros:

- Lowest implementation cost.
- Reuses existing API and tests.
- Preserves all current visibility.

Cons:

- Consumers can interpret mixed evidence differently.
- Recent Kubernetes events are not promoted into a settled action receipt.
- Deployment health can recover before the event and artifact windows are trustworthy.
- Torghut still has to infer whether a Jangar proof is safe for capital decisions.

Decision: reject as insufficient. It remains the raw input surface, not the action authority.

### Option B: Freeze Every Non-Healthy Clock

If any Jangar clock is degraded, freeze all schedules and downstream consumers until every status block is healthy.

Pros:

- Simple incident posture.
- Strong blast-radius reduction.
- Easy to explain during an active outage.

Cons:

- Blocks repair and verify work that is needed to clear the failure.
- Treats stale empirical jobs the same as database unreachability.
- Encourages manual bypasses because the action model is too coarse.

Decision: reject as steady state. Keep as an emergency override only.

### Option C: Rollout Settlement Fuses and Proof Reclocking

Create a short-lived `RolloutSettlementReceipt` that joins the relevant clocks at one observed cut and maps the result
to action classes: serve, observe, repair, verify, dispatch, widen, and external capital.

Pros:

- Preserves serving and repair work during degraded windows.
- Blocks normal dispatch and rollout widening until event/probe/artifact clocks settle.
- Gives Torghut a single Jangar proof digest to consume.
- Makes stale clocks measurable instead of spreading interpretation across consumers.

Cons:

- Requires one new persisted/materialized receipt and tests across several current modules.
- Requires an event-window policy so short registry blips do not create permanent holds.
- Requires deployer discipline: green deployment health is not enough until settlement is green.

Decision: select Option C.

## Chosen Architecture

### RolloutSettlementReceipt

Add a materialized receipt produced by Jangar and mirrored into the control-plane status payload.

Required fields:

- `receipt_id`
- `namespace`
- `swarm`
- `release_digest`
- `observed_at`
- `fresh_until`
- `settlement_window_seconds`
- `decision`: `allow`, `observe`, `repair_only`, `hold`, or `unknown`
- `allowed_action_classes`: `serve`, `observe`, `repair`, `verify`, `dispatch`, `widen`, `external_capital`
- `rollout_clock`: deployment readiness plus recent image-pull, probe, and backoff event counts
- `execution_clock`: execution-trust status, pending requirements, and stale stage list
- `database_clock`: connection status, migration parity, and latest migration id
- `workflow_artifact_clock`: recent failed jobs, missing ConfigMaps, and active retry count
- `watch_clock`: watch stream errors, restarts, and observed resource set
- `route_clock`: route probes required by action class, including memory and control-plane status routes
- `empirical_clock`: Torghut empirical job status, stale job ids, and authority flag
- `negative_evidence_refs`: compact references to events or routes that force a hold
- `repair_hints`: smallest proof expected to reopen each held action class

### Action Matrix

- `serve`: allowed when the serving route and minimum runtime kit are valid.
- `observe`: allowed when read-only routes are valid and the receipt is not `unknown`.
- `repair`: allowed when collaboration runtime is valid, even if rollout or empirical clocks are held.
- `verify`: allowed when database and artifact clocks are valid or the verify job is explicitly scoped to repair.
- `dispatch`: allowed only when execution, workflow artifact, watch, route, and database clocks are fresh.
- `widen`: allowed only when rollout has no blocking image-pull/probe/backoff events in the settlement window.
- `external_capital`: allowed only when all dispatch and empirical clocks are fresh and Torghut returns no active
  capital holdback.

### Engineer Scope

Implement in this order:

1. Add a pure settlement builder under `services/jangar/src/server/` that consumes existing status components and a
   compact event-window input.
2. Extend `kube-gateway` or an adjacent event collector to read recent warning events for configured namespaces without
   requiring direct deployment RBAC from every runtime.
3. Add `rollout_settlement` to `/api/agents/control-plane/status` and `/ready`; keep degraded receipts visible without
   forcing serving readiness to 503 unless the decision is `unknown` for serving.
4. Feed settlement decisions into `buildDependencyQuorum` so workflow dispatch and rollout widening use the same action
   matrix.
5. Persist or cache the latest receipt in the Jangar database when available, and emit a negative evidence digest to
   NATS/artifact storage when the database is unavailable.

### Validation Gates

- Unit tests cover `allow`, `observe`, `repair_only`, `hold`, and `unknown` decisions.
- Regression tests prove that a healthy deployment rollout plus recent `ImagePullBackOff` blocks `widen`.
- Regression tests prove that healthy database migrations plus stale execution stages blocks `dispatch`.
- Regression tests prove that watch restarts over threshold block `dispatch` but allow `repair`.
- Route tests prove memory/control-plane route resets degrade only the action classes that require those routes.
- Status snapshots include `negative_evidence_refs` without dumping raw event logs.
- Documentation examples show how deployer and Torghut consumers read the receipt.

### Rollout and Rollback

Roll out in shadow first:

1. Emit `rollout_settlement` with `decision_shadow` while existing dependency quorum remains authoritative.
2. Compare shadow decisions against current dependency quorum for 24 hours or three rollouts, whichever is longer.
3. Enable dispatch gating after shadow parity is understood.
4. Enable rollout widening gates last.
5. Enable Torghut external-capital consumption only after the companion Torghut route parity tests pass.

Rollback is configuration-only:

- Disable settlement enforcement and keep the receipt in observe mode.
- Preserve receipts and negative evidence for post-incident analysis.
- Do not delete receipt tables or cached proof while rolling back behavior.

## Handoff

Engineer acceptance gate: a single settlement receipt must explain why the current state allows serving and repair but
holds normal dispatch, rollout widening, and Torghut external capital until watch reliability, execution clocks, route
proof, and empirical jobs refresh.

Deployer acceptance gate: do not widen a Jangar or agents rollout on deployment health alone. Widen only when
`rollout_settlement.allowed_action_classes` includes `widen` for the promoted digest and the settlement window contains
no blocking image-pull, probe, backoff, missing-artifact, or schema drift evidence.

Rollback gate: if settlement enforcement blocks required repair work, disable enforcement for `dispatch` and `widen`
only after creating a manual override receipt that names the expired clocks, the blast radius, and the expiry time.
