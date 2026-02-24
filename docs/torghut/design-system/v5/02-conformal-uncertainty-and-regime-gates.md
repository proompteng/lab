# Priority 2: Conformal Uncertainty and Regime-Shift Gates

## Objective

Introduce a production uncertainty control plane that enforces calibrated prediction intervals, detects regime shifts,
and deterministically abstains or degrades trading when calibration fails.

## Problem Statement

Model confidence is currently not enforced as a first-class promotion and runtime gate. Under market change points,
point forecasts can remain directionally plausible while calibration quality collapses, leading to oversized and
poorly-timed trades.

## Scope

### In Scope

- conformal interval engine for per-symbol/horizon coverage control,
- temporal/change-point aware recalibration policies,
- abstain/degrade gate outcomes wired into autonomy and sizing,
- calibration SLOs and alerting with runbook actions.

### Out of Scope

- replacing all model families,
- discretionary/manual overrides in code path,
- live auto-retraining without approval gates.

## Target Architecture

### Components

1. `ConformalEngineV5`

- computes prediction sets from model residual history.
- supports rolling and weighted windows.

2. `ShiftDetectorV5`

- monitors residual distribution drift and change-point indicators.
- emits `shift_state` with severity.

3. `CalibrationGateV5`

- evaluates coverage error, interval sharpness, and shift severity.
- returns deterministic action: `pass`, `degrade`, `abstain`, `fail`.

4. `RecalibrationOrchestrator`

- schedules recalibration tasks and writes artifact chain.

### Gate Decision Policy

- `pass`: normal routing/sizing.
- `degrade`: reduce max notional and require higher confidence.
- `abstain`: skip new entries, allow risk-reducing exits.
- `fail`: block promotion and trigger rollback to baseline mode.

## Data Contracts

### Calibration Snapshot (`calibration_snapshot_v1`)

```json
{
  "schema_version": "calibration_snapshot_v1",
  "symbol": "MSFT",
  "horizon": "5m",
  "window_start": "2026-02-21T13:00:00Z",
  "window_end": "2026-02-21T14:00:00Z",
  "target_coverage": 0.9,
  "observed_coverage": 0.86,
  "coverage_error": 0.04,
  "avg_interval_width": 0.72,
  "shift_state": "elevated",
  "shift_score": 0.63,
  "gate_action": "degrade"
}
```

### Gate Output Extension

Add to autonomy gate payload:

- `uncertainty_gate_action`
- `coverage_error`
- `shift_score`
- `recalibration_run_id`

## Torghut Integration Points

- `services/torghut/app/trading/evaluation.py`
  - implement conformal statistics and calibration snapshots.
- `services/torghut/app/trading/autonomy/gates.py`
  - add uncertainty gate stage and deterministic action mapping.
- `services/torghut/app/trading/portfolio.py`
  - apply degrade multipliers and abstain constraints.
- `services/torghut/app/trading/autonomy/runtime.py`
  - ensure gate action is applied before decision execution.
- `docs/torghut/design-system/v3/full-loop/02-gate-policy-matrix.md`
  - add uncertainty gate policy envelope.

## Deterministic Safety Rules

- if uncertainty fields are missing or invalid, default to `abstain`.
- no live/paper promotion when calibration SLO fails.
- uncertainty gate cannot be bypassed by LLM advisory output.

## Metrics, SLOs, and Alerts

### Metrics

- `calibration_coverage_error{symbol,horizon}`
- `conformal_interval_width{symbol,horizon}`
- `uncertainty_gate_action_total{action}`
- `regime_shift_score{symbol,horizon}`
- `recalibration_runs_total{status}`

### SLOs

- `|observed_coverage - target_coverage| <= 0.03` over rolling live-eligibility window.
- abstain/degrade actions must be logged at 100% rate.
- recalibration completion latency <= 15 minutes for paper pipelines.

### Alerts

- 3 consecutive windows with coverage error > threshold.
- shift score sustained high while gate action remains `pass`.
- failed recalibration pipeline or missing artifact chain.

## Verification Plan

### Offline

- historical replay with synthetic and real change-point segments.
- validate empirical coverage and false-abstain rate.

### Paper

- run baseline vs conformal-gated path.
- evaluate net-after-cost performance and drawdown tails.

### Promotion Criteria

- calibration SLO pass for 3+ trading days in paper.
- no unresolved critical uncertainty alerts.
- reproducible recalibration artifacts available for audit.

## Failure Modes and Mitigations

- under-coverage during volatility spike:
  - mitigation: widen intervals + force degrade.
- over-wide intervals causing strategy paralysis:
  - mitigation: cap abstain rate and trigger model investigation lane.
- stale residual buffers:
  - mitigation: hard staleness checks, fail closed.

## Rollback Plan

- set `UNCERTAINTY_GATE_MODE=observe` to stop blocking promotions while keeping telemetry.
- set `UNCERTAINTY_GATE_ENABLED=false` only as emergency fallback with explicit incident record.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v5-conformal-uncertainty-gates-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `gateConfigPath`
  - `evaluationWindow`
  - `artifactPath`
- Expected artifacts:
  - conformal engine + shift detector,
  - gate policy extensions,
  - recalibration job and reports,
  - replay validation output.
- Exit criteria:
  - target coverage SLO achieved,
  - deterministic abstain/degrade behavior validated,
  - gate integration blocks unsafe promotion paths.

## References

- [1] Flow-based Conformal Prediction for Multi-dimensional Time Series. arXiv:2502.05709. https://arxiv.org/abs/2502.05709
- [2] Conformal Prediction for Time-series Forecasting with Change Points. arXiv:2509.02844. https://arxiv.org/abs/2509.02844
- [3] Temporal Conformal Prediction (TCP): A Distribution-Free Statistical and Machine Learning Framework for Adaptive Risk Forecasting. arXiv:2507.05470. https://arxiv.org/abs/2507.05470
- [4] ProbFM: Probabilistic Time Series Foundation Model with Uncertainty Decomposition. arXiv:2601.10591. https://arxiv.org/abs/2601.10591
