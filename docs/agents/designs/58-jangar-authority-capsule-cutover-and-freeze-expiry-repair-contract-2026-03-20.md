# 58. Jangar Authority Capsule Cutover and Freeze Expiry Repair Contract (2026-03-20)

Status: Approved for implementation (`plan`)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-plan`
Swarm impacts:

- `jangar-control-plane`
- `torghut-quant`

Companion doc:

- `docs/torghut/design-system/v6/57-torghut-profit-clock-cutover-and-regime-auction-contract-2026-03-20.md`

Extends:

- `57-jangar-authority-capsules-freeze-reconciliation-and-consumer-slo-contract-2026-03-20.md`
- `56-jangar-capability-receipts-and-consumer-binding-contract-2026-03-20.md`
- `55-jangar-rollout-fact-receipts-and-swarm-freeze-parity-2026-03-20.md`
- `54-jangar-admission-receipts-rollout-shadow-and-anti-entropy-reconciliation-2026-03-20.md`

## Executive summary

The decision is to move Jangar from broad request-time status reduction to a cutover built around small, durable
**Authority Capsules** plus an explicit **Freeze Expiry Repair** loop. Jangar will keep emitting the rich control-plane
status payload for operators, but rollout-critical consumers will bind to capsule subjects with digest parity and
freshness budgets instead of re-deriving correctness from large JSON responses.

The reason is visible in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/ready`
  - returns HTTP `503`
  - reports `execution_trust.status="blocked"`
  - reports stale swarm freeze reasons for both `jangar-control-plane` and `torghut-quant`
- `GET http://jangar.jangar.svc.cluster.local/api/agents/control-plane/status?namespace=agents`
  - returns HTTP `200`
  - reports `database.status="healthy"`
  - reports `rollout_health.status="degraded"`
  - reports `dependency_quorum.decision="block"`
  - reports `execution_trust.status="blocked"`
  - reports `migration_consistency.applied_count=24`
- `kubectl get pods -n agents -o wide`
  - shows mixed rollout state:
    - `agents-679c868658-n2gsn` is `0/1 Running`
    - `agents-75784dbff9-rtjtj` is `1/1 Running`
    - `agents-controllers-5c4b57cf57-mgwv8` is `0/1 Running`
    - two newer `agents-controllers` pods are `1/1 Running`
- `kubectl get events -n agents --sort-by=.metadata.creationTimestamp | tail -n 40`
  - shows `BackoffLimitExceeded` for `jangar-swarm-plan-template-step-1-attempt-1`
  - shows `BackoffLimitExceeded` for `jangar-swarm-verify-template-step-1-attempt-1`
- `kubectl auth can-i create pods/exec -n jangar`
  - returns `no`
- `kubectl auth can-i create pods/exec -n torghut`
  - returns `no`

The tradeoff is more persistence, stricter consumer contracts, and one more background repair loop. I am keeping that
trade because the expensive failure mode is not complete unavailability. It is ambiguous authority: pods can be partly
healthy, the database can be healthy, and the service can still block on stale freeze state that outlives the moment
that created it.

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

1. rollout-critical consumers bind to one capsule id and digest instead of reusing broad request-time reductions;
2. expired freeze state becomes a first-class repair workflow with explicit status, evidence, and timeout behavior;
3. `/ready`, `/api/agents/control-plane/status`, deploy verification, and Torghut typed consumers share the same
   subject freshness budget;
4. rollout remains fail-closed, but unrelated consumers do not inherit stale or irrelevant blocks.

## Assessment snapshot

### Cluster health, rollout, and event evidence

The current Jangar runtime is materially healthier than the authority it emits.

- `kubectl get pods -n jangar -o wide`
  - shows `jangar-64b9d545fc-nknwd` `2/2 Running`
  - shows `jangar-worker-79984689d4-zs6ql` `1/1 Running`
  - shows `jangar-db-1` `1/1 Running`
- `kubectl get events -n jangar --sort-by=.metadata.creationTimestamp | tail -n 40`
  - returns no current event noise in the namespace
- `kubectl get pods -n agents -o wide`
  - confirms the control-plane rollout is mixed rather than fully down
- `kubectl get events -n agents`
  - confirms repeated job backoff in the same window as the stale freeze state

Interpretation:

- Jangar is not in a storage outage or total controller collapse.
- Jangar is still letting old freeze truth and mixed rollout state dominate the consumer contract.
- That is a control-plane shape problem, not primarily a compute-capacity problem.

### Source architecture and high-risk modules

The source tree shows where ambiguity is introduced:

- `services/jangar/src/server/control-plane-status.ts`
  - owns a wide status payload with rollout, execution trust, watch reliability, empirical dependencies, and
    namespaces in one reducer;
  - `DEFAULT_ROLLOUT_DEPLOYMENTS` and `DEFAULT_EXECUTION_TRUST_SWARMS` keep the current contract broad by default.
