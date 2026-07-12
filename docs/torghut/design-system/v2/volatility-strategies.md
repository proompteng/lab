# Volatility Strategies and Volatility Targeting (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: strategy/alpha/discovery/profile modules and tests exist, but research strategy proposals are not all promoted runtime strategies.
- Matched implementation area: Strategy, alpha, TSMOM, regime, portfolio, and sizing.
- Current source evidence:
  - `services/torghut/app/strategies/catalog.py`
  - `services/torghut/app/trading/alpha/tsmom.py`
  - `services/torghut/app/trading/strategy_runtime`
  - `services/torghut/app/trading/discovery/candidate_specs.py`
  - `services/torghut/app/trading/portfolio`
- Design drift note: A research/stress module is not enough to call a strategy live; promotion still depends on proof/readiness gates.


## Purpose

Control risk in a way that increases robustness across regimes.

## Practical Approaches Without Options

- Volatility targeting (scale positions to keep vol stable).
- Drawdown-based de-risking.
- Correlation-aware risk budgets.
- Shock response: if realized vol spikes above a threshold, reduce exposure quickly (with hysteresis).

## Optional (If Options Added Later)

- Volatility carry and hedging overlays.

## Torghut Implementation Sketch

- Compute realized volatility per symbol and for the portfolio.
- Scale target exposures each rebalance tick.
- Persist the vol estimates used for each sizing decision (audit + reproducibility).

## References

- Trend drawdowns and volatility dynamics often co-move: https://www.man.com/maninstitute/why-do-trend-following-strategies-suffer-drawdowns
