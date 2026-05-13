from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.trading.repair_outcome_dividend import (
    REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION,
    build_repair_outcome_dividend_ledger,
)


NOW = datetime(2026, 5, 13, 12, 30, tzinfo=timezone.utc)


def _lot(
    lot_class: str,
    reason: str,
    *,
    dispatchable: bool = True,
) -> dict[str, object]:
    output_receipts = {
        "quant_pipeline": "torghut.quant-pipeline-current-receipt.v1",
        "feature_lineage": "torghut.feature-lineage-current-receipt.v1",
        "execution_tca": "torghut.execution-tca-current-receipt.v1",
    }
    value_gates = {
        "quant_pipeline": "zero_notional_or_stale_evidence_rate",
        "feature_lineage": "zero_notional_or_stale_evidence_rate",
        "execution_tca": "fill_tca_or_slippage_quality",
    }
    return {
        "lot_id": f"compacted-repair-lot:{lot_class}:{reason}",
        "lot_class": lot_class,
        "target_value_gate": value_gates[lot_class],
        "expected_gate_delta": f"retire_{reason}",
        "raw_reason_codes": [reason],
        "required_output_receipt": output_receipts[lot_class],
        "state": "selected",
        "dispatchable": dispatchable,
        "hold_reason_codes": [] if dispatchable else ["dispatch_limit_exceeded"],
        "max_notional": "0",
    }


def _repair_bid_settlement() -> dict[str, object]:
    lots = [
        _lot("quant_pipeline", "quant_health_not_configured"),
        _lot("feature_lineage", "market_context_evidence_missing"),
        _lot("execution_tca", "execution_tca_stale"),
        _lot("feature_lineage", "forecast_registry_degraded", dispatchable=False),
    ]
    return {
        "schema_version": "torghut.repair-bid-settlement-ledger.v1",
        "ledger_id": "repair-bid-settlement-ledger:test",
        "generated_at": NOW.isoformat(),
        "fresh_until": (NOW + timedelta(seconds=60)).isoformat(),
        "compacted_lots": lots,
        "selected_lot_ids": [lot["lot_id"] for lot in lots],
        "dispatchable_lot_ids": [lot["lot_id"] for lot in lots[:3]],
        "held_lot_ids": [lots[3]["lot_id"]],
        "routeable_candidate_count": 0,
        "max_notional": "0",
    }


def _build(
    *,
    repair_outcome_receipts: list[dict[str, object]] | None = None,
) -> dict[str, object]:
    return build_repair_outcome_dividend_ledger(
        account_label="PA3SX7FYNUTF",
        window="15m",
        trading_mode="live",
        repair_bid_settlement_ledger=_repair_bid_settlement(),
        repair_receipt_frontier={
            "schema_version": "torghut.repair-receipt-frontier.v1",
            "frontier_id": "repair-receipt-frontier:test",
            "max_notional": "0",
        },
        freshness_carry_ledger={
            "schema_version": "torghut.freshness-carry-ledger.v1",
            "ledger_id": "freshness-carry-ledger:test",
        },
        route_warrant_exchange={
            "schema_version": "torghut.route-warrant-exchange.v1",
            "warrant_id": "route-warrant:test",
            "warrant_state": "repair_only",
            "max_notional": "0",
        },
        live_submission_gate={
            "allowed": False,
            "reason": "simple_submit_disabled",
        },
        repair_outcome_receipts=repair_outcome_receipts,
        now=NOW,
    )


def test_dispatchable_repair_lots_open_zero_notional_outcome_escrows() -> None:
    ledger = _build()

    assert ledger["schema_version"] == REPAIR_OUTCOME_DIVIDEND_LEDGER_SCHEMA_VERSION
    assert ledger["capital_stage"] == "shadow"
    assert ledger["capital_state"] == "zero_notional"
    assert ledger["max_notional"] == "0"
    assert ledger["live_submit_enabled"] is False
    assert ledger["source_repair_bid_settlement_ledger_id"] == (
        "repair-bid-settlement-ledger:test"
    )
    assert ledger["summary"]["repair_receipt_binding_count"] == 3
    assert ledger["summary"]["open_escrow_count"] == 3
    assert ledger["summary"]["routeable_candidate_count"] == 0
    assert len(ledger["outcome_receipts"]) == 3
    assert len(ledger["open_escrows"]) == 3
    assert {receipt["terminal_state"] for receipt in ledger["outcome_receipts"]} == {
        "pending"
    }
    assert all(
        receipt["dividend"] == "pending" and receipt["next_action"] == "hold"
        for receipt in ledger["outcome_receipts"]
    )
    assert ledger["next_repair_frontier"]["dispatchable_lot_ids"] == [
        "compacted-repair-lot:quant_pipeline:quant_health_not_configured",
        "compacted-repair-lot:feature_lineage:market_context_evidence_missing",
        "compacted-repair-lot:execution_tca:execution_tca_stale",
    ]


def test_no_delta_outcome_preserves_reason_and_rolls_lot_forward() -> None:
    ledger = _build(
        repair_outcome_receipts=[
            {
                "receipt_id": "torghut-feature-lineage-receipt:no-delta",
                "repair_lot_id": (
                    "compacted-repair-lot:feature_lineage:"
                    "market_context_evidence_missing"
                ),
                "schema_version": "torghut.feature-lineage-current-receipt.v1",
                "terminal_state": "succeeded",
                "preserved_reason_codes": ["market_context_evidence_missing"],
                "generated_at": NOW.isoformat(),
            }
        ]
    )

    receipt = next(
        receipt
        for receipt in ledger["outcome_receipts"]
        if receipt["repair_lot_id"]
        == "compacted-repair-lot:feature_lineage:market_context_evidence_missing"
    )
    assert receipt["outcome"] == "no_delta"
    assert receipt["dividend"] == "zero"
    assert receipt["next_action"] == "roll_forward"
    assert receipt["retired_reason_codes"] == []
    assert receipt["preserved_reason_codes"] == ["market_context_evidence_missing"]
    assert ledger["no_delta_lots"] == [
        "compacted-repair-lot:feature_lineage:market_context_evidence_missing"
    ]
    assert "market_context_evidence_missing" in ledger["preserved_reason_codes"]
    assert ledger["summary"]["open_escrow_count"] == 2
    assert ledger["summary"]["no_delta_lot_count"] == 1


def test_positive_outcome_releases_one_zero_notional_repair_credit() -> None:
    ledger = _build(
        repair_outcome_receipts=[
            {
                "receipt_id": "torghut-tca-receipt:current",
                "repair_lot_id": "compacted-repair-lot:execution_tca:execution_tca_stale",
                "schema_version": "torghut.execution-tca-current-receipt.v1",
                "terminal_state": "succeeded",
                "retired_reason_codes": ["execution_tca_stale"],
                "preserved_reason_codes": [],
                "routeable_candidate_delta": 0,
            }
        ]
    )

    receipt = next(
        receipt
        for receipt in ledger["outcome_receipts"]
        if receipt["repair_lot_id"]
        == "compacted-repair-lot:execution_tca:execution_tca_stale"
    )
    assert receipt["outcome"] == "retired_reason_codes"
    assert receipt["dividend"] == "positive"
    assert receipt["next_action"] == "release_credit"
    assert ledger["retired_reason_codes"] == ["execution_tca_stale"]
    assert ledger["next_repair_frontier"]["credit_release_lot_ids"] == [
        "compacted-repair-lot:execution_tca:execution_tca_stale"
    ]
    assert ledger["summary"]["positive_dividend_count"] == 1
    assert ledger["summary"]["routeable_candidate_count"] == 0
