from __future__ import annotations

from decimal import Decimal

import pytest

from app.trading.execution.order_lifecycle import (
    HISTORICAL_LIVE_ORDER_ATTEMPT_SCAN_LIMIT,
    OrderLifecycleSafetyError,
    attempt_client_order_ids,
    fetch_existing_orders,
)
from app.trading.scheduler.pipeline.runtime_gates import (
    terminal_unfilled_execution_reason,
)


class _OrderReader:
    def __init__(self, orders: dict[str, object]) -> None:
        self.orders = orders
        self.lookups: list[str] = []

    def get_order_by_client_order_id(self, client_order_id: str) -> object:
        self.lookups.append(client_order_id)
        return self.orders.get(client_order_id)


def test_historical_repricing_ids_remain_readable_without_authorizing_retries() -> None:
    assert HISTORICAL_LIVE_ORDER_ATTEMPT_SCAN_LIMIT == 3
    assert attempt_client_order_ids("client-1", max_attempts=3) == (
        "client-1",
        "client-1-r2",
        "client-1-r3",
    )

    reader = _OrderReader(
        {
            "client-1": {"id": "order-1", "status": "canceled"},
            "client-1-r2": {"id": "order-2", "status": "filled"},
        }
    )
    assert fetch_existing_orders(reader, "client-1", max_attempts=3) == [
        {"id": "order-1", "status": "canceled"},
        {"id": "order-2", "status": "filled"},
    ]
    assert reader.lookups == ["client-1", "client-1-r2", "client-1-r3"]


def test_historical_recovery_rejects_malformed_broker_payload() -> None:
    reader = _OrderReader({"client-1": "not-an-order"})

    with pytest.raises(OrderLifecycleSafetyError, match="recovery_read_invalid"):
        fetch_existing_orders(reader, "client-1", max_attempts=1)


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


def test_historical_lifecycle_fill_metadata_remains_readable() -> None:
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
