# Backtesting and Walk-Forward (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Purpose

Define a backtesting framework that is credible enough to trust for capital allocation.

## Key Requirements

- Strict out-of-sample evaluation with walk-forward splits.
- Purged splits when using overlapping labels or lookback windows, plus an embargo window.
- Transaction costs and realistic execution assumptions.
- Portfolio-level simulation (not just per-trade).

## Split Hygiene (Avoid Leakage)

When labels depend on future outcomes (common in finance), you must prevent overlap between training examples and the
labeling horizon of test examples.

Minimum rules:

- Purge any training samples whose label horizon overlaps the test fold.
- Apply an embargo buffer after the test fold to prevent subtle leakage (market reaction / delayed effects).
- Freeze feature definitions and preprocessing for the full out-of-sample period.

## Minimum Backtest Modes

- Unit backtests: strategy logic on fixed fixtures.
- Integration replay: Kafka replay -> TA -> ClickHouse -> trading loop (paper only).
- Offline simulator: deterministic re-run of decisions and fills with a cost model.

## Simulator Scope (What \"Realistic\" Means)

At minimum, the simulator must account for:

- spread costs (aggressive vs passive),
- partial fills and time-in-force behavior,
- latency / bar-close vs next-bar fills (no same-bar fill if signal is computed at bar close),
- slippage bands that scale with volatility,
- cancel/replace throttles,
- market hours and halts (equities).

## Walk-Forward Protocol

- Train window: fit parameters (if any) and calibrate cost model.
- Validation window: select variants with multiple-testing correction.
- Test window: frozen selection, report results.

## Torghut Extensions

- Add a replay harness that can:
  - ingest historical events into Kafka with correct keys,
  - run TA and materialize features into ClickHouse,
  - run trading loop in "simulate" mode where the execution engine uses a fill simulator.
- Persist all inputs used by the backtest so results are reproducible.

Suggested v2 interfaces:

- `ExecutionAdapter`:
  - `submit(order_intent) -> simulated_execution`
  - `reconcile() -> updates`
- `CostModel`:
  - `estimate_cost(order_intent, market_snapshot) -> (expected_cost_bps, worst_case_cost_bps)`

## Failure Modes

- Lookahead bias: using future bars to decide current trades.
- Survivorship bias: testing only current winners.
- Execution fantasy: fills at mid with no slippage.

## References

- Data snooping / specification search: https://www.econometricsociety.org/publications/econometrica/2000/09/01/reality-check-data-snooping
- Probability of backtest overfitting (PBO) and CSCV: https://scholarworks.wmich.edu/math_pubs/42/
- Deflated Sharpe Ratio (selection bias correction): https://www.pm-research.com/content/iijpormgmt/40/5/94
