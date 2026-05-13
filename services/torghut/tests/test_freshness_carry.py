from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, cast

from app.trading.freshness_carry import (
    FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION,
    build_freshness_carry_ledger,
)


NOW = datetime(2026, 5, 13, 9, 15, tzinfo=timezone.utc)


def _base_inputs() -> dict[str, object]:
    return {
        "account_label": "PA3SX7FYNUTF",
        "window": "15m",
        "source_serving_repair_receipt_ledger": {
            "schema_version": "torghut.source-serving-repair-receipt-ledger.v1",
            "ledger_id": "source-serving:current",
            "source_serving_state": "converged",
            "generated_at": NOW.isoformat(),
            "reason_codes": [],
        },
        "route_warrant_exchange": {
            "schema_version": "torghut.route-warrant-exchange.v1",
            "warrant_id": "route-warrant:current",
            "warrant_state": "paper_candidate",
            "max_notional": "25",
        },
        "clickhouse_ta_status": {
            "state": "current",
            "latest_signal_at": (NOW - timedelta(seconds=30)).isoformat(),
            "source_ref": "torghut.ta_signals",
        },
        "tca_summary": {
            "order_count": 24,
            "expected_shortfall_coverage": "0.75",
            "last_computed_at": (NOW - timedelta(minutes=5)).isoformat(),
        },
        "empirical_jobs_status": {
            "ready": True,
            "status": "healthy",
            "authority": "empirical",
            "stale_jobs": [],
            "missing_jobs": [],
            "ineligible_jobs": [],
        },
        "market_context_status": {
            "last_checked_at": (NOW - timedelta(seconds=20)).isoformat(),
            "last_freshness_seconds": 20,
            "max_staleness_seconds": 900,
            "last_risk_flags": [],
            "alert_active": False,
            "last_symbol": "AAPL",
        },
        "quant_evidence": {
            "ok": True,
            "required": True,
            "window": "15m",
        },
        "live_submission_gate": {
            "allowed": True,
            "reason": "ok",
        },
        "now": NOW,
    }


def _build(**overrides: object) -> dict[str, object]:
    payload = _base_inputs()
    payload.update(overrides)
    return build_freshness_carry_ledger(**payload)  # type: ignore[arg-type]


def _dimension(ledger: dict[str, object], dimension_id: str) -> dict[str, Any]:
    dimensions = cast(list[dict[str, Any]], ledger["dimensions"])
    return next(
        dimension
        for dimension in dimensions
        if dimension["dimension_id"] == dimension_id
    )


def test_partial_ta_freshness_keeps_capital_zero_and_opens_repair_slo() -> None:
    ledger = _build(
        clickhouse_ta_status={
            "state": "current",
            "latest_signal_at": (NOW - timedelta(hours=2)).isoformat(),
            "source_ref": "torghut.ta_signals",
        }
    )

    assert ledger["schema_version"] == FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION
    assert ledger["capital_posture"]["decision"] == "repair_only"
    assert ledger["capital_posture"]["max_notional"] == "0"
    assert _dimension(ledger, "ta_signals")["state"] == "stale"
    assert "ta_signal_lag_exceeded" in ledger["capital_posture"]["reason_codes"]
    assert (
        ledger["summary"]["zero_notional_or_stale_evidence_rate"]
        == "0.1666666666666666666666666667"
    )

    ta_slo = next(
        slo
        for slo in ledger["repair_proof_slos"]
        if slo["target_dimension_id"] == "ta_signals"
    )
    assert ta_slo["dispatchable"] is True
    assert ta_slo["max_notional"] == "0"
    assert ta_slo["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert ta_slo["required_output_receipts"] == [
        "torghut.ta-freshness-repair-receipt.v1"
    ]


def test_current_freshness_can_be_paper_candidate_without_widening_route_warrant() -> (
    None
):
    ledger = _build()

    assert ledger["capital_posture"]["decision"] == "paper_candidate"
    assert ledger["capital_posture"]["max_notional"] == "25"
    assert ledger["capital_posture"]["reason_codes"] == []
    assert ledger["repair_proof_slos"] == []
    assert ledger["summary"]["zero_notional_or_stale_evidence_rate"] == "0"
    assert all(
        dimension["stale_reason_codes"] == [] for dimension in ledger["dimensions"]
    )


def test_source_serving_gap_holds_non_source_freshness_repairs() -> None:
    ledger = _build(
        source_serving_repair_receipt_ledger={
            "schema_version": "torghut.source-serving-repair-receipt-ledger.v1",
            "ledger_id": "source-serving:stale",
            "source_serving_state": "digest_unknown",
            "generated_at": NOW.isoformat(),
            "reason_codes": ["serving_image_digest_missing"],
        },
        tca_summary={
            "order_count": 24,
            "expected_shortfall_coverage": "0.10",
            "last_computed_at": (NOW - timedelta(minutes=5)).isoformat(),
        },
    )

    assert ledger["capital_posture"]["decision"] == "repair_only"
    assert _dimension(ledger, "source_serving")["state"] == "stale"
    assert _dimension(ledger, "tca")["state"] == "low_confidence"

    source_slo = next(
        slo
        for slo in ledger["repair_proof_slos"]
        if slo["target_dimension_id"] == "source_serving"
    )
    tca_slo = next(
        slo
        for slo in ledger["repair_proof_slos"]
        if slo["target_dimension_id"] == "tca"
    )
    assert source_slo["dispatchable"] is True
    assert tca_slo["dispatchable"] is False
    assert tca_slo["hold_reason_codes"] == ["source_serving_not_current"]
