# 67. Jangar Runtime Cells and Rollout Backpressure Contract (2026-05-05)

Status: Ready for implementation (`plan`)
Date: `2026-05-05`
Owner: Gideon Park (Torghut Traders architecture)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/72-torghut-proof-exchange-and-data-firebreak-contract-2026-05-05.md`

Extends:

- `docs/agents/designs/66-jangar-recovery-release-lanes-and-rollout-proof-fence-contract-2026-03-21.md`
- `docs/agents/designs/65-jangar-recovery-epoch-cutover-and-backlog-seat-enforcement-contract-2026-03-21.md`
- `docs/agents/designs/63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `docs/torghut/design-system/v6/64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`

## Executive Summary

I am choosing runtime cells with rollout backpressure as the next Jangar control-plane architecture.

The current system is healthier than it was in March, but the May 5 evidence still shows a dangerous split:
Jangar can serve requests while execution trust, controller rollout, and Torghut proof reads are degraded. The
right answer is not another global `ready` bit. The right answer is to make each runtime capability a typed cell,
bind consumers to cell receipts, and make rollout widening stop when cells cannot prove bounded execution and
bounded downstream query pressure.

The hard decision is to move from "controller is up, so the control plane can advance" to "the required runtime
cells have fresh receipts, or advancement waits." That adds implementation surface. I accept that cost because the
failure mode we need to reduce is stale or overloaded work continuing under a green deployment.

## Mission Inputs and Success Criteria

Runtime inputs for this plan lane:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- owner channel: `swarm://owner/trading`
- objective: assess cluster/source/database state and merge architecture artifacts that improve, maintain, and
  innovate Torghut quant while increasing Jangar control-plane resilience

This contract succeeds when engineer and deployer stages can prove all of the following:

1. Jangar reports one active runtime cell set for each consumer class: serving, dispatch, workflow runtime,
   Torghut quant evidence, and deploy verification.
2. `/ready`, `/api/agents/control-plane/status`, `Swarm.status`, deploy verification, and NATS/Jangar progress
   comments all cite the same cell-set id and receipt digest.
3. Rollout widening is blocked when a required cell is stale, missing, overloaded, or backed by an unready
   controller deployment.
4. Torghut quant evidence reads are rate-limited through a cell budget instead of route-time fanout that can
   exhaust Postgres or ClickHouse.
5. A deployer has explicit rollback gates tied to cell receipt age, controller availability, queue pressure, and
   downstream proof-read budget, not only pod readiness.

## Live Assessment Snapshot

All cluster and database checks in this run were read-only.

### Cluster Health, Rollout, and Events

Evidence collected on `2026-05-05`:

- `kubectl auth whoami` returned `system:serviceaccount:agents:agents-sa`.
- `kubectl get nodes -o wide` was forbidden for this identity, so node health is an evidence gap rather than a
  hidden assumption.
- `kubectl get pods -n jangar -o wide` showed the Jangar app, Bumba, Symphony, Redis, Open WebUI, and `jangar-db-1`
  running.
- `kubectl get pods -n torghut -o wide` showed the core Torghut revision `torghut-00201` running, ClickHouse
  replicas running, Keeper running, Postgres running, `torghut-ta` running, and `torghut-ws` running. It also
  showed `torghut-sim-00280-deployment-6f844b4647-np4x6` in `ImagePullBackOff`.
- `kubectl get pods -n agents -o wide` showed `agents` ready and `agents-controllers` split: one controller pod
  ready, one controller pod not ready.
- `kubectl get deployments...` and Argo CD Application reads were forbidden in the scoped identity, so I used
  Jangar's own typed status surface for rollout evidence.
