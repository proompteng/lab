# Backtesting, Walk-Forward, and Research Ledger

## Status

- Implementation status: `Completed (strict)` (verified with code + tests + runtime/config on 2026-02-21)

## Objective

Establish a statistically defensible, reproducible research-to-promotion pipeline that controls overfitting and records
all promotion evidence as immutable artifacts.

## Existing Baseline

Current assets:

- walk-forward harness: `services/torghut/app/trading/evaluation.py`
- minimal trade evaluation utilities: `services/torghut/app/trading/backtest.py`
- TSMOM baseline research module: `services/torghut/app/trading/alpha/tsmom.py`

Gap:

- existing harness is useful but lacks full promotion ledger, purged CV controls, and explicit multiple-testing gates.

## Three-Layer Research Pipeline

### Layer 1: hypothesis filtering (fast)

- run broad sweeps with vectorized tooling (vectorbt/NumPy).
- output candidate configs and confidence intervals.
- no promotion decisions at this layer.

### Layer 2: realistic simulation

- replay on Torghut-compatible event/feature contracts.
- include conservative cost model and fill assumptions.
- generate fold-level and regime-level metrics.

### Layer 3: promotion validation

- purged walk-forward splits with embargo.
- stress scenarios (spread, volatility, liquidity shocks).
- multiple-testing correction diagnostics.

## Required Promotion Metrics

- net PnL after costs.
- max drawdown.
- turnover and participation.
- fold stability and cross-symbol consistency.
- deflated Sharpe or equivalent overfit diagnostic.
- execution-quality proxy metrics (simulated TCA).

## Research Ledger Design

New persistent entities (Postgres):

- `research_runs`
- `research_candidates`
- `research_fold_metrics`
- `research_stress_metrics`
- `research_promotions`

Minimum fields per run:

- strategy id/type/version.
- parameter hash.
- dataset snapshot hash and date range.
- feature schema version.
- cost model version.
- code commit SHA.
- tool/library versions.
- metric outputs and gate outcomes.

## Reproducibility Contract

A research run is promotable only if:

- raw inputs are versioned and addressable,
- feature extraction code version is pinned,
- decision logic version is pinned,
- rerun reproduces metrics within tolerance.

## Statistical Guardrails

- no in-sample only promotions.
- minimum number of folds per strategy family.
- reject razor-thin parameter peaks (fragility checks).
- stress tests must preserve positive expectancy under pessimistic costs.

## External Literature Anchors

- Moskowitz, Ooi, Pedersen (2012) time-series momentum.
- Hurst, Ooi, Pedersen (2017) century of trend following.
- Moreira, Muir (2016) volatility managed portfolios.
- White (2000) reality check for data snooping.
- Bailey, Lopez de Prado deflated Sharpe framing.

## Outputs and Artifacts

Per promotion candidate run:

- markdown report,
- machine-readable metrics JSON,
- fold plots and risk plots,
- gate decision summary,
- immutable run metadata row.

## Integration with LEAN and Qlib

- LEAN: cross-engine benchmark validation for promoted candidates.
- Qlib: optional alpha generation lane feeding candidates into Torghut validation pipeline.
- Torghut promotion decision remains based on Torghut-compatible replay + ledger evidence.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-research-ledger-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `outputPath`
  - `researchDbMigrationPath`
- Expected execution:
  - add ledger schema migrations,
  - extend evaluation harness with purged walk-forward and stress suite,
  - emit structured artifacts,
  - add promotion gate evaluator.
- Expected artifacts:
  - migration files,
  - updated research scripts,
  - tests validating reproducibility and gates.
- Exit criteria:
  - at least one candidate can run through full pipeline end-to-end,
  - rerun reproducibility check passes,
  - promotion decision generated from ledger evidence.
