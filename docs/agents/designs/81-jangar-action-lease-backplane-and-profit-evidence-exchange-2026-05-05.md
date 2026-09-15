# 81. Jangar Action Lease Backplane and Profit Evidence Exchange (2026-05-05)

Status: Approved for implementation (`plan`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`

Companion Torghut contract:

- `docs/torghut/design-system/v6/85-torghut-profit-evidence-leases-and-capital-repair-loop-2026-05-05.md`

Extends:

- `docs/agents/designs/80-jangar-settlement-adoption-ladder-and-cutover-governance-2026-05-05.md`
- `docs/agents/designs/79-jangar-control-plane-proof-runway-and-consumer-gated-rollout-2026-05-05.md`
- `docs/agents/designs/77-jangar-evidence-settlement-authority-and-data-proof-handoff-2026-05-05.md`
- `docs/torghut/design-system/v6/84-torghut-capital-warrant-adoption-and-profitability-experiment-ladder-2026-05-05.md`

## Decision

Jangar should implement a **ControlPlaneActionLease backplane** as the next architecture step. The backplane turns
settled proof into short-lived, materialized leases for action classes: `serve`, `observe`, `repair`, `verify`,
`dispatch`, `widen`, and `external_capital`. A scheduler, deployer, route, or Torghut capital consumer should not
derive authority by re-reading every raw health endpoint at request time. It should cite a lease id, lease digest,
freshness window, blocked reason set, and source evidence refs.

I am choosing this because the current May 5 evidence shows Jangar serving but still carrying action ambiguity:

- Jangar had `8/8` pods running and `/ready` returned `status=ok` with leader election healthy.
- `/api/agents/control-plane/status?namespace=agents` reported database health with `25/25` migrations applied and
  `latency_ms=2`, but execution trust was degraded for stale discover, plan, and verify stages.
- The same status payload reported dependency quorum `block` because empirical jobs are degraded.
- The `agents` namespace had current running controller pods, but also `5` Error pods, `3` `ImagePullBackOff` pods,
  one Pending pod, and readiness probe timeouts on both controller replicas and the agents API.
- Recent `agents` events included `UnexpectedJob`, `MissingJob`, and older image pull backoffs for Jangar digests.
- Direct CNPG SQL was blocked by RBAC in both `jangar` and `torghut`; the runner service account cannot create
  `pods/exec` in either namespace.
- Jangar's typed Torghut quant-health route timed out after 25 seconds for `account=paper&window=15m`, while the older
  wrong path returned 404.
- Torghut `/healthz` and `/db-check` were healthy, but `/trading/health` returned HTTP 503 because live submission is
  shadow-only, and `/trading/status` showed all three hypotheses shadow or blocked with zero promotion eligibility.

The decision is not to make `/ready` harsher. Serving and repair must stay up. The decision is to make every unsafe
action consume an expiring lease that has already reconciled route health, rollout health, storage, image platform,
schedule ownership, database proof, quant proof, and Torghut profit evidence.

The tradeoff is one more durable projection. I accept that cost because the current alternative is worse: each hot path
keeps performing expensive or partial reads and then makes its own operational judgment.

## Success Metrics

Implementation is successful when the engineer and deployer stages can prove all of the following:

1. Every schedule-created Job and every manual swarm launch records a `control_plane_action_lease_id` before creation.
2. Jangar can return HTTP 200 for `/ready` while the `dispatch`, `widen`, or `external_capital` leases are held.
3. A quant-health request for a common account/window answers from a bounded projection within 500 ms p95 and never
   scans history tables in the request path.
4. A runner with the current `agents` service account can read the projection needed for deploy safety without
   `pods/exec`, app deployment list permissions, or database credentials.
5. Image-pull, controller-readiness, CronJob ownership, PVC readiness, route timeout, and empirical-job freshness
   failures appear as typed lease blockers.
6. Torghut can keep shadow, replay, and repair work running while non-shadow capital is held by the
   `external_capital` lease.

## Evidence Snapshot

All cluster and database assessment for this plan was read-only.

### Cluster and Rollout Evidence

The runtime identity is `system:serviceaccount:agents:agents-sa`. `kubectl config current-context` is unset, but
`kubectl auth whoami` succeeds. That identity can list enough pod, job, CronJob, and event evidence for a lease
projection, but it cannot exec into CNPG pods.

Jangar was serving:

- `kubectl get pods -n jangar` showed `Running 8`.
- The primary Jangar pod was `2/2 Running`.
- Jangar Postgres, Redis, Bumba, Symphony, Open WebUI, and Alloy were running.
- `/ready` reported leader election enabled, required, and leader-held by the active Jangar pod.

The agents namespace was not clean:

- pod summary: `Running 12`, `Completed 16`, `Error 5`, `ImagePullBackOff 3`, `Pending 1`, `Terminating 1`;
- current controller and API pods were running, but recent readiness probes timed out on `/ready`;
- Jangar and Torghut schedule jobs were running beside older failed attempts;
- CronJob events showed manual jobs as `UnexpectedJob` children and old active jobs as `MissingJob`;
- old image digests remained in backoff while the current `e48d29c9` digest was running on the sampled node.

Torghut was serving but still in a repair-sensitive state:

- pod summary: `Running 27`, `Pending 1`;
- current Torghut revision `torghut-00216` and sim revision `torghut-sim-00296` were running;
- migration and backfill jobs were active in the sampled window;
- recent events included startup/readiness probe failures and ClickHouse pods matching multiple PodDisruptionBudgets.

Interpretation: pod availability is necessary but not enough. Lease projection must preserve the difference between
serving health and action authority.

### Source Architecture Evidence

The high-risk surfaces are already identifiable:

- `services/jangar/src/server/control-plane-status.ts` has 572 lines and aggregates database, execution trust, rollout,
  watch, workflow, dependency quorum, runtime admission, and provider facts.
- `services/jangar/src/server/control-plane-execution-trust.ts` has 506 lines and degrades stale stage windows.
- `services/jangar/src/server/supporting-primitives-controller.ts` has 2790 lines and owns schedule materialization,
  CronJob generation, workspace PVC lifecycle, and support-resource watches.
- `services/jangar/src/server/primitives-kube.ts` has 675 lines and defines built-in Kubernetes resource targets. It
  includes ConfigMaps, CronJobs, Deployments, Events, Jobs, Leases, Namespaces, Pods, Secrets, and Services, while the
  supporting controller reads and deletes `persistentvolumeclaim` directly for workspace reconciliation.
- `services/torghut/app/trading/submission_council.py` has the proof-aware live-submission gate and already validates
  the typed Jangar quant-health path.
- `services/torghut/app/trading/scheduler/simple_pipeline.py` still has a local simple-submit guard, which is correct
  as a mechanical switch but not enough as capital authority.

The missing abstraction is not another status field. The missing abstraction is a hot-path proof projection with a
single action contract and bounded freshness.

### Database and Data Evidence

Direct SQL through CNPG was blocked by RBAC:

- `kubectl cnpg psql -n jangar jangar-db -- -c 'select now();'` failed because `pods/exec` is forbidden.
- `kubectl cnpg psql -n torghut torghut-db -- -c 'select now();'` failed for the same reason.

Application and route proof was available:

- Jangar database proof reported configured, connected, healthy, `25` registered migrations, `25` applied migrations,
  and latest migration `20260418_embedding_dimension_4096`.
- Torghut `/db-check` returned `ok=true`, `schema_current=true`, and `schema_graph_lineage_ready=true`.
- Torghut `/trading/status` reported `last_decision_at=2026-05-04T17:25:57.901670Z`, current runtime loops on
  2026-05-05, empirical jobs stale from March 21, TCA last computed on 2026-04-02, and quant evidence
  `quant_health_not_configured`.
- Jangar market-context health for `NVDA` returned a high quality bundle with current technicals and regime data, but
  stale fundamentals and news, so overall state was `degraded`.
- The typed Jangar quant-health route timed out after 25 seconds with zero bytes returned.

Interpretation: schema proof is healthy. Data proof is mixed, and at least one typed proof route is too expensive or
blocked to use synchronously in a trading hot path.

## Problem

The current architecture stack has the right concepts: evidence clocks, settlement authority, proof runway, capital
warrants, and an adoption ladder. What it still lacks is a reliable runtime shape for action decisions under pressure.

There are four failure modes to remove:

1. **Request-time proof overload.** A route such as quant health can time out while trying to answer a consumer gate,
   even if the raw tables contain useful proof.
2. **Consumer-local interpretation.** The scheduler, deployer, Jangar routes, and Torghut can all see the same facts
   but choose different actions.
3. **Privilege-dependent validation.** A worker without `pods/exec` or deployment list rights cannot prove safety if
   the primary design assumes privileged inspection.
4. **Negative evidence loss.** Image-pull backoffs, controller readiness timeouts, CronJob ownership warnings, route
   timeouts, and stale empirical jobs are events today, but they are not always preserved as first-class blockers on a
   dispatch or capital decision.

## Alternatives Considered

### Option A: Patch Each Broken Surface Directly

This option adds PVC support to `primitives-kube.ts`, tunes the quant-health route, adjusts Torghut configuration for
`TRADING_JANGAR_QUANT_HEALTH_URL`, and fixes schedule ownership warnings.

Pros:

- direct improvement to visible failures;
- can land in small engineering PRs;
- reduces immediate event noise.

Cons:

- leaves the next consumer to invent its own readiness interpretation;
- keeps heavy proof in request paths;
- does not give deployers a least-privilege release authority;
- does not preserve negative evidence in one durable action journal.

Decision: required engineering work, but not enough as the architecture.

### Option B: Enforce the Settlement Authority Directly in Every Consumer

Each consumer calls the settlement or proof-runway endpoint before acting. Enforcement becomes strict once the adoption
ladder reaches the right rung.

Pros:

- uses the existing architecture vocabulary;
- avoids another persisted object;
- centralizes decision logic in one route.

Cons:

- makes the route a synchronous dependency for every action;
- still pressures Jangar to perform expensive joins or route probes at request time;
- turns route slowness into scheduler and trading stalls;
- does not help unprivileged deployers when raw proof requires privileged cluster or database access.

Decision: useful for read-path authority, but too fragile for hot-path enforcement.

### Option C: ControlPlaneActionLease Backplane

Jangar continuously reconciles compact action leases from raw evidence. Consumers read leases by namespace, release
digest, swarm/stage, action class, account/window, or route family. Leases expire quickly, cite source evidence, and
include typed blockers. Heavy proof is precomputed into bounded projections.

Pros:

- removes request-time scans and unbounded route probes from scheduler and capital hot paths;
- gives all consumers one action decision for the same proof cut;
- supports least-privilege deployers through a projection route or CRD/status object;
- keeps serving and repair available while dispatch, widen, or capital are held;
- makes negative evidence auditable and easy to test.

Cons:

- adds a reconciler and storage table or CRD/status projection;
- needs careful expiry semantics so stale leases cannot authorize action;
- requires shadow comparison before consumers fail closed.

Decision: select Option C.

## Chosen Architecture

### ControlPlaneActionLease

Jangar should materialize this object in Postgres first, then mirror the current decision to a route and, if useful, to
a Kubernetes status projection:

```text
control_plane_action_lease
  lease_id
  lease_digest
  namespace
  subject_kind                 # swarm, schedule, release, route, torghut_account_window
  subject_name
  release_digest
  action_class                 # serve, observe, repair, verify, dispatch, widen, external_capital
  decision                     # allow, warn, hold, repair_only, unknown
  enforcement_mode             # off, shadow, warn, enforce
  source_runway_id
  source_settlement_epoch_id
  evidence_cut_id
  allowed_until
  observed_at
  blocked_reasons
  source_evidence_refs
  lease_inputs
  consumer_contract_version
```

The lease is intentionally small. Raw events, route payloads, and data proofs stay in their source systems. The lease
stores references and normalized blockers.

### Evidence Inputs

The first implementation should build leases from these inputs:

- Jangar readiness and leader election;
- control-plane status, execution trust, dependency quorum, watch reliability, and rollout health;
- schedule template digest, CronJob name, service account, node selector, target namespace, and recent ownership
  warnings;
- schedule-runner image digest and observed platform compatibility;
- workspace PVC phase and storage class;
- database migration proof from application status, not DB exec;
- route probes for memories, control-plane status, market context, and quant health;
- Torghut profit evidence leases from the companion contract.

### Lease Semantics

Leases must obey these rules:

- `serve` remains allowed when the route can answer and leader election is healthy, even if dispatch is held.
- `repair` remains allowed unless the repair path itself is broken or unsafe.
- `dispatch` requires fresh schedule, image, service-account, PVC, route, database, and execution-trust proof.
- `widen` requires dispatch proof plus clean rollout/event windows for the target release digest.
- `external_capital` requires Jangar platform proof plus a fresh Torghut profit-evidence lease for the account/window.
- missing privileged SQL access is recorded as `privileged_sql_unavailable` and can be satisfied by application
  database proof when the action class allows it.
- route timeout is a blocker for actions that require that route, not a global serving outage.

### Bounded Quant and Data Projections

Jangar should not compute capital gates by scanning historical quant tables at request time. The action-lease
reconciler should read from or create compact latest projections with bounded cardinality:

- latest metrics by strategy/account/window;
- latest pipeline health by stage/account/window;
- freshness summary by route and provider;
- market-context domain summary by symbol or basket;
- stale or empty proof reason counts.

The typed quant-health route should become a view over that projection. If the projection is stale, the route returns
negative evidence quickly instead of timing out.

### Scheduler and Deployer Consumption

The supporting-primitives controller should shadow-write the lease id into schedule status first. After shadow parity:

- CronJob-created Jobs include the lease id and digest as annotations.
- Manual swarm jobs do the same.
- If `dispatch` is held in warn/enforce mode, the controller records an admitted=false schedule condition instead of
  creating a pod that will fail later.
- Deploy verification reads the lease projection and does not require `pods/exec` into Jangar or Torghut databases.

## Validation Gates

Engineer stage acceptance gates:

- Unit tests for the pure lease builder: healthy serving plus degraded execution trust allows `serve`, `observe`, and
  `repair`, but holds `dispatch`, `widen`, and `external_capital`.
- Regression test for route timeout: quant-health timeout creates `route_timeout:quant_health` on only the dependent
  action classes.
- Regression test for least-privilege DB proof: application migration proof can satisfy schema inputs when CNPG exec is
  unavailable.
- Regression test for schedule ownership warnings: `UnexpectedJob` and `MissingJob` events hold `dispatch` for the
  affected schedule while leaving repair allowed.
- Source-level fix plan for PVC parity: add `persistentvolumeclaim` and `persistentvolumeclaims` to `primitives-kube.ts`
  or keep all PVC operations behind the supporting controller with an explicit test that documents the boundary.

Deployer stage acceptance gates:

- Shadow leases are visible for `jangar-control-plane` discover, plan, implement, and verify schedules.
- The active Jangar release digest has fresh `serve`, `repair`, and `dispatch` lease decisions.
- One forced or observed quant-health timeout produces a fast negative lease on the next reconciliation cycle.
- Torghut `/trading/health` and `/trading/status` agree with the external-capital lease for the sampled account/window.
- No deployment widening is permitted from pod readiness alone when lease evidence is stale.

## Rollout Plan

1. **Shadow projection.** Add the lease builder, storage/projection route, and tests. Emit leases but do not gate
   schedules or capital.
2. **Read-path parity.** Add lease ids and digests to control-plane status, schedule status, deploy verification, and
   Torghut status mirrors.
3. **Warn mode.** Warn and annotate when `dispatch`, `widen`, or `external_capital` would be held. Keep creating Jobs.
4. **Dispatch enforcement.** Hold new schedule-created Jobs when the dispatch lease is stale or blocked; keep repair
   and observe paths open.
5. **Widen enforcement.** Require the release lease before rollout widening.
6. **External-capital enforcement.** Require the companion Torghut profit-evidence lease before non-shadow order
   warrants or capital widening.

## Rollback Plan

Rollback is configuration-only:

- set action-lease enforcement mode to `off` to stop blocking consumers;
- keep shadow lease emission active unless it is causing load;
- keep negative evidence writes so the incident can be replayed;
- if the projection route is unhealthy, consumers fall back to existing status routes in warn mode only;
- never delete lease history during rollback.

## Risks and Mitigations

- **Risk: stale leases authorize unsafe work.** Mitigation: short `allowed_until`, monotonic evidence cuts, and fail
  closed for missing lease on `dispatch`, `widen`, and `external_capital` after enforcement.
- **Risk: lease builder becomes another large status module.** Mitigation: keep the builder pure, source adapters
  small, and store references instead of raw payloads.
- **Risk: over-blocking repair.** Mitigation: action classes are separate; repair and observe gates must have explicit
  tests.
- **Risk: projection drift from source truth.** Mitigation: shadow comparison and route parity gates before
  enforcement.
- **Risk: Torghut capital waits on platform proof and loses opportunity.** Mitigation: shadow and replay work continue,
  and only non-shadow capital requires the lease.

## Handoff Contract

Engineer:

- implement the pure lease builder before any persistence side effects;
- make quant-health route behavior bounded and fast by reading compact projections;
- add the PVC parity decision and tests;
- wire schedule status annotations in shadow mode first;
- add route-parity tests across `/ready`, control-plane status, schedule status, deploy verification, and Torghut
  mirrors.

Deployer:

- do not enable dispatch enforcement until shadow leases exist for all four Jangar stages and one full scheduled loop;
- do not enable widen enforcement until image-pull and controller-readiness blockers are represented in leases;
- do not enable external-capital enforcement until Torghut publishes profit-evidence leases for the sampled account and
  window;
- rollback by disabling enforcement mode, not by deleting leases or turning off diagnostics.
