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
- \"No chase\" rules: if market moves away beyond a band, cancel instead of crossing the spread repeatedly.
- Participation caps (per symbol and portfolio) to keep impact bounded.

## Torghut Extensions

- Introduce an ExecutionPlanner that outputs a schedule of child orders.
- Store child order intent and link to parent decision hash.
- Persist realized slippage (decision price vs average fill) to calibrate the cost model.

## ExecutionPlanner MVP (Sane Defaults)

- Prefer passive or near-touch limits in normal liquidity.
- Escalate aggressiveness only when the strategy edge is time-sensitive and the cost model allows it.
- Use timeouts and stepwise bands instead of continuous repricing.

## References

- RL for optimal execution (2025 survey): https://arxiv.org/abs/2508.06535
- 100x more data improves RL for optimal execution (2025): https://arxiv.org/abs/2505.20271
- Optimal execution with impact (foundational): https://docslib.org/doc/1384720/optimal-execution-of-portfolio-transactions
