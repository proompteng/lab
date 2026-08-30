# Torghut Profit Promotion Parameter Rationale - 2026-05-19

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


## Purpose

This note records the promotion parameter set for the `$500/day` Torghut profit objective. The goal is not to make
promotion impossible; it is to allow ordinary down days while blocking candidates whose apparent edge depends on
oversized drawdowns, one-off best days, hidden leverage, negative cash, synthetic proof, or unexecuted replay.

## Source-backed constraints

- `AlgoXpert Alpha Research Framework` (2026-03-10, <https://arxiv.org/abs/2603.09219>) is the closest promotion
  process template: it separates in-sample, walk-forward, and strict out-of-sample stages; prefers stable parameter
  regions over single optima; uses purge gaps; and includes catastrophic vetoes, spread/leverage guards, circuit
  breakers, and kill switches.
- `Interpretable Hypothesis-Driven Trading` (2025-12-15, <https://arxiv.org/abs/2512.12924>) validates market
  microstructure hypotheses across 34 independent test periods with transaction costs and position constraints. Its
  modest returns and low drawdown are a useful warning: honest intraday validation should favor reproducibility and
  downside control over headline backtest PnL.
- `TradeFM: A Generative Foundation Model for Trade-flow and Market Microstructure` (2026-02-27,
  <https://arxiv.org/abs/2602.23784>) supports scale-invariant microstructure representations and simulator-based
  stress testing, but its generated rollouts are research/stress inputs. They must not become promotion authority
  without real replay and shadow evidence.
- `A novel approach to trading strategy parameter optimization using double out-of-sample data and walk-forward
  techniques` (2026-02-11, <https://arxiv.org/abs/2602.10785>) supports walk-forward parameter search, independent
  out-of-sample evaluation, conservative fees, and cost sensitivity. Torghut promotion should therefore use post-cost
  net PnL and should not promote from a single optimized in-sample window.
- `Stochastic Price Dynamics in Response to Order Flow Imbalance` (2025-05-23,
  <https://arxiv.org/abs/2505.17388>) supports horizon- and regime-dependent treatment of order-flow signals. Torghut
  should keep regime-slice pass rate as a hard promotion gate and should test continuation/reversal hypotheses by
  replay horizon.
- `Returns and Order Flow Imbalances` (2025-08-09, revised 2025-10-08, <https://arxiv.org/abs/2508.06788>) shows
  one-second intraday price-flow dynamics change materially around macro announcements and liquidity/spread conditions.
  Torghut should treat news timing, liquidity state, and spread state as execution and regime gates.
- `Hidden Order in Trades Predicts the Size of Price Moves` (2025-12-02, <https://arxiv.org/abs/2512.15720>)
  supports information-theoretic order-flow state as a volatility/magnitude signal, not standalone directional proof.
  Torghut should use this kind of feature as a regime or opportunity filter, then require directional replay evidence.
- `Explainable Patterns in Cryptocurrency Microstructure` (2026-01-31, <https://arxiv.org/abs/2602.00776>) supports
  portable order-book/trade feature libraries, but also shows maker/taker behavior can diverge under stress. Torghut
  should keep executable replay and cost-stress checks separate from signal ranking.

## Promotion parameter set

The active `$500/day` program should use these default promotion gates:

| Gate | Value | Rationale |
| --- | ---: | --- |
| `target_net_pnl_per_day` | `500` | Objective is post-cost daily portfolio net PnL, not cumulative paper PnL. |
| `min_profit_factor` | `1.50` | Provides a loss cushion after slippage/fees and prevents barely-positive churn from passing. |
| `min_active_day_ratio` | `0.90` | Avoids candidates that hit the target by trading only one or two lucky days. |
| `min_positive_day_ratio` | `0.60` | Allows down days while requiring repeatability across the window. |
| `max_best_day_share` | `0.25` | Prevents a single best day from explaining most of the edge. |
| `max_cluster_contribution_share` | `0.40` | Prevents one mechanism or cluster from dominating portfolio proof. |
| `max_single_symbol_contribution_share` | `0.35` | Prevents a single ticker from carrying portfolio promotion. |
| `max_worst_day_loss_pct_equity` | `0.05` | Normal worst-day loss cap. |
| `extended_max_worst_day_loss_pct_equity` | `0.08` | Allowed only when total net PnL covers drawdown by at least `3.00x`. |
| `max_drawdown_pct_equity` | `0.08` | Normal max drawdown cap. |
| `extended_max_drawdown_pct_equity` | `0.12` | Allowed only when total net PnL covers drawdown by at least `3.00x`. |
| `min_total_net_pnl_to_drawdown_ratio` | `3.00` | Return-adjusted exception for good candidates with tolerable drawdown. |
| `max_worst_day_loss` | `999999999` | Absolute cap disabled by default; percentage-of-equity gate is canonical. |
| `max_drawdown` | `999999999` | Absolute cap disabled by default; percentage-of-equity gate is canonical. |
| `max_gross_exposure_pct_equity` | `1.0` | No hidden leverage for promotion. |
| `min_cash` | `0` | Negative cash blocks promotion. |
| `max_negative_cash_observation_count` | `0` | Any negative-cash observation blocks promotion. |
| `min_avg_filled_notional_per_day` | `300000` | Requires enough executable activity to make `$500/day` plausible after costs. |
| `min_regime_slice_pass_rate` | `0.45` | Keeps regime dependence visible instead of averaging it away. |
| `shadow_parity_status` | `within_budget` | Runtime path must match replay budget before promotion. |
| `executable_replay_passed` | `true` | Candidate must produce executable replay proof. |

## Next harness gates

The current promotion parameter set is the immediate gate. The next harness improvement should add explicit
walk-forward and cost-stress authority:

- Require at least `5` walk-forward folds when the replay window has enough history.
- Freeze parameters after candidate selection; no post-selection retuning before live-paper promotion.
- Require base post-cost expectancy to stay positive under a `50%` transaction-cost shock.
- Reject sharp single-cell parameter optima by checking neighboring parameter-surface stability.
- Add bootstrap or Monte Carlo reorder evidence and require the lower confidence bound to stay above zero before
  promoting beyond shadow.

## Operational interpretation

Down days are acceptable. The promotion blocker is not a red day; it is an oversized red day, excessive peak-to-trough
drawdown, or concentration that makes the observed `$500/day` look like luck or leverage. Synthetic/model-generated
evidence may rank or stress candidates, but promotion authority requires real replay, executable order proof, shadow
parity, and post-cost ledger semantics.
