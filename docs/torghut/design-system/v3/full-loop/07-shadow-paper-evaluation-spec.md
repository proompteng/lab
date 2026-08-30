# 07. Shadow and Paper Evaluation Spec

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

Define how candidate strategies are validated in shadow/paper environments before live consideration, with
champion-challenger controls and execution-quality gating.

## Evaluation Modes

- Shadow mode:
  - candidate produces intents but no orders.
  - compare against champion and hypothetical fills.
- Paper mode:
  - candidate submits paper orders through full runtime path.
  - collect real execution-policy and reconciliation behavior.

## Champion-Challenger Protocol

- champion remains active baseline.
- challenger runs with bounded risk budget.
- compare by regime, symbol, and cost-adjusted metrics.

## Minimum Evaluation Window

- duration configured by strategy class and turnover profile.
- must include at least one high-volatility and one normal regime segment.

## Required Metrics

- net PnL after modeled costs,
- drawdown and tail loss,
- turnover and participation,
- TCA metrics (shortfall/slippage/churn),
- decision stability and rejection causes.

## Promotion Decision Logic

- challenger passes only if it beats champion on risk-adjusted objectives without violating risk/capacity constraints.
- ambiguous outcomes require extended window or return to research.

## Agent Implementation Scope (Significant)

Workstream A: runtime mode controls

- implement shadow/paper toggles and artifact routing.

Workstream B: comparison engine

- implement champion-challenger comparator and regime slicing.

Workstream C: reporting and dashboards

- produce comparative reports and dashboard-ready outputs.

Workstream D: gate integration

- feed outcomes into gate policy matrix.

Owned areas:

- `services/torghut/app/trading/scheduler.py`
- `services/torghut/app/trading/reporting.py`
- `services/torghut/scripts/**`
- `services/torghut/tests/**`

Minimum deliverables:

- shadow/paper mode config,
- comparison report generator,
- telemetry metrics integration,
- promotion-ready report schema.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-shadow-paper-run-v1`.
- Required keys:
  - `torghutNamespace`
  - `gitopsPath`
  - `strategyConfigPatchPath`
  - `evaluationWindow`
- Exit criteria:
  - shadow and paper workflows produce comparable reports,
  - gate evaluator consumes report outputs,
  - promotion recommendation deterministically reproducible.
