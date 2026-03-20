# 56. Torghut Profit Clocks and Lane Falsification Exchange (2026-03-20)

Status: Ready for merge (discover architecture lane)
Date: `2026-03-20`
Owner: Gideon Park (Torghut Traders)
Mission: `codex/swarm-torghut-quant-discover`
Swarm impacts:

- `torghut-quant`
- `jangar-control-plane`

Companion doc:

- `docs/agents/designs/57-jangar-authority-capsules-and-route-parity-contract-2026-03-20.md`

Extends:

- `53-torghut-cross-plane-profit-certificate-veto-and-options-auth-isolation-2026-03-20.md`
- `54-torghut-capital-lease-receipts-and-profit-falsification-ledger-2026-03-20.md`
- `55-torghut-hypothesis-settlement-exchange-and-lane-capability-leases-2026-03-20.md`
- `49-torghut-quant-source-of-truth-and-profit-circuit-handoff-2026-03-19.md`

## Executive summary

The decision is to replace Torghut’s route-time live submission answers with durable `profit clocks` and a
lane-scoped falsification exchange. Jangar remains the owner of infrastructure and rollout authority. Torghut becomes
the owner of hypothesis-level capital time, freshness expiry, and lane-local degradation.

The reason is concrete in the live system on `2026-03-20`:

- `GET http://jangar.jangar.svc.cluster.local/api/torghut/trading/control-plane/quant/health?window=15m`
  - returns HTTP `200`
  - reports `latestMetricsCount=72`
  - reports both ingestion stages `ok=false`
  - reports `maxStageLagSeconds=84395`
  - reports compute and materialization still healthy
- `GET http://torghut-00156-private.torghut.svc.cluster.local/readyz`
  - returns HTTP `503`
  - reports `postgres.ok=true`
  - reports `clickhouse.ok=true`
  - reports `database.ok=true` with head `0025_widen_lean_shadow_parity_status`
  - reports `empirical_jobs.ok=false`
  - reports `quant_evidence.reason="quant_health_fetch_failed"`
  - reports `quant_evidence.source_url="http://jangar.../api/agents/control-plane/status?..."`
- `GET http://torghut-00156-private.torghut.svc.cluster.local/db-check`
  - reports schema current and lineage ready
  - still reports migration parent-fork warnings
- `curl http://torghut-forecast.torghut.svc.cluster.local:8089/readyz`
  - fails to connect right now
- `kubectl -n torghut get pods`
  - shows the live `torghut-00156` revision healthy
  - shows forecast pods `0/1 Running`
  - shows `torghut-dspy-cluster-runner` in `Error`
- `kubectl -n torghut get events --sort-by=.lastTimestamp | tail -n 120`
  - shows repeated forecast readiness `503`
  - shows recent liveness and readiness probe timeouts on the active Torghut revision

The tradeoff is more persistence and stricter expiry semantics. That is worth paying because the current failure mode
is still route-time optimism: the core service has the right data to fail safely, but it does not express profit truth
as one durable, replayable object.

## Mission inputs and success criteria

Observed mission inputs:

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarmName: `torghut-quant`
- swarmStage: `discover`
- objective: assess cluster/source/database state and create/update+merge required design-document PRs that improve,
  maintain, and innovate Torghut quant

This artifact succeeds when:

1. every hypothesis and account has one current `profit_clock_id` that scheduler, `/readyz`, and `/trading/status`
   can share;
2. Jangar authority capsules become typed inputs, not live route dependencies;
3. data freshness, empirical evidence, and lane capability loss become explicit falsification events with expiry;
4. the design defines measurable profitability hypotheses and deployer gates before any capital-stage relaxation.

## Assessment snapshot

### Cluster health, rollout, and event evidence

Current live evidence shows a system that blocks safely but still answers profit truth from too many moving parts:

- the core Torghut revision is running and can serve `/readyz` and `/db-check`;
- the readiness decision is degraded because empirical jobs, quant evidence, and live submission gates are not healthy;
- the typed quant-health endpoint itself is reachable and returns detailed stage truth;
- forecast runtime is not reachable right now even though the main service is serving;
- repeated probe failures in torghut namespace show that liveness and profitability are coupled too tightly.

Interpretation:

- Torghut already has enough evidence to know which hypothesis lanes are healthy or degraded;
- it still answers that question from route-time fetches and in-process state instead of a durable profit clock.

### Source architecture and high-risk modules

The source tree matches the live contradiction:

- `services/torghut/app/trading/submission_council.py`
  - resolves quant evidence from `TRADING_JANGAR_QUANT_HEALTH_URL`;
  - if that is absent, it falls back to other Jangar URLs;
  - before the discovery-branch fix, that fallback preserved the control-plane status path instead of deriving the
    typed quant-health route, which is exactly what the live `readyz` payload showed.
