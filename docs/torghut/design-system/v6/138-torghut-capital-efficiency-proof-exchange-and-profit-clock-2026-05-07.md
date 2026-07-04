# 138. Torghut Capital-Efficiency Proof Exchange and Profit Clock

- Status: Accepted for engineer and deployer handoff
- Date: 2026-05-07
- Owner: Gideon Park, Torghut Traders architecture
- Scope: Torghut quant profitability, hypothesis admission, data quality, capital guardrails, rollback behavior
- Companion: `docs/agents/designs/134-jangar-profit-clock-settlement-router-and-evidence-margin-arbiter-2026-05-07.md`

## Decision

Torghut will move from a flat proof-floor repair queue to a capital-efficiency proof exchange. The exchange ranks
zero-notional repairs and paper/live capital requests by expected profit per unit of evidence debt, margin charge,
and clock risk. Capital cannot advance unless the hypothesis carries a current Jangar profit-clock settlement
receipt and the local proof floor agrees that the same evidence epoch is fit for the requested action.

The design is intentionally ambitious: it treats proof freshness, feature availability, execution cost, and
control-plane trust as scarce balance-sheet inputs. The goal is not to submit trades faster. The goal is to make
Torghut spend its next repair and canary efforts where they can create measurable, post-cost profit with bounded
capital risk.

## Evidence Snapshot

Read-only evidence captured on 2026-05-07 around 06:10-06:20 UTC:

Cluster and runtime:

- Jangar is serving and its deployment is rolled out.
- Agents controllers are rolled out at 2/2 replicas after earlier failed jobs and transient readiness timeouts.
- Torghut live revision `torghut-00250` is serving, but `/readyz` and `/trading/health` are degraded.
- Live trading status shows `capital_stage: shadow`, `live_submission_gate.allowed: false`,
  `simple_submit_disabled`, and proof-floor `route_state: repair_only`.
- Live proof-floor blocking reasons include `hypothesis_not_promotion_eligible`,
  `execution_tca_stale`, and `simple_submit_disabled`.
- Live quant evidence reports `quant_pipeline_degraded` with `maxStageLagSeconds: 44777`. Compute is current,
  while ingestion and materialization are not coherent.
- Sim revision `torghut-sim-00350` is serving and ready, but remains zero-notional and not promotion eligible.

Source architecture:

- `services/torghut/app/trading/proof_floor.py` already fails closed on stale or contradictory proof and emits a
  repair ladder.
- `services/torghut/app/trading/submission_council.py` already consumes Jangar quant health and clamps live
  submission when authority is missing or degraded.
- `services/torghut/app/trading/hypotheses.py` already evaluates runtime hypothesis state from dependency
  capabilities, feature rows, drift, market context, evidence continuity, signal lag, and TCA.
- `services/torghut/app/trading/empirical_jobs.py` already enforces artifact lineage and promotion authority for
  empirical jobs.
- `services/torghut/app/trading/tca.py` already summarizes execution TCA, but current persisted TCA is too old
  for live authority.
- Tests are broad at the component level, especially around proof floor, hypotheses, submission council,
  empirical jobs, TCA, quant readiness, and runtime simulations. The missing test surface is the integrated
  capital decision that joins Jangar stage authority, Postgres proof windows, ClickHouse feature clocks, and TCA
  freshness into one hypothesis-level profit clock.

Database and feature evidence:

- Postgres schema head is `0029_whitepaper_embedding_dimension_4096`.
- `execution_tca_metrics` has 13,775 rows, but latest `computed_at` is
  `2026-04-02T20:59:45.136640Z`; average absolute slippage is about 568.6 bps.
- `trade_decisions` has 147,623 rows. Latest created decision is `2026-05-06T17:44:19.618796Z`, while latest
  executed decision is from the April execution epoch.
- `strategy_hypothesis_metric_windows` has 3 rows, all for `H-MICRO-01`; only one persisted window has positive
  post-cost expectancy, and promotion still fails sample count, slippage, and expectancy requirements.
- `vnext_empirical_job_runs` shows 20 rows, with the newest empirical job set completed on
  `2026-05-06T16:27:32.941330Z` for candidate `chip-paper-microbar-composite@execution-proof`.
- `vnext_dataset_snapshots` has one runtime-window snapshot for a short paper simulation window on
  2026-05-06.
- ClickHouse `torghut.ta_microbars` has 1,749,621 rows and `torghut.ta_signals` has 1,165,933 rows through
  `2026-05-06T20:58:35Z`.
- ClickHouse options tables are empty: `options_contract_bars_1s`, `options_contract_features`, and
  `options_surface_features` each have 0 rows.

## Problem

Torghut has a hard proof floor, but not yet a capital-efficiency market for retiring proof debt.

The current system correctly refuses capital. That is good. The problem is that it does not yet tell engineer
and deployer stages which repair produces the highest expected capital unlock per unit of risk. As a result,
very different failures can compete in a flat queue:

- stale execution TCA from April 2,
- live ingestion lag above 44,000 seconds,
- empty options feature tables,
- H-MICRO-01 paper windows with insufficient sample depth,
- H-CONT-01 and H-REV-01 clocks that remain shadow or rollback-required,
- control-plane trust and rollout clocks that must stay coherent.

