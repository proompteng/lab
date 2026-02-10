# Backtesting and Walk-Forward (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Define a backtesting framework that is credible enough to trust for capital allocation.

## Key Requirements
- Strict out-of-sample evaluation with walk-forward splits.
- Purged splits when using overlapping labels or lookback windows.
- Transaction costs and realistic execution assumptions.
- Portfolio-level simulation (not just per-trade).

## Minimum Backtest Modes
- Unit backtests: strategy logic on fixed fixtures.
- Integration replay: Kafka replay -> TA -> ClickHouse -> trading loop (paper only).
- Offline simulator: deterministic re-run of decisions and fills with a cost model.

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

## Failure Modes
- Lookahead bias: using future bars to decide current trades.
- Survivorship bias: testing only current winners.
- Execution fantasy: fills at mid with no slippage.

## References
- Probability of backtest overfitting (PBO) and CSCV: https://scholarworks.wmich.edu/math_pubs/42/
