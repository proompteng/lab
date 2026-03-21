# 64. Jangar Recovery Epochs and Backlog Seats Contract (2026-03-21)

Status: Approved for implementation (`discover`)
Date: `2026-03-21`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-discover`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/63-torghut-profit-windows-and-evidence-escrow-contract-2026-03-21.md`

Extends:

- `63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`
- `61-jangar-runtime-kit-ledger-and-execution-class-admission-contract-2026-03-20.md`

## Executive summary

The decision is to stop letting Jangar recover stale stage debt and queued requirement work from process-local state,
best-effort timers, or whatever rollout revision happens to be running. Jangar will instead compile two durable
objects: **Recovery Epochs** and **Backlog Seats**.

The evidence from `2026-03-21` makes this necessary:

- `GET http://jangar.jangar.svc.cluster.local/ready` at `2026-03-21T00:07:40Z`
  - returns HTTP `200`;
  - reports `execution_trust.status="degraded"`;
  - still cites `jangar-control-plane.requirements.pending=5`;
  - still cites unreconciled `StageStaleness` debt for both `jangar-control-plane` and `torghut-quant`.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m` at
  `2026-03-21T00:07:40Z`
  - reports both swarms in `phase="Recovering"` even though their `updated_at` values are still `2026-03-11`;
  - reports `rollout_health.status="degraded"` because `agents-controllers` is `updated=2`, `ready=1`, `desired=2`;
  - reports `database.status="healthy"` and `24/24` migrations applied;
  - reports no recent failed jobs for the staged cadence view even while failed requirement jobs are still present.
- `kubectl -n agents get jobs`
  - shows repeated failed `jangar-control-plane-torghut-quant-req-*` jobs aged `23m` through `112m`;
  - shows current discover and verify schedule runs still executing;
  - proves stale and current work are coexisting without one durable epoch boundary.
- `kubectl -n agents logs job/jangar-control-plane-torghut-quant-req-00gc3cxb-3-ngvw-368131ff --tail=200`
  - shows the failed requirement handoff still bootstrapping from image `jangar:c474fc44`;
  - fails on `python3: can't open file '/app/skills/huly-api/scripts/huly-api.py'`;
  - proves queued work can still launch against a superseded runtime after newer revisions are already serving.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still keeps `swarmUnfreezeTimers` in process memory;
  - sorts requirement signals only by priority and creation time;
  - has no durable concept of "this backlog item belongs to the old runtime epoch and must not relaunch."
- `services/jangar/src/server/control-plane-status.ts`
  - still uses rollout-derived fallback (`maybeUseSplitTopologyControllerRollout`, `maybeUseSplitTopologyRuntimeRollout`)
    to infer controller and runtime health from replica availability;
  - has no persistent epoch identity tying rollout state to backlog safety.

