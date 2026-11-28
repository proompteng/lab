from __future__ import annotations

from unittest import TestCase

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.config import settings
from app.models import (
    Base,
)
from app.trading.execution_adapters import (
    OrderSubmission,
)


class FakeAlpacaClient:
    def __init__(self) -> None:
        self.submitted: list[dict[str, str]] = []

    def submit_order(
        self,
        request: OrderSubmission | str | None = None,
        *,
        symbol: str | None = None,
        side: str | None = None,
        qty: float | None = None,
        order_type: str | None = None,
        time_in_force: str | None = None,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, str] | None = None,
    ) -> dict[str, str]:
        if isinstance(request, OrderSubmission):
            submission = request
        else:
            resolved_symbol = request if isinstance(request, str) else symbol
            submission = OrderSubmission(
                symbol=str(resolved_symbol),
                side=str(side),
                qty=float(qty or 0),
                order_type=str(order_type),
                time_in_force=str(time_in_force),
                limit_price=limit_price,
                stop_price=stop_price,
                extra_params=extra_params,
            )
        extra_params = submission.extra_params or {}
        order = {
            "id": f"order-{len(self.submitted) + 1}",
            "client_order_id": extra_params.get("client_order_id")
            if extra_params
            else None,
            "symbol": submission.symbol,
            "side": submission.side,
            "type": submission.order_type,
            "time_in_force": submission.time_in_force,
            "qty": str(submission.qty),
            "filled_qty": "0",
            "status": "accepted",
        }
        self.submitted.append(order)
        return order

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> dict[str, str] | None:
        return next(
            (
                order
                for order in self.submitted
                if order.get("client_order_id") == client_order_id
            ),
            None,
        )

    def get_order(self, alpaca_order_id: str) -> dict[str, str]:
        return {
            "id": alpaca_order_id,
            "client_order_id": None,
            "symbol": "AAPL",
            "side": "buy",
            "type": "market",
            "time_in_force": "day",
            "qty": "1",
            "filled_qty": "0",
            "status": "accepted",
        }

    def list_positions(self) -> list[dict[str, str]]:
        return []

    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        _ = status
        return []


class FilledAlpacaClient(FakeAlpacaClient):
    def submit_order(
        self,
        request: OrderSubmission | str | None = None,
        *,
        symbol: str | None = None,
        side: str | None = None,
        qty: float | None = None,
        order_type: str | None = None,
        time_in_force: str | None = None,
        limit_price: float | None = None,
        stop_price: float | None = None,
        extra_params: dict[str, str] | None = None,
    ) -> dict[str, str]:
        order = super().submit_order(
            request,
            symbol=symbol,
            side=side,
            qty=qty,
            order_type=order_type,
            time_in_force=time_in_force,
            limit_price=limit_price,
            stop_price=stop_price,
            extra_params=extra_params,
        )
        order["filled_qty"] = str(
            request.qty if isinstance(request, OrderSubmission) else qty
        )
        order["filled_avg_price"] = "101"
        order["status"] = "filled"
        return order


class ConflictingOrderClient(FakeAlpacaClient):
    def list_orders(self, status: str = "all") -> list[dict[str, str]]:
        if status != "open":
            return []
        return [
            {
                "id": "order-conflict-1",
                "client_order_id": "existing-open-order",
                "symbol": "AAPL",
                "side": "sell",
                "type": "market",
                "time_in_force": "day",
                "qty": "1",
                "filled_qty": "0",
                "status": "accepted",
            }
        ]


class PositionLookupUnavailableClient(FakeAlpacaClient):
    def list_positions(self) -> list[dict[str, str]]:
        raise RuntimeError("positions lookup unavailable")


class PositionLookupNoneClient(FakeAlpacaClient):
    def list_positions(self) -> list[dict[str, str]] | None:
        return None


class AccountShortingDisabledClient(FakeAlpacaClient):
    def get_account(self) -> dict[str, bool]:
        return {"shorting_enabled": False}


class SymbolNotShortableClient(FakeAlpacaClient):
    def get_account(self) -> dict[str, bool]:
        return {"shorting_enabled": True}

    def get_asset(self, symbol_or_asset_id: str) -> dict[str, str | bool]:
        return {
            "symbol": symbol_or_asset_id,
            "tradable": True,
            "shortable": False,
            "easy_to_borrow": False,
        }


class AccountMetadataUnavailableClient(FakeAlpacaClient):
    def get_account(self) -> dict[str, bool]:
        raise RuntimeError("account lookup unavailable")


class _TestOrderIdempotencyBase(TestCase):
    def setUp(self) -> None:
        engine = create_engine("sqlite+pysqlite:///:memory:", future=True)
        Base.metadata.create_all(engine)
        self.session_local = sessionmaker(
            bind=engine, expire_on_commit=False, future=True
        )
        self._orig_multi_account_enabled = settings.trading_multi_account_enabled
        self._orig_allow_shorts = settings.trading_allow_shorts
        self._orig_fractional_equities_enabled = (
            settings.trading_fractional_equities_enabled
        )
        self._orig_trading_mode = settings.trading_mode
        settings.trading_multi_account_enabled = False
        settings.trading_allow_shorts = False
        settings.trading_fractional_equities_enabled = False
        settings.trading_mode = "paper"

    def tearDown(self) -> None:
        settings.trading_multi_account_enabled = self._orig_multi_account_enabled
        settings.trading_allow_shorts = self._orig_allow_shorts
        settings.trading_fractional_equities_enabled = (
            self._orig_fractional_equities_enabled
        )
        settings.trading_mode = self._orig_trading_mode
