# Reinforcement Learning (RL) in Trading and Execution (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


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
