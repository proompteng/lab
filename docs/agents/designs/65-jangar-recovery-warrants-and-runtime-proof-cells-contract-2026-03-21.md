# 65. Jangar Recovery Warrants and Runtime Proof Cells Contract (2026-03-21)

Status: Approved for implementation (`plan`)
Date: `2026-03-21`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/64-torghut-hypothesis-vaults-and-post-cost-profit-tapes-contract-2026-03-21.md`

Extends:

- `64-jangar-recovery-epochs-and-backlog-seats-contract-2026-03-21.md`
- `63-jangar-consumer-projections-and-latency-class-admission-contract-2026-03-20.md`
- `62-jangar-execution-receipts-and-stage-recovery-cells-contract-2026-03-20.md`

## Executive summary

The decision is to stop treating a healthy rollout and an active backlog as enough proof that Jangar may safely launch,
promote, or serve authority to consumers. Jangar will compile two new durable objects:
**Recovery Warrants** and **Runtime Proof Cells**. It will also stamp consumer-facing **Projection Watermarks** so
Torghut and deploy verification can tell which authority digest they are actually consuming.

The March 21, 2026 evidence is explicit:

- `GET http://jangar.jangar.svc.cluster.local/ready` at `2026-03-21T00:30:01Z`
  - returns HTTP `200`;
  - reports `execution_trust.status="degraded"`;
  - cites `requirements are degraded on jangar-control-plane: pending=5`;
  - cites both `jangar-control-plane` and `torghut-quant` as `freeze expiry unreconciled (StageStaleness)`;
  - proves serving health and execution authority are still different things.
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents&window=15m` at
  `2026-03-21T00:30:02Z`
  - reports `rollout_health.status="healthy"` with `agents=1/1` and `agents-controllers=2/2`;
  - still reports both swarms in `phase="Recovering"` with `updated_at` values on `2026-03-11`;
  - reports `database.status="healthy"` with `24/24` migrations applied;
  - proves rollout, database health, and runnable backlog truth are still not bound together durably.
- `kubectl get pods -n agents` at `2026-03-21T00:29:57Z`
  - shows both `agents-controllers` pods ready;
  - shows repeated failed `jangar-control-plane-torghut-quant-req-*` pods alongside current running discover, plan,
    and verify work;
  - proves stale and fresh work are coexisting under a healthy-looking rollout.
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -n 60` at `2026-03-21T00:29:58Z`
  - shows repeated `BackoffLimitExceeded` on old requirement jobs;
  - shows new schedule and plan jobs continuing to launch on current images;
  - proves the control plane can advance while still replaying stale debt.
- `kubectl logs -n agents pod/jangar-control-plane-torghut-quant-req-00gc3cxb-3-ngvw-368g2k6h --tail=200` at
  `2026-03-21T00:31:18Z`
  - fails with `python3: can't open file '/app/skills/huly-api/scripts/huly-api.py'`;
  - proves runtime completeness is still an admission bug, not just an observability bug.
- source inspection:
  - `services/jangar/src/server/supporting-primitives-controller.ts`
    still holds `swarmUnfreezeTimers` in process memory and sorts requirement signals by priority plus creation time;
  - `services/jangar/src/server/control-plane-status.ts`
    still derives controller and runtime health from rollout availability with
    `maybeUseSplitTopologyControllerRollout(...)` and `maybeUseSplitTopologyRuntimeRollout(...)`;
  - existing tests cover control-plane status reduction, but searches for `recovery_warrant`, `runtime_proof_cell`,
    or `projection_watermark` under executable Jangar code return nothing.

The tradeoff is more additive persistence and stricter admission. I am keeping that trade because the next six-month
control-plane failure will not come from a missing readiness probe. It will come from healthy rollouts relaunching old
work on incomplete runtime kits and then advertising that state as current authority.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster/source/database state and merge architecture artifacts that improve Jangar resilience and
  safer rollout behavior while enabling stronger Torghut profitability contracts

