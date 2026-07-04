# Time-Series Momentum and Trend Following (v2)

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

Implement a robust trend strategy with strong risk controls.

## Common Variants

- Moving average crossovers (multi-horizon).
- Breakout systems (Donchian channels).
- Time-series momentum: sign(lookback return) \* risk-targeted position.

## Why It Can Work

Trend strategies can benefit from persistence in price moves and may perform well in crisis regimes, but they can
experience long drawdowns in sideways markets.

## Torghut Implementation Sketch

- Signals:
  - multi-horizon returns (1d, 5d, 20d) and volatility,
  - trend strength score.
- Positioning:
  - volatility targeting,
  - per-symbol max risk.
- Execution:
  - limit orders with bands to avoid chasing.

## Practical Controls (To Survive Drawdowns)

- Regime gating: reduce or disable trend exposure in \"high chop\" regimes.
- Time-based stops: cap holding time for weak trends (reduce bleed).
- Portfolio constraints:
  - cap correlated exposures,
  - cap max single-name risk,
  - throttle during correlation spikes.

## Signal Notes

For equities, trend signals can be implemented on end-of-bar data (e.g., 1m/5m/daily). Ensure the backtest matches
how the signal is computed in production (no same-bar fill if the signal uses the bar close).

## References

- Time Series Momentum (foundational): https://pages.stern.nyu.edu/~lpederse/papers/TimeSeriesMomentum.pdf
- Managed futures / trend following overview: https://www.aqr.com/Insights/Strategies/Alternative-Thinking/Managed-Futures
- Trend drawdowns perspective (2024): https://www.man.com/maninstitute/why-do-trend-following-strategies-suffer-drawdowns
