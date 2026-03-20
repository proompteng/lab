# 55. Jangar Rollout Fact Receipts and Swarm-Freeze Parity (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Related mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`

Extends:

- `54-jangar-witness-mirror-quorum-and-promotion-veto-2026-03-20.md`
- `53-jangar-dependency-provenance-ledger-and-consumer-acknowledged-admission-2026-03-19.md`
- `52-jangar-rollout-epoch-witness-and-segment-circuit-breakers-2026-03-19.md`
- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`

## Executive summary

The next control-plane resilience step is to stop letting Jangar compute rollout authority from partially overlapping,
partially stale surfaces. It now needs one durable fact path that every control-plane projection consumes.

Read-only evidence captured on `2026-03-20` shows the current contradiction plainly:

- `kubectl -n agents get swarm jangar-control-plane -o yaml`
  - `status.phase = Frozen`
  - `status.updatedAt = 2026-03-11T15:48:11.742Z`
  - `status.queuedNeeds = 5`
  - `status.lastDiscoverAt = 2026-03-08T07:05:00Z`
- `kubectl -n agents get swarm torghut-quant -o yaml`
  - `status.phase = Frozen`
  - `status.updatedAt = 2026-03-11T15:48:13.974Z`
  - `status.lastPlanAt = 2026-03-08T07:22:00Z`
- `kubectl -n agents get agentrun torghut-swarm-plan-template -o yaml`
  - `status.phase = Failed`
  - `status.reason = BackoffLimitExceeded`
  - `status.finishedAt = 2026-03-19T19:22:39.483Z`
- `kubectl -n agents get agentrun torghut-swarm-verify-template -o yaml`
  - `status.phase = Failed`
  - `status.reason = BackoffLimitExceeded`
  - `status.finishedAt = 2026-03-19T19:35:36.385Z`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status'`
  - `dependency_quorum.decision = "allow"`
  - `rollout_health.status = "healthy"`
  - `workflows.recent_failed_jobs = 0`
  - `workflows.backoff_limit_exceeded_jobs = 0`
- `curl -fsS 'http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?window=15m'`
  - `ok = true`
  - `status = "degraded"`
  - `latestMetricsCount = 72`
  - `maxStageLagSeconds = 39678`

The problem is not that Jangar has no evidence. The problem is that it does not require all authoritative evidence to
flow through the same decision artifact. Swarm freeze, stage failures, rollout health, and downstream trading-health
lag can each be true at the same time while the top-level dependency decision still resolves to `allow`.

The selected architecture is to add **Rollout Fact Receipts** and **Swarm-Freeze Parity**:

- producers publish durable receipts for stage cadence, workflow failures, rollout health, downstream freshness, and
  consumer acknowledgement;
- a single reducer emits one admission receipt per rollout epoch;
- `/api/agents/control-plane/status`, `/ready`, `Swarm.status`, and downstream Torghut promotion inputs all project the
  same receipt id and decision;
- missing or contradictory critical receipts open a challenge window and force `hold` or `block`, never `allow`.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- ownerChannel: `swarm://owner/trading`

This architecture artifact succeeds when:

1. cluster, source, and database/data evidence are captured with exact read-only proof;
2. at least two viable directions are compared and one is chosen with explicit tradeoffs;
3. Jangar can no longer publish promotion-friendly authority from stale or incomplete swarm truth;
4. engineer and deployer stages receive one contract with explicit validation, rollout, rollback, and parity gates.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current cluster evidence says Jangar is split across incompatible truth surfaces:

- `Swarm.status` still projects frozen March 11 truth for both swarms even though new runs and new failures exist on
  March 19 and March 20.
- `AgentRun.status` shows fresh `BackoffLimitExceeded` failures for Torghut plan and verify lanes.
- the Jangar control-plane endpoint still reports `dependency_quorum = allow`, `rollout_health = healthy`, and zero
  recent workflow failures.
- quant health is not blocking, but it is materially stale for a 15 minute operating window.

Interpretation:

- Jangar already has enough information to know that the operating picture is incomplete.
- that incompleteness is not yet represented as one mandatory veto-capable receipt.
- deployers still need to infer truth by manually comparing `Swarm`, `AgentRun`, and Jangar HTTP status payloads.

### Source architecture and high-risk modules

The source tree explains why the contradiction exists:

- `services/jangar/src/server/control-plane-status.ts`
  - reduces dependency quorum from the current process view and namespace-local workflow collection;
  - blocks on material degradation, but not on cross-surface parity drift between `Swarm.status`, workflow failures,
    and downstream stage freshness;
  - currently reports `workflows.target_namespaces = 1`, which keeps the reducer focused on `agents` runtime state
    rather than the full cross-swarm truth path.
- `services/jangar/src/routes/ready.tsx`
  - promotes execution-trust data to readiness only when the optional execution-trust path is active;
  - does not require a shared receipt id with `Swarm.status`.
