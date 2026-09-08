# 67. Jangar Evidence Epochs and Proof-Cell Rollout Contract (2026-05-05)

Status: Approved for implementation (`discover`)
Date: `2026-05-05`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/72-torghut-profit-proof-exchange-and-query-firebreak-contract-2026-05-05.md`

Extends:

- `66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md`
- `65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `61-jangar-runtime-kits-and-admission-passports-contract-2026-03-20.md`
- `57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`

## Executive Summary

I am choosing durable evidence epochs and proof cells as the next Jangar control-plane architecture. The core decision is
that serving, stage dispatch, rollout widening, requirement handoff, and Torghut promotion may no longer recompute their
own independent health answers from live routes. They must cite the same bounded, fresh, typed evidence epoch.

The May 5 evidence is not a generic outage. It is a split-brain authority problem:

- Jangar serves `/ready` and can return HTTP `200`, but execution trust is degraded by five pending
  `jangar-control-plane` requirements and stale `discover`, `plan`, `implement`, and `verify` stages.
- `GET /api/agents/control-plane/status` reports Jangar database connectivity and migration consistency as healthy,
  with `25/25` Kysely migrations applied, while dependency quorum blocks on `agents_controller_unavailable`,
  `workflow_runtime_unavailable`, and `empirical_jobs_degraded`.
- The `agents` namespace has `207` Error pods, `14` Running pods, and `11` Completed pods. One
  `agents-controllers` replica is `0/1` ready and emits readiness probe HTTP `503`.
- Schedule-runner jobs for Jangar and Torghut recently failed with Bun parsing
  `manifest?.metadata?.namespace ?? readEnv("JANGAR_POD_NAMESPACE") || 'agents'`; newer jobs with the parenthesized
  expression complete, but the cluster still carries failed work and duplicate requirement evidence.
- Jangar app logs show repeated `Query read timeout` on control-plane heartbeat reads and heartbeat publishes.
- Direct CNPG psql access is correctly blocked for this runner by RBAC:
  `pods "jangar-db-1" is forbidden ... cannot create resource "pods/exec"`.

The reason I am not selecting another local readiness patch is that the system is already separating availability from
truth. The problem is that only humans can see the separation. The control plane needs one object model that makes that
separation enforceable.

## Mission Inputs and Success Criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- objective: assess cluster, source, and database state, then merge architecture artifacts that improve Jangar
  resilience and safer rollout behavior while improving Torghut profitability.

This design succeeds when:

1. every serving, dispatch, verify, rollout, and promotion surface can cite one `evidence_epoch_id`;
2. every epoch contains bounded proof cells for runtime kit completeness, controller heartbeat, rollout health, NATS
   collaboration, database schema, data freshness, and Torghut profit evidence;
3. request-time routes only project the latest unexpired epoch and never run heavyweight proof queries;
4. rollout widening fails closed when the canary cannot publish a fresher or equivalent epoch;
5. stale proof cells block their consumer class without taking unrelated serving paths down.

## Assessment Snapshot

### Cluster Health, Rollout, and Event Evidence

The cluster is not uniformly unhealthy. It is partially available and partially unable to prove execution authority.

Read-only commands and results:

- `kubectl -n agents get pods --no-headers | awk ...`
  - `Error 207`
  - `Running 14`
  - `Completed 11`
- `kubectl -n torghut get pods --no-headers | awk ...`
  - `ImagePullBackOff 1`
  - `Running 17`
  - `Completed 1`
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -80`
  - shows recent `BackoffLimitExceeded` for `jangar-control-plane-verify-sched-cron-*`;
  - shows successful newer discover cron jobs after the hotfix image;
  - shows `agents-controllers-675b94fc46-5ncwz` readiness probe failing with HTTP `503`.
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -80`
  - shows `torghut-sim-00280` `ImagePullBackOff`;
  - shows the promoted Torghut digest pulling on one node and failing on another with `no match for platform`;
  - shows later `torghut-00202` becoming ready after startup/readiness timeouts.
- `kubectl -n nats get pods,svc -o wide`
  - shows three NATS pods running `2/2`;
  - JetStream custom-resource reads are forbidden to this service account, so NATS stream health must be inferred
    through the CLI soak/publish path and pod state from this runner.

Interpretation:

