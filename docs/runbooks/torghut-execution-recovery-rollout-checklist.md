# Torghut Execution Recovery Rollout Checklist

## Scope

Use this checklist for the Torghut/Jangar production recovery rollout that targets execution throughput restoration and profitability-gated promotion.

## Preconditions

- Changes are merged through CI and deployed via Argo CD sync (no ad-hoc production mutation).
- Deterministic risk and firewall controls remain enabled and authoritative.
- No run-level prompt overrides are present on market-context AgentRuns.

## Canary progression gates

Evaluate gates on active market sessions only.

1. Gate A: Runtime stability (must hold for 1 full session)
- `torghut_trading_execution_clean_ratio >= 0.75`
- `sum(increase(torghut_trading_decisions_total[1h])) > 25`
- No firing alerts:
  - `TorghutQuantExecutionCleanRatioLow`
  - `TorghutQuantLLMErrorRateHigh`

2. Gate B: Rejection quality (must hold for 3 consecutive sessions)
- `qty_below_min` reject share <= `0.03`:
  - `increase(torghut_trading_decision_reject_reason_total{reason="qty_below_min"}[1h]) / clamp_min(increase(torghut_trading_decisions_total[1h]), 1) <= 0.03`
- `llm_unavailable_*` reject share <= `0.02`:
  - `sum(increase(torghut_trading_decision_reject_reason_total{reason=~"llm_unavailable_.*"}[1h])) / clamp_min(increase(torghut_trading_decisions_total[1h]), 1) <= 0.02`

3. Gate C: Profitability readiness (rolling 20 sessions)
- At least `15 / 20` sessions satisfy:
  - filled executions >= 1
  - reject ratio <= 0.25
  - positive realized PnL after costs

## Market-context continuity gates

- Batch failure ratio (`failed|partial`) <= `0.40` over 30m.
- `skipped_market_closed` outcome is zero in market-open windows.
- Pre-open probe schedules exist and execute before open:
  - `torghut-market-context-fundamentals-preopen-probe`
  - `torghut-market-context-news-preopen-probe`

## Hard rollback triggers

Rollback immediately (GitOps revert + Argo sync) if any condition persists for the alert window:

- `execution_clean_ratio < 0.70` for 15m.
- `qty_below_min` share > `0.05` for 30m.
- `llm_unavailable_*` reject share > `0.03` for 30m.
- Market-context skipped outcome appears during market-open window.

## Verification evidence to capture per stage

- Grafana dashboard screenshot/export:
  - `Torghut Execution Recovery`
- Prometheus snippets for gate metrics and ratios.
- Jangar `/api/torghut/trading/summary` snapshot (top reasons, pre/post-open split).
- Argo CD app revision and sync status for `torghut`, `jangar`, and observability app.
