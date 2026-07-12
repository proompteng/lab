from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.trading.execution_runtime import (
    ExecutionOrderResult,
    build_execution_status_payload,
    record_last_execution_order,
)


def test_execution_status_uses_the_shared_operational_gate_without_reinterpretation() -> (
    None
):
    metrics = SimpleNamespace(
        orders_submitted_total=3,
        orders_rejected_total=4,
        decision_reject_reason_total={
            "broker_submit_failed": 2,
            "capital_stage_shadow": 9,
            "non_operational_diagnostic": 1,
            "proof_collection_pending": 1,
            "research_evidence_missing": 1,
        },
    )
    state = SimpleNamespace(metrics=metrics, last_execution_order=None)

    payload = build_execution_status_payload(
        state=state,
        live_submission_gate={
            "allowed": False,
            "reason": "accepted_ta_signal_stale",
            "blocked_reasons": ["accepted_ta_signal_stale"],
            "execution_route": {
                "route": "alpaca",
                "reason": "alpaca_regular_session_open",
                "alpaca_regular_session_open": True,
            },
        },
    )

    assert payload["gate"]["allowed"] is False
    assert payload["gate"]["reason"] == "accepted_ta_signal_stale"
    assert payload["gate"]["blocked_reasons"] == ["accepted_ta_signal_stale"]
    assert payload["reject_reason_totals"] == {"broker_submit_failed": 2}


def test_execution_status_reads_last_order_payload() -> None:
    metrics = SimpleNamespace(
        orders_submitted_total=1,
        orders_rejected_total=0,
        decision_reject_reason_total={},
    )
    state = SimpleNamespace(metrics=metrics)

    record_last_execution_order(
        state=state,
        order=ExecutionOrderResult(
            route="alpaca",
            symbol="NVDA",
            side="buy",
            notional=Decimal("12.50"),
            broker_order_id=None,
            status="accepted",
            submitted_at="2026-07-04T00:00:00Z",
        ),
    )

    payload = build_execution_status_payload(
        state=state,
        live_submission_gate={
            "allowed": True,
            "reason": "operational_submission_ready",
            "blocked_reasons": [],
            "execution_route": {"route": "alpaca"},
        },
    )

    assert payload["last_submitted_order"] == {
        "route": "alpaca",
        "symbol": "NVDA",
        "side": "buy",
        "notional": "12.50",
        "broker_order_id": None,
        "status": "accepted",
        "submitted_at": "2026-07-04T00:00:00Z",
    }


def test_execution_status_handles_non_mapping_reject_totals() -> None:
    metrics = SimpleNamespace(
        orders_submitted_total=0,
        orders_rejected_total=0,
        decision_reject_reason_total=["bad-shape"],
    )
    state = SimpleNamespace(metrics=metrics, last_execution_order=None)

    payload = build_execution_status_payload(
        state=state,
        live_submission_gate={"allowed": True, "blocked_reasons": []},
    )

    assert payload["reject_reason_totals"] == {}


def test_execution_status_coerces_reject_reason_counts() -> None:
    metrics = SimpleNamespace(
        orders_submitted_total=0,
        orders_rejected_total=5,
        decision_reject_reason_total={
            "broker_submit_failed": True,
            "trading_disabled": 2.8,
            "submit_disabled": "3.7",
            "live_submit_disabled": "bad",
            "risk_breach": object(),
        },
    )
    state = SimpleNamespace(metrics=metrics, last_execution_order=None)

    payload = build_execution_status_payload(
        state=state,
        live_submission_gate={"allowed": True, "blocked_reasons": []},
    )

    assert payload["reject_reason_totals"] == {
        "broker_submit_failed": 1,
        "trading_disabled": 2,
        "submit_disabled": 3,
        "live_submit_disabled": 1,
        "risk_breach": 1,
    }
