# Mean Reversion and Statistical Arbitrage (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Purpose

Implement controlled mean-reversion strategies that are cost-aware and regime-aware.

## Common Variants

- Intraday reversal (short horizon).
- Pairs trading / cointegration.
- Bollinger-band style reversion on z-scores.

## Why It Fails

- Regime breaks (trends) can overwhelm reversion assumptions.
- Costs dominate at high turnover.

## Torghut Implementation Sketch

- Signals:
  - z-score of returns vs rolling mean,
  - spread/volatility gating,
  - cointegration residuals for pairs.
- Controls:
  - disable in strong trend regimes,
  - strict stop-loss and max holding time.
- Execution:
  - avoid crossing wide spreads; prefer passive/near-touch limits,
  - enforce a minimum expected edge vs cost model.

## References

- Backtest overfitting risk is high for mean reversion due to many degrees of freedom: https://scholarworks.wmich.edu/math_pubs/42/
- Intraday reversal (RFS, 2025): https://www.sciencedirect.com/science/article/pii/S1386418124001669
