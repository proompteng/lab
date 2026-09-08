from __future__ import annotations

from copy import deepcopy
from datetime import datetime, timezone

import pytest

from app.trading.alpha_closure_dividend_slo import build_alpha_closure_dividend_slo


NOW = datetime(2026, 5, 14, 20, 15, tzinfo=timezone.utc)


def _board(
    *,
    measured_delta: int = 0,
    retired_reason_codes: list[str] | None = None,
    preserved_reason_codes: list[str] | None = None,
    no_delta_budget_state: str = "consumed",
    max_notional: str = "0",
    capital_rule: str = "zero_notional_repair_only",
    fresh_until: str = "2026-05-14T20:30:00+00:00",
) -> dict[str, object]:
    routeable_before = 0
    routeable_after = max(0, routeable_before + measured_delta)
    return {
        "schema_version": "torghut.alpha-repair-closure-board.v1",
        "board_id": "alpha-repair-closure-board:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": fresh_until,
        "selected_value_gate": "routeable_candidate_count",
        "max_notional": max_notional,
        "capital_rule": capital_rule,
        "repair_closures": [
            {
                "closure_id": "alpha-repair-closure:test",
                "hypothesis_id": "H-MICRO-01",
                "dedupe_key": "dedupe-test",
                "value_gate": "routeable_candidate_count",
                "validation_commands": [
                    "uv run --frozen pytest services/torghut/tests/test_alpha_repair_closure_board.py"
                ],
                "max_notional": max_notional,
                "capital_rule": capital_rule,
            }
        ],
        "no_delta_debt": [{"debt_id": "alpha-repair-no-delta:test"}]
        if no_delta_budget_state == "consumed"
        else [],
        "alpha_closure_settlement_market": {
            "schema_version": "torghut.alpha-closure-settlement-market.v1",
            "market_id": "alpha-closure-settlement-market:test",
            "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
            "selected_hypothesis_id": "H-MICRO-01",
            "selected_value_gate": "routeable_candidate_count",
            "selected_repair_class": "feature_replay_closure",
            "required_output_receipt": "torghut.alpha-closure-settlement-receipt.v1",
            "active_dedupe_key": "dedupe-test",
            "max_notional": max_notional,
            "capital_rule": capital_rule,
            "no_delta_budget": {
                "state": no_delta_budget_state,
                "release_conditions": [
                    "evidence_window_changes",
                    "blocker_set_changes",
                    "source_ref_changes",
                ],
            },
            "pending_settlement_receipt": {
                "schema_version": "torghut.alpha-closure-settlement-receipt.v1",
                "receipt_id": "alpha-closure-settlement-receipt:test",
                "hypothesis_id": "H-MICRO-01",
                "retired_reason_codes": retired_reason_codes or [],
                "preserved_reason_codes": preserved_reason_codes
                if preserved_reason_codes is not None
                else ["route_universe_empty"],
                "introduced_reason_codes": [],
                "measured_delta": measured_delta,
                "routeable_candidate_count_before": routeable_before,
                "routeable_candidate_count_after": routeable_after,
                "next_allowed_attempt_after": "2026-05-14T20:30:00+00:00",
                "validation_commands": [
                    "uv run --frozen pytest services/torghut/tests/test_alpha_repair_closure_board.py"
                ],
            },
        },
    }


def test_alpha_closure_dividend_slo_marks_no_delta_debt() -> None:
    slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(),
    )

    assert slo["schema_version"] == "torghut.alpha-closure-dividend-slo.v1"
    assert str(slo["slo_id"]).startswith("alpha-closure-dividend-slo:")
    assert slo["dividend_state"] == "no_delta"
    assert slo["selected_hypothesis_id"] == "H-MICRO-01"
    assert slo["selected_value_gate"] == "routeable_candidate_count"
    assert slo["routeable_candidate_count_before"] == 0
    assert slo["routeable_candidate_count_after"] == 0
    assert slo["measured_delta"] == 0
    assert slo["no_delta_budget_state"] == "consumed"
    assert slo["no_delta_debt_count"] == 1
    assert "alpha_closure_no_delta_budget_consumed" in slo["reason_codes"]
    assert "alpha_closure_no_delta_debt_active" in slo["reason_codes"]
    assert slo["max_notional"] == "0"
    assert slo["capital_rule"] == "zero_notional_repair_only"


