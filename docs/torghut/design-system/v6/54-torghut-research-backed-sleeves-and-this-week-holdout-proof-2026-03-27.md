# 54. Torghut Research-Backed Sleeves and This-Week Holdout Proof Contract (2026-03-27)

## Status

- Date: `2026-03-27`
- Maturity: `implementation contract`
- Scope: `services/torghut/app/trading/{strategy_runtime.py,decisions.py,intraday_tsmom_contract.py,evaluation.py}`, `services/torghut/scripts/{local_intraday_tsmom_replay.py,generate_historical_profitability_manifests.py,start_historical_simulation.py,build_historical_profitability_proof.py}`, `argocd/applications/torghut/strategy-configmap.yaml`, and archive/proof artifacts under `services/torghut/artifacts/**`
- Depends on:
  - `docs/torghut/design-system/v6/05-evaluation-benchmark-and-contamination-control-standard.md`
  - `docs/torghut/design-system/v6/08-profitability-research-validation-execution-governance-system.md`
  - `docs/torghut/design-system/v6/38-authoritative-empirical-promotion-evidence-contract-2026-03-09.md`
  - `docs/torghut/design-system/v6/53-torghut-kafka-retention-bootstrap-and-archive-backed-profitability-proof-2026-03-27.md`
  - `docs/torghut/design-system/v1/historical-dataset-simulation.md`
  - `docs/torghut/design-system/v1/trading-day-simulation-automation.md`
- Implementation status: `Not started`
- Primary objective: define the research-backed multi-sleeve strategy family Torghut should test on the retained March 16 through March 27, 2026 internal window, and define an honest proof workflow for the March 23 through March 27, 2026 holdout week using only currently available internal data

## Executive summary

The current archive/proof document in doc53 answers **how Torghut must preserve and certify evidence**.

It does not answer two other questions tightly enough:

1. what sleeve family should Torghut actually test on the retained internal week; and
2. how should Torghut use the exact March 23 through March 27, 2026 ClickHouse surface without contaminating the holdout or crashing ClickHouse.

This document answers those questions.

Observed ClickHouse state on `2026-03-27`:

- retained replay-grade `ta_signals` rows where `source='ta'` and `window_size='PT1S'`:
  - `697,566` rows
  - first event `2026-03-16 12:01:38 UTC`
  - last event `2026-03-27 20:57:16 UTC`
- retained active-part totals:
  - `torghut.ta_signals`: `847,873` rows across `10` partitions, `2026-03-16` through `2026-03-27`
  - `torghut.ta_microbars`: `892,974` rows across `13` partitions, `2026-03-11` through `2026-03-27`
- March 23 through March 27, 2026 week inventory:
  - replay-grade `ta_signals` rows: `369,268`
  - active-part `ta_signals` rows: `432,286`
  - active-part `ta_microbars` rows: `369,268`
  - symbol universe: `12`
  - symbols: `AAPL`, `AMAT`, `AMD`, `AVGO`, `GOOG`, `INTC`, `META`, `MSFT`, `MU`, `NVDA`, `PLTR`, `SHOP`
- options tables in ClickHouse currently show no retained active partitions

Operational constraint:

- broad week-level aggregates on `ta_microbars`, and even some week-level symbol aggregates on `ta_signals`, fail with `MEMORY_LIMIT_EXCEEDED` on the current ClickHouse pod budget;
- therefore the proof workflow for this week must use:
  - `system.parts` partition metadata for inventory,
  - day-bounded or chunk-bounded direct reads for replay,
  - immutable archived replay bundles for repeated proof runs.

Decision:

- keep doc53 as the authoritative `>= $250/day` archive/proof program;
- use the currently retained March 16 through March 20, 2026 window as the **selection/calibration** slice;
- use March 23 through March 27, 2026 as the **untouched holdout** slice;
- treat direct ClickHouse TA replay as the **primary** simulation path for this week;
- replace the single-sleeve mindset with a research-backed, long-only, three-sleeve portfolio:
  - `momentum_pullback_long_v1`
  - `breakout_continuation_long_v1`
  - `mean_reversion_rebound_long_v1`