- `services/torghut/app/main.py`
  - `/readyz` rebuilds dependencies, alpha readiness, empirical jobs, live submission gate, and quant evidence at
    request time;
  - route truth can therefore drift from scheduler truth between evaluations.
- `services/torghut/app/trading/hypotheses.py`
  - collapses Jangar dependency state into one coarse `decision/reasons/message` contract;
  - lane-local capability provenance is lost before promotion logic can bind it.
- `services/torghut/scripts/verify_quant_readiness.py`
  - already verifies rich profitability and rollback evidence bundles;
  - those proofs are not yet the same object the runtime scheduler or `/readyz` uses for live capital answers.

Current missing regression coverage:

- no regression proving scheduler, `/readyz`, and `/trading/status` share one durable profit clock id;
- no regression proving lane-specific capability loss degrades only the affected hypothesis clocks;
- no regression proving a typed quant-health route must be used when deriving Jangar quant authority;
- no regression proving stale ingestion-stage lag automatically expires a profit clock even when compute and
  materialization still look healthy.

### Database, schema, quality, freshness, and consistency evidence

The database story is mixed in the right way for an additive architecture step.

- `db-check` reports:
  - `schema_current=true`
  - `current_heads=["0025_widen_lean_shadow_parity_status"]`
  - `schema_graph_branch_count=1`
  - lineage warnings from historical parent forks
- the active `readyz` payload reports:
  - `postgres.ok=true`
  - `clickhouse.ok=true`
  - `database.ok=true`
  - `empirical_jobs.ok=false`
  - `quant_evidence.ok=false`
- the live quant-health route reports:
  - fresh compute and materialization;
  - severely stale ingestion stages.

Interpretation:

- the schema contract is good enough to extend safely;
- the bigger quality problem is not migration drift, but capital truth depending on stale or misrouted evidence;
- profitability should therefore be governed by persisted time-bounded proofs, not by whichever route returns first.

## Problem statement

Torghut still has five six-month profitability risks:

1. live capital truth is computed on demand instead of settled in a durable object;
2. typed Jangar quant authority can still be miswired through generic endpoint config;
3. lane-local capability loss is not encoded as a time-bounded falsification event;
4. scheduler and route status can drift because both recompute from current state;
5. stale data and fresh compute can coexist without a single object that says capital must expire.

That is safe enough to block. It is not rigorous enough to compound profit without accidental optimism.

## Alternatives considered

### Option A: move final profit authority entirely into Jangar

Summary:

- Jangar issues the final answer for each hypothesis and account;
- Torghut only executes or renders it.

Pros:

- one control-plane owner;
- simplest deployer narrative.

Cons:

- couples strategy economics to infrastructure control-plane release cycles;
- makes future hypothesis work more expensive;
- expands Jangar blast radius into lane-specific trading decisions.

Decision: rejected.

### Option B: keep current submission-council route truth and harden individual checks

Summary:

- fix the miswired quant-health fallback;
- keep in-process gate evaluation and route-time recomputation;
- patch degraded dependencies one by one.

Pros:

- smallest implementation delta;
- immediate safety improvement.

Cons:

- preserves route/runtime drift;
- provides weak replay and audit value;
- keeps capital-stage answers coupled to transient fetch timing.

Decision: rejected as the long-term direction, though the discovery branch still lands the quant-health derivation fix as
an immediate regression repair.

### Option C: durable profit clocks and lane falsification exchange

Summary:

- Jangar publishes authority capsules;
- Torghut binds those capsules to local profit evidence, freshness budgets, and lane requirements;
- the result is one durable `profit clock` per hypothesis/account/lane plus explicit falsification events.

Pros:

- gives scheduler and routes one shared profit truth object;
- lets capability loss degrade only the affected lanes;
- creates a durable audit trail for why capital was granted, held, or revoked;
- preserves future option value because new signals become new clock inputs, not new route-time branches.

Cons:

- adds more persistence and compilers;
- requires dual-read rollout and stricter expiry policy.

Decision: selected.

## Decision

Adopt **durable profit clocks and a lane falsification exchange**.

Torghut will stop treating live capital truth as the output of whichever route can fetch enough evidence right now.
Instead it will settle time-bounded profit clocks from Jangar authority capsules plus local hypothesis evidence.

## Proposed architecture

### 1. Profit clock data model

Add additive persistence for:

- `strategy_profit_clocks`
  - `id`
  - `hypothesis_id`
  - `account_label`
  - `lane`
  - `capital_stage`
  - `status` (`observe`, `canary`, `live`, `hold`, `revoked`)
  - `clock_digest`
  - `compiled_at`
  - `expires_at`
  - `jangar_authority_capsule_id`
  - `summary_reason`