The tradeoff is more additive persistence and explicit supersession rules. I am keeping that trade because the next
six-month failure mode is not a dead pod. It is a healthy-enough serving path replaying stale recovery debt and stale
queued work against the wrong runtime, then calling that "recovering."

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-discover`
- swarmName: `jangar-control-plane`
- swarmStage: `discover`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience/reliability with safer rollout behavior, while improving Torghut profitability through better control-plane
  authority

This document succeeds when:

1. every runnable stage or requirement item can cite one `recovery_epoch_id` and one `backlog_seat_id` before it
   launches;
2. stale queued work cannot relaunch against a superseded runtime revision after a new epoch is opened;
3. `/ready`, `/api/agents/control-plane/status`, deploy verification, and requirement dispatch all expose the same
   active epoch ids when they overlap;
4. rollout widening is blocked whenever the new epoch is not sealed or when runnable backlog still points at a retired
   epoch;
5. stale freeze debt becomes durable repair state rather than an immortal `freeze.until` timestamp plus process-local
   retry behavior.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster is serving, but it is not proving that recovery truth and runnable backlog truth belong to the same
revision.

- `kubectl -n agents get pods`
  - shows `agents-controllers-b6bcfc46c-gfk9k` ready and `agents-controllers-b6bcfc46c-lmldv` unready;
  - shows current discover and verify stage pods still running;
  - shows many failed requirement pods still retained alongside current stage activity.
- `kubectl -n agents get events --sort-by=.lastTimestamp | tail -n 60`
  - shows repeated `BackoffLimitExceeded` events on `jangar-control-plane-torghut-quant-req-*`;
  - shows the newest discover cron and step jobs starting cleanly on `jangar:e88a1045`;
  - proves the system can advance new schedule work before it has retired old failed work.
- `kubectl -n jangar get events --sort-by=.lastTimestamp | tail -n 40`
  - shows the Jangar serving rollout replacing pods `28m` ago;
  - shows a readiness probe refusal during startup;
  - proves serving rollout timing is still independent from stale swarm debt retirement.

Interpretation:

- the control plane has partial recovery, not a stable cutover point;
- rollout health and backlog safety are still related only by inference;
- the absence of one durable epoch boundary is now a reliability bug, not just an observability gap.

### Source architecture and high-risk modules

The current source tree keeps recovery ownership and backlog supersession implicit.

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - `swarmUnfreezeTimers` is still an in-memory coordinator for freeze repair;
  - `sortRequirementSignalsForDispatch(...)` has no runtime-epoch awareness, no supersession rule, and no durable
    backlog seat identity;
  - the dispatcher can therefore keep retrying old work when the right action is to reseat or quarantine it.
- `services/jangar/src/routes/ready.tsx`
  - still merges execution trust across namespaces and returns `200` whenever status is not `blocked` or `unknown`;
  - it does not tell a deployer or stage runner which recovery epoch is authoritative for that answer.
- `services/jangar/src/server/control-plane-status.ts`
  - still allows rollout availability to stand in for controller/runtime truth in split-topology cases;
  - still has no durable link between rollout revision, recovery debt, and runnable backlog.
- `services/jangar/scripts/codex/lib/huly-api-client.ts`
  - the missing-helper path bug was fixed in source, but the failed requirement jobs prove launch-time work can still
    run under older images when backlog items are not superseded explicitly.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - can prove deployment health and digest state;
  - cannot yet prove that the active backlog has been reseated onto the same epoch before promotion.

### Database, schema, freshness, and consistency evidence

The persistent substrate is healthy, but the missing objects are now more important than the existing ones.

- Jangar control-plane status reports:
  - `database.status="healthy"`;
  - `migration_consistency.latest_applied="20260312_torghut_simulation_control_plane_v2"`;
  - `migration_consistency.unapplied_count=0`.
- direct cluster-scope inspection is intentionally limited:
  - `kubectl get application -n argocd` is forbidden for this service account;
  - `kubectl get cluster.postgresql.cnpg.io -A` is forbidden;
  - `kubectl get clickhouseinstallations.clickhouse.altinity.com -A` is forbidden.
- those RBAC gaps do not block the architecture conclusion:
  - Jangar already has durable storage and fresh status data;
  - what it lacks is a durable record of which backlog items are valid for which recovery epoch.

Interpretation:

- the database is not the bottleneck;
- the missing schema is the bottleneck;
- recovery safety now depends on additive persistence for epoch ownership and backlog supersession.

## Problem statement

Jangar still has four common-mode failure channels that the current March 20 contract stack does not retire:

1. stale freeze debt can remain visible for days after `freeze.until` has passed because retirement is still more
   behavioral than durable;
2. queued requirements and stage work can keep launching against superseded runtime revisions because backlog items are
   not bound to one active recovery epoch;
3. rollout health can improve before the system has proven that current runnable work belongs to the promoted runtime;
4. deploy verification has no contract to assert "old work is quarantined or reseated" before promotion.

That means the control plane can be live, partially healed, and still unsafe to trust for autonomous work dispatch.

## Alternatives considered

### Option A: split Jangar into more deployments without new backlog truth

Summary:

- move serving, Huly handoff, quant projection, and stage scheduling into separate deployments or services;
- rely on physical isolation to narrow failures.

Pros:

- reduces request-path contention;
- keeps serving failures from directly sharing a pod with heavier work.

Cons:

- does not stop stale queued work from launching against old images;
- increases rollout sprawl and operational surface area immediately;
- treats topology as the fix for stale truth rather than as a future optimization.

Decision: rejected.

### Option B: keep current topology and tune TTLs, retries, and queue budgets

Summary:

- add tighter caching, retry ceilings, and backoff tuning;
- keep the current request-time and process-local recovery model.

Pros:

- smallest implementation delta;
- may reduce visible retry churn quickly.

Cons:

- still cannot prove which backlog items belong to the current runtime;
- still lets stale work and fresh work coexist without a cutover contract;
- keeps deploy verification blind to backlog supersession.

Decision: rejected.

### Option C: recovery epochs plus backlog seats

Summary:

- compile durable recovery epochs per swarm and execution class;
- bind every pending stage or requirement item to a backlog seat owned by one epoch;
- allow launch only from active, sealed epochs and supersede or quarantine older seats explicitly.

Pros:

- directly addresses the live stale-runtime replay evidence;
- makes rollout safety stronger than digest parity alone;
- preserves future option value because physical deployment splits can be added later without changing the authority
  model.

Cons:

- adds new tables, compiler logic, and migration work;
- requires staged cutover because old queue records and live jobs already exist.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile one active recovery epoch per swarm execution class and one backlog seat per runnable work item.
Dispatch, readiness, status, and deploy verification must all reference those objects instead of inferring recovery
truth from timers, queue age, or rollout availability.

## Architecture

### 1. Recovery epochs

Add additive persistence:

- `control_plane_recovery_epochs`
  - `recovery_epoch_id`
  - `swarm_name`
  - `execution_class` (`serving`, `collaboration`, `plan`, `implement`, `verify`, `torghut_quant`)
  - `active_revision`
  - `execution_receipt_ids_json`
  - `consumer_projection_ids_json`
  - `recovery_cell_ids_json`
  - `freeze_reason`
  - `status` (`shadow`, `active`, `sealed`, `retired`, `quarantined`)
  - `opened_at`
  - `sealed_at`
  - `retired_at`
  - `evidence_digest`

Rules:

- a new epoch opens whenever the admitted runtime digest, execution receipt set, or recovery-cell set changes in a
  way that would affect runnable work;
- serving may move to a new epoch before collaboration or stage-runner epochs do, but each transition must be explicit;
- an epoch is not `sealed` until controller rollout parity, required receipts, and required projections all agree;
- `/ready`, deploy verification, and dispatch surfaces must report the active epoch ids they are trusting.

### 2. Backlog seats

Add additive persistence:

- `control_plane_backlog_seats`
  - `backlog_seat_id`
  - `swarm_name`
  - `stage_name`
  - `requirement_signal_name`
  - `priority_score`
  - `target_recovery_epoch_id`
  - `admitted_revision`
  - `admitted_runtime_kit_id`
  - `consumer_projection_id`
  - `status` (`queued`, `running`, `completed`, `failed`, `superseded`, `quarantined`, `canceled`)
  - `failure_budget_remaining`
  - `dispatch_after`
  - `last_job_ref`
  - `last_transition_at`
  - `superseded_by_epoch_id`

Rules:

- every runnable stage and requirement item must be represented by one seat before launch;
- when a new epoch opens, queued seats pointing at the previous epoch must either be reseated or explicitly
  quarantined before another launch attempt;
- launchers must reject any seat whose target epoch is no longer `active` or `sealed`;
- job retries consume the same seat rather than creating authority ambiguity through new transient jobs.

### 3. Epoch cutover and supersession invariants

Mandatory invariants:

1. a stage launcher may only create a job when `backlog_seat.target_recovery_epoch_id == active_epoch_id`;
2. promotion may not proceed while any runnable seat still points at a retired epoch;
3. `requirements.pending` must decompose into seat states (`queued`, `superseded`, `quarantined`) instead of one raw
   counter;
4. stale freeze retirement must close or supersede the related recovery epoch instead of mutating in-memory timers only.

This is the safer rollout behavior the live cluster is currently missing.

### 4. Surface contracts

- `/ready`
  - consumes only the active `serving` epoch and returns its `recovery_epoch_id`.
- `/api/agents/control-plane/status`
  - becomes the audit and operator surface for all active epochs plus backlog seat summaries;
  - must show seat counts by state and active epoch per execution class.
- requirement and stage launchers
  - consume the `collaboration`, `plan`, `implement`, and `verify` epochs, not just raw swarm freeze state.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - must prove both digest parity and epoch parity:
    - the promoted deployment matches the sealed epoch;
    - no runnable backlog seat still points at the prior epoch.

### 5. Validation and rollout gates

Engineer-stage minimum validation:

1. migration tests for the new tables plus expiry semantics;
2. regression proving a superseded seat cannot relaunch after epoch cutover;
3. restart test proving recovery epochs and backlog seats survive controller restart and leader change;
4. parity test proving `/ready`, status, dispatch, and deploy verification cite the same active epoch ids;
5. regression proving old `c474fc44`-bound requirement seats would be superseded rather than relaunched once the new
   epoch is active.

Deployer-stage acceptance gates:

1. shadow-write epochs and seats for at least two full stage cadences before enforcement;
2. show `superseded` or `quarantined` counts draining instead of raw retry churn for old work;
3. prove no new jobs launch against a retired epoch during one full promotion cycle;
4. keep rollout blocked if seat supersession and deployment revision disagree.

## Rollout plan

Phase 0. Write-only.

- create epochs and seats in parallel with existing timers and retry logic;
- expose them in status without changing admission.

Phase 1. Shadow admission.

- have launchers compute whether a seat would be blocked or superseded under the new contract;
- emit mismatch metrics whenever the old launcher would run work that the new contract would stop.

Phase 2. Enforce launch supersession.

- block new launches for seats bound to retired epochs;
- keep serving on the active serving epoch while non-serving epochs cut over separately.

Phase 3. Enforce promotion parity.

- require deploy verification to prove sealed-epoch parity and zero runnable seats on retired epochs before widening.

## Rollback plan

- keep old timers and queue counters readable during Phases 0-2 so launchers can temporarily fall back if epoch
  compilation is wrong;
- if shadow parity diverges or seat supersession is misclassifying live work, revert admission to the prior launcher,
  keep writing epoch/seat records for forensics, and do not delete them;
- if deploy verification sees epoch disagreement after rollout, stop widening, reopen the prior epoch as active, and
  mark the new epoch `quarantined` until corrected.

## Risks and open questions

- over-superseding seats could delay legitimate work if epoch boundaries are cut too often;
- under-superseding seats would preserve the current stale-runtime replay failure mode;
- the control plane must decide how long to retain completed and superseded seats without turning the queue ledger into
  unbounded history;
- physical service splits may still be worth doing later, but only after epoch truth is durable.

## Handoff to engineer and deployer

Engineer handoff:

- add the new migrations, epoch compiler, seat compiler, and launcher enforcement;
- remove launch-time reliance on process-local timers as the only recovery owner;
- add the supersession, restart, and parity tests listed above.

Deployer handoff:

- require shadow parity first;
- do not promote if any runnable seat still points at a retired epoch;
- treat any launch against a retired epoch as a hard rollback trigger for the admission cutover.
