# Strategy SDK and Plugin Contracts

## Objective
Define a strict strategy plugin SDK so research can iterate quickly while preserving runtime safety and deterministic
behavior in Torghut production loops.

## Design Principles
- Plugins generate intents, not orders.
- Plugins are pure functions over canonical feature vectors and local state.
- Plugin interfaces are versioned and backward-compatible by policy.
- Plugin failures degrade locally and do not crash the scheduler.

## SDK Surface (Proposed)
```python
from dataclasses import dataclass
from datetime import datetime
from typing import Any, Protocol

@dataclass(frozen=True)
class FeatureVectorV3:
  symbol: str
  event_ts: datetime
  timeframe: str
  schema_version: str
  values: dict[str, float | int | str | None]

@dataclass(frozen=True)
class StrategyContext:
  strategy_id: str
  strategy_type: str
  version: str
  params: dict[str, Any]

@dataclass(frozen=True)
class StrategyIntent:
  strategy_id: str
  symbol: str
  direction: str  # long|short|flat
  confidence: float
  target_notional: float
  horizon: str
  rationale: list[str]
  meta: dict[str, Any]

class StrategyPlugin(Protocol):
  strategy_type: str
  version: str

  def validate_params(self, params: dict[str, Any]) -> None: ...
  def required_features(self) -> set[str]: ...
  def warmup_bars(self) -> int: ...
  def on_event(self, fv: FeatureVectorV3, ctx: StrategyContext) -> StrategyIntent | None: ...
```

## Built-In Plugin Families (v1)
- `legacy_macd_rsi@1.0.0` for migration parity.
- `trend_multifactor@1.0.0`.
- `mean_reversion@1.0.0`.
- `volatility_overlay@1.0.0`.

## Strategy Catalog Contract Extension
Extend strategy catalog model from `services/torghut/app/strategies/catalog.py` with:
- `strategy_type: str`
- `version: str`
- `params: dict[str, Any]`
- `feature_requirements: list[str]`
- `cooldown_seconds: int | null`
- `max_parallel_positions: int | null`
- `priority: int`

Validation policy:
- unknown plugin type/version => strategy disabled (fail closed).
- invalid params => strategy disabled + reason persisted.
- catalog reload is atomic.

## Runtime Packaging and Loading
- Plugin package location:
  - `services/torghut/app/trading/strategies/plugins/`
- One module per plugin family and semantic version.
- No dynamic pip installs at runtime.
- Plugin imports must be deterministic and auditable.

## Plugin Lifecycle
1. Register plugin in registry map.
2. Validate strategy config against plugin schema.
3. Warmup period consumes features without emitting intents.
4. Active evaluation emits intents.
5. Circuit-breaker disables plugin if error budget exceeded.
6. Re-enable by config or automatic cooldown policy.

## Security and Runtime Restrictions
- No outbound HTTP from plugin code path.
- No broker client references in plugins.
- No file writes in runtime evaluation.
- No mutable global state shared across plugins.

## Test Matrix (Required Per Plugin)
- deterministic unit tests using fixture feature vectors,
- param-validation tests,
- warmup boundary tests,
- missing/stale feature tests,
- performance budget tests,
- replay parity test against frozen fixture set.

## Observability Contract
Per plugin labels:
- `strategy_plugin_loaded`
- `strategy_plugin_enabled`
- `strategy_events_total`
- `strategy_intents_total`
- `strategy_errors_total`
- `strategy_eval_latency_ms`
- `strategy_circuit_open_total`

## Versioning and Deprecation Policy
- Breaking changes require major version bump.
- Minor versions may add optional params/features only.
- Removal requires one release deprecation window.
- Rollback path must remain config-only for previous stable major.

## AgentRun Handoff Bundle
- `ImplementationSpec`: `torghut-v3-plugin-sdk-impl-v1`.
- Required keys:
  - `repository`
  - `base`
  - `head`
  - `designDoc`
  - `strategyCatalogPath`
- Expected execution:
  - implement SDK contracts,
  - migrate legacy logic to plugin,
  - add plugin loader and validation,
  - add plugin conformance test harness.
- Expected artifacts:
  - new SDK modules under `services/torghut/app/trading/strategies/`,
  - strategy catalog schema updates,
  - unit/integration tests.
- Exit criteria:
  - legacy behavior reproducible via `legacy_macd_rsi` plugin,
  - invalid plugin configuration fails closed,
  - deterministic plugin replay tests pass.
