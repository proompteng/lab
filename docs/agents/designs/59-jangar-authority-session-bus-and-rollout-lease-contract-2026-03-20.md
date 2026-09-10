# 59. Jangar Authority Session Bus and Rollout Lease Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/58-torghut-profit-cohort-auction-and-freshness-insurance-contract-2026-03-20.md`

Extends:

- `58-jangar-authority-capsule-cutover-and-freeze-expiry-repair-contract-2026-03-20.md`
- `57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`
- `56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`

## Executive summary

The decision is to move Jangar from request-time authority reduction to a durable **Authority Session Bus** backed by
small **Rollout Leases**. Jangar will still expose `/ready` and the rich control-plane status route, but both surfaces
will project the latest compiled session instead of recomputing rollout truth on every request.

The reason is visible in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `503`
  - reports `execution_trust.status="blocked"`
  - reports unreconciled freeze expiry for `jangar-control-plane` and `torghut-quant`
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - returns HTTP `200`
  - reports `database.status="healthy"`
  - reports controllers derived as healthy from rollout or heartbeats
  - reports `execution_trust.status="blocked"` because requirements and freeze expiry remain stale
- `kubectl get swarms.swarm.proompteng.ai -n agents -o wide`
  - reports `jangar-control-plane` `Frozen` `Ready=False`
  - reports `torghut-quant` `Frozen` `Ready=False`
- `kubectl get swarm jangar-control-plane -n agents -o yaml`
  - reports `status.freeze.enteredAt="2026-03-11T15:36:12.630Z"`
  - reports `status.freeze.until="2026-03-11T16:36:12.630Z"`
  - reports `requirements.pending=5`
  - reports all four stages stuck in `Frozen`
- `kubectl get pods -n agents -o wide`
  - shows mixed rollout state with one `agents` pod `0/1 Running` and one `1/1 Running`
  - shows one `agents-controllers` pod `0/1 Running` and newer pods `1/1 Running`
- `kubectl get events -n agents --sort-by=.metadata.creationTimestamp | tail -n 40`
  - shows a fresh `BackoffLimitExceeded` on `torghut-swarm-plan-template-step-1-attempt-1`

The tradeoff is additive persistence, a compiler loop, and a new lease object that deploy verification must respect. I
am keeping that trade because the more expensive failure mode is ambiguous authority: Jangar can look healthy enough to
serve while rollout truth still depends on stale freeze records and whichever reducer answered first.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Jangar
  resilience and Torghut profitability

This artifact succeeds when:

1. `/ready`, `/api/agents/control-plane/status`, deploy verification, and downstream consumers cite one
   `authority_session_id`;
2. expired freeze state becomes an owned `repair` workflow with a deadline and evidence bundle instead of a permanent
   implicit veto;
3. every rollout step for `agents` or `torghut` carries one short-lived `rollout_lease_id` compiled from the same
   authority session;
4. serving-class authority can stay available during bounded recovery, while promotion-class authority remains
   explicitly blocked.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The current control plane is materially healthier than the authority it emits.

- `kubectl get pods -n jangar -o wide`
  - shows `jangar-64b9d545fc-nknwd` `2/2 Running`
  - shows `jangar-worker-79984689d4-zs6ql` `1/1 Running`
  - shows `jangar-db-1` `1/1 Running`
- `kubectl get pods -n agents -o wide`
  - shows mixed `agents` and `agents-controllers` rollout health rather than total outage
  - shows current swarm jobs running while older attempts recently hit backoff
- `GET /ready`
  - stays blocked even though leader election is current and the main Jangar pod is serving
- `kubectl get swarm ...`
  - shows freeze windows that expired on `2026-03-11` but still gate readiness on `2026-03-20`

Interpretation:

- Jangar needs a durable separation between `serving`, `promotion`, and `repair` authority.
- The system already has the raw facts to do this.
- What is missing is a first-class compiled object that every consumer agrees to trust.

### Source architecture and high-risk modules

The current source tree still keeps too much correctness in request paths.

- `services/jangar/src/server/control-plane-status.ts`
  - defines broad defaults such as `DEFAULT_ROLLOUT_DEPLOYMENTS` and `DEFAULT_EXECUTION_TRUST_SWARMS`;
  - still aggregates rollout, database, watch reliability, empirical services, swarms, and execution trust in one
    request-driven reducer.
- `services/jangar/src/routes/ready.tsx`
  - recomputes trust on demand and only returns `200` when the merged trust is `healthy`;
  - does not project a durable session id or readiness class.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - already runs CRD checks, watchers, and freeze/unfreeze timers;
  - does not persist an explicit freeze-repair workflow or rollout lease object.
- `services/jangar/src/server/control-plane-heartbeat-store.ts`
  - already proves the control plane can persist small authority objects in Postgres.