- `GET http://jangar.jangar.svc.cluster.local/ready` returned HTTP 200 with `execution_trust.status="degraded"`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` reported:
  - `rollout_health.status="degraded"`
  - `agents.status="healthy"`
  - `agents-controllers.status="degraded"`
  - `agents-controllers.ready_replicas=1`, `available_replicas=1`, `updated_replicas=2`, `desired_replicas=2`
  - `database.status="healthy"` with `25/25` Kysely migrations applied
  - `dependency_quorum.decision="block"`
  - blocker reasons `agents_controller_unavailable`, `workflow_runtime_unavailable`, and
    `empirical_jobs_degraded`
  - `execution_trust.status="degraded"` due to five pending Jangar requirements and stale Jangar stages
- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o json` reported both swarms `phase="Active"`
  and not frozen, but both had `Ready` degraded due stage or requirement health. `torghut-quant` also reported
  `AgentRunIngestionDegraded` with untouched AgentRuns for `4770718s`.
- Recent events in `agents` included manual hotfix cron jobs that completed, followed by Kubernetes
  `UnexpectedJob` warnings on the scheduled cronjobs. This is a live indication that runtime launch provenance and
  scheduler provenance are not yet one clean authority surface.
- Recent events in `torghut` included failed Knative revisions, readiness timeouts, `ImagePullBackOff` for one
  sim pod, and then `torghut-00201` becoming ready.

Interpretation:

- Jangar serving is up, but serving health is not promotion health.
- Controller rollout health is currently degraded in the status surface Jangar itself asks consumers to trust.
- Scheduled stage work can be active while old stage health remains stale, so dispatch must be bound to typed
  runtime-cell receipts rather than stage age alone.

### Source Architecture and High-Risk Modules

The codebase already has several pieces of the right solution:

- `services/torghut/app/trading/submission_council.py` has typed quant-health loading, a submission gate, segment
  summaries, and promotion-certificate evaluation.
- `services/torghut/app/trading/scheduler/pipeline.py` calls the shared live-submission gate before live
  submission.
- `services/torghut/app/main.py` projects `/readyz`, `/trading/status`, `/trading/health`, and runtime status
  through common alpha-readiness and live-submission surfaces.
- `services/torghut/config/trading/hypotheses/*.json` already names lane-local segment dependencies such as
  `ta-core`, `market-context`, `execution`, `empirical`, and `llm-review`.
- `services/torghut/scripts/check_migration_graph.py` makes schema topology an explicit CI contract.

The risk is not lack of code. The risk is that several surfaces still recompute or fetch evidence at request time.
The most important current source shape:

- `services/torghut/app/main.py` reads expensive readiness data and live-submission evidence while handling
  `/readyz`, `/trading/status`, and other routes.
- `services/torghut/app/trading/submission_council.py` fetches Jangar quant evidence through a short-lived cache,
  but the read still happens in-process and is only safe if the upstream route is bounded.
- `services/torghut/app/trading/scheduler/pipeline.py` caches the last live-submission gate but still recomputes
  when given a session.
- The Torghut service has 151 app Python files and 138 test files, but the largest risk-bearing modules are very
  large: `app/trading/autonomy/lane.py` around 7,377 lines, `app/trading/autonomy/policy_checks.py` around 6,072
  lines, `app/trading/scheduler/pipeline.py` around 4,273 lines, and `app/main.py` around 3,959 lines.

Those module sizes are not automatically wrong. They do mean route-time proof compilation and runtime-control
decisions must be moved behind smaller, testable receipt compilers before they become harder to reason about.

### Database, Schema, Freshness, and Consistency

Direct database reads are restricted from this runtime identity:

- `kubectl cnpg psql -n torghut torghut-db ...` failed with `pods "torghut-db-1" is forbidden ... cannot create
resource "pods/exec"`.
- `kubectl cnpg psql -n jangar jangar-db ...` failed with the same `pods/exec` restriction.
- direct ClickHouse HTTP reads against `torghut-clickhouse:8123` returned HTTP 401.

The useful database evidence came from runtime surfaces and logs:

