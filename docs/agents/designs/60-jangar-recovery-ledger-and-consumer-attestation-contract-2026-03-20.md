# 60. Jangar Recovery Ledger and Consumer Attestation Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/59-torghut-lane-balance-sheet-and-dataset-seat-auction-contract-2026-03-20.md`

Extends:

- `59-jangar-authority-session-bus-and-rollout-lease-contract-2026-03-20.md`
- `58-jangar-authority-journals-bounded-recovery-cells-and-replay-contract-2026-03-20.md`
- `57-jangar-authority-capsules-and-readiness-class-separation-2026-03-20.md`

## Executive summary

The decision is to take the authority-session stack one level further and make stale control-plane debt first-class.
Jangar will persist a durable **Recovery Ledger** for stale freeze, rollout skew, and dependency debt, then compile
**Consumer Attestations** from the authority session plus the open recovery cases. `/ready`, deploy verification, and
Torghut will stop inferring their own global truth from the same coarse blocked payload.

The reason is visible in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/health`
  - returns HTTP `200`
  - reports `status="ok"`
- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `503`
  - reports `execution_trust.status="blocked"`
  - reports both `jangar-control-plane` and `torghut-quant` blocked on freeze-expiry reconciliation
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?account=PA3SX7FYNUTF&window=15m`
  - returns HTTP `200` at `2026-03-20T21:05:18.855Z`
  - reports `database.status="healthy"` and `migration_consistency.applied_count=24`
  - reports controllers healthy from heartbeats or rollout
  - still reports `execution_trust.status="blocked"` because stale swarm-stage debt is globalized
  - reports `rollout_health.status="degraded"` because `agents` and `agents-controllers` are behind on updated
    replicas even though ready replicas exist

