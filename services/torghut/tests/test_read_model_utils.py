from datetime import timezone

from app.trading.read_model_utils import (
    append_unique_text,
    as_bool,
    as_int,
    as_mapping,
    as_sequence,
    as_text,
    first_mapping,
    is_alpha_readiness_repair,
    parse_datetime_utc,
    routeable_candidate_count,
    stable_hash24,
    unique_text_list,
    zero_notional_or_stale_evidence_rate,
)


def test_coercion_helpers_match_read_model_expectations() -> None:
    assert as_mapping({"a": 1}) == {"a": 1}
    assert as_mapping(["a"]) == {}
    assert as_sequence(["a", "b"]) == ["a", "b"]
    assert as_sequence("ab") == ()
    assert as_text("  value  ") == "value"
    assert as_text(None, default="missing") == "missing"
    assert as_int("4.9") == 4
    assert as_int("nope", default=7) == 7
    assert as_bool("allowed") is True
    assert as_bool("hold", default=True) is False


def test_collection_helpers_dedupe_without_string_splitting() -> None:
    items = unique_text_list(["a", " b ", "a", "", None, "c"])
    assert items == ["a", "b", "c"]

    appended = append_unique_text(["a"], ["b", "a"], " c ", "", None)
    assert appended == ["a", "b", "c"]


def test_timestamp_and_hash_helpers_are_stable() -> None:
    parsed = parse_datetime_utc("2026-05-16T12:30:00Z")
    assert parsed is not None
    assert parsed.tzinfo == timezone.utc
    assert parsed.isoformat() == "2026-05-16T12:30:00+00:00"
    assert parse_datetime_utc("2026-05-16T12:30:00") is None

    first = stable_hash24("prefix", {"b": 2, "a": 1})
    second = stable_hash24("prefix", {"a": 1, "b": 2})
    assert first == second
    assert len(first) == 24


def test_repair_read_model_helpers_extract_shared_contract_fields() -> None:
    assert first_mapping([{}, {"code": "repair_alpha_readiness"}]) == {
        "code": "repair_alpha_readiness"
    }
    assert is_alpha_readiness_repair({"code": "repair_alpha_readiness"})
    assert not is_alpha_readiness_repair(
        {"reason": "hypothesis_not_promotion_eligible"}
    )
    assert not is_alpha_readiness_repair({"code": "repair_market_context"})

    evidence = {
        "repair_bid_settlement": {"routeable_candidate_count": "2"},
        "routeability_acceptance": {
            "accepted_routeable_candidate_count": 5,
            "zero_notional_or_stale_evidence_rate": "0.25",
        },
        "route_evidence_clearinghouse": {"accepted_routeable_candidate_count": 3},
    }
    assert routeable_candidate_count(evidence) == 5
    assert zero_notional_or_stale_evidence_rate(evidence) == "0.25"