- `services/jangar/src/data/agents-control-plane.ts`
  - already has the typed segment vocabulary needed for scoped vetoes, but no durable receipt contract that forces all
    projections to agree on the same authority snapshot.

Current regression gaps:

- no test proving `Swarm.status.phase = Frozen` and fresh stage failures force control-plane admission away from `allow`;
- no test proving `/api/agents/control-plane/status`, `/ready`, and `Swarm.status` publish the same admission receipt;
- no test proving stale downstream quant-health receipts can open a challenge window even when namespace-local rollout
  health is green;
- no test proving recent `BackoffLimitExceeded` stage failures survive aggregation and remain visible to consumers.

### Database and data continuity evidence

The data surfaces show healthy storage with unhealthy authority semantics:

- Torghut Postgres head is current:
  - `alembic_version = 0025_widen_lean_shadow_parity_status`
- Torghut options control-plane rows exist but are stale:
  - `torghut_options_contract_catalog.count = 1735031`
  - `torghut_options_contract_catalog.latest = 2026-03-11 01:06:33.304365+00`
  - `torghut_options_rate_limit_state.latest = 2026-03-11 01:08:11.712+00`
- ClickHouse replicas are writable but cold right now:
  - `system.replicas.is_readonly = 0` for all Torghut tables
  - `ta_signals rows_10m = 0`
  - `ta_microbars rows_10m = 0`

Interpretation:

- the control-plane failure is not a storage outage;
- the missing primitive is a durable authority chain that records freshness and contradiction explicitly.

## Problem statement

Jangar still has four resilience-critical gaps:

1. `Swarm.status`, `AgentRun.status`, and Jangar HTTP status are not guaranteed to project the same admission truth.
2. Recent failures can disappear from the current dependency quorum because the reducer is scoped to the wrong surface.
3. Downstream stale data can exist without opening a first-class control-plane challenge window.
4. Deployers have to reconcile multiple outputs manually instead of following one authoritative receipt id.

That makes safer rollout behavior dependent on human judgment precisely where the system should already be able to fail
safe by itself.

## Alternatives considered

### Option A: widen Jangar RBAC and keep a single in-memory reducer

Summary:

- broaden controller reads so the current reducer can query more rollout objects directly;
- continue deriving the decision from live Kubernetes reads and process-local aggregation.

Pros:

- smallest conceptual delta;
- fewer new persistence objects;
- could improve immediate rollout visibility.

Cons:

- increases privilege footprint for the main control-plane runtime;
- still fails when any critical producer is temporarily unavailable;
- keeps projections vulnerable to drift because nothing forces `Swarm.status` and HTTP status to share the same epoch.

### Option B: keep independent status surfaces and add stronger alerts

Summary:

- preserve `Swarm.status`, HTTP status, and stage-job inspection as separate surfaces;
- notify operators earlier when they drift.

Pros:

- smallest implementation effort;
- useful for observability regardless of design direction.

Cons:

- does not reduce the dangerous failure mode;
- still requires deployer inference;
- turns correctness into a documentation problem instead of a control-plane invariant.

### Option C: rollout fact receipts plus swarm-freeze parity

Summary:

- producers publish durable receipts for each critical authority input;
- Jangar reduces those receipts into one admission artifact per rollout epoch;
- all control-plane surfaces project that artifact instead of recomputing it independently.

Pros:

- preserves least privilege by letting each producer publish only the facts it owns;
- removes the stale-projection failure mode;
- gives Torghut and deployers one receipt id to consume and audit;
- increases future option value because new receipt classes can be added without redesigning the whole reducer.

Cons:

- adds persistence, expiry, and reconciliation semantics;
- requires parity tests across several surfaces;
- will force stricter holds until the receipt producers are stable.

## Decision

Adopt **Option C**.

The control plane should not be trusted because one endpoint says `allow`. It should be trusted because every critical
surface agrees on the same durable receipt and that receipt is still fresh.

## Proposed architecture

### 1. Rollout fact receipts

Add a durable receipt ledger in the control-plane database:

- `control_plane_fact_receipts`
  - key: `{plane, subject_kind, subject_ref, fact_class, source_epoch_id}`
  - fields:
    - `fact_class` in `{swarm_stage, workflow_failure, rollout_health, downstream_freshness, consumer_ack, transport}`
    - `decision` in `{healthy, hold, block, unknown}`
    - `reason_codes[]`
    - `observed_at`
    - `fresh_until`
    - `source_revision`
    - `source_config_hash`
    - `evidence_ref`
    - `projection_scope`
    - `producer_identity`
    - `payload_json`
- `control_plane_fact_events`
  - immutable history of `published`, `expired`, `recovered`, `contradicted`, and `challenged`

Each producer writes only its own receipt class:

