# Profitability Discipline (Reality Checklist)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Purpose

Define the discipline required to build a trading system that can be both autonomous and profitable over time.

This document focuses on what makes systems fail in practice: overfitting, hidden transaction costs, regime breaks,
unsafe scaling, and silent production drift.

## What "Profitable" Means Operationally

A profitable autonomous system is one that:

- Has positive expectancy after realistic costs.
- Maintains acceptable drawdowns for its mandate.
- Survives regime changes via risk controls and adaptive allocation.
- Produces audit-grade evidence explaining where PnL came from.

## Core Loop (Research -> Production)

- Hypothesis: define the edge source (behavioral, structural, microstructure).
- Dataset: define training, validation, and strict out-of-sample.
- Backtest: include realistic fills, spreads, slippage, and latency assumptions.
- Robustness: walk-forward, stress tests, parameter sensitivity.
- Paper: shadow and/or paper trading with full logging.
- Live: slow ramp with hard limits and kill switches.

## Minimum "Go Live" Evidence

- Stability under walk-forward:
  - Similar performance distribution across folds.
  - No single period dominates total PnL.
- Cost realism:
  - PnL remains positive under pessimistic transaction cost multipliers.
- Capacity check:
  - Estimated impact grows slower than expected edge.
- Operational safety:
  - Verified kill switch cancels open orders and blocks new submissions.

## Torghut Extensions Required

- Stronger transaction cost model (see `transaction-cost-and-capacity.md`).
- Execution quality improvements (see `execution-and-market-impact.md`).
- Regime-aware risk throttles (see `regime-detection.md`).
- Always-on, reproducible decision store (inputs + outputs) for attribution.

## Common Profit-Killers

- Data leakage (lookahead, survivorship bias, using revised data).
- Implicit fill assumptions (market orders at mid).
- Neglecting borrow costs, fees, and shortability.
- Ignoring trading halts and market hours.
- Strategy overlap (correlated alphas) leading to hidden concentration.

## Implementation Notes (Torghut)

- Encode "profitability gates" as deterministic controls:
  - Max daily loss, max drawdown, max order rate.
  - Staleness gates for signals and prices.
  - Degrade modes (paper only, no new positions, flatten).
- Store enough data to perform daily attribution:
  - decision -> execution -> fill -> position snapshot -> PnL decomposition.

## References

- Managed futures / trend following overview: AQR Managed Futures page: https://www.aqr.com/Insights/Strategies/Alternative-Thinking/Managed-Futures
- US Market Access Rule (risk management controls): SEC 15c3-5 summary: https://www.sec.gov/rules-regulations/2011/06/risk-management-controls-brokers-or-dealers-market-access
