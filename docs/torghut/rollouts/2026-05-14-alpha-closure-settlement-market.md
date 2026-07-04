# Torghut Alpha Closure Settlement Market

Date: 2026-05-14

Governing design:

- `docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`
- `docs/torghut/design-system/v6/198-torghut-alpha-repair-closure-board-and-routeable-revenue-reentry-2026-05-14.md`

Runtime requirement source:

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`

Before evidence at `2026-05-14T02:17:19Z`:

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- `live_submission_allowed=false`
- live alpha repair closure selected `H-CONT-01`

## Change

`alpha_repair_closure_board` now includes a nested
`torghut.alpha-closure-settlement-market.v1` object. The market follows doc 201 by selecting `H-MICRO-01` as the first
feature-replay closure while the live alpha-readiness queue remains topped by
`hypothesis_not_promotion_eligible` and the hypothesis carries feature, drift, or required feature-set blockers.

The market carries:

- selected hypothesis, repair class, and lot class;
- required `torghut.alpha-closure-settlement-receipt.v1`;
- required after-receipts for alpha readiness, promotion custody, capital replay, feature replay, drift checks, and
  required feature-set proof;
- active dedupe key and no-delta budget;
- pending settlement receipt template with before blockers and routeable-candidate before/after counts;
- `max_notional=0` and `capital_rule=zero_notional_repair_only`.

`/readyz` and `/trading/consumer-evidence` continue to expose only compact board refs, now including the market id,
selected hypothesis, selected repair class, settlement receipt requirement, active dedupe key, and no-delta state.

## Validation

Run before release handoff:

- `cd services/torghut && uv run --frozen pytest tests/test_alpha_repair_closure_board.py tests/test_build_revenue_repair_digest.py -k "alpha_repair_closure or revenue_repair"`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k "revenue_repair or alpha_repair_closure"`
- `cd services/torghut && uv run --frozen ruff format --check app/trading/alpha_repair_closure_board.py app/trading/revenue_repair.py tests/test_alpha_repair_closure_board.py`
- `cd services/torghut && uv run --frozen ruff check app/trading/alpha_repair_closure_board.py app/trading/revenue_repair.py tests/test_alpha_repair_closure_board.py`

## Risk And Rollback

Risk is limited to additive read-model output. The change does not submit orders, write trading records, enable paper or
live notional, or change `/readyz` admission status.

Rollback is to revert the PR or stop emitting `alpha_closure_settlement_market` from `alpha_repair_closure_board`.
Keep existing revenue-repair, executable-alpha, repair-bid settlement, and repair-outcome dividend payloads. Capital
must remain `max_notional=0` with live submission disabled.

## Revenue Status

This targets `routeable_candidate_count`. It improves the next repair admission step by selecting the lineage-ready
`H-MICRO-01` feature replay lane and blocking duplicate no-delta launches until the evidence key changes. Immediate
revenue impact remains blocked until a settlement receipt retires feature, drift, or required feature-set blockers and
routeable candidates rise above zero.
