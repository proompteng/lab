from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.alpha_repair_closure_board import (
    build_alpha_repair_closure_board,
    compact_alpha_repair_closure_board,
)

NOW = datetime(2026, 5, 14, 0, 10, tzinfo=timezone.utc)


def _repair_queue() -> list[dict[str, object]]:
    return [
        {
            "code": "repair_alpha_readiness",
            "reason": "alpha_readiness_not_promotion_eligible",
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
            "reason_codes": ["alpha_readiness_not_promotion_eligible"],
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


def _build(
    *,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
    db_check: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_alpha_repair_closure_board(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _repair_queue(),
        capital=capital or {"max_notional": "0"},
        evidence=_evidence(),
        executable_alpha_repair_receipts=_repair_receipts(),
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
    no_delta_debt = cast(list[Mapping[str, Any]], board["no_delta_debt"])
    assert no_delta_debt[0]["dedupe_key"] == closure["dedupe_key"]
    assert "blocker_set_changes" in no_delta_debt[0]["release_conditions"]


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
    assert compact["no_delta_debt_count"] == 1
    assert compact["max_notional"] == "0"