- Jangar's control-plane status reported its database healthy, `latency_ms=2`, and `25/25` migrations applied.
- Torghut `/readyz`, `/db-check`, and `/trading/status` timed out during this run.
- Torghut app logs showed repeated SQLAlchemy pool exhaustion:
  `QueuePool limit of size 5 overflow 5 reached, connection timed out, timeout 30.00`.
- Torghut app logs also showed `IdleInTransactionSessionTimeout` on:
  `SELECT max(trade_decisions.created_at) AS max_1 FROM trade_decisions`.
- Jangar market-context health for `NVDA` returned `overallState="degraded"` with stale domain health:
  - technicals freshness `44416s` against a `60s` max
  - fundamentals freshness `4648542s` against an `86400s` max
  - news freshness `4303313s` against a `300s` max
  - regime freshness `44416s` against a `120s` max
- Jangar symbols returned 12 active symbols: `AMAT`, `AMD`, `ASML`, `AVGO`, `INTC`, `KLAC`, `LRCX`, `MU`, `NVDA`,
  `QCOM`, `TSM`, and `TXN`.
- Jangar quant snapshot for strategy `6b163d0c-dcef-438b-ab88-ce5e806e3493`, account `PA3SX7FYNUTF`, window `1d`
  returned metrics, but many were `insufficient_data` or stale. The `metrics_pipeline_lag_seconds` metric reported
  `86400`, with metadata showing `taFreshnessSeconds=25719`, `contextFreshnessSeconds=38456`, and
  `latestExecutionFreshnessSeconds=86400`.
- Jangar quant alerts had one open warning: `sharpe_annualized` below threshold for strategy
  `4b0051ba-ae40-43c1-9d8b-ad5a57a2b8f6`, account `PA3SX7FYNUTF`, window `5d`, opened on
  `2026-03-12T13:42:09.427Z`.

Interpretation:

- Database schema health is not the blocker for Jangar.
- Torghut route-time evidence reads are themselves a reliability risk under DB pressure.
- Freshness is split by domain. Market-context and quant evidence are not fresh enough to justify broad live
  promotion, but some data lanes are still useful for shadow and bounded repair.

## Problem Statement

Jangar currently has typed status surfaces, but it still allows consumers to ask broad questions at the wrong time:
"is the control plane ready?", "is Torghut ready?", "can we promote?" Those questions collapse unrelated failure
domains into one answer and can force expensive DB-backed reads while the runtime is already under pressure.

The May 5 failure shape is specific:

1. Jangar can serve while controller rollout and workflow runtime are degraded.
2. Torghut can pass `/healthz` while DB-backed readiness and status routes time out.
3. Quant evidence can exist while context freshness and profit metrics are stale.
4. Scheduler activity can continue while Jangar/Torghut stage health is still degraded.
5. Scoped service accounts cannot use privileged database inspection as a normal deployer verification path.

The architecture needs a durable control-plane unit that can say: this capability is fresh, bounded, and safe for
this consumer class. I call that unit a runtime cell.

## Alternatives Considered

### Option A: Tighten the Existing Readiness and Dependency-Quorum Thresholds

Summary:

- keep current status routes;
- make thresholds stricter for controller availability, stage staleness, and quant freshness;
- teach runbooks to interpret the stricter answer.

Pros:

- fastest implementation;
- minimal schema/API surface change;
- useful for short-term alerting.

Cons:

- does not prevent route-time expensive proof reads;
- still makes consumers recompute or reinterpret broad status payloads;
- cannot express "serving ok, dispatch blocked, Torghut proof reads rate-limited" cleanly;
- does not give deploy verification a durable receipt id.

Decision: rejected as the primary design. It is a useful patch, not the six-month architecture.

### Option B: Split Jangar Into More Deployments First

Summary:

- make serving, controllers, schedulers, and quant projections separate deployments before changing authority data.

Pros:

- reduces CPU and memory contention;
- makes Kubernetes rollout status easier to understand;
- may improve blast-radius isolation.