- The serving plane exists.
- The execution plane is degraded.
- The rollout plane is mixed but progressing.
- The current architecture does not give deployers one evidence id that explains which of those facts applies to which
  consumer.

### Source Architecture and High-Risk Modules

The risky source paths are all places where request-time or controller-local logic substitutes for durable authority.

- `services/jangar/src/routes/ready.tsx`
  - correctly keeps serving alive when execution trust is degraded;
  - still returns a route-local runtime admission snapshot instead of a durable epoch id shared with dispatch and deploy
    verification.
- `services/jangar/src/server/control-plane-status.ts`
  - can report healthy database and degraded dependency quorum in the same payload;
  - reads controller heartbeats from Postgres on the status path, which is why query timeouts become status ambiguity.
- `services/jangar/src/server/control-plane-heartbeat-store.ts`
  - `upsertHeartbeat` and `getHeartbeat` are clear and typed, but the store is used as a live dependency rather than an
    epoch compiler input with a bounded stale projection.
- `services/jangar/src/server/control-plane-runtime-admission.ts`
  - runtime kits and admission passports are the right direction;
  - they need epoch binding and persisted proof-cell inputs so launchers, `/ready`, and deploy verification cite the
    same digest set.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - schedule runner generation now has the parenthesized namespace expression covered by tests;
  - requirement dispatch still reasons from active/failure counters, freeze state, and ingestion pause state rather
    than from one dispatch proof cell;
  - `swarmUnfreezeTimers` remains process-local, which is acceptable as a wakeup optimization but not as recovery truth.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - rollout verification can check readiness and image state;
  - it cannot yet prove evidence epoch parity before promotion.

Test gap:

- We have focused tests for the schedule-runner namespace expression and passport admission behavior, but no
  cross-surface parity test that asserts `/ready`, control-plane status, schedule dispatch, and deploy verification all
  reject or allow from the same epoch.

### Database, Data, Schema, Freshness, and Consistency Evidence

The database story is mixed in a useful way:

- Jangar status reports:
  - `database.connected=true`
  - `database.status="healthy"`
  - `migration_consistency.registered_count=25`
  - `migration_consistency.applied_count=25`
  - `migration_consistency.unapplied_count=0`
- Jangar logs also report:
  - `failed to read control-plane heartbeat: Query read timeout`
  - `control-plane heartbeat publish failed warn: Query read timeout`
- Direct database shell access is unavailable by design from this runner:
  - `kubectl cnpg psql -n jangar jangar-db -- -c ...`
  - `kubectl cnpg psql -n torghut torghut-db -- -c ...`
  - both fail because the service account cannot create `pods/exec`.
- Torghut data surfaces show stronger freshness problems:
  - Jangar market context for `AAPL` is stale across technicals, fundamentals, news, and regime; fundamentals are from
    `2026-03-12`, news from `2026-03-16`, and technical/regime data from `2026-05-04`;
  - Jangar market context for `NVDA` is also stale and carries source-error risk flags;
  - Jangar typed quant health route times out for a known strategy/account/window;
  - Torghut `/readyz`, `/db-check`, and `/trading/health` time out;
  - Torghut logs show repeated `IdleInTransactionSessionTimeout` on
    `SELECT max(trade_decisions.created_at) FROM trade_decisions`.

Interpretation:

- Schema health is not enough.
- Direct database inspection is not an acceptable operational dependency.
- Heavy freshness reads on request paths are now an availability risk and a profitability risk.

## Problem Statement

Jangar has accumulated the right ingredients: runtime kits, admission passports, heartbeat rows, rollout health,
execution trust, dependency quorum, NATS collaboration, and Torghut proof surfaces. The missing piece is a durable
authority boundary.

Today, a route can be serving-ready while execution trust is stale; a rollout can become ready while a sibling revision
has image pull debt; a schedule runner can complete while previous cron jobs remain failed; and Torghut can show health
while profit evidence routes time out. Those are individually explainable states. The failure mode is that the system
does not compile them into one bounded answer per consumer.

Without that boundary:

1. deployers cannot tell whether a rollout is safe to widen or merely safe to serve;
2. engineers can fix a route without reducing stale dispatch and promotion risk;
3. Torghut can lose profitable time to route-time database contention or, worse, trade on stale proof;
4. audit evidence depends on privileged human commands that production deployers should not need.

## Alternatives Considered

### Option A: Tighten Current Route-Time Checks

Summary:

- add stricter status reducers to `/ready`, `/api/agents/control-plane/status`, and Torghut health routes;
- fail closed faster when a dependency is stale or a query times out.

Pros:

- fastest code change;
- uses existing surfaces and tests;
- can reduce false green answers quickly.

Cons:

- keeps heavyweight proof work on request paths;
- increases outage probability when the database is slow;
- still lets dispatch, rollout, and promotion derive different answers;
- does not help deployers reason about which stale evidence applies to which consumer.

Decision: rejected as the primary direction. It is useful as tactical hardening only after epochs exist.

### Option B: Split Controller and Database Topology First

Summary:

- split serving, controller, heartbeat, and schedule work into more deployments and pools;
- add separate resource budgets before changing authority objects.

Pros:

- reduces resource contention;
- makes partial failure domains easier to operate;
- helps the observed heartbeat timeout problem.

Cons:

- does not create a shared truth object;
- can make more replicas produce more contradictory answers;
- does not solve Torghut proof freshness or promotion gating.

Decision: rejected for this stage. It remains a likely implementation step after proof cells define the boundaries.

### Option C: Durable Evidence Epochs and Proof Cells

Summary:

- compile one small epoch record from existing evidence producers;
- attach typed proof cells with expiry, producer, digest, consumer class, and rollout effect;
- make routes, launchers, deploy verification, and Torghut consumers project the same epoch.

Pros:

- directly addresses the split-state failure mode;
- lets serving stay available while dispatch or promotion blocks;
- removes privileged DB shell access from validation;
- gives Torghut a bounded, auditable proof exchange instead of request-time scans.

Cons:

- requires additive schema, a compiler loop, and cross-surface parity tests;
- requires careful expiry defaults to avoid noisy false holds;
- has more up-front work than route patches.

Decision: selected.

## Decision

Jangar will implement evidence epochs and proof cells.

An `evidence_epoch` is a compact, durable projection with:

- `evidence_epoch_id`
- `compiler_version`
- `source_revision`
- `runtime_image_ref`
- `authority_digest`
- `issued_at`
- `fresh_until`
- `serving_decision`
- `dispatch_decision`
- `promotion_decision`
- `rollback_decision`
- `reason_codes`

A `proof_cell` is a typed subject attached to exactly one epoch:

- `proof_cell_id`
- `evidence_epoch_id`
- `subject_kind`
- `subject_ref`
- `consumer_class`
- `decision`
- `observed_at`
- `fresh_until`
- `producer`
- `evidence_ref`
- `digest`
- `reason_codes`

Initial proof-cell subjects:

- `runtime-kit:serving`
- `runtime-kit:collaboration`
- `controller-heartbeat:agents-controller`
- `controller-heartbeat:workflow-runtime`
- `rollout:agents`
- `rollout:agents-controllers`
- `swarm-stage:jangar-control-plane:<stage>`
- `swarm-requirements:jangar-control-plane`
- `nats:workflow.general`
- `database-schema:jangar`
- `database-query-budget:jangar-heartbeats`
- `torghut:market-context:<symbol-set>`
- `torghut:quant-health:<strategy-set>`
- `torghut:profit-proof-exchange`

Consumer classes:

- `serving`
- `swarm_plan`
- `swarm_implement`
- `swarm_verify`
- `deploy_verify`
- `torghut_runtime`
- `torghut_promotion`

Rules:

1. `serving` may degrade when execution proof cells are stale, but it must not claim promotion readiness.
2. `swarm_*` consumers require collaboration, runtime kit, stage, and requirement proof cells.
3. `deploy_verify` requires rollout, runtime kit, and epoch parity proof cells.
4. `torghut_promotion` requires fresh market-context, quant-health, profit-proof, and database-query-budget proof cells.
5. A missing required proof cell is `unknown` or `block`, never `allow`.

## Implementation Scope

### Phase 1: Shadow Epoch Compiler

Additive Jangar work:

- create migration for `agents_control_plane.evidence_epochs`;
- create migration for `agents_control_plane.proof_cells`;
- implement `control-plane-evidence-epoch-compiler.ts`;
- compile from existing status, runtime admission, heartbeat, rollout, and execution-trust inputs;
- expose a read-only endpoint at `/api/agents/control-plane/evidence-epoch`;
- keep `/ready` and `/api/agents/control-plane/status` behavior unchanged except for including shadow epoch ids.

