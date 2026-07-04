from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, cast

import pytest

from app.trading.alpha_readiness_settlement_conveyor import (
    build_alpha_readiness_settlement_conveyor,
    compact_alpha_readiness_settlement_conveyor,
)

NOW = datetime(2026, 5, 14, 9, 5, tzinfo=timezone.utc)


def _repair_queue() -> list[dict[str, object]]:
    return [
        {
            "code": "repair_alpha_readiness",
            "reason": "hypothesis_not_promotion_eligible",
            "priority": 70,
            "expected_unblock_value": 2,
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
        "routeability_acceptance": {
            "ledger_id": "routeability-acceptance-ledger:test",
            "accepted_routeable_candidate_count": 0,
            "zero_notional_or_stale_evidence_rate": 1,
        },
        "repair_bid_settlement": {
            "ledger_id": "repair-bid-settlement-ledger:test",
            "account_id": "PA3SX7FYNUTF",
            "session_id": "15m",
            "trading_mode": "live",
            "routeable_candidate_count": 0,
        },
        "route_evidence_clearinghouse": {
            "accepted_routeable_candidate_count": 0,
        },
    }


def _window_receipt(
    *,
    receipt_id: str,
    hypothesis_id: str,
    reason_codes: list[str],
    measured_delta: int = 0,
    after_refs: list[str] | None = None,
) -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-evidence-window-receipt.v1",
        "receipt_id": receipt_id,
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "hypothesis_id": hypothesis_id,
        "candidate_id": "chip-paper-microbar-composite@execution-proof",
        "strategy_id": f"strategy:{hypothesis_id}",
        "lane_id": "microstructure-breakout"
        if hypothesis_id == "H-MICRO-01"
        else "continuation",
        "strategy_family": "microstructure_breakout"
        if hypothesis_id == "H-MICRO-01"
        else "intraday_continuation",
        "target_value_gate": "routeable_candidate_count",
        "preserved_reason_codes": reason_codes,
        "retired_reason_codes": [],
        "new_reason_codes": [],
        "after_refs": after_refs or [],
        "required_after_receipts": [
            "alpha_readiness_receipt",
            "capital_replay_board",
            "hypothesis_promotion_receipt",
            "torghut.executable-alpha-receipts.v1",
            "feature_replay_receipt",
            "drift_check_receipt",
            "required_feature_set_receipt",
        ],
        "measured_routeable_candidate_delta": measured_delta,
        "no_delta_reason": "routeable_candidate_count_unchanged"
        if measured_delta <= 0
        else "",
        "dedupe_key": f"dedupe:{hypothesis_id}",
        "max_notional": "0",
        "capital_rule": "zero_notional_repair_only",
        "validation_commands": [
            "uv run --frozen pytest services/torghut/tests/test_executable_alpha_repair_receipts.py -k evidence_window"
        ],
    }


def _foundry() -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-evidence-foundry.v1",
        "foundry_id": "alpha-evidence-foundry:test",
        "status": "selected",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "source_commit": "source-sha",
        "active_revision": "torghut-00384",
        "selected_queue_code": "repair_alpha_readiness",
        "selected_value_gate": "routeable_candidate_count",
        "receipts": [
            _window_receipt(
                receipt_id="alpha-evidence-window-receipt:cont",
                hypothesis_id="H-CONT-01",
                reason_codes=["post_cost_expectancy_non_positive"],
            ),
            _window_receipt(
                receipt_id="alpha-evidence-window-receipt:micro",
                hypothesis_id="H-MICRO-01",
                reason_codes=[
                    "drift_checks_missing",
                    "feature_rows_missing",
                    "required_feature_set_unavailable",
                ],
            ),
            _window_receipt(
                receipt_id="alpha-evidence-window-receipt:rev",
                hypothesis_id="H-REV-01",
                reason_codes=["post_cost_expectancy_non_positive"],
            ),
        ],
    }


def _closure_board() -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-repair-closure-board.v1",
        "board_id": "alpha-repair-closure-board:test",
        "account_id": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "status": "selected",
        "alpha_closure_settlement_market": {
            "market_id": "alpha-closure-settlement-market:test",
            "selected_hypothesis_id": "H-MICRO-01",
            "required_after_receipts": [
                "feature_replay_receipt",
                "drift_check_receipt",
                "required_feature_set_receipt",
            ],
        },
    }