- swarm cadence/freeze reconciler writes `swarm_stage`;
- workflow/job observers write `workflow_failure`;
- rollout adapters write `rollout_health`;
- Torghut/Jangar health bridges write `downstream_freshness`;
- Huly/consumer integrations write `consumer_ack` and `transport`.

### 2. Swarm-freeze parity reducer

Add one reducer that emits:

- `control_plane_admission_receipts`
  - key: `{swarm, rollout_epoch_id}`
  - fields:
    - `receipt_id`
    - `decision` in `{allow, hold, block}`
    - `blocking_receipt_ids[]`
    - `degraded_receipt_ids[]`
    - `challenge_window_id`
    - `published_at`
    - `expires_at`
    - `projection_hash`

Required invariant:

- `Swarm.status`
- `/api/agents/control-plane/status`
- `/ready`
- downstream Torghut admission inputs

must all surface the same `receipt_id`, `decision`, and `expires_at`.

### 3. Challenge windows

Add `control_plane_challenge_windows` for contradictory or stale truth:

- opened when a critical receipt is missing, stale, or contradictory to another receipt in the same rollout epoch;
- closes only when the missing or contradictory receipts recover or expire by policy;
- forces the admission decision to `hold` or `block`;
- is visible to deployers and consumers as the primary reason promotion is paused.

This is the direct resilience improvement: the system stops silently preferring the greenest-looking local surface.

### 4. Receipt precedence and failure-mode mapping

Critical receipts that must never be optional for promotion-friendly authority:

- fresh swarm stage cadence for the producer swarm;
- recent workflow-failure receipts for the relevant stages;
- rollout-health receipts for the controlling runtime;
- downstream freshness receipts for quant and market context when a consumer depends on them;
- consumer acknowledgement receipts for any rollout epoch consumed cross-plane.

Decision policy:

- any missing critical receipt => `hold`;
- any contradictory critical receipt => `block`;
- any expired receipt referenced by the current admission receipt => `hold`;
- only one active, unexpired admission receipt may be authoritative per `{swarm, rollout_epoch_id}`.

### 5. Implementation scope

Engineer stage must implement:

- the receipt tables and reducer contract;
- parity projection from the admission receipt into `Swarm.status`, `/ready`, and control-plane HTTP status;
- stage-failure receipt publication from workflow observations;
- receipt-backed challenge windows;
- explicit downstream freshness receipt ingestion hooks.

## Validation and acceptance gates

Engineer acceptance gates:

- regression proving stale `Swarm.status` and fresh workflow failures cannot coexist with `decision = allow`;
- regression proving `/ready`, `Swarm.status`, and `/api/agents/control-plane/status` expose the same `receipt_id`;
- regression proving a degraded downstream freshness receipt opens a challenge window and prevents promotion-friendly
  authority;
- regression proving recent `BackoffLimitExceeded` jobs are represented in the admission receipt.

Deployer acceptance gates:

- do not treat any rollout as promotion-capable unless all exposed surfaces report the same active `receipt_id`;
- do not promote while a challenge window is open;
- verify that the active admission receipt references fresh swarm-stage and rollout-health evidence for the current
  rollout epoch.

## Rollout plan

1. Land the receipt schema and write-only producers behind feature flags.
2. Run the reducer in shadow mode and publish receipt ids into status payloads without enforcing them.
3. Add projection parity checks to CI and staging validation.
4. Switch `/ready` and control-plane status to receipt-backed decisions.
5. Switch `Swarm.status` to project the receipt-backed decision and challenge-window state.
6. Make downstream consumers require the admission receipt id instead of coarse `decision/reasons/message` only.

## Rollback plan

- If receipt publication is noisy, keep writing receipts but revert the projection surfaces to their current reducer.
- If projection parity causes false blocks, disable receipt enforcement while preserving receipt history for diagnosis.
- Do not delete the ledger during rollback; the receipt history is part of the recovery surface.

## Risks

- Shadow-mode parity may initially expose more contradictions than operators expect.
- Receipt expiry tuning that is too aggressive could create noisy `hold` decisions during benign reconciliation delays.
- Additional receipt producers mean more coordination across Jangar and Torghut implementations.

## Handoff to engineer

Build the receipt ledger and reducer first, then make projection parity non-optional. The contract is not satisfied if
one surface still computes its own admission decision locally.

Exact acceptance gates:

- one active admission receipt per `{swarm, rollout_epoch_id}`;
- all projection surfaces expose the same `receipt_id`;
- stale or contradictory critical receipts never resolve to `allow`.

## Handoff to deployer

Use the admission receipt as the merge and rollout authority, not the prettiest single endpoint.

Deployment must stop when:

- projection surfaces disagree on `receipt_id`;
- any challenge window is open;
- any critical receipt is missing, expired, or contradictory for the intended rollout epoch.
