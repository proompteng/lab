# DeepLOB + BDLOB Microstructure Intelligence and Execution Integration

## Status

- Doc: `v6/11`
- Date: `2026-03-01`
- Maturity: `production design`
- Scope: production contract for integrating DeepLOB and BDLOB-style microstructure signals into Torghut prediction and execution policy
- Implementation status: `Planned`
- Evidence:
  - `docs/torghut/design-system/v6/11-deeplob-bdlob-microstructure-intelligence.md` (design-level contract)
- Rollout gap: Torghut has partial execution and regime controls but no production-ready DeepLOB/BDLOB feature-model-policy contract with fail-closed rollout.

## Objective

Add high-quality order-book intelligence with strict freshness, quality, and execution-safety constraints so short-horizon alpha is measured after realistic costs.

## Non-Negotiable Rules

1. no LOB model inference without feature-quality pass.
2. no execution policy update without deterministic risk-gate compatibility.
3. all microstructure outputs must be lineage-tagged and replayable.
4. stale or malformed LOB snapshots force defensive fallback.

## Architecture Contract

### Data Layer

Required inputs:

- level-2 depth snapshots,
- top-k queue and imbalance dynamics,
- spread and depth elasticity,
- short-horizon signed order-flow statistics.

Feature-quality checks:

1. max snapshot staleness,
2. missing-level thresholds,
3. timestamp monotonicity,
4. schema completeness and range sanity.

### Model Layer

Model roles:

- `DeepLOBAdapter`: short-horizon directional probability.
- `BDLOBAdapter`: Bayesian uncertainty and confidence intervals.

Combined output contract:

`microstructure_signal_v1`

Required fields:

- `schema_version` = `microstructure_signal_v1`
- `symbol`
- `horizon`
- `direction_probabilities`
- `uncertainty_band` (`low|medium|high`)
- `expected_spread_impact_bps`
- `expected_slippage_bps`
- `feature_quality_status` (`pass|fail`)
- `artifact`
  - `model_id`
  - `feature_schema_version`
  - `training_run_id`

### Policy Layer

Execution integration:

1. use microstructure uncertainty to adjust participation cap.
2. throttle urgency when uncertainty is high.
3. abstain or reduce notional on adverse-selection risk spikes.
4. pass final decision through deterministic policy and risk gates.

## Canonical Artifact Set

`<artifact_path>/microstructure/deeplob-bdlob-report-v1.json`

Required fields:

- `schema_version` = `deeplob-bdlob-report-v1`
- `candidate_id`
- `feature_quality_summary`
- `prediction_quality_summary`
- `execution_impact_summary`
- `cost_adjusted_outcomes`
- `fallback_summary`
- `overall_status` (`pass|fail`)

Required supporting artifacts:

- `lob-feature-quality-report.json`
- `microstructure-model-metrics.json`
- `tca-divergence-report.json`
- `risk-gate-compatibility-report.json`

## Promotion Gate Requirements

Mandatory checks:

1. feature-quality pass rate above threshold.
2. cost-adjusted edge not below deterministic baseline.
3. realized-vs-simulated slippage divergence within threshold.
4. deterministic gate compatibility `pass`.
5. fallback reliability meets SLO.

Any failure triggers:

- promotion block,
- forced defensive fallback,
- incident artifact publication.

## Owned Code and Config Areas

- `services/dorvud/technical-analysis-flink/**`
- `services/torghut/app/trading/ingest.py`
- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/forecasting.py`
- `services/torghut/app/trading/execution_policy.py`
- `services/torghut/app/trading/tca.py`
- `services/torghut/app/trading/autonomy/gates.py`
- `services/torghut/app/trading/autonomy/policy_checks.py`
- `docs/torghut/schemas/ta-signals.avsc`
- `argocd/applications/torghut/ta/configmap.yaml`

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v6-deeplob-bdlob-microstructure-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `artifactPath`
  - `taSchemaPath`
  - `featurePolicyRef`
  - `evaluationWindow`
- Expected artifacts:
  - LOB feature extraction and validation patches,
  - DeepLOB and BDLOB adapter contracts,
  - microstructure report bundle and gate integration.
- Exit criteria:
  - feature-quality gate is enforced and tested,
  - cost-adjusted benchmark comparison exists,
  - fail-closed fallback path is verified in integration tests.

## Verification Plan

1. Unit tests for feature-quality gate thresholds and fail-close behavior.
2. Integration tests for model output schema, uncertainty bands, and policy adjustments.
3. Replay tests for cost-adjusted PnL and slippage divergence.
4. Regression tests proving no bypass of deterministic risk gates.

## Rollback

1. disable microstructure model consumption via policy flag,
2. continue collecting LOB features in shadow mode,
3. revert to deterministic execution policy profile.

## Research References

- DeepLOB: https://arxiv.org/abs/1808.03668
- BDLOB: https://arxiv.org/abs/1811.10041
