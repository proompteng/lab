"""Thin wrappers around alpaca-py clients for torghut."""

from __future__ import annotations

import inspect
import re
from collections.abc import Callable, Iterable, Mapping
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from dataclasses import asdict, is_dataclass
from enum import Enum
from typing import Any, Dict, List, Optional, cast
from uuid import UUID

from alpaca.common.exceptions import APIError
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
    StopLimitOrderRequest,
    StopOrderRequest,
)

from .config import settings


class OrderFirewallToken:
    """Marker token required for broker order submission/cancellation."""


class OrderFirewallViolation(PermissionError):
    """Raised when broker mutation methods are called outside OrderFirewall."""


class _TradingMutationGuardProxy:
    """Expose non-mutating trading methods while blocking direct order mutations."""

    _blocked_methods = frozenset({"submit_order", "cancel_order_by_id", "cancel_orders"})

    def __init__(self, trading_client: TradingClient) -> None:
        self._trading_client = trading_client

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._trading_client, name)
        if name in self._blocked_methods and callable(attr):
            raise OrderFirewallViolation("order_firewall_boundary_violation")
        return attr


class TorghutAlpacaClient:
    """Service-level Alpaca wrapper returning JSON-serializable dicts."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        base_url: Optional[str] = None,
        trading_client: Optional[TradingClient] = None,
        data_client: Optional[StockHistoricalDataClient] = None,
    ) -> None:
        key = api_key or settings.apca_api_key_id
        secret = secret_key or settings.apca_api_secret_key
        base = _normalize_alpaca_base_url(base_url or settings.apca_api_base_url)
        data_base = _normalize_alpaca_base_url(settings.apca_data_api_base_url)

        is_live = settings.trading_mode == "live"

        # Default to paper trading; override URL if provided.
        raw_trading_client = trading_client or TradingClient(
            api_key=key,
            secret_key=secret,
            paper=not is_live,
            url_override=base,
        )
        self._trading = raw_trading_client
        self.trading = _TradingMutationGuardProxy(raw_trading_client)

        # Market Data v2 (stocks).
        self.data = data_client or StockHistoricalDataClient(
            api_key=key,
            secret_key=secret,
            url_override=data_base,
            sandbox=not is_live,
        )

    # ------------------- Trading helpers -------------------
    def get_account(self) -> Dict[str, Any]:
        account = self._trading.get_account()
        return self._model_to_dict(account)

    def list_positions(self) -> List[Dict[str, Any]]:
        positions = self._trading.get_all_positions()
        return [self._model_to_dict(pos) for pos in positions]

    def list_open_orders(self) -> List[Dict[str, Any]]:
        request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
        orders = self._trading.get_orders(request)
        return [self._model_to_dict(order) for order in orders]

    def list_orders(self, status: str = "all") -> List[Dict[str, Any]]:
        status_value = QueryOrderStatus(status.lower())
        request = GetOrdersRequest(status=status_value)
        orders = self._trading.get_orders(request)
        return [self._model_to_dict(order) for order in orders]

    def get_order(self, alpaca_order_id: str) -> Dict[str, Any]:
        order = self._trading.get_order_by_id(alpaca_order_id)
        return self._model_to_dict(order)

    def get_order_by_client_order_id(self, client_order_id: str) -> Dict[str, Any] | None:
        # alpaca-py renamed this helper across versions.
        getter = cast(Callable[[str], Any] | None, getattr(self._trading, "get_order_by_client_order_id", None))
        if getter is None:
            getter = cast(Callable[[str], Any] | None, getattr(self._trading, "get_order_by_client_id", None))
        if getter is None:
            return None

        try:
            order = getter(client_order_id)
        except APIError as exc:
            if exc.status_code == 404:
                return None
            raise

        return self._model_to_dict(order)

    def submit_order(
        self,
        symbol: str,
        side: str,
        qty: float,
        order_type: str,
        time_in_force: str,
        limit_price: Optional[float] = None,
        stop_price: Optional[float] = None,
        extra_params: Optional[Dict[str, Any]] = None,
        *,
        firewall_token: OrderFirewallToken,
    ) -> Dict[str, Any]:
        self._require_firewall_caller()
        self._require_firewall_token(firewall_token)
        side_enum = OrderSide(side.lower())
        tif_enum = TimeInForce(time_in_force.lower())
        payload = {"symbol": symbol, "qty": qty, "side": side_enum, "time_in_force": tif_enum}
        if extra_params:
            payload.update(extra_params)

        order_type_lower = order_type.lower()
        if order_type_lower == "market":
            request = MarketOrderRequest(**payload)
        elif order_type_lower == "limit":
            if limit_price is None:
                raise ValueError("limit_price is required for limit orders")
            request = LimitOrderRequest(limit_price=limit_price, **payload)
        elif order_type_lower == "stop":
            if stop_price is None:
                raise ValueError("stop_price is required for stop orders")
            request = StopOrderRequest(stop_price=stop_price, **payload)
        elif order_type_lower == "stop_limit":
            if stop_price is None or limit_price is None:
                raise ValueError("stop_limit orders require both stop_price and limit_price")
            request = StopLimitOrderRequest(stop_price=stop_price, limit_price=limit_price, **payload)
        else:
            raise ValueError(f"Unsupported order_type: {order_type}")

        order = self._trading.submit_order(request)
        return self._model_to_dict(order)

    def cancel_order(self, alpaca_order_id: str, *, firewall_token: OrderFirewallToken) -> bool:
        self._require_firewall_caller()
        self._require_firewall_token(firewall_token)
        self._trading.cancel_order_by_id(alpaca_order_id)
        return True

    def cancel_all_orders(self, *, firewall_token: OrderFirewallToken) -> List[Dict[str, Any]]:
        self._require_firewall_caller()
        self._require_firewall_token(firewall_token)
        responses = self._trading.cancel_orders()
        return [self._model_to_dict(resp) for resp in responses]

    # ------------------- Market data -------------------
    def get_bars(  # pyright: ignore[reportUnknownVariableType,reportUnknownArgumentType]
        self, symbols: Iterable[str] | str, timeframe: str, lookback_bars: int
    ) -> Dict[str, List[Dict[str, Any]]]:
        timeframe_obj = self._parse_timeframe(timeframe)
        if isinstance(symbols, str):
            symbols = [symbols]

        start = datetime.now(timezone.utc) - self._timeframe_to_timedelta(timeframe_obj, lookback_bars)
        request = StockBarsRequest(
            symbol_or_symbols=list(symbols),
            timeframe=timeframe_obj,
            start=start,
            limit=lookback_bars,
        )
        bars = self.data.get_stock_bars(request)

        raw_data = getattr(bars, "data", bars)  # allow raw dicts in tests
        if not isinstance(raw_data, dict):
            return {}

        bar_data_raw = cast(dict[str, Iterable[Any]], raw_data)

        typed_bars: dict[str, list[Any]] = {}
        for symbol, val in bar_data_raw.items():
            if isinstance(val, (str, bytes)):
                continue
            typed_bars[symbol] = list(val)

        parsed: dict[str, list[Dict[str, Any]]] = {
            symbol: [self._model_to_dict(bar) for bar in bars_list]
            for symbol, bars_list in typed_bars.items()
        }

        return parsed

    # ------------------- Helpers -------------------
    @staticmethod
    def _model_to_dict(model: Any) -> Dict[str, Any]:
        def to_jsonable(value: Any) -> Any:
            if value is None or isinstance(value, (str, int, float, bool)):
                return value
            if isinstance(value, UUID):
                return str(value)
            if isinstance(value, datetime):
                return value.isoformat()
            if isinstance(value, Decimal):
                return str(value)
            if isinstance(value, Enum):
                return to_jsonable(value.value)
            if is_dataclass(value) and not isinstance(value, type):
                return to_jsonable(asdict(value))
            if isinstance(value, Mapping):
                mapping = cast(Mapping[object, Any], value)
                return {str(key): to_jsonable(val) for key, val in mapping.items()}
            if isinstance(value, (list, tuple, set, frozenset)):
                items = cast(Iterable[Any], value)
                return [to_jsonable(item) for item in items]
            return str(value)

        if hasattr(model, "model_dump"):
            try:
                raw = model.model_dump(mode="json")
            except TypeError:
                raw = model.model_dump()
            if isinstance(raw, Mapping):
                return cast(Dict[str, Any], to_jsonable(raw))
            raise TypeError(f"Unsupported model_dump payload type: {type(raw)}")
        if hasattr(model, "__dict__"):
            raw = {k: v for k, v in model.__dict__.items() if not k.startswith("_")}
            return cast(Dict[str, Any], to_jsonable(raw))
        if isinstance(model, Mapping):
            return cast(Dict[str, Any], to_jsonable(model))
        raise TypeError(f"Unsupported model type: {type(model)}")

    @staticmethod
    def _parse_timeframe(value: str) -> TimeFrame:
        match = re.fullmatch(r"(\d+)(Min|Hour|Day|Week|Month)", value)
        if not match:
            raise ValueError(f"Invalid timeframe string: {value}")
        amount = int(match.group(1))
        unit_str = match.group(2)
        unit = TimeFrameUnit(unit_str)
        return TimeFrame(amount=amount, unit=unit)

    @staticmethod
    def _timeframe_to_timedelta(timeframe: TimeFrame, count: int) -> timedelta:
        unit = timeframe.unit
        amount = timeframe.amount * count
        if unit == TimeFrameUnit.Minute:
            return timedelta(minutes=amount)
        if unit == TimeFrameUnit.Hour:
            return timedelta(hours=amount)
        if unit == TimeFrameUnit.Day:
            return timedelta(days=amount)
        if unit == TimeFrameUnit.Week:
            return timedelta(weeks=amount)
        if unit == TimeFrameUnit.Month:
            return timedelta(days=30 * amount)
        raise ValueError(f"Unsupported timeframe unit: {unit}")

    @staticmethod
    def _require_firewall_token(token: object) -> None:
        if not isinstance(token, OrderFirewallToken):
            raise PermissionError("order_firewall_token_required")

    @staticmethod
    def _require_firewall_caller() -> None:
        frame = inspect.currentframe()
        try:
            caller = frame.f_back if frame is not None else None
            if caller is not None and caller.f_globals.get("__name__", "") == __name__:
                caller = caller.f_back
            caller_module = caller.f_globals.get("__name__", "") if caller is not None else ""
            if caller_module == "app.trading.firewall":
                return
            raise OrderFirewallViolation("order_firewall_boundary_violation")
        finally:
            del frame


def _normalize_alpaca_base_url(base_url: Optional[str]) -> Optional[str]:
    if not base_url:
        return None
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/v2"):
        return trimmed[:-3]
    return trimmed


__all__ = [
    "OrderFirewallToken",
    "OrderFirewallViolation",
    "TorghutAlpacaClient",
]
