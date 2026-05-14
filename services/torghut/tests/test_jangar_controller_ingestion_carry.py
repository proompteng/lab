from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.trading.jangar_controller_ingestion_carry import (
    build_jangar_controller_ingestion_carry,
    compact_jangar_controller_ingestion_carry,
)

NOW = datetime(2026, 5, 14, 15, 30, tzinfo=timezone.utc)


def test_controller_ingestion_carry_classifies_unavailable_when_missing() -> None:
    carry = build_jangar_controller_ingestion_carry(generated_at=NOW)

    assert carry["schema_version"] == "torghut.jangar-controller-ingestion-carry.v1"
    assert carry["carry_state"] == "unavailable"
    assert carry["jangar_settlement_decision"] == "unknown"
    assert carry["jangar_controller_ingestion_current"] is None
    assert carry["selected_ticket_class"] == "none"
    assert carry["max_notional"] == "0"
    assert "jangar_controller_ingestion_settlement_missing" in carry["reason_codes"]
    assert "jangar_verify_foreclosure_board_missing" in carry["reason_codes"]


def test_controller_ingestion_carry_classifies_current_when_settlement_and_board_match() -> (
    None
):
    carry = build_jangar_controller_ingestion_carry(
        generated_at=NOW,
        dependency_quorum={
            "controller_ingestion_settlement": {
                "settlement_id": "controller-ingestion-settlement:current",
                "decision": "allow",
                "controller_ingestion_current": True,
                "fresh_until": "2026-05-14T15:45:00+00:00",
            },
            "verify_trust_foreclosure_board": {
                "board_id": "verify-trust-foreclosure-board:current",
                "fresh_until": "2026-05-14T15:45:00+00:00",
            },
        },
    )

    assert carry["carry_state"] == "current"
    assert carry["source_jangar_settlement_ref"] == (
        "controller-ingestion-settlement:current"
    )
    assert carry["jangar_controller_ingestion_current"] is True
    assert (
        carry["jangar_verify_foreclosure_board_ref"]
        == "verify-trust-foreclosure-board:current"
    )
    assert carry["selected_ticket_class"] == "none"
    assert carry["reason_codes"] == []


def test_controller_ingestion_carry_classifies_repairable_ticket() -> None:
    carry = build_jangar_controller_ingestion_carry(
        generated_at=NOW,
        dependency_quorum={
            "controller_ingestion_settlement": {
                "settlement_id": "controller-ingestion-settlement:repair",
                "decision": "repair_only",
                "controller_ingestion_current": False,
                "selected_repair_ticket": {
                    "ticket_id": "verify-trust-foreclosure-ticket:repair",
                    "ticket_class": "jangar_verify_carry",
                    "required_output_receipt": (
                        "jangar.verify-trust-foreclosure-ticket.v1"
                    ),
                    "validation_commands": [
                        "bun run --filter jangar test -- services/jangar/src/server/__tests__/control-plane-verify-trust-foreclosure.test.ts"
                    ],
                },
            },
        },
    )

    assert carry["carry_state"] == "repairable"
    assert carry["selected_release_condition"] == "jangar_controller_ingestion_current"
    assert carry["selected_ticket_class"] == "jangar_verify_carry"
    assert carry["selected_ticket_id"] == "verify-trust-foreclosure-ticket:repair"
    assert "jangar_controller_ingestion_repairable" in carry["reason_codes"]
    assert carry["validation_commands"]


def test_controller_ingestion_carry_classifies_lagging_source_claim() -> None:
    carry = build_jangar_controller_ingestion_carry(
        generated_at=NOW,
        dependency_quorum={
            "foreclosure_carry_rollout_witness": {
                "witness_id": "foreclosure-carry-rollout-witness:source",
                "fresh_until": "2026-05-14T15:45:00+00:00",
            }
        },
    )

    assert carry["carry_state"] == "lagging"
    assert "jangar_controller_ingestion_lagging" in carry["reason_codes"]


def test_controller_ingestion_carry_classifies_stale_settlement() -> None:
    carry = build_jangar_controller_ingestion_carry(
        generated_at=NOW,
        dependency_quorum={
            "controller_ingestion_settlement": {
                "settlement_id": "controller-ingestion-settlement:stale",
                "decision": "repair_only",
                "fresh_until": "2026-05-14T15:00:00+00:00",
            }
        },
    )

    assert carry["carry_state"] == "stale"
    assert "jangar_controller_ingestion_settlement_stale" in carry["reason_codes"]


def test_controller_ingestion_carry_classifies_contradicted_allow_without_board() -> (
    None
):
    carry = build_jangar_controller_ingestion_carry(
        generated_at=NOW,
        dependency_quorum={
            "controller_ingestion_settlement": {
                "settlement_id": "controller-ingestion-settlement:bad",
                "decision": "allow",
                "controller_ingestion_current": True,
                "fresh_until": "2026-05-14T15:45:00+00:00",
            }
        },
    )

    assert carry["carry_state"] == "contradicted"
    assert "jangar_allow_without_required_carry_fields" in carry["reason_codes"]


def test_controller_ingestion_carry_rejects_naive_generated_at() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_jangar_controller_ingestion_carry(
            generated_at=datetime(2026, 5, 14, 15, 30)
        )


def test_compact_controller_ingestion_carry_ref() -> None:
    carry = build_jangar_controller_ingestion_carry(generated_at=NOW)
    compact = compact_jangar_controller_ingestion_carry(carry)

    assert (
        compact["schema_version"] == "torghut.jangar-controller-ingestion-carry-ref.v1"
    )
    assert compact["carry_id"] == carry["carry_id"]
    assert compact["carry_state"] == "unavailable"
    assert compact["max_notional"] == "0"

    assert compact_jangar_controller_ingestion_carry(None) == {
        "schema_version": "torghut.jangar-controller-ingestion-carry-ref.v1",
        "status": "missing",
        "reason_codes": ["jangar_controller_ingestion_carry_missing"],
    }