Validation:

- unit tests for expiry, missing cell behavior, and consumer-class decisions;
- route tests proving shadow epoch ids are present and stable for equivalent inputs;
- no rollout enforcement in this phase.

### Phase 2: Cross-Surface Parity

Additive Jangar work:

- update `/ready`, status, schedule dispatch status, and deploy verification to include `evidence_epoch_id`;
- add a parity test that constructs one degraded execution-trust input and proves all four surfaces cite the same
  epoch and consumer decision;
- publish NATS status updates with the epoch id and top reason codes during scheduled swarm launches.

Validation:

- `bun run --filter @proompteng/jangar test -- services/jangar/src/routes/ready.test.ts`
- focused tests for `control-plane-status`, `supporting-primitives-controller`, and deployment verification;
- local `bunx oxfmt --check` on changed docs and TypeScript paths.

### Phase 3: Enforcement

Controlled behavior changes:

- schedule and requirement launchers must refuse a `hold` or `block` passport for their consumer class;
- deploy verification must fail promotion when the canary epoch is stale, missing, or older than the current serving
  epoch;
- Torghut promotion must consume the companion profit-proof exchange cell before it can advance capital.

Feature flags:

- `JANGAR_EVIDENCE_EPOCH_SHADOW=true`
- `JANGAR_EVIDENCE_EPOCH_ENFORCE_DISPATCH=false` initially
- `JANGAR_EVIDENCE_EPOCH_ENFORCE_DEPLOY=false` initially
- `JANGAR_EVIDENCE_EPOCH_ENFORCE_TORGHUT_PROMOTION=false` initially

## Rollout Plan

1. Ship schema and compiler in shadow mode.
2. Watch epoch production for one full swarm cadence.
3. Require parity in CI and deploy verification, but keep enforcement disabled.
4. Enable dispatch enforcement for `discover` and `plan` first.
5. Enable `implement` and `verify` enforcement after no stale proof-cell regressions for one cadence.
6. Enable deploy enforcement after canary and stable pods report matching epoch decisions.
7. Enable Torghut promotion enforcement after the companion proof exchange is shadow-producing fresh receipts.

## Rollback Plan

Rollback is intentionally simple:

- set enforcement flags to `false`;
- keep the compiler and read-only endpoints running for diagnosis;
- if the compiler itself causes load, set `JANGAR_EVIDENCE_EPOCH_SHADOW=false`;
- do not drop tables during rollback;
- use the last emitted epoch ids and proof-cell reason codes as incident evidence.

## Acceptance Gates for Engineer Stage

Engineer stage is accepted only when:

1. migrations are additive and reversible by application-level disablement;
2. compiler output is deterministic for the same inputs;
3. missing cells fail closed per consumer class;
4. `/ready`, status, schedule dispatch, and deploy verification expose the same epoch id in tests;
5. no request-time route performs heavyweight proof scans;
6. NATS publish/soak paths continue to work when the local `nats` CLI exists and report a blocked collaboration cell when
   it does not.

## Acceptance Gates for Deployer Stage

Deployer stage is accepted only when:

1. canary and stable pods expose comparable epoch ids;
2. deploy verification prints `evidence_epoch_id`, `promotion_decision`, and top reason codes;
3. rollout widening is refused for stale canary epochs;
4. disabling enforcement restores previous launch behavior without a redeploy;
5. Torghut promotion remains blocked until the companion profit-proof exchange cell is fresh.

## Risks

- Proof-cell expiry that is too short will create noisy holds. Mitigation: shadow mode with observed expiry histograms.
- Proof-cell expiry that is too long will recreate stale optimism. Mitigation: consumer-specific maximum TTLs.
- The compiler can become another request-time dependency if implemented in routes. Mitigation: background compiler plus
  bounded projection reads.
- Operators may treat a serving `degrade` as promotion authority. Mitigation: every projection must show consumer class,
  decision, and reason codes.

## Handoff

Engineer:

- start with the shadow compiler and schema;
- do not enforce dispatch until cross-surface parity tests pass;
- keep all proof inputs additive and bounded;
- treat direct DB shell access as unavailable in production validation.

Deployer:

- require epoch ids in deployment evidence before widening;
- keep enforcement flags available for rollback;
- block promotion when canary/stable epochs disagree;
- treat route timeouts as proof-cell failures, not as a reason to bypass proof.
