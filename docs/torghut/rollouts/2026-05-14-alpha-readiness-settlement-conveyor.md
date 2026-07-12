# Torghut Alpha-Readiness Settlement Conveyor Rollout

This rollout note covers the observe-only Torghut alpha-readiness settlement conveyor for the current
`repair_alpha_readiness` revenue blocker.

## Governing Design

- `docs/torghut/design-system/v6/205-torghut-alpha-readiness-settlement-conveyor-and-routeable-profit-runway-2026-05-14.md`
- Companion contract:
  `docs/agents/designs/200-jangar-revenue-repair-settlement-conveyor-and-stage-health-custody-2026-05-14.md`

## Revenue Evidence

Read-only source: `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`.

Before implementation, 2026-05-14T10:03:24Z:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- `alpha_evidence_foundry.next_implementation_milestone=settle alpha evidence-window receipts before any paper or live capital release`

After local implementation, live pre-deploy evidence at 2026-05-14T10:16:25Z still correctly showed:

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- `alpha_closure_settlement_market.status=pending_no_delta`
- `alpha_closure_settlement_market.selected_hypothesis_id=H-MICRO-01`

The runtime route remains zero-notional until the image containing this PR is promoted and the conveyor appears on
`/trading/revenue-repair` and compact consumer evidence.

## What Shipped

- Added `torghut.alpha-readiness-settlement-conveyor.v1` as a pure Torghut read-model.
- Added compact `torghut.alpha-readiness-settlement-conveyor-ref.v1` mirrors to health and consumer evidence payloads.
- Selected `H-MICRO-01` first when the live alpha-readiness evidence matches the accepted design: it is the
  lineage-ready feature/drift lane, while other lanes remain behind post-cost or lineage blockers.
- Added no-delta lease accounting keyed by source ref, evidence window, blocker set, source commit, hypothesis, and
  required receipt set.
- Marked the emitted `torghut.alpha-readiness-settlement-receipt.v1` as funded by the settlement itself so
  `missing_receipts` only names real upstream repair receipts and no longer records the output schema as a
  self-dependency.
- Preserved `max_notional=0`, `capital_rule=zero_notional_repair_only`, and live submission disabled.

## Validation

- `cd services/torghut && /tmp/codex-uv/bin/uv sync --frozen --extra dev`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen ruff format --check app/trading/alpha_readiness_settlement_conveyor.py app/trading/revenue_repair.py app/main.py tests/test_alpha_readiness_settlement_conveyor.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen ruff check app/trading/alpha_readiness_settlement_conveyor.py app/trading/revenue_repair.py app/main.py tests/test_alpha_readiness_settlement_conveyor.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen pytest tests/test_alpha_readiness_settlement_conveyor.py tests/test_alpha_evidence_foundry.py tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k "alpha or revenue_repair or consumer_evidence or settlement_conveyor"`: pass, 43 selected tests
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen pytest tests/test_alpha_readiness_settlement_conveyor.py tests/test_alpha_evidence_foundry.py tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py -k "alpha or revenue_repair or consumer_evidence or settlement_conveyor" --cov --cov-branch --cov-fail-under=0 --cov-report=xml --cov-report=`: pass, 43 selected tests
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen python scripts/check_migration_graph.py`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen pyright --project pyrightconfig.scripts.json`
- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen python scripts/check_diff_coverage.py --coverage-xml coverage.xml --threshold 90`: pass, changed-line coverage 273/287 (95.12%)

Additional broad coverage evidence:

- `cd services/torghut && /tmp/codex-uv/bin/uv run --frozen pytest --cov --cov-branch --cov-report=term-missing --cov-report=xml`
  reached 1,403 passing tests with no failures before the local serial run was stopped in
  `tests/test_run_whitepaper_autoresearch_profit_target.py::TestWhitepaperAutoresearchProfitTarget::test_seed_recent_whitepapers_runs_end_to_end_and_writes_artifacts`.
  CI shards that file into separate runner slices and remains the full required coverage gate for the PR.

## Risk And Rollback

Risk is limited to additive evidence payloads on Torghut health, revenue repair, and consumer evidence. The conveyor is
observe-only and does not execute trades, mutate broker state, change database rows, or alter submit gates.

Rollback is to revert this PR or stop emitting `alpha_readiness_settlement_conveyor` and the compact conveyor ref.
Existing revenue-repair, alpha evidence foundry, alpha repair closure board, proof floor, and capital holds remain
the fallback surfaces. Capital stays `max_notional=0`.

## Owner Status

The revenue metric targeted is `routeable_candidate_count`. The current smallest revenue blocker remains
`hypothesis_not_promotion_eligible`; this PR makes the H-MICRO-01 no-delta/reentry key explicit so repeated
zero-notional repair work can be denied until source, blocker, evidence-window, or required-receipt inputs change.
