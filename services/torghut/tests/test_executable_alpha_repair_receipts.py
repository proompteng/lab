from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta, timezone
from typing import Any, cast

import pytest

from app.trading.executable_alpha_receipts import (
    build_executable_alpha_repair_receipts,
    build_executable_alpha_settlement_slots,
    compact_executable_alpha_settlement_slots,
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


def _h_cont_alpha_readiness() -> dict[str, object]:
    return {
        "promotion_eligible_total": 0,
        "repair_target_count": 1,
        "capital_replay_board": {
            "schema_version": "torghut.capital-replay-board.v1",
            "board_id": "capital-replay:cont",
        },
        "executable_alpha_receipts": {
            "schema_version": "torghut.executable-alpha-receipts.v1",
            "candidate_receipts": [
                {
                    "receipt_id": "receipt:cont",
                    "hypothesis_id": "H-CONT-01",
                    "max_notional": "0",
                }
            ],
        },
        "repair_targets": [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "strategy_id": "intraday_tsmom_v1@paper",
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["post_cost_expectancy_non_positive"],
                "informational_reasons": [
                    "closed_session_signal_hold",
                    "closed_session_tca_evidence_hold",
                ],
            }
        ],
    }


def _alpha_readiness_with_micro_drift_lane() -> dict[str, object]:
    return {
        "promotion_eligible_total": 0,
        "repair_target_count": 3,
        "capital_replay_board": {
            "schema_version": "torghut.capital-replay-board.v1",
            "board_id": "capital-replay:micro",
        },
        "executable_alpha_receipts": {
            "schema_version": "torghut.executable-alpha-receipts.v1",
            "candidate_receipts": [
                {
                    "receipt_id": "receipt:cont",
                    "hypothesis_id": "H-CONT-01",
                    "max_notional": "0",
                },
                {
                    "receipt_id": "receipt:micro",
                    "hypothesis_id": "H-MICRO-01",
                    "max_notional": "0",
                },
                {
                    "receipt_id": "receipt:rev",
                    "hypothesis_id": "H-REV-01",
                    "max_notional": "0",
                },
            ],
        },
        "repair_targets": [
            {
                "hypothesis_id": "H-CONT-01",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "strategy_id": "intraday_tsmom_v1@paper",
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["post_cost_expectancy_non_positive"],
                "informational_reasons": ["closed_session_tca_evidence_hold"],
            },
            {
                "hypothesis_id": "H-MICRO-01",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "strategy_id": ("microbar_volume_continuation_long_top2_chip_v1@paper"),
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["drift_checks_missing"],
            },
            {
                "hypothesis_id": "H-REV-01",
                "candidate_id": "chip-paper-microbar-composite@execution-proof",
                "strategy_id": (
                    "microbar_prev_day_open45_reversal_long_top1_chip_v1@paper"
                ),
                "state": "shadow",
                "promotion_eligible": False,
                "reasons": ["post_cost_expectancy_non_positive"],
                "informational_reasons": [
                    "closed_session_market_context_hold",
                    "closed_session_tca_evidence_hold",
                ],
            },
        ],
    }


def _h_cont_repair_receipts() -> tuple[dict[str, object], dict[str, object]]:
    alpha = _h_cont_alpha_readiness()
    return alpha, _build(alpha_readiness=alpha)


def _settlement_evidence(
    alpha_readiness: Mapping[str, Any] | None = None,
    *,
    routeable_candidate_count: int = 0,
) -> dict[str, object]:
    return {
        "alpha_readiness": alpha_readiness or _h_cont_alpha_readiness(),
        "repair_bid_settlement": {
            "ledger_id": "repair-bid-settlement-ledger:test",
            "routeable_candidate_count": routeable_candidate_count,
        },
        "routeability_acceptance": {
            "ledger_id": "routeability-acceptance-ledger:test",
            "accepted_routeable_candidate_count": routeable_candidate_count,
        },
        "route_evidence_clearinghouse": {
            "packet_id": "route-evidence-clearinghouse:test",
            "accepted_routeable_candidate_count": routeable_candidate_count,
        },
    }


def _build(
    *,
    alpha_readiness: Mapping[str, Any] | None = None,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
    generated_at: datetime = NOW,
) -> dict[str, object]:
    return build_executable_alpha_repair_receipts(
        generated_at=generated_at,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _top_alpha_queue(),
        alpha_readiness=alpha_readiness or _alpha_readiness(),
        capital=capital or {"max_notional": "0"},
        repair_bid_settlement_ledger=_settlement_ledger(),
    )


