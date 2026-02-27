# Evaluation, Benchmark, and Contamination Control Standard

## Status

- Doc: `v6/05`
- Date: `2026-02-27`
- Maturity: `production design`
- Scope: mandatory evaluation standard for all regime-router, DSPy, and alpha-discovery artifacts

## Objective

Define the evaluation framework that prevents false confidence from leakage or data contamination and enforces comparable, promotion-grade evidence.

## Core Principle

No model, prompt, or strategy artifact can be promoted without contamination-safe forward evaluation and reproducibility checks.

## Evaluation Standard

### Temporal integrity

- Strict train/validation/test ordering.
- No feature or textual source created after decision timestamp.
- Explicit embargo windows around split boundaries.

### Leakage controls

- Timestamp normalization to UTC and event-time semantics.
- Data-source lineage logged per feature and prompt context item.
- Automatic rejection of artifacts that fail lineage completeness.

### Regime-balanced coverage

- Evaluate across trending, mean-reverting, high-volatility, and crisis regimes.
- Require minimum decision counts per regime bucket.

### Cost realism

- Include slippage, spread, queue-position uncertainty, fees, and partial-fill behavior.
- Compare simulated versus realized metrics continuously post-promotion.

## Benchmark Set

Required baselines for each strategy family:

1. static TSMOM baseline,
2. best-single-expert static baseline,
3. regime-adaptive weighted baseline,
4. deterministic no-LLM baseline for decision layer,
5. current production artifact baseline.

## Promotion Gate Metrics

Minimum metrics for eligibility:

- schema validity,
- reproducibility hash match,
- out-of-sample Sharpe and drawdown thresholds,
- calibration and uncertainty metrics,
- deterministic gate compatibility,
- fallback and timeout rates within budget.

## Required Artifacts per Eval Run

- `dataset_manifest.json`
- `split_manifest.json`
- `metrics_report.json`
- `failure_analysis.json`
- `reproducibility_bundle.json`

## CI and Enforcement

- Eval schema checks are blocking in CI.
- Promotion job fails closed on missing artifacts.
- Pyright, unit tests, and integration tests remain mandatory for touched components.

## Operational Monitoring

Post-promotion monitors:

- live-vs-backtest drift,
- calibration drift,
- fallback-rate drift,
- regime-coverage drift,
- realized slippage drift.

If drift exceeds policy, auto-hold promotion queue and optionally auto-rollback current candidate.

## Exit Criteria

1. All promotion decisions reference full eval artifact bundle.
2. No artifact can bypass temporal integrity checks.
3. Drift monitors are active and tied to incident/runbook actions.
