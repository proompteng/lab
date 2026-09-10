# Priority 1: TSFM Router, Refinement, and Uncertainty-Aware Forecasting

## Status

- Implementation status: `Partial` (core router implemented; full design deliverables not strictly verified end-to-end as of 2026-02-21)

## Objective

Build a production forecasting layer that routes each symbol/horizon to the best-performing time-series model family,
optionally applies forecast refinement, and emits calibrated uncertainty that downstream gates can enforce.

## Problem Statement

Current signal flow is strategy-centric and feature-centric, but not model-family adaptive. Performance and robustness
vary by symbol, horizon, and regime. A single static forecaster leaves measurable edge on the table and can degrade
during shifts.

## Scope

### In Scope

- model family routing by symbol, horizon, and regime bucket,
- refinement stage for selected forecasts,
- probabilistic output contract (`point`, `interval`, `epistemic`, `aleatoric`),
- deterministic fallback to baseline model when calibration or runtime SLO fails,
- auditability of routing decisions.

### Out of Scope

- fully autonomous model retraining in live runtime,
- direct execution decisions from model output without existing policy chain,
- replacing existing deterministic strategies in one cutover.

## Target Architecture

### Components

1. `ForecastRouterV5`

- chooses model adapter using `symbol`, `horizon`, `regime_label`, and latest calibration score.
- route policy stored in versioned config.

2. `ForecastAdapter` family

- `chronos_adapter`
- `moment_adapter`
- `financial_tsfm_adapter` (for fine-tuned finance variants)

3. `ForecastRefinerV5`

- optional refinement step (bridge-style transport update) when configured and healthy.

4. `ForecastCalibrationStore`

- stores rolling calibration metrics per route key.

5. `ForecastDecisionAudit`

- immutable record for each route decision and fallback reason.

### Runtime Flow

1. receive normalized feature vector.
2. compute route key (`symbol`, `horizon`, `regime`).
3. select adapter from route policy + health score.
4. generate point + interval forecast.
5. optionally run refinement.
6. emit structured forecast contract.
7. pass to uncertainty gate and existing strategy/evaluation path.

## Data Contracts

### Forecast Output Contract (`forecast_contract_v1`)

```json
{
  "schema_version": "forecast_contract_v1",
  "symbol": "AAPL",
  "horizon": "5m",
  "event_ts": "2026-02-21T14:35:00Z",
  "model_family": "chronos",
  "model_version": "chronos-ft-fin-v1",
  "route_key": "AAPL|5m|trend",
  "point_forecast": 194.32,
  "interval": { "p05": 193.95, "p50": 194.32, "p95": 194.77 },
  "uncertainty": { "epistemic": 0.12, "aleatoric": 0.21 },
  "calibration_score": 0.93,
  "fallback": { "applied": false, "reason": null }
}
```

### Route Policy Contract (`forecast_router_policy_v1`)

- key: `symbol_glob + horizon + regime`
- fields:
  - `preferred_model_family`
  - `candidate_fallbacks`
  - `min_calibration_score`
  - `max_inference_latency_ms`
  - `disable_refinement`

## Torghut Integration Points

- `services/torghut/app/trading/features.py`
  - extend normalized features with forecast-ready inputs and route tags.
- `services/torghut/app/trading/evaluation.py`
  - ingest `forecast_contract_v1`; compute route-level quality metrics.
- `services/torghut/app/trading/autonomy/gates.py`
  - add route-health gate checks (`calibration`, `latency`, `fallback_rate`).
- `services/torghut/app/trading/autonomy/runtime.py`
  - wire router into runtime signal path.
- `argocd/applications/torghut/strategy-configmap.yaml`
  - route-policy + thresholds.

## Deterministic Safety Controls

- hard fallback to deterministic baseline when:
  - adapter error,
  - latency SLO breach,
  - calibration score below threshold,
  - interval fields missing/invalid.
- fallback behavior is deterministic and logged with reason code.
- no bypass around existing risk, execution policy, or kill switch.

## Metrics, SLOs, and Alerts

### Core Metrics

- `forecast_router_inference_latency_ms{model_family}`
- `forecast_router_fallback_total{reason}`
- `forecast_calibration_error{model_family,symbol,horizon}`
- `forecast_route_selection_total{model_family,route_key}`

### SLOs

- p95 inference latency <= 200ms (paper), <= 120ms (live candidate path).
- route-level calibration error <= configured bound for promotion.
- fallback rate <= 5% per trading hour for live-eligible routes.

### Alerts

- sustained fallback rate > threshold for 3 windows.
- calibration degradation for any live-enabled route key.
- route policy checksum drift vs expected ConfigMap revision.

## Validation Plan

### Offline

- rolling walk-forward by symbol/horizon/regime.
- compare baseline vs routed/refined forecasts on:
  - error metrics,
  - directional hit rate,
  - cost-aware paper PnL impact.

### Paper/Shadow

- dual-run baseline and router outputs.
- require non-inferiority on tail-risk and superiority on net-after-cost objectives.

### Promotion Gates

- 3 consecutive trading days with gate pass in paper.
- no critical alert during gate window.
- reproducibility hash match across replay.

## Failure Modes and Mitigations

- regime misclassification causes poor route choice:
  - mitigation: conservative default route + route lock timeout.
- overconfident uncertainty estimates:
  - mitigation: gate-level coverage checks and abstain/degrade path.
- model drift after retrain:
  - mitigation: canary route keys and instant fallback toggle.

## Rollback Plan

- `FORECAST_ROUTER_ENABLED=false` routes all forecasts to deterministic baseline.
- preserve audit and metrics in shadow for diagnostics.
- rollback target: < 5 minutes via config rollout.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v5-tsfm-router-refinement-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `strategyConfigPath`
  - `evaluationWindow`
  - `artifactPath`
- Expected artifacts:
  - router and adapter modules,
  - route policy schema + config,
  - migration/audit schema,
  - replay and benchmark report.
- Exit criteria:
  - calibration and latency SLOs met in paper,
  - deterministic fallback coverage tests pass,
  - gate integration proven with no bypass.

## References

- [1] Chronos: Learning the Language of Time Series. arXiv:2403.07815. https://arxiv.org/abs/2403.07815
- [2] MOMENT: A Family of Open Time-series Foundation Models. arXiv:2402.03885. https://arxiv.org/abs/2402.03885
- [3] Re(Visiting) Time Series Foundation Models in Finance. arXiv:2511.18578. https://arxiv.org/abs/2511.18578
- [4] RefineBridge: Generative Bridge Models Improve Financial Forecasting by Foundation Models. arXiv:2512.21572. https://arxiv.org/abs/2512.21572
- [5] ProbFM: Probabilistic Time Series Foundation Model with Uncertainty Decomposition. arXiv:2601.10591. https://arxiv.org/abs/2601.10591
- [6] FinZero: Launching Multi-modal Financial Time Series Forecast with Large Reasoning Model. arXiv:2509.08742. https://arxiv.org/abs/2509.08742
