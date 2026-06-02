from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, cast

from app.trading.freshness_carry import (
    FRESHNESS_CARRY_LEDGER_SCHEMA_VERSION,
    _jangar_pressure_refs,
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
    pressure_ref = next(
        ref
        for ref in ledger["jangar_pressure_refs"]
        if ref["target_dimension_id"] == "ta_signals"
    )
    assert str(pressure_ref["pressure_ref_id"]).startswith("freshness-pressure-ref:")
    assert pressure_ref["source_class"] == "torghut_freshness"
    assert pressure_ref["action_class"] == "dispatch_repair"
    assert pressure_ref["freshness_carry_ledger_ref"] == ledger["ledger_id"]
    assert pressure_ref["repair_proof_slo_ref"] == ta_slo["repair_id"]
    assert pressure_ref["target_value_gate"] == "zero_notional_or_stale_evidence_rate"
    assert pressure_ref["required_output_receipts"] == [
        "torghut.ta-freshness-repair-receipt.v1"
    ]
    assert pressure_ref["ttl_seconds"] == 60
    assert str(pressure_ref["dedupe_key"]).startswith("freshness-pressure-dedupe:")
    assert pressure_ref["max_notional"] == "0"
    assert pressure_ref["dispatchable"] is True
    assert pressure_ref["reason_codes"] == ["ta_signal_lag_exceeded"]


def test_current_freshness_can_be_paper_candidate_without_widening_route_warrant() -> (
    None
):
    ledger = _build()

    assert ledger["capital_posture"]["decision"] == "paper_candidate"
    assert ledger["capital_posture"]["max_notional"] == "25"
    assert ledger["capital_posture"]["reason_codes"] == []
    assert ledger["repair_proof_slos"] == []
    assert ledger["jangar_pressure_refs"] == []
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
    tca_pressure_ref = next(
        ref
        for ref in ledger["jangar_pressure_refs"]
        if ref["target_dimension_id"] == "tca"
    )
    assert tca_pressure_ref["dispatchable"] is False
    assert tca_pressure_ref["hold_reason_codes"] == ["source_serving_not_current"]
    assert tca_pressure_ref["reason_codes"] == [
        "expected_shortfall_coverage_low",
        "source_serving_not_current",
    ]


def test_pressure_refs_backfill_external_ids_and_skip_malformed_slos() -> None:
    refs = _jangar_pressure_refs(
        account_label="PA3SX7FYNUTF",
        window="15m",
        ledger_id="freshness-carry-ledger:test",
        fresh_until=(NOW + timedelta(seconds=60)).isoformat(),
        dimensions=[
            {
                "dimension_id": "ta_signals",
                "state": "stale",
                "stale_reason_codes": ["ta_signal_lag_exceeded"],
            }
        ],
        repair_proof_slos=[{"repair_id": "repair-proof-slo:malformed"}],
        external_refs=[
            {
                "schema_version": "torghut.jangar-pressure-ref.v1",
                "source_class": "manual_freshness",
                "target_dimension_id": "manual",
            }
        ],
    )

    assert len(refs) == 1
    assert str(refs[0]["pressure_ref_id"]).startswith("freshness-pressure-ref:")
    assert refs[0]["source_class"] == "manual_freshness"


def test_malformed_freshness_inputs_are_repair_only_with_typed_reasons() -> None:
    ledger = _build(
        source_serving_repair_receipt_ledger={
            "schema_version": "torghut.source-serving-repair-receipt-ledger.v1",
            "ledger_id": "source-serving:unknown",
            "source_serving_state": "booting",
            "generated_at": "not-a-date",
            "reason_codes": [],
        },
        clickhouse_ta_status={
            "state": "warming",
            "latest_signal_at": "2026-05-13T09:14:40Z",
            "low_memory_fallback_count": True,
            "source_ref": "torghut.ta_signals",
        },
        tca_summary={
            "order_count": True,
            "expected_shortfall_coverage": "not-a-decimal",
            "last_computed_at": "",
        },
        empirical_jobs_status={
            "ready": "false",
            "status": "degraded",
            "authority": "empirical",
            "stale_jobs": ["ranker"],
            "missing_jobs": [],
            "ineligible_jobs": [],
        },
        market_context_status={
            "last_checked_at": "not-a-date",
            "last_freshness_seconds": 1_200,
            "max_staleness_seconds": 900,
            "last_risk_flags": [],
            "health_error": "timeout",
            "last_symbol": "AAPL",
        },
        quant_evidence={
            "ok": "false",
            "required": "true",
            "reason": "quant_evidence_stale",
            "checked_at": "not-a-date",
            "window": "15m",
        },
        live_submission_gate={
            "allowed": "false",
            "reason": "",
        },
    )

    assert ledger["capital_posture"]["decision"] == "repair_only"
    assert ledger["capital_posture"]["max_notional"] == "0"
    assert "live_submission_gate_closed" in ledger["capital_posture"]["reason_codes"]

    ta_dimension = _dimension(ledger, "ta_signals")
    assert ta_dimension["state"] == "unknown"
    assert ta_dimension["low_memory_fallback_count"] == 1
    assert ta_dimension["max_event_at"] == "2026-05-13T09:14:40+00:00"
    assert "clickhouse_ta_warming" in ta_dimension["stale_reason_codes"]

    assert _dimension(ledger, "tca")["state"] == "missing"
    assert "tca_computed_at_missing" in _dimension(ledger, "tca")["stale_reason_codes"]
    assert _dimension(ledger, "empirical")["state"] == "stale"
    market_dimension = _dimension(ledger, "market_context")
    assert market_dimension["state"] == "stale"
    assert market_dimension["required_repair_receipt"] is None
    assert (
        "market_context_health_error"
        in market_dimension["stale_reason_codes"]
    )
    assert not any(
        slo["target_dimension_id"] == "market_context"
        for slo in ledger["repair_proof_slos"]
    )
    assert {
        "value_gate": "diagnostic",
        "dimension_id": "market_context",
        "state": "stale",
        "capital_effect": "no_capital_change",
    } in ledger["value_gate_impacts"]
    assert (
        "market_context"
        not in ledger["capital_posture"]["non_current_dimension_ids"]
    )
    assert _dimension(ledger, "quant_evidence")["state"] == "stale"
    assert _dimension(ledger, "source_serving")["state"] == "unknown"
    assert (
        "source_serving_booting"
        in _dimension(ledger, "source_serving")["stale_reason_codes"]
    )


def test_tca_missing_timestamp_and_stale_receipts_open_repair_slos() -> None:
    missing_timestamp_ledger = _build(
        tca_summary={
            "order_count": 8,
            "expected_shortfall_coverage": "0.75",
            "last_computed_at": "",
        }
    )
    stale_ledger = _build(
        tca_summary={
            "order_count": 8,
            "expected_shortfall_coverage": "0.75",
            "last_computed_at": (NOW - timedelta(days=2)).isoformat(),
        }
    )

    missing_tca = _dimension(missing_timestamp_ledger, "tca")
    stale_tca = _dimension(stale_ledger, "tca")
    assert missing_tca["state"] == "missing"
    assert missing_tca["stale_reason_codes"] == ["tca_computed_at_missing"]
    assert stale_tca["state"] == "stale"
    assert stale_tca["stale_reason_codes"] == ["tca_computed_at_stale"]
    assert any(
        slo["target_dimension_id"] == "tca" for slo in stale_ledger["repair_proof_slos"]
    )


def test_current_freshness_can_be_live_candidate_without_widening_route_warrant() -> (
    None
):
    ledger = _build(
        route_warrant_exchange={
            "schema_version": "torghut.route-warrant-exchange.v1",
            "warrant_id": "route-warrant:live",
            "warrant_state": "live_micro_candidate",
            "max_notional": "5",
        }
    )

    assert ledger["capital_posture"]["decision"] == "live_candidate"
    assert ledger["capital_posture"]["max_notional"] == "5"
    assert ledger["repair_proof_slos"] == []
