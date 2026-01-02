"""Thin wrappers around alpaca-py clients for torghut."""

from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List, Optional, cast

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
        base = base_url or settings.apca_api_base_url
        data_base = settings.apca_data_api_base_url

        is_live = settings.trading_mode == "live"

        # Default to paper trading; override URL if provided.
        self.trading = trading_client or TradingClient(
            api_key=key,
            secret_key=secret,
            paper=not is_live,
            url_override=base,
        )

        # Market Data v2 (stocks).
        self.data = data_client or StockHistoricalDataClient(
            api_key=key,
            secret_key=secret,
            url_override=data_base,
            sandbox=not is_live,
        )

    # ------------------- Trading helpers -------------------
    def get_account(self) -> Dict[str, Any]:
        account = self.trading.get_account()
        return self._model_to_dict(account)

    def list_positions(self) -> List[Dict[str, Any]]:
        positions = self.trading.get_all_positions()
        return [self._model_to_dict(pos) for pos in positions]

    def list_open_orders(self) -> List[Dict[str, Any]]:
        request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
        orders = self.trading.get_orders(request)
        return [self._model_to_dict(order) for order in orders]

    def get_order(self, alpaca_order_id: str) -> Dict[str, Any]:
        order = self.trading.get_order_by_id(alpaca_order_id)
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
    ) -> Dict[str, Any]:
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

        order = self.trading.submit_order(request)
        return self._model_to_dict(order)

    def cancel_order(self, alpaca_order_id: str) -> bool:
        self.trading.cancel_order_by_id(alpaca_order_id)
        return True

    def cancel_all_orders(self) -> List[Dict[str, Any]]:
        responses = self.trading.cancel_orders()
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
        if hasattr(model, "model_dump"):
            return model.model_dump()
        if hasattr(model, "__dict__"):
            return {k: v for k, v in model.__dict__.items() if not k.startswith("_")}
        if isinstance(model, dict):
            return cast(Dict[str, Any], model)
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


__all__ = ["TorghutAlpacaClient"]