def _build(
    *,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
    foundry: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_alpha_readiness_settlement_conveyor(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _repair_queue(),
        capital=capital or {"capital_state": "zero_notional", "max_notional": "0"},
        evidence=_evidence(),
        alpha_evidence_foundry=foundry or _foundry(),
        alpha_repair_closure_board=_closure_board(),
        source_serving_metadata={
            "build": {
                "commit": "source-sha",
                "active_revision": "torghut-00384",
            }
        },
    )


def test_alpha_readiness_settlement_conveyor_selects_micro_no_delta_lane() -> None:
    conveyor = _build()

    assert (
        conveyor["schema_version"] == "torghut.alpha-readiness-settlement-conveyor.v1"
    )
    assert conveyor["status"] == "no_delta"
    assert conveyor["settlement_state"] == "no_delta"
    assert conveyor["selected_value_gate"] == "routeable_candidate_count"
    assert conveyor["routeable_candidate_count_before"] == 0
    assert conveyor["routeable_candidate_count_after"] == 0
    assert conveyor["max_notional"] == "0"
    selected_lane = cast(Mapping[str, Any], conveyor["selected_lane"])
    assert selected_lane["hypothesis_id"] == "H-MICRO-01"
    assert selected_lane["repeat_launch_decision"] == "deny"
    assert selected_lane["no_delta_release_key"]
    assert "active_no_delta_lease" in conveyor["reason_codes"]
    leases = cast(list[Mapping[str, Any]], conveyor["active_no_delta_leases"])
    assert len(leases) == 3
    assert any(lease["hypothesis_id"] == "H-MICRO-01" for lease in leases)
    receipt = cast(Mapping[str, Any], conveyor["settlement_receipt"])
    assert receipt["schema_version"] == "torghut.alpha-readiness-settlement-receipt.v1"
    assert receipt["hypothesis_id"] == "H-MICRO-01"
    assert receipt["evidence_window_state"] == "no_delta"
    assert receipt["drift_state"] == "missing"
    assert receipt["schema_lineage_state"] == "missing"
    assert "torghut.alpha-readiness-settlement-receipt.v1" in receipt["funded_receipts"]
    assert (
        "torghut.alpha-readiness-settlement-receipt.v1"
        not in receipt["missing_receipts"]
    )
    assert receipt["max_notional"] == "0"


def test_alpha_readiness_settlement_conveyor_marks_paid_when_selected_lane_moves() -> (
    None
):
    foundry = deepcopy(_foundry())
    receipts = cast(list[dict[str, object]], foundry["receipts"])
    receipts[1] = _window_receipt(
        receipt_id="alpha-evidence-window-receipt:micro-paid",
        hypothesis_id="H-MICRO-01",
        reason_codes=["closed_session_signal_hold"],
        measured_delta=1,
        after_refs=[
            "alpha_readiness_receipt:current",
            "capital_replay_board:current",
            "hypothesis_promotion_receipt:current",
            "feature_replay_receipt:current",
            "drift_check_receipt:current",
            "required_feature_set_receipt:current",
        ],
    )

    conveyor = _build(foundry=foundry)

    assert conveyor["status"] == "settling"
    assert conveyor["settlement_state"] == "paid"
    assert conveyor["routeable_candidate_count_after"] == 1
    assert conveyor["measured_routeable_candidate_delta"] == 1
    selected_lane = cast(Mapping[str, Any], conveyor["selected_lane"])
    assert selected_lane["repeat_launch_decision"] == "allow"
    receipt = cast(Mapping[str, Any], conveyor["settlement_receipt"])
    assert receipt["settlement_state"] == "paid"
    assert "feature_replay_receipt" in receipt["funded_receipts"]
    assert "torghut.alpha-readiness-settlement-receipt.v1" in receipt["funded_receipts"]
    assert (
        "torghut.alpha-readiness-settlement-receipt.v1"
        not in receipt["missing_receipts"]
    )


def test_alpha_readiness_settlement_conveyor_quarantines_nonzero_notional() -> None:
    conveyor = _build(capital={"capital_state": "shadow", "max_notional": "25"})

    assert conveyor["status"] == "quarantined"
    assert conveyor["settlement_state"] == "quarantined"
    assert "capital_notional_nonzero" in conveyor["reason_codes"]
    assert conveyor["max_notional"] == "25"


def test_alpha_readiness_settlement_conveyor_observes_non_alpha_queue() -> None:
    conveyor = _build(
        repair_queue=[
            {
                "code": "repair_execution_tca",
                "reason": "execution_tca_stale",
                "value_gate": "fill_tca_or_slippage_quality",
            }
        ]
    )

    assert conveyor["status"] == "observing"
    assert "revenue_repair_top_item_not_alpha_readiness" in conveyor["reason_codes"]


def test_alpha_readiness_settlement_release_key_changes_with_blocker_set() -> None:
    first = _build()
    changed_foundry = deepcopy(_foundry())
    receipts = cast(list[dict[str, object]], changed_foundry["receipts"])
    micro = cast(dict[str, object], receipts[1])
    micro["preserved_reason_codes"] = [
        "drift_checks_missing",
        "feature_rows_missing",
        "required_feature_set_unavailable",
        "schema_lineage_missing",
    ]

    second = _build(foundry=changed_foundry)

    first_lane = cast(Mapping[str, Any], first["selected_lane"])
    second_lane = cast(Mapping[str, Any], second["selected_lane"])
    assert first_lane["no_delta_release_key"] != second_lane["no_delta_release_key"]


def test_alpha_readiness_settlement_compact_ref_and_missing_payload() -> None:
    conveyor = _build()
    compact = compact_alpha_readiness_settlement_conveyor(conveyor)

    assert (
        compact["schema_version"]
        == "torghut.alpha-readiness-settlement-conveyor-ref.v1"
    )
    assert compact["conveyor_id"] == conveyor["conveyor_id"]
    assert compact["selected_hypothesis_id"] == "H-MICRO-01"
    assert compact["settlement_state"] == "no_delta"
    assert compact["active_no_delta_lease_count"] == 3
    assert compact["repeat_launch_decision"] == "deny"
    assert compact["max_notional"] == "0"

    assert compact_alpha_readiness_settlement_conveyor(None) == {
        "schema_version": "torghut.alpha-readiness-settlement-conveyor-ref.v1",
        "status": "missing",
        "reason_codes": ["alpha_readiness_settlement_conveyor_missing"],
    }


def test_alpha_readiness_settlement_conveyor_rejects_naive_generated_at() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_alpha_readiness_settlement_conveyor(
            generated_at=datetime(2026, 5, 14, 9, 5),
            business_state="repair_only",
            revenue_ready=False,
            repair_queue=_repair_queue(),
            capital={"max_notional": "0"},
            evidence=_evidence(),
            alpha_evidence_foundry=_foundry(),
            alpha_repair_closure_board=_closure_board(),
        )