Cons:

- topology does not create truth by itself;
- still leaves route-time proof reads and stale stage authority unresolved;
- raises operational complexity before defining the contract each deployment must satisfy.

Decision: rejected for this plan. Runtime cells can later map to separate deployments, but the contract comes first.

### Option C: Runtime Cells With Backpressure Receipts

Summary:

- compile one runtime cell set per control-plane epoch;
- each cell owns a capability, budget, freshness SLO, and receipt digest;
- consumers bind to cells by class;
- rollout widening and Torghut capital promotion fail closed when required cells are stale, over budget, or missing.

Pros:

- directly addresses the May 5 evidence;
- separates serving readiness, dispatch readiness, proof-read readiness, and promotion authority;
- gives deployers stable ids instead of raw route-time evidence;
- lets Torghut consume bounded projections without privileged DB shell access.

Cons:

- requires additive persistence and new typed status projection work;
- forces engineers to draw tighter boundaries around existing broad status reducers;
- rollout will be slower until parity is proven.

Decision: selected.

## Decision

Jangar will implement runtime cells and rollout backpressure receipts.

A runtime cell is an additive record with:

- `runtime_cell_id`
- `cell_set_id`
- `consumer_class`
- `capability`
- `authority_epoch_id`
- `source_revision`
- `receipt_digest`
- `freshness_slo_seconds`
- `max_query_budget_units`
- `budget_used_units`
- `state`
- `reason_codes`
- `last_success_at`
- `expires_at`

The initial cell capabilities are:

- `serving-http`
- `controller-reconcile`
- `workflow-runtime`
- `stage-dispatch`
- `requirements-bridge`
- `torghut-quant-proof-read`
- `torghut-market-context-read`
- `deploy-verification`
- `nats-progress-publish`

Consumer classes are:

- `serve`
- `dispatch`
- `promote`
- `verify`
- `handoff`
- `observe`

Each consumer class must declare required cells and tolerated degraded cells. A `serve` consumer can tolerate stale
Torghut proof reads. A `promote` consumer cannot.

## Architecture Contract

### Cell Compiler

Add a periodic and on-demand cell compiler in Jangar. The compiler reads existing status inputs, but it writes a small
bounded result:

- controller rollout status
- workflow runtime availability
- swarm stage and requirement health
- Jangar database migration status
- Torghut quant projection health
- Torghut market-context projection health
- NATS publish helper availability

The compiler must not run unbounded database scans. If it needs Torghut evidence, it consumes typed, bounded Torghut
or Jangar projections with timeouts and query budgets.

### Status Surfaces

The following surfaces must expose the active `cell_set_id`, required-cell state, and receipt digest:

- `GET /ready`
- `GET /api/agents/control-plane/status?namespace=agents`
- `Swarm.status`
- deploy verification output
- progress-comment body emitted by `services/jangar/scripts/codex/codex-progress-comment.ts`

The status payloads can keep their existing fields, but the cell set becomes the authority for promotion and dispatch.

### Rollout Backpressure

Rollout widening fails closed when:

- required controller cells are not healthy;
- `agents-controllers` has fewer available replicas than desired for the configured cell policy;
- workflow runtime cell is missing or expired;
- stage-dispatch cell has stale stage debt beyond policy;
- Torghut proof-read cell reports DB pool pressure, route timeout, or budget exhaustion;
- deploy-verification cell cannot cite the same cell-set digest as `/ready`.

Rollout backpressure is not a Kubernetes mutation from this plan. It is a design requirement for engineer/deployer
implementation through GitOps and deploy verification.

### Torghut Consumer Binding

Torghut must not fetch broad Jangar status and infer promotion authority on its own. It should consume:

- `torghut-quant-proof-read` for quant metrics freshness and proof exchange budget;
- `torghut-market-context-read` for domain freshness and provider health;
- `controller-reconcile` and `workflow-runtime` only as promotion blockers, not as trading-loop liveness blockers;
- `nats-progress-publish` for audit visibility, not capital authority.

