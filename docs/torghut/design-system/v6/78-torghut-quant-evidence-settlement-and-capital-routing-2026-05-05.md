# 78. Torghut Quant Evidence Settlement and Capital Routing (2026-05-05)

Status: Approved for implementation (`discover`)

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Decision

Torghut should settle evidence into account/window-scoped capital routing receipts before any hypothesis moves beyond
observe or shadow.

The reason is current state. Live Torghut is operationally alive: `/healthz`, `/readyz`, `/db-check`,
`/trading/health`, `/trading/status`, and `/trading/empirical-jobs` all returned HTTP `200` on revision
`torghut-00206`. The live database contract is current at Alembic head `0029_whitepaper_embedding_dimension_4096`.
That is not enough to promote capital. Live status also reports stale empirical jobs from `2026-03-21`, no promotion
eligible hypotheses, all three configured hypotheses requiring rollback, signal lag above `51,000` seconds, Jangar
dependency quorum blocked by empirical jobs, and quant health degraded by ingestion lag. The sim lane is a separate
hard block: `/readyz` returned HTTP `503` because the sim database contract is at head `0023_simulation_run_progress`
while the app expects `0029_whitepaper_embedding_dimension_4096`.

The tradeoff is that Torghut may keep serving, collecting evidence, and replaying simulations while capital remains
held. That is deliberate. The architecture should increase profitability by making fresh proof the scarce resource
that routes capital, not by allowing live mode or a green liveness check to masquerade as economic authority.

## Runtime Inputs

- repository: `proompteng/lab`
- base: `main`
- head: `codex/swarm-torghut-quant-discover`
- swarm: `torghut-quant`
- stage: `discover`
- objective: assess cluster/source/database state and create architecture artifacts that improve, maintain, and
  innovate Torghut quant.

Success means the next engineer can implement a bounded evidence settlement path, and the deployer can prove safe
rollout and rollback without mutating databases or Kubernetes during validation.

## Evidence

All cluster and database checks were read-only.

### Cluster and Rollout

- Torghut namespace pods were running for live revision `torghut-00206`, sim revision `torghut-sim-00283`, Torghut DB,
  ClickHouse, Keeper, websocket forwarders, TA workers, options workers, and exporters.
- Torghut events showed recent startup/readiness probe failures during revision churn, then `RevisionReady` for
  `torghut-00206` and `torghut-sim-00283`.
- Torghut events also showed DB migration, whitepaper semantic backfill, and empirical jobs backfill jobs completing
  on the promoted digest.
- The worker cannot list Knative services in `torghut` and cannot exec into CNPG database pods. Validation therefore
  must rely on route contracts, pod/event reads, and persisted evidence receipts.
- Kafka pods are running, including all six broker pods. The data transport layer is not the immediate blocker.

### Live Torghut Routes

- `/healthz` returned `{"status":"ok","service":"torghut"}` with HTTP `200`.
- `/db-check` returned HTTP `200`, `ok=true`, current head `0029_whitepaper_embedding_dimension_4096`, expected head
  `0029_whitepaper_embedding_dimension_4096`, no duplicate revisions, no orphan parents, and lineage ready.
- `/readyz` returned HTTP `200`; Postgres, ClickHouse, Alpaca, database, scheduler, live-submission gate, and
  non-required quant evidence were OK.
- `/trading/health` returned HTTP `200`; alpha readiness has three hypotheses, one blocked, two shadow, zero promotion
  eligible, three rollback required, and dependency quorum `block` for `empirical_jobs_degraded`.
- `/trading/status` returned live mode and running scheduler on revision `torghut-00206`.
- Live `last_decision_at` is `2026-05-04T17:25:57.901670Z`.
- Signal continuity reports market closed expected staleness, but the measured signal lag is still above `51,000`
  seconds and is a blocker for the configured hypothesis entry contracts.
- TCA evidence exists but is not promotion-ready for current hypotheses: `order_count=13775`,
  `avg_abs_slippage_bps=568.6138848199565249`, and `last_computed_at=2026-04-02T20:59:45.136640Z`.
- Live empirical jobs are stale. The four required jobs all cite dataset snapshot
  `torghut-full-day-20260318-884bec35` and were created on `2026-03-21T09:03:22Z`.

### Jangar and Quant Health

