# Execution, TCA, and Broker Abstraction

## Objective
Decouple alpha intent generation from broker mechanics and establish closed-loop transaction cost analytics (TCA) that
feed promotion and policy decisions.

## Current Baseline
- execution path is primarily Alpaca-centered in Torghut trading modules.
- execution policy exists but TCA feedback is not yet first-class for promotion gates.

## Target Execution Architecture

### Core contracts
- `OrderIntent`: broker-neutral target request.
- `ExecutionAdapter`: venue-specific submit/cancel/replace/status interface.
- `ExecutionPolicyEngine`: order type and protection policy.
- `TCARecorder`: slippage and shortfall measurement.

### `OrderIntent` fields
- `intent_id`
- `decision_id`
- `symbol`
- `side`
- `qty`
- `urgency`
- `order_constraints`
- `max_slippage_bps`
- `participation_cap`

## Policy Engine Rules
- passive-first when spread/capacity conditions recommend.
- aggressive actions only when urgency and liquidity justify.
- bounded retry/cancel/replace loops.
- hard timeout and stale-intent cancellation.

## Broker Abstraction Roadmap
- adapter 1: Alpaca (current production adapter).
- adapter 2: simulation adapter for replay/backtests.
- adapter 3: optional secondary venue after contract maturity.

All adapters must support:
- idempotency keys,
- standardized error codes,
- deterministic audit payloads.

## TCA Metrics (Required)
Per order:
- decision-to-submit latency.
- arrival-mid slippage.
- fill shortfall vs arrival price.
- spread capture vs crossing cost.
- cancel/replace churn.

Aggregated:
- symbol-level implementation shortfall.
- strategy-level slippage drift.
- policy-mode performance comparison.

## Feedback Loop
- TCA metrics recalibrate cost model versions.
- promotion gates require TCA thresholds met in paper/shadow.
- sustained TCA degradation triggers policy fallback.

## Operational Guardrails
- order firewall remains final submit authority.
- kill switch blocks new submissions and cancels eligible open orders.
- execution errors are classified and observable.

## Failure Modes and Mitigations
- broker API partial outage:
  - switch to protective mode, reduce aggressiveness, trigger alerts.
- stale market snapshot:
  - reject intent with explicit stale-data code.
- excessive churn:
  - cooldown and policy throttling.

## Observability
Metrics:
- `execution_submit_total{adapter,status}`
- `execution_error_total{adapter,code}`
- `execution_slippage_bps_p50/p95`
- `execution_shortfall_bps`
- `execution_cancel_replace_ratio`

SLO targets:
- submission success ratio above target threshold.
- p95 slippage within configured band per symbol bucket.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-execution-tca-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `executionConfigPath`
- Expected execution:
  - implement broker-neutral order intent contract,
  - add execution adapter interface + Alpaca adapter conformance,
  - add TCA recording pipeline and dashboards,
  - wire policy feedback loop.
- Expected artifacts:
  - execution abstraction modules,
  - adapter conformance tests,
  - TCA reports and metric wiring.
- Exit criteria:
  - end-to-end paper cycle records TCA metrics,
  - policy fallback triggers on forced degradation tests,
  - idempotency and kill-switch invariants preserved.
