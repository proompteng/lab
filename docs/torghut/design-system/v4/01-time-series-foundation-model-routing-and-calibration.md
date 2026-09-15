# Time-Series Foundation Model Routing and Calibration

## Status

- Implementation status: `Partial` (core routing/calibration paths implemented; full deliverable set not strictly verified end-to-end as of 2026-02-21)

## Objective

Add a model-routing layer that chooses between deterministic alpha models and time-series foundation models, with hard
calibration gates before any strategy can influence paper/live decisions.

## Why This Matters

Recent foundation-model papers show strong zero-shot and transfer behavior for time series, but they can be brittle
under market regime shifts unless uncertainty calibration and fallback routing are enforced.

## Proposed Torghut Design

- Add `ForecastRouterV4` in Torghut to route symbol/horizon requests to:
  - legacy deterministic forecaster,
  - Chronos-family adapter,
  - MOMENT/TiRex adapter.
- Add per-model calibration profiles (coverage error, interval width, drift score).
- Fail closed to deterministic baseline when calibration thresholds degrade.
- Persist model-selection and calibration decisions for audit and replay.

## Owned Code and Config Areas

- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/autonomy.py`
- `services/torghut/app/models/entities.py`
- `argocd/applications/torghut/strategy-configmap.yaml`

## Deliverables

- `ForecastRouterV4` and adapters for at least two foundation model families.
- Calibration gate module with configurable thresholds.
- DB schema updates for per-model calibration and routing audit rows.
- Backfill/replay tool to compare baseline vs routed model outcomes.

## Verification

- Offline replay on rolling windows with deterministic seeds.
- Coverage and error metrics must exceed baseline by configured margin.
- Calibration gate denial paths must be tested and observable.

## Rollback

- Single config switch to route all forecasts to deterministic baseline.
- Keep model adapters loaded but non-authoritative for shadow diagnostics.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-forecast-routing-calibration-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `strategyConfigPath`
  - `evaluationWindow`
- Expected artifacts:
  - router + calibration modules,
  - migration + audit schema,
  - replay and comparison report.
- Exit criteria:
  - calibration SLOs pass in paper/shadow,
  - deterministic fallback verified,
  - no risk-gate bypass paths.

## Research References

- Chronos: https://arxiv.org/abs/2403.07815
- Chronos-2: https://arxiv.org/abs/2506.03109
- MOMENT: https://arxiv.org/abs/2402.03885
- TiRex: https://arxiv.org/abs/2508.19141
