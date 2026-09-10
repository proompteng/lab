# Event-Driven Synthetic Market and Offline Policy Lab

## Objective

Create a high-fidelity synthetic market lab for Torghut to pretrain and stress autonomous policies before paper/live
exposure.

## Why This Matters

Recent event-driven simulation and diffusion-based financial data generation work enables broader stress coverage than
historical replay alone, especially for rare-liquidity and volatility regimes.

## Proposed Torghut Design

- Add `MarketSimV4` module with two generators:
  - event-driven Neural Hawkes simulation,
  - diffusion-style path generation for stress scenarios.
- Use generated scenarios to pretrain candidate policies offline.
- Add simulation provenance hashing so every promotion decision can reference exact synthetic datasets.

## Owned Code and Config Areas

- `services/torghut/app/trading/backtest.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/scripts/run_autonomous_lane.py`
- `docs/torghut/design-system/v3/full-loop/06-backtest-realism-standard.md`

## Deliverables

- Synthetic market generator interfaces and dataset registry.
- Scenario taxonomy (liquidity shock, spread blowout, volatility clustering).
- Offline policy pretraining and evaluation pipeline.
- Promotion reports including synthetic-stress metrics.

## Verification

- Generated scenario statistics match configured constraints.
- Offline-trained policy must beat baseline in robustness metrics.
- Reproducibility check: identical seed yields identical scenario bundles.

## Rollback

- Disable synthetic pretraining for promotion while keeping generators for diagnostics.
- Fall back to historical replay-only gate set.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-synthetic-market-lab-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `artifactPath`
  - `datasetRegistryPath`
- Expected artifacts:
  - generator modules,
  - scenario catalog,
  - offline policy evaluation report.
- Exit criteria:
  - reproducible synthetic bundles,
  - improved robustness gates,
  - no uncontrolled promotion path.

## Research References

- Event-based LOB simulation via Neural Hawkes: https://arxiv.org/abs/2502.17417
- CoFinDiff (IJCAI 2025): https://www.ijcai.org/proceedings/2025/1040
- Market Making without Regret: https://arxiv.org/abs/2411.13993
