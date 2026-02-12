# Autonomous Gap Closure Roadmap (2026-02-12)

## Status
- Version: `v3-gap-roadmap`
- Last updated: `2026-02-12`
- Maturity: `draft`

## Purpose
Translate current production reality into an executable, fully autonomous quant LLM trading roadmap.

## Current-State Facts (Anchor)
- Active strategy: `intraday-tsmom-profit-v2` with `universe_type=intraday_tsmom_v1`.
- Universe source: Jangar (`TRADING_UNIVERSE_SOURCE=jangar`, no static symbols in live)
- Execution engine: LEAN adapter selected by default (`TRADING_EXECUTION_ADAPTER=lean`) with Alpaca fallback.
- Autonomy cycle runs but remains non-promoting (`recommendation=shadow`, `patches_total=0`).
- Last run signals exist but no viable trading output in the same run (`decision_count=0`, `trade_count=0`).
- No durable `research_*` tables in DB yet (no production-grade promotion ledger).
- LLM route is disabled in live runtime (`LLM_ENABLED=false`).

## Workstreams

### Workstream A — Research Ledger and Promotion Determinism
Create a persistent and auditable evidence trail for every candidate before any automatic policy transition.

- Define immutable records for strategy run, feature contract version, dataset hash, code hash, and parameter set.
- Persist fold-level decision/trade metrics, stress metrics, and gate outputs.
- Require successful reproducibility check for any promotion decision.
- Gate candidate acceptance to a minimum confidence envelope and publication window.

### Workstream B — Backtesting Realism and Signal Coverage
Fix the gap between signal presence and actionable decisions during autonomous evaluation.

- Ensure walk-forward evaluation and autonomous lane share identical feature contracts and feature hashes.
- Add representative replay windows and data sufficiency guard (`min_signals`, `min_decisions`, `min_trades`).
- Add realistic execution model assumptions: slippage buckets, spread model, time-in-force behavior, partial fill assumptions.
- Add market session handling and embargo/purge logic aligned to TA data freshness.

### Workstream C — Autonomous Promotion Engine
Turn shadow-only lane into deterministic paper-candidate promotion pipeline.

- Add a structured promotion decision API in service layer.
- Emit paper-candidate manifests only when gates and minimum thresholds are met.
- Track attempted promotions, denied promotions, and deny reasons in DB and artifact store.
- Add automatic canary and rollback paths for promotion actions.

### Workstream D — Execution Policy and LEAN/Alpaca Router Governance
Guarantee route safety, fallback clarity, and traceability.

- Enforce explicit per-symbol adapter routing policy with audit tags on each order.
- Record route used (`lean`, `alpaca_fallback`) and fallback reason codes in execution metadata.
- Add kill-switch override precedence and circuit breaker conditions.
- Add alerting on repeated fallback/failure patterns.

### Workstream E — LLM Bounded Rollout for Advisory Layer
Move from LLM-disabled to staged advisory operation.

- Stage 1: shadow evaluation only, no actuation impact.
- Stage 2: enable paper review in shadow with pass-through error handling.
- Stage 3: optional bounded adjustment in paper after control validation.
- Stage 4: allow controlled live advisory influence only after independent challenge review.

## Implementation Sequence
1. **Foundational:** ledger schema + migrations + replay harness + feature version registry.
2. **Validation:** backtest realism + robustness gates + deterministic evaluation parity.
3. **Control:** promotion gate engine + candidate artifact generation.
4. **Execution:** router governance + fallback observability + strategy canary path.
5. **Autonomy:** staged LLM and capital ramp, with explicit kill-switch and rollback.

## Exit Criteria
- All promotion attempts create ledger rows.
- Zero promotion action without passing: ledger reproducibility, fold stability, and risk gates.
- Paper run executes strategy candidate for >N runs with no critical regressions.
- Live mode requires explicit approvals and staged capital controls.
