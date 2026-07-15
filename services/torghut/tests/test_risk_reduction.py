from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Literal

import pytest

from app.trading.risk_reduction import (
    BrokerOrderObservation,
    BrokerPositionObservation,
    BrokerReductionSnapshot,
    CancelAllOrdersPlan,
    CancelOrderPlan,
    CloseAllPositionsPlan,
    ClosePositionPlan,
    PositionCloseLeg,
    ReplaceOrderPlan,
    RiskReductionAuthorization,
    RiskReductionPermitError,
    RiskReductionPermitExpectation,
    authorize_risk_reduction,
    consume_risk_reduction_permit,
    evaluate_position_reduction_recovery,
    flatten_observed_positions,
)
from app.trading.risk_reduction_mutation_authority import (
    risk_reduction_request_id,
)


NOW = datetime(2026, 7, 15, 12, 0, tzinfo=timezone.utc)
ENDPOINT = "a" * 64


def _snapshot(
    *,
    complete: bool = True,
    orders: tuple[BrokerOrderObservation, ...] = (),
    positions: tuple[BrokerPositionObservation, ...] = (),
    observed_at: datetime = NOW,
) -> BrokerReductionSnapshot:
    return BrokerReductionSnapshot(
        broker_route="alpaca",
        account_label="paper",
        endpoint_fingerprint=ENDPOINT,
        observed_at=observed_at,
        complete=complete,
        orders=orders,
        positions=positions,
    )


def _order(
    *,
    order_id: str = "order-1",
    client_order_id: str = "client-1",
    symbol: str = "AAPL",
    side: Literal["buy", "sell"] = "buy",
    quantity: Decimal = Decimal("10"),
    filled_quantity: Decimal = Decimal("4"),
    status: str = "partially_filled",
    limit_price: Decimal | None = Decimal("200"),
) -> BrokerOrderObservation:
    return BrokerOrderObservation(
        order_id=order_id,
        client_order_id=client_order_id,
        symbol=symbol,
        side=side,
        quantity=quantity,
        filled_quantity=filled_quantity,
        status=status,
        limit_price=limit_price,
    )


def _request_payload(authorization: RiskReductionAuthorization) -> dict[str, object]:
    return {
        "broker_request": {"order_id": "order-1"},
        "risk_reduction": authorization.evidence_payload,
    }


def _expectation(
    authorization: RiskReductionAuthorization,
    payload: dict[str, object],
) -> RiskReductionPermitExpectation:
    permit = authorization.permit
    return RiskReductionPermitExpectation(
        broker_route=permit.broker_route,
        account_label=permit.account_label,
        endpoint_fingerprint=permit.endpoint_fingerprint,
        operation=permit.operation,
        target_key=permit.target_key,
        request_payload=payload,
    )


def test_cancel_order_seals_exact_open_order_and_consumes_once() -> None:
    authorization = authorize_risk_reduction(
        _snapshot(orders=(_order(),)),
        CancelOrderPlan("order-1"),
        now=NOW,
    )
    payload = _request_payload(authorization)
    expectation = _expectation(authorization, payload)

    consumed = consume_risk_reduction_permit(
        authorization.permit,
        expectation=expectation,
        now=NOW,
    )

    assert consumed.operation == "cancel_order"
    assert consumed.gross_before == consumed.gross_after == 0
    with pytest.raises(RiskReductionPermitError, match="already_consumed"):
        consume_risk_reduction_permit(
            authorization.permit,
            expectation=expectation,
            now=NOW,
        )


def test_cancel_all_requires_complete_snapshot_and_seals_only_open_orders() -> None:
    with pytest.raises(RiskReductionPermitError, match="complete_broker_snapshot"):
        authorize_risk_reduction(
            _snapshot(complete=False, orders=(_order(),)),
            CancelAllOrdersPlan(),
            now=NOW,
        )

    terminal = _order(
        order_id="order-2", status="filled", filled_quantity=Decimal("10")
    )
    authorization = authorize_risk_reduction(
        _snapshot(orders=(_order(), terminal)),
        CancelAllOrdersPlan(),
        now=NOW,
    )
    action = authorization.evidence_payload["action"]
    assert isinstance(action, dict)
    assert [item["order_id"] for item in action["orders"]] == ["order-1"]


