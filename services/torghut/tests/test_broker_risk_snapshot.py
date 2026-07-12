from __future__ import annotations

from unittest.mock import Mock, patch

import pytest

from app.trading.broker_risk_snapshot import (
    normalize_live_open_order_rows,
    normalize_live_position_rows,
)
from app.trading.execution import OrderExecutor


@pytest.mark.parametrize(
    ("normalizer", "reason"),
    [
        (normalize_live_position_rows, "live_risk_positions_snapshot_unavailable"),
        (
            normalize_live_open_order_rows,
            "live_risk_open_orders_snapshot_unavailable",
        ),
    ],
)
def test_live_broker_snapshot_requires_row_lists(normalizer, reason: str) -> None:
    with pytest.raises(RuntimeError, match=reason):
        normalizer({"unexpected": "mapping"})


def test_live_position_snapshot_normalizes_short_exposure() -> None:
    assert normalize_live_position_rows(
        [
            {
                "symbol": "nvda",
                "side": "short",
                "qty": "2",
                "market_value": "400",
            }
        ]
    ) == [
        {
            "symbol": "NVDA",
            "side": "short",
            "qty": "2",
            "market_value": "-400",
        }
    ]


@pytest.mark.parametrize(
    "position",
    [
        {"side": "long", "qty": "1", "market_value": "100"},
        {"symbol": "AAPL", "side": "long", "qty": "bad", "market_value": "100"},
        {"symbol": "AAPL", "side": "long", "qty": "1"},
        {"symbol": "AAPL", "side": "long", "qty": "1", "market_value": "-100"},
        {"symbol": "AAPL", "side": "unknown", "qty": "1", "market_value": "100"},
        {"symbol": "AAPL", "side": "long", "qty": "0", "market_value": "100"},
    ],
)
def test_live_position_snapshot_rejects_unpriceable_rows(
    position: dict[str, str],
) -> None:
    with pytest.raises(RuntimeError, match="live_risk_position"):
        normalize_live_position_rows([position])


def test_live_open_order_snapshot_requires_remaining_priced_exposure() -> None:
    order = {
        "symbol": "AAPL",
        "side": "buy",
        "qty": "2",
        "filled_qty": "1",
        "limit_price": "100",
    }

    assert normalize_live_open_order_rows([order]) == [
        {
            **order,
            "notional_price": "100",
        }
    ]


@pytest.mark.parametrize(
    "order",
    [
        {"symbol": "AAPL", "side": "buy", "qty": "1"},
        {
            "symbol": "AAPL",
            "side": "buy",
            "qty": "1",
            "filled_qty": "1",
            "limit_price": "100",
        },
        {
            "symbol": "AAPL",
            "side": "unknown",
            "qty": "1",
            "limit_price": "100",
        },
        {
            "symbol": "AAPL",
            "side": "buy",
            "qty": "1",
            "filled_qty": "bad",
            "limit_price": "100",
        },
        {
            "symbol": "AAPL",
            "side": "buy",
            "qty": "0",
            "limit_price": "100",
        },
    ],
)
def test_live_open_order_snapshot_rejects_unprojectable_rows(
    order: dict[str, str],
) -> None:
    with pytest.raises(RuntimeError, match="live_risk_open_order"):
        normalize_live_open_order_rows([order])


def test_live_executor_fails_closed_when_open_order_read_fails() -> None:
    client = Mock()
    client.list_orders.side_effect = OSError("broker unavailable")

    with (
        patch(
            "app.trading.execution.order_executor_submission_methods.settings.trading_mode",
            "live",
        ),
        pytest.raises(RuntimeError, match="live_broker_open_order_read_failed"),
    ):
        OrderExecutor._list_open_orders(client)
