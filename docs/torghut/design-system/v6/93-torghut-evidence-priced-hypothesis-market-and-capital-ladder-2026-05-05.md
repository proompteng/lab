# 93. Torghut Evidence-Priced Hypothesis Market and Capital Ladder (2026-05-05)

Status: Accepted for engineer and deployer handoff

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

Torghut should add an **EvidencePricedHypothesisMarket** and a staged **CapitalLeaseLadder**.

The current system is broker-safe but not profit-productive. Live submission is disabled, active capital is shadow,
zero hypotheses are promotion eligible, all three current hypotheses require rollback, empirical jobs are stale, Jangar
quant-health times out, recent signals have duplicate groups, and options feature tables are empty. Freezing everything
keeps us safe but does not buy the evidence needed to trade. Pushing new alpha first would be worse: it would add
strategy surface before the proof and data-quality surfaces can price risk.

I am choosing an evidence-priced market. Each hypothesis receives a current quote made from expected edge, proof debt,
data quality, Jangar brownout posture, empirical freshness, and broker safety. The market can allocate zero-notional
repair and replay budget while paper/live capital remains held. Paper probes start only when the quote clears the
capital ladder and the Jangar companion contract is not holding capital.

The tradeoff is that this delays exciting strategy work until the proof market can measure it. That is the right trade:
profitable capital is a product of current evidence, not just plausible ideas.

## Evidence Snapshot

All assessment for this pass was read-only.

### Cluster And Route Evidence

- Torghut namespace pods were Running, including ClickHouse replicas, `torghut-db-1`, live revision `torghut-00222`,
  sim revision `torghut-sim-00303`, TA Flink jobs, options TA, options catalog, options enricher, and WebSocket
  forwarders.
- Torghut live `/healthz` returned HTTP 200 in 0.008s.
- Torghut sim `/healthz` returned HTTP 200 in 0.007s.
- Torghut live `/trading/status` returned HTTP 200 in 4.944s with `last_decision_at=2026-05-04T17:25:57.901670Z`,
  active revision `torghut-00222`, active capital stage `shadow`, and current scheduler loop activity.
- Live status reported three hypotheses: `H-CONT-01`, `H-MICRO-01`, and `H-REV-01`. All three had capital multiplier
  `0`; none were promotion eligible; all three required rollback.
- Live `/trading/health` returned HTTP 503 in 6.208s. Postgres, ClickHouse, Alpaca, universe, and readiness cache were
  OK, but live submission was blocked by `simple_submit_disabled`.
- Sim `/trading/health` returned HTTP 200 in 4.312s, but alpha readiness had `dependency_quorum.decision=unknown`
  because the Jangar status fetch timed out.
- Jangar control-plane status returned HTTP 200, but dependency quorum was `block` with reason
  `empirical_jobs_degraded`, and execution trust was degraded for stale discover, plan, implement, and verify stages.
- Jangar quant-health for both live and sim with `window=5d` timed out after 25 seconds with HTTP 000.
- The live Torghut GitOps manifest sets `TRADING_JANGAR_QUANT_HEALTH_REQUIRED=false` and does not set
  `TRADING_JANGAR_QUANT_HEALTH_URL`; sim does set the quant-health URL.

### Database And Data Evidence

- `/db-check` returned HTTP 200 with `schema_current=true`, current head `0029_whitepaper_embedding_dimension_4096`,
  one current head, one expected head, and no duplicate revisions.
- The schema graph is lineage-ready but still reports known parent forks at
  `0010_execution_provenance_and_governance_trace` and `0015_whitepaper_workflow_tables`.
- ClickHouse `torghut.ta_microbars` had 1,676,669 rows, max event time `2026-05-05 20:50:32.000`, and max ingest time
  `2026-05-05 20:51:08.757`.
- ClickHouse `torghut.ta_signals` had 1,185,151 rows, max event time `2026-05-05 20:50:12.000`, and max ingest time
  `2026-05-05 20:51:02.702`.
- Recent duplicate groups in the last six hours were `803` for `ta_signals` and `0` for `ta_microbars`.
- Options tables `options_contract_bars_1s`, `options_contract_features`, and `options_surface_features` had zero
  rows.
- `/trading/empirical-jobs` returned `ready=false`, `status=degraded`, `authority=blocked`, and stale
  `benchmark_parity`, `foundation_router_parity`, `janus_event_car`, and `janus_hgrm_reward` jobs. The candidate was
  `intraday_tsmom_v1@prod`; the dataset snapshot was `torghut-full-day-20260318-884bec35`.

### Source Architecture And Test Surface

- Hypotheses are source-controlled in `services/torghut/config/trading/hypotheses`. Current manifests declare expected
  gross edge of 6 bps for continuation, 10 bps for microstructure breakout, and 8 bps for event reversion, with
  rollback triggers for Jangar dependency blocks, stale context, feature gaps, drawdown, and post-cost expectancy.
