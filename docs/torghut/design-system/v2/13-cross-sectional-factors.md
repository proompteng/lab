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
- Normalize signals, cap exposures, and apply turnover limits.

## Required System Work
- PortfolioAllocator (see `08-portfolio-and-sizing.md`).
- Better universe management (avoid survivorship bias).

## References
- Managed futures can be seen as an allocation problem across instruments: https://www.aqr.com/Insights/Strategies/Alternative-Thinking/Managed-Futures