def test_alpha_closure_dividend_slo_marks_paid_delta() -> None:
    slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(
            measured_delta=1,
            retired_reason_codes=["hypothesis_not_promotion_eligible"],
            preserved_reason_codes=[],
            no_delta_budget_state="available",
        ),
    )

    assert slo["dividend_state"] == "paid"
    assert slo["routeable_candidate_count_after"] == 1
    assert slo["retired_reason_codes"] == ["hypothesis_not_promotion_eligible"]
    assert "alpha_closure_no_delta_active" not in slo["reason_codes"]


def test_alpha_closure_dividend_slo_marks_stale() -> None:
    slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(fresh_until="2026-05-14T20:00:00+00:00"),
    )

    assert slo["dividend_state"] == "stale"
    assert "alpha_closure_dividend_slo_stale" in slo["reason_codes"]


def test_alpha_closure_dividend_slo_invalidates_nonzero_notional() -> None:
    slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(max_notional="10"),
    )

    assert slo["dividend_state"] == "invalid"
    assert "alpha_closure_capital_not_zero_notional" in slo["reason_codes"]
    assert slo["max_notional"] == "10"


def test_alpha_closure_slo_coerces_counts_and_dedupes_reasons() -> None:
    board = _board(no_delta_budget_state="available")
    market = board["alpha_closure_settlement_market"]
    assert isinstance(market, dict)
    receipt = market["pending_settlement_receipt"]
    assert isinstance(receipt, dict)
    receipt["routeable_candidate_count_before"] = True
    receipt["routeable_candidate_count_after"] = 2.0
    receipt["measured_delta"] = "not-a-number"
    receipt["preserved_reason_codes"] = [
        "route_universe_empty",
        "route_universe_empty",
        "",
    ]

    slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=board,
    )

    assert slo["routeable_candidate_count_before"] == 1
    assert slo["routeable_candidate_count_after"] == 2
    assert slo["measured_delta"] == 1
    assert slo["preserved_reason_codes"] == ["route_universe_empty"]


@pytest.mark.parametrize(
    "fresh_until",
    [
        "not-a-date",
        "2026-05-14T20:30:00",
    ],
)
def test_alpha_closure_dividend_slo_ignores_unparseable_fresh_until(
    fresh_until: str,
) -> None:
    slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(fresh_until=fresh_until),
    )

    assert slo["fresh_until"] == fresh_until
    assert "alpha_closure_dividend_slo_stale" not in slo["reason_codes"]


def test_alpha_closure_dividend_slo_requires_aware_generation_time() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_alpha_closure_dividend_slo(
            generated_at=datetime(2026, 5, 14, 20, 15),
            alpha_repair_closure_board=_board(),
        )


def test_alpha_closure_dividend_slo_invalidates_missing_contract_parts() -> None:
    missing_board_slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=None,
    )
    assert missing_board_slo["dividend_state"] == "invalid"
    assert "alpha_closure_board_missing" in missing_board_slo["reason_codes"]

    missing_market_board = deepcopy(_board())
    del missing_market_board["alpha_closure_settlement_market"]
    missing_market_slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=missing_market_board,
    )
    assert missing_market_slo["dividend_state"] == "invalid"
    assert (
        "alpha_closure_settlement_market_missing" in missing_market_slo["reason_codes"]
    )

    missing_receipt_board = deepcopy(_board())
    missing_receipt_market = missing_receipt_board["alpha_closure_settlement_market"]
    assert isinstance(missing_receipt_market, dict)
    missing_receipt_market["required_output_receipt"] = ""
    missing_receipt_slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=missing_receipt_board,
    )
    assert missing_receipt_slo["dividend_state"] == "invalid"
    assert (
        "alpha_closure_required_settlement_receipt_missing"
        in missing_receipt_slo["reason_codes"]
    )

    non_numeric_notional_slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(max_notional="not-a-number"),
    )
    assert non_numeric_notional_slo["dividend_state"] == "invalid"
    assert (
        "alpha_closure_capital_not_zero_notional"
        in non_numeric_notional_slo["reason_codes"]
    )

    unsafe_capital_rule_slo = build_alpha_closure_dividend_slo(
        generated_at=NOW,
        alpha_repair_closure_board=_board(capital_rule="paper_canary"),
    )
    assert unsafe_capital_rule_slo["dividend_state"] == "invalid"
    assert (
        "alpha_closure_capital_rule_not_zero_notional"
        in unsafe_capital_rule_slo["reason_codes"]
    )