This document does **not** claim the target has been proven.

This document defines the only honest way to test the current retained window.

## Relationship to doc53

Doc53 remains the source of truth for:

- immutable replay bundles;
- `data_sufficiency`;
- `trial-ledger.json`;
- `statistical-validity-report.json`;
- `profitability-certificate.json`;
- the fail-closed `insufficient_history` status;
- the `>= $250/day` historical and paper promotion program.

This document is narrower.

It defines:

- the research-backed sleeve families Torghut should implement next;
- the exact March 16 through March 27, 2026 window split;
- the safe ClickHouse access pattern for this week;
- the exact this-week proof artifacts and command flow;
- the boundary between "holdout week profitable" and "promotion-grade profitable."

If this document conflicts with doc53 on promotion authority, doc53 wins.

## ClickHouse data available for the current week

### Primary simulation source for this week

For the retained March 16 through March 27, 2026 window, Torghut should simulate from the TA data already materialized
into ClickHouse.

That means:

- primary replay source for this week:
  - `torghut.ta_signals` for the current local replay script
  - `torghut.ta_microbars` as an additional source for the multi-sleeve successor when needed
- primary runner for this week:
  - `services/torghut/scripts/local_intraday_tsmom_replay.py`
  - and its multi-sleeve successor defined in this document
- Kafka is **not** the required replay starting point for this week's research loop

Kafka remains relevant only for:

- durable archive creation before retention expires;
- later proof reproducibility once ClickHouse retention moves on;
- historical simulation rebuilds when ClickHouse no longer retains the needed days.

### This-week inventory

The current retained holdout week is `2026-03-23` through `2026-03-27`.

Replay-grade `ta_signals` coverage (`source='ta'`, `window_size='PT1S'`):

| Trading day | Rows | Symbols | First event (UTC) | Last event (UTC) |
| --- | ---: | ---: | --- | --- |
| `2026-03-23` | `72,069` | `12` | `2026-03-23 12:00:10` | `2026-03-23 20:58:53` |
| `2026-03-24` | `68,020` | `12` | `2026-03-24 12:00:48` | `2026-03-24 20:59:26` |
| `2026-03-25` | `74,969` | `12` | `2026-03-25 12:00:19` | `2026-03-25 20:59:48` |
| `2026-03-26` | `82,841` | `12` | `2026-03-26 12:02:22` | `2026-03-26 20:59:56` |
| `2026-03-27` | `71,369` | `12` | `2026-03-27 12:00:19` | `2026-03-27 20:57:16` |
| **Total** | **`369,268`** | **`12`** | `2026-03-23 12:00:10` | `2026-03-27 20:57:16` |

Active parts by table for the same week:

| Trading day | `ta_signals` active-part rows | `ta_microbars` active-part rows |
| --- | ---: | ---: |
| `2026-03-23` | `92,656` | `72,069` |
| `2026-03-24` | `80,862` | `68,020` |
| `2026-03-25` | `84,392` | `74,969` |
| `2026-03-26` | `95,566` | `82,841` |
| `2026-03-27` | `78,810` | `71,369` |
| **Total** | **`432,286`** | **`369,268`** |

### Retained-window inventory

The full currently retained replay-grade `ta_signals` window is:

- `2026-03-16` through `2026-03-27`
- `697,566` filtered replay rows
- `10` trading days

The currently retained active-part `ta_signals` partitions are:

| Trading day | Rows |
| --- | ---: |
| `2026-03-16` | `89,039` |
| `2026-03-17` | `73,678` |
| `2026-03-18` | `76,304` |
| `2026-03-19` | `86,547` |
| `2026-03-20` | `90,019` |
| `2026-03-23` | `92,656` |
| `2026-03-24` | `80,862` |
| `2026-03-25` | `84,392` |
| `2026-03-26` | `95,566` |
| `2026-03-27` | `78,810` |