### Database, schema, freshness, and consistency evidence

The data surface is ready for additive state, not a redesign.

- Jangar status reports `migration_consistency.registered_count=24` and `applied_count=24`.
- `database.status="healthy"` is already present in the current control-plane payload.
- `kubectl auth can-i create pods/exec -n jangar`
  - returns `no`, so direct SQL validation is unavailable from this worker.

Interpretation:

- the architecture should extend the control-plane database with small additive tables;
- read paths should project from those rows instead of re-deriving trust from multiple sources under live load;
- the rollout contract must remain observable even when pod exec is unavailable.

## Problem statement

Jangar still has five resilience-critical gaps:

1. rollout truth is compiled at request time instead of published as a durable object;
2. freeze expiry is treated as a stale observation, not an owned repair workflow;
3. deploy verification, `/ready`, and downstream consumers can all describe the same incident differently;
4. serving availability and promotion authority still share one coarse health outcome;
5. downstream systems cannot prove which exact control-plane decision authorized their work.

That is survivable for a small control plane. It is not acceptable for the next six months of autonomous Torghut
operation, where the expensive failure mode is contradictory truth rather than total unavailability.

## Alternatives considered

### Option A: finish the authority-capsule cutover over HTTP only

Summary:

- keep HTTP pull as the primary contract;
- add more typed endpoints and a stricter freeze repair loop;
- continue using `/ready` and status as the final authority surfaces.

Pros:

- smallest implementation delta;
- minimal transport changes.

Cons:

- still leaves correctness tied to request-time reducers;
- does not create a lease object that rollout tooling can bind to;
- keeps downstream replay and forensic reconstruction too dependent on logs.

Decision: rejected.

### Option B: centralize final trading authority inside Jangar

Summary:

- Jangar would emit final capital and promotion guidance for Torghut lanes;
- Torghut would mostly execute those decisions.

Pros:

- one operator story on paper;
- fewer contracts to inspect at first glance.

Cons:

- couples infrastructure truth to trading economics;
- increases blast radius from Jangar mistakes;
- destroys future option value for Torghut-local experimentation.

Decision: rejected.

### Option C: authority sessions, rollout leases, and a durable bus

Summary:

- Jangar compiles small authority sessions from capsules, swarms, rollout facts, and repair state;
- each rollout step requires an explicit lease derived from one session;
- the latest session is projected through HTTP and emitted through an outbox bus for consumers.

Pros:

- removes request-time ambiguity from the critical path;
- gives deploy verification and downstream systems one id to bind to;
- keeps serving and promotion authority separate without hiding recovery state;
- preserves Jangar ownership of platform truth while keeping Torghut-local economics local.

Cons:

- adds additive tables, a session compiler, and lease expiry semantics;
- requires staged cutover so legacy status routes can shadow-compare;
- demands tighter tests around digest, TTL, and projector parity.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile durable authority sessions, emit short-lived rollout leases from those sessions, and project both
HTTP surfaces and downstream consumers from the same persisted object set.

## Architecture

### 1. Authority session model

Add additive control-plane tables:

- `control_plane_authority_sessions`
  - `authority_session_id`
  - `session_class` (`serving`, `promotion`, `recovery`)
  - `scope_namespace`
  - `subject_set_json`
  - `capsule_digest_set`
  - `execution_trust_status`
  - `dependency_quorum_decision`
  - `freeze_repair_id`
  - `rollout_lease_id`
  - `evidence_refs_json`
  - `issued_at`
  - `expires_at`
  - `producer_revision`
- `control_plane_subject_versions`
  - `authority_session_id`
  - `subject`
  - `capsule_id`
  - `decision`
  - `digest`
  - `freshness_budget_seconds`
  - `reason_codes_json`
  - `evidence_ref`

Rules:

- one session is the only authority allowed to speak for `/ready`, deploy verification, or a typed downstream binding;
- `serving` means Jangar may serve operator and dependency traffic;
- `promotion` means rollout and downstream promotion work may trust the session;
- `recovery` means serving may continue, but promotion is blocked until repair closes.

### 2. Freeze repair workflow

Add:

- `control_plane_freeze_repairs`
  - `freeze_repair_id`
  - `swarm_name`
  - `freeze_reason`
  - `freeze_entered_at`
  - `freeze_expires_at`
  - `repair_owner`
  - `repair_status` (`open`, `shadow-cleared`, `closed`, `aborted`)
  - `repair_evidence_refs_json`
  - `closed_at`

Behavior:

- if `freeze.until` is in the past and blockers remain, the compiler must emit `session_class="recovery"` and open or
  refresh one repair row;
- the repair row, not the raw stale freeze timestamp, becomes the operator-visible object for unresolved recovery;
- a repair may only close after one full clean observation window for the affected swarm and stages.

### 3. Rollout leases

