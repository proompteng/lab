# Torghut Alpha Evidence Foundry

Date: 2026-05-14

Governing design:

- `docs/torghut/design-system/v6/200-torghut-routeable-alpha-evidence-foundry-and-capital-safe-profit-ladder-2026-05-14.md`
- `docs/torghut/design-system/v6/201-torghut-alpha-closure-settlement-and-feature-replay-market-2026-05-14.md`

Runtime requirement source:

- `GET http://torghut.torghut.svc.cluster.local/trading/revenue-repair`

Before evidence at `2026-05-14T03:01:46Z`:

- `business_state=repair_only`
- `revenue_ready=false`
- top `repair_queue` item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `routeable_candidate_count=0`
- `zero_notional_or_stale_evidence_rate=1.0`
- `max_notional=0`
- `live_submission_allowed=false`

## Change

`alpha_evidence_foundry` is now emitted by `/trading/revenue-repair` as a pure read-model. It consumes the current
alpha-readiness repair receipts and publishes one `torghut.alpha-evidence-window-receipt.v1` per hypothesis so the top
`repair_alpha_readiness` queue item has hypothesis-scoped before evidence, expected routeable-candidate delta, and
no-delta debt.

`/readyz` and `/trading/consumer-evidence` mirror the compact `torghut.alpha-evidence-foundry-ref.v1` with foundry id,
selected value gate, receipt count, selected receipt, no-delta debt count, and zero-notional capital fields.

The change is additive. It does not make `/readyz` green, does not change repair queue order, does not submit orders,
and does not open paper or live notional.

## Validation

Run before release handoff:

- `cd services/torghut && uv run --frozen pytest tests/test_alpha_evidence_foundry.py tests/test_build_revenue_repair_digest.py tests/test_executable_alpha_repair_receipts.py`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k "revenue_repair or consumer_evidence or readyz_returns_200"`
- `cd services/torghut && uv run --frozen ruff format --check app/trading/alpha_evidence_foundry.py app/trading/revenue_repair.py app/main.py scripts/build_revenue_repair_digest.py tests/test_alpha_evidence_foundry.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- `cd services/torghut && uv run --frozen ruff check app/trading/alpha_evidence_foundry.py app/trading/revenue_repair.py app/main.py scripts/build_revenue_repair_digest.py tests/test_alpha_evidence_foundry.py tests/test_build_revenue_repair_digest.py tests/test_trading_api.py`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.alpha.json`
- `cd services/torghut && uv run --frozen pyright --project pyrightconfig.scripts.json`

## Risk And Rollback

Risk is limited to additive payload growth and possible downstream parser assumptions. The compact ref is used on
Jangar-facing surfaces to keep those payloads small.

Rollback is to revert the PR or stop emitting `alpha_evidence_foundry` and keep existing executable-alpha receipts,
alpha repair closure board, proof floor, repair-bid settlement, and capital holds in force. Capital remains
`max_notional=0` with live submission disabled.

## Revenue Status

This targets `routeable_candidate_count`. It improves the repair path by giving the active alpha-readiness lane
receipt-level before evidence and no-delta debt. Immediate revenue impact remains blocked until a later repair
settles feature, drift, post-cost, market-context, and TCA blockers and routeable candidates rise above zero.
