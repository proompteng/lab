# 138. Torghut Profit Stats Census And TCA Reactivation Market (2026-05-07)

Status: Accepted for engineer and deployer handoff

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: route repair, paper-route probing, quote routeability, and TCA/freshness surfaces exist but remain gate-controlled.
- Matched implementation area: Routeability, TCA, fill quality, and market context.
- Current source evidence:
  - `services/torghut/app/trading/route_reacquisition.py`
  - `services/torghut/app/trading/route_reacquisition_probe.py`
  - `services/torghut/app/trading/scheduler/paper_route_probe/probe_processing.py`
  - `services/torghut/app/trading/scheduler/submission_preparation/quote_routeability.py`
  - `services/torghut/app/trading/tca`
- Design drift note: Routeability claims need current repair/probe/TCA/readiness evidence.


## Decision

I am selecting **profit-stats census with TCA reactivation market** as the next Torghut profitability architecture
step.

Torghut is not blocked because it lacks data. It is blocked because the data surfaces do not settle into a current,
profitable, post-cost action contract. At `2026-05-07T06:29Z`, Torghut live and simulation pods were Running, options
watermarks were current through `2026-05-07T06:29:34.830Z`, and `trade_decisions` held `147623` rows across `16`
symbols. That is enough raw material for profitable repair work. It is not enough to spend capital. Execution and TCA
stopped being current on `2026-04-02`, promotion decisions had `1` row and `0` allowed rows, autoresearch epochs had
`0` rows, and planner statistics were stale enough to misrepresent critical table sizes by orders of magnitude.

The selected design turns those facts into a profit-stats census and a TCA reactivation market. The census classifies
which trading evidence is current, stale, empty, or statistically suspect. The reactivation market ranks zero-notional
repair bids by expected unblock value: repair TCA recency, repair promotion eligibility, repair autoresearch
production, repair database statistics, and then let fresh options watermarks and decision history compete for paper
capital. The tradeoff is that paper remains held even with fresh options data and a large decision history. I accept
that because stale TCA and stale planner statistics make apparent edge unverifiable.

## Runtime Objective And Success Metrics

This contract increases profitability by turning blocked trading evidence into measurable zero-notional repair work
with hard capital guardrails.

Success means:

- Torghut publishes a profit-stats census that distinguishes actual counts, planner estimates, freshness, and gate
  materiality.
- `trade_decisions`, `executions`, `execution_tca_metrics`, options watermarks, promotion decisions, empirical jobs,
  autoresearch epochs, and whitepaper analysis each carry a receipt state.
- TCA reactivation bids are ranked by post-cost unblock value, not by table size or newest artifact alone.
- Options-driven hypotheses may enter zero-notional research and replay while paper/live notional remains `0` until
  TCA, promotion, Jangar census, and market-context receipts are current.
- Planner-stat drift becomes a deployment and query-budget risk with an explicit maintenance recommendation.
- Paper canary eligibility requires current TCA, current Jangar evidence census, current options or market-context
  receipts, at least one promotion-eligible hypothesis, and no unresolved contradiction.

## Evidence Snapshot

All evidence was collected read-only. I did not mutate Kubernetes resources, database rows, ClickHouse tables, broker
state, trading flags, GitOps resources, or empirical artifacts.

### Cluster And Rollout Evidence

- Torghut live `deployment/torghut-00250-deployment` and simulation `deployment/torghut-sim-00350-deployment` were
  `1/1` available and their pods were `2/2` Running.
- Torghut options catalog and enricher deployments were `1/1` available.
- Torghut ClickHouse, keeper, taskmanager, jobmanager, guardrails, alloy, WebSocket, and Symfony pods were Running.
- Argo CD reported `torghut` OutOfSync but Healthy. OutOfSync resources included simulation AnalysisTemplates,
  WorkflowTemplates, and Services.
- Recent Torghut events showed readiness 503s during rollout that later recovered, plus repeated
  `MultiplePodDisruptionBudgets` warnings for ClickHouse pods and a `NoPods` warning for a keeper PDB.