Add:

- `control_plane_rollout_leases`
  - `rollout_lease_id`
  - `authority_session_id`
  - `target_namespace`
  - `target_name`
  - `strategy` (`canary`, `bluegreen`, `shadow`)
  - `allowed_revision`
  - `rollback_revision`
  - `allowed_weights_json`
  - `issued_at`
  - `expires_at`
  - `revoked_at`
  - `revocation_reason`

Rules:

- every deploy verification or rollout step must reference one unexpired lease;
- the lease is valid only while the parent session remains fresh and non-revoked;
- if repair state opens or a required subject degrades, the lease is revoked rather than silently becoming ambiguous.

### 4. Projection and transport

Jangar will keep HTTP routes, but they become projectors over durable sessions:

- `/ready`
  - returns the latest serving or recovery session summary plus `authority_session_id`;
- `/api/agents/control-plane/status`
  - returns the same `authority_session_id` and a projection of subjects, leases, and repair status;
- deploy verification
  - must validate the current `rollout_lease_id` before progressing.

Transport:

- add `control_plane_authority_outbox`
  - `outbox_id`
  - `authority_session_id`
  - `subject`
  - `payload_json`
  - `published_at`
  - `delivery_state`
- emit to `jangar.authority.sessions.v1` from the outbox so downstream consumers can subscribe without scraping the
  large status route.

### 5. Acceptance gates

Engineer acceptance gates:

1. `/ready` and `/api/agents/control-plane/status` publish the same `authority_session_id`, `session_class`, and
   subject digests for the same observation window.
2. An expired swarm freeze produces one `freeze_repair_id` and one `recovery` session instead of an indefinite stale
   block with no owner.
3. Deploy verification fails closed when the required rollout lease is missing, expired, or revoked.
4. Restricted RBAC or rollout-read failures degrade or block the session explicitly; they must never synthesize a
   healthy promotion session.

Deployer acceptance gates:

1. During canary rollout, the deployer can read the current `rollout_lease_id`, `authority_session_id`, and
   `rollback_revision` before advancing weight.
2. A revoked lease prevents further rollout progression within one reconcile interval.
3. Recovery-class sessions keep operator visibility available while clearly blocking promotion.
4. Rollback returns the target to the previous revision without deleting session or repair history.

## Rollout plan

Phase 0: additive shadow write

- create the four additive tables and session compiler;
- write sessions, repairs, leases, and outbox rows without enforcement;
- add parity logging between legacy reducers and the new projector.

Phase 1: projector parity

- make `/ready` and control-plane status include `authority_session_id`, `session_class`, and `rollout_lease_id`;
- keep legacy reducer output for comparison only;
- verify at least one stale-freeze and one mixed-rollout case in staging or shadow production.

Phase 2: rollout lease enforcement

- require deploy verification to present an unexpired lease;
- fail closed on lease mismatch or revocation;
- keep HTTP projection and outbox dual-published.

Phase 3: downstream consumer cutover

- move Torghut and any future consumers to session-bound subjects;
- demote the broad status route to operator and diagnostics use rather than final consumer truth.

## Rollback plan

If the session compiler or projector causes false blocks:

1. stop enforcing rollout leases while keeping additive rows for diagnosis;
2. fall back to the legacy status reducer for deploy verification only;
3. keep recording repair rows so stale freeze evidence is not lost;
4. re-enable enforcement only after the parity diff is clean across one full rollout window.

## Risks and open questions

- Session churn could become noisy if freshness budgets are too short. Mitigation: minimum lease TTL and diff-aware
  publishing.
- Recovery sessions could become a new ambiguous middle state. Mitigation: explicit `repair_owner`, `repair_status`,
  and close criteria.
- Outbox transport lag could reintroduce stale truth. Mitigation: the lease projector remains source of truth and the
  bus is derived from persisted rows.

## Handoff to engineer

1. Implement the additive session, repair, lease, and outbox tables in the Jangar control-plane database.
2. Build a session compiler that projects `serving`, `promotion`, and `recovery` classes from existing capsule,
   rollout, swarm, and repair facts.
3. Update `/ready`, control-plane status, and deploy verification to emit or require `authority_session_id` and
   `rollout_lease_id`.
4. Add regression tests covering stale freeze expiry, mixed rollout replicas, revoked leases, and RBAC-degraded
   rollout reads.

## Handoff to deployer

1. Do not advance canary weight unless the reported `rollout_lease_id` is current, unexpired, and tied to the active
   `authority_session_id`.
2. Treat `session_class="recovery"` as serve-only: keep diagnostics and typed dependency reads available, but do not
   promote or widen rollout.
3. During rollback, preserve session and repair history and verify the lease now points at the rollback revision.
4. Promotion is complete only when serving and promotion sessions converge on fresh digests and no open repair remains.
