from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

import pytest

from app.trading.alpha_evidence_foundry import (
    build_alpha_evidence_foundry,
    compact_alpha_evidence_foundry,
)

NOW = datetime(2026, 5, 14, 1, 10, tzinfo=timezone.utc)


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
            "promotion_eligible_total": 0,
            "repair_targets": [
                {
                    "hypothesis_id": "H-CONT-01",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "strategy_id": "intraday_tsmom_v1@paper",
                    "lane_id": "continuation",
                    "strategy_family": "intraday_continuation",
                    "state": "shadow",
                    "promotion_eligible": False,
                    "reasons": ["post_cost_expectancy_non_positive"],
                    "informational_reasons": [
                        "closed_session_signal_hold",
                        "closed_session_tca_evidence_hold",
                    ],
                },
                {
                    "hypothesis_id": "H-MICRO-01",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "strategy_id": "microbar_volume_continuation_long_top2_chip_v1@paper",
                    "lane_id": "microstructure-breakout",
                    "strategy_family": "microstructure_breakout",
                    "state": "blocked",
                    "promotion_eligible": False,
                    "reasons": [
                        "drift_checks_missing",
                        "feature_rows_missing",
                        "required_feature_set_unavailable",
                    ],
                },
                {
                    "hypothesis_id": "H-REV-01",
                    "candidate_id": "chip-paper-microbar-composite@execution-proof",
                    "strategy_id": "microbar_prev_day_open45_reversal_long_top1_chip_v1@paper",
                    "lane_id": "event-reversion",
                    "strategy_family": "event_reversion",
                    "state": "shadow",
                    "promotion_eligible": False,
                    "reasons": ["post_cost_expectancy_non_positive"],
                    "informational_reasons": [
                        "closed_session_market_context_hold",
                        "closed_session_signal_hold",
                        "closed_session_tca_evidence_hold",
                    ],
                },
            ],
        },
        "execution_tca": {
            "state": "pass",
            "reason": "execution_tca_route_universe_exclusions_applied",
        },
        "route_reacquisition": {
            "state": "repair_only",
            "routeable_symbol_count": 0,
            "probing_symbol_count": 1,
            "repair_candidate_count": 7,
        },
        "routeability_acceptance": {
            "ledger_id": "routeability-acceptance-ledger:test",
            "accepted_routeable_candidate_count": 0,
            "zero_notional_or_stale_evidence_rate": 1,
        },
        "route_evidence_clearinghouse": {
            "packet_id": "route-evidence-clearinghouse:test",
            "accepted_routeable_candidate_count": 0,
        },
        "repair_bid_settlement": {
            "ledger_id": "repair-bid-settlement-ledger:test",
            "routeable_candidate_count": 0,
        },
    }


def _receipt(
    *,
    receipt_id: str,
    hypothesis_id: str,
    reason_codes: list[str],
    validation_key: str,
) -> dict[str, object]:
    return {
        "receipt_id": receipt_id,
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "hypothesis_id": hypothesis_id,
        "candidate_id": "chip-paper-microbar-composite@execution-proof",
        "strategy_id": f"strategy:{hypothesis_id}",
        "reason_codes": reason_codes,
        "required_input_refs": [
            "torghut-revenue-repair-digest:test",
            "capital-replay:test",
        ],
        "required_output_receipts": [
            "alpha_readiness_receipt",
            "hypothesis_promotion_receipt",
            "capital_replay_board",
            "torghut.executable-alpha-receipts.v1",
        ],
        "validation_commands": [
            "uv run --frozen pytest "
            f"services/torghut/tests/test_executable_alpha_repair_receipts.py -k {validation_key}"
        ],
        "max_notional": "0",
        "capital_rule": "zero_notional_repair_only",
    }


def _repair_receipts() -> dict[str, object]:
    return {
        "schema_version": "torghut.executable-alpha-repair-receipts.v1",
        "source_revenue_repair_ref": "torghut-revenue-repair-digest:test",
        "status": "selected",
        "receipts": [
            _receipt(
                receipt_id="executable-alpha-repair-receipt:cont",
                hypothesis_id="H-CONT-01",
                reason_codes=[
                    "post_cost_expectancy_non_positive",
                    "closed_session_signal_hold",
                    "closed_session_tca_evidence_hold",
                ],
                validation_key="evidence_window",
            ),
            _receipt(
                receipt_id="executable-alpha-repair-receipt:micro",
                hypothesis_id="H-MICRO-01",
                reason_codes=[
                    "drift_checks_missing",
                    "feature_rows_missing",
                    "required_feature_set_unavailable",
                ],
                validation_key="feature",
            ),
            _receipt(
                receipt_id="executable-alpha-repair-receipt:rev",
                hypothesis_id="H-REV-01",
                reason_codes=[
                    "post_cost_expectancy_non_positive",
                    "closed_session_market_context_hold",
                    "closed_session_signal_hold",
                    "closed_session_tca_evidence_hold",
                ],
                validation_key="evidence_window",
            ),
        ],
    }


