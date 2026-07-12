# Torghut Controller-Ingestion Carry Import

Date: 2026-05-14

Governing design:

- `docs/torghut/design-system/v6/211-torghut-controller-ingestion-carry-and-alpha-no-delta-release-2026-05-14.md`
- Companion Jangar design:
  `docs/agents/designs/205-jangar-controller-ingestion-settlement-and-verification-carry-cutover-2026-05-14.md`

## Runtime Evidence Before Change

Source: `http://torghut.torghut.svc.cluster.local/trading/revenue-repair`

- `business_state=repair_only`
- `revenue_ready=false`
- top queue item: `repair_alpha_readiness` / `hypothesis_not_promotion_eligible`
- affected value gate: `routeable_candidate_count`
- `accepted_routeable_candidate_count=0`
- `max_notional=0`
- no-delta auction reason included `jangar_verification_carry_unavailable`

## Shipped Change

- Added the additive `torghut.jangar-controller-ingestion-carry.v1` reducer.
- The reducer classifies imported Jangar carry as `current`, `repairable`, `lagging`, `unavailable`, `stale`, or
  `contradicted`.
- `/trading/revenue-repair` now emits the full carry import and passes it into the no-delta reentry auction.
- `/readyz` and `/trading/consumer-evidence` mirror the compact
  `torghut.jangar-controller-ingestion-carry-ref.v1` payload.
- The no-delta auction selects `jangar_verify_carry` only when controller-ingestion carry is `repairable`; current,
  unavailable, stale, lagging, or contradicted carry does not open another alpha repair ticket by itself.
- All carry import and selected-ticket paths keep `max_notional=0` and do not alter live submission.

## Validation Plan

- `cd services/torghut && uv run --frozen pytest tests/test_jangar_controller_ingestion_carry.py`
- `cd services/torghut && uv run --frozen pytest tests/test_no_delta_repair_reentry_auction.py`
- `cd services/torghut && uv run --frozen pytest tests/test_build_revenue_repair_digest.py -k revenue_repair`
- `cd services/torghut && uv run --frozen pytest tests/test_trading_api.py -k consumer_evidence`
- `cd services/torghut && uv run --frozen ruff check app/trading tests`
- `cd services/torghut && uv run --frozen ruff format --check app/trading tests`

## Risk And Rollback

Risk is schema drift in the Jangar carry fields. The reducer fails closed: missing or contradictory fields become denial
evidence and cannot enable paper or live capital.

Rollback is to revert the PR or stop consuming `jangar_controller_ingestion_carry`; existing no-delta auction,
alpha-readiness conveyor, dividend ledger, and proof-floor holds continue to keep Torghut at `max_notional=0`.

## Revenue Impact

Target metric is `routeable_candidate_count`. This change does not directly increase routeable candidates; it improves
the top repair lane by replacing opaque `jangar_verification_carry_unavailable` evidence with a typed carry state and a
bounded zero-notional Jangar carry ticket only when the runtime proves the gap is repairable. The smallest current
blocker remains unchanged no-delta alpha-readiness evidence or missing Jangar controller-ingestion carry, depending on
the live post-rollout state.