This document succeeds when:

1. every launch-capable execution class can cite one active `recovery_warrant_id` before it starts work;
2. every warrant can prove runtime completeness through required proof cells, including the helper/runtime assets that
   current failed jobs are missing;
3. consumer-facing projections and deploy verification can cite one `projection_watermark_id` and one warrant digest,
   not only deployment readiness;
4. rollout widening is blocked whenever active backlog seats, runtime proof, and serving authority disagree.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster is no longer a simple outage story. It is a proof-of-authority story.

- `/ready`
  - proves serving is available and leader election is healthy;
  - also proves execution trust remains degraded because the backlog and freeze surfaces are stale.
- `/api/agents/control-plane/status`
  - proves rollout and database health are good enough to support stronger authority contracts;
  - also proves the current status API still lets rollout health and runnable backlog truth drift apart.
- `kubectl get pods` and `kubectl get events`
  - prove current stage activity and old failing requirement work are overlapping in time;
  - therefore Jangar needs a cutover contract stronger than "new pods are ready."

Interpretation:

- the system is healthy enough to continue, but not healthy enough to trust implicitly;
- safer rollout now depends on durable proof that the active runtime kit and the active backlog belong to the same
  admitted warrant.

### Source architecture and high-risk modules

The source tree still makes recovery truth too behavioral.

- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still uses `swarmUnfreezeTimers` as a process-local repair mechanism;
  - still dispatches requirement work in `sortRequirementSignalsForDispatch(...)` without runtime completeness or
    warrant awareness;
  - therefore cannot prove that a queued item belongs to the active admitted runtime kit.
- `services/jangar/src/server/control-plane-status.ts`
  - still turns healthy `agents-controllers` rollout into healthy controller/runtime authority when split-topology
    inference is available;
  - therefore hides the distinction between "pods are ready" and "the warranted runtime kit is complete."
- tests:
  - `services/jangar/src/server/__tests__/control-plane-status.test.ts` covers quorum and degraded/healthy reduction;
  - there are no executable parity tests for warrants, proof cells, or projection watermarks because those objects do
    not exist in code yet.

### Database, schema, freshness, and consistency evidence

The persistent substrate is healthy, but it is not yet carrying enough control-plane proof.

- `/api/agents/control-plane/status`
  - reports `database.status="healthy"` and `latest_applied="20260312_torghut_simulation_control_plane_v2"`;
  - proves additive persistence is feasible now.
- direct cluster-scope inspection remains intentionally bounded:
  - this service account can read namespace-local pods, jobs, logs, and events;
  - it cannot list all `deployments.apps` in `torghut` or exec into `torghut-db`, which is acceptable for a control
    plane architecture conclusion;
  - exact errors observed:
    - `deployments.apps is forbidden` in namespace `torghut`;
    - `pods/exec is forbidden` in namespace `torghut`.
- those RBAC gaps do not change the direction:
  - Jangar already has durable storage and enough read surfaces;
  - it lacks durable proof that serving rollout, runtime-kit completeness, backlog seats, and consumer projections all
    belong to the same active authority digest.

## Problem statement

Jangar still has five common-mode failure channels that the March 20-21 contract stack does not finish retiring:

1. rollout readiness can still stand in for runtime completeness when helper assets or other runtime-kit contents are
   missing;
2. queued or retried work can still relaunch against incomplete or superseded runtime state;
3. backlog safety is not yet bound to one admitted runtime digest and one current proof set;
4. consumer-facing status can advertise healthy controller/runtime authority without exposing which proof it is
   trusting;
5. deploy verification can prove digest parity, but not "this digest is backed by a complete runtime kit and zero
   runnable stale seats."

That means Jangar can be live, green, and still unsafe to trust for autonomous rollout or trading-side authority.

## Alternatives considered

### Option A: split more deployments and rely on topology for safety

Pros:

- lowers immediate resource contention;
- narrows the blast radius of some request-path failures.

Cons:

- does not prove backlog items belong to the admitted runtime;
- does not stop incomplete runtime kits from launching work;
- increases rollout sprawl before the authority model is fixed.

Decision: rejected.

### Option B: keep epochs and seats, but tighten queue TTLs and rollout thresholds

Pros:

- smaller implementation delta;
- may reduce visible retry churn quickly.

Cons:

- still leaves runtime completeness largely implicit;
- still lets healthy rollout mask incomplete runtime kits;
- still gives consumers no durable watermark for the authority they consumed.

Decision: rejected.

### Option C: recovery warrants plus runtime proof cells and projection watermarks

Pros:

- directly addresses the live helper-path and stale-work evidence;
- makes rollout proof stronger than pod readiness or digest parity alone;
- preserves future option value because topology changes can happen later without changing authority semantics.

Cons:

- adds new tables, compiler logic, and enforcement;
- requires staged cutover because current launchers and status reducers are already live.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will compile one active recovery warrant per execution class, one proof-cell set per runtime kit, and one
projection watermark per consumer-facing authority digest. Launch, readiness, status, and deploy verification must
consume those objects instead of inferring truth from rollouts and timers alone.

## Architecture

### 1. Recovery warrants

Add additive persistence:

- `control_plane_recovery_warrants`
  - `recovery_warrant_id`
  - `recovery_epoch_id`
  - `swarm_name`
  - `execution_class` (`serving`, `collaboration`, `discover`, `plan`, `implement`, `verify`, `torghut_quant`)
  - `admitted_revision`
  - `admitted_image_digest`
  - `runtime_kit_digest`
  - `required_proof_cell_ids_json`
  - `active_backlog_seat_ids_json`
  - `projection_watermark_ids_json`
  - `status` (`draft`, `active`, `sealed`, `superseded`, `broken`, `quarantined`)
  - `opened_at`
  - `sealed_at`
  - `superseded_at`
  - `reason_codes_json`

Rules:

- a warrant opens whenever runtime-kit digest, admitted revision, or required proof set changes materially;
- a warrant becomes `sealed` only when required proof cells are healthy, active backlog seats target that warrant, and
  consumer projections have been stamped with the same digest;
- serving, collaboration, and stage-runner warrants may roll separately, but every split must be explicit and
  queryable.

### 2. Runtime proof cells

Add additive persistence:

- `control_plane_runtime_proof_cells`
  - `runtime_proof_cell_id`
  - `recovery_warrant_id`
  - `proof_kind` (`image_digest`, `runtime_kit`, `helper_asset`, `config_digest`, `secret_binding`, `network_identity`)
  - `proof_subject`
  - `expected_ref`
  - `observed_ref`
  - `artifact_ref`
  - `content_hash`
  - `status` (`healthy`, `degraded`, `missing`, `expired`, `quarantined`)
  - `reason_codes_json`
  - `observed_at`
  - `expires_at`

Rules:

- every launch-capable warrant declares required proof kinds before it may be sealed;
- the missing Huly helper path is represented as a first-class failing `helper_asset` proof cell, not only as a pod log;
- launchers must refuse any seat whose target warrant lacks healthy required proof cells.

### 3. Projection watermarks

Add additive persistence:

- `control_plane_projection_watermarks`
  - `projection_watermark_id`
  - `consumer_key` (`torghut_dependency_quorum`, `torghut_quant_health`, `torghut_market_context`, `deploy_verification`)
  - `recovery_warrant_id`
  - `projection_digest`
  - `source_ref`
  - `observed_at`
  - `expires_at`
  - `status` (`fresh`, `degraded`, `expired`, `quarantined`)
  - `reason_codes_json`

Rules:

- any consumer-facing authority projection must cite its active watermark id and warrant id;
- status, readiness, and deploy verification must refuse to claim promotion-safe authority when their watermark points
  at a broken or superseded warrant;
