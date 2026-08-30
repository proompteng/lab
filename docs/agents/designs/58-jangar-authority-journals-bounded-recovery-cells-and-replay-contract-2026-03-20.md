# 58. Jangar Authority Journals, Bounded Recovery Cells, and Replay Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Victor Chen (Jangar Engineering)
Mission: `codex/swarm-jangar-control-plane-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/57-torghut-profit-reserves-forecast-calibration-escrow-and-probe-auction-2026-03-20.md`

Extends:

- `57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`
- `56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
- `55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `51-jangar-control-plane-execution-cells-and-collaboration-failover-2026-03-19.md`

## Executive summary

The decision is to move Jangar from point-in-time authority capsules to append-only **Authority Journals** scoped to
bounded **Recovery Cells**. Every consumer-facing projection must resolve from the same journal head and replay
contract instead of whichever pod, route, or stale swarm record answered first.

The reason is visible in the live system on `2026-03-20`:

- `kubectl get swarm -n agents jangar-control-plane -o yaml`
  - `status.phase = Frozen`
  - `status.updatedAt = 2026-03-11T15:48:11.742Z`
  - `status.queuedNeeds = 5`
  - `status.freeze.reason = StageStaleness`
- `kubectl get swarm -n agents torghut-quant -o yaml`
  - `status.phase = Frozen`
  - `status.updatedAt = 2026-03-11T15:48:13.974Z`
  - the freeze is also still `StageStaleness`
- `kubectl get pods -n agents -o wide`
  - `agents-679c868658-n2gsn` is `0/1 Running`
  - `agents-75784dbff9-rtjtj` is `1/1 Running`
  - `agents-controllers-5c4b57cf57-mgwv8` is `0/1 Running`
  - `agents-controllers-6f66994756-54llk` is `1/1 Running`
- `curl http://10.244.2.250:8080/ready`
  - returns HTTP `503`
  - reports `execution_trust.status="blocked"`
- `curl http://10.244.2.137:8080/ready`
  - returns HTTP `200`
  - reports `agentsController.enabled=false`
  - reports `supportingController.enabled=false`
- `curl http://agents.agents.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - returns `dependency_quorum.decision="block"`
  - returns `database.status="healthy"`
  - returns `migration_consistency.applied_count=24`
  - returns `rollout_health.status="unknown"`
- `kubectl get events -n agents --sort-by=.lastTimestamp | tail -n 40`
  - still shows readiness probe failures for the unready `agents` and `agents-controllers` pods

The tradeoff is more persistence, replay bookkeeping, and stricter serving rules. I am keeping that trade because the
current failure mode is no longer missing data. It is split authority: a service, a pod, and a stale swarm object can
all be "true" at once and still force operators to guess which one matters.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-jangar-control-plane-plan`
- swarmName: `jangar-control-plane`
- swarmStage: `plan`
- objective: assess cluster/source/database state and create or update merged design documents that improve Jangar
  resilience and Torghut profitability

This artifact succeeds when:

1. Jangar serves one journal head per recovery cell and every consumer can bind to it by `journal_id`, `revision`,
   and `digest`;
2. expired swarm freezes stop acting as indefinite global truth and instead become explicit replayable recovery work;
3. `/ready`, `/api/agents/control-plane/status`, deploy verification, and Torghut upstream bindings all use the same
   journal head contract;
4. engineer and deployer stages have explicit validation, rollout, and rollback gates that can be executed without
   manually reconciling pod-level and service-level answers.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current cluster evidence says Jangar can still run while its authority contract drifts.

- pod-local readiness is inconsistent inside the same logical service;
- service-level control-plane status is blocked for legitimate reasons, but the stale swarm phase remains the dominant
  blocker nearly nine days after the underlying freeze window expired;
- event history still records fresh readiness failures in `agents`, so the system is not merely carrying an old stale
  bit;
- the swarms remain globally frozen even while new `discover`, `plan`, and `verify` runs exist in the namespace.

Interpretation:

- Jangar has enough evidence to protect the system;
- it does not yet have a serving model that guarantees every projection is using the same evidence epoch.

### Source architecture and high-risk modules

The code paths match the live contradiction.

- `services/jangar/src/routes/ready.tsx`
  - computes readiness from local controller helpers plus `buildExecutionTrust(...)`;
  - can return `200` from one pod while another pod returns `503` because the route still relies on local process
    state and leader-election context.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - still freezes swarms by deleting stage schedules and relies on process-local `swarmUnfreezeTimers`;
  - that means stale-freeze repair is not yet durable across controller failover or restart.
- `services/jangar/src/server/control-plane-status.ts`
  - already knows how to reduce workflow health, rollout health, dependency quorum, and stale freezes;
  - still computes those views on demand rather than serving a durable journal head that every consumer must reuse;
  - also compresses rich `execution_trust.blocking_windows` into broader segment reasons, which weakens ownership and
    rollback diagnosis for downstream consumers.
