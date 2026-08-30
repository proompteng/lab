# Limit-Order-Book Intelligence and Feature Stack

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented and evolved: execution route/gate/status modules exist, with live submission controlled by scheduler and submission-council gates.
- Matched implementation area: Execution, live submission, and broker path.
- Current source evidence:
  - `services/torghut/app/trading/execution_runtime.py`
  - `services/torghut/app/trading/execution_adapters/adapter_types.py`
  - `services/torghut/app/trading/execution_policy/order_rules.py`
  - `services/torghut/app/trading/submission_council/__init__.py`
  - `services/torghut/app/trading/scheduler/pipeline/submission_policy.py`
- Design drift note: Old monolithic order executor/live path claims are stale; current source uses split execution/runtime/gate modules.


## Objective

Upgrade Torghut microstructure intelligence from TA-heavy inputs to a hybrid feature stack that includes limit-order-book
state features and order-flow imbalance signals.

## Why This Matters

New LOB modeling papers show that richer microstructure features can improve short-horizon prediction and execution
quality, but only when feature freshness and quality gates are strict.

## Proposed Torghut Design

- Introduce `OrderBookFeatureVectorV4` with:
  - top-k level imbalance,
  - queue dynamics,
  - spread and depth elasticity,
  - short-horizon signed flow statistics.
- Build a feature-quality gate for missing levels, stale timestamps, and malformed depth snapshots.
- Keep existing TA features and add compatibility mappers for dual-mode strategies.

## Owned Code and Config Areas

- `services/dorvud/technical-analysis-flink/**`
- `services/torghut/app/trading/features.py`
- `services/torghut/app/trading/ingest.py`
- `docs/torghut/schemas/ta-signals.avsc`
- `argocd/applications/torghut/ta/configmap.yaml`

## Deliverables

- New LOB-derived feature schema and mappers.
- Flink-side extraction path and ClickHouse persistence.
- Torghut ingestion path with strict validation.
- Regression tests and parity reports against legacy features.

## Verification

- Freshness/quality gate pass rates per symbol/session.
- Backtest uplift in fill-adjusted PnL and slippage metrics.
- Zero schema drift incidents during replay tests.

## Rollback

- Disable LOB feature consumption via feature flag.
- Continue producing LOB features in shadow for diagnostics.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v4-lob-feature-stack-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `taSchemaPath`
  - `flinkConfigPath`
- Expected artifacts:
  - schema changes,
  - extraction/ingest implementation,
  - parity and quality reports.
- Exit criteria:
  - gate stability achieved for paper sessions,
  - deterministic fallback confirmed,
  - no ingestion regressions.

## Research References

- HLOB paper page: https://www.sciencedirect.com/science/article/pii/S0957417425011210
- Dilated Conv + Transformer + MTL for stocks: https://arxiv.org/abs/2509.00696
- TCSMI model for financial prediction: https://arxiv.org/abs/2507.08093
