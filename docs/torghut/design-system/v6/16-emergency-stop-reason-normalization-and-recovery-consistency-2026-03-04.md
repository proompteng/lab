# 16. Emergency Stop Reason Normalization and Recovery Consistency (2026-03-04)

## Status

- Date: `2026-03-04`
- Type: `design ADR + implementation`
- Scope: `torghut trading safety loop`
- Owners: `torghut`, `jangar`
- Objective: prevent false-nonrecoverable latched states caused by duplicate/dirty emergency-stop reason strings.

## Problem Framing

During 2026-03-04 cluster operation, torghut safety logs and evidence show reason strings such as:

- `signal_lag_exceeded:10; signal_lag_exceeded:10`
- `signal_lag_exceeded:10; ; signal_staleness_streak_exceeded:cursor_ahead_of_stream:2`

These compound strings are not consistently normalized before recovery logic evaluation. That causes:

- Duplicate reasons to block accurate recovery accounting.
- Unknown/blank tokens to persist in reason state.
- Non-recoverable handling to depend on raw string shape.
- Rollback evidence and operator-facing status JSON to receive inconsistent reason slices.

The scheduler already supports semicolon-delimited reasons, so the lowest-impact fix is normalization at the reason ingestion boundary.

## Alternatives and Tradeoffs

### Option A: Keep raw reason strings and patch callsites only

- Pros:
  - No schema changes.
  - Minimal code churn.
- Cons:
  - Fails to fix hidden edge cases in already-present callsites.
  - Recovery logic still sensitive to accidental spacing/dedup issues.
  - No single canonical behavior for tests and APIs.

### Option B: Add strict normalization and dedup helpers at reason boundaries (chosen)

- Pros:
  - Deterministic recovery behavior across all reason entry points.
  - Minimal risk, no DB schema changes.
  - Easy to regression-test with unit tests in `test_trading_scheduler_safety.py`.
  - Can be used by future reason analytics without schema migration.
- Cons:
  - State remains stringly typed in-memory.
  - Operators still see semicolon-joined strings unless downstream parsers are updated later.

### Option C: Migrate emergency-stop reasons to structured JSON columns now

- Pros:
  - Long-term query ergonomics and analytics quality are better.
- Cons:
  - Higher blast radius.
  - Requires schema migration, replay/backfill, and API contract updates across at least readiness and rollback surfaces.

## Chosen Design

1. Introduce centralized normalization helpers in `services/torghut/app/trading/scheduler.py`:
   - normalize individual tokens,
   - split semicolon-joined strings,
   - dedupe while preserving deterministic order.
2. Restrict recoverable emergency-stop classification to explicit prefix checks:
   - `signal_lag_exceeded:`
   - `signal_staleness_streak_exceeded:`
3. Evaluate recovery against normalized current reasons and normalized latched reasons so state transitions are consistent.
4. Update recovery branch behavior:
   - non-recoverable current reasons escalate and reset streaks,
   - recoverable reasons refresh latched reason state in canonical form,
   - only clear stop after configured hysteresis when no reason remains.
5. Add regression tests for:
   - split normalization and dedupe,
   - list normalization and dedupe,
   - strict recoverable prefix matching.

## Target Files

- `services/torghut/app/trading/scheduler.py`
- `services/torghut/tests/test_trading_scheduler_safety.py`

## Data/Observability Impact

- Immediate: more stable emergency-stop reason snapshots in:
  - `state.emergency_stop_reason`,
  - readiness/rollback payload generation,
  - rollback evidence files.
- Follow-up (optional):
  - add structured reason list columns only after this change is stable in production and rollout noise is reduced.

## Validation Plan

- Unit tests:
  - `python -m unittest services/torghut/tests/test_trading_scheduler_safety.py` (or discovery target).
- Static checks:
  - `ruff check app tests scripts migrations`,
  - `pyright --project pyrightconfig.json`,
  - `pyright --project pyrightconfig.alpha.json`,
  - `pyright --project pyrightconfig.scripts.json`.
- Runtime evidence:
  - confirm no false nonrecoverable latched states after repeated `signal_lag_exceeded` recovery cycles.