- `services/jangar/src/server/control-plane-heartbeat-store.ts`
  - provides freshness-oriented persistence that is useful for journal compilation;
  - does not yet define a replay contract for stale freeze transitions or pod-serving parity.
- `packages/scripts/src/jangar/verify-deployment.ts`
  - remains a separate deploy verifier with no required parity against a single Jangar journal revision.

Existing coverage is meaningful but still incomplete:

- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - already covers `StageStaleness`, dependency quorum blocking, and workflow degradation;
  - does not prove that all consuming surfaces publish the same revision and digest.
- `services/jangar/src/routes/ready.test.ts`
  - covers readiness and execution-trust branching;
  - does not prove parity between service routing, pod-local readiness, and deploy verification.

### Database, schema, freshness, and consistency evidence

The database surface is healthy enough to support additive journal persistence.

- control-plane status reports:
  - `database.connected = true`
  - `migration_consistency.unapplied_count = 0`
  - latest applied migration `20260312_torghut_simulation_control_plane_v2`
- the current schema already includes durability primitives:
  - `agents_control_plane.component_heartbeats`
  - Torghut quant control-plane cache tables under `torghut_control_plane.*`
  - market-context lifecycle tables under `torghut_market_context_*`
- direct SQL inspection is RBAC-forbidden for this worker:
  - `kubectl cnpg psql -n jangar jangar-db -- ...`
  - fails with `pods/exec is forbidden`

Interpretation:

- this is not a schema-reset problem;
- it is a control-plane serving and replay problem on top of healthy persistence.

## Problem statement

Jangar still has five resilience-critical gaps:

1. pod-local readiness and service-level status do not have to project the same authority epoch;
2. swarm-freeze truth can remain globally blocking well past its intended lifetime because stale freeze repair is not
   modeled as a first-class replay contract;
3. deploy verification is still allowed to reason about rollout health separately from runtime authority;
4. consumers cannot require a single authoritative journal revision across pods, services, and deploy stages;
5. the current serving model couples unrelated failures because stale global truth remains easier to publish than
   scoped recovery truth.

That is not good enough for the next six months. The next control plane needs to serve one replayable authority record
per failure domain, not a bundle of route-time reductions.

## Alternatives considered

### Option A: tighten the existing capsule stack and ban more fallbacks

Summary:

- keep authority capsules as the primary serving primitive;
- add stricter TTLs and more consumer binding rules.

Pros:

- smallest incremental change;
- preserves the current mental model.

Cons:

- does not solve split pod/service truth;
- still treats stale freeze recovery as an implementation detail instead of a first-class contract;
- keeps deploy verification outside the same revision model.

Decision: rejected.

### Option B: force all authority through a single leader-only gateway

Summary:

- only the elected leader would answer readiness and control-plane status;
- non-leaders would never serve control-plane truth.

Pros:

- removes mixed pod answers quickly;
- simpler to explain operationally.

Cons:

- creates a narrow serving bottleneck;
- turns failover into a new availability problem;
- still leaves stale swarm-freeze repair under-specified.

Decision: rejected.

### Option C: authority journals plus bounded recovery cells

Summary:

- Jangar compiles append-only authority journals from existing capsules and facts;
- each journal is scoped to a bounded recovery cell with explicit replay and expiry rules;
- all consumers bind to the same journal head instead of raw route-time reduction.

Pros:

- eliminates mixed authority epochs without forcing a single leader-only serving path;
- turns stale freeze repair into an explicit, auditable workflow;
- limits blast radius by cell instead of by whole service or whole swarm;
- preserves future option value for additional consumers and cells.

Cons:

- adds persistence and replay machinery;
- requires staged migration because existing routes and deploy tooling must dual-read first;
- raises the bar for parity tests and rollout validation.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will issue authoritative journal heads for bounded recovery cells. Pods, services, and deploy tools may render
different payload shapes, but they may not choose different authority revisions.

## Architecture

### 1. Authority journal ledger

Add additive Jangar persistence:

- `agents_control_plane.authority_journal_heads`
  - `journal_id`
  - `cell_id`
  - `subject_kind`
  - `subject_ref`
  - `revision`
  - `decision` (`allow`, `hold`, `block`, `recovering`, `unknown`)
  - `digest`
  - `valid_after`
  - `fresh_until`
  - `freeze_state`
  - `replay_contract_version`
  - `source_capsule_ids`
  - `source_receipt_ids`
  - `produced_at`
- `agents_control_plane.authority_journal_events`
  - append-only facts used to derive journal revisions;
  - includes reconciliation outcomes, replay attempts, and why a revision changed.

Journal heads are small, typed, and stable enough to be served directly by pods, services, and deploy verification.

### 2. Recovery-cell model

Jangar will stop treating all authority failures as whole-plane failures.

Initial cell set:

- `swarm-lifecycle`
  - stale freeze state, queued needs, stage cadence, replay eligibility;
