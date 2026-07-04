# Torghut Alpha Repair Dividend Ledger Rollout

This rollout note covers the observe-only Torghut alpha repair dividend ledger for the current
`repair_alpha_readiness` revenue blocker.

## Governing Design

- `docs/torghut/design-system/v6/204-torghut-alpha-repair-dividend-ledger-and-custody-flight-recorder-2026-05-14.md`
- Companion contract:
  `docs/agents/designs/199-jangar-material-action-custody-flight-recorder-and-merge-reentry-slo-2026-05-14.md`
- Upstream conveyor contract:
  `docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`

## Revenue Evidence

Read-only source: `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`.

Before implementation, 2026-05-14T11:05:48Z:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- active live source commit: `6f7f0fbd2f7746a62d899c2962662caba97020b2`
- `alpha_readiness_settlement_conveyor` was not yet present in the live payload
- `alpha_repair_dividend_ledger` was not yet present in the live payload

After local implementation, live pre-deploy evidence is expected to remain repair-only until image promotion:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item remains `repair_alpha_readiness` until alpha readiness is actually settled
- `max_notional=0`
- live submission remains disabled

## What Shipped

- Added `torghut.alpha-repair-dividend-ledger.v1` as a pure Torghut read-model under `/trading/revenue-repair`.
- Added compact `torghut.alpha-repair-dividend-ledger-ref.v1` mirrors to `/readyz` and
  `/trading/consumer-evidence`.
- The ledger records selected hypothesis, value gate, before/after routeable candidate counts, measured delta,
  preserved/retired blockers, no-delta release key, required receipts, validation command, and Jangar custody
  launch decision.
- Repeated no-delta alpha repair is `launch_decision=deny` until source ref, evidence window, blocker set, or required
  receipt set changes.
- Preserved `max_notional=0`, `capital_rule=zero_notional_repair_only`, and live submission disabled.

## Validation

- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv sync --frozen --extra dev`
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen ruff format --check app/trading/alpha_repair_dividend_ledger.py app/trading/revenue_repair.py app/main.py tests/test_alpha_repair_dividend_ledger.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen ruff check app/trading/alpha_repair_dividend_ledger.py app/trading/revenue_repair.py app/main.py tests/test_alpha_repair_dividend_ledger.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_alpha_repair_dividend_ledger.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k "alpha_repair_dividend or revenue_repair or consumer_evidence"`:
  pass, 27 selected tests
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_alpha_repair_dividend_ledger.py tests/test_alpha_readiness_settlement_conveyor.py tests/test_alpha_evidence_foundry.py tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k "alpha or revenue_repair or consumer_evidence or settlement_conveyor or dividend" --cov --cov-branch --cov-fail-under=0 --cov-report=xml --cov-report=`:
  pass, 54 selected tests
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90`:
  pass, changed-line coverage 202/216 (93.52%)
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_repair_bid_settlement.py -k promotion_custody`:
  pass, 1 selected test
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pytest tests/test_executable_alpha_repair_receipts.py -k evidence_window`:
  pass, 1 selected test
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen python scripts/check_migration_graph.py`:
  pass
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pyright --project pyrightconfig.json`:
  pass
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pyright --project pyrightconfig.alpha.json`:
  pass
- `cd services/torghut && /tmp/codex-uv-bootstrap/bin/uv run --frozen pyright --project pyrightconfig.scripts.json`:
  pass

## Risk And Rollback

Risk is limited to additive evidence payloads on Torghut revenue repair, health, and consumer evidence. The ledger is
observe-only and does not execute trades, mutate broker state, change database rows, or alter submit gates.

Rollback is to revert this PR or stop emitting `alpha_repair_dividend_ledger` and the compact dividend ledger ref.
Existing revenue-repair, alpha evidence foundry, alpha readiness settlement conveyor, proof floor, and capital holds
remain the fallback surfaces. Capital stays `max_notional=0`.

## Owner Status

The revenue metric targeted is `routeable_candidate_count`. The current smallest revenue blocker remains
`hypothesis_not_promotion_eligible`; this PR adds compact dividend accounting so Torghut and Jangar can prove
whether the selected alpha repair paid, no-deltaed, or must be held before another zero-notional repair launch.
