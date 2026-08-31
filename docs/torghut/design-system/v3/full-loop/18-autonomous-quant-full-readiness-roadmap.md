# Autonomous Quant Full-Readiness Roadmap

## Status

- Version: `v3-full-readiness-2026-02-12`
- Owner: `torghut`
- Scope: production-readiness for fully autonomous quant+LLM trading

## Update (2026-02-26)

- The signal source continuity workstream from this roadmap is completed in code and observability.
- Implemented controls include no-signal reason classification, continuity alerting/recovery, emergency-stop integration, and live-promotion blocking while a continuity alert is active.

## Current evidence (2026-02-12)

- LEAN execution path is active and strategy decisions can include `execution_adapter.selected`.
- The trade loop can still stall on signal fetch with zero signals while cursor is ahead of the latest signal.
- `research_runs` and related tables are available but live writes are sparse/noisy; no evidence of continuous lane evidence yet.
- `trading/autonomy` and `trading/status` lacked explicit fetch stall reasoning in previous state.

## Remaining work (ordered by control priority; signal continuity closed on 2026-02-26)

1. **Execution + governance provenance**
   - Ensure every execution row has non-null:
     - `execution_expected_adapter`
     - `execution_actual_adapter`
     - `execution_fallback_reason` (when a fallback occurred)
   - Keep route tags for reconciled rows and historical backfills.

2. **Research lane reliability**
   - Maintain durable `research_runs` writes from every promotion attempt.
   - Capture and persist gate report + recommendation trace IDs on all paths.
   - Add retry + dead-letter behavior for failed research persistence.

3. **Backtest + deployment safety**
   - Add a pre-live promotion checkpoint:
     - minimum paper simulation run count
     - minimum live shadow exposure duration
     - minimum non-error gate ratio
   - Enforce at least one-stage approval before live promotion.

4. **Performance and cost observability**
   - Add Prometheus/Log dashboards for:
     - ingest latency and signal lag
     - decision→fill latency by adapter
     - route fallback ratio and execution error categories
     - rolling daily PnL with gate coverage

5. **Autonomous rollback**
   - Automatic emergency stop if:
     - signal lag exceeds policy limit,
     - autonomous lane fails repeatedly,
     - fallback ratio exceeds budget,
     - or PnL drawdown breaches policy.
   - Route all rollbacks through existing kill-switch and include operator evidence package.

## Implementation sequence

### Phase A (completed)

- Shipped ingestion reason telemetry into `/trading/status` and `/trading/autonomy`.
- Shipped alerting on `cursor_ahead_of_stream` and `no_signals_in_window` with cursor lag threshold.

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
