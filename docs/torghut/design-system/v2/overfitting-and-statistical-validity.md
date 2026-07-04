# Overfitting and Statistical Validity (v2)

## Status

- Version: `v2`
- Last updated: **2026-02-10**

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


## Purpose

Make overfitting hard by default.

## Multiple-Testing Reality

If you try hundreds of variants (symbols, parameters, features), the best backtest is often a false positive.

## Controls

- Pre-register strategy families and limit degrees of freedom.
- Use walk-forward with purging/embargo.
- Track the total number of variants tested.
- Prefer simpler strategies until proven otherwise.
- Use selection-bias adjustments for reported Sharpe/metrics (deflated Sharpe).
- Use data-snooping controls when searching over many variants (reality check / bootstrap).

## Metrics To Report

- Distribution across folds, not just a single Sharpe.
- Drawdown statistics, tail risk, and worst-case period behavior.
- Turnover and cost sensitivity.
- Performance under pessimistic cost multipliers (e.g., 2x spread, +X bps slippage).
- Concentration and correlation stress (e.g., max single-name exposure, corr spikes).

## Torghut Extensions

- Store a "research ledger" (runs, parameters, code hash, data versions, results).
- Build CI gates for strategy changes:
  - unit tests,
  - deterministic replay smoke tests,
  - minimum risk constraints.

## References

- Data snooping / specification search: https://www.econometricsociety.org/publications/econometrica/2000/09/01/reality-check-data-snooping
- Probability of backtest overfitting (PBO): https://scholarworks.wmich.edu/math_pubs/42/
- Deflated Sharpe Ratio (selection bias correction): https://www.pm-research.com/content/iijpormgmt/40/5/94
