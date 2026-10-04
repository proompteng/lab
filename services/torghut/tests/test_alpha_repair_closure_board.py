from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

import pytest

from app.trading.alpha_repair_closure_board import (
    build_alpha_repair_closure_board,
    compact_alpha_repair_closure_board,
)

NOW = datetime(2026, 5, 14, 0, 10, tzinfo=timezone.utc)


def _repair_queue() -> list[dict[str, object]]:
    return [
        {
            "code": "repair_alpha_readiness",
            "reason": "hypothesis_not_promotion_eligible",
            "priority": 70,
            "expected_unblock_value": 4,
            "value_gate": "routeable_candidate_count",
            "required_output_receipt": "torghut.executable-alpha-receipts.v1",
            "required_receipts": [
                "alpha_readiness_receipt",
                "hypothesis_promotion_receipt",
                "capital_replay_board",
            ],
            "max_notional": "0",
            "capital_rule": "zero_notional_repair_only",
        }
    ]


def _evidence() -> dict[str, object]:
    return {
        "alpha_readiness": {
            "capital_replay_board": {
                "schema_version": "torghut.capital-replay-board.v1",
                "board_id": "capital-replay:test",
            }
        },
        "repair_bid_settlement": {
            "ledger_id": "repair-bid-settlement-ledger:test",
            "account_id": "PA3SX7FYNUTF",
            "session_id": "15m",
            "trading_mode": "live",
            "routeable_candidate_count": 0,
        },
        "routeability_acceptance": {
            "accepted_routeable_candidate_count": 0,
        },
    }


def _repair_receipts() -> dict[str, object]:
    return {
        "schema_version": "torghut.executable-alpha-repair-receipts.v1",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "status": "selected",
        "selected_receipt_id": "executable-alpha-repair-receipt:test",
        "selected_receipt": {
            "receipt_id": "executable-alpha-repair-receipt:test",
            "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
            "hypothesis_id": "H-AAPL-ROUTE-REHAB",
            "reason_codes": ["hypothesis_not_promotion_eligible"],
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k promotion"
            ],
            "max_notional": "0",
            "capital_rule": "zero_notional_repair_only",
            "rollback_target": (
                "stop emitting executable_alpha_repair_receipts and keep Torghut max_notional=0"
            ),
        },
    }


def _feature_repair_receipts() -> dict[str, object]:
    payload = _repair_receipts()
    payload["selected_receipt_id"] = "executable-alpha-repair-receipt:cont"
    payload["selected_receipt"] = {
        "receipt_id": "executable-alpha-repair-receipt:cont",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "hypothesis_id": "H-CONT-01",
        "candidate_id": "candidate-cont",
        "strategy_id": "strategy-cont",
        "lineage_status": "ready",
        "repair_class": "evidence_window_refresh",
        "reason_codes": ["post_cost_expectancy_non_positive"],
        "validation_commands": [
            "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window"
        ],
        "required_output_receipts": [
            "alpha_readiness_receipt",
            "hypothesis_promotion_receipt",
            "capital_replay_board",
            "torghut.executable-alpha-receipts.v1",
        ],
        "max_notional": "0",
        "capital_rule": "zero_notional_repair_only",
    }
    payload["receipts"] = [
        payload["selected_receipt"],
        {
            "receipt_id": "executable-alpha-repair-receipt:micro",
            "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
            "hypothesis_id": "H-MICRO-01",
            "candidate_id": "chip-paper-microbar-composite@execution-proof",
            "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
            "lineage_status": "ready",
            "repair_class": "evidence_window_refresh",
            "reason_codes": [
                "drift_checks_missing",
                "feature_rows_missing",
                "required_feature_set_unavailable",
            ],
            "validation_commands": [
                "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window"
            ],
            "required_output_receipts": [
                "alpha_readiness_receipt",
                "hypothesis_promotion_receipt",
                "capital_replay_board",
                "torghut.executable-alpha-receipts.v1",
            ],
            "max_notional": "0",
            "capital_rule": "zero_notional_repair_only",
        },
    ]
    return payload


