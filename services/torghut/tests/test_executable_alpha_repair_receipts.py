from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.executable_alpha_receipts import (
    build_executable_alpha_repair_receipts,
)


NOW = datetime(2026, 5, 13, 22, 55, tzinfo=timezone.utc)


def _top_alpha_queue() -> list[dict[str, object]]:
    return [
        {
            "code": "repair_alpha_readiness",
            "reason": "alpha_readiness_not_promotion_eligible",
            "dimension": "alpha_readiness",
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


def _settlement_ledger() -> dict[str, object]:
    return {
        "schema_version": "torghut.repair-bid-settlement-ledger.v1",
        "ledger_id": "repair-bid-settlement-ledger:test",
        "account_id": "PA3SX7FYNUTF",
        "session_id": "15m",
        "trading_mode": "live",
        "max_notional": "0",
        "routeable_candidate_count": 0,
    }


def _alpha_readiness() -> dict[str, object]:
    return {
        "promotion_eligible_total": 0,
        "repair_target_count": 5,
        "capital_replay_board": {
            "schema_version": "torghut.capital-replay-board.v1",
            "board_id": "capital-replay:test",
        },
        "executable_alpha_receipts": {
            "schema_version": "torghut.executable-alpha-receipts.v1",
            "candidate_receipts": [
                {
                    "receipt_id": "receipt:stale",
                    "hypothesis_id": "H-STALE",
                    "max_notional": "0",
                }
            ],
        },
        "repair_targets": [
            {
                "hypothesis_id": "H-STALE",
                "candidate_id": "candidate-stale",
                "strategy_id": "strategy-stale",
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["hypothesis_window_evidence_stale"],
            },
            {
                "hypothesis_id": "H-LINEAGE",
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["alpha_readiness_not_promotion_eligible"],
            },
            {
                "hypothesis_id": "H-PORTFOLIO",
                "candidate_id": "candidate-portfolio",
                "strategy_id": "strategy-portfolio",
                "state": "blocked",
                "promotion_eligible": False,
                "reasons": ["autoresearch_portfolio_candidates_blocked"],
            },
            {
                "hypothesis_id": "H-TA",
                "candidate_id": "candidate-ta",
                "strategy_id": "strategy-ta",
                "state": "blocked",
                "promotion_eligible": False,
                "reasons": ["equity_ta_rows_missing"],
            },
            {
                "hypothesis_id": "H-DRAG",
                "candidate_id": "candidate-drag",
                "strategy_id": "strategy-drag",
                "state": "blocked",
                "promotion_eligible": False,
                "reasons": ["rejection_drag_unmeasured"],
            },
        ],
    }


def _build(
    *,
    alpha_readiness: Mapping[str, Any] | None = None,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_executable_alpha_repair_receipts(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _top_alpha_queue(),
        alpha_readiness=alpha_readiness or _alpha_readiness(),
        capital=capital or {"max_notional": "0"},
        repair_bid_settlement_ledger=_settlement_ledger(),
    )


def test_alpha_readiness_top_queue_selects_zero_notional_lineage_receipt() -> None:
    payload = _build()

    assert payload["schema_version"] == "torghut.executable-alpha-repair-receipts.v1"
    assert payload["status"] == "selected"
    assert payload["target_value_gate"] == "routeable_candidate_count"
    assert payload["max_notional"] == "0"
    assert payload["capital_rule"] == "zero_notional_repair_only"
    assert payload["reason_codes"] == []
    selected = cast(Mapping[str, Any], payload["selected_receipt"])
    assert selected["schema_version"] == "torghut.executable-alpha-repair-receipt.v1"
    assert selected["hypothesis_id"] == "H-LINEAGE"
    assert selected["repair_class"] == "strategy_lineage_repair"
    assert selected["lineage_status"] == "missing"
    assert selected["target_value_gate"] == "routeable_candidate_count"
    assert selected["max_notional"] == "0"
    assert selected["capital_rule"] == "zero_notional_repair_only"
    assert selected["no_delta_settlement_required"] is True
    assert selected["validation_commands"]
    assert selected["jangar_reentry"]["max_parallelism"] == 1
    receipts = cast(list[Mapping[str, Any]], payload["receipts"])
    assert "receipt:stale" in cast(list[str], receipts[1]["required_input_refs"])


def test_reason_codes_map_to_executable_alpha_repair_classes() -> None:
    payload = _build()
    receipts = cast(list[Mapping[str, Any]], payload["receipts"])

    classes_by_hypothesis = {
        str(receipt["hypothesis_id"]): receipt["repair_class"] for receipt in receipts
    }

    assert classes_by_hypothesis == {
        "H-LINEAGE": "strategy_lineage_repair",
        "H-STALE": "evidence_window_refresh",
        "H-PORTFOLIO": "autoresearch_portfolio_repair",
        "H-TA": "equity_ta_refill",
        "H-DRAG": "rejection_drag_measurement",
    }
    stale = next(
        receipt for receipt in receipts if receipt["hypothesis_id"] == "H-STALE"
    )
    assert stale["evidence_window_status"] == "stale"
    assert stale["expected_gate_delta"] == "retire_hypothesis_window_evidence_stale"
    assert stale["settlement"]["allowed_outcomes"] == [
        "retired",
        "improved",
        "no_delta",
        "invalidated",
    ]


def test_receipts_hold_when_alpha_readiness_is_not_top_queue_item() -> None:
    payload = _build(
        repair_queue=[
            {
                "code": "repair_execution_tca",
                "reason": "execution_tca_stale",
                "value_gate": "fill_tca_or_slippage_quality",
            }
        ]
    )

    assert payload["status"] == "inactive"
    assert payload["selected_receipt"] is None
    assert payload["receipts"] == []
    assert payload["reason_codes"] == ["revenue_repair_top_item_not_alpha_readiness"]


def test_receipts_block_nonzero_notional() -> None:
    payload = _build(capital={"max_notional": "25"})

    assert payload["status"] == "blocked"
    assert payload["selected_receipt"] is None
    assert payload["receipts"] == []
    assert payload["reason_codes"] == ["capital_notional_nonzero"]
