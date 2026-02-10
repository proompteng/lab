# Time-Series Momentum and Trend Following (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Implement a robust trend strategy with strong risk controls.

## Common Variants
- Moving average crossovers (multi-horizon).
- Breakout systems (Donchian channels).
- Time-series momentum: sign(lookback return) * risk-targeted position.

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
