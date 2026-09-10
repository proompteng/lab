from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timedelta, timezone
from typing import Any, cast

import pytest

from app.trading.alpha_repair_dividend_ledger import (
    build_alpha_repair_dividend_ledger,
    compact_alpha_repair_dividend_ledger,
)

NOW = datetime(2026, 5, 14, 11, 20, tzinfo=timezone.utc)


def _repair_queue() -> list[dict[str, object]]:
    return [
        {
            "code": "repair_alpha_readiness",
            "reason": "hypothesis_not_promotion_eligible",
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
        },
        "repair_bid_settlement": {
            "ledger_id": "repair-bid-settlement-ledger:test",
            "routeable_candidate_count": 0,
        },
        "route_evidence_clearinghouse": {
            "accepted_routeable_candidate_count": 0,
        },
    }


def _repair_bid_settlement() -> dict[str, object]:
    return {
        "ledger_id": "repair-bid-settlement-ledger:test",
        "account_id": "PA3SX7FYNUTF",
        "session_id": "15m",
        "trading_mode": "live",
        "selected_lot_ids": ["compacted-repair-lot:alpha"],
        "routeable_candidate_count": 0,
    }


def _executable_alpha_repair_receipts() -> dict[str, object]:
    return {
        "schema_version": "torghut.executable-alpha-repair-receipts.v1",
        "receipt_set_id": "executable-alpha-repair-receipts:test",
        "required_output_receipt": "torghut.executable-alpha-receipts.v1",
        "selected_receipt": {
            "receipt_id": "executable-alpha-repair-receipt:micro",
            "hypothesis_id": "H-MICRO-01",
            "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
            "repair_class": "evidence_window_refresh",
            "max_notional": "0",
        },
        "receipts": [
            {
                "receipt_id": "executable-alpha-repair-receipt:micro",
                "hypothesis_id": "H-MICRO-01",
                "max_notional": "0",
            }
        ],
    }


def _settlement_slots() -> dict[str, object]:
    return {
        "schema_version": "torghut.executable-alpha-settlement-slots.v1",
        "slot_set_id": "executable-alpha-settlement-slots:test",
        "max_notional": "0",
    }


def _alpha_foundry() -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-evidence-foundry.v1",
        "foundry_id": "alpha-evidence-foundry:test",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "status": "selected",
    }


def _closure_board() -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-repair-closure-board.v1",
        "board_id": "alpha-repair-closure-board:test",
        "alpha_closure_settlement_market": {
            "market_id": "alpha-closure-settlement-market:test",
            "account_id": "PA3SX7FYNUTF",
            "window": "15m",
            "trading_mode": "live",
            "selected_hypothesis_id": "H-MICRO-01",
            "selected_repair_class": "feature_replay_closure",
            "pending_settlement_receipt": {
                "receipt_id": "alpha-closure-settlement-receipt:test",
                "preserved_reason_codes": [
                    "drift_checks_missing",
                    "feature_rows_missing",
                ],
                "next_allowed_attempt_after": (NOW + timedelta(minutes=15)).isoformat(),
                "validation_commands": [
                    "uv run --frozen pytest services/torghut/tests/test_alpha_repair_closure_board.py"
                ],
            },
        },
    }