def test_replace_requires_complete_state_and_cannot_cross_position_zero() -> None:
    with pytest.raises(RiskReductionPermitError, match="complete_broker_snapshot"):
        authorize_risk_reduction(
            _snapshot(complete=False, orders=(_order(),)),
            ReplaceOrderPlan(order_id="order-1", limit_price=Decimal("190")),
            now=NOW,
        )

    with pytest.raises(RiskReductionPermitError, match="cross_position_zero"):
        authorize_risk_reduction(
            _snapshot(
                orders=(_order(side="sell"),),
                positions=(
                    BrokerPositionObservation(
                        "AAPL",
                        Decimal("5"),
                        Decimal("200"),
                    ),
                ),
            ),
            ReplaceOrderPlan(order_id="order-1", limit_price=Decimal("190")),
            now=NOW,
        )

    authorization = authorize_risk_reduction(
        _snapshot(orders=(_order(),)),
        ReplaceOrderPlan(order_id="order-1", limit_price=Decimal("190")),
        now=NOW,
    )
    assert authorization.permit.operation == "replace_order"
    action = authorization.evidence_payload["action"]
    assert isinstance(action, dict)
    assert action["quantity"] == "6"


def test_single_position_close_forbids_wrong_side_cross_zero_and_new_symbol() -> None:
    snapshot = _snapshot(
        positions=(BrokerPositionObservation("AAPL", Decimal("5"), Decimal("200")),)
    )
    invalid_legs = (
        PositionCloseLeg("AAPL", "buy", Decimal("1")),
        PositionCloseLeg("AAPL", "sell", Decimal("6")),
        PositionCloseLeg("MSFT", "sell", Decimal("1")),
    )

    for leg in invalid_legs:
        with pytest.raises(RiskReductionPermitError):
            authorize_risk_reduction(snapshot, ClosePositionPlan(leg), now=NOW)

    authorization = authorize_risk_reduction(
        snapshot,
        ClosePositionPlan(PositionCloseLeg("AAPL", "sell", Decimal("2"))),
        now=NOW,
    )
    assert authorization.permit.gross_before == Decimal("1000")
    assert authorization.permit.gross_after == Decimal("600")
    assert authorization.permit.net_before == Decimal("1000")
    assert authorization.permit.net_after == Decimal("600")
    action = authorization.evidence_payload["action"]
    assert isinstance(action, dict)
    assert action["causal_position"] == {
        "broker_symbol": "AAPL",
        "signed_quantity": "5",
        "symbol": "AAPL",
    }
    observation = authorization.evidence_payload["observation"]
    assert isinstance(observation, dict)
    assert observation["positions"][0]["unit_notional"] == "200"


def test_close_action_identity_excludes_volatile_mark_but_evidence_keeps_it() -> None:
    def authorization(mark: str) -> RiskReductionAuthorization:
        return authorize_risk_reduction(
            _snapshot(
                positions=(
                    BrokerPositionObservation("AAPL", Decimal("5"), Decimal(mark)),
                )
            ),
            ClosePositionPlan(PositionCloseLeg("AAPL", "sell", Decimal("2"))),
            now=NOW,
        )

    first = authorization("200")
    second = authorization("201")

    assert first.evidence_payload["action"] == second.evidence_payload["action"]
    assert (
        first.evidence_payload["observation"] != second.evidence_payload["observation"]
    )
    first_request = {
        "broker_request": {"symbol": "AAPL", "quantity": "2", "side": "sell"},
        "risk_reduction": first.evidence_payload,
        "schema_version": "torghut.alpaca-reduction-request.v1",
    }
    second_request = {
        **first_request,
        "risk_reduction": second.evidence_payload,
    }
    assert risk_reduction_request_id(
        "close_position",
        first_request,
        target_kind="position",
        target_key="AAPL",
    ) == (
        risk_reduction_request_id(
            "close_position",
            second_request,
            target_kind="position",
            target_key="AAPL",
        )
    )


