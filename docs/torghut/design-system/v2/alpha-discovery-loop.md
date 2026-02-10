# Alpha Discovery Loop (From Research To Production)

## Status
- Version: `v2`
- Last updated: **2026-02-10**

## Purpose
Define an engineering workflow that increases the probability that a discovered edge is real, persists out-of-sample,
and survives production costs and operational constraints.

This document is not a promise of profitability. It is a discipline and a set of gates.

## Definition: "Alpha" (Operational)
Alpha is not "a good backtest". For Torghut, alpha is:
- positive expectancy after realistic costs,
- stable performance across walk-forward folds,
- capacity that is non-trivial for the target notional,
- behavior that can be explained and reproduced.

## The Loop
1. Hypothesis
- Edge source and why it might persist (behavioral, structural, microstructure).
- Failure modes and expected regime behavior.

2. Data + Feature Contract
- Define features and timestamps.
- Enforce parity: online and offline use the same definitions.

3. Backtest (First Pass)
- Conservative fills and costs.
- No same-bar fill if the signal is computed at bar close.

4. Robustness
- Walk-forward + purged splits + embargo.
- Parameter sensitivity (no razor-thin optimum).
- Stress tests:
  - cost multipliers,
  - volatility spikes,
  - liquidity drought.

5. Paper / Shadow Production
- Run in paper with full audit logging.
- If an intelligence layer is used, run it in shadow mode first.

6. Promotion
- Increase risk budgets slowly.
- Require explicit change control for any step towards live.

## Gating Criteria (Suggested)
### Statistical
- Multiple-testing aware reporting (deflated Sharpe or reality-check style constraints).
- No single period dominates lifetime PnL.

### Cost realism
- Profit remains positive under pessimistic cost bands.
- Slippage model calibrated using paper/live fills when available.

### Capacity
- Participation constraints satisfied for the intended universe.
- Exposure constraints prevent concentration.

### Operational
- Order firewall exists (single executor with broker creds).
- Kill switch can cancel open orders and block new ones.
- Reconciliation lag and data freshness gates are enforced.

## Role Of LLM/Agent Systems
Use LLMs primarily for:
- research workflow acceleration (idea -> code -> backtest),
- structured review of decisions (approve/veto/adjust) within tight bounds,
- operational automation via GitOps PRs.

Do not use LLMs as:
- an unrestricted decision-maker,
- a component with broker credentials,
- a system that can pull arbitrary external text into the trading prompt.

## Torghut Deliverables For This Loop
- Research ledger (all runs + variants tested + data versions + results).
- Replay/sim harness (deterministic reproduction).
- Cost model MVP integrated into backtest, risk, and execution.
- Portfolio allocator and regime throttles.

## References
- Backtest validity: `docs/torghut/design-system/v2/backtesting-and-walkforward.md`
- Overfitting controls: `docs/torghut/design-system/v2/overfitting-and-statistical-validity.md`
- Cost model: `docs/torghut/design-system/v2/transaction-cost-and-capacity.md`