def _conveyor(
    *,
    measured_delta: int = 0,
    repeat_launch_decision: str = "deny",
    release_key: str | None = "release-key:micro",
    reason_codes: list[str] | None = None,
    fresh_until: datetime | None = None,
) -> dict[str, object]:
    blockers = reason_codes or [
        "drift_checks_missing",
        "feature_rows_missing",
        "required_feature_set_unavailable",
    ]
    selected_lane: dict[str, object] = {
        "hypothesis_id": "H-MICRO-01",
        "candidate_id": "chip-paper-microbar-composite@execution-proof",
        "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
        "lane_id": "microstructure-breakout",
        "before_reason_codes": blockers,
        "required_receipts": [
            "alpha_readiness_receipt",
            "capital_replay_board",
            "hypothesis_promotion_receipt",
            "feature_replay_receipt",
        ],
        "repeat_launch_decision": repeat_launch_decision,
        "measured_routeable_candidate_delta": measured_delta,
        "max_notional": "0",
    }
    if release_key is not None:
        selected_lane["no_delta_release_key"] = release_key
    settlement_state = "paid" if measured_delta > 0 else "no_delta"
    return {
        "schema_version": "torghut.alpha-readiness-settlement-conveyor.v1",
        "conveyor_id": "alpha-readiness-settlement-conveyor:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": (fresh_until or NOW + timedelta(minutes=15)).isoformat(),
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "source_commit": "source-sha",
        "account_id": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "status": "settling" if measured_delta > 0 else "no_delta",
        "settlement_state": settlement_state,
        "selected_value_gate": "routeable_candidate_count",
        "routeable_candidate_count_before": 0,
        "routeable_candidate_count_after": measured_delta,
        "measured_routeable_candidate_delta": measured_delta,
        "max_notional": "0",
        "selected_lane": selected_lane,
        "lane_scores": [selected_lane],
        "required_receipts": selected_lane["required_receipts"],
        "settlement_receipt": {
            "schema_version": "torghut.alpha-readiness-settlement-receipt.v1",
            "receipt_id": "alpha-readiness-settlement-receipt:micro",
            "hypothesis_id": "H-MICRO-01",
            "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
            "lane_id": "microstructure-breakout",
            "settlement_state": settlement_state,
            "routeable_candidate_count_before": 0,
            "routeable_candidate_count_after": measured_delta,
            "measured_routeable_candidate_delta": measured_delta,
            "preserved_reason_codes": blockers if measured_delta <= 0 else [],
            "retired_reason_codes": ["drift_checks_missing"]
            if measured_delta > 0
            else [],
            "new_reason_codes": [],
            "evidence_window_id": "alpha-evidence-window-receipt:micro",
            "no_delta_release_key": release_key or "",
            "repeat_launch_decision": repeat_launch_decision,
            "missing_receipts": ["feature_replay_receipt"]
            if measured_delta <= 0
            else [],
            "funded_receipts": ["feature_replay_receipt"] if measured_delta > 0 else [],
        },
        "validation_commands": [
            "uv run --frozen pytest services/torghut/tests/test_alpha_readiness_settlement_conveyor.py"
        ],
    }


