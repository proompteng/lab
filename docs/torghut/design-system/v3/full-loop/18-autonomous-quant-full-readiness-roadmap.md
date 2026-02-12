# Autonomous Quant Full-Readiness Roadmap

## Status
- Version: `v3-full-readiness-2026-02-12`
- Owner: `torghut`
- Scope: production-readiness for fully autonomous quant+LLM trading

## Current evidence (2026-02-12)
- LEAN execution path is active and strategy decisions can include `execution_adapter.selected`.
- The trade loop can still stall on signal fetch with zero signals while cursor is ahead of the latest signal.
- `research_runs` and related tables are available but live writes are sparse/noisy; no evidence of continuous lane evidence yet.
- `trading/autonomy` and `trading/status` lacked explicit fetch stall reasoning in previous state.

## Remaining work (ordered by control priority)
1. **Signal source continuity**
   - Guarantee WS-backed symbol universe is authoritative (`TRADING_UNIVERSE_SOURCE=jangar`) and static symbols are removed from hot paths.
   - Add explicit staleness alerting when the cursor is ahead of ClickHouse tail (implemented partially in ingestion telemetry) and route this to alerts.

2. **Execution + governance provenance**
   - Ensure every execution row has non-null:
     - `execution_expected_adapter`
     - `execution_actual_adapter`
     - `execution_fallback_reason` (when a fallback occurred)
   - Keep route tags for reconciled rows and historical backfills.

3. **Research lane reliability**
   - Maintain durable `research_runs` writes from every promotion attempt.
   - Capture and persist gate report + recommendation trace IDs on all paths.
   - Add retry + dead-letter behavior for failed research persistence.

4. **Backtest + deployment safety**
   - Add a pre-live promotion checkpoint:
     - minimum paper simulation run count
     - minimum live shadow exposure duration
     - minimum non-error gate ratio
   - Enforce at least one-stage approval before live promotion.

5. **Performance and cost observability**
   - Add Prometheus/Log dashboards for:
     - ingest latency and signal lag
     - decision→fill latency by adapter
     - route fallback ratio and execution error categories
     - rolling daily PnL with gate coverage

6. **Autonomous rollback**
   - Automatic emergency stop if:
     - signal lag exceeds policy limit,
     - autonomous lane fails repeatedly,
     - fallback ratio exceeds budget,
     - or PnL drawdown breaches policy.
   - Route all rollbacks through existing kill-switch and include operator evidence package.

## Implementation sequence
### Phase A (now)
- Ship ingestion reason telemetry into `/trading/status` and `/trading/autonomy`.
- Alert on `cursor_ahead_of_stream` and `no_signals_in_window` with cursor lag threshold.

### Phase B
- Add CI checks for research lane persistence and minimum evidence artifacts.
- Extend end-to-end tests covering `trading/autonomy` and `trading/decisions`.

### Phase C
- Add policy gates for promotion and staged capital ramp to live by day.
- Add synthetic drill for incident rollback and recovery.

## Success criteria
- Autonomy runs with non-zero signal throughput for >95% windows once WS/TA is healthy.
- Every lane execution has route provenance and evidence artifacts.
- No autonomous live promotion without gate evidence + approvals.
