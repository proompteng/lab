# Evaluation, Benchmark, and Contamination Control Standard

## Status

- Doc: `v6/05`
- Date: `2026-02-27`
- Maturity: `production design`
- Scope: mandatory evaluation standard for all regime-router, DSPy, and alpha-discovery artifacts
- Implementation status: `Partial`
- Evidence:
  - `services/torghut/app/trading/autonomy/gates.py`
  - `services/torghut/app/trading/autonomy/policy_checks.py`
  - `services/torghut/app/trading/evaluation.py`
  - `services/torghut/app/trading/empirical_jobs.py`
  - `services/torghut/app/main.py`
  - `services/torghut/tests/test_profitability_evidence_v4.py`
  - `services/torghut/tests/test_trading_pipeline.py`
  - `services/torghut/tests/test_governance_policy_dry_run.py`
  - `services/torghut/tests/test_empirical_jobs.py`
  - `services/torghut/tests/test_trading_api.py`
- Rollout gap: fail-closed contamination and profitability-stage enforcement are already in-tree, but the repo still lacks authoritative empirical evidence across all benchmark, router, and Janus families; several parity artifacts remain deterministic scaffold outputs rather than promotion-authoritative evidence.

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: typed proof/readiness/repair/capital surfaces exist across API, trading, and Jangar consumer modules; contract text remains broader than runtime.
- Matched implementation area: Proof, evidence, freshness, repair, and capital gating.
- Current source evidence:
  - `services/torghut/app/api/readiness_helpers/trading_health_proof_lane.py`
  - `services/torghut/app/api/proof_floor_payloads/proof_floor_receipts.py`
  - `services/torghut/app/trading/consumer_evidence.py`
  - `services/torghut/app/trading/freshness_carry.py`
  - `services/torghut/app/trading/revenue_repair/repair_queue.py`
  - `services/jangar/src/server/control-plane-torghut-consumer-evidence.ts`
- Design drift note: Most May 2026 proof/capital docs are implemented as distributed surfaces, not single resources named after each document.


## Implementation update (2026-03-09)

This document was stale where it described the evaluation registry problem as if the control-plane enforcement surface did not exist yet.

The current repository already contains:

- profitability-stage manifest generation and hard-fail validation paths in the autonomous lane and policy checks;
- empirical job persistence/status surfacing for benchmark-style evidence production;
- operator-readable status endpoints for empirical jobs and doc29 completion gates.

The remaining gap is not basic registry existence. It is evidence authority:

- benchmark parity, foundation-router parity, and Janus-Q still include deterministic scaffold authority paths;
- those artifacts therefore cannot yet serve as fully authoritative contamination-safe promotion evidence across all families.

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
