from __future__ import annotations

from collections.abc import Callable, Mapping
from decimal import Decimal

import pytest

from app.trading.execution.order_lifecycle import (
    OrderLifecycleIO,
    OrderLifecyclePolicy,
    OrderLifecycleSafetyError,
    submit_with_bounded_repricing,
)
from app.trading.models import ExecutionRequest
from app.trading.scheduler.pipeline.runtime_gates import (
    terminal_unfilled_execution_reason,
)


class _OrderClient:
    def __init__(self) -> None:
        self.orders: dict[str, dict[str, object]] = {}
        self.submissions: list[ExecutionRequest] = []
        self.client_order_ids: list[str | None] = []
        self.cancelled: list[str] = []
        self.cancel_all_calls = 0

    def submit(
        self,
        request: ExecutionRequest,
        extra_params: dict[str, object],
    ) -> dict[str, object]:
        order_id = f"order-{len(self.submissions) + 1}"
        order = {
            "id": order_id,
            "status": "new",
            "qty": str(request.qty),
            "filled_qty": "0",
            "client_order_id": extra_params.get("client_order_id"),
        }
        self.submissions.append(request)
        self.client_order_ids.append(extra_params.get("client_order_id"))
        self.orders[order_id] = order
        return dict(order)

    def get_order(self, order_id: str) -> dict[str, object]:
        return dict(self.orders[order_id])

    def cancel_order(self, order_id: str) -> bool:
        self.cancelled.append(order_id)
        self.orders[order_id]["status"] = "canceled"
        return True

    def cancel_all_orders(self) -> None:
        self.cancel_all_calls += 1


class _ReadFailureClient(_OrderClient):
    def get_order(self, order_id: str) -> dict[str, object]:
        del order_id
        raise RuntimeError("broker unavailable")


class _LateFillClient(_OrderClient):
    def cancel_order(self, order_id: str) -> bool:
        result = super().cancel_order(order_id)
        if order_id == "order-1":
            self.orders[order_id]["filled_qty"] = "7"
        return result


class _UnconfirmedCancelClient(_OrderClient):
    def cancel_order(self, order_id: str) -> bool:
        self.cancelled.append(order_id)
        self.orders[order_id]["status"] = "pending_cancel"
        return True


class _RejectedClient(_OrderClient):
    def submit(
        self,
        request: ExecutionRequest,
        extra_params: dict[str, object],
    ) -> dict[str, object]:
        order = super().submit(request, extra_params)
        order["status"] = "rejected"
        self.orders[order["id"]] = dict(order)
        return order

    def cancel_order(self, order_id: str) -> bool:
        raise AssertionError(f"terminal order must not be canceled: {order_id}")


class _ObservedCanceledClient(_OrderClient):
    def get_order(self, order_id: str) -> dict[str, object]:
        self.orders[order_id]["status"] = "canceled"
        return super().get_order(order_id)

    def cancel_order(self, order_id: str) -> bool:
        raise AssertionError(f"terminal order must not be canceled: {order_id}")


_POLICY = OrderLifecyclePolicy(
    reprice_seconds=2.0,
    max_attempts=3,
    slippage_bps=Decimal("8"),
)


def _io(
    client: _OrderClient,
    *,
    submit: Callable[[ExecutionRequest, dict[str, object]], Mapping[str, object]]
    | None = None,
    sleep: Callable[[float], None] = lambda _seconds: None,
) -> OrderLifecycleIO:
    return OrderLifecycleIO(
        execution_client=client,
        submit=submit or client.submit,
        sleep=sleep,
    )


def _request() -> ExecutionRequest:
    return ExecutionRequest(
        decision_id="decision-1",
        symbol="NVDA",
        side="buy",
        qty=Decimal("10"),
        order_type="limit",
        time_in_force="day",
        limit_price=Decimal("100"),
        client_order_id="client-1",
    )


def test_live_order_reprices_three_times_within_eight_bps_and_cancels() -> None:
    client = _OrderClient()
    sleeps: list[float] = []

    result = submit_with_bounded_repricing(
        io=_io(client, sleep=sleeps.append),
        request=_request(),
        extra_params={"client_order_id": "client-1"},
        policy=_POLICY,
    )

    assert result.exhausted
    assert result.attempts == 3
    assert [request.limit_price for request in client.submissions] == [
        Decimal("100.00"),
        Decimal("100.04"),
        Decimal("100.08"),
    ]
    assert client.client_order_ids == ["client-1", "client-1-r2", "client-1-r3"]
    assert client.cancelled == ["order-1", "order-2", "order-3"]
    assert sleeps == [2.0, 2.0, 2.0]
    assert len(result.prior_orders) == 2
    assert result.final_order["_order_lifecycle"]["remaining_qty"] == "10"


