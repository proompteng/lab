# 65. Jangar Recovery Epoch Cutover and Backlog Seat Enforcement Contract (2026-03-21)

Status: Approved for implementation (`plan`)
Date: `2026-03-21`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/64-torghut-profit-window-cutover-and-escrow-enforcement-contract-2026-03-21.md`

Extends:

- `64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
- `63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`

## Executive summary

The decision is to implement the March 21 recovery-epoch and backlog-seat model through a staged cutover:
shadow compilation first, then seal-and-reseat, then dispatch and rollout enforcement. I am not taking the one-release
hard cutover because the live system is already in the exact state that would make that unsafe.

The current evidence is concrete:

- `GET http://jangar.jangar.svc.cluster.local/ready` at `2026-03-21T00:29:49Z`
  - returns HTTP `200`;
  - reports `execution_trust.status="degraded"`;
  - still cites `jangar-control-plane.requirements.pending=5`;
  - still cites unreconciled `StageStaleness` debt across both `jangar-control-plane` and `torghut-quant`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents` at
  `2026-03-21T00:29:49Z`
  - reports `rollout_health.status="healthy"` for `agents` and `agents-controllers`;
  - reports `database.status="healthy"` with `24/24` migrations applied;
  - still reports `dependency_quorum.decision="block"` and `execution_trust.status="degraded"`.
- `kubectl -n agents get swarm jangar-control-plane torghut-quant -o yaml`
  - shows both swarms still `phase="Frozen"`;
  - shows `freeze.until` values from `2026-03-11` that are already in the past;
  - shows `updatedAt` still pinned to `2026-03-11T15:48:11.742Z` and `2026-03-11T15:48:13.974Z`.
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 80`
  - shows recent `BackoffLimitExceeded` on `jangar-control-plane-discover-sched-*` and many
    `jangar-control-plane-torghut-quant-req-*` jobs;
  - also shows new plan/discover/verify schedule work starting on newer images.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still stores `swarmUnfreezeTimers` in process memory;
  - still sorts requirement dispatch by priority and age, not by recovery-epoch ownership.
- `services/jangar/src/routes/ready.tsx`
  - still treats "not blocked and not unknown" as ready enough for serving;
  - does not emit one authoritative recovery epoch id or seal state.

The reason for the staged cutover is simple: rollout health is already greener than backlog truth. The tradeoff is
extra compiler, parity, and verification work before enforcement. I am keeping that trade because the six-month risk is
not a down pod; it is stale work relaunching after a healthy rollout and being mistaken for legitimate recovery.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience/reliability with safer rollout behavior while improving Torghut profitability through better control-plane
  authority

This document succeeds when:

1. `dispatch`, `/ready`, `/api/agents/control-plane/status`, `Swarm.status`, and deploy verification can all cite the
   same `recovery_epoch_id`;
2. every queued requirement item and stage run can cite one `backlog_seat_id` and one owning epoch before launch;
3. any seat owned by a retired epoch is explicitly superseded, reseated, or quarantined instead of being retried
   opportunistically;
4. rollout widening fails closed when the active epoch is not sealed or when retired seats remain launchable;
5. stale freeze debt is converted into durable reseat work instead of living indefinitely in `freeze.until` plus
   controller-local timers.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster is serving, but it is not proving that serving health and runnable backlog belong to the same cutover.

- `/ready`
  - says Jangar is available enough to serve;
  - does not say which epoch that answer belongs to.
- `/api/agents/control-plane/status`
  - says rollout is healthy and database state is healthy;
  - also says dependency quorum is blocked and execution trust is degraded.
