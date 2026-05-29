from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

import pytest

from app.trading.quality_adjusted_profit_frontier import (
    build_quality_adjusted_profit_frontier,
)


NOW = datetime(2026, 5, 8, 12, 0, tzinfo=timezone.utc)


def _frontier(
    *,
    quant_evidence: Mapping[str, Any] | None = None,
    market_context_status: Mapping[str, Any] | None = None,
    simulation_cache_status: Mapping[str, Any] | None = None,
    jangar_evidence_quality: Mapping[str, Any] | None = None,
) -> dict[str, object]:
    quality = (
        {
            "jangar_evidence_quality_ref": "quality-ledger:clean",
            "quality_state": "clean",
            "decision": "allow",
        }
        if jangar_evidence_quality is None
        else jangar_evidence_quality
    )
    return build_quality_adjusted_profit_frontier(
        account_label="PA3SX7FYNUTF",
        trading_mode="paper",
        torghut_revision="torghut-quality-frontier",
        proof_floor_receipt={
            "generated_at": "2026-05-08T12:00:00+00:00",
            "capital_state": "paper_allowed",
            "blocking_reasons": [],
        },
        route_reacquisition_board={
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "routeable",
                    "hypothesis_ids": ["H-CONT-01"],
                    "expected_cost_class": "low",
                    "avg_abs_slippage_bps": "4.5",
                    "slippage_guardrail_bps": "8",
                }
            ]
        },
        live_submission_gate={"allowed": True, "blocked_reasons": []},
        hypothesis_payload={"items": [{"hypothesis_id": "H-CONT-01"}]},
        quant_evidence=quant_evidence
        or {
            "status": "healthy",
            "ok": True,
            "latest_metrics_count": 4284,
            "stage_count": 3,
        },
        market_context_status=market_context_status
        or {"status": "healthy", "state": "fresh", "last_quality_score": 0.98},
        simulation_cache_status=simulation_cache_status
        or {"enabled": True, "last_updated_at": "2026-05-08T11:55:00+00:00"},
        jangar_evidence_quality=quality,
        now=NOW,
    )


def _packet(frontier: Mapping[str, object], repair_class: str) -> Mapping[str, Any]:
    packets = cast(list[Mapping[str, Any]], frontier["packets"])
    return next(packet for packet in packets if packet["repair_class"] == repair_class)


@pytest.mark.parametrize(
    ("field", "payload", "repair_class", "expected_receipts", "expected_decision"),
    [
        (
            "quant_evidence",
            {
                "latest_metrics_count": 4284,
                "degraded_latest_metrics_count": 4163,
                "stage_count": 3,
            },
            "quant",
            {"quant_latest_metrics_degraded"},
            "repair",
        ),
        (
            "quant_evidence",
            {"latest_metrics_count": 144, "stage_count": 0},
            "quant",
            {"quant_pipeline_stages_missing"},
            "repair",
        ),
        (
            "quant_evidence",
            {
                "open_alerts": [{"severity": "critical", "status": "open"}],
            },
            "quant",
            {"quant_critical_alert_open"},
            "hold",
        ),
        (
            "market_context_status",
            {
                "stale_technicals_count": 9,
                "stale_regime_count": 15,
                "risk_flag_count": 25,
                "risk_flags": ["technicals_source_error"],
            },
            "market_context",
            {"market_context_stale", "market_context_risk_flags"},
            "repair",
        ),
        (
            "simulation_cache_status",
            {
                "enabled": True,
                "run_id": "sim-march",
                "last_updated_at": "2026-03-19T10:08:32.208+00:00",
                "max_age_seconds": 7 * 24 * 60 * 60,
            },
            "simulation",
            {"simulation_cache_stale"},
            "repair",
        ),
    ],
)
def test_non_promoting_inputs_create_zero_notional_repair_packets(
    field: str,
    payload: Mapping[str, Any],
    repair_class: str,
    expected_receipts: set[str],
    expected_decision: str,
) -> None:
    frontier = _frontier(**{field: payload})
    packet = _packet(frontier, repair_class)
    escrow = cast(list[Mapping[str, Any]], frontier["hypothesis_escrows"])[0]

    assert frontier["capital_state"] == "zero_notional"
    assert frontier["paper_probe_notional_limit"] == "0"
    assert packet["decision"] == expected_decision
    assert packet["capital_class"] == "zero_notional_repair"
    assert expected_receipts <= set(packet["non_promoting_receipts"])
    assert expected_receipts <= set(escrow["blockers"])


def test_missing_jangar_quality_ref_keeps_hypothesis_escrow_repair_only() -> None:
    frontier = _frontier(jangar_evidence_quality={})
    escrow = cast(list[Mapping[str, Any]], frontier["hypothesis_escrows"])[0]

    assert frontier["paper_probe_notional_limit"] == "0"
    assert "jangar_quality_ledger_missing" in frontier["blocked_capital_surfaces"]
    assert escrow["promotion_state"] == "repair_only"
    assert "jangar_quality" in escrow["missing_receipts"]