def _build_settlement_slots(
    *,
    alpha_readiness: Mapping[str, Any] | None = None,
    repair_queue: list[dict[str, object]] | None = None,
    capital: Mapping[str, Any] | None = None,
    routeable_candidate_count: int = 0,
    generated_at: datetime = NOW,
) -> dict[str, object]:
    alpha = alpha_readiness or _h_cont_alpha_readiness()
    repair_receipts = _build(alpha_readiness=alpha, repair_queue=repair_queue)
    return build_executable_alpha_settlement_slots(
        generated_at=generated_at,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=repair_queue or _top_alpha_queue(),
        capital=capital or {"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(
            alpha, routeable_candidate_count=routeable_candidate_count
        ),
        executable_alpha_repair_receipts=repair_receipts,
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


def test_executable_alpha_source_ref_is_stable_across_digest_ticks() -> None:
    first = _build(generated_at=NOW)
    second = _build(generated_at=NOW + timedelta(minutes=5))

    assert first["generated_at"] != second["generated_at"]
    assert first["source_revenue_repair_ref"] == second["source_revenue_repair_ref"]
    assert (
        cast(Mapping[str, Any], first["selected_receipt"])["source_revenue_repair_ref"]
        == first["source_revenue_repair_ref"]
    )
    assert (
        cast(Mapping[str, Any], second["selected_receipt"])["source_revenue_repair_ref"]
        == first["source_revenue_repair_ref"]
    )


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


def test_feature_drift_lane_is_selected_before_post_cost_window_receipts() -> None:
    payload = _build(alpha_readiness=_alpha_readiness_with_micro_drift_lane())

    selected = cast(Mapping[str, Any], payload["selected_receipt"])
    assert selected["hypothesis_id"] == "H-MICRO-01"
    assert selected["repair_class"] == "evidence_window_refresh"
    assert selected["expected_gate_delta"] == "retire_drift_checks_missing"
    assert selected["max_notional"] == "0"
    receipts = cast(list[Mapping[str, Any]], payload["receipts"])
    assert [receipt["hypothesis_id"] for receipt in receipts] == [
        "H-MICRO-01",
        "H-CONT-01",
        "H-REV-01",
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


def test_evidence_window_selected_repair_receipt_settles_no_delta_for_unchanged_routeable_count() -> (
    None
):
    payload = _build_settlement_slots()

    assert payload["schema_version"] == "torghut.executable-alpha-settlement-slots.v1"
    assert payload["status"] == "settled"
    assert payload["max_notional"] == "0"
    assert payload["capital_rule"] == "zero_notional_repair_only"
    selected_slot = cast(Mapping[str, Any], payload["selected_slot"])
    assert (
        selected_slot["schema_version"] == "torghut.executable-alpha-settlement-slot.v1"
    )
    assert selected_slot["hypothesis_id"] == "H-CONT-01"
    assert selected_slot["target_value_gate"] == "routeable_candidate_count"
    assert selected_slot["settlement_state"] == "no_delta"
    assert selected_slot["routeable_candidate_count_before"] == 0
    assert selected_slot["routeable_candidate_count_after"] == 0
    assert selected_slot["measured_delta"] == 0
    assert selected_slot["no_delta_reason"] == "routeable_candidate_count_unchanged"
    assert selected_slot["material_reentry_receipt_id"].startswith(
        "material-reentry-receipt:"
    )
    assert selected_slot["required_material_reentry_receipt"] == (
        "jangar.material-reentry-receipt.v1"
    )
    assert selected_slot["max_notional"] == "0"
    no_delta_debt = cast(list[Mapping[str, Any]], payload["no_delta_debt"])
    assert len(no_delta_debt) == 1
    assert no_delta_debt[0]["selected_receipt_id"] == payload["selected_receipt_id"]
    assert no_delta_debt[0]["remaining_blocker"] == (
        "post_cost_expectancy_non_positive"
    )
    assert "blocker_set_changes" in no_delta_debt[0]["release_conditions"]


def test_settlement_slots_inactive_when_alpha_readiness_is_not_top_queue_item() -> None:
    payload = _build_settlement_slots(
        repair_queue=[
            {
                "code": "repair_execution_tca",
                "reason": "execution_tca_stale",
                "value_gate": "fill_tca_or_slippage_quality",
            }
        ]
    )

    assert payload["status"] == "inactive"
    assert payload["selected_slot"] is None
    assert payload["slots"] == []
    assert payload["no_delta_debt"] == []
    assert payload["reason_codes"] == ["revenue_repair_top_item_not_alpha_readiness"]


def test_settlement_slots_block_when_capital_safety_is_not_zero_notional() -> None:
    payload = _build_settlement_slots(
        capital={"max_notional": "25", "live_submission_allowed": True}
    )

    assert payload["status"] == "blocked"
    assert payload["selected_slot"] is None
    assert payload["slots"] == []
    assert payload["reason_codes"] == [
        "capital_notional_nonzero",
        "live_submission_enabled",
    ]


def test_settlement_slots_block_stale_selected_repair_receipt() -> None:
    alpha, repair_receipts = _h_cont_repair_receipts()
    selected = cast(dict[str, object], repair_receipts["selected_receipt"])
    selected["fresh_until"] = "2026-05-13T22:54:00Z"

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    assert payload["status"] == "blocked"
    assert payload["selected_slot"] is None
    assert payload["reason_codes"] == ["selected_executable_alpha_repair_receipt_stale"]


def test_settlement_slots_select_receipt_by_id_and_records_routeable_improvement() -> (
    None
):
    alpha, repair_receipts = _h_cont_repair_receipts()
    selected = cast(dict[str, object], repair_receipts["selected_receipt"])
    selected_receipt_id = selected["receipt_id"]
    selected.pop("reason_codes")
    selected.pop("required_output_receipts")
    repair_receipts["selected_receipt"] = None
    repair_receipts["selected_receipt_id"] = selected_receipt_id

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(alpha, routeable_candidate_count=1),
        executable_alpha_repair_receipts=repair_receipts,
    )

    selected_slot = cast(Mapping[str, Any], payload["selected_slot"])
    assert payload["status"] == "settled"
    assert payload["no_delta_debt"] == []
    assert selected_slot["selected_receipt_id"] == selected_receipt_id
    assert selected_slot["settlement_state"] == "improved"
    assert selected_slot["measured_delta"] == 1
    assert set(selected_slot["before_reason_codes"]) == {
        "post_cost_expectancy_non_positive",
        "closed_session_signal_hold",
        "closed_session_tca_evidence_hold",
    }
    assert set(selected_slot["required_after_receipts"]) == {
        "alpha_readiness_receipt",
        "hypothesis_promotion_receipt",
        "capital_replay_board",
        "torghut.executable-alpha-receipts.v1",
    }


def test_settlement_slots_fall_back_to_before_reasons_when_after_target_missing() -> (
    None
):
    alpha, repair_receipts = _h_cont_repair_receipts()
    after_alpha = {
        "repair_targets": [
            {
                "hypothesis_id": "H-OTHER",
                "reasons": ["post_cost_expectancy_non_positive"],
            }
        ]
    }

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(after_alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    selected_slot = cast(Mapping[str, Any], payload["selected_slot"])
    selected_receipt = cast(Mapping[str, Any], repair_receipts["selected_receipt"])
    assert alpha["repair_targets"]
    assert set(selected_slot["after_reason_codes"]) == set(
        selected_receipt["reason_codes"]
    )
    assert selected_slot["settlement_state"] == "no_delta"


def test_settlement_slots_retire_when_before_blocker_clears() -> None:
    _, repair_receipts = _h_cont_repair_receipts()
    after_alpha = {
        "repair_targets": [
            {
                "hypothesis_id": "H-OTHER",
                "reasons": ["post_cost_expectancy_non_positive"],
            },
            {
                "hypothesis_id": "H-CONT-01",
                "reasons": ["fresh_after_receipt_missing"],
            },
        ]
    }

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(after_alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    selected_slot = cast(Mapping[str, Any], payload["selected_slot"])
    assert selected_slot["settlement_state"] == "retired"
    assert selected_slot["retired_reason_codes"] == [
        "closed_session_signal_hold",
        "closed_session_tca_evidence_hold",
        "post_cost_expectancy_non_positive",
    ]


def test_settlement_slots_improve_when_blocker_count_shrinks() -> None:
    _, repair_receipts = _h_cont_repair_receipts()
    after_alpha = {
        "repair_targets": [
            {
                "hypothesis_id": "H-CONT-01",
                "reasons": ["post_cost_expectancy_non_positive"],
            }
        ]
    }

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(after_alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    selected_slot = cast(Mapping[str, Any], payload["selected_slot"])
    assert selected_slot["settlement_state"] == "improved"
    assert selected_slot["preserved_reason_codes"] == [
        "post_cost_expectancy_non_positive"
    ]


def test_settlement_slots_block_selected_receipt_with_nonzero_notional() -> None:
    alpha, repair_receipts = _h_cont_repair_receipts()
    selected = cast(dict[str, object], repair_receipts["selected_receipt"])
    selected["max_notional"] = "25"

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    assert payload["status"] == "blocked"
    assert payload["selected_slot"] is None
    assert payload["reason_codes"] == ["selected_receipt_notional_nonzero"]


def test_settlement_slots_use_receipt_settlement_reasons_and_keep_unknown_blocker() -> (
    None
):
    alpha, repair_receipts = _h_cont_repair_receipts()
    selected = cast(dict[str, object], repair_receipts["selected_receipt"])
    selected["reason_codes"] = []
    settlement = cast(dict[str, object], selected["settlement"])
    settlement["before_reason_codes"] = ["closed_session_signal_hold"]
    target = cast(dict[str, object], cast(list[object], alpha["repair_targets"])[0])
    target["hypothesis_id"] = "H-OTHER"

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    selected_slot = cast(Mapping[str, Any], payload["selected_slot"])
    assert selected_slot["preserved_reason_codes"] == ["closed_session_signal_hold"]
    no_delta_debt = cast(list[Mapping[str, Any]], payload["no_delta_debt"])
    assert no_delta_debt[0]["remaining_blocker"] == "closed_session_signal_hold"


def test_compact_settlement_slots_reports_missing_payload() -> None:
    compact = compact_executable_alpha_settlement_slots(None)

    assert compact == {
        "schema_version": "torghut.executable-alpha-settlement-slots-ref.v1",
        "status": "missing",
        "reason_codes": ["executable_alpha_settlement_slots_missing"],
    }


def test_settlement_slots_reject_generated_at_without_timezone() -> None:
    alpha, repair_receipts = _h_cont_repair_receipts()

    with pytest.raises(ValueError, match="generated_at_missing_timezone"):
        build_executable_alpha_settlement_slots(
            generated_at=datetime(2026, 5, 13, 22, 55),
            business_state="repair_only",
            revenue_ready=False,
            repair_queue=_top_alpha_queue(),
            capital={"max_notional": "0", "live_submission_allowed": False},
            evidence=_settlement_evidence(alpha),
            executable_alpha_repair_receipts=repair_receipts,
        )


def test_settlement_slots_allow_invalid_fresh_until_as_untrusted_input() -> None:
    alpha, repair_receipts = _h_cont_repair_receipts()
    selected = cast(dict[str, object], repair_receipts["selected_receipt"])
    selected["fresh_until"] = "invalid"

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    assert payload["status"] == "settled"


def test_settlement_slots_block_naive_stale_selected_receipt_timestamp() -> None:
    alpha, repair_receipts = _h_cont_repair_receipts()
    selected = cast(dict[str, object], repair_receipts["selected_receipt"])
    selected["fresh_until"] = (
        (NOW - timedelta(minutes=1)).replace(tzinfo=None).isoformat()
    )

    payload = build_executable_alpha_settlement_slots(
        generated_at=NOW,
        business_state="repair_only",
        revenue_ready=False,
        repair_queue=_top_alpha_queue(),
        capital={"max_notional": "0", "live_submission_allowed": False},
        evidence=_settlement_evidence(alpha),
        executable_alpha_repair_receipts=repair_receipts,
    )

    assert payload["status"] == "blocked"
    assert payload["reason_codes"] == ["selected_executable_alpha_repair_receipt_stale"]


def test_compact_settlement_slots_exposes_no_delta_receipt_ref() -> None:
    payload = _build_settlement_slots()
    compact = compact_executable_alpha_settlement_slots(payload)

    assert compact["schema_version"] == (
        "torghut.executable-alpha-settlement-slots-ref.v1"
    )
    assert compact["status"] == "settled"
    assert compact["selected_hypothesis_id"] == "H-CONT-01"
    assert compact["settlement_state"] == "no_delta"
    assert compact["target_value_gate"] == "routeable_candidate_count"
    assert compact["no_delta_debt_count"] == 1
    assert compact["remaining_blocker"] == "post_cost_expectancy_non_positive"
    assert compact["max_notional"] == "0"