- `kubectl -n agents get swarm ... -o yaml`
  - proves both swarms are still logically frozen on March 11 truth;
  - proves the stale debt is durable in CR status even while new jobs continue to start.
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 80`
  - shows recent requirement backoff failures and current schedule starts overlapping in the same namespace;
  - proves stale and fresh work can coexist without a single authoritative boundary.

Interpretation:

- serving health is real, but not sufficient for safe rollout;
- rollout health is real, but not sufficient for safe dispatch;
- the missing contract is cutover, not connectivity.

### Source architecture and high-risk modules

The source still treats recovery as behavior and timing more than durable ownership.

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - `swarmUnfreezeTimers` keeps freeze repair process-local;
  - `sortRequirementSignalsForDispatch(...)` has no epoch, digest, or seat identity in its dispatch sort.
- `services/jangar/src/server/control-plane-status.ts`
  - can report healthy rollout and degraded execution trust at the same time;
  - does not yet emit the recovery-epoch ids needed to prove which truth is current.
- `services/jangar/src/routes/ready.tsx`
  - preserves serving-vs-promotion separation, which is correct;
  - but it still has no typed recovery-epoch projection that a deployer can compare with status and dispatch.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - can prove rollout digest and readiness;
  - cannot yet prove that launchable backlog has been reseated onto the promoted epoch.

### Database, schema, freshness, and consistency evidence

The persistent substrate is ready for this cutover. The main missing piece is schema and projection design, not
database reliability.

- Jangar status reports `database.connected=true`, `latency_ms=3`, and `migration_consistency.unapplied_count=0`.
- direct DB exec remains intentionally blocked for this service account:
  - `kubectl cnpg psql -n jangar jangar-db -- app -c ...`
  - fails with `pods "jangar-db-1" is forbidden ... cannot create resource "pods/exec"`.
- that RBAC limit reinforces the architecture choice:
  - deploy verification must consume typed projections and additive tables, not ad hoc privileged shell access.

## Problem statement

The discover-stage contract correctly defined `recovery_epochs` and `backlog_seats`, but it did not yet define the
safe adoption path. Without that plan-stage contract, the implementation can still fail in three expensive ways:

1. a new rollout can declare success while launchable backlog still belongs to a retired runtime;
2. stale freeze debt can remain visible for days because the system lacks an explicit reseat-and-seal workflow;
3. operators can see healthy rollout data and degraded execution truth, but still have no single deploy gate that tells
   them whether promotion is allowed.

That is the gap this document closes.

## Alternatives considered

### Option A: hard-cut directly to epoch and seat enforcement

Summary:

- add the new tables and immediately make dispatch and rollout depend on them.

Pros:

- smallest elapsed time to final behavior;
- simpler mental model once it works.

Cons:

- too risky with live stale work already present;
- offers no parity window to prove that `ready`, status, dispatch, and deploy verification are projecting the same ids;
- increases the chance of deadlocking rollouts on the first release.

Decision: rejected.

### Option B: split controller topology first, then revisit backlog truth

Summary:

- isolate dispatch, serving, and reconciliation into more deployments before changing authority objects.

Pros:

- narrows resource contention and partial-failure domains;
- remains valuable later if the control plane keeps growing.

Cons:

- does not stop stale work from relaunching under the wrong epoch;
- spends rollout complexity before fixing the actual truth boundary;
- pushes the current safety bug into a larger topology.

Decision: rejected for the current phase.

### Option C: shadow compile, seal, reseat, and then enforce

Summary:

- compile recovery epochs and backlog seats in shadow;
- prove cross-surface parity;
- reseat or quarantine stale backlog;
- enforce only after one active sealed epoch is demonstrably stable.

Pros:

- directly addresses the live March 21 failure mode;
- gives engineer and deployer stages measurable parity gates;
- preserves future option value for later topology splits.

Cons:

- requires more staged work and more additive projections;
- delays hard enforcement by one cadence window.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will cut over to recovery-epoch and backlog-seat authority through a three-phase plan: shadow compile, seal and
reseat, then enforce. No rollout may rely on these objects until parity is proven. Once parity is proven, no dispatch
or promotion path may ignore them.

## Planned architecture

### 1. Shadow compiler and parity surfaces

Implement the additive persistence from doc 64, then expose one parity projection everywhere that matters:

- `recovery_epoch_id`
- `epoch_status`
- `epoch_sealed`
- `epoch_revision_digest`
- `launchable_backlog_seat_count`
- `retired_backlog_seat_count`
- `quarantined_backlog_seat_count`
- `oldest_unreconciled_seat_age_seconds`

Required consumers:

- `services/jangar/src/routes/ready.tsx`
- `services/jangar/src/server/control-plane-status.ts`
- `Swarm.status`
- `packages/scripts/src/jangar/verify-deployment.ts`
- dispatch and requirement-launch paths in `supporting-primitives-controller.ts`

Plan requirement:

- these consumers may differ in reduction level, but not in ids;
- one request for the same swarm and execution class must produce the same active `recovery_epoch_id` everywhere.

### 2. Reseat and supersession rules

Every stage run and requirement signal must resolve to one backlog seat before launch. Seats move through:

- `shadow_compiled`
- `active`
- `reseat_required`
- `retired`
- `quarantined`

Rules:

- opening a new epoch on digest or topology change marks all seats from older epochs `reseat_required`;
- a seat may be reseated only if its underlying requirement/work item is still semantically valid;
- helper-path, auth, or manifest-contract failures are quarantine reasons, not automatic reseat reasons;
- no seat from a retired epoch may launch, even if it is older and higher priority than current seats.

### 3. Enforcement gates

Dispatch gate:

- block any launch without an `active` seat owned by the currently sealed epoch.

Promotion gate:

- `verify-deployment` must fail when:
  - the active epoch is not `sealed`;
  - any `reseat_required` or `retired` seat is still launchable;
  - freeze-expiry debt is older than one cadence window without a matching reseat plan;
  - `Swarm.updatedAt` still points at a pre-cutover truth snapshot while rollout digest has moved on.

Serving gate:

- `/ready` may remain `200` for serving continuity while promotion is blocked;
- the response must still emit the active epoch and seal state so operators stop confusing service liveness with
  rollout clearance.

### 4. Metrics and audit projections

Add explicit observability so the cutover is measurable:

- `jangar_recovery_epoch_shadow_parity_mismatch_total`
- `jangar_backlog_seat_reseat_required_total`
- `jangar_backlog_seat_quarantined_total`
- `jangar_backlog_seat_launch_block_total`
- `jangar_swarm_freeze_unreconciled_age_seconds`
- `jangar_recovery_epoch_active_revision_info`

These metrics must be sufficient for deploy verification and oncall debugging without privileged DB access.

## Validation plan

Implementation is not complete until these gates pass:

1. unit tests prove `/ready`, control-plane status, and deploy verification project the same epoch and seat counts for
   the same snapshot;
2. regression tests prove a seat owned by a retired epoch cannot launch even when it has higher dispatch priority;
3. regression tests prove stale `freeze.until` debt opens `reseat_required` work instead of silently leaving the swarm
   frozen forever;
4. regression tests prove helper-path or auth failures quarantine seats rather than auto-reseating them;
5. deploy verification proves no rollout can promote while retired seats remain launchable.

## Rollout plan

1. shadow write epochs and seats for one full cadence window without changing dispatch.
2. enable parity projections in `/ready`, status, and deploy verification, but keep them advisory.
3. cut dispatch over to active sealed seats only for stage schedules first.
4. cut requirement dispatch over once stage-seat parity is stable.
5. make deploy verification fail closed on stale or unsealed backlog truth.

## Rollback plan

If cutover misbehaves:

- disable dispatch enforcement first;
- keep writing epochs and seats for forensics;
- preserve `reseat_required` and `quarantined` history;
- revert deploy verification to advisory mode before reverting shadow compilation;
- do not delete epoch or seat history during rollback.

## Risks and follow-up

- long-running jobs may span epoch boundaries, so launch ownership and completion ownership must be modeled separately;
- over-aggressive enforcement could stall healthy serving rollouts if parity reducers drift;
- the RBAC model means deploy tooling must trust typed projections, so those projections need stronger regression
  coverage than the current ad hoc status reducers.

## Engineer handoff contract

Engineer stage is complete only when:

1. additive migrations for doc 64 objects and this cutover projection are landed;
2. `supporting-primitives-controller.ts` dispatches by active seat ownership, not just priority and age;
3. `/ready`, status, and deploy verification expose the same active epoch ids and seat counters;
4. tests cover retired-seat launch blocking, freeze-expiry reseat, and quarantine semantics.

## Deployer handoff contract

Deployer stage is complete only when live validation shows:

1. `kubectl -n agents get swarm jangar-control-plane -o yaml` shows current `updatedAt` rather than March 11 stale
   truth after cutover;
2. `/ready` and `/api/agents/control-plane/status` cite the same active `recovery_epoch_id`;
3. no `jangar-control-plane-torghut-quant-req-*` job launches from a retired seat after enforcement is enabled;
4. deploy verification fails closed when epoch seal or seat parity is missing, and passes once parity is restored.
