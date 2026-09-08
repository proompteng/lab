# Portfolio Construction and Position Sizing (v2)

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

## PortfolioAllocator MVP (Implementation Notes)

Inputs (minimum):

- per-symbol directional signal (buy/sell/hold) and a confidence/strength score,
- per-symbol volatility estimate,
- current positions and equity/buying power.

Constraints (minimum):

- max notional per trade and per symbol,
- max position pct equity per symbol,
- max gross exposure and max single-sector (optional),
- turnover limit (do not churn).

Output:

- target position or order intent per symbol (post-risk, post-constraints).

## References

- Trend following drawdown behavior is often portfolio-driven: https://www.man.com/maninstitute/why-do-trend-following-strategies-suffer-drawdowns
