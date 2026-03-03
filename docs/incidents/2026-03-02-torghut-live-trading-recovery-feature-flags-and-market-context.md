# Incident Report: Torghut Live Trading Blocked by Feature-Flag Short-Circuit and Market-Context Schema Drift

- **Date**: 2026-03-02 (UTC)
- **Severity**: High
- **Services affected**: `torghut`, `jangar` market-context path, Flipt (`feature-flags`)

## Impact

- Torghut runtime stayed up but did not submit live orders for the affected window.
- Decision loop produced mostly rejected decisions with `risk_reasons=["kill_switch_enabled"]`.
- Market-context health remained `overallState=down` due technical/regime source failures.

## User-visible Symptoms

- `/trading/status` reported `kill_switch_enabled=true` while `running=true`.
- Decision mix in Postgres showed only rejected decisions for recent windows.
- Jangar market-context health endpoint returned:
  - `ingestionHealth.clickhouse.lastError=clickhouse_query_failed`
  - `overallState=down`
  - technical/regime domain state `error`.

## Timeline (UTC)

- **2026-03-02 16:13**: System-state runbook check confirmed workloads healthy but trading blocked and market-context down.
- **2026-03-02 16:18**: Re-validated runtime: `kill_switch_enabled=true`, decisions still rejected.
- **2026-03-02 16:26**: Root cause isolation in code and live probes:
  - Jangar query selected non-existent ClickHouse columns from `ta_signals`.
  - Torghut feature-flag override chain aborted on missing flag key.
- **2026-03-02 16:30-16:32**: Direct Knative env patch attempts were auto-reverted by Argo self-heal.
- **2026-03-02 16:34-16:36**: Updated Flipt source branch (`feature-flags-state`) to restore torghut flag parity and recovery toggles.
- **2026-03-02 16:37**: Torghut revision recovered and became Ready after restart loop convergence.
- **2026-03-02 16:38+**: Live flow confirmed:
  - signal freshness healthy (seconds-level lag),
  - decision statuses include `filled`,
  - executions include `filled`.

## Root Causes

1. **Feature-flag short-circuit prevented kill-switch override**
   - Torghut resolves flags sequentially and stops after first failed flag lookup.
   - Flipt storage branch lacked several `torghut_*` keys (first failure at `torghut_ws_crypto_enabled`).
   - As a result, `torghut_trading_kill_switch_enabled=false` was never applied and runtime fell back to env default `TRADING_KILL_SWITCH_ENABLED=true`.

2. **Jangar market-context query/schema mismatch**
   - Jangar market-context technical source queried legacy/non-existent columns from `ta_signals` (e.g. `c`, `v`, `spread`, `rsi`, `volatility`, `atr`, `imbalance`, `trend_strength`, `adx`, `liquidity_score`).
   - Current canonical `ta_signals` schema no longer provides those columns.
   - Query failed with `UNKNOWN_IDENTIFIER`, surfaced as `clickhouse_query_failed`, forcing market-context `overallState=down`.

## Contributing Factors

- Argo CD self-heal/prune quickly reverted direct runtime patches not reflected in GitOps desired state.
- Market-context requirement gate added additional trade suppression risk while context pipeline was degraded.
- Flipt source-of-truth branch drifted from main feature inventory parity for torghut keys.

## Recovery Actions Performed

1. Verified data-plane and signal continuity were healthy (ClickHouse freshness + WS continuity metrics).
2. Confirmed the feature-flag short-circuit behavior from live Torghut process.
3. Updated Flipt storage branch (`feature-flags-state`) with missing Torghut flag keys and recovery values.
4. Set runtime-critical flags for recovery:
   - `torghut_trading_kill_switch_enabled=false`
   - `torghut_trading_market_context_required=false`
   - `torghut_llm_fail_open_live_approved=true` (required for live `pass_through` validation)
5. Restarted Torghut revision pod to reload resolved feature flags.
6. Verified live trading resumed with filled decisions/executions.

## Validation Evidence

- `/trading/status`:
  - `running=true`
  - `kill_switch_enabled=false`
  - `signal_continuity.last_state="signals_present"`
- ClickHouse freshness:
  - `ta_signals` lag in low single-digit seconds
  - `ta_microbars` lag in low single-digit seconds
- Postgres recent windows:
  - `trade_decisions` includes `filled`
  - `executions` includes `filled`

## Follow-up Actions

1. **Code fix (Jangar)**: update market-context ClickHouse query to current `ta_signals`/`ta_microbars` schema and add regression test for schema compatibility.
2. **Config robustness (Torghut)**: do not abort all remaining feature-flag overrides on a single missing key; degrade per-key with warning.
3. **GitOps parity guard**: enforce CI diff check between `main` flag catalog and `feature-flags-state` catalog before rollout.
4. **Runbook update**: add explicit check for feature-flag short-circuit indicators and missing flag keys in recovery triage.

