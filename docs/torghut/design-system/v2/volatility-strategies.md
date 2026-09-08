# Volatility Strategies and Volatility Targeting (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

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
