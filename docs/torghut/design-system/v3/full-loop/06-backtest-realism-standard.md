# 06. Backtest Realism Standard

## Source Implementation Audit (2026-07-04)

- Source baseline inspected: `6473f3ee7 ci(arc): fit ten lab runners per node (#11877)`.
- Implementation status: Partially implemented: historical simulation, replay, Lean backtest APIs, and local replay scripts exist, but older monolithic simulation assumptions have been split.
- Matched implementation area: Simulation, replay, backtesting, and Lean.
- Current source evidence:
  - `services/torghut/scripts/run_local_simple_lane_replay.py`
  - `services/torghut/scripts/verify_historical_simulation_parity.py`
  - `services/torghut/app/api/trading_misc/lean_backtests.py`
  - `services/jangar/src/routes/api/torghut/simulation/runs.ts`
  - `argocd/applications/torghut/historical-simulation-workflowtemplate.yaml`
- Design drift note: Simulation docs must be checked against current split scripts and Jangar simulation routes.


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
