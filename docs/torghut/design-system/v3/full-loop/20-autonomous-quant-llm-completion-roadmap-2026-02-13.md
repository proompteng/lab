# Autonomous Quant + LLM Full-Autonomy Completion Roadmap (2026-02-13)

## Status

- Completed: `implemented` (2026-02-25)
- Related PR: `https://github.com/proompteng/lab/pull/3641`
- Implementation scope delivered in this completion pass:
  - deterministic whitepaper engineering trigger grading + dispatch contract,
  - manual approval override path with audit fields,
  - fail-closed automatic rollout transitions with rollback/halt evidence logging.

## Update (2026-02-26)

- Signal continuity/freshness controls referenced in this roadmap are now completed and should not be treated as open priority work.
- Implemented coverage includes:
  - no-signal reason classification + lag handling in `services/torghut/app/trading/ingest.py`,
  - continuity alert latching/recovery, emergency stop integration, and live-promotion block while continuity alert is active in `services/torghut/app/trading/scheduler.py`,
  - status/autonomy and metrics exposure in `services/torghut/app/main.py` and `services/torghut/app/metrics.py`,
  - runtime profitability evidence endpoint at `GET /trading/profitability/runtime` with fixed 72-hour lookback, adapter/fallback attribution, realized-PnL proxy, adverse excursion proxy, and gate/rollback attribution sourced from autonomy artifacts,
  - alert rules in `argocd/applications/observability/graf-mimir-rules.yaml`.

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

1. Signal continuity and freshness (**Completed 2026-02-26**)
   - `no_signal_reason` guards and `ta_signals` lag continuity handling are implemented.
   - Alerting for `no_signals_in_window`, `cursor_ahead_of_stream`, and sustained silence states is implemented.
   - Live promotion is blocked while continuity alert is active.

2. Autonomous evidence ledger continuity
   - Ensure every lane window writes:
     - `research_runs`,
     - `research_candidates`,
     - `research_fold_metrics`,
     - `research_stress_metrics`,
     - `research_promotions` when promotion gates pass/fail.
   - Add a nightly reconciliation check that verifies the full artifact chain for the latest lane IDs.

3. Strategy profitability signal (**Completed 2026-02-26**)
   - Runtime profitability slice is now exposed through `GET /trading/profitability/runtime`:
     - fixed `72h` lookback window metadata (`start`, `end`, counts, `empty`),
     - decisions grouped by `symbol` + `strategy_id`,
     - executions grouped by adapter transition with fallback reason attribution,
     - realized PnL proxy (`-shortfall_notional_total`) and adverse excursion proxy (`p95/max` bps),
     - gate6/promotion and rollback attribution from existing autonomy artifacts.
   - Endpoint caveats explicitly state that payload is evidence-only and does not claim profitability certainty.

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

1. **Signal continuity controls** (**Completed 2026-02-26**)
   - Freshness checks/alerts and continuity promotion block are implemented.
   - Continue runtime monitoring only; do not treat this as missing implementation work.

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

- Signal freshness alerts + lane evidence validation tests (completed).
- Profitability evidence endpoint and promotion gate checks (completed for runtime API surface).
- LEAN route telemetry, backfill validation, and reconciliation tests.
- LLM advisory policy hardening for advisory-only mode.