### Database And Data Evidence

- `trade_decisions` exact count was `147623`, with max `created_at` at `2026-05-06T17:44:19.618Z` and max
  `executed_at` at `2026-04-02T20:59:45.140Z`.
- Decision status counts were `69909` rejected, `63569` blocked, `13555` filled, `370` planned, `217` canceled, and
  `3` expired.
- `executions` exact count was `13778`, with max `updated_at` at `2026-04-03T05:32:36.212Z`.
- `execution_tca_metrics` exact count was `13775`, with max `computed_at` at `2026-04-02T20:59:45.136Z`.
- `strategy_promotion_decisions` had `1` row, max `updated_at` at `2026-05-06T22:34:19.476Z`, and `0` allowed rows.
- `autoresearch_epochs` had `0` rows.
- `vnext_empirical_job_runs` had `20` completed rows, max `updated_at` at `2026-05-06T16:27:32.941Z`.
- `whitepaper_analysis_runs` had `1` row, max `updated_at` at `2026-03-12T08:30:18.720Z`.
- `torghut_options_watermarks` had `5293` rows, max successful timestamp at `2026-05-07T06:29:34.830Z`, and
  `0` retry rows.
- `torghut_options_contract_catalog` planner estimate was about `2.39M` rows, enough to support options research if
  query budgets are guarded.
- Planner statistics were stale on operational tables: `pg_stat_user_tables` estimated `trade_decisions` at `17` rows
  versus `147623` actual, and estimated `executions` and `execution_tca_metrics` at `0` despite more than `13K` rows
  each.

### Source Evidence

- `services/torghut/app/trading/submission_council.py` already builds the live submission gate from Jangar dependency
  quorum, quant status, empirical evidence, promotion certificates, market-context segments, and TCA inputs.
- `_evaluate_certificate_candidates` blocks missing/stale metric windows, dependency quorum failures, shadow-only
  candidates, missing promotion eligibility, and blocked segments.
- `build_live_submission_gate_payload` blocks live when toggles are off, promotion eligibility is zero, empirical proof
  is not ready, dependency quorum is not allow, required quant metrics are not OK, or certificates are stale.
- `services/torghut/app/trading/tca.py` already writes and aggregates execution TCA metrics, including slippage,
  shortfall, churn, and recency.
- `services/torghut/app/trading/empirical_jobs.py` already marks promotion authority eligible only when scorecards,
  parity, and lineage are ready.
- `services/torghut/app/trading/discovery/promotion_contract.py` requires runtime family, scheduler parity, and live
  shadow validation before candidate promotion readiness.

## Problem

Torghut has a live decision factory but no current post-cost settlement loop.

The current database says there are many decisions, many rejections and blocks, and enough options data to form new
research hypotheses. It also says executions and TCA have not refreshed since early April. Without current TCA, no one
can tell whether a strategy that looks profitable before costs survives slippage, churn, and fill quality. Without
promotion eligibility, no empirical or options candidate should claim paper authority. Without accurate planner
statistics, even read-only profitability checks can choose inefficient plans and become a reliability risk.

The architecture should not ask engineers to "make Torghut trade". It should ask them to reactivate the evidence loop
that makes trading defensible.

## Alternatives Considered

### Option A: Promote Fresh Options Data Into A Paper Canary

Pros:

- Uses the freshest data surface in the system.
- Creates new paper observations quickly.
- Might discover volatility or liquidity dislocations before the current window decays.

Cons:

- Ignores TCA staleness from `2026-04-02`.
- Ignores `0` allowed promotion decisions.
- Ignores planner-stat drift on the same operational tables used to explain profitability.
- Risks treating raw opportunity as verified edge.

Decision: reject.

### Option B: Freeze Profit Work Until Every Evidence Table Is Current

Pros:

- Strong capital safety.
- Easy deployer gate.
- Avoids spending compute against contradictory evidence.

Cons:

- Wastes fresh options watermarks and decision-history signal.
- Does not rank which repair unblocks profit fastest.
- Lets autoresearch, promotion, and TCA remain independent backlogs instead of one post-cost repair portfolio.

Decision: reject.

### Option C: Profit-Stats Census And TCA Reactivation Market

Pros:

- Keeps notional at `0` while converting blocked evidence into ranked repair bids.
- Makes planner-stat drift a first-class reliability and query-budget input.
- Prioritizes TCA recency before capital because post-cost truth is the missing profitability primitive.
- Lets fresh options data create research and replay bids without bypassing promotion and TCA gates.
- Produces measurable hypotheses and deployer acceptance gates.

Cons:

- Requires a new reducer and route receipt.
- Requires careful bounded counting to avoid pressure on large tables.
- May hold paper longer than an opportunistic options-only path.

Decision: select Option C.

## Architecture

Torghut emits one profit-stats census per account, strategy family, and market window.

```text
profit_stats_census
  census_id
  generated_at
  account_label
  strategy_family
  market_window
  jangar_evidence_census_ref
  table_stat_receipt_refs
  evidence_receipt_refs
  tca_reactivation_bid_refs
  capital_state             # zero_notional, shadow, paper_ready, live_micro_ready
  max_notional
  reason_codes
  fresh_until
```

Each material table or evidence family emits a bounded receipt.

```text
profit_evidence_receipt
  receipt_id
  census_id
  evidence_family           # decisions, executions, tca, options, promotion, empirical, autoresearch, whitepaper
  source_ref
  exact_count               # only for bounded operational tables
  planner_estimate
  max_event_time
  state                     # current, stale, empty, stats_stale, blocked, research_only
  materiality               # research, replay, paper, live
  allowed_effects
  blocked_effects
  reason_codes
```

TCA reactivation becomes an explicit market of zero-notional repair bids.

```text
tca_reactivation_bid
  bid_id
  census_id
  hypothesis_id
  symbol
  account_label
  blocker_refs
  expected_unblock_value
  required_evidence
  max_notional              # always 0 until TCA and promotion receipts are current
  selected
  reason_codes
```

### Measurable Trading Hypotheses

1. **Options freshness hypothesis:** fresh options watermarks and a multi-million-row contract catalog can identify
   covered-call, put-spread, and volatility-dislocation candidates. Guardrail: research and replay only until TCA,
   promotion, and Jangar census receipts are current.
2. **TCA recency hypothesis:** refreshing execution/TCA settlement for the `16` active decision symbols will reduce
   false paper candidates and expose post-cost edge. Target: current TCA within one trading session, average absolute
   slippage inside the configured guardrail before any paper widening.
3. **Decision-blocker concentration hypothesis:** the `69909` rejected and `63569` blocked decisions contain a small
   set of recurring blocker reasons. Target: top blocker families ranked with repair bids and at least one
   promotion-eligible candidate before paper canary.
4. **Statistics-drift hypothesis:** repairing planner statistics on operational tables will reduce query-budget risk
   and make route/census latency predictable. Target: planner estimate and exact count for bounded tables remain inside
   the configured drift budget before deploy widening.

### Capital Semantics

- `options_current` may authorize research and replay, not paper.
- `tca_stale` is a hard paper/live hold.
- `promotion_allowed_count=0` is a hard paper/live hold.
- `autoresearch_empty` is a repair bid, not a capital blocker by itself unless it is the only source of current
  hypothesis generation.
- `stats_stale` blocks deploy widening and large ad hoc analysis until maintenance is reviewed.
- `jangar_census_degraded` holds paper/live and may still allow zero-notional repair if the degraded receipts are not
  trading-safety critical.

## Implementation Scope

Engineer stage should implement the minimum production slice:

- Add a `profit_stats_census` reducer that reads existing Torghut tables through bounded queries.
- Compare planner estimates with exact counts only on bounded operational tables such as `trade_decisions`,
  `executions`, `execution_tca_metrics`, `strategy_promotion_decisions`, `autoresearch_epochs`, and
  `vnext_empirical_job_runs`.