- Jangar control-plane status returned HTTP `200`.
- Jangar execution trust is degraded by stale Jangar control-plane stages and pending requirements.
- Jangar dependency quorum blocks on Torghut empirical jobs.
- Jangar quant health for account `PA3SX7FYNUTF`, window `15m`, returned HTTP `200` and `status="degraded"`.
- Quant latest metrics are not empty: `latestMetricsCount=108` and metrics pipeline lag was `14` seconds.
- Quant ingestion is still not healthy: `maxStageLagSeconds=333284`, with degraded ingestion stages for all reported
  strategies.

### Simulation Lane

- Torghut-sim `/healthz` returned HTTP `200`.
- Torghut-sim `/readyz` returned HTTP `503`.
- Sim database contract reports current head `0023_simulation_run_progress`, expected head
  `0029_whitepaper_embedding_dimension_4096`, and `schema_current=false`.
- Sim dependency quorum is `unknown` because the Jangar control-plane status fetch timed out from the sim path.
- Sim quant evidence for account `TORGHUT_SIM` is `unknown` because the Jangar quant-health fetch timed out.
- Sim signal continuity is in `actionable_source_fault` with `no_signals_in_window` and an active emergency stop.

### Source and Test Surface

- `services/torghut/app/trading` contains `123` Python modules.
- `services/torghut/tests` contains `146` Python test files.
- The current hot-path source surface is large: `services/torghut/app/main.py` is `3978` lines,
  `submission_council.py` is `1196`, `hypotheses.py` is `732`, and `completion.py` is `993`.
- `/readyz` and `/trading/status` assemble database contract, dependency quorum, empirical jobs, quant evidence,
  hypothesis status, TCA, LLM state, market context, and live-submission gate behavior on route paths.
- `submission_council.py` already knows the right vocabulary for quant evidence, Jangar dependency quorum, empirical
  jobs, capital stages, and segment summaries. The missing piece is a settled receipt that all routes and schedulers
  consume consistently.
- `hypotheses.py` already declares per-hypothesis dependency capabilities such as `jangar_dependency_quorum`,
  `signal_continuity`, `market_context_freshness`, `feature_coverage`, and `drift_governance`.
- `completion.py` already evaluates empirical job gates and dependency quorum for completion gates.
- The test gap is cross-route parity: a regression must prove `/readyz`, `/trading/status`, scheduler live submission,
  and Jangar quant health cite the same capital routing receipt for the same account/window.

## Problem

Torghut currently has operational truth, economic truth, and simulation truth in different places.

Operational truth says live Torghut is up. Database truth says live schema is current. Economic truth says promotion
is blocked by stale empirical jobs, stale signal inputs, unacceptable TCA for the current contracts, and degraded
quant ingestion. Simulation truth says the sim lane is not even schema-current. Those answers are all valid, but they
are not settled into one capital-routing decision.

The expensive failure modes are:

1. live mode and `live_submission_gate.allowed=true` can be misread as capital permission;
2. stale empirical jobs from March remain truthful history but not current promotion authority;
3. Jangar quant latest metrics can be non-empty while ingestion stages are too stale for promotion;
4. sim can serve liveness while its schema contract is six heads behind;
5. TCA evidence can exist but be too stale or too expensive for the promotion contract;
6. route-specific timeouts can produce inconsistent Jangar dependency decisions across live and sim paths.

## Alternatives

### Option A: Require Quant Health and Empirical Jobs Globally

Set the existing flags so Torghut fails readiness and submission whenever quant health or empirical jobs are degraded.

Pros:

- Fastest operational reduction in risk.
- Uses existing configuration.
- Makes stale proof visible immediately.

Cons:

- Over-blocks repair and evidence-collection work.
- Does not distinguish live from sim schema drift.
- Does not produce a durable account/window capital receipt.
- Does not improve profitability beyond saying "no".

Decision: reject as the architecture, keep as an emergency control.

### Option B: Prioritize Research Throughput

Put the next stage into whitepaper autoresearch, strategy factory, MLX lanes, and more candidate generation.

Pros:

- Directly targets new alpha.
- Uses existing Torghut research infrastructure.
- Could produce better candidates.

Cons:

- More candidates do not help if current proof and routing cannot safely spend capital.
- Existing empirical proof is stale and sim is schema-diverged.
- It increases backlog before fixing the authority path that would admit or reject results.

Decision: reject for this discover output. Resume after evidence settlement exists.