def _build(
    *,
    conveyor: Mapping[str, Any] | None = None,
    capital: Mapping[str, Any] | None = None,
    repair_queue: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return build_alpha_repair_dividend_ledger(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _repair_queue(),
        capital=capital or {"capital_state": "zero_notional", "max_notional": "0"},
        evidence=_evidence(),
        repair_bid_settlement_ledger=_repair_bid_settlement(),
        executable_alpha_repair_receipts=_executable_alpha_repair_receipts(),
        executable_alpha_settlement_slots=_settlement_slots(),
        alpha_evidence_foundry=_alpha_foundry(),
        alpha_repair_closure_board=_closure_board(),
        alpha_readiness_settlement_conveyor=_conveyor()
        if conveyor is None
        else conveyor,
    )


def test_alpha_repair_dividend_ledger_records_no_delta_launch_denial() -> None:
    ledger = _build()

    assert ledger["schema_version"] == "torghut.alpha-repair-dividend-ledger.v1"
    assert ledger["dividend_state"] == "no_delta"
    assert ledger["selected_value_gate"] == "routeable_candidate_count"
    assert ledger["routeable_candidate_count_before"] == 0
    assert ledger["routeable_candidate_count_after"] == 0
    assert ledger["measured_delta"] == 0
    assert ledger["selected_hypothesis_id"] == "H-MICRO-01"
    assert ledger["no_delta_release_key"] == "release-key:micro"
    assert ledger["max_notional"] == "0"
    assert "active_no_delta_release_key" in ledger["reason_codes"]
    custody = cast(Mapping[str, Any], ledger["jangar_custody"])
    assert custody["required_recorder_schema"] == (
        "jangar.material-action-custody-flight-recorder.v1"
    )
    assert custody["launch_decision"] == "deny"


def test_alpha_repair_dividend_ledger_marks_paid_when_routeable_count_moves() -> None:
    ledger = _build(
        conveyor=_conveyor(
            measured_delta=1,
            repeat_launch_decision="allow",
            release_key="release-key:micro-paid",
        )
    )

    assert ledger["dividend_state"] == "paid"
    assert ledger["routeable_candidate_count_after"] == 1
    assert ledger["measured_delta"] == 1
    custody = cast(Mapping[str, Any], ledger["jangar_custody"])
    assert custody["launch_decision"] == "allow"
    assert custody["allowed_action_class"] == "dispatch_repair"


def test_alpha_repair_dividend_ledger_holds_pending_attempt() -> None:
    conveyor = deepcopy(_conveyor(repeat_launch_decision="hold"))
    conveyor["status"] = "settling"
    conveyor["settlement_state"] = "pending"
    selected_lane = cast(dict[str, object], conveyor["selected_lane"])
    selected_lane["repeat_launch_decision"] = "hold"
    settlement_receipt = cast(dict[str, object], conveyor["settlement_receipt"])
    settlement_receipt["settlement_state"] = "pending"
    settlement_receipt["repeat_launch_decision"] = "hold"

    ledger = _build(conveyor=conveyor)

    assert ledger["dividend_state"] == "pending"
    custody = cast(Mapping[str, Any], ledger["jangar_custody"])
    assert custody["launch_decision"] == "hold"
    hypothesis_dividend = cast(list[Mapping[str, Any]], ledger["hypothesis_dividends"])[
        0
    ]
    assert hypothesis_dividend["dividend_state"] == "pending"


def test_alpha_repair_dividend_release_key_changes_with_blocker_set() -> None:
    first = _build(conveyor=_conveyor(release_key=None))
    second = _build(
        conveyor=_conveyor(
            release_key=None,
            reason_codes=[
                "drift_checks_missing",
                "feature_rows_missing",
                "schema_lineage_missing",
            ],
        )
    )

    assert first["no_delta_release_key"] != second["no_delta_release_key"]


def test_alpha_repair_dividend_ledger_blocks_missing_conveyor() -> None:
    ledger = _build(conveyor={})

    assert ledger["dividend_state"] == "blocked"
    assert "alpha_readiness_settlement_conveyor_missing" in ledger["reason_codes"]
    custody = cast(Mapping[str, Any], ledger["jangar_custody"])
    assert custody["launch_decision"] == "deny"


def test_alpha_repair_dividend_ledger_keeps_selected_dividend_without_lane_scores() -> (
    None
):
    conveyor = deepcopy(_conveyor())
    conveyor["lane_scores"] = []

    ledger = _build(conveyor=conveyor)

    dividends = cast(list[Mapping[str, Any]], ledger["hypothesis_dividends"])
    assert len(dividends) == 1
    assert dividends[0]["selected"] is True
    assert dividends[0]["hypothesis_id"] == "H-MICRO-01"


def test_alpha_repair_dividend_ledger_blocks_stale_conveyor() -> None:
    ledger = _build(conveyor=_conveyor(fresh_until=NOW - timedelta(seconds=1)))

    assert ledger["dividend_state"] == "stale"
    assert "alpha_readiness_settlement_conveyor_stale" in ledger["reason_codes"]
    custody = cast(Mapping[str, Any], ledger["jangar_custody"])
    assert custody["launch_decision"] == "deny"


def test_alpha_repair_dividend_ledger_blocks_nonzero_notional() -> None:
    ledger = _build(capital={"capital_state": "shadow", "max_notional": "25"})

    assert ledger["dividend_state"] == "blocked"
    assert ledger["max_notional"] == "25"
    assert "capital_notional_nonzero" in ledger["reason_codes"]


def test_compact_alpha_repair_dividend_ledger_ref() -> None:
    ledger = _build()
    compact = compact_alpha_repair_dividend_ledger(ledger)

    assert compact["schema_version"] == "torghut.alpha-repair-dividend-ledger-ref.v1"
    assert compact["ledger_id"] == ledger["ledger_id"]
    assert compact["dividend_state"] == "no_delta"
    assert compact["launch_decision"] == "deny"
    assert compact["selected_value_gate"] == "routeable_candidate_count"
    assert compact["max_notional"] == "0"

    assert compact_alpha_repair_dividend_ledger(None) == {
        "schema_version": "torghut.alpha-repair-dividend-ledger-ref.v1",
        "status": "missing",
        "reason_codes": ["alpha_repair_dividend_ledger_missing"],
    }


def test_alpha_repair_dividend_ledger_rejects_naive_generated_at() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_alpha_repair_dividend_ledger(
            generated_at=datetime(2026, 5, 14, 11, 20),
            business_state="repair_only",
            revenue_ready=False,
            repair_queue=_repair_queue(),
            capital={"max_notional": "0"},
            evidence=_evidence(),
            repair_bid_settlement_ledger=_repair_bid_settlement(),
            executable_alpha_repair_receipts=_executable_alpha_repair_receipts(),
            executable_alpha_settlement_slots=_settlement_slots(),
            alpha_evidence_foundry=_alpha_foundry(),
            alpha_repair_closure_board=_closure_board(),
            alpha_readiness_settlement_conveyor=_conveyor(),
        )
