# Priority 3: Microstructure Execution Intelligence (Hawkes + Friction-Aware Policy)

## Objective

Improve realized trading performance by making execution policy explicitly microstructure-aware, using simulator-backed
calibration, friction-aware decisioning, and deterministic protections against adverse selection.

## Problem Statement

Signal quality can be positive while net performance degrades from slippage, shortfall, and churn. Existing execution
logic has policy checks and TCA, but it does not yet use a model-driven microstructure state and simulation loop for
continuous policy calibration.

## Scope

### In Scope

- microstructure state features for execution policy,
- simulator-backed TCA benchmarking and drift monitoring,
- friction-aware regime-conditioned execution controls,
- deterministic throttles for spread shocks and liquidity compression.

### Out of Scope

- high-frequency market-making replacement of current core strategy engine,
- venue-specific colocation optimizations,
- any direct bypass of risk/kill-switch flow.

## Target Architecture

### Components

1. `MicrostructureStateV5`

- real-time state from spread, depth, imbalance, fill hazard, and latency proxy features.

2. `ExecutionPolicyAdvisorV5`

- computes recommended order type, urgency tier, and participation ceiling.
- recommendation remains bounded by deterministic execution policy.

3. `SimulatorBackedTCAService`

- runs deterministic Hawkes-driven LOB simulations to estimate expected shortfall distributions.
- compares simulated distribution to realized fills for drift detection.

4. `FrictionRegimeController`

- applies FR-LUX style regime-conditioned constraints on participation and turnover budget.

### Decision Flow

1. build `MicrostructureStateV5` from incoming market + internal fills.
2. compute advisor output.
3. intersect advisor output with hard deterministic constraints in `execution_policy.py`.
4. execute with provenance fields.
5. update TCA and simulator divergence metrics.

## Data Contracts

### Microstructure State (`microstructure_state_v1`)

```json
{
  "schema_version": "microstructure_state_v1",
  "symbol": "NVDA",
  "event_ts": "2026-02-21T14:41:00Z",
  "spread_bps": 3.8,
  "depth_top5_usd": 1745000,
  "order_flow_imbalance": 0.24,
  "latency_ms_estimate": 42,
  "fill_hazard": 0.61,
  "liquidity_regime": "normal"
}
```

### Execution Recommendation (`execution_advice_v1`)

- `urgency_tier`: `low|normal|high`
- `max_participation_rate`
- `preferred_order_type`
- `quote_offset_bps`
- `adverse_selection_risk`

### TCA Divergence (`tca_divergence_v1`)

- `expected_shortfall_bps_p50/p95`
- `realized_shortfall_bps`
- `divergence_bps`
- `simulator_version`

## Torghut Integration Points

- `services/torghut/app/trading/execution_policy.py`
  - add advisor input contract and bounded integration.
- `services/torghut/app/trading/tca.py`
  - add simulator divergence metrics.
- `services/torghut/app/trading/risk.py`
  - add adverse-selection risk checks.
- `services/torghut/app/trading/execution.py`
  - persist execution-advice provenance metadata.
- `services/torghut/app/trading/features.py`
  - add microstructure feature extraction helpers.

## Deterministic Safety Controls

- execution approval still requires existing deterministic checks.
- advisor cannot increase risk limits, only tighten or suggest less aggressive action.
- if advisor data is stale/missing, fallback to baseline execution policy.

## Metrics, SLOs, and Alerts

### Metrics

- `execution_slippage_bps{symbol,strategy}`
- `execution_shortfall_notional{symbol,strategy}`
- `execution_adverse_selection_flag_total{symbol}`
- `tca_simulator_divergence_bps{symbol}`
- `execution_policy_override_total{reason}`

### SLOs

- reduce average slippage bps versus baseline by configured target in paper.
- p95 divergence between simulator and realized shortfall within tolerance.
- 100% provenance on execution advice application.

### Alerts

- divergence exceeds threshold for consecutive windows.
- adverse-selection flags spike while participation remains high.
- advisor recommendation stream stale beyond timeout.

## Verification Plan

### Offline

- replay execution decisions with historical microstructure snapshots.
- validate slippage and shortfall deltas vs baseline policy.

### Paper

- split-book style comparison: baseline vs advisor-bounded execution.
- evaluate net-after-cost PnL, shortfall tails, and fill rate.

### Promotion Criteria

- stable improvement in cost-adjusted outcomes across regimes.
- no increase in critical risk incidents.
- deterministic override behavior validated by tests.

## Failure Modes and Mitigations

- simulator miscalibration leads to false confidence:
  - mitigation: divergence-based guardrail and periodic recalibration.
- advisor overreacts to transient spread spikes:
  - mitigation: hysteresis on regime transitions and capped response slope.
- performance overhead increases latency:
  - mitigation: low-latency feature cache and timeout-based fallback.

## Rollback Plan

- disable advisor with `EXECUTION_ADVISOR_ENABLED=false`.
- keep divergence and TCA telemetry active for diagnostics.
- retain schema compatibility with baseline execution path.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v5-microstructure-execution-intelligence-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `riskConfigPath`
  - `artifactPath`
  - `evaluationWindow`
- Expected artifacts:
  - microstructure state module,
  - advisor integration patch,
  - simulator-backed TCA pipeline,
  - validation report and gate evidence.
- Exit criteria:
  - cost and slippage targets pass in paper,
  - deterministic policy precedence proven,
  - fallback behavior tested under timeout/staleness faults.

## References

- [1] FR-LUX: Friction-Aware, Regime-Conditioned Policy Optimization for Implementable Portfolio Management. arXiv:2510.02986. https://arxiv.org/abs/2510.02986
- [2] A Deterministic Limit Order Book Simulator with Hawkes-Driven Order Flow. arXiv:2510.08085. https://arxiv.org/abs/2510.08085
- [3] Diffusive Limit of Hawkes Driven Order Book Dynamics With Liquidity Migration. arXiv:2511.18117. https://arxiv.org/abs/2511.18117
- [4] Explainable Patterns in Cryptocurrency Microstructure. arXiv:2602.00776. https://arxiv.org/abs/2602.00776
- [5] Resolving Latency and Inventory Risk in Market Making with Reinforcement Learning. arXiv:2505.12465. https://arxiv.org/abs/2505.12465
- [6] Market Making without Regret. arXiv:2411.13993. https://arxiv.org/abs/2411.13993