def test_already_satisfied_identity_is_stable_and_target_bound() -> None:
    request = {
        "already_satisfied": True,
        "observation": {"positions": []},
        "schema_version": "torghut.alpaca-reduction-preflight.v1",
    }

    first = risk_reduction_request_id(
        "close_position",
        request,
        target_kind="position",
        target_key="AAPL",
    )
    repeated = risk_reduction_request_id(
        "close_position",
        {**request, "observation": {"positions": [], "read": "repeated"}},
        target_kind="position",
        target_key="AAPL",
    )
    other_target = risk_reduction_request_id(
        "close_position",
        request,
        target_kind="position",
        target_key="MSFT",
    )

    assert first == repeated
    assert first != other_target


def test_single_leg_of_balanced_book_is_blocked_when_net_exposure_would_increase() -> (
    None
):
    snapshot = _snapshot(
        positions=(
            BrokerPositionObservation("AAPL", Decimal("10"), Decimal("10")),
            BrokerPositionObservation("MSFT", Decimal("-5"), Decimal("20")),
        )
    )

    with pytest.raises(RiskReductionPermitError, match="net_exposure"):
        authorize_risk_reduction(
            snapshot,
            ClosePositionPlan(PositionCloseLeg("AAPL", "sell", Decimal("10"))),
            now=NOW,
        )


def test_complete_multi_leg_flatten_reduces_gross_and_preserves_net_bound() -> None:
    snapshot = _snapshot(
        positions=(
            BrokerPositionObservation("AAPL", Decimal("10"), Decimal("10")),
            BrokerPositionObservation("MSFT", Decimal("-5"), Decimal("20")),
        )
    )
    plan = flatten_observed_positions(snapshot)
    authorization = authorize_risk_reduction(snapshot, plan, now=NOW)

    assert authorization.permit.operation == "close_all_positions"
    assert authorization.permit.gross_before == Decimal("200")
    assert authorization.permit.gross_after == 0
    assert authorization.permit.net_before == authorization.permit.net_after == 0
    action = authorization.evidence_payload["action"]
    assert isinstance(action, dict)
    assert [position["symbol"] for position in action["causal_positions"]] == [
        "AAPL",
        "MSFT",
    ]


def test_close_all_rejects_partial_leg_set() -> None:
    snapshot = _snapshot(
        positions=(
            BrokerPositionObservation("AAPL", Decimal("1"), Decimal("10")),
            BrokerPositionObservation("MSFT", Decimal("-1"), Decimal("10")),
        )
    )
    with pytest.raises(RiskReductionPermitError, match="exact_observed_positions"):
        authorize_risk_reduction(
            snapshot,
            CloseAllPositionsPlan(
                legs=(PositionCloseLeg("AAPL", "sell", Decimal("1")),)
            ),
            now=NOW,
        )


def test_stale_observation_expired_permit_and_tampered_evidence_fail_closed() -> None:
    snapshot = _snapshot(
        orders=(_order(),),
        observed_at=NOW - timedelta(seconds=6),
    )
    with pytest.raises(RiskReductionPermitError, match="observation_stale"):
        authorize_risk_reduction(snapshot, CancelOrderPlan("order-1"), now=NOW)

    authorization = authorize_risk_reduction(
        _snapshot(orders=(_order(),)),
        CancelOrderPlan("order-1"),
        now=NOW,
        permit_ttl_seconds=1,
    )
    payload = _request_payload(authorization)
    with pytest.raises(RiskReductionPermitError, match="permit_invalid"):
        consume_risk_reduction_permit(
            authorization.permit,
            expectation=_expectation(authorization, payload),
            now=NOW + timedelta(seconds=2),
        )

    tampered = dict(payload)
    tampered_evidence = dict(authorization.evidence_payload)
    tampered_evidence["target_key"] = "other-order"
    tampered["risk_reduction"] = tampered_evidence
    with pytest.raises(RiskReductionPermitError, match="permit_invalid"):
        consume_risk_reduction_permit(
            authorization.permit,
            expectation=_expectation(authorization, tampered),
            now=NOW,
        )


