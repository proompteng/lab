# 06. Backtest Realism Standard

## Objective
Define minimum realism requirements so backtests approximate production behavior and avoid inflated strategy quality.

## Realism Requirements
- execution lag between signal and order simulation,
- spread-aware pricing,
- partial fill simulation,
- transaction costs and slippage,
- participation constraints,
- strategy cooldown and risk clipping effects.

## Fill Model Requirements
- support market/limit/stop behavior with deterministic rules.
- no perfect fill assumptions under adverse spread/volatility.
- include reject/cancel outcomes when constraints trigger.

## Cost Model Requirements
- base fee component,
- spread crossing cost,
- volatility-adjusted slippage,
- turnover-sensitive penalty.

## Stress Scenario Suite
Required scenarios:
- spread x2 and x3,
- volatility spike,
- liquidity drought,
- delayed market data,
- order rejection bursts.

## Evaluation Outputs
- baseline metrics,
- stress metrics,
- fragility summary,
- confidence band summary.

## Anti-Overfit Rules
- purged walk-forward splits,
- parameter sensitivity checks,
- multiple-testing adjustment,
- reject narrow peak strategies.

## Agent Implementation Scope (Significant)
Workstream A: simulator improvements
- implement realistic fill/cost behavior in evaluation path.

Workstream B: scenario harness
- add stress scenario runners and report generators.

Workstream C: command-line workflow
- provide repeatable CLI for baseline + stress runs.

Workstream D: validation tests
- add deterministic fixture tests for all realism rules.

Owned areas:
- `services/torghut/app/trading/backtest.py`
- `services/torghut/app/trading/costs.py`
- `services/torghut/app/trading/evaluation.py`
- `services/torghut/scripts/run_walkforward.py`

Minimum deliverables:
- realism-enabled simulator,
- stress suite,
- report outputs,
- regression tests.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-backtest-robustness-v1`.
- Required keys:
  - `datasetSnapshotId`
  - `strategyId`
  - `strategyVersion`
  - `costModelVersion`
  - `artifactPath`
- Exit criteria:
  - realism checks pass,
  - stress suite outputs generated,
  - promotion gates consume realism outputs.