- `strategy_profit_clock_inputs`
  - `strategy_profit_clock_id`
  - `input_kind` (`quant`, `empirical_jobs`, `market_context`, `forecast`, `scheduler`, `database`, `capsule`)
  - `input_ref`
  - `status`
  - `observed_at`
  - `fresh_until`
  - `reason_codes`
- `strategy_profit_falsifications`
  - `id`
  - `strategy_profit_clock_id`
  - `lane`
  - `reason_code`
  - `triggered_at`
  - `severity`
  - `evidence_ref`
  - `resolved_at`

### 2. Clock compiler

The compiler loop should:

- consume the latest Jangar authority capsule required for the hypothesis;
- consume quant-health stage truth, empirical job freshness, and local scheduler evidence;
- assign one profit status and expiry deadline;
- emit falsification events when required evidence goes stale, degrades, or disappears;
- persist the finalized clock before scheduler or route consumers can act on it.

Critical rule:

- fresh compute and stale ingestion is not a partial success for live capital;
- the clock must hold or revoke until ingestion freshness is inside policy.

### 3. Lane-local degradation

Profit clocks must be lane-scoped:

- equity hypothesis clocks should not freeze because forecast or another optional lane is degraded unless that lane is
  declared as required;
- hypothesis-local required inputs are explicit configuration, not inferred from broad service health;
- falsification events revoke only the affected clocks and emit a typed reason for the affected lane.

### 4. Route and scheduler parity

Once clocks exist:

- `/readyz` projects the current clock id and digest instead of recomputing live submission logic from scratch;
- `/trading/status` reports the same clock ids and falsification state;
- scheduler promotion logic reads the latest admissible clock row, not a freshly fetched in-memory payload;
- `verify_quant_readiness.py` and runtime status can converge on the same evidence object family.

### 5. Measurable profitability hypotheses and guardrails

Each profit clock must carry explicit promotion policy inputs:

- minimum sample size;
- target effect size;
- p-value or confidence bound target;
- max drawdown delta;
- max allowed ingestion lag;
- max empirical job age;
- max execution fallback ratio;
- lane-specific dependency set.

That turns “profitability” from a route summary into a durable, testable hypothesis contract.

## Validation gates

Engineer acceptance gates:

- add clock and falsification persistence plus deterministic digest tests;
- add regression tests proving `resolve_quant_health_url()` derives the typed quant-health path from generic Jangar
  base URLs;
- add scheduler and route parity tests proving one `profit_clock_id` is surfaced everywhere;
- add falsification tests proving stale ingestion stages revoke or hold clocks even when other stages are healthy;
- add lane-isolation tests proving a degraded optional lane does not revoke unrelated hypothesis clocks.

Deployer acceptance gates:

- `curl` of Jangar quant-health and Torghut `/readyz` shows matching `profit_clock_id` inputs once the new contract is
  enabled;
- no route may report a live-capital status without a current clock id and clock digest;
- deployment remains blocked if the quant-health source URL is generic control-plane status instead of the typed quant
  route;
- rollback remains blocked until previous clocks or prior release behavior are restored and route parity is confirmed.

## Rollout plan

1. Land the immediate regression fix for typed quant-health URL derivation.
2. Add profit-clock tables and compiler in shadow mode.
3. Persist clocks while keeping existing route payloads for comparison.
4. Switch scheduler, `/readyz`, and `/trading/status` to profit-clock-backed projection.
5. Enforce lane-local falsification and remove legacy route-time live capital recomputation.

## Rollback plan

If profit-clock compilation regresses:

- revert route projection to the prior live submission payload while preserving stored clocks for forensics;
- freeze capital-stage progression at `observe` or `shadow` until the prior compiler or prior release is restored;
- restore typed quant-health wiring before re-enabling any non-observe stage.

## Risks and open questions

- Expiry budgets need calibration so clocks do not flap during normal market-open jitter.
- Profit-clock compilers cannot quietly inherit generic endpoint fallbacks again.
- We still need a clean contract for how forecast readiness participates in lane-specific clocks versus whole-system
  readiness.
- There is a migration choice between reusing existing promotion tables or adding a dedicated clock ledger. The design
  direction prefers a dedicated ledger so route and scheduler truth are explicit.

## Engineer and deployer handoff contract

Engineer handoff:

- implement the typed quant-health routing fix first;
- land clock persistence and scheduler/route parity before any policy relaxation;
- make every non-observe capital answer reference a `profit_clock_id` and `clock_digest`;
- treat falsification events as first-class revocation inputs, not post-hoc annotations.

Deployer handoff:

- hold rollout if the live service reports non-observe capital without a profit clock id;
- verify typed Jangar quant authority is being consumed before trusting any promotion answer;
- rollback by restoring prior release behavior or prior clock compiler behavior, then confirm route/scheduler parity
  before any new promotion.

