from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timezone
from typing import Any, cast

from app.trading.profit_repair_settlement import (
    PROFIT_REPAIR_SETTLEMENT_LEDGER_SCHEMA_VERSION,
    build_profit_repair_settlement_ledger,
)


NOW = datetime(2026, 5, 8, 12, 20, tzinfo=timezone.utc)


def _base_inputs() -> dict[str, object]:
    return {
        "account_label": "PA3SX7FYNUTF",
        "trading_mode": "live",
        "torghut_revision": "torghut-00307",
        "consumer_evidence_receipt": {
            "receipt_id": "torghut-consumer-evidence:test",
            "fresh_until": "2026-05-08T12:21:00+00:00",
            "forecast_registry_state": "degraded",
            "reason_codes": [
                "forecast_registry_degraded",
                "simple_submit_disabled",
                "hypothesis_not_promotion_eligible",
            ],
        },
        "proof_floor_receipt": {
            "route_state": "repair_only",
            "capital_state": "zero_notional",
            "max_notional": "0",
            "blocking_reasons": ["hypothesis_not_promotion_eligible"],
        },
        "capital_reentry_cohort_ledger": {
            "ledger_id": "capital-reentry-ledger:test",
            "aggregate_state": "repair",
            "cohorts": [
                {
                    "cohort_class": "receipt_settlement",
                    "symbol_set": ["AAPL"],
                    "blocking_reason_codes": ["market_context_receipt_missing"],
                }
            ],
        },
        "quality_adjusted_profit_frontier": {
            "frontier_id": "quality-frontier:test",
            "summary": {"capital_ready": False},
            "blocked_capital_surfaces": [
                "schema_lineage_missing",
                "rejection_drag_unmeasured",
            ],
        },
        "route_reacquisition_board": {
            "rows": [
                {
                    "symbol": "AAPL",
                    "state": "probing",
                    "current_blocker": "route_tca_passed_but_dependency_receipts_block_capital",
                },
                {
                    "symbol": "NVDA",
                    "state": "blocked",
                    "current_blocker": "execution_tca_route_universe_exclusions_applied",
                    "avg_abs_slippage_bps": "13.82",
                    "slippage_guardrail_bps": "8",
                },
                {
                    "symbol": "AMZN",
                    "state": "missing",
                    "current_blocker": "execution_tca_symbol_missing",
                },
            ],
        },
        "live_submission_gate": {
            "allowed": False,
            "reason": "simple_submit_disabled",
            "blocked_reasons": ["simple_submit_disabled"],
            "profit_lease_projection": {
                "leases": [
                    {
                        "blocking_reason_codes": [
                            "schema_lineage_missing",
                            "research_candidates_empty",
                            "rejection_drag_unmeasured",
                        ]
                    }
                ]
            },
        },
        "quant_evidence": {
            "ok": False,
            "stage_count": 0,
            "blocking_reasons": ["quant_pipeline_degraded"],
        },
        "jangar_execution_trust_admission_ref": {
            "admission_ref": "jangar-execution-trust:test",
            "decision": "hold",
            "state": "degraded",
            "reason_codes": ["controller_witness_split"],
        },
        "now": NOW,
    }


def _ledger(**overrides: object) -> dict[str, object]:
    payload = _base_inputs()
    payload.update(overrides)
    return build_profit_repair_settlement_ledger(**payload)


def _lot(ledger: Mapping[str, object], lot_class: str) -> Mapping[str, Any]:
    for raw_lot in cast(list[Mapping[str, Any]], ledger["repair_lots"]):
        if raw_lot["lot_class"] == lot_class:
            return raw_lot
    raise AssertionError(f"missing lot {lot_class}")


def test_profit_repair_settlement_groups_execution_trust_lots_at_zero_notional() -> (
    None
):
    ledger = _ledger()

    assert ledger["schema_version"] == PROFIT_REPAIR_SETTLEMENT_LEDGER_SCHEMA_VERSION
    assert ledger["aggregate_state"] == "repair"
    assert ledger["next_safe_action"] == "zero_notional_repair"
    assert ledger["capital_reentry_ledger_ref"] == "capital-reentry-ledger:test"
    assert ledger["quality_frontier_ref"] == "quality-frontier:test"
    assert ledger["summary"]["lot_count"] == 7
    assert ledger["summary"]["zero_notional_lot_count"] == 7

    quant = _lot(ledger, "quant_freshness")
    assert "quant_pipeline_degraded" in quant["blocking_reason_codes"]
    assert "quant_pipeline_stages_missing" in quant["blocking_reason_codes"]

    aapl = _lot(ledger, "aapl_receipt_settlement")
    assert aapl["symbol_set"] == ["AAPL"]
    assert "jangar_execution_trust_hold" in aapl["blocking_reason_codes"]
    assert "controller_witness_split" in aapl["blocking_reason_codes"]

    tca = _lot(ledger, "route_tca")
    assert tca["symbol_set"] == ["NVDA"]
    assert "execution_tca_slippage_above_guardrail" in tca["blocking_reason_codes"]

    schema = _lot(ledger, "schema_lineage")
    assert "schema_lineage_missing" in schema["blocking_reason_codes"]
    assert "rejection_drag_unmeasured" in schema["blocking_reason_codes"]


def test_optional_unconfigured_quant_health_does_not_create_quant_repair() -> None:
    ledger = _ledger(
        quant_evidence={
            "required": False,
            "ok": True,
            "status": "not_required",
            "reason": "quant_health_not_configured",
            "blocking_reasons": [],
            "informational_reasons": ["quant_health_not_configured"],
            "source_url": None,
        }
    )

    quant = _lot(ledger, "quant_freshness")

    assert quant["current_state"] == "observe"
    assert quant["blocking_reason_codes"] == []