- Torghut may mirror only stamped watermarks into its local authority tables once this contract lands.

### 4. Backlog and rollout invariants

Mandatory invariants:

1. a stage or requirement launcher may create work only when its `backlog_seat.target_recovery_epoch_id` belongs to
   the active sealed warrant for that execution class;
2. a healthy deployment rollout is insufficient on its own to derive healthy controller/runtime authority once warrants
   are enabled;
3. any failed proof cell that is required by an active warrant becomes a rollout block, not only a status warning;
4. deploy verification must prove warrant parity, projection-watermark freshness, and zero runnable seats on superseded
   warrants before widening.

### 5. Surface contracts

- `/ready`
  - returns the active serving `recovery_warrant_id` and whether its required proof cells are healthy.
- `/api/agents/control-plane/status`
  - returns active warrants, proof-cell summaries, backlog-seat counts by warrant, and projection watermark digests;
  - stops implying full authority from rollout health alone.
- launchers and scheduler paths
  - consume sealed warrants and proof cells instead of process-local timer state alone.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - must prove admitted digest parity and warrant parity before marking promotion safe.

### 6. Validation and rollout gates

Engineer-stage minimum validation:

1. migration tests for warrants, proof cells, and projection watermarks;
2. regression proving a missing helper asset yields a broken proof cell and blocks new launches;
3. restart and leader-change regression proving warrants survive process restart and are not rebuilt from timers alone;
4. parity regression proving `/ready`, `/api/agents/control-plane/status`, launchers, and deploy verification expose the
   same active warrant ids;
5. regression proving healthy rollout cannot overwrite broken warrant state when proof cells fail.

Deployer-stage acceptance gates:

1. shadow-write warrants, proof cells, and watermarks for at least two full stage cadences before enforcement;
2. show all required proof cells healthy for the active serving and stage warrants before widening rollout;
3. prove no new jobs launch against a superseded or broken warrant during one full promotion cycle;
4. keep rollout blocked if deploy verification digest parity and warrant parity disagree.

## Rollout plan

Phase 0. Write-only.

- create warrants, proof cells, and watermarks alongside the current epoch/seat and rollout reducers;
- expose them in status without changing launch admission.

Phase 1. Shadow enforcement.

- compute whether launches and rollout widening would be blocked under the new contract;
- emit mismatch metrics whenever the old system would admit work that the warrant contract would reject.

Phase 2. Enforce runtime-proof admission.

- block launches for broken or incomplete warrants;
- keep serving on the active serving warrant while non-serving classes cut over separately if needed.

Phase 3. Enforce rollout parity.

- require deploy verification and consumer projections to cite fresh watermarks from sealed warrants before widening.

## Rollback plan

- keep the old timer- and rollout-derived reducers readable during Phases 0-2 for parity and emergency fallback;
- if warrant compilation misclassifies active work, revert launch admission to the prior path, continue writing the new
  objects for forensics, and do not delete them;
- if serving or deploy verification sees warrant disagreement after enforcement, freeze widening, restore the prior
  sealed warrant as active, and mark the newer warrant `quarantined`.

## Risks and open questions

- too many required proof cells could make routine rollout slower than necessary if the proof set is over-specified;
- too few proof cells would preserve the current helper-path and stale-runtime replay risks;
- projection watermarks require careful expiry tuning so consumers do not flap on harmless lag;
- completed and superseded warrant history will need retention rules to avoid unbounded growth.

## Handoff to engineer and deployer

Engineer handoff:

- add warrant, proof-cell, and watermark persistence plus parity projections;
- wire launchers, readiness, and deploy verification to sealed warrant truth;
- add the missing-helper, restart, and rollout-parity regressions listed above.

Deployer handoff:

- require shadow parity first;
- do not widen rollout while any required proof cell is degraded or any active consumer watermark points at a broken
  warrant;
- treat any launch under a broken or superseded warrant as a hard rollback trigger.