The tradeoff is more additive persistence, one more compiler loop, and explicit consumer identity. I am keeping that
trade because the expensive failure mode is not total outage anymore. It is healthy-enough pods serving while stale
March 11, 2026 swarm debt still blocks every consumer equally.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-plan`
- swarmName: `torghut-quant`
- swarmStage: `plan`
- objective: assess cluster, source, and database state and merge architecture artifacts that improve Jangar
  resilience and Torghut profitability

This artifact succeeds when:

1. every stale freeze, behind rollout, or dependency debt window has one durable `recovery_case_id` with explicit
   scope, owner, deadline, and evidence;
2. `/ready`, `/api/agents/control-plane/status`, deploy verification, and Torghut consumers each cite one
   `consumer_attestation_id` and one `authority_session_id`;
3. a blocked recovery case can stop only the consumers it actually affects instead of globally flattening all
   Jangar truth into `blocked`;
4. rollout leases become valid only when their attestation digest matches the current authority session and the
   relevant recovery cases are either resolved or explicitly tolerated.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The live cluster says Jangar is running, but its authority is still debt-shaped.

- `kubectl get pods -n jangar -o wide`
  - shows `jangar-64b9d545fc-nknwd` `2/2 Running`
  - shows `jangar-worker-79984689d4-zs6ql` `1/1 Running`
  - shows `jangar-db-1` `1/1 Running`
- `GET /api/agents/control-plane/status`
  - shows `controllers[].status="healthy"` across `agents-controller`, `supporting-controller`, and
    `orchestration-controller`
  - shows `watch_reliability.status="healthy"` with `77` events and `0` errors in the last `15` minutes
  - shows `database.status="healthy"` with `24/24` registered and applied migrations
- that same payload still reports:
  - `execution_trust.status="blocked"`
  - `jangar-control-plane.phase="Recovering"` with `freeze.until="2026-03-11T16:36:12.630Z"`
  - `torghut-quant.phase="Recovering"` with `freeze.until="2026-03-11T16:36:17.456Z"`
  - every `discover`, `plan`, `implement`, and `verify` stage waiting on freeze reconciliation

Interpretation:

- the control plane has enough live signal to keep serving;
- the authority model still lets expired debt stay on the critical path for every consumer;
- safer rollout now depends on scoping that debt rather than simply recomputing it faster.

### Source architecture and high-risk modules

The current Jangar source tree still compresses too many meanings into one request-time answer.

- `services/jangar/src/routes/ready.tsx`
  - merges execution-trust statuses across namespaces and returns `503` whenever the merged status is `blocked` or
    `unknown`
  - has no concept of consumer identity, repair debt, or attestation class
- `services/jangar/src/server/control-plane-status.ts`
  - computes control-runtime, workflow, watch, rollout, empirical-service, and execution-trust segments in one
    reducer
  - turns `execution_trust_blocked` and `empirical_jobs_degraded` into one global `dependency_quorum.decision="block"`
- `services/jangar/src/data/agents-control-plane.ts`
  - already projects rich control-plane segments to the UI
  - still depends on the same broad blocked/degraded/healthy reduction rather than a consumer-scoped artifact

The highest-risk missing tests are now architectural rather than local:

- there is no regression test proving an expired freeze on one swarm can degrade serving while still blocking only the
  promotion and deploy consumers that depend on that swarm;
- there is no attestation-parity test that binds `/ready`, deploy verification, and downstream Torghut consumption to
  the same digest and expiry window;
- there is no replay test for March 11, 2026 stale freeze debt being retired without wiping unrelated healthy rollout
  evidence.

### Database, schema, freshness, and consistency evidence

Jangar already has the persistence surface needed for additive recovery objects.

- `GET /api/agents/control-plane/status`
  - reports `database.latency_ms=2`
  - reports `migration_consistency.latest_registered="20260312_torghut_simulation_control_plane_v2"`
  - reports `migration_consistency.latest_applied="20260312_torghut_simulation_control_plane_v2"`
- the existing authority-session and heartbeat stack already persists compact state rather than forcing pod-local-only
  truth

Interpretation:

- we do not need a new database or new trust substrate;
- we need narrower additive tables that preserve stale debt and consumer scope explicitly.

## Problem statement

Jangar still has five resilience-critical gaps:

1. expired freeze and rollout skew remain observations, not owned recovery records;
2. request-time reducers globalize stale debt into one blocked execution-trust answer;
3. serving, promotion, rollout, and downstream-runtime consumers still share one coarse readiness meaning;
4. deploy verification cannot prove which exact control-plane decision it is trusting;
5. stale debt can survive for days because there is no first-class recovery object with owner, deadline, and closure
   evidence.

That is no longer a startup problem. It is a six-month operability problem.

## Alternatives considered

### Option A: keep the authority-session bus and tighten the reducers

Summary:

- keep sessions and rollout leases as the only new durable objects;
- repair stale freeze handling and make reducers more selective.

Pros:

- smallest implementation delta;
- no new consumer registry.

Cons:

- still keeps stale-debt interpretation in request paths;
- still forces `/ready`, deploy verification, and Torghut to share one broad blocked outcome;
- still makes incident replay depend on logs and point-in-time reductions.

Decision: rejected.

### Option B: push consumer-specific policy out to each caller

Summary:

- Jangar would continue publishing one broad status document;
- Torghut and deploy tooling would each learn their own scoping logic.

Pros:

- minimal Jangar persistence changes;
- caller-specific tuning is easy to ship.

Cons:

- duplicates correctness logic across consumers;
- guarantees drift between `/ready`, deploy verification, and runtime gating;
- worsens blast radius during incident response because every consumer will disagree differently.

Decision: rejected.

### Option C: recovery ledger plus consumer attestations

Summary:

- Jangar compiles authority sessions as before;
- a recovery compiler persists stale debt into recovery-ledger rows;
- an attestation compiler emits consumer-scoped decisions for serving, promotion, deploy, and downstream-runtime
  consumers.

Pros:

- removes stale-debt interpretation from request-time critical paths;
- gives every consumer one digest and expiry window to trust;
- keeps rollout safer because attestation scope is explicit and auditable.

Cons:

- adds new tables and one more compiler loop;
- requires a maintained consumer registry;
- needs shadow-parity testing before any consumer flips.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will persist a recovery ledger and consumer attestations, then bind rollout leases and downstream trust to those
attestations instead of global request-time reductions.

## Architecture

### 1. Recovery ledger

Add additive tables:

- `control_plane_recovery_cases`
  - `recovery_case_id`
  - `authority_session_id`
  - `scope_namespace`
  - `scope_subject`
  - `failure_class` (`freeze_expiry`, `rollout_skew`, `dependency_debt`, `watch_staleness`)
  - `opened_at`
  - `deadline_at`
  - `status` (`open`, `repairing`, `resolved`, `expired`)
  - `serving_effect` (`allow`, `degrade`, `block`)
  - `promotion_effect` (`allow`, `degrade`, `block`)
  - `evidence_refs_json`
  - `closure_refs_json`
  - `owner_identity`
  - `producer_revision`

Rules:

- stale debt is never implicit once observed twice; it becomes a recovery case;
- closure requires evidence, not just absence of the symptom;
- an expired recovery case is treated as a product bug, not a silent state.

### 2. Consumer attestation compiler

Add additive tables:

- `control_plane_consumer_attestations`
  - `consumer_attestation_id`
  - `authority_session_id`
  - `consumer_id`
  - `consumer_class` (`serving`, `promotion`, `deploy`, `runtime`)
  - `decision` (`allow`, `degrade`, `block`)
  - `bound_recovery_case_ids_json`
  - `bound_rollout_lease_id`
  - `reason_codes_json`
  - `digest`
  - `issued_at`
  - `expires_at`
- `control_plane_consumer_bindings`
  - `consumer_id`
  - `subject_scope_json`
  - `required_capabilities_json`
  - `required_failure_classes_json`
  - `default_serving_policy`
  - `default_promotion_policy`

Initial consumers:

- `jangar-ready-serving`
- `agents-rollout-deployer`
- `torghut-quant-runtime`
- `torghut-quant-promotion`

Rules:

- `/ready` returns from `jangar-ready-serving`, not from a global blocked reducer;
- deploy verification uses `agents-rollout-deployer`;
- Torghut runtime uses `torghut-quant-runtime` for fail-closed runtime gating;
- Torghut live promotion uses `torghut-quant-promotion`, which is stricter than runtime.

### 3. Rollout-safety model

Rollout leases become attestation-bound:

- `rollout_lease_id` is valid only when its `consumer_attestation_id` is current;
- updated replicas must match the attested deployment digest before the lease is extended;
- a recovery case with `promotion_effect="block"` invalidates promotion and deploy leases without forcing a serving
  outage when the serving attestation is still degraded-but-valid.

This removes the current failure mode where behind `agents-controllers` replicas and stale freeze debt are merged into
one universal block.

### 4. Read model changes

`/ready` and `/api/agents/control-plane/status` still exist, but they become projections:

- `/ready`
  - returns the latest serving attestation
  - includes `consumer_attestation_id`, `authority_session_id`, and relevant `recovery_case_ids`
- `/api/agents/control-plane/status`
  - keeps the rich segment detail
  - adds the compiled consumer-attestation summary so deployers and runtimes can prove parity

### 5. Validation and acceptance gates

Engineer acceptance gates:

- unit tests that compile at least:
  - one stale-freeze case that degrades serving and blocks promotion;
  - one rollout-skew case that blocks deploy only;
  - one resolved case that retires the attestation block after evidence closure
- shadow test proving `/ready`, status, and attestation digests match for the same timestamp
- replay test seeded with March 11, 2026 freeze debt and March 20, 2026 healthy controllers

Deployer acceptance gates:

- `jangar-ready-serving` attestation remains `allow` or bounded `degrade` during healthy-pod cutover
- `agents-rollout-deployer` attestation blocks when updated replicas lag desired replicas or recovery cases are open
- rollout tooling records the attestation digest used for the deploy decision

## Rollout plan

Phase 0. Add tables and compiler writes in shadow mode.

- no consumer reads the new objects yet
- current status and ready behavior remains unchanged

Phase 1. Project the new objects through status.

- expose recovery cases and consumer attestation summaries in `/api/agents/control-plane/status`
- compare digests against current reducer outputs

Phase 2. Move `/ready` to the serving attestation.

- `/ready` remains fail-closed on `block`
- `/ready` may return `200` on bounded `degrade` when the serving attestation allows it

Phase 3. Move deploy verification and Torghut to their own attestations.

- rollout tooling binds to `agents-rollout-deployer`
- Torghut runtime and promotion bind to their dedicated consumer ids

Phase 4. Retire global stale-freeze blocking from request-time reduction.

- request paths become readers of compiled debt and attestation state
- stale debt closure is enforced through the recovery ledger only

## Rollback

If the compiler or attestation policy is wrong:

1. stop reading consumer attestations in `/ready`, deploy verification, and Torghut;
2. fall back to the current request-time reduction;
3. leave recovery-ledger rows intact for forensics and replay;
4. fix compiler logic offline, then re-enable shadow mode before the next cutover.

## Risks and open questions

- Consumer scoping can become too permissive if bindings are under-modeled. That risk is lower than the current
  universal block because it is explicit and testable.
- Recovery debt ownership needs a small but real operational workflow. Without that, the ledger just preserves debt
  more cleanly.
- Attestation TTL that is too short will create avoidable rollout churn. TTL that is too long will blur real recovery
  progress.

## Handoff to engineer and deployer

Engineer handoff:

- implement recovery-ledger and consumer-attestation tables and compiler
- add status and ready projections
- add replay and parity tests for March 11 stale-freeze debt and March 20 healthy-controller state

Deployer handoff:

- require attestation digests in rollout verification records
- treat `degrade` as a valid serving state only for `jangar-ready-serving`
- keep promotion and deploy fail-closed while any relevant recovery case remains open

The acceptance bar is not "fewer 503s." The acceptance bar is being able to prove which stale debt blocked which
consumer, with one recovery object and one attestation digest.
