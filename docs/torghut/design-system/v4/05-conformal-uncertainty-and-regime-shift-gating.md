# Conformal Uncertainty and Regime-Shift Gating

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

Introduce conformal uncertainty envelopes and shift-aware recalibration gates so Torghut can reject low-confidence
forecasts and degrade safely when market regimes shift.

## Why This Matters

Recent conformal forecasting papers for multivariate and shifted time-series show practical ways to maintain calibrated
prediction intervals under non-stationarity.

## Proposed Torghut Design

- Add `ConformalGateV4` stage between feature generation and strategy execution.
- Compute per-symbol predictive intervals and empirical coverage drift.
- Add change-point aware recalibration trigger and abstain policy.
- Use uncertainty scores as first-class gate signals in promotion decisions.

## Owned Code and Config Areas

- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/autonomy.py`
- `services/torghut/app/trading/features.py`
- `docs/torghut/design-system/v3/full-loop/02-gate-policy-matrix.md`

## Deliverables

- Conformal interval engine and calibration monitor.
- Shift-detection and automatic recalibration workflow.
- Gate-policy extensions for abstain/degrade states.
- Dashboards and alerts for coverage drift.

## Verification

- Coverage metrics hold near configured target ranges.
- Regime-shift replay triggers recalibration and safe degradation.
- No live/paper promotion when calibration SLO fails.

## Rollback

- Force deterministic abstain on symbols failing coverage checks.
- Disable conformal-driven promotion while keeping diagnostics.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-conformal-regime-gates-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `gateConfigPath`
  - `evaluationWindow`
- Expected artifacts:
  - conformal modules,
  - gate config updates,
  - drift/recalibration reports.
- Exit criteria:
  - stable coverage under replay,
  - shift-aware degradation validated,
  - promotion guardrails enforced.

## Research References

- Flow-based conformal prediction for MTS: https://arxiv.org/abs/2502.05709
- Conformal prediction under change-point shifts: https://arxiv.org/abs/2509.02844
- Temporal conformal prediction for uncertainty: https://arxiv.org/abs/2507.05470
