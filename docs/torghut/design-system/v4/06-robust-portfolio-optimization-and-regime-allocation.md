# Robust Portfolio Optimization and Regime Allocation

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


## Objective

Add a robust portfolio allocation layer that remains stable under covariance uncertainty and regime changes, with
explicit concentration and turnover controls.

## Why This Matters

Recent robust optimization and online change-point portfolio research enables scalable allocation with stronger
worst-case guarantees than static mean-variance setups.

## Proposed Torghut Design

- Add `AllocatorV4` using distributionally robust optimization (DRO) constraints.
- Integrate online regime segmentation to switch risk budgets and turnover constraints.
- Track allocation confidence and uncertainty penalties in promotion reports.

## Owned Code and Config Areas

- `services/torghut/app/trading/portfolio.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/models/entities.py`
- `argocd/applications/torghut/strategy-configmap.yaml`

## Deliverables

- Robust allocator module with uncertainty budget controls.
- Regime segmentation integration and config schema.
- Allocation audit trail and explainability output.
- Regression tests for concentration, turnover, and fallback behavior.

## Verification

- Out-of-sample drawdown and turnover metrics improve vs baseline.
- Allocation remains inside concentration and liquidity caps.
- Regime transitions do not trigger uncontrolled reallocations.

## Rollback

- Revert to baseline allocator with static risk budgets.
- Keep regime diagnostics running for shadow analysis.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-robust-allocator-regime-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `strategyConfigPath`
  - `artifactPath`
- Expected artifacts:
  - allocator implementation,
  - regime policy config,
  - robustness backtest report.
- Exit criteria:
  - risk metrics pass gates,
  - fallback behavior verified,
  - reproducible allocation evidence stored.

## Research References

- Accelerating large-scale robust portfolio optimization: https://arxiv.org/abs/2411.02938
- Bayesian online change-point portfolio optimization: https://arxiv.org/abs/2405.04941
