# Autonomous Quant Live Readiness Snapshot (2026-02-13)

## What is in place now

- LEAN adapter routing is configured and active:
  - `TRADING_EXECUTION_ADAPTER=lean`
  - `TRADING_EXECUTION_ADAPTER_POLICY=all`
  - `TRADING_EXECUTION_FALLBACK_ADAPTER=alpaca`
- Autonomy loop is running and executing on a cadence.
- Research lane code path is present and wired, including:
  - run persistence,
  - gate/evaluation output generation,
  - patch artifact generation,
  - route metadata helpers for execution provenance.
- Route metadata backfill migration `0007_autonomy_permissions_backfill_routes` is already applied in live DB.

## Live evidence (at query time)

- `/trading/status` shows non-zero autonomy runs but `signals_total` is currently zero in recent windows.
- `/trading/autonomy` shows same zero-signal pattern and no lane recommendation artifacts yet.
- ClickHouse `torghut.ta_signals` contains historical rows, but latest signal windows are empty.
- `executions` still show legacy rows with `execution_expected_adapter`/`execution_actual_adapter` unset.

## Gaps blocking “fully autonomous + profitable” operation

1. **Signal continuity is not sustained**
   - Root cause appears to be source freshness, not execution gating:
     no new signal rows arriving in the active `Cursor->window` slice.
   - Immediate control action: enforce explicit source-liveness guardrails (lag SLO + consecutive empty-window alerts).

2. **No live autonomous research evidence yet**
   - Lane runs are currently short-circuiting before persistence because signal batches are empty.
   - Need backfilled evidence and proof-of-life once signal ingress recovers.

3. **No immediate performance evidence**
   - No live `signals_total` means no recent decision/execution cycle, so no fresh profitability or PnL evidence.
   - Need at minimum one full 3–5 day autonomous window with non-empty signals before any live escalation decision.

4. **Execution provenance on historical rows**
   - Existing historical rows still have null route fields.
   - Reconcile backfill has been added in code and SQL migration but needs explicit verification run after deployment.

## Definition of done (next checkpoint)

- Source window fills ≥95% of 5-minute windows over a 4-hour sample.
- `autonomy.signals_total` rises >0 and `execution_requests_total`/`execution_fallback*` counters are emitted.
- At least one complete `research_runs` row set is present with:
  - candidate row,
  - gate report,
  - fold/stress metrics,
  - promotion recommendation.
- Route fields are no longer null for newly created executions and backfill script verifies historical recovery.

## Suggested execution sequence

1. Roll out LEAN-aware execution+status code (this branch) and confirm endpoint telemetry.
2. Raise source freshness alert when `no_signal_reason` is repeatedly non-null for 2+ cycles.
3. Verify `research_*` writes resume within first non-empty signal window.
4. Build a profitability evidence packet:
   - rolling decision count,
   - non-zero fill count,
   - `research` gate decision trail,
   - route fallback and error budget.
