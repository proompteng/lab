# Autonomous Quant + LLM Full-Autonomy Completion Roadmap (2026-02-13)

## Current evidence snapshot

- Live service is running a revised autonomy/scheduler/build and has LEAN adapter plumbing, with fallback and route metadata hooks present.
- Live telemetry currently shows:
  - `/trading/autonomy` runs are present but recent `signals_total` is `0`.
  - `last_run_id` is often `null`.
  - `/trading/metrics` currently reports only base counters until a signal-triggered cycle runs.
- Source-of-truth symbol feed is still expected from Jangar (`TRADING_UNIVERSE_SOURCE=jangar`); strategy-level static symbols are not the global routing source.

## What this means for "profitable strategy on LEAN"

- There is no reliable indication of current strategy profitability from live telemetry because no recent signal decisions are reaching execution.
- LEAN is configured but cannot be validated as “profitable” without a bounded period of non-empty signal windows, executed decisions, fills, and audit evidence.
- If `signals_total == 0` for multiple cycles, there is no basis to claim profitability.

## Missing production control gaps

1. Signal continuity and freshness
   - Guard `no_signal_reason` and enforce source SLOs for `ta_signals` lag.
   - Add explicit alerting for:
     - consecutive `no_signals_in_window`,
     - repeated `cursor_ahead_of_stream`,
     - sustained stream silence after restart.
   - Do not scale LEAN until source and windows are stable.

2. Autonomous evidence ledger continuity
   - Ensure every lane window writes:
     - `research_runs`,
     - `research_candidates`,
     - `research_fold_metrics`,
     - `research_stress_metrics`,
     - `research_promotions` when promotion gates pass/fail.
   - Add a nightly reconciliation check that verifies the full artifact chain for the latest lane IDs.

3. Strategy profitability signal
   - Add explicit live paper profitability dashboard slice:
     - decisions by symbol/strategy,
     - execution fills by adapter,
     - realized PnL and adverse excursion for a fixed hold-forward window,
     - gate and rollback attribution.
   - Only promote to live when 3+ day paper evidence passes the gate policy envelope for the same symbols.

4. LEAN parity and fallback observability
   - Persist `execution_expected_adapter`, `execution_actual_adapter`, `execution_fallback_count`, `execution_fallback_reason` on every execution write.
   - Require route parity checks for LEAN vs Alpaca for a fixed symbol subset before any increased allocation.
   - Keep fallback policy on by default (`policy=all`, `fallback=alpaca`) until LEAN stability is proven.

5. LLM advisory hardening
   - Keep advisory off for capital-changing actions unless gate policy and fail-mode controls are explicit.
   - Add LLM telemetry in the same lane evidence pack (review timestamps, shadow vs adjustment counts, gate outcomes).
   - Block live if advisory/guardrail mismatch or parse/validation error budget is exceeded.

6. No separate global symbol configuration
   - Confirm prod never sources universe from static flags in runtime:
     - enforce `TRADING_UNIVERSE_SOURCE=jangar`,
     - keep strategy-level symbol filters optional and scoped to strategy config only.
   - Document a policy that symbols are accepted only via WS/Jangar for live routing.

## Completion sequence (recommended)

1. **Restore signal continuity**
   - Implement/enable ta signal freshness checks and restart recovery jobs in ClickHouse/TA stack.
   - Verify at least 95% window hit rate for 4 consecutive hours.

2. **Re-run LEAN execution telemetry burn-in**
   - 24h paper-only cycle with route provenance metrics and fallback counts.
   - Confirm endpoint counters for route transitions are present in `/metrics`.

3. **Backtest and research replay lock**
   - Add explicit replay script runs for the same decision set used in live cycles.
   - Verify replay and live gate artifacts resolve to the same candidate hash path.

4. **Quant + LLM gate activation**
   - Move from deterministic strategy-only lane to bounded LLM advisory only after:
     - stable strategy profitability,
     - zero critical guardrail violations,
     - successful rollback rehearsal.

5. **Pilot live and gated ramp**
   - Enable live promotion only under approval token flow and staged capital caps.
   - Keep canaries narrow by symbol bucket and increase only on pass criteria at each gate.

## Immediate acceptance criteria

- 24h period with:
  - `signals_total > 0`,
  - non-zero new `trade_decisions` and `executions`,
  - at least one fully populated research row set,
  - stable route metadata on new executions.
- Profitable strategy evidence:
  - positive net realized PnL after cost over paper period,
  - gate report recommending at least `paper`,
  - explicit evidence artifact chain stored in autonomy artifacts and DB.

## Open PR hooks this roadmap maps to

- Signal freshness alerts + lane evidence validation tests.
- Profitability evidence endpoint and promotion gate checks.
- LEAN route telemetry, backfill validation, and reconciliation tests.
- LLM advisory policy hardening for advisory-only mode.
