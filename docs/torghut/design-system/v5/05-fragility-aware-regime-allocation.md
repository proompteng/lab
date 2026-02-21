# Priority 5: Fragility-Aware Regime Allocation and Stability Mode

## Objective
Implement a portfolio/risk allocation layer that dynamically adjusts risk budgets based on regime and market fragility
signals, reducing tail losses and crowding risk while preserving deterministic control.

## Problem Statement
Static allocation and risk budgets underperform when liquidity compresses, spreads accelerate, or strategy crowding
increases. Existing constraints limit gross/notional exposure but do not explicitly encode market fragility states as a
first-class allocation input.

## Scope
### In Scope
- fragility indicator computation (liquidity, spread acceleration, crowding proxies),
- regime-aware allocation multipliers,
- stability mode with deterministic notional and turnover clamps,
- integration with existing autonomy gate and execution policy.

### Out of Scope
- discretionary human override logic in runtime,
- replacing the full risk engine,
- introducing leverage or exposure classes not supported by current policy.

## Target Architecture
### Components
1. `FragilityMonitorV5`
- computes composite fragility score per symbol and portfolio level.
- emits `normal|elevated|stress|crisis` state.

2. `RegimeAllocatorV5`
- converts regime + fragility state into budget multipliers.
- applies symbol, sector, and gross exposure clamps.

3. `StabilityModeController`
- deterministic behavior under `stress|crisis`:
  - reduce notional,
  - cap participation,
  - raise confidence threshold,
  - bias to risk-reducing exits.

4. `PromotionGuard`
- blocks promotion when fragility SLOs fail.

## Allocation Policy Model
### Inputs
- `regime_label` from strategy runtime,
- `fragility_score` and state,
- realized slippage/churn from TCA,
- current gross/net and concentration exposure.

### Outputs
- `budget_multiplier`,
- `capacity_multiplier`,
- `max_participation_rate_override`,
- `abstain_probability_bias`,
- `stability_mode_active`.

### Deterministic Constraints
- allocator can only tighten, not loosen, hard risk maxima.
- any unknown fragility state defaults to conservative (`elevated`).
- crisis state forces entry restrictions regardless of model confidence.

## Torghut Integration Points
- `services/torghut/app/trading/portfolio.py`
  - apply fragility-aware multipliers and allocation audit payload.
- `services/torghut/app/trading/risk.py`
  - add fragility-triggered reject reasons.
- `services/torghut/app/trading/autonomy/gates.py`
  - include fragility in promotion and runtime gates.
- `services/torghut/app/trading/execution_policy.py`
  - accept dynamic participation clamps from stability mode.
- `argocd/applications/torghut/strategy-configmap.yaml`
  - policy thresholds and mode toggles.

## Data Contracts
### Fragility Snapshot (`fragility_snapshot_v1`)
```json
{
  "schema_version": "fragility_snapshot_v1",
  "event_ts": "2026-02-21T14:50:00Z",
  "symbol": "SPY",
  "spread_acceleration": 0.42,
  "liquidity_compression": 0.37,
  "crowding_proxy": 0.58,
  "correlation_concentration": 0.66,
  "fragility_score": 0.59,
  "fragility_state": "stress"
}
```

### Allocation Audit Extension
- `fragility_state`
- `stability_mode_active`
- `applied_multipliers`
- `clamp_reasons`

## Metrics, SLOs, and Alerts
### Metrics
- `fragility_score{symbol}`
- `stability_mode_active_total`
- `allocation_multiplier{regime,fragility_state}`
- `portfolio_turnover_ratio`
- `portfolio_drawdown`

### SLOs
- stress/crisis states trigger deterministic clamp actions at 100% rate.
- concentration and gross exposure limits never exceeded in stress mode.
- drawdown tail metrics improve versus baseline over evaluation windows.

### Alerts
- fragility state elevated/stress without stability mode activation.
- repeated concentration near limit while crowding proxy remains high.
- gate/policy mismatch between fragility state and allocation output.

## Verification Plan
### Offline
- replay known stress windows and synthetic fragility shocks.
- compare drawdown, turnover, and recovery vs baseline allocator.

### Paper
- shadow stress-mode activation by regime bucket.
- evaluate retained upside vs reduced downside under instability.

### Promotion Criteria
- improved downside metrics with acceptable opportunity cost.
- deterministic clamp and rollback behavior validated.
- complete audit trail for every fragility-triggered allocation decision.

## Failure Modes and Mitigations
- excessive conservatism during transient noise:
  - mitigation: hysteresis bands and minimum dwell-time before state transitions.
- missed fragility detection:
  - mitigation: ensemble indicators + conservative default policy on missing data.
- allocator instability during rapid regime transitions:
  - mitigation: transition smoothing + max step size for multiplier changes.

## Rollback Plan
- set `FRAGILITY_MODE=observe` to disable enforcement but keep telemetry.
- set `FRAGILITY_MODE=off` only during incident response with explicit approval.
- revert to baseline multipliers while preserving snapshot artifacts.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v5-fragility-regime-allocation-v1`
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `riskConfigPath`
  - `strategyConfigPath`
  - `artifactPath`
- Expected artifacts:
  - fragility monitor module,
  - allocator integration,
  - stability-mode policy and tests,
  - stress replay report.
- Exit criteria:
  - clamp behavior deterministic under stress,
  - risk and drawdown gates pass,
  - rollback rehearsal complete.

## References
- [1] BIS Working Paper 1229: Artificial intelligence and market fragility. https://www.bis.org/publ/work1229.htm
- [2] NBER Working Paper 33351: Artificial Intelligence and Asset Prices. https://www.nber.org/papers/w33351
- [3] FR-LUX: Friction-Aware, Regime-Conditioned Policy Optimization for Implementable Portfolio Management. arXiv:2510.02986. https://arxiv.org/abs/2510.02986
- [4] Conformal Prediction for Time-series Forecasting with Change Points. arXiv:2509.02844. https://arxiv.org/abs/2509.02844
