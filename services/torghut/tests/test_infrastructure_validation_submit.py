from __future__ import annotations

import pytest

from app.trading.infrastructure_validation_submit import (
    _require_known_null_terminal_order,
)


@pytest.mark.parametrize("status", ["canceled", "cancelled", "expired", "rejected"])
def test_known_null_terminal_order_requires_exact_identity_and_zero_fill(
    status: str,
) -> None:
    order = {
        "id": "paper-order-1",
        "client_order_id": "ivp-" + "a" * 44,
        "status": status,
        "filled_qty": "0",
    }

    _require_known_null_terminal_order(
        order,
        client_order_id="ivp-" + "a" * 44,
    )


@pytest.mark.parametrize(
    ("overrides", "error"),
    [
        ({"client_order_id": "ivp-" + "b" * 44}, "identity_mismatch"),
        ({"id": ""}, "identity_missing"),
        ({"status": "filled", "filled_qty": "1"}, "status_invalid"),
        ({"status": "canceled", "filled_qty": "0.01"}, "fill_observed"),
        ({"status": "canceled", "filled_qty": None}, "filled_qty_invalid"),
    ],
)
def test_terminal_order_rejects_wrong_identity_or_any_fill(
    overrides: dict[str, object],
    error: str,
) -> None:
    order: dict[str, object] = {
        "id": "paper-order-1",
        "client_order_id": "ivp-" + "a" * 44,
        "status": "canceled",
        "filled_qty": "0",
    }
    order.update(overrides)

    with pytest.raises(RuntimeError, match=error):
        _require_known_null_terminal_order(
            order,
            client_order_id="ivp-" + "a" * 44,
        )