def _build(
    *,
    generated_at: datetime = NOW,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
    evidence: Mapping[str, Any] | None = None,
    repair_receipts: Mapping[str, Any] | None = None,
    db_check: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_alpha_repair_closure_board(
        generated_at=generated_at,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _repair_queue(),
        capital=capital or {"max_notional": "0"},
        evidence=evidence or _evidence(),
        executable_alpha_repair_receipts=repair_receipts or _repair_receipts(),
        source_serving_metadata={
            "build": {
                "commit": "source-sha",
                "active_revision": "torghut-00371",
                "image_digest": "sha256:test",
            }
        },
        db_check=db_check or {"schema_current": True},
    )


def test_alpha_repair_closure_board_selects_zero_notional_top_alpha_repair() -> None:
    board = _build()

    assert board["schema_version"] == "torghut.alpha-repair-closure-board.v1"
    assert board["status"] == "selected"
    assert board["selected_value_gate"] == "routeable_candidate_count"
    assert board["routeable_candidate_count"] == 0
    assert board["max_notional"] == "0"
    assert board["capital_rule"] == "zero_notional_repair_only"
    assert board["db_schema_current"] is True
    closure = cast(list[Mapping[str, Any]], board["repair_closures"])[0]
    assert closure["queue_code"] == "repair_alpha_readiness"
    assert closure["required_output_receipt"] == "torghut.executable-alpha-receipts.v1"
    assert closure["routeable_candidate_count_before"] == 0
    assert closure["measured_delta"] == 0
    assert closure["no_delta_reason"] == "routeable_candidate_count_unchanged"
    assert closure["max_notional"] == "0"
    assert closure["validation_commands"]
    market = cast(Mapping[str, Any], board["alpha_closure_settlement_market"])
    assert market["schema_version"] == "torghut.alpha-closure-settlement-market.v1"
    assert (
        market["required_output_receipt"]
        == "torghut.alpha-closure-settlement-receipt.v1"
    )
    assert market["active_dedupe_key"] == closure["dedupe_key"]
    assert market["no_delta_budget"]["state"] == "consumed"
    no_delta_debt = cast(list[Mapping[str, Any]], board["no_delta_debt"])
    assert no_delta_debt[0]["dedupe_key"] == closure["dedupe_key"]
    assert "blocker_set_changes" in no_delta_debt[0]["release_conditions"]


def test_alpha_repair_closure_board_selects_micro_feature_replay_market_first() -> None:
    board = _build(repair_receipts=_feature_repair_receipts())

    closure = cast(list[Mapping[str, Any]], board["repair_closures"])[0]
    assert closure["hypothesis_id"] == "H-MICRO-01"
    assert closure["reason_code"] == "hypothesis_not_promotion_eligible"
    assert closure["max_notional"] == "0"
    market = cast(Mapping[str, Any], board["alpha_closure_settlement_market"])
    assert market["selected_hypothesis_id"] == "H-MICRO-01"
    assert market["selected_repair_class"] == "feature_replay_closure"
    assert market["selected_lot_class"] == "feature_lineage"
    assert market["selected_value_gate"] == "routeable_candidate_count"
    assert (
        market["required_output_receipt"]
        == "torghut.alpha-closure-settlement-receipt.v1"
    )
    assert market["required_after_receipts"][-3:] == [
        "feature_replay_receipt",
        "drift_check_receipt",
        "required_feature_set_receipt",
    ]
    assert market["before_blocker_codes"] == [
        "drift_checks_missing",
        "feature_rows_missing",
        "required_feature_set_unavailable",
    ]
    pending_receipt = cast(Mapping[str, Any], market["pending_settlement_receipt"])
    assert (
        pending_receipt["schema_version"]
        == "torghut.alpha-closure-settlement-receipt.v1"
    )
    assert pending_receipt["hypothesis_id"] == "H-MICRO-01"
    assert pending_receipt["repair_class"] == "feature_replay_closure"
    assert pending_receipt["routeable_candidate_count_before"] == 0
    assert pending_receipt["routeable_candidate_count_after"] == 0
    assert pending_receipt["max_notional"] == "0"


def test_alpha_repair_closure_board_accepts_string_db_schema_flags() -> None:
    selected = _build(db_check={"schema_current": "allow"})
    held = _build(db_check={"schema_current": "hold"})
    default_held = _build(db_check={"schema_current": "unknown"})

    assert selected["status"] == "selected"
    assert selected["db_schema_current"] is True
    assert held["status"] == "held"
    assert held["db_schema_current"] is False
    assert default_held["status"] == "held"
    assert "db_check_schema_not_current" in default_held["reason_codes"]


def test_alpha_repair_closure_board_uses_receipt_fallback_and_positive_delta() -> None:
    repair_receipts = _repair_receipts()
    selected_receipt = cast(dict[str, object], repair_receipts.pop("selected_receipt"))
    selected_receipt["measured_delta"] = "2.0"
    selected_receipt["reason_codes"] = [
        "hypothesis_not_promotion_eligible",
        "hypothesis_not_promotion_eligible",
        "",
    ]
    repair_receipts["receipts"] = [selected_receipt]
    evidence = _evidence()
    repair_bid_settlement = cast(dict[str, object], evidence["repair_bid_settlement"])
    routeability_acceptance = cast(
        dict[str, object], evidence["routeability_acceptance"]
    )
    repair_bid_settlement["routeable_candidate_count"] = True
    routeability_acceptance["accepted_routeable_candidate_count"] = 4.7
    evidence["route_evidence_clearinghouse"] = {
        "accepted_routeable_candidate_count": "not-a-count",
    }

    board = _build(evidence=evidence, repair_receipts=repair_receipts)

    closure = cast(list[Mapping[str, Any]], board["repair_closures"])[0]
    assert board["routeable_candidate_count"] == 4
    assert closure["measured_delta"] == 2
    assert closure["no_delta_reason"] == ""
    assert board["no_delta_debt"] == []
    assert closure["before_refs"][-1] == "executable-alpha-repair-receipt:test"
    assert (
        closure["required_receipts"].count("torghut.executable-alpha-receipts.v1") == 1
    )


def test_alpha_repair_closure_board_rejects_naive_generated_at() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        _build(generated_at=datetime(2026, 5, 14, 0, 10))


def test_alpha_repair_closure_board_holds_when_db_schema_is_not_current() -> None:
    board = _build(db_check={"schema_current": False})

    assert board["status"] == "held"
    assert board["db_schema_current"] is False
    assert "db_check_schema_not_current" in board["reason_codes"]
    assert board["max_notional"] == "0"


def test_alpha_repair_closure_board_blocks_nonzero_notional() -> None:
    board = _build(capital={"max_notional": "25"})

    assert board["status"] == "blocked"
    assert "capital_notional_nonzero" in board["reason_codes"]
    assert board["max_notional"] == "25"


def test_alpha_repair_closure_board_inactive_when_top_queue_is_not_alpha() -> None:
    board = _build(
        repair_queue=[
            {
                "code": "repair_execution_tca",
                "reason": "execution_tca_stale",
                "value_gate": "fill_tca_or_slippage_quality",
            }
        ]
    )

    assert board["status"] == "inactive"
    assert "revenue_repair_top_item_not_alpha_readiness" in board["reason_codes"]
    assert board["repair_closures"] == []
    assert board["no_delta_debt"] == []


def test_compact_alpha_repair_closure_board_returns_jangar_facing_ref() -> None:
    board = _build()
    compact = compact_alpha_repair_closure_board(board)

    assert compact["schema_version"] == "torghut.alpha-repair-closure-board-ref.v1"
    assert compact["board_id"] == board["board_id"]
    assert compact["status"] == "selected"
    assert compact["selected_value_gate"] == "routeable_candidate_count"
    assert compact["required_output_receipt"] == "torghut.executable-alpha-receipts.v1"
    assert (
        compact["required_settlement_receipt"]
        == "torghut.alpha-closure-settlement-receipt.v1"
    )
    assert compact["selected_hypothesis_id"] == "H-AAPL-ROUTE-REHAB"
    assert compact["active_dedupe_key"]
    assert compact["no_delta_budget_state"] == "consumed"
    assert compact["no_delta_debt_count"] == 1
    assert compact["max_notional"] == "0"


def test_compact_alpha_repair_closure_board_reports_missing_payload() -> None:
    compact = compact_alpha_repair_closure_board(None)

    assert compact == {
        "schema_version": "torghut.alpha-repair-closure-board-ref.v1",
        "status": "missing",
        "reason_codes": ["alpha_repair_closure_board_missing"],
    }


def test_compact_alpha_repair_closure_board_tolerates_non_sequence_closures() -> None:
    compact = compact_alpha_repair_closure_board(
        {
            "schema_version": "torghut.alpha-repair-closure-board.v1",
            "status": "held",
            "reason_codes": "not-a-list",
            "repair_closures": "not-a-list",
            "no_delta_debt": "not-a-list",
            "top_queue_item_ref": {
                "required_output_receipt": "torghut.executable-alpha-receipts.v1",
            },
        }
    )

    assert compact["reason_codes"] == []
    assert compact["top_closure_id"] is None
    assert compact["required_output_receipt"] == "torghut.executable-alpha-receipts.v1"
    assert compact["no_delta_debt_count"] == 0
