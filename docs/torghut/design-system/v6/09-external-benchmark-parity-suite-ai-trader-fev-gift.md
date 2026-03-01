# External Benchmark Parity Suite (AI-Trader, fev-bench, GIFT-Eval)

## Status

- Doc: `v6/09`
- Date: `2026-03-01`
- Maturity: `production design`
- Scope: external benchmark parity contract for Torghut validation and promotion gates
- Implementation status: `Planned`
- Evidence:
  - `docs/torghut/design-system/v6/09-external-benchmark-parity-suite-ai-trader-fev-gift.md` (design-level contract)
- Rollout gap: current evaluation artifacts do not yet include explicit parity reports against modern public financial-agent benchmark families.

## Objective

Define a mandatory benchmark parity layer so Torghut candidate promotion is evaluated against current external standards for:

1. trading decision quality,
2. financial reasoning fidelity,
3. temporal event and regime forecasting reliability.

## Why This Is Required

Internal backtests alone are insufficient for promotion confidence.
External parity checks reduce blind spots and help detect policy drift, overfitting, and benchmark gaming.

## Benchmark Families and Coverage

### Family A: Trading Decision Benchmark (AI-Trader style)

Purpose:

- assess end-to-end decision quality under realistic market context and action constraints.

Required coverage:

- directional decision quality,
- risk-aware abstention quality,
- trade policy compliance under stress slices,
- latency-aware decision stability.

### Family B: Financial Reasoning Benchmark (GIFT-Eval style)

Purpose:

- assess financial domain reasoning quality and factual reliability for LLM-assisted advisory paths.

Required coverage:

- factual consistency,
- citation/provenance coverage,
- contradiction and hallucination rate,
- schema-valid recommendation quality.

### Family C: Event Forecast Benchmark (fev-bench style)

Purpose:

- assess temporal event forecasting and regime-shift anticipation relevant to trading risk.

Required coverage:

- event horizon calibration quality,
- lead/lag sensitivity,
- distribution-shift robustness,
- confidence calibration.

## Canonical Artifact Contract

Every candidate must produce:

`<artifact_path>/benchmarks/benchmark-parity-report-v1.json`

Required fields:

- `schema_version` = `benchmark-parity-report-v1`
- `candidate_id`
- `baseline_candidate_id`
- `benchmark_runs`
  - `ai_trader_like`
  - `gift_eval_like`
  - `fev_bench_like`
- `scorecards`
  - `decision_quality`
  - `reasoning_quality`
  - `event_forecast_quality`
- `overall_parity_status` (`pass|fail`)
- `degradation_summary`
- `artifact_hash`
- `created_at_utc`

Each benchmark run must include:

- `dataset_ref`
- `window_ref`
- `metrics`
- `slice_metrics`
- `policy_violations`
- `run_hash`

## Minimum Promotion Metrics

Required floor checks:

1. schema-valid advisory output rate `>= 99.5%`.
2. deterministic gate compatibility `pass`.
3. policy violation rate not worse than current production baseline.
4. fallback/timeout budgets within configured threshold.
5. no critical degradation in stress slices.

Required degradation checks:

- candidate must not degrade more than configured margin versus production baseline in:
  - adverse-regime decision quality,
  - risk veto alignment,
  - confidence calibration error.

## Statistical Validity Binding

Benchmark parity is necessary but not sufficient.
Promotion still requires passing:

- contamination-safe split controls,
- PBO limits,
- DSR limits,
- reproducibility hash checks.

## Data and Leakage Controls

1. benchmark datasets must have explicit timestamp lineage.
2. no benchmark item may contain future information relative to decision time.
3. benchmark construction and labeling logic must be versioned and hashable.
4. benchmark suite refresh must preserve reproducible historical versions.

## Operational Monitoring

Post-promotion benchmark drift monitor:

- run scheduled parity checks against latest production baseline,
- raise incident when parity drops below threshold for two consecutive windows,
- hold promotion queue until parity is restored or rollback is executed.

## Owned Code and Config Areas

- `services/torghut/app/trading/evaluation.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/trading/llm/dspy_compile/workflow.py`
- `services/torghut/scripts/run_autonomous_lane.py`
- `config/trading/llm/dspy-metrics.yaml`
- `argocd/applications/torghut/autonomy-gate-policy-configmap.yaml`

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v6-benchmark-parity-suite-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `artifactPath`
  - `candidateId`
  - `baselineCandidateId`
  - `benchmarkDatasetRef`
  - `metricsPolicyRef`
- Expected artifacts:
  - benchmark parity report,
  - per-family scorecards,
  - promotion gate decision patch with parity checks,
  - drift monitor wiring notes.
- Exit criteria:
  - parity suite runs in CI and AgentRun lanes,
  - candidate and baseline compared end-to-end,
  - promotion fails closed on missing or failing parity artifacts.

## Verification Plan

1. Unit tests for benchmark report schema and required-field hard failures.
2. Integration tests for candidate-vs-baseline parity pipeline.
3. Regression tests for fail-closed gate behavior when parity report is absent.
4. Drift-monitor simulation tests to validate queue hold and rollback triggers.

## Rollback Plan

1. disable candidate promotions requiring parity exceptions,
2. roll back to last candidate with passing parity report,
3. keep benchmark collection active for incident diagnosis.

## Research References

- AI-Trader benchmark: https://arxiv.org/abs/2512.10971
- GIFT-Eval: https://arxiv.org/abs/2410.10393
- fev-bench: https://arxiv.org/abs/2509.26468
- QuantAgent: https://arxiv.org/abs/2509.09995
