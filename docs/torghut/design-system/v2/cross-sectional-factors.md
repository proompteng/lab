# Cross-Sectional Factors and Multi-Asset Allocation (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Add portfolio-level strategies that allocate across symbols based on relative signals.

## Factor Ideas
- Momentum (relative strength).
- Low volatility.
- Quality/profitability (if fundamentals are available).
- Value (if fundamentals are available).

## Torghut Implementation Sketch
- Start with price-only cross-sectional momentum across a curated universe.
- Normalize signals (z-score or rank) and translate into target weights.
- Neutralize exposures if needed (sector neutral, beta neutral) as a later step.
- Apply turnover limits and position caps (avoid churn and concentration).

## Required System Work
- PortfolioAllocator (see `portfolio-and-sizing.md`).
- Better universe management (avoid survivorship bias).

## Failure Modes
- Hidden concentration: many names behave like one factor during stress.
- Turnover bleed: cross-sectional edges are often small and cost-sensitive.
- Selection bias: universe choices dominate results.

## References
- Managed futures can be seen as an allocation problem across instruments: https://www.aqr.com/Insights/Strategies/Alternative-Thinking/Managed-Futures