def test_permit_never_outlives_the_sealed_observation() -> None:
    authorization = authorize_risk_reduction(
        _snapshot(
            orders=(_order(),),
            observed_at=NOW - timedelta(seconds=4),
        ),
        CancelOrderPlan("order-1"),
        now=NOW,
        max_observation_age_seconds=5,
        permit_ttl_seconds=15,
    )
    payload = _request_payload(authorization)

    assert authorization.permit.expires_at == NOW + timedelta(seconds=1)
    with pytest.raises(RiskReductionPermitError, match="permit_invalid"):
        consume_risk_reduction_permit(
            authorization.permit,
            expectation=_expectation(authorization, payload),
            now=NOW + timedelta(seconds=2),
        )


def test_forged_permit_fails_closed() -> None:
    authorization = authorize_risk_reduction(
        _snapshot(orders=(_order(),)),
        CancelOrderPlan("order-1"),
        now=NOW,
    )
    forged = replace(authorization.permit, target_key="order-2")
    payload = _request_payload(authorization)
    with pytest.raises(RiskReductionPermitError, match="permit_invalid"):
        consume_risk_reduction_permit(
            forged,
            expectation=_expectation(authorization, payload),
            now=NOW,
        )


@pytest.mark.parametrize(
    ("current_quantity", "outcome", "reason"),
    [
        (Decimal("5"), "unresolved", "target_position_unchanged"),
        (Decimal("3"), "resolved", "target_position_reduced"),
        (Decimal("-1"), "conflict", "position_side_flipped"),
        (Decimal("6"), "conflict", "position_quantity_increased"),
    ],
)
def test_position_recovery_distinguishes_progress_from_safety_conflicts(
    current_quantity: Decimal,
    outcome: str,
    reason: str,
) -> None:
    authorization = authorize_risk_reduction(
        _snapshot(
            positions=(BrokerPositionObservation("AAPL", Decimal("5"), Decimal("200")),)
        ),
        ClosePositionPlan(PositionCloseLeg("AAPL", "sell", Decimal("2"))),
        now=NOW,
    )

    evaluation = evaluate_position_reduction_recovery(
        authorization.evidence_payload,
        (BrokerPositionObservation("AAPL", current_quantity, Decimal("200")),),
        operation="close_position",
        target_key="AAPL",
    )

    assert evaluation.outcome == outcome
    assert evaluation.reason == reason


def test_position_recovery_proves_flat_and_rejects_new_flatten_symbol() -> None:
    snapshot = _snapshot(
        positions=(
            BrokerPositionObservation("AAPL", Decimal("1"), Decimal("200")),
            BrokerPositionObservation("MSFT", Decimal("-1"), Decimal("100")),
        )
    )
    authorization = authorize_risk_reduction(
        snapshot,
        flatten_observed_positions(snapshot),
        now=NOW,
    )

    flat = evaluate_position_reduction_recovery(
        authorization.evidence_payload,
        (),
        operation="close_all_positions",
        target_key="paper",
    )
    conflict = evaluate_position_reduction_recovery(
        authorization.evidence_payload,
        (BrokerPositionObservation("NVDA", Decimal("1"), Decimal("10")),),
        operation="close_all_positions",
        target_key="paper",
    )

    assert (flat.outcome, flat.reason) == ("resolved", "account_flat")
    assert (conflict.outcome, conflict.reason) == (
        "conflict",
        "new_position_observed_during_flatten",
    )
