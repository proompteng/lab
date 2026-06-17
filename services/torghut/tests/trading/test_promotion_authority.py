from app.trading.promotion_authority import (
    PromotionStage,
    capital_allowed_authority,
    capital_blocked_authority,
    paper_probation_authority,
    source_collection_authority,
    target_capital_promotion_allowed,
    target_promotion_stage,
)


def test_source_collection_authority_is_collection_only() -> None:
    authority = source_collection_authority(
        blockers=["runtime_ledger_source_window_missing"],
    )

    fields = authority.as_target_fields()

    assert fields["promotion_stage"] == "source_collection"
    assert fields["source_collection_authorized"] is True
    assert fields["paper_probation_authorized"] is False
    assert fields["bounded_live_paper_collection_authorized"] is True
    assert fields["capital_promotion_allowed"] is False
    assert fields["promotion_allowed"] is False
    assert fields["final_promotion_allowed"] is False
    assert fields["final_promotion_authorized"] is False
    assert fields["final_authority_ok"] is False
    assert fields["promotion_blockers"] == ["runtime_ledger_source_window_missing"]
    assert target_capital_promotion_allowed(fields) is False
    assert target_promotion_stage(fields) is PromotionStage.SOURCE_COLLECTION


def test_paper_probation_authority_is_not_capital_authority() -> None:
    authority = paper_probation_authority(
        blockers=["live_runtime_ledger_required"],
    )

    fields = authority.as_target_fields()

    assert fields["promotion_stage"] == "paper_probation"
    assert fields["paper_probation_authorized"] is True
    assert fields["source_collection_authorized"] is False
    assert fields["capital_promotion_allowed"] is False
    assert fields["promotion_allowed"] is False
    assert fields["final_promotion_allowed"] is False
    assert fields["final_promotion_authorized"] is False
    assert target_capital_promotion_allowed(fields) is False
    assert target_promotion_stage(fields) is PromotionStage.PAPER_PROBATION


def test_capital_blocked_authority_preserves_blockers() -> None:
    authority = capital_blocked_authority(
        blockers=["mean_daily_net_pnl_after_costs_below_500"],
    )

    fields = authority.as_target_fields()

    assert fields["promotion_stage"] == "capital_blocked"
    assert fields["capital_promotion_allowed"] is False
    assert fields["promotion_allowed"] is False
    assert fields["final_promotion_allowed"] is False
    assert fields["promotion_blockers"] == ["mean_daily_net_pnl_after_costs_below_500"]
    assert target_capital_promotion_allowed(fields) is False
    assert target_promotion_stage(fields) is PromotionStage.CAPITAL_BLOCKED


def test_capital_allowed_authority_is_the_only_true_promotion_state() -> None:
    authority = capital_allowed_authority()

    fields = authority.as_target_fields()

    assert authority.stage is PromotionStage.CAPITAL_ALLOWED
    assert fields["promotion_stage"] == "capital_allowed"
    assert fields["capital_promotion_allowed"] is True
    assert fields["promotion_allowed"] is True
    assert fields["final_promotion_allowed"] is True
    assert fields["final_promotion_authorized"] is True
    assert fields["final_authority_ok"] is True
    assert fields["promotion_blockers"] == []
    assert target_capital_promotion_allowed(fields) is True
    assert target_promotion_stage(fields) is PromotionStage.CAPITAL_ALLOWED


def test_legacy_target_stage_falls_back_to_compatible_fields() -> None:
    assert (
        target_promotion_stage({"capital_promotion_allowed": True})
        is PromotionStage.CAPITAL_ALLOWED
    )
    assert (
        target_promotion_stage({"source_collection_authorized": True})
        is PromotionStage.SOURCE_COLLECTION
    )
    assert (
        target_promotion_stage({"paper_probation_authorized": True})
        is PromotionStage.PAPER_PROBATION
    )
    assert target_promotion_stage({}) is PromotionStage.CAPITAL_BLOCKED
