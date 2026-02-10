# Portfolio Construction and Position Sizing (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Translate signals into positions in a way that is robust and scalable.

## Sizing Primitives
- Volatility targeting: size positions so risk is stable.
- Notional caps and position percent-of-equity caps.
- Correlation-aware limits (avoid hidden concentration).

## Portfolio Layer
Even if each strategy is simple, the portfolio can be sophisticated:
- allocate capital across strategies by risk budgets,
- reduce exposure when correlations spike,
- rebalance with turnover limits.

## Torghut Extensions
- Add a PortfolioAllocator stage after strategy decisions:
  - input: per-symbol decisions + confidence + risk estimates,
  - output: final sizes per symbol constrained by portfolio limits.
- Persist portfolio snapshots for attribution.

## References
- Trend following drawdown behavior is often portfolio-driven: https://www.man.com/maninstitute/why-do-trend-following-strategies-suffer-drawdowns