The next architecture step should not lower the proof floor. It should make the proof floor economically
directed.

## Alternatives Considered

### Option A: Continue the Current Proof Floor and Repair Ladder

Keep the proof floor as the final authority and use its reason codes to drive manual or scheduled repairs.

Benefit:

- Strong safety properties are already implemented.
- Low engineering cost.
- Existing tests protect important local behavior.

Cost:

- Does not rank repairs by expected profit impact.
- Does not distinguish high-value zero-notional repairs from low-value housekeeping.
- Leaves stage, TCA, feature, and empirical clocks as adjacent evidence instead of a hypothesis balance sheet.

### Option B: Expand Paper and Options Exploration Now

Use the fact that live and sim pods are serving to widen paper exploration, especially into the options lane,
while keeping live capital disabled.

Benefit:

- Potentially increases learning rate.
- Could discover profitable options microstructure behavior before the lane is fully mature.

Cost:

- Current options feature tables are empty, so the exploration would be mostly infrastructure exercise.
- Live ingestion and materialization clocks are not coherent.
- Existing TCA is stale and far outside acceptable slippage budgets.
- It would add more observations without proving they can become capital-qualified decisions.

### Option C: Capital-Efficiency Proof Exchange

Create a hypothesis-level exchange that prices repair and canary actions by expected post-cost profit, proof
debt, margin charge, and clock risk. Repairs can run zero-notional under a Jangar `repair_dispatch` receipt.
Paper and live canaries require Jangar `paper_canary` or `live_micro_canary` receipts plus local proof-floor
agreement.

Benefit:

- Keeps live capital locked while improving the rate at which proof debt is retired.
- Produces measurable trading hypotheses with explicit gates.
- Turns current evidence gaps into ranked, testable work for engineer and deployer stages.
- Creates a shared contract with Jangar so capital cannot advance on stale or mismatched clocks.

Cost:

- Requires new ledger and receipt integration.
- Adds cross-source acceptance tests.
- May reject attractive isolated paper windows until their execution, feature, and control-plane clocks align.

I choose Option C.

## Architecture

### Capital-Efficiency Proof Exchange

The exchange is a Torghut-owned service boundary that sits above the current proof floor and below any capital
allocator. It should create two output types:

- `repair_bid`: a zero-notional action that retires a named evidence debt.
- `capital_request`: a paper or live canary request for one or more hypotheses.

Each output is scored by a capital-efficiency function:

`capital_efficiency_score = expected_daily_net_bps_after_cost / (proof_debt_weight * clock_risk_weight * margin_charge * repair_minutes)`

The exact model can start simple and deterministic. The important part is that every repair and capital request
has the same dimensions:

- hypothesis ID,
- action class,
- expected post-cost edge,
- sample count and session coverage,
- execution slippage budget,
- feature freshness,
- market-context freshness,
- empirical lineage,
- Jangar settlement receipt,
- notional ceiling,
- rollback target.

The score does not override safety. A high score can only reorder eligible work. It cannot bypass proof-floor or
Jangar settlement holds.

### Profit Clock

Every hypothesis gets a profit clock. The clock is current only when these inputs belong to the same acceptable
epoch:

- Jangar `profit_clock_settlement_receipt`,
- Torghut revision and mode,
- execution TCA summary,
- strategy hypothesis metric window,
- empirical job lineage,
- ClickHouse feature inventory,
- market context,
- signal continuity,
- proof-floor route state.

The profit clock fails closed for capital if any required source is missing, stale, contradictory, or older than
the action-class TTL.

### Suggested Data Shapes

Engineer stage can choose exact storage, but the design needs these durable concepts:

- `profit_clock_receipts`: cached Jangar receipt refs and local parse state.
- `hypothesis_margin_ledgers`: one current row per hypothesis, account scope, and capital stage.
- `repair_bids`: ranked zero-notional repairs with expected unlock value and expiry.
- `feature_lane_inventory`: current row/freshness state for equities, options contracts, options surface, and
  market context lanes.
- `capital_efficiency_snapshots`: append-only score snapshots used for audit and regression tests.

These should be append-friendly and idempotent. The exchange must never update trade records or execution
records as part of scoring.

## Trading Hypotheses and Guardrails

### H-MICRO-01: Chip Microbar Composite Repair

Current state: blocked in runtime status, with persisted windows only for H-MICRO-01 and insufficient promotion
evidence.

Repair objective:

- Restore feature rows, drift checks, and current TCA for the microbar composite path.

Paper gate:

- Jangar receipt decision `allow` for `paper_canary`.
- TCA latest computed within 1 market day.
- ClickHouse `ta_microbars` and `ta_signals` ingest lag <= 120 seconds during an open session.
- Minimum 60 paper decisions across at least 3 distinct sessions.
- Average absolute slippage <= 8 bps.
- Post-cost expectancy >= 10 bps after fees and slippage.
- No required feature lane empty.

Live gate:

- Jangar receipt decision `allow` for `live_micro_canary`.
- Proof floor route state is not `repair_only`.
- Live submission gate is explicitly enabled.
- Notional starts at zero until the first deployer-approved micro canary.

Rollback:

- Return to shadow if TCA stales beyond 1 market day, feature inventory empties, post-cost expectancy falls below
  0 bps over the active window, or receipt expires.

### H-CONT-01: Session Continuation

Current state: shadow and rollback-required because signal lag and TCA are stale.

Paper gate:

- Signal lag <= 90 seconds during open session.
- TCA latest computed within 1 market day.
- Minimum 40 paper decisions and 80 signal observations.
- Post-cost expectancy >= 6 bps.
- Average absolute slippage <= 12 bps.

Rollback:

- Return to shadow on signal lag > 180 seconds, TCA stale, or two consecutive windows below 0 bps post cost.

### H-REV-01: Event Reversion

Current state: shadow and rollback-required because market context is stale.

Paper gate:

- Market-context freshness <= 120 seconds during open session.
- Minimum 30 paper decisions across at least 2 sessions.
- Post-cost expectancy >= 8 bps.
- Average absolute slippage <= 12 bps.
- No unresolved market-context contradiction reason from the proof floor.

Rollback:

- Return to shadow on market-context freshness > 300 seconds, receipt expiry, or post-cost expectancy below
  0 bps over the active replay window.

### Options Sleeve: Blocked Until Feature Inventory Exists

Current state: blocked for capital and paper widening because ClickHouse options bars and feature tables are
empty.

Repair gate:

- Zero-notional `repair_dispatch` only.
- Populate `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features`.
- Validate at least one open-session feature snapshot with contracts, spreads, and quote freshness.

Paper gate:

- No paper canary until all options feature tables have nonzero rows and quote freshness is <= 15 seconds during
  an open options session.
- Spread guardrail starts at max 30 bps for eligible contracts.
- No live options notional until paper windows prove positive post-cost edge and borrow/margin assumptions are
  modeled.

## Engineer Acceptance Gates

Engineer stage should implement the first production slice behind existing gates:

- Build deterministic scoring for `repair_bid` and `capital_request`.
- Parse and validate Jangar profit-clock settlement receipts.
- Add `feature_lane_inventory` evidence for equity TA and options lanes.
- Add integrated profit-clock tests that join receipt state, proof floor state, TCA freshness, feature inventory,
  empirical lineage, and hypothesis windows.
- Add regression tests for the May 7 evidence:
  - stale April 2 TCA blocks paper/live capital,
  - empty options features block options paper and live capital,
  - H-MICRO-01 can produce repair bids while notional remains zero,
  - expired Jangar receipts fail closed,
  - Postgres statistics estimates cannot be used as row-count truth for capital.
- Expose a read-only status surface that lists ranked repair bids, capital requests, and active rollback targets.

## Deployer Acceptance Gates

Deployer stage should use the exchange to decide when to widen runtime behavior:

- Initial rollout is observe-only with no capital behavior change.
- Zero-notional repair dispatch can be enabled after receipt parity with Torghut proof-floor blockers is visible.
- Paper canary admission requires one full market session where exchange status, proof floor, and Jangar receipts
  agree.
- Live micro canary requires:
  - Jangar `live_micro_canary` receipt `allow`,
  - proof floor not `repair_only`,
  - live submission explicitly enabled,
  - TCA fresh within 1 market day,
  - feature inventory current,
  - hypothesis-specific paper gates satisfied,
  - rollback target set to shadow or zero notional.

## Rollout Plan

1. Add exchange read model and tests without changing capital behavior.
2. Emit ranked repair bids in `/trading/status` or an adjacent read-only route.
3. Enable zero-notional repair scheduling from top-ranked bids.
4. Require Jangar receipt agreement before any paper canary widening.
5. Require full profit-clock agreement before any live micro canary.

## Rollback Plan

Rollback must be immediate and local:

- If Jangar receipt is missing, expired, unknown schema, or contradictory, all capital requests hold.
- If TCA stales past 1 market day, all hypotheses return to shadow or zero notional.
- If ClickHouse equity TA ingest lag exceeds 300 seconds during an open session, paper and live canaries hold.
- If options feature inventory returns to zero rows, options sleeve stays repair-only.
- If proof-floor route state returns to `repair_only`, live admission is disabled even when exchange scores are
  high.

## Risks

- Scoring can create false precision. The first implementation must keep scoring simple and reason-coded.
- A repair bid can become stale quickly during market hours. Every bid needs expiry.
- The exchange adds another surface that can diverge from the proof floor. Deployer stage must require parity
  before treating it as authority.
- The current options lane has no feature rows, so options profitability remains a runway, not an immediate
  capital candidate.

## Handoff

Engineer stage owns the exchange read model, scoring, Jangar receipt parser, feature inventory, and integrated
tests. Deployer stage owns observe-only rollout, receipt/proof-floor parity validation, zero-notional repair
enablement, paper canary widening, and final live micro-canary gates. Until all gates are satisfied, the correct
capital posture is shadow or zero notional.
