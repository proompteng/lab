# Iteration 2 - Rollback gate hardening for governed actuation

Date: 2026-03-01

Scope:
- Preserve deterministic hard-gating by separating paper patch emission from final actuation eligibility.
- Preserve deterministic hard-gating by tying persistence promotion flags to `actuation_allowed`.
- Extend tests for fail-path enforcement in both artifact and persisted-ledger outcomes.
- Record implementation updates in the artifact trail.

Changes made:
1. `services/torghut/app/trading/autonomy/lane.py`
   - Added explicit `actuation_allowed` computation before actuation intent build.
   - Kept paper patch generation tied to paper recommendation success (`promotion_allowed` + paper mode), while preserving hard-gating through actuation intent and persistence state.
   - Wired `actuation_allowed` through persistence helpers so ledger write paths use an effective promotion decision (`promotion_allowed && actuation_allowed`).
   - Applied effective promotion state to:
     - candidate role/status (`challenger` + `evaluated` when hard gate fails),
     - lifecycle metadata (`promotable`/`actuation_allowed`),
     - evidence bundle (`actuation_allowed`),
     - promotion decision record (`promotion_allowed`, `approve_reason`/`deny_reason`, `approved_mode`, `effective_time`).

2. `services/torghut/tests/test_autonomous_lane.py`
   - Extended rollback-fail coverage to assert `actuation_allowed=false` and ledger rejection when rollback readiness is blocked.
   - Added regression test `test_lane_does_not_persist_promotion_when_rollback_not_ready` verifying persisted ledger remains non-promotable when rollback checks fail.

Pass/fail validation added:
- Pass path: existing paper target flow still writes `actuation-intent.json` when readiness passes.
- Fail path: mocked rollback readiness failure now keeps `actuation_allowed=false` and prevents persisted promotion status.
- New test validates persisted metadata/evidence and reject state when effective actuation is blocked.

Test plan to run next:
- `bun run --filter @proompteng/backend test -- services/torghut/tests/test_autonomous_lane.py`
- `bun run --filter @proompteng/backend test -- services/torghut/tests/test_trading_scheduler_autonomy.py`