- Use estimates and freshness watermarks for large quant and options tables instead of full scans.
- Add TCA reactivation bid scoring from TCA recency, symbol coverage, blocked decision volume, promotion state, and
  expected post-cost unblock value.
- Surface census receipts and selected bids in `/readyz` and `/trading/status` with max notional fixed at `0` while
  hard blockers remain.
- Add tests for stale TCA hold, options research-only state, promotion-zero hold, planner-stat drift, and Jangar census
  degraded consumption.

Out of scope for the first implementation:

- Enabling live submission or increasing paper notional.
- Mutating database statistics automatically.
- Creating new broker credentials or changing account scopes.
- Full scans of quant history or options catalog tables.

## Validation Gates

Local validation:

- `uv sync --frozen --extra dev`
- `uv run --frozen pytest tests/test_profitability_proof_floor.py tests/test_tca_adaptive_policy.py`
- `uv run --frozen pytest tests/test_policy_checks.py tests/test_trading_scheduler_safety.py`
- `uv run --frozen pyright --project pyrightconfig.json`
- `uv run --frozen pyright --project pyrightconfig.alpha.json`
- `uv run --frozen pyright --project pyrightconfig.scripts.json`

Cluster and database validation after deploy:

- Read `/readyz` and `/trading/status` and confirm `profit_stats_census` includes receipt ids, selected bids, reason
  codes, and `max_notional=0` while hard blockers remain.
- Run read-only SQL against Torghut to verify receipt counts for `trade_decisions`, `executions`,
  `execution_tca_metrics`, `strategy_promotion_decisions`, `autoresearch_epochs`, `vnext_empirical_job_runs`, and
  `torghut_options_watermarks`.
- Confirm no validation step runs full counts on large quant history tables.
- Confirm paper canary remains held until TCA is current, Jangar census is current, promotion has at least one allowed
  candidate, and market-context receipts are current.

## Rollout Plan

1. Ship profit-stats census in observe-only mode with notional fixed at `0`.
2. Compare selected TCA reactivation bids with proof-floor blockers for one closed-session and one market-session
   window.
3. Let zero-notional repair jobs consume selected bids for TCA and promotion repair.
4. Add deploy widening hold when planner-stat drift breaches budget on operational tables.
5. Permit paper-readiness evaluation only after Jangar census, TCA, promotion, options or market context, and
   proof-floor receipts are current.
6. Require paper outcome and rollback receipts before any live micro discussion.

## Rollback Plan

- Stop consumers from reading `profit_stats_census` and fall back to existing proof-floor and submission-council gates.
- Keep selected repair bids observable if route latency and query budgets remain healthy.
- Keep paper and live capital held if the census is missing, degraded, or stale.
- Revert the Torghut image through GitOps if census generation causes readiness latency or database pressure.

## Risks And Mitigations

- **Query pressure:** bound exact counts to operational tables and use estimates for large history/catalog tables.
- **Over-prioritizing old TCA rows:** score recency and symbol coverage separately from row volume.
- **Options false edge:** options receipts remain research-only until post-cost and promotion receipts clear.
- **Planner-stat maintenance ambiguity:** the census recommends maintenance but does not mutate database state.
- **Route payload growth:** expose compact receipts on readiness and keep detailed bids on trading status.

## Handoff To Engineer

Implement the census and bid reducer before changing any trading behavior. The first production value is a route payload
that explains which zero-notional repair should run next and why capital is still held. Keep large-table access
estimate-based and make every exact count obviously bounded in code and tests.

## Handoff To Deployer

Do not approve paper or live widening from fresh options data alone. Require current TCA, at least one allowed
promotion decision, current Jangar evidence census, current market-context or options receipt as applicable, and
planner-stat drift inside budget. If the census recommends database maintenance, route it through a reviewed
maintenance change rather than mutating records during validation.