def _build(
    *,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
    repair_receipts: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    return build_alpha_evidence_foundry(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _repair_queue(),
        capital=capital or {"capital_state": "zero_notional", "max_notional": "0"},
        evidence=_evidence(),
        executable_alpha_repair_receipts=repair_receipts or _repair_receipts(),
        source_serving_metadata={
            "build": {
                "commit": "source-sha",
                "active_revision": "torghut-00373",
            }
        },
    )


def test_alpha_evidence_foundry_emits_window_receipts_for_all_alpha_targets() -> None:
    foundry = _build()

    assert foundry["schema_version"] == "torghut.alpha-evidence-foundry.v1"
    assert foundry["status"] == "selected"
    assert foundry["selected_queue_code"] == "repair_alpha_readiness"
    assert foundry["selected_value_gate"] == "routeable_candidate_count"
    assert foundry["routeable_candidate_count_before"] == 0
    assert foundry["zero_notional_or_stale_evidence_rate_before"] == 1
    assert (
        foundry["required_output_receipt"] == "torghut.alpha-evidence-window-receipt.v1"
    )
    assert foundry["max_notional"] == "0"
    receipts = cast(list[Mapping[str, Any]], foundry["receipts"])
    assert [receipt["hypothesis_id"] for receipt in receipts] == [
        "H-CONT-01",
        "H-MICRO-01",
        "H-REV-01",
    ]
    assert all(receipt["max_notional"] == "0" for receipt in receipts)
    assert all(
        receipt["measured_routeable_candidate_delta"] == 0 for receipt in receipts
    )
    assert len(cast(list[Mapping[str, Any]], foundry["no_delta_debt"])) == 3


def test_alpha_evidence_foundry_classifies_feature_and_guardrail_states() -> None:
    foundry = _build()
    receipts = cast(list[Mapping[str, Any]], foundry["receipts"])
    by_hypothesis = {str(receipt["hypothesis_id"]): receipt for receipt in receipts}

    micro = by_hypothesis["H-MICRO-01"]
    assert micro["lane_id"] == "microstructure-breakout"
    assert micro["feature_coverage_state"] == "missing"
    assert micro["drift_check_state"] == "missing"
    assert micro["post_cost_expectancy_state"] == "current"
    assert micro["expected_routeable_candidate_delta"] == 1
    assert micro["route_universe_state"] == "probing"
    assert micro["no_delta_reason"] == "routeable_candidate_count_unchanged"

    cont = by_hypothesis["H-CONT-01"]
    assert cont["post_cost_expectancy_state"] == "blocked"
    assert cont["tca_state"] == "hold"

    rev = by_hypothesis["H-REV-01"]
    assert rev["market_context_state"] == "hold"
    assert rev["post_cost_expectancy_state"] == "blocked"


def test_alpha_evidence_foundry_blocks_nonzero_notional() -> None:
    foundry = _build(capital={"capital_state": "shadow", "max_notional": "15"})

    assert foundry["status"] == "blocked"
    assert foundry["receipts"] == []
    assert "capital_notional_nonzero" in foundry["reason_codes"]
    assert foundry["max_notional"] == "15"


def test_alpha_evidence_foundry_inactive_when_top_queue_is_not_alpha() -> None:
    foundry = _build(
        repair_queue=[
            {
                "code": "repair_execution_tca",
                "reason": "execution_tca_stale",
                "value_gate": "fill_tca_or_slippage_quality",
            }
        ]
    )

    assert foundry["status"] == "inactive"
    assert foundry["receipts"] == []
    assert foundry["no_delta_debt"] == []
    assert "revenue_repair_top_item_not_alpha_readiness" in foundry["reason_codes"]


def test_alpha_evidence_foundry_holds_when_receipts_are_missing() -> None:
    foundry = _build(repair_receipts={"source_revenue_repair_ref": "revenue:test"})

    assert foundry["status"] == "held"
    assert foundry["receipts"] == []
    assert "alpha_evidence_window_receipts_missing" in foundry["reason_codes"]


def test_alpha_evidence_foundry_rejects_naive_generated_at() -> None:
    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_alpha_evidence_foundry(
            generated_at=datetime(2026, 5, 14, 1, 10),
            business_state="repair_only",
            revenue_ready=False,
            repair_queue=_repair_queue(),
            capital={"max_notional": "0"},
            evidence=_evidence(),
            executable_alpha_repair_receipts=_repair_receipts(),
        )


def test_compact_alpha_evidence_foundry_returns_jangar_ref() -> None:
    foundry = _build()
    compact = compact_alpha_evidence_foundry(foundry)

    assert compact["schema_version"] == "torghut.alpha-evidence-foundry-ref.v1"
    assert compact["foundry_id"] == foundry["foundry_id"]
    assert compact["status"] == "selected"
    assert compact["selected_value_gate"] == "routeable_candidate_count"
    assert (
        compact["required_output_receipt"] == "torghut.alpha-evidence-window-receipt.v1"
    )
    assert compact["receipt_count"] == 3
    assert compact["selected_hypothesis_id"] == "H-CONT-01"
    assert compact["hypothesis_ids"] == ["H-CONT-01", "H-MICRO-01", "H-REV-01"]
    assert compact["no_delta_debt_count"] == 3
    assert compact["max_notional"] == "0"


def test_compact_alpha_evidence_foundry_reports_missing_payload() -> None:
    compact = compact_alpha_evidence_foundry(None)

    assert compact == {
        "schema_version": "torghut.alpha-evidence-foundry-ref.v1",
        "status": "missing",
        "reason_codes": ["alpha_evidence_foundry_missing"],
    }