def test_live_order_only_reprices_the_unfilled_quantity() -> None:
    client = _OrderClient()

    def submit(
        request: ExecutionRequest,
        extra_params: dict[str, object],
    ) -> dict[str, object]:
        order = client.submit(request, extra_params)
        if len(client.submissions) == 1:
            client.orders[order["id"]]["filled_qty"] = "4"
            client.orders[order["id"]]["status"] = "partially_filled"
        else:
            client.orders[order["id"]]["filled_qty"] = str(request.qty)
            client.orders[order["id"]]["status"] = "filled"
        return order

    result = submit_with_bounded_repricing(
        io=_io(client, submit=submit),
        request=_request(),
        extra_params={"client_order_id": "client-1"},
        policy=_POLICY,
    )

    assert not result.exhausted
    assert [request.qty for request in client.submissions] == [
        Decimal("10"),
        Decimal("6"),
    ]
    assert result.final_order["status"] == "filled"


def test_live_order_accounts_for_late_fill_before_replacement() -> None:
    client = _LateFillClient()

    def submit(
        request: ExecutionRequest,
        extra_params: dict[str, object],
    ) -> dict[str, object]:
        order = client.submit(request, extra_params)
        if len(client.submissions) == 1:
            client.orders[order["id"]]["filled_qty"] = "4"
            client.orders[order["id"]]["status"] = "partially_filled"
        else:
            client.orders[order["id"]]["filled_qty"] = str(request.qty)
            client.orders[order["id"]]["status"] = "filled"
        return order

    result = submit_with_bounded_repricing(
        io=_io(client, submit=submit),
        request=_request(),
        extra_params={"client_order_id": "client-1"},
        policy=_POLICY,
    )

    assert not result.exhausted
    assert [request.qty for request in client.submissions] == [
        Decimal("10"),
        Decimal("3"),
    ]


def test_live_order_does_not_cancel_or_replace_rejected_order() -> None:
    client = _RejectedClient()
    result = submit_with_bounded_repricing(
        io=_io(client),
        request=_request(),
        extra_params={"client_order_id": "client-1"},
        policy=_POLICY,
    )

    assert result.exhausted
    assert result.attempts == 1
    assert len(client.submissions) == 1
    assert client.cancelled == []
    assert result.final_order["_order_lifecycle"] == {
        "attempts": 1,
        "exhausted": True,
        "filled_qty_total": "0",
        "remaining_qty": "10",
        "slippage_bps": "8",
    }


def test_live_order_replaces_broker_canceled_order_without_canceling_it_again() -> None:
    client = _ObservedCanceledClient()

    result = submit_with_bounded_repricing(
        io=_io(client),
        request=_request(),
        extra_params={"client_order_id": "client-1"},
        policy=_POLICY,
    )

    assert result.exhausted
    assert result.attempts == 3
    assert len(client.submissions) == 3
    assert client.cancelled == []
    assert len(result.prior_orders) == 2


def test_terminal_zero_fill_is_rejected_but_partial_fill_remains_actionable() -> None:
    class _Execution:
        status = "canceled"
        filled_qty = Decimal("0")

    execution = _Execution()
    assert (
        terminal_unfilled_execution_reason(execution)
        == "order_terminal_unfilled_canceled"
    )

    execution.filled_qty = Decimal("1")
    assert terminal_unfilled_execution_reason(execution) is None


def test_terminal_final_attempt_uses_total_lifecycle_fills() -> None:
    execution = type(
        "Execution",
        (),
        {
            "status": "canceled",
            "filled_qty": Decimal("0"),
            "raw_order": {
                "_order_lifecycle": {
                    "filled_qty_total": "0.25",
                    "remaining_qty": "0.75",
                }
            },
        },
    )()

    assert terminal_unfilled_execution_reason(execution) is None


def test_live_order_fails_closed_when_cancel_never_becomes_terminal() -> None:
    client = _UnconfirmedCancelClient()

    with pytest.raises(OrderLifecycleSafetyError, match="cancel_unconfirmed"):
        submit_with_bounded_repricing(
            io=_io(client),
            request=_request(),
            extra_params={"client_order_id": "client-1"},
            policy=_POLICY,
        )

    assert client.cancel_all_calls == 1


def test_live_order_read_failure_cancels_known_order_and_fails_closed() -> None:
    client = _ReadFailureClient()

    with pytest.raises(OrderLifecycleSafetyError, match="read_failed"):
        submit_with_bounded_repricing(
            io=_io(client),
            request=_request(),
            extra_params={"client_order_id": "client-1"},
            policy=_POLICY,
        )

    assert client.cancelled == ["order-1"]
