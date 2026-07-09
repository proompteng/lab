from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

from app.trading.execution_runtime import (
    ExecutionGateInputs,
    ExecutionOrderResult,
    ExecutionRouteDecision,
    build_execution_gate,
    build_execution_status_payload,
    record_last_execution_order,
)


def test_execution_gate_ignores_diagnostics() -> None:
    route = ExecutionRouteDecision(
        route="testnet",
        reason="alpaca_regular_session_closed",
        alpaca_regular_session_open=False,
        testnet_after_hours_enabled=True,
    )

    gate = build_execution_gate(
        inputs=ExecutionGateInputs(
            trading_enabled=True,
            submit_enabled=True,
            live_submit_enabled=True,
            kill_switch_enabled=False,
            route_available=True,
            route=route,
        ),
        diagnostics={
            "non_operational_diagnostic": True,
            "proof_collection_pending": True,
            "research_evidence_missing": True,
        },
    )

    assert gate.allowed is True
    assert gate.reason == "operational_submission_ready"
    assert gate.blocked_reasons == ()


def test_execution_gate_keeps_operational_blockers() -> None:
    route = ExecutionRouteDecision(
        route="alpaca",
        reason="alpaca_regular_session_open",
        alpaca_regular_session_open=True,
        testnet_after_hours_enabled=True,
    )

    gate = build_execution_gate(
        inputs=ExecutionGateInputs(
            trading_enabled=True,
            submit_enabled=True,
            live_submit_enabled=True,
            kill_switch_enabled=True,
            route_available=False,
            route=route,
        ),
    )

    assert gate.allowed is False
    assert gate.reason == "kill_switch_enabled"
    assert list(gate.blocked_reasons) == ["kill_switch_enabled", "alpaca_unavailable"]


def test_execution_status_filters_diagnostic_reject_reasons() -> None:
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
            "reason": "proof_collection_pending",
            "blocked_reasons": [
                "proof_collection_pending",
                "research_evidence_missing",
            ],
            "execution_route": {
                "route": "alpaca",
                "reason": "alpaca_regular_session_open",
                "alpaca_regular_session_open": True,
            },
        },
    )

    assert payload["gate"]["allowed"] is True
    assert payload["gate"]["reason"] == "operational_submission_ready"
    assert payload["gate"]["blocked_reasons"] == []
    assert payload["reject_reason_totals"] == {"broker_submit_failed": 2}


def test_execution_status_blocks_testnet_route_as_not_mainnet() -> None:
    metrics = SimpleNamespace(
        orders_submitted_total=0,
        orders_rejected_total=0,
        decision_reject_reason_total={},
    )
    state = SimpleNamespace(metrics=metrics, last_execution_order=None)

    payload = build_execution_status_payload(
        state=state,
        live_submission_gate={
            "allowed": True,
            "reason": "operational_submission_ready",
            "blocked_reasons": [],
            "execution_route": {
                "route": "testnet",
                "reason": "alpaca_regular_session_closed",
                "alpaca_regular_session_open": False,
            },
        },
    )

    assert payload["gate"]["allowed"] is False
    assert payload["gate"]["reason"] == "mainnet_route_unavailable"
    assert payload["gate"]["blocked_reasons"] == ["mainnet_route_unavailable"]


def test_execution_gate_payload_preserves_operational_blockers() -> None:
    route = ExecutionRouteDecision(
        route="testnet",
        reason="alpaca_regular_session_closed",
        alpaca_regular_session_open=False,
        testnet_after_hours_enabled=True,
    )

    gate = build_execution_gate(
        inputs=ExecutionGateInputs(
            trading_enabled=False,
            submit_enabled=False,
            live_submit_enabled=False,
            kill_switch_enabled=True,
            route_available=False,
            route=route,
        ),
    )

    assert gate.to_payload() == {
        "allowed": False,
        "reason": "trading_disabled",
        "blocked_reasons": [
            "trading_disabled",
            "submit_disabled",
            "live_submit_disabled",
            "kill_switch_enabled",
            "testnet_unavailable",
        ],
        "execution_route": {
            "route": "testnet",
            "reason": "alpaca_regular_session_closed",
            "alpaca_regular_session_open": False,
            "testnet_after_hours_enabled": True,
        },
    }


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
            route="testnet",
            symbol="BTC/USD",
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
            "execution_route": {"route": "testnet"},
        },
    )

    assert payload["last_submitted_order"] == {
        "route": "testnet",
        "symbol": "BTC/USD",
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
