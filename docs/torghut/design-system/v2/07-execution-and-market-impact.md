# Execution and Market Impact (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Improve fills and reduce slippage while maintaining strict safety.

## Execution Modes
- Market (use rarely, strict slippage caps).
- Limit with price bands.
- TWAP/VWAP style slicing for larger orders.
- Participation-of-volume (POV) with caps.

## Execution Safety Controls
- Hard max slippage (bps) vs recent price snapshot.
- Max order rate per symbol.
- Cancel/replace throttles.
- Market hours and halt awareness.

## Torghut Extensions
- Introduce an ExecutionPlanner that outputs a schedule of child orders.
- Store child order intent and link to parent decision hash.

## References
- RL for optimal execution (2025 survey): https://arxiv.org/abs/2508.06535
- Optimal execution with impact (foundational): https://docslib.org/doc/1384720/optimal-execution-of-portfolio-transactions