- `control-runtime`
  - controllers, leader election, workflow runtime, watch reliability;
- `consumer-capabilities`
  - typed upstream capability subjects exported to Torghut and other consumers;
- `deployer-verification`
  - rollout digest parity, Argo sync, ready-state parity against the same journal revision.

Rules:

- a cell may block itself without forcing unrelated cells to discard their last settled journal head;
- cells have explicit maximum stale-serving windows;
- journal serving outside that window becomes `unknown`, never silent success.

### 3. Replay contract

Every blocked or expired authority state must be replayable.

Replay contract fields:

- `replay_needed`
- `replay_reason`
- `replay_owner`
- `replay_start_deadline`
- `replay_completion_deadline`
- `last_good_revision`
- `candidate_revision`

For stale swarm freezes:

- expired freeze state becomes `recovering`, not an indefinite `Frozen` truth;
- replay is driven by a dedicated reconciler that inspects recent runs, current queue state, and newer stage activity;
- recovery completion publishes a new journal revision that either clears the stale freeze or records an explicitly
  current block reason.

### 4. Serving contract

`/ready`, `/api/agents/control-plane/status`, and deploy verification must all return:

- `journal_id`
- `revision`
- `digest`
- `cell_decisions`
- `last_good_revision`
- `served_from` (`leader`, `standby-cache`, `db-head`)

This allows:

- leader pods to serve fresh revisions;
- standby pods to serve the last settled revision within a bounded TTL;
- deploy verification to reject rollout when the runtime is serving a different digest than the deployment under test.

### 5. Validation and observability

New validation metrics and alerts:

- `jangar_authority_journal_revision_skew_total`
- `jangar_authority_journal_stale_serves_total`
- `jangar_recovery_cell_block_seconds`
- `jangar_stale_freeze_replay_pending_seconds`
- `jangar_deployer_runtime_digest_mismatch_total`

Required tests:

- parity across `/ready`, control-plane status, and deploy verifier for the same journal revision;
- stale freeze replay from `Frozen(StageStaleness)` to either `recovering` or a fresh explicit block;
- standby serving of last good journal head within TTL, and hard failure beyond TTL;
- cell-scoped failure that blocks only the affected cell while preserving unrelated last-good authority;
- controller failover while a freeze is active, proving replay does not depend on the original process timer;
- propagation of concrete `execution_trust.blocking_windows` reasons into cell-level journal entries.

## Validation gates

Engineer gate:

- journal schema and compiler implemented additively;
- all consuming routes emit `journal_id`, `revision`, and `digest`;
- regressions added for stale freeze replay, pod/service parity, and deploy/runtime digest parity.

Deployer gate:

- rollout is rejected if runtime routes and deploy verification do not agree on the same journal digest;
- no promotion when `swarm-lifecycle` is `recovering` beyond its replay deadline;
- standby-serving mode is validated explicitly before any canary promotion.

Operational gate:

- stale freeze replay SLO defined and alerting live;
- journal skew across serving pods must remain `0` for the rollout window.

## Rollout

1. Ship journal compilation in shadow mode while keeping existing capsule consumers unchanged.
2. Dual-publish route payloads with both legacy fields and journal identifiers.
3. Move deploy verification to require journal digest parity.
4. Switch `/ready` and control-plane status to fail from journal state, not local-only reduction.
5. Migrate Torghut and other consumers to typed journal-bound subjects.
6. Remove legacy serving paths once parity has been stable for two full rollout cycles.

## Rollback

Rollback is safe because the journal layer is additive.

- keep journal writers running for audit continuity;
- disable journal enforcement in routes and deploy verification;
- revert consumers to existing capsule reads only if the journal compiler itself is the fault domain;
- never delete journal history during rollback.

## Risks

- journal compilation bugs could create new false blocks if replay deadlines are too aggressive;
- bounded stale-serving windows require careful tuning so standby serving is safe but still useful;
- deploy/runtime parity gates will initially surface latent drift and may slow merges.

Mitigations:

- shadow dual-read rollout first;
- explicit per-cell TTLs and replay deadlines;
- regression coverage before deployer enforcement.

## Handoff contract for engineer and deployer

Engineer stage:

1. Implement additive journal tables and compiler over existing capsule and receipt sources.
2. Add cell-scoped replay logic for stale freezes and blocked lifecycle transitions.
3. Update `/ready`, control-plane status, and deploy verification to emit and consume the same journal identifiers.
4. Add regression tests for:
   - pod/service parity,
   - stale freeze replay,
   - standby last-good serving TTL,
   - deploy/runtime digest mismatch rejection.

Deployer stage:

1. Validate shadow-mode journal parity before enforcement.
2. Confirm mixed pod states still serve one journal digest and one decision.
3. Require a clean stale-freeze replay outcome before allowing rollout beyond canary.
4. Capture the enforced `journal_id`, `revision`, and `digest` in rollout evidence and rollback notes.