- `services/jangar/src/routes/ready.tsx`
  - recomputes `execution_trust` at request time and treats `healthy` as the only success class;
  - does not require digest parity with the richer control-plane route.
- `services/jangar/src/routes/api/torghut/trading/control-plane/quant/health.ts`
  - already exposes a fast, narrow, typed surface;
  - is the correct subject boundary for Torghut quant consumers.
- `services/jangar/src/server/supporting-primitives-controller.ts`
  - already contains freeze release behavior;
  - does not yet make expired freeze repair a durable workflow with its own evidence object.
- `services/jangar/src/server/__tests__/control-plane-status.test.ts`
  - covers status projection;
  - does not prove capsule parity across `/ready`, status, deploy verification, and downstream consumers.

### Database, schema, freshness, and consistency evidence

The current data plane supports additive persistence rather than a redesign.

- Jangar control-plane status reports:
  - `database.status="healthy"`
  - `migration_consistency.registered_count=24`
  - `migration_consistency.applied_count=24`
  - `migration_consistency.latest_applied="20260312_torghut_simulation_control_plane_v2"`
- direct SQL is not available to this worker:
  - `kubectl auth can-i create pods/exec -n jangar` -> `no`
  - `kubectl auth can-i create pods/exec -n torghut` -> `no`

Interpretation:

- the next resilience move should reuse the existing control-plane database;
- the missing piece is durable authority materialization plus explicit freeze repair state.

## Problem statement

Jangar still has four resilience-critical gaps:

1. request-time reducers remain part of the correctness boundary for consumers that only need a narrow answer;
2. stale freeze expiry is still modeled as an observation, not a repair workflow with ownership and deadlines;
3. consumer freshness budgets are implicit, so one stale surface can remain globally blocking longer than intended;
4. rollout verification and downstream consumers can still disagree because they do not share one digest-backed object.

That is acceptable for a prototype control plane. It is not acceptable for the next six months of multi-lane Torghut
operation, where safe degradation must be explicit and bounded.

## Alternatives considered

### Option A: keep request-time status assembly and patch obvious predicates

Summary:

- tighten `buildExecutionTrust(...)`;
- lower noise around stale freeze or rollout lag;
- keep `/ready` and status as the main authority surfaces.

Pros:

- smallest implementation delta;
- least schema work.

Cons:

- leaves correctness tied to broad reducers and request latency;
- keeps stale freeze repair implicit;
- does not create a shared digest contract for downstream consumers.

Decision: rejected.

### Option B: centralize final trading authority inside Jangar

Summary:

- Jangar would emit final trading eligibility and capital guidance for each Torghut lane;
- Torghut would mostly execute those decisions.

Pros:

- single operator story;
- fewer contracts to inspect at first glance.

Cons:

- couples infrastructure authority to trading economics;
- increases blast radius for Jangar mistakes;
- reduces future option value for independent Torghut experimentation.

Decision: rejected.

### Option C: authority capsules plus freeze expiry repair and consumer partitions

Summary:

- Jangar compiles small subject-specific capsules with digest, freshness, and evidence refs;
- a dedicated repair loop owns expired freeze transition logic;
- each consumer declares exactly which capsule subjects it requires and how stale they may be.

Pros:

- removes broad request-time reducers from the critical path;
- turns expired freeze into an owned workflow rather than a lingering veto;
- preserves a clear separation between infrastructure truth and trading-local decisions;
- makes rollout-safe degradation explicit.

Cons:

- adds additive storage and one compiler loop;
- requires staged cutover while legacy status surfaces remain in place;
- forces tighter tests around digest and TTL parity.

Decision: selected.

## Decision

Adopt **Option C**.

Jangar will remain the authoritative issuer of infrastructure and typed dependency truth, but it will issue that truth
through small capsule subjects and explicit repair state rather than through one large status payload alone.

## Architecture

### 1. Authority capsule subjects

Add additive Jangar persistence in the control-plane database:

- `control_plane_authority_capsules`
  - `capsule_id`
  - `subject`
  - `scope_namespace`
  - `scope_name`
  - `decision`
  - `digest`
  - `fresh_as_of`
  - `fresh_until`
  - `input_refs`
  - `evidence_refs`
  - `producer_revision`
  - `legacy_projection_hash`
- `control_plane_authority_consumers`
  - `consumer_name`
  - `required_subjects`
  - `max_staleness_seconds`
  - `last_accepted_capsule_id`
  - `last_accepted_digest`
  - `status`

Required first-wave subjects:

- `execution_trust`
- `rollout_health`
- `dependency_quorum`
- `torghut_quant_health`
- `torghut_market_context`
- `torghut_empirical_jobs`

Rule:

- `/api/agents/control-plane/status` may still return a wide operator payload;
- rollout-critical consumers must bind to specific capsule subjects and surface the accepted `capsule_id` and `digest`.

### 2. Freeze expiry repair workflow

Add explicit repair state:

- `control_plane_freeze_repairs`
  - `repair_id`
  - `swarm_name`
  - `stage`
  - `freeze_reason`
  - `freeze_until`
  - `detected_at`
  - `repair_state`
  - `repair_reason`
  - `resolved_at`
  - `evidence_ref`

Behavior:

1. detect expired freeze on any monitored swarm;
2. if the freeze is still referenced by `execution_trust`, create or update a repair row;
3. classify the repair as:
   - `expired_waiting_observer`
   - `expired_waiting_status_projection`
   - `expired_cleared`
   - `expired_escalated`;
4. block only the consumers that require that swarm-stage subject;
5. emit a new capsule digest once the repair result changes.

### 3. Consumer partition contract

First-wave consumers:

- `jangar-ready-route`
- `jangar-control-plane-status`
- `jangar-deploy-verify`
- `torghut-quant-runtime`
- `torghut-swarm-verify`

Each consumer must declare:

- required capsule subjects;
- maximum staleness budget;
- fail mode when a subject is missing or stale:
  - `hold`
  - `block`
  - `degrade-observe`

Examples:

- `jangar-ready-route`
  - requires `execution_trust` and `rollout_health`
  - fails `block` when digest is stale or subject missing
- `torghut-quant-runtime`
  - requires `torghut_quant_health`, `torghut_market_context`, and `dependency_quorum`
  - may `degrade-observe` for market-context on lanes that do not require it
  - may never substitute `execution_trust` for `torghut_quant_health`

### 4. Request-time status becomes projection, not source

`/ready` and `/api/agents/control-plane/status` change role:

- they project the latest accepted capsule subjects;
- they no longer serve as the only source of truth for consumers;
- they must include:
  - `capsule_subjects`
  - `capsule_id`
  - `digest`
  - `fresh_until`
  - `consumer_contract_version`

This preserves operator usability while removing correctness dependence on a large reducer.

## Validation gates

Engineer gates:

1. regression proving an expired freeze transitions into a repair row and eventually to `expired_cleared`;
2. regression proving `/ready` and `/api/agents/control-plane/status` expose the same `execution_trust` digest;
3. regression proving Torghut quant consumers reject a generic control-plane status URL as a quant-health source;
4. regression proving mixed `agents` rollout state changes `rollout_health` without silently changing unrelated typed
   capsule subjects.

Deployer gates:

1. one dual-read window where legacy status and capsule projections are both emitted and the digests stay aligned;
2. one forced stale-freeze repair drill that clears the block without restarting healthy Jangar pods;
3. one rollout verify run showing `capsule_id` and `digest` in the evidence record;
4. no consumer continues past two capsule TTLs without surfacing `hold`, `block`, or `degrade-observe`.

## Rollout plan

Phase 0: dual-write only

- compile capsules and repair rows;
- continue serving legacy status as the decision source;
- alert on digest drift.

Phase 1: dual-read shadow

- `/ready`, deploy verification, and Torghut read both legacy and capsule state;
- emit mismatch metrics and keep legacy state authoritative.

Phase 2: enforce typed capsule subjects

- `/ready` and deploy verification require capsule digests;
- Torghut typed consumers require their subject bindings;
- generic fallback paths become explicit errors.

Phase 3: remove legacy critical-path dependence

- legacy status remains for operator inspection only;
- all rollout-critical consumers bind to capsule subjects.

## Rollback plan

Rollback triggers:

- capsule compiler stale for two consecutive TTL windows;
- digest divergence between `/ready` and status for the same subject;
- repair loop misclassifies active freeze as cleared;
- consumer partition configuration blocks a healthy rollout path unexpectedly.

Rollback action:

1. keep writing capsules for forensics;
2. mark capsule enforcement disabled in configuration;
3. revert consumers to legacy status projection;
4. preserve repair rows and evidence refs for postmortem.

## Risks and open questions

- additive state can drift if capsule versioning is not explicit;
- dual-read periods can confuse operators unless the UI names the authoritative path clearly;
- repair-loop bugs could clear freezes too aggressively if stage ownership is not precise.

Open questions to resolve in implementation:

- whether to house capsule tables in the existing Jangar DB schema or a dedicated `control_plane_authority` schema;
- whether deploy verification should accept `hold` for non-trading swarms or always hard-block;
- how many capsule subjects can share one compiler without recreating the current broad reducer problem.

## Handoff contract

Engineer acceptance:

1. capsule tables and repair tables are additive and migrated;
2. `/ready`, `/api/agents/control-plane/status`, and one downstream Torghut path emit capsule id and digest;
3. typed consumer bindings are declared in code and tested;
4. stale freeze repair is visible through a durable row and metrics.

Deployer acceptance:

1. observe one full cutover window with digest parity and no unexplained `execution_trust` block;
2. verify a stale-freeze repair closes without a manual cluster mutation;
3. verify Torghut can read typed quant and market-context subjects even while `agents` rollout remains mixed;
4. document the exact rollback toggle that restores legacy critical-path behavior.
