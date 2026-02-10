# Reinforcement Learning (RL) in Trading and Execution (v2)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Describe where RL can be useful, and where it is often a trap.

## Where RL Has A Clearer Fit
- Optimal execution (choosing slicing and aggressiveness under constraints).
- Inventory control problems (market making), if the environment is realistic.

## Where RL Is Risky
- Direct "trade the market" policies without credible simulators.
- Overfitting to historical paths with poor generalization.

## Torghut Approach
- Use RL first for execution policy selection, not alpha discovery.
- Keep RL behind deterministic safety:
  - RL proposes, risk engine approves.

## Simulator Requirement (Why Most RL Trading Fails)
If the environment does not model:
- partial fills,
- slippage and spreads,
- impact under participation,
- latency and queue priority,
then RL agents will learn a policy that exploits simulator artifacts, not the market.

Treat RL outputs as a proposal that must survive the same cost model and risk firewall as any other execution plan.

## References
- RL for optimal execution (2025 survey): https://arxiv.org/abs/2508.06535
- Deep RL for technical analysis and trading systems (ACM, 2025): https://dl.acm.org/doi/10.1145/3731899
- 100x more data improves RL for optimal execution (2025): https://arxiv.org/abs/2505.20271
- RLHF for trading (2025): https://arxiv.org/abs/2506.02830