### Option C: Evidence Settlement and Capital Routing Receipts

Settle account/window proof into one durable receipt. Routes, scheduler gates, Jangar mirrors, and deploy checks all
consume that receipt. Capital can move only when the receipt says the hypothesis, account, window, data plane, runtime
lease, empirical proof, TCA, and rollback path are fresh.

Pros:

- Turns profitability into a testable gate instead of route interpretation.
- Lets live serving continue while capital is held.
- Separates live account evidence from sim evidence.
- Makes stale empirical jobs and quant ingestion lag explicit reason codes.
- Gives Jangar one bounded Torghut proof object to mirror.

Cons:

- Requires a new persisted or materialized read model.
- Requires cross-route parity tests.
- Keeps current hypotheses in observe/shadow until evidence is refreshed.

Decision: select Option C.

## Target Contracts

### QuantEvidenceSettlement

`QuantEvidenceSettlement` is the bounded account/window proof object.

Required fields:

- `quant_evidence_settlement_id`;
- `account`;
- `window`;
- `capital_context`: `live`, `paper`, or `simulation`;
- `active_revision`;
- `database_schema_head`;
- `expected_schema_head`;
- `jangar_runtime_freshness_lease_id`;
- `empirical_jobs_digest`;
- `quant_health_digest`;
- `signal_continuity_digest`;
- `tca_digest`;
- `market_context_digest`;
- `sim_runtime_digest`;
- `decision`: `allow`, `observe`, `shadow`, `canary`, `scale`, `quarantine`, or `veto`;
- `reason_codes`;
- `issued_at`;
- `fresh_until`.

The settlement is valid only for its account and window. It cannot be reused across live and sim.

### ProfitVerdictCell

`ProfitVerdictCell` maps a settlement to one hypothesis.

Required fields:

- `profit_verdict_cell_id`;
- `quant_evidence_settlement_id`;
- `hypothesis_id`;
- `lane_id`;
- `strategy_family`;
- `requested_stage`;
- `current_stage`;
- `decision`;
- `post_cost_expectancy_bps`;
- `avg_abs_slippage_bps`;
- `sample_count`;
- `rollback_required`;
- `blocking_reason_codes`;
- `fresh_until`.

Initial measurable hypotheses:

- `H-CONT-01` continuation canary requires signal lag `<= 90s`, Jangar dependency quorum `allow`, feature rows
  present, fresh empirical proof, at least `40` samples, post-cost expectancy `>= 6 bps`, and average absolute
  slippage `<= 12 bps`.
- `H-MICRO-01` microstructure breakout canary requires order-book/liquidity features, drift governance checks, fresh
  quant ingestion, at least `60` samples, post-cost expectancy `>= 10 bps`, and average absolute slippage `<= 8 bps`.
- `H-REV-01` event reversion canary requires market context freshness `<= 120s`, signal lag `<= 90s`, Jangar
  dependency quorum `allow`, at least `30` samples, post-cost expectancy `>= 8 bps`, and average absolute slippage
  `<= 12 bps`.

Today all three cells would hold or veto. That is the correct decision until empirical jobs and ingestion freshness
are repaired.

### CapitalRoutingReceipt

`CapitalRoutingReceipt` is the object consumed by the live-submission gate and deploy verification.

Required fields:

- `capital_routing_receipt_id`;
- `quant_evidence_settlement_id`;
- `profit_verdict_cell_ids`;
- `route_consumer`: `readyz`, `trading_status`, `scheduler`, `jangar_quant_health`, or `deploy_verify`;
- `decision`;
- `reason_codes`;
- `max_route_budget_ms`;
- `last_route_duration_ms`;
- `rollback_action`;
- `fresh_until`.

Receipt rules:

- `/readyz` can report service-ready while `scheduler` capital routing is `shadow` or `hold`.
- `scheduler` cannot submit live non-observe orders unless the receipt decision is `canary` or `scale`.
- `jangar_quant_health` must report the same settlement id for the same account/window.
- Sim receipt must veto when schema head is not expected head.
- A receipt expires at the earliest expiry among Jangar lease, empirical jobs, quant health, TCA, market context, and
  schema proof.

## Implementation Scope

Engineer stage:

1. Add a settlement projector that builds `QuantEvidenceSettlement`, `ProfitVerdictCell`, and
   `CapitalRoutingReceipt` from existing DB checks, empirical jobs, Jangar quant health, hypothesis runtime status,
   TCA, signal continuity, and market context.
2. Wire `/readyz`, `/trading/status`, `/trading/health`, `/trading/profitability/runtime`, and scheduler submission
   to cite the active receipt id.
3. Wire Jangar quant health to consume the settlement id for account/window parity.
4. Fix sim schema drift before sim can produce a non-veto settlement.
5. Add cross-route tests proving one account/window produces one active settlement and route-specific receipts.
6. Add regression tests for stale empirical jobs, degraded quant ingestion, sim schema drift, stale TCA, and Jangar
   dependency block.

Deployer stage:

1. Verify live settlement exists for account `PA3SX7FYNUTF`, window `15m`, and revision `torghut-00206`.
2. Verify sim settlement is vetoed until schema head equals expected head.
3. Verify all three current hypotheses remain observe/shadow with `rollback_required=true` until empirical jobs and
   ingestion freshness pass.
4. Verify Jangar control-plane status mirrors the settlement id and blocks `torghut_promotion` on stale evidence.
5. Verify rollback can force every receipt to observe/shadow without deleting settlement history.

## Validation Gates

Local checks:

- `uv run --frozen pytest` for affected Torghut tests when code is touched.
- Targeted tests for `submission_council`, `hypotheses`, `completion`, trading API routes, and Jangar quant-health
  route parity.
- `uv run --frozen pyright --project pyrightconfig.json`.
- `uv run --frozen pyright --project pyrightconfig.alpha.json`.
- `uv run --frozen pyright --project pyrightconfig.scripts.json`.
- `bunx oxfmt --check` for touched docs and TypeScript paths.

Live gates:

- `/healthz` and `/readyz` return within `500 ms` p95 for live.
- `/trading/status` returns the active settlement and receipt ids within `750 ms` p95.
- `/trading/empirical-jobs` reports fresh jobs before any canary receipt is issued.
- Jangar quant health returns the same settlement id and reports no ingestion stage above the lane budget.
- TCA for each promoted cell meets that cell's slippage and post-cost thresholds.
- Sim `/readyz` returns HTTP `200` and schema head `0029` before sim receipts can be anything other than veto.

## Rollout

1. Produce settlements in shadow mode and expose ids on status routes.
2. Keep live submission behavior unchanged while comparing old gates to receipts.
3. Enforce receipt veto for sim first because sim schema drift is concrete and isolated.
4. Enforce receipt hold for live canary/scale promotion while leaving observe/shadow evidence collection enabled.
5. Refresh empirical jobs and quant ingestion proof.
6. Permit canary only after the relevant `ProfitVerdictCell` satisfies its hypothesis thresholds.

## Rollback

Rollback must preserve evidence:

- disable receipt enforcement by route consumer, not by truncating tables;
- force all active receipts to observe/shadow through a rollback receipt;
- keep stale empirical and sim-schema evidence visible;
- prevent canary/scale until a new settlement supersedes the rollback receipt;
- record the Jangar runtime lease id used for the rollback decision.

Rollback is successful when live serving remains healthy, scheduler capital stage is observe/shadow, and Jangar reports
`torghut_promotion` blocked or held with a fresh rollback reason.

## Risks

- The settlement projector could become another broad status route. The mitigation is fixed route budgets and small
  digests, not full payload storage.
- Profit thresholds can become stale. The mitigation is to version thresholds per hypothesis and require review before
  changing live canary/scale requirements.
- Account/window mismatch can hide data freshness. The mitigation is to make account and window part of every primary
  key and every Jangar mirror.
- Sim repair can be deferred because live is running. The mitigation is to make sim veto visible in Jangar and block
  any strategy that requires sim parity.

## Handoff

Engineer acceptance:

- implement the three contracts and route/scheduler citations;
- prove cross-route parity with tests;
- keep existing safety vocabulary while replacing route interpretation with receipt consumption;
- do not weaken empirical, TCA, market-context, or Jangar dependency gates to make a cell pass.

Deployer acceptance:

- validate live, sim, Jangar mirror, and receipt behavior through read-only routes;
- verify stale empirical jobs and degraded quant ingestion hold live capital;
- verify sim schema drift vetoes sim receipts;
- roll back by forcing observe/shadow receipts and preserving evidence.