- `services/torghut/app/trading/hypotheses.py` already compiles hypothesis readiness and dependency quorum into runtime
  status.
- `services/torghut/app/trading/empirical_jobs.py` already models stale jobs, truthfulness, candidate IDs, dataset
  snapshots, authority, and promotion eligibility.
- `services/torghut/app/trading/submission_council.py` already composes dependency quorum, empirical jobs, DSPy,
  quant evidence, promotion certificates, and capital stage into a proof-aware gate.
- `services/torghut/app/main.py` still contains a local simple live gate path; the simple lane must not become a
  separate source of capital truth.
- The Torghut test suite is broad, with 140 Python test files. The highest-risk policy surface is concentrated in
  `test_policy_checks.py` at 5,656 lines and `app/trading/autonomy/policy_checks.py` at 6,072 lines. New capital logic
  must be small, pure, and fixture-driven.

## Problem

Torghut has three separate forms of debt that currently collapse into "do not trade":

1. proof debt: empirical jobs are structurally present but stale;
2. data-quality debt: signals are fresh but have recent duplicate groups, and options features are empty;
3. control-plane debt: Jangar can serve but holds material swarm action on degraded execution trust and stale empirical
   proof.

That state is correctly blocking capital. It is also too coarse to improve profitability. The system needs a way to
fund the next proof action that is most likely to unlock safe profit, without pretending that a proof action is capital
deployment.

## Alternatives Considered

### Option A: Freeze Until Every Gate Is Green

Keep live and paper capital disabled until empirical jobs, quant-health, signal duplicate checks, options tables,
Jangar execution trust, and all hypotheses are green.

Pros:

- Strong broker safety.
- Simple deployer rule.
- Prevents partial proof from leaking into capital.

Cons:

- Does not prioritize repairs.
- Blocks zero-notional replay and proof refresh behind the same capital gate.
- Can leave stale empirical jobs stale forever.
- Does not create a measurable path to profitability.

Decision: keep as emergency posture only.

### Option B: Build A New Alpha Lane First

Use the current shadow state to build a more ambitious microstructure or options strategy, then backfill proof.

Pros:

- Higher apparent upside.
- Uses existing hypothesis scaffolding.
- Keeps product momentum visible.

Cons:

- Ignores current data-quality debt.
- Adds options dependency before options tables have rows.
- Increases proof debt and route pressure.
- Risks optimizing against stale March empirical artifacts.

Decision: reject for the next lane.

### Option C: Evidence-Priced Hypothesis Market And Capital Ladder

Price each hypothesis by expected edge, current evidence, data quality, Jangar posture, and repair cost. Allocate
zero-notional repair/replay budget first. Paper and live capital require fresh leases from the capital ladder.

Pros:

- Creates a profit-seeking repair order instead of a flat freeze.
- Separates zero-notional learning from broker exposure.
- Gives options work a bootstrap path without allowing options capital on empty tables.
- Lets Jangar brownout posture hold capital while repair proof continues.
- Produces measurable gates for engineer and deployer stages.

Cons:

- Adds policy state that must be explainable.
- Needs static weights before dynamic learning can be trusted.
- Requires careful validation of data-quality quotes so duplicate groups are not underpriced.

Decision: select Option C.

## Chosen Architecture

### EvidencePricedHypothesisMarket

```text
hypothesis_market_quote
  quote_id
  hypothesis_id
  lane_id
  expected_gross_edge_bps
  expected_net_edge_bps
  proof_freshness_score
  data_quality_score
  control_plane_score
  repair_cost_score
  falsification_value
  capital_unlock_value
  market_price
  recommended_action       # hold, repair, replay, paper_probe, live_probe, scale
  reason_codes
  observed_at
  fresh_until
```

Rules:

- `repair` and `replay` can run with zero notional under Jangar `repair_only` or `dispatch_hold` only when they have
  explicit repair budgets.
- `paper_probe` requires fresh empirical jobs, configured quant-health projection, no capital hold from Jangar, and
  data-quality quote inside threshold.
- `live_probe` requires two clean paper sessions, positive post-cost expectancy, broker safety toggles, and rollback
  readiness.
- A hypothesis with positive gross edge but stale proof receives repair priority, not capital.

### DataQualityQuote

```text
data_quality_quote
  quote_id
  dataset_ref
  signal_max_event_ts
  signal_duplicate_groups_6h
  microbar_max_event_ts
  microbar_duplicate_groups_6h
  option_feature_rows
  schema_current
  lineage_warning_count
  decision               # pass, observe, repair_only, hold
  reason_codes
```

Initial thresholds:

- signal and microbar freshness must be inside the market-session expectation window;
- signal duplicate groups must be below a policy threshold before paper;
- options feature rows must be nonzero before any options hypothesis can leave repair;
- schema lineage warnings are allowed for zero-notional repair but must be acknowledged in the capital lease.

### CapitalLeaseLadder

