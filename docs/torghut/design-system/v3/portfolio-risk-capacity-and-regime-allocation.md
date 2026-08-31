# Portfolio, Risk, Capacity, and Regime Allocation

## Objective

Upgrade Torghut from per-signal sizing to portfolio-aware, regime-aware allocation while preserving deterministic hard
risk constraints.

## Current Baseline

- portfolio sizing and risk controls exist in trading loop but are strategy-local.
- one dominant strategy creates concentration and high rejection rates.
- regime-aware budget/capacity multipliers are implemented in allocator controls; broader multi-strategy adoption remains partial.

## Target Allocation Stack

1. `IntentAggregator` produces net symbol intents.
2. `PortfolioAllocator` maps intents to target exposures.
3. `RiskGateChain` enforces hard limits.
4. `ExecutionPolicyEngine` maps approved exposures to order intents.

## Allocation Inputs

- strategy intents with confidence and horizon.
- account equity, cash, buying power.
- open positions and recent fills.
- estimated spread/volatility/capacity.
- regime label and confidence.

## Allocation Outputs

- target delta quantity per symbol.
- per-strategy budget utilization trace.
- rejection/clip reasons with deterministic codes.

## Budgeting Policy

- base risk budget per strategy family.
- regime multipliers adjust base budgets.
- capacity scaling adjusts by spread/volatility/liquidity.
- final hard clipping by gross/net/notional limits.

## Regime Model (Initial)

- trend regime: favor trend strategies, reduce mean-reversion weight.
- mean-reversion regime: reverse above bias.
- high-volatility regime: reduce gross exposure and tighten participation caps.
- uncertain regime: move toward defensive baseline weights.

## Capacity Controls

Enforce by symbol:

- participation cap.
- expected slippage budget.
- turnover ceiling.
- concentration cap.

If symbol fails capacity checks:

- clip or reject allocation,
- persist reason for analytics.

## Deterministic Risk Invariants

- global notional limits.
- per-symbol max exposure.
- per-strategy max contribution.
- kill switch always supersedes allocator output.

## Observability

Metrics:

- `allocator_active_strategies`
- `allocator_gross_exposure`
- `allocator_net_exposure`
- `allocator_reject_total{reason}`
- `capacity_utilization_ratio{symbol}`
- `strategy_pnl_contribution{strategy_id}`

SLO targets:

- no limit breach at post-risk stage.
- rejection reasons fully classified (no `unknown`).
- allocation latency p99 within scheduler budget.

## Promotion Gates (Allocator-Specific)

- candidate strategy must improve portfolio-level risk-adjusted metrics.
- no unacceptable concentration increase.
- capacity stress scenario remains within limits.

## Integration Notes

- keep `RiskEngine` as final deterministic guardrail.
- use PyPortfolioOpt/cvxportfolio offline for policy calibration, then encode runtime policy explicitly in Torghut code.
- avoid runtime dependence on external optimizers for deterministic path.

## Runtime Flags (v3 allocator path)

- `TRADING_ALLOCATOR_ENABLED` (default `false`): enables deterministic intent aggregation + pre-risk allocation clipping.
- `TRADING_ALLOCATOR_DEFAULT_REGIME` (default `neutral`): fallback regime label when no regime context is provided.
- `TRADING_ALLOCATOR_REGIME_BUDGET_MULTIPLIERS`: JSON map `regime_label -> multiplier` for budget scaling.
- `TRADING_ALLOCATOR_REGIME_CAPACITY_MULTIPLIERS`: JSON map `regime_label -> multiplier` for symbol-capacity scaling.
- `TRADING_ALLOCATOR_MAX_SYMBOL_PCT_EQUITY` / `TRADING_ALLOCATOR_MAX_SYMBOL_NOTIONAL`: optional allocator symbol caps.
- `TRADING_ALLOCATOR_DEFAULT_BUDGET_MULTIPLIER` and `TRADING_ALLOCATOR_DEFAULT_CAPACITY_MULTIPLIER` default to `1.0`.
- `TRADING_ALLOCATOR_MIN_MULTIPLIER` / `TRADING_ALLOCATOR_MAX_MULTIPLIER` clamp runtime multipliers deterministically.

## AgentRun Handoff Bundle

- `ImplementationSpec`: `torghut-v3-allocator-risk-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `riskConfigPath`
  - `strategyConfigPath`
- Expected execution:
  - implement allocator module and integration path,
  - add regime multiplier config,
  - add capacity and concentration gates,
  - add allocator metrics and tests.
- Expected artifacts:
  - allocator code under `services/torghut/app/trading/`,
  - updated config schema + defaults,
  - targeted unit/integration tests.
- Exit criteria:
  - allocator produces deterministic outputs for fixed fixtures,
  - risk hard limits preserved,
  - portfolio-level metrics available for promotion decisions.
