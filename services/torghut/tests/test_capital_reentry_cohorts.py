from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Mapping, cast

from app.trading.capital_reentry_cohorts import (
    CAPITAL_REENTRY_COHORT_LEDGER_SCHEMA_VERSION,
    build_capital_reentry_cohort_ledger,
)


def _proof_floor(**overrides: object) -> dict[str, object]:
    proof_floor: dict[str, object] = {
        "schema_version": "torghut.profitability-proof-floor.v1",
        "generated_at": "2026-05-08T08:26:00+00:00",
        "account_label": "PA3SX7FYNUTF",
        "route_state": "repair_only",
        "capital_state": "zero_notional",
        "max_notional": "0",
        "blocking_reasons": ["hypothesis_not_promotion_eligible"],
    }
    proof_floor.update(overrides)
    return proof_floor


def _consumer_receipt(**overrides: object) -> dict[str, object]:
    receipt: dict[str, object] = {
        "schema_version": "torghut.consumer-evidence-receipt.v1",
        "receipt_id": "torghut-consumer-evidence:test",
        "generated_at": "2026-05-08T08:26:00+00:00",
        "fresh_until": "2026-05-08T08:27:00+00:00",
        "candidate_id": "chip-paper-microbar-composite@execution-proof",
        "dataset_snapshot_ref": "torghut-chip-full-day-20260505-4c330ce9-r1",
        "forecast_registry_state": "degraded",
        "paper_readiness_state": "blocked",
        "live_readiness_state": "blocked",
        "max_notional": "0",
        "reason_codes": [
            "forecast_registry_degraded",
            "simple_submit_disabled",
            "hypothesis_not_promotion_eligible",
        ],
    }
    receipt.update(overrides)
    return receipt


def _route_row(
    symbol: str,
    state: str,
    blocker: str,
    value: int,
    required_receipts: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return {
        "proof_packet_id": f"route-repair:PA3SX7FYNUTF:{symbol}:{state}",
        "symbol": symbol,
        "state": state,
        "current_blocker": blocker,
        "expected_unblock_value": value,
        "required_receipts": dict(required_receipts or {}),
        "max_notional": "0",
    }


def _route_board() -> dict[str, object]:
    return {
        "schema_version": "torghut.route-reacquisition-board.v1",
        "generated_at": "2026-05-08T08:26:00+00:00",
        "account_label": "PA3SX7FYNUTF",
        "trading_mode": "live",
        "capital_state": "zero_notional",
        "state": "repair_only",
        "summary": {
            "capital_eligible_symbol_count": 0,
            "expected_unblock_value": 14,
        },
        "rows": [
            _route_row(
                "AAPL",
                "probing",
                "route_tca_passed_but_dependency_receipts_block_capital",
                3,
                {
                    "market_context_receipt": {"state": "missing"},
                    "quant_pipeline_receipt": {"state": "missing"},
                    "alpha_readiness_receipt": {"state": "fail"},
                },
            ),
            _route_row(
                "NVDA", "blocked", "execution_tca_route_universe_exclusions_applied", 2
            ),
            _route_row("AMZN", "missing", "execution_tca_symbol_missing", 1),
        ],
    }


def _cohort(ledger: Mapping[str, Any], cohort_class: str) -> Mapping[str, Any]:
    for raw_cohort in cast(list[Mapping[str, Any]], ledger["cohorts"]):
        if raw_cohort["cohort_class"] == cohort_class:
            return raw_cohort
    raise AssertionError(f"missing cohort {cohort_class}")


def test_capital_reentry_ledger_groups_unsettled_receipt_cohorts_at_zero_notional() -> (
    None
):
    ledger = build_capital_reentry_cohort_ledger(
        account_label="PA3SX7FYNUTF",
        trading_mode="live",
        torghut_revision="torghut-00302",
        consumer_evidence_receipt=_consumer_receipt(),
        proof_floor_receipt=_proof_floor(),
        route_reacquisition_board=_route_board(),
        jangar_material_verdict_ref={
            "verdict_ref": "material-action-verdict:paper_canary:hold",
            "decision": "hold",
            "reason_codes": ["controller_witness_split"],
        },
        now=datetime(2026, 5, 8, 8, 26, tzinfo=timezone.utc),
    )

    assert ledger["schema_version"] == CAPITAL_REENTRY_COHORT_LEDGER_SCHEMA_VERSION
    assert str(ledger["ledger_id"]).startswith("capital-reentry-ledger:")
    assert ledger["aggregate_state"] == "repair"
    assert ledger["consumer_evidence_receipt_id"] == "torghut-consumer-evidence:test"
    assert ledger["summary"]["cohort_count"] == 5
    assert ledger["summary"]["zero_notional_cohort_count"] == 5
    assert ledger["summary"]["paper_candidate_count"] == 0

    cohorts = cast(list[Mapping[str, Any]], ledger["cohorts"])
    assert all(cohort["max_notional"] == "0" for cohort in cohorts)

    receipt_settlement = _cohort(ledger, "receipt_settlement")
    assert receipt_settlement["symbol_set"] == ["AAPL"]
    assert receipt_settlement["current_state"] == "repair"
    assert "forecast_registry_degraded" in receipt_settlement["blocking_reason_codes"]
    assert "jangar_material_verdict_hold" in receipt_settlement["blocking_reason_codes"]
    assert "capital_gate_safety" in receipt_settlement["metric_bindings"]

    tca_repair = _cohort(ledger, "tca_repair")
    assert tca_repair["symbol_set"] == ["NVDA"]

    missing_tca = _cohort(ledger, "missing_tca_probe")
    assert missing_tca["symbol_set"] == ["AMZN"]