```text
capital_lease
  lease_id
  hypothesis_id
  account_scope
  stage                  # zero_notional, paper_probe, paper_canary, live_probe, scaled_live
  max_notional
  expires_at
  required_quotes
  required_jangar_posture
  rollback_triggers
  status                 # active, held, expired, revoked
```

Rules:

- `zero_notional` is for learning and repair only. It cannot place broker orders.
- `paper_probe` is the first broker-visible stage and must be short-lived.
- `live_probe` cannot start from a stale March artifact. It needs fresh empirical jobs and current market-session proof.
- Any Jangar `capital_hold` or `block` revokes paper and live leases but leaves zero-notional repair available if the
  repair budget allows it.

## Measurable Hypotheses

- `H-CONT-01` continuation: expected gross edge 6 bps. Next action is `repair` until empirical jobs are fresh and
  signal duplicate groups are below threshold. Paper probe requires positive net edge after slippage and no Jangar
  capital hold.
- `H-MICRO-01` microstructure breakout: expected gross edge 10 bps. Next action is `repair_only` because it is already
  blocked and depends on feature coverage. It cannot receive paper capital until microstructure feature coverage and
  duplicate signal controls pass.
- `H-REV-01` event reversion: expected gross edge 8 bps. Next action is `repair` for market-context and empirical
  freshness. It cannot promote while Jangar dependency quorum is block or unknown.
- Options hypotheses remain `hold` until options feature tables are nonzero and the options catalog firebreak clears a
  bounded cycle.

## Engineer Scope

1. Add pure quote builders for `EvidencePricedHypothesisMarket`, `DataQualityQuote`, and `CapitalLeaseLadder`.
2. Read Jangar brownout posture from the companion contract and expose it in Torghut status without request-time deep
   proof scans.
3. Add data-quality quote inputs from ClickHouse signal/microbar freshness, duplicate groups, options feature row
   counts, schema current state, and empirical job freshness.
4. Route the simple live gate through the proof-aware submission council and capital lease decision.
5. Add static policy weights for the first release; do not let producers self-report market price.
6. Emit zero-notional repair recommendations for the three current hypotheses and keep paper/live disabled until the
   validation gates pass.

## Validation Gates

- Unit test: stale empirical jobs make a quote recommend `repair`, not `paper_probe`.
- Unit test: Jangar `capital_hold` revokes paper/live leases but leaves budgeted zero-notional repair available.
- Unit test: signal duplicate groups above threshold hold paper even when signal freshness is current.
- Unit test: options hypotheses remain held when options feature tables have zero rows.
- Unit test: simple live mode cannot allow broker-visible capital without a current capital lease.
- Integration test: `/trading/status` includes market quotes and data-quality quotes from cached projections.
- Integration test: `/trading/health` stays fail-closed for paper/live when quant-health is missing or times out.
- Deployer smoke: after one market session, each hypothesis has a quote, a recommended action, reason codes, and an
  expiry.

## Rollout Plan

1. Ship quote builders and status projection only.
2. Run one market session in observe mode and compare quote recommendations to current submission-council blocks.
3. Enforce zero-notional repair budget selection for stale empirical jobs and data-quality debt.
4. Wire simple live mode through capital leases while keeping `TRADING_SIMPLE_SUBMIT_ENABLED=false`.
5. Enable paper-probe shadow only after empirical jobs are fresh, quant-health is configured, duplicate signals are
   inside threshold, and Jangar has no capital hold.
6. Enable paper probes before any live probe. Live remains disabled until two clean paper sessions show positive
   post-cost expectancy and rollback readiness.

## Rollback Plan

- Disable market quote enforcement and keep status projection.
- If quote generation pressures ClickHouse or Postgres, use cached latest data-quality projections only.
- If Jangar posture is unavailable, fail closed for paper/live and allow only local zero-notional repair.
- If simple live council routing regresses, keep `TRADING_SIMPLE_SUBMIT_ENABLED=false` and hold capital in shadow.
- If options firebreak blocks serving, keep cache serving open and hold only capital-relevant options readiness.

## Handoff Contract

Engineer acceptance:

- Capital logic must be pure and tested before route wiring.
- Static policy weights must live in source control and include comments for each initial weight.
- No paper or live lease can be issued from stale empirical jobs, missing quant-health, or a Jangar capital hold.

Deployer acceptance:

- Before paper reentry, verify fresh empirical jobs, no Jangar capital hold, configured quant-health, duplicate signal
  quote inside threshold, and capital lease `stage=paper_probe`.
- Before live reentry, require two clean paper sessions, positive post-cost expectancy, rollback readiness, and live
  broker toggles explicitly enabled.
- A green `/db-check` is necessary but never sufficient for capital.

Open risks:

- Market prices can become opaque if weights multiply too many signals. The first version should expose every term.
- Duplicate signal groups need a source-level repair, not just a capital hold.
- Options profitability remains speculative until options feature tables are populated and bounded catalog cycles pass.