The available replay universe for the current retained window is:

- `AAPL`
- `AMAT`
- `AMD`
- `AVGO`
- `GOOG`
- `INTC`
- `META`
- `MSFT`
- `MU`
- `NVDA`
- `PLTR`
- `SHOP`

### Operational caveat

This week's data is real and usable, but the current ClickHouse pod does not have enough headroom for careless analytics.

Observed on `2026-03-27`:

- a grouped week query over `ta_microbars` failed with `MEMORY_LIMIT_EXCEEDED`;
- a week-level `GROUP BY symbol` over replay-grade `ta_signals` also failed with `MEMORY_LIMIT_EXCEEDED`.

Therefore the approved query pattern for this week is:

1. use `system.parts` for inventory and partition-level row counts;
2. use direct `ta_signals` reads only in day-bounded or chunk-bounded windows;
3. avoid repeated broad week aggregates on raw ClickHouse tables;
4. convert the week into archived replay bundles before repeated candidate-search loops.

## Research synthesis

### What the literature supports

The relevant literature does not support "one generic intraday rule."

It supports **separate sleeve families**:

1. **Intraday continuation / momentum**
   - The first part of the day can predict later-day continuation in highly liquid instruments, especially when volatility and participation are elevated.
   - Sources:
     - [Beat the Market: An Effective Intraday Momentum Strategy for the S&P500 ETF (SPY)](https://papers.ssrn.com/sol3/papers.cfm?abstract_id=4824172)
     - [Intraday Patterns in the Cross-section of Stock Returns](https://arxiv.org/abs/1005.3535)
2. **Short-horizon reversal after dislocation**
   - Extreme intraday price moves can mean-revert, but only if the move looks like a temporary liquidity shock rather than persistent directional flow.
   - Source:
     - [Short-term market reaction after extreme price changes of liquid stocks](https://arxiv.org/abs/cond-mat/0406696)
3. **Order-flow / imbalance-confirmed continuation**
   - Per-symbol flow and imbalance can strengthen continuation, but the sign is conditional and can reverse if the flow is broad, crowded, or already exhausted.
   - Source:
     - [Trade Co-occurrence, Trade Flow Decomposition, and Conditional Order Imbalance in Equity Markets](https://arxiv.org/abs/2209.10334)
4. **Execution realism is central**
   - A sleeve only exists if its predicted edge clears expected execution cost and risk at the time of order submission.
   - Source:
     - [Measuring and Modeling Execution Cost and Risk](https://pages.stern.nyu.edu/rengle/executioncost.pdf)
5. **Data-snooping controls are mandatory**
   - Repeatedly tuning on the same small window without correction creates false edge.
   - Sources:
     - [A Reality Check for Data Snooping](https://www.econometricsociety.org/publications/econometrica/browse/volume/2000)
     - [The Probability of Backtest Overfitting](https://www.davidhbailey.com/dhbpapers/backtest-prob.pdf)
     - [The Deflated Sharpe Ratio](https://www.davidhbailey.com/dhbpapers/deflated-sharpe.pdf)

### What Torghut should infer from that research

This is an inference from the literature plus the retained Torghut surface.

Torghut should:

- stay **long-only** for this proof lane;
- keep continuation and reversal in **separate sleeves**;
- use imbalance only as a **confirmation input**, not as a stand-alone alpha claim;
- enforce spread, extension, and volatility gates before sizing;
- treat the March 23 through March 27 week as a **frozen holdout**, not as another tuning sandbox.

## Decision

Adopt a three-sleeve proof portfolio for the retained March window:

1. `momentum_pullback_long_v1`
2. `breakout_continuation_long_v1`
3. `mean_reversion_rebound_long_v1`

All three sleeves must:

- be long-only;
- treat sell actions as exit-only;
- emit:
  - `sleeve_id`
  - `candidate_id`
  - `data_lineage_id`
  - `proof_window_id`
  - `research_family`
  - `entry_gate_id`
- be replayable from currently available `ta_signals` plus `ta_microbars`;
- be valid under chunked local replay and historical simulation manifests.

## Sleeve definitions

### 1. `momentum_pullback_long_v1`

Research family:

- intraday continuation with extension control

Purpose:

- capture continuation only when the instrument is trending up, but entry is taken on a controlled pullback instead of pure chase.

Available inputs:

- `ema12`
- `ema26`
- `macd`
- `macd_signal`
- `rsi14`
- `vol_realized_w60s`
- midpoint from `imbalance_bid_px` / `imbalance_ask_px`
- spread from `imbalance_ask_px - imbalance_bid_px`

Derived features required:

- `mid_px`
- `spread_bps`
- `price_vs_ema12_bps`
- `macd_hist`
- `session_minutes_from_open`

Entry contract:

- eligible window:
  - `14:00 UTC` through `19:15 UTC`
- trend:
  - `ema12 > ema26`
  - `macd > macd_signal`
- pullback band:
  - price is not above `ema12`
  - price is between `2` and `35` bps below `ema12`
- confirmation:
  - `macd_hist > 0`
  - `rsi14` is bullish but not exhausted
  - `vol_realized_w60s` inside configured band
- execution gate:
  - spread below sleeve cap
  - no existing long re-entry in the same direction

Exit contract:

- flatten on trend failure, spread blowout, time stop, or end of day

Implementation surfaces:

- extend or replace parts of `services/torghut/app/trading/intraday_tsmom_contract.py`
- register plugin in `services/torghut/app/trading/strategy_runtime.py`
- keep exit-only sell enforcement in `services/torghut/app/trading/decisions.py`

### 2. `breakout_continuation_long_v1`

Research family:

- momentum continuation with imbalance confirmation

Purpose:

- capture continuation only when price expansion is accompanied by favorable per-symbol bid/ask imbalance and acceptable spread.

Available inputs:

- all `momentum_pullback_long_v1` inputs
- `imbalance_bid_sz`
- `imbalance_ask_sz`
- `microstructure_signal_v1`

Derived features required:

- `imbalance_pressure = (bid_sz - ask_sz) / (bid_sz + ask_sz)`
- `spread_bps`
- `breakout_distance_bps` versus recent local high or opening range high
- `breakout_age_seconds`

Entry contract:

- eligible window:
  - `14:00 UTC` through `19:30 UTC`
- breakout:
  - price exceeds local breakout reference
  - breakout is fresh, not late and exhausted
- confirmation:
  - `imbalance_pressure` above configured floor
  - spread below sleeve cap
  - volatility inside band
  - trend still aligned (`ema12 > ema26`)
- do not enter if:
  - breakout is already overextended versus `ema12`
  - spread widens beyond cap
  - existing long exposure already fills the symbol budget

Exit contract:

- flatten on failed breakout, imbalance reversal, time stop, or end of day

Implementation surfaces:

- new plugin module under `services/torghut/app/trading/`
- metadata emission through `RuntimeDecision.metadata()` in `services/torghut/app/trading/strategy_runtime.py`
- sizing and symbol-cap enforcement in `services/torghut/app/trading/decisions.py`

### 3. `mean_reversion_rebound_long_v1`

Research family:

- shock reversal after liquidity normalization

Purpose:

- capture rebound only after a downside shock looks temporarily dislocated and then begins to normalize.

Available inputs:

- midpoint and spread
- `rsi14`
- `macd_hist`
- `vol_realized_w60s`
- `ema12`
- `vwap_session`

Derived features required:

- `shock_distance_bps` versus rolling anchor
- `rebound_reclaim_bps`
- `spread_normalized`
- `oversold_state`

Entry contract:

- eligible window:
  - `14:00 UTC` through `18:45 UTC`
- shock:
  - price has sold off sharply versus recent anchor
  - `rsi14` is oversold
  - realized volatility is elevated
- normalization:
  - spread has narrowed back below sleeve cap
  - midpoint has reclaimed above a short anchor
  - `macd_hist` is improving, not still accelerating down
- do not enter while:
  - spread remains blown out
  - price is still making new local lows

Exit contract:

- flatten at mean-reversion target, renewed downside acceleration, time stop, or end of day

Implementation surfaces:

- new plugin module under `services/torghut/app/trading/`
- execution gate wiring in `services/torghut/app/trading/decisions.py`
- cost-aware target/stop evaluation in the local replay harness

## Portfolio and allocator contract for the retained week

The week-proof portfolio must be sleeve-aware.

Allocator limits:

- max gross exposure: `1.0x` equity
- max symbol exposure: `0.20x` equity
- max sleeve exposure: `0.35x` equity
- max concurrent positions: `5`
- one active position per symbol

Pre-trade hard fails:

- no short entries
- no flat sells
- no re-entry while already long in the same sleeve direction
- no entry when spread cap fails
- no entry when symbol cap is exhausted

Important limitation:

- the currently retained ClickHouse surface does **not** provide a full marketwide participation model;
- therefore true participation-rate caps versus total consolidated tape volume are **not** available from this week alone;
- the live-capital program in doc53 must still treat marketwide participation modeling as incomplete until durable archive bundles or richer execution surfaces exist.

## This-week proof workflow

### Proof split

Use the currently retained window as:

- **selection/calibration week**: `2026-03-16` through `2026-03-20`
- **holdout week**: `2026-03-23` through `2026-03-27`

Rules:

- no threshold changes after the holdout is first touched;
- all searched candidates must be recorded in the trial ledger;
- the holdout week is only run after the candidate set is frozen.

### Required new artifacts

Add a week-proof artifact directory:

- `services/torghut/artifacts/proof-weeks/2026-03-23/`

Required files:

- `clickhouse-week-inventory.json`
- `selection-week-trial-ledger.json`
- `research-sleeve-config.lock.json`
- `holdout-week-report.json`
- `holdout-week-profitability-proof.json`
- `holdout-week-statistical-validity.json`

### Required scripts

Add:

1. `services/torghut/scripts/build_weekly_clickhouse_inventory.py`
   - outputs exact week inventory from `system.parts` plus safe direct day queries
   - never runs broad week-level raw aggregates
2. `services/torghut/scripts/local_research_sleeve_replay.py`
   - generalizes the current local replay from one sleeve to the three-sleeve portfolio
   - reuses the chunked fetch pattern from `local_intraday_tsmom_replay.py`
   - outputs per-sleeve, per-symbol, and per-day performance
3. `services/torghut/scripts/run_this_week_holdout_proof.py`
   - enforces the March 16 through March 20 selection window
   - freezes chosen candidates
   - runs the March 23 through March 27 holdout replay
   - writes the week-specific artifacts above

### Required command flow

1. Build week inventory from ClickHouse.
2. Run baseline replay on the selection week using the current production `intraday_tsmom_v1` config.
3. Search candidate grids for the three new sleeves on the selection week only.
4. Freeze the selected candidate set into `research-sleeve-config.lock.json`.
5. Replay the holdout week.
6. Only if direct ClickHouse replay becomes unusable for a required day, fall back to archived manifests or historical simulation for that day.
7. Build proof artifacts and compare against:
   - cash-flat baseline
   - current production `intraday_tsmom_v1` baseline

### Safe query contract

The local proof scripts for this week must:

- read replay data in small time chunks, not one giant week query;
- prefer `ta_signals` for replay reads;
- treat the existing TA ClickHouse tables as the default source for this week;
- use `system.parts` for row inventories;
- avoid week-level `GROUP BY symbol` and `GROUP BY trading_day` on raw `ta_microbars`;
- archive bundles after the first valid replay to avoid hitting ClickHouse repeatedly.

### Existing evidence that ClickHouse is sufficient for this week

The current week already has enough retained ClickHouse TA data to drive the local replay path:

- the retained holdout week exposes `369,268` replay-grade `ta_signals` rows across `5` trading days and `12` symbols;
- the existing `local_intraday_tsmom_replay.py` script reads ClickHouse in bounded chunks rather than one raw week scan;
- the existing `local_intraday_tsmom_replay.py` script currently reads `torghut.ta_signals` directly, not Kafka;
- that direct ClickHouse replay path has already succeeded on `2026-03-23` through `2026-03-27`.

So the operational problem for this week is **not** "Kafka must be replayed first."

The operational problem is:

- use the already materialized TA data correctly;
- avoid memory-bound analytics;
- freeze selection versus holdout;
- then archive the resulting evidence before retention expires.

## Proof semantics for this week

The only honest claim this week can support is:

- "This frozen candidate set was or was not profitable on the March 23 through March 27, 2026 holdout week after modeled costs."

This week cannot support the stronger claim:

- "`>= $250/day` has been proven for Torghut."

That stronger claim remains blocked on doc53 requirements:

- enough archived history;
- selection-bias-aware evidence;
- historical OOS gates;
- paper gates.

## Acceptance criteria

This document is implemented only when all of the following are true:

1. The week inventory script writes `clickhouse-week-inventory.json` with the exact retained March 23 through March 27 counts.
2. The multi-sleeve replay script can run on the retained week without issuing broad memory-bound ClickHouse aggregates.
3. Every decision emitted by the three sleeves includes:
   - `sleeve_id`
   - `candidate_id`
   - `data_lineage_id`
   - `proof_window_id`
4. The holdout proof runner writes:
   - `selection-week-trial-ledger.json`
   - `research-sleeve-config.lock.json`
   - `holdout-week-report.json`
   - `holdout-week-profitability-proof.json`
   - `holdout-week-statistical-validity.json`
5. Holdout reporting compares the frozen multi-sleeve portfolio against:
   - cash-flat
   - the current `intraday_tsmom_v1` baseline
6. The reporting layer explicitly marks the result as:
   - `holdout_week_positive`,
   - `holdout_week_negative`, or
   - `holdout_week_inconclusive`,
   and never upgrades it to `historical_proven` or `paper_proven`.

## Appendix: exact queries used for the live inventory snapshot

The following query classes produced the March 27 snapshot used in this document:

1. `system.parts` inventory:

```sql
SELECT table, partition AS trading_day, sum(rows) AS rows
FROM system.parts
WHERE active
  AND database = 'torghut'
  AND table IN ('ta_signals', 'ta_microbars')
  AND partition >= '2026-03-23'
  AND partition <= '2026-03-27'
GROUP BY table, trading_day
ORDER BY table, trading_day
```

2. replay-grade `ta_signals` day coverage:

```sql
SELECT
  toDate(event_ts) AS trading_day,
  count() AS rows,
  uniqExact(symbol) AS symbols,
  min(event_ts) AS first_ts,
  max(event_ts) AS last_ts
FROM torghut.ta_signals
WHERE source = 'ta'
  AND window_size = 'PT1S'
  AND event_ts >= toDateTime64('2026-03-23 00:00:00', 3, 'UTC')
  AND event_ts < toDateTime64('2026-03-28 00:00:00', 3, 'UTC')
GROUP BY trading_day
ORDER BY trading_day
```

3. retained replay universe:

```sql
SELECT DISTINCT symbol
FROM torghut.ta_signals
WHERE source = 'ta'
  AND window_size = 'PT1S'
  AND event_ts >= toDateTime64('2026-03-23 00:00:00', 3, 'UTC')
  AND event_ts < toDateTime64('2026-03-28 00:00:00', 3, 'UTC')
ORDER BY symbol
```

Broad raw `ta_microbars` aggregates were intentionally excluded from the approved proof loop because they triggered `MEMORY_LIMIT_EXCEEDED` on the current cluster state.
