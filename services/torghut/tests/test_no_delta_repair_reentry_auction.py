from __future__ import annotations

from collections.abc import Mapping
from copy import deepcopy
from datetime import datetime, timezone
from typing import Any, cast

import pytest

from app.trading.no_delta_repair_reentry_auction import (
    build_no_delta_repair_reentry_auction,
    compact_no_delta_repair_reentry_auction,
)

NOW = datetime(2026, 5, 14, 14, 40, tzinfo=timezone.utc)


def _repair_queue() -> list[dict[str, object]]:
    return [
        {
            "code": "repair_alpha_readiness",
            "reason": "hypothesis_not_promotion_eligible",
            "dimension": "alpha_readiness",
            "action": "clear_hypothesis_blockers_before_capital",
            "priority": 70,
            "expected_unblock_value": 3,
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


def _repair_bid_settlement() -> dict[str, object]:
    return {
        "ledger_id": "repair-bid-settlement-ledger:test",
        "account_id": "PA3SX7FYNUTF",
        "session_id": "15m",
        "trading_mode": "live",
        "routeable_candidate_count": 0,
    }


def _conveyor() -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-readiness-settlement-conveyor.v1",
        "conveyor_id": "alpha-readiness-settlement-conveyor:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": "2026-05-14T14:55:00+00:00",
        "status": "no_delta",
        "settlement_state": "no_delta",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "account_id": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "selected_value_gate": "routeable_candidate_count",
        "routeable_candidate_count_before": 0,
        "routeable_candidate_count_after": 0,
        "measured_routeable_candidate_delta": 0,
        "active_no_delta_lease_count": 1,
        "selected_lane": {
            "hypothesis_id": "H-MICRO-01",
            "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
            "lane_id": "microstructure-breakout",
            "before_reason_codes": [
                "drift_checks_missing",
                "feature_rows_missing",
                "required_feature_set_unavailable",
            ],
            "required_receipts": [
                "alpha_readiness_receipt",
                "capital_replay_board",
                "feature_replay_receipt",
            ],
            "no_delta_release_key": "release-key:micro",
            "repeat_launch_decision": "deny",
            "measured_routeable_candidate_delta": 0,
            "max_notional": "0",
        },
        "settlement_receipt": {
            "schema_version": "torghut.alpha-readiness-settlement-receipt.v1",
            "receipt_id": "alpha-readiness-settlement-receipt:micro",
            "hypothesis_id": "H-MICRO-01",
            "settlement_state": "no_delta",
            "routeable_candidate_count_before": 0,
            "routeable_candidate_count_after": 0,
            "measured_routeable_candidate_delta": 0,
            "preserved_reason_codes": [
                "drift_checks_missing",
                "feature_rows_missing",
                "required_feature_set_unavailable",
            ],
            "no_delta_release_key": "release-key:micro",
            "repeat_launch_decision": "deny",
            "missing_receipts": ["feature_replay_receipt"],
        },
    }


def _dividend_ledger() -> dict[str, object]:
    return {
        "schema_version": "torghut.alpha-repair-dividend-ledger.v1",
        "ledger_id": "alpha-repair-dividend-ledger:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": "2026-05-14T14:55:00+00:00",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "source_alpha_readiness_settlement_conveyor_ref": (
            "alpha-readiness-settlement-conveyor:test"
        ),
        "account_id": "PA3SX7FYNUTF",
        "window": "15m",
        "trading_mode": "live",
        "status": "no_delta",
        "dividend_state": "no_delta",
        "reason_codes": ["active_no_delta_release_key"],
        "selected_queue_code": "repair_alpha_readiness",
        "selected_value_gate": "routeable_candidate_count",
        "routeable_candidate_count_before": 0,
        "routeable_candidate_count_after": 0,
        "measured_delta": 0,
        "selected_hypothesis_id": "H-MICRO-01",
        "preserved_reason_codes": [
            "drift_checks_missing",
            "feature_rows_missing",
            "required_feature_set_unavailable",
        ],
        "required_output_receipt": "torghut.executable-alpha-receipts.v1",
        "required_receipts": [
            "alpha_readiness_receipt",
            "feature_replay_receipt",
        ],
        "no_delta_release_key": "release-key:micro",
        "no_delta_release_conditions": [
            "source_ref_changes",
            "evidence_window_changes",
            "blocker_set_changes",
            "required_receipt_changes",
        ],
        "jangar_custody": {
            "required_recorder_schema": (
                "jangar.material-action-custody-flight-recorder.v1"
            ),
            "launch_decision": "deny",
            "launch_decision_reason": "no_delta_release_key_active",
        },
        "max_notional": "0",
        "capital_rule": "zero_notional_repair_only",
    }


def _build(
    *,
    conveyor: Mapping[str, Any] | None = None,
    dividend: Mapping[str, Any] | None = None,
    capital: Mapping[str, Any] | None = None,
    jangar_verification_carry: Mapping[str, Any] | None = None,
    jangar_controller_ingestion_carry: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_no_delta_repair_reentry_auction(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_repair_queue(),
        capital=capital or {"capital_state": "zero_notional", "max_notional": "0"},
        alpha_readiness_settlement_conveyor=_conveyor()
        if conveyor is None
        else conveyor,
        alpha_repair_dividend_ledger=_dividend_ledger()
        if dividend is None
        else dividend,
        repair_bid_settlement_ledger=_repair_bid_settlement(),
        jangar_verification_carry=jangar_verification_carry,
        jangar_controller_ingestion_carry=jangar_controller_ingestion_carry,
    )


def test_no_delta_reentry_auction_denies_unchanged_active_release_key() -> None:
    auction = _build()

    assert auction["schema_version"] == "torghut.no-delta-repair-reentry-auction.v1"
    assert auction["reentry_decision"] == "deny"
    assert auction["active_no_delta_release_key"] == "release-key:micro"
    assert auction["selected_ticket"] is None
    assert auction["selected_value_gate"] == "routeable_candidate_count"
    assert auction["max_notional"] == "0"
    assert "no_release_condition_changed" in auction["reason_codes"]
    assert "duplicate_no_delta_reentry_denied" in auction["reason_codes"]

    tickets = cast(list[Mapping[str, Any]], auction["candidate_tickets"])
    assert tickets
    assert {ticket["state"] for ticket in tickets} == {"denied"}


def test_no_delta_reentry_auction_selects_one_changed_evidence_ticket() -> None:
    dividend = deepcopy(_dividend_ledger())
    dividend["changed_release_conditions"] = [
        "source_ref_changes",
        "evidence_window_changes",
        "blocker_set_changes",
        "required_receipt_changes",
        "selected_hypothesis_changed",
        "schema_lineage_receipt_current",
    ]

    auction = _build(dividend=dividend)

    assert auction["reentry_decision"] == "allow"
    release_states = {
        condition["code"]: condition["state"]
        for condition in cast(list[Mapping[str, Any]], auction["release_conditions"])
    }
    assert release_states["source_revenue_repair_ref_changed"] == "changed"
    assert release_states["evidence_window_changed"] == "changed"
    assert release_states["blocker_set_changed"] == "changed"
    assert release_states["required_receipt_set_changed"] == "changed"
    assert release_states["selected_hypothesis_changed"] == "changed"
    assert release_states["schema_lineage_receipt_current"] == "changed"
    selected = cast(Mapping[str, Any], auction["selected_ticket"])
    assert selected["ticket_class"] == "alpha_evidence_window"
    assert selected["release_condition"] == "source_revenue_repair_ref_changed"
    assert selected["state"] == "selected"
    assert selected["max_notional"] == "0"
    assert (
        selected["required_output_receipt"]
        == "torghut.alpha-evidence-window-receipt.v1"
    )

    selected_tickets = [
        ticket
        for ticket in cast(list[Mapping[str, Any]], auction["candidate_tickets"])
        if ticket["state"] == "eligible"
    ]
    assert any(
        ticket["ticket_class"] == "alpha_evidence_window" for ticket in selected_tickets
    )


def test_no_delta_reentry_auction_selects_jangar_foreclosure_ticket() -> None:
    auction = _build(
        jangar_verification_carry={
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "status": "current",
            "execution_trust_status": "degraded",
            "fresh_until": "2026-05-14T14:55:00+00:00",
            "foreclosure_tickets": [
                {
                    "ticket_id": "verify-trust-foreclosure-ticket:test",
                    "state": "open",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                }
            ],
        },
        jangar_controller_ingestion_carry={
            "schema_version": "torghut.jangar-controller-ingestion-carry.v1",
            "carry_id": "jangar-controller-ingestion-carry:repairable",
            "carry_state": "repairable",
            "selected_release_condition": "jangar_controller_ingestion_current",
            "selected_ticket_class": "jangar_verify_carry",
            "selected_ticket_id": "verify-trust-foreclosure-ticket:test",
            "max_notional": "0",
            "reason_codes": ["jangar_controller_ingestion_repairable"],
        },
    )

    assert auction["reentry_decision"] == "allow"
    selected = cast(Mapping[str, Any], auction["selected_ticket"])
    assert selected["ticket_class"] == "jangar_verify_carry"
    assert selected["release_condition"] == "jangar_controller_ingestion_current"


def test_no_delta_reentry_auction_does_not_select_jangar_ticket_for_current_carry() -> (
    None
):
    auction = _build(
        jangar_controller_ingestion_carry={
            "schema_version": "torghut.jangar-controller-ingestion-carry.v1",
            "carry_id": "jangar-controller-ingestion-carry:current",
            "carry_state": "current",
            "selected_release_condition": "jangar_controller_ingestion_current",
            "selected_ticket_class": "none",
            "max_notional": "0",
            "reason_codes": [],
        },
    )

    assert auction["reentry_decision"] == "deny"
    assert auction["selected_ticket"] is None
    release_states = {
        condition["code"]: condition["state"]
        for condition in cast(list[Mapping[str, Any]], auction["release_conditions"])
    }
    assert release_states["jangar_controller_ingestion_current"] == "current"
    tickets = cast(list[Mapping[str, Any]], auction["candidate_tickets"])
    jangar_ticket = next(
        ticket for ticket in tickets if ticket["ticket_class"] == "jangar_verify_carry"
    )
    assert (
        "jangar_controller_ingestion_carry_not_repairable"
        in jangar_ticket["hold_reason_codes"]
    )


@pytest.mark.parametrize(
    "carry_state",
    ["unavailable", "stale", "lagging", "contradicted"],
)
def test_no_delta_reentry_auction_denies_unusable_controller_carry(
    carry_state: str,
) -> None:
    auction = _build(
        jangar_controller_ingestion_carry={
            "schema_version": "torghut.jangar-controller-ingestion-carry.v1",
            "carry_id": f"jangar-controller-ingestion-carry:{carry_state}",
            "carry_state": carry_state,
            "selected_release_condition": "jangar_controller_ingestion_current",
            "selected_ticket_class": "none",
            "max_notional": "0",
            "reason_codes": [f"jangar_controller_ingestion_{carry_state}"],
        },
    )

    assert auction["reentry_decision"] == "deny"
    assert auction["selected_ticket"] is None
    assert f"jangar_controller_ingestion_{carry_state}" in auction["reason_codes"]


def test_no_delta_reentry_auction_denies_nonzero_notional() -> None:
    auction = _build(capital={"capital_state": "shadow", "max_notional": "25"})

    assert auction["reentry_decision"] == "deny"
    assert auction["max_notional"] == "25"
    assert "capital_notional_nonzero" in auction["reason_codes"]


def test_no_delta_reentry_auction_denies_invalid_notional_string() -> None:
    auction = _build(
        capital={"capital_state": "shadow", "max_notional": "not-a-number"}
    )

    assert auction["reentry_decision"] == "deny"
    assert auction["max_notional"] == "not-a-number"
    assert "capital_notional_nonzero" in auction["reason_codes"]


def test_no_delta_reentry_auction_holds_without_active_key_or_release_change() -> None:
    dividend = deepcopy(_dividend_ledger())
    dividend["dividend_state"] = "positive_delta"
    dividend["routeable_candidate_count_before"] = True
    dividend["routeable_candidate_count_after"] = 2.0
    dividend["jangar_custody"] = {"launch_decision": "allow"}

    conveyor = deepcopy(_conveyor())
    conveyor["active_no_delta_lease_count"] = "not-a-number"
    conveyor["repeat_launch_decision"] = "allow"
    selected_lane = cast(dict[str, object], conveyor["selected_lane"])
    selected_lane["repeat_launch_decision"] = "allow"

    auction = _build(conveyor=conveyor, dividend=dividend)

    assert auction["active_no_delta_release_key"] is None
    assert auction["reentry_decision"] == "hold"
    assert auction["routeable_candidate_count_before"] == 1
    assert auction["routeable_candidate_count_after"] == 2
    assert "no_release_condition_changed" in auction["reason_codes"]
    assert "duplicate_no_delta_reentry_denied" not in auction["reason_codes"]

    tickets = cast(list[Mapping[str, Any]], auction["candidate_tickets"])
    assert {ticket["state"] for ticket in tickets} == {"held"}


def test_no_delta_reentry_auction_maps_stale_jangar_release_conditions() -> None:
    dividend = deepcopy(_dividend_ledger())
    dividend["changed_release_conditions"] = [
        "source_ref_changes",
        "blocker_set_changes",
        "required_receipt_changes",
        "selected_hypothesis_changes",
        "jangar_verify_foreclosure_ticket_current",
    ]

    auction = _build(
        dividend=dividend,
        jangar_verification_carry={
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "status": "current",
            "execution_trust_status": "degraded",
            "fresh_until": "2026-05-14T14:39:00+00:00",
            "foreclosure_tickets": [],
        },
    )

    condition_codes = {
        condition["code"]
        for condition in cast(list[Mapping[str, str]], auction["release_conditions"])
    }
    assert {
        "source_revenue_repair_ref_changed",
        "blocker_set_changed",
        "required_receipt_set_changed",
        "selected_hypothesis_changed",
        "jangar_verify_foreclosure_ticket_current",
    } <= condition_codes
    assert "jangar_verification_carry_stale" in auction["reason_codes"]
    assert "jangar_foreclosure_ticket_missing" in auction["reason_codes"]


@pytest.mark.parametrize(
    ("fresh_until", "expected_extra_reason"),
    [
        ("", None),
        ("not-a-date", None),
        ("2026-05-14T14:00:00", None),
        ("2026-05-14T14:00:00Z", "jangar_verification_carry_stale"),
    ],
)
def test_no_delta_reentry_auction_handles_unusable_jangar_carry_times(
    fresh_until: str,
    expected_extra_reason: str | None,
) -> None:
    auction = _build(
        jangar_verification_carry={
            "schema_version": "jangar.verify-trust-foreclosure-board.v1",
            "board_id": "verify-trust-foreclosure-board:agents:test",
            "status": "current",
            "execution_trust_status": "degraded",
            "fresh_until": fresh_until,
            "reason_codes": ["existing_reason", " ", "existing_reason"],
            "foreclosure_tickets": [],
        }
    )

    carry = cast(Mapping[str, Any], auction["jangar_verification_carry"])
    reason_codes = cast(list[str], carry["reason_codes"])
    assert reason_codes.count("existing_reason") == 1
    assert "jangar_foreclosure_ticket_missing" in reason_codes
    if expected_extra_reason is not None:
        assert expected_extra_reason in reason_codes


def test_compact_no_delta_reentry_auction_ref() -> None:
    auction = _build()
    compact = compact_no_delta_repair_reentry_auction(auction)

    assert compact["schema_version"] == "torghut.no-delta-repair-reentry-auction-ref.v1"
    assert compact["auction_id"] == auction["auction_id"]
    assert compact["reentry_decision"] == "deny"
    assert compact["active_no_delta_release_key"] == "release-key:micro"
    assert compact["selected_ticket_id"] is None
    assert compact["max_notional"] == "0"

    assert compact_no_delta_repair_reentry_auction(None) == {
        "schema_version": "torghut.no-delta-repair-reentry-auction-ref.v1",
        "status": "missing",
        "reason_codes": ["no_delta_repair_reentry_auction_missing"],
    }


def test_no_delta_reentry_auction_rejects_naive_generated_at() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_no_delta_repair_reentry_auction(
            generated_at=datetime(2026, 5, 14, 14, 40),
            business_state="repair_only",
            revenue_ready=False,
            repair_queue=_repair_queue(),
            capital={"capital_state": "zero_notional", "max_notional": "0"},
            alpha_readiness_settlement_conveyor=_conveyor(),
            alpha_repair_dividend_ledger=_dividend_ledger(),
            repair_bid_settlement_ledger=_repair_bid_settlement(),
        )