This keeps Jangar control-plane problems from erasing useful Torghut shadow evidence, while still blocking capital
promotion when control-plane truth is not reliable.

## Validation Gates

Engineer-stage acceptance:

- Unit tests for cell compiler state transitions: healthy, stale, expired, over-budget, source-error, and
  controller-unavailable.
- API tests proving `/ready` and control-plane status cite the same `cell_set_id` and digest.
- Controller tests proving dispatch refuses a required cell in `stale`, `expired`, or `over_budget`.
- A Torghut consumer test proving capital promotion blocks on missing `torghut-quant-proof-read` while serving and
  shadow evaluation remain allowed.
- A migration test for additive cell tables if persistence is added.

Deployer-stage acceptance:

- `kubectl -n agents get pods` shows required controller pods ready for the chosen rollout policy.
- `GET /ready` returns a `cell_set_id`.
- `GET /api/agents/control-plane/status?namespace=agents` returns the same `cell_set_id`.
- Deploy verification prints the same digest and refuses promotion if it differs.
- NATS publish helper can emit a concise status update or the active cell explicitly records why it cannot.
- Torghut `/healthz` may be green while `/readyz` is degraded, but promotion remains blocked until proof-read cells
  are healthy.

## Rollout Plan

1. Add schema and compiler in shadow mode. No rollout or dispatch behavior changes.
2. Expose cell-set projections on `/ready`, control-plane status, and `Swarm.status`.
3. Add deploy verification parity checks that warn but do not fail.
4. Enable dispatch backpressure for stage-dispatch and requirements-bridge cells.
5. Enable promotion backpressure for Torghut proof-read and market-context cells.
6. Make deploy verification fail closed on digest mismatch or required-cell expiry.

## Rollback Plan

Rollback must not require deleting cell records.

- Phase 1 rollback: disable enforcement and keep compiling cells for observation.
- Phase 2 rollback: pin deploy verification to warning-only mode.
- Phase 3 rollback: if a compiler bug causes false blocking, mark the affected cell policy inactive by GitOps and
  keep `/ready` serving on the previous readiness contract.
- Data rollback: because cell records are additive, leave historical records in place and issue a new cell set with
  `state="inactive"` for the bad policy.

## Risks and Tradeoffs

- The design adds new state. That is justified only if engineer implementation keeps the compiler bounded and small.
- Cell freshness can become another stale truth surface if deploy verification does not require digest parity.
- If every consumer requires every cell, the system regresses to one global gate. Consumer-class binding must stay
  strict.
- The first rollout will feel slower. That is the right trade when controller rollout, proof reads, and downstream
  capital gates are already split in production.

## Handoff to Engineer

Build the smallest additive implementation:

- create a runtime-cell model and compiler;
- expose the active cell set on `/ready` and control-plane status;
- wire dispatch to required cells only after shadow parity is green;
- add tests that fail on digest mismatch and stale required cells;
- keep database reads bounded and never call Torghut heavyweight routes from Jangar request handlers.

Implementation is complete only when a test can show: Jangar serves, dispatch is blocked, and Torghut promotion is
blocked, all for different explicit cell reasons in one payload.

## Handoff to Deployer

Do not promote a Jangar rollout because pods are ready if runtime cells are degraded.

Before widening:

- confirm `agents-controllers` availability matches desired policy;
- confirm `/ready` and control-plane status expose the same `cell_set_id`;
- confirm deploy verification prints the same receipt digest;
- confirm Torghut proof-read and market-context cells are healthy for promotion;
- publish a NATS/Jangar update that names the degraded cell if any gate is held.

Rollback immediately if a promoted rollout creates digest disagreement, raises proof-read budget exhaustion, or
allows dispatch while `stage-dispatch` is stale.
