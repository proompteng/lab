from app.trading.evidence_collection_policy import (
    EvidenceCollectionStage,
    collection_blocked_policy,
    evidence_admissibility_policy,
    paper_probation_policy,
    source_collection_policy,
    target_evidence_admissible,
    target_evidence_collection_stage,
)


def _assert_no_capital_authority(fields: dict[str, object]) -> None:
    for key in (
        "capital_promotion_allowed",
        "final_authority_ok",
        "promotion_allowed",
        "final_promotion_allowed",
        "final_promotion_authorized",
    ):
        assert fields[key] is False
    assert fields["strategy_capital_authority_allowed"] is False
    capital_blockers = fields["strategy_capital_authority_blockers"]
    assert isinstance(capital_blockers, list)
    assert "strategy_capital_authority_required" in capital_blockers


def test_source_collection_policy_is_collection_only() -> None:
    fields = source_collection_policy(
        blockers=["live_runtime_ledger_required"],
        bounded_live_paper_collection_authorized=True,
    ).as_target_fields()

    assert fields["source_collection_authorized"] is True
    assert fields["paper_probation_authorized"] is False
    assert fields["evidence_collection_ok"] is True
    assert fields["evidence_admissible"] is False
    assert (
        target_evidence_collection_stage(fields)
        == EvidenceCollectionStage.SOURCE_COLLECTION
    )
    _assert_no_capital_authority(fields)


def test_paper_probation_policy_is_not_capital_authority() -> None:
    fields = paper_probation_policy(
        blockers=["live_runtime_ledger_required"],
    ).as_target_fields()

    assert fields["paper_probation_authorized"] is True
    assert fields["source_collection_authorized"] is False
    assert fields["evidence_admissible"] is False
    assert (
        target_evidence_collection_stage(fields)
        == EvidenceCollectionStage.PAPER_PROBATION
    )
    _assert_no_capital_authority(fields)


def test_admissible_evidence_still_cannot_project_capital_true() -> None:
    fields = evidence_admissibility_policy(blockers=[]).as_target_fields()

    assert fields["evidence_admissible"] is True
    assert target_evidence_admissible(fields) is True
    assert (
        target_evidence_collection_stage(fields)
        == EvidenceCollectionStage.EVIDENCE_ADMISSIBLE
    )
    _assert_no_capital_authority(fields)


def test_collection_block_preserves_reasons_and_legacy_true_is_ignored() -> None:
    fields = collection_blocked_policy(
        blockers=["proof_missing", "proof_missing", "route_missing"],
    ).as_target_fields()

    assert fields["evidence_collection_blockers"] == ["proof_missing", "route_missing"]
    assert target_evidence_admissible(fields) is False
    assert target_evidence_admissible({"capital_promotion_allowed": True}) is False
    assert (
        target_evidence_collection_stage({})
        == EvidenceCollectionStage.COLLECTION_BLOCKED
    )
    _assert_no_capital_authority(fields)
