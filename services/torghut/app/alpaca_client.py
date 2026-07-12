"""Thin wrappers around alpaca-py clients for torghut."""

from __future__ import annotations

import inspect
import re
from collections.abc import Iterable, Mapping
from dataclasses import asdict, is_dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional, Protocol, cast
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


class AlpacaStrictOrderLookupMalformedError(RuntimeError):
    """Raised when an exact broker lookup returns no trustworthy order payload."""


def _is_explicit_http_not_found(exc: APIError) -> bool:
    """Return whether Alpaca supplied an unambiguous HTTP 404 status."""

    status_code: object = getattr(exc, "status_code", None)
    return type(status_code) is int and status_code == 404


_RESERVED_ORDER_EXTRA_PARAMS = frozenset(
    {
        "limit_price",
        "notional",
        "order_type",
        "qty",
        "side",
        "stop_price",
        "symbol",
        "time_in_force",
        "type",
    }
)
_ALLOWED_ORDER_EXTRA_PARAMS = frozenset(
    {
        "client_order_id",
        "extended_hours",
        "legs",
        "order_class",
        "position_intent",
        "stop_loss",
        "take_profit",
    }
)


class _ReadOnlyTradingClientLike(Protocol):
    def get_account(self) -> Any: ...

    def get_all_positions(self) -> Iterable[Any]: ...

    def get_asset(self, symbol_or_asset_id: str) -> Any: ...

    def get_orders(self, filter: Any | None = None) -> Iterable[Any]: ...

    def get_order_by_id(self, order_id: str) -> Any: ...

    def get_order_by_client_id(self, client_id: str) -> Any: ...


class _TradingClientLike(_ReadOnlyTradingClientLike, Protocol):
    def submit_order(self, _order_data: Any, /) -> Any: ...

    def cancel_order_by_id(self, order_id: str) -> Any: ...

    def cancel_orders(self) -> Iterable[Any]: ...


class _StockDataClientLike(Protocol):
    def get_stock_bars(self, _request_params: StockBarsRequest, /) -> Any: ...


class _SingleAttemptTradingClient(TradingClient):
    """Alpaca trading client with SDK-level HTTP retries disabled.

    A broker mutation can succeed even when its HTTP response is lost. Retrying that
    request inside the SDK would hide a second broker attempt from Torghut's durable
    execution state machine, so every service-created client performs one HTTP
    attempt and lets the caller reconcile an ambiguous result.
    """

    def __init__(
        self,
        api_key: str | None = None,
        secret_key: str | None = None,
        *,
        paper: bool = True,
        url_override: str | None = None,
    ) -> None:
        super().__init__(
            api_key=api_key,
            secret_key=secret_key,
            paper=paper,
            url_override=url_override,
        )

        retry_configuration = vars(self)
        retry_attempts = retry_configuration.get("_retry")
        if type(retry_attempts) is not int:
            raise RuntimeError("alpaca_sdk_retry_control_unavailable")

        self._retry = 0


class _ReadOnlyTradingClient:
    """Named Alpaca trading reads exposed outside the firewall boundary."""

    def __init__(self, trading_client: _ReadOnlyTradingClientLike) -> None:
        self._trading_client = trading_client

    def get_account(self) -> Any:
        return self._trading_client.get_account()

    def get_all_positions(self) -> Iterable[Any]:
        return self._trading_client.get_all_positions()

    def get_orders(self, filter: Any | None = None) -> Iterable[Any]:
        return self._trading_client.get_orders(filter)

    def get_order_by_id(self, order_id: str) -> Any:
        return self._trading_client.get_order_by_id(order_id)

    def get_asset(self, symbol_or_asset_id: str) -> Any:
        return self._trading_client.get_asset(symbol_or_asset_id)

    def get_order_by_client_id(self, client_id: str) -> Any:
        return self._trading_client.get_order_by_client_id(client_id)


class TorghutAlpacaClient:
    """Service-level Alpaca wrapper returning JSON-serializable dicts."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        secret_key: Optional[str] = None,
        base_url: Optional[str] = None,
        trading_client: _TradingClientLike | None = None,
        data_client: _StockDataClientLike | None = None,
        paper: Optional[bool] = None,
    ) -> None:
        key = api_key or settings.apca_api_key_id
        secret = secret_key or settings.apca_api_secret_key
        base = _normalize_alpaca_base_url(base_url or settings.apca_api_base_url)
        data_base = _normalize_alpaca_base_url(settings.apca_data_api_base_url)

        use_paper = paper if paper is not None else settings.trading_mode != "live"
        self.endpoint_class = "paper" if use_paper else "live"

        # Broker mutations use a dedicated single-attempt client so an ambiguous
        # response cannot cause a hidden resubmission. Reads keep the SDK's retry
        # policy because repeating a read does not create broker-side state.
        if trading_client is None:
            read_trading_client: _ReadOnlyTradingClientLike = TradingClient(
                api_key=key,
                secret_key=secret,
                paper=use_paper,
                url_override=base,
            )
            mutation_trading_client: _TradingClientLike = _SingleAttemptTradingClient(
                api_key=key,
                secret_key=secret,
                paper=use_paper,
                url_override=base,
            )
        else:
            read_trading_client = trading_client
            mutation_trading_client = trading_client

        self._trading = mutation_trading_client
        self.trading: _ReadOnlyTradingClient = _ReadOnlyTradingClient(
            read_trading_client
        )

        # Market Data v2 (stocks).
        self.data: _StockDataClientLike = data_client or StockHistoricalDataClient(
            api_key=key,
            secret_key=secret,
            url_override=data_base,
            sandbox=use_paper,
        )

    # ------------------- Trading helpers -------------------
    def get_account(self) -> Dict[str, Any]:
        account = self.trading.get_account()
        return self._model_to_dict(account)

    def get_asset(self, symbol_or_asset_id: str) -> Dict[str, Any] | None:
        try:
            asset = self.trading.get_asset(symbol_or_asset_id)
        except APIError as exc:
            if _is_explicit_http_not_found(exc):
                return None
            raise
        if asset is None:
            return None
        return self._model_to_dict(asset)

    def list_positions(self) -> List[Dict[str, Any]]:
        positions = self.trading.get_all_positions()
        return [self._model_to_dict(pos) for pos in positions]

    def list_open_orders(self) -> List[Dict[str, Any]]:
        request = GetOrdersRequest(status=QueryOrderStatus.OPEN)
        orders = self.trading.get_orders(request)
        return [self._model_to_dict(order) for order in orders]

    def list_orders(self, status: str = "all") -> List[Dict[str, Any]]:
        status_value = QueryOrderStatus(status.lower())
        request = GetOrdersRequest(status=status_value)
        orders = self.trading.get_orders(request)
        return [self._model_to_dict(order) for order in orders]

    def get_order(self, alpaca_order_id: str) -> Dict[str, Any]:
        order = self.trading.get_order_by_id(alpaca_order_id)
        return self._model_to_dict(order)

    def get_order_by_client_order_id(
        self, client_order_id: str
    ) -> Dict[str, Any] | None:
        try:
            order = self.trading.get_order_by_client_id(client_order_id)
        except APIError as exc:
            if _is_explicit_http_not_found(exc):
                return None
            raise
        if order is None:
            return None

        return self._model_to_dict(order)

    def get_order_by_client_order_id_strict(
        self, client_order_id: str
    ) -> dict[str, object] | None:
        """Read one exact client id once; only an explicit broker 404 means absent."""

        if not client_order_id.strip():
            raise ValueError("alpaca_client_order_id_required")
        try:
            order = self._trading.get_order_by_client_id(client_order_id)
        except APIError as exc:
            if _is_explicit_http_not_found(exc):
                return None
            raise
        if order is None:
            raise AlpacaStrictOrderLookupMalformedError(
                "alpaca_strict_order_lookup_missing_payload"
            )
        raw = self._extract_model_payload(order)
        if any(not isinstance(key, str) for key in raw):
            raise AlpacaStrictOrderLookupMalformedError(
                "alpaca_strict_order_lookup_non_string_key"
            )
        return {cast(str, key): value for key, value in raw.items()}

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
        order_extra_params = dict(extra_params or {})
        reserved_extra_params = sorted(
            _RESERVED_ORDER_EXTRA_PARAMS.intersection(order_extra_params)
        )
        if reserved_extra_params:
            raise ValueError(
                "alpaca_order_extra_params_reserved:" + ",".join(reserved_extra_params)
            )
        unsupported_extra_params = sorted(
            set(order_extra_params).difference(_ALLOWED_ORDER_EXTRA_PARAMS)
        )
        if unsupported_extra_params:
            raise ValueError(
                "alpaca_order_extra_params_unsupported:"
                + ",".join(unsupported_extra_params)
            )
        side_enum = OrderSide(side.lower())
        tif_enum = TimeInForce(time_in_force.lower())
        payload = {
            "symbol": symbol,
            "qty": qty,
            "side": side_enum,
            "time_in_force": tif_enum,
        }
        payload.update(order_extra_params)

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
                raise ValueError(
                    "stop_limit orders require both stop_price and limit_price"
                )
            request = StopLimitOrderRequest(
                stop_price=stop_price, limit_price=limit_price, **payload
            )
        else:
            raise ValueError(f"Unsupported order_type: {order_type}")

        order = self._trading.submit_order(request)
        return self._model_to_dict(order)

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: OrderFirewallToken
    ) -> bool:
        self._require_firewall_caller()
        self._require_firewall_token(firewall_token)
        self._trading.cancel_order_by_id(alpaca_order_id)
        return True

    def cancel_all_orders(
        self, *, firewall_token: OrderFirewallToken
    ) -> List[Dict[str, Any]]:
        self._require_firewall_caller()
        self._require_firewall_token(firewall_token)
        responses = self._trading.cancel_orders()
        return [self._model_to_dict(resp) for resp in responses]

    # ------------------- Market data -------------------
    def get_bars(
        self, symbols: Iterable[str] | str, timeframe: str, lookback_bars: int
    ) -> Dict[str, List[Dict[str, Any]]]:
        timeframe_obj = self._parse_timeframe(timeframe)
        if isinstance(symbols, str):
            symbols = [symbols]

        start = datetime.now(timezone.utc) - self._timeframe_to_timedelta(
            timeframe_obj, lookback_bars
        )
        request = StockBarsRequest(
            symbol_or_symbols=list(symbols),
            timeframe=timeframe_obj,
            start=start,
            limit=lookback_bars,
        )
        bars = cast(Any, self.data).get_stock_bars(request)

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
    @classmethod
    def _model_to_dict(cls, model: Any) -> Dict[str, Any]:
        raw = cls._extract_model_payload(model)
        return cast(Dict[str, Any], cls._to_jsonable(raw))

    @classmethod
    def _to_jsonable(cls, value: Any) -> Any:
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        if isinstance(value, UUID):
            return str(value)
        if isinstance(value, datetime):
            return value.isoformat()
        if isinstance(value, Decimal):
            return str(value)
        if isinstance(value, Enum):
            return cls._to_jsonable(value.value)
        if is_dataclass(value) and not isinstance(value, type):
            return cls._to_jsonable(asdict(value))
        if isinstance(value, Mapping):
            mapping = cast(Mapping[object, Any], value)
            return {str(key): cls._to_jsonable(val) for key, val in mapping.items()}
        if isinstance(value, (list, tuple, set, frozenset)):
            items = cast(Iterable[Any], value)
            return [cls._to_jsonable(item) for item in items]
        return str(value)

    @staticmethod
    def _extract_model_payload(model: Any) -> Mapping[object, Any]:
        if hasattr(model, "model_dump"):
            try:
                raw = model.model_dump(mode="json")
            except TypeError:
                raw = model.model_dump()
            if isinstance(raw, Mapping):
                return cast(Mapping[object, Any], raw)
            raise TypeError(f"Unsupported model_dump payload type: {type(raw)}")
        if isinstance(model, Mapping):
            return cast(Mapping[object, Any], model)
        try:
            raw_vars = cast(Mapping[str, Any], vars(model))
        except TypeError as exc:
            raise TypeError(f"Unsupported model type: {type(model)}") from exc
        return {
            key: value for key, value in raw_vars.items() if not key.startswith("_")
        }

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
            caller_module = (
                caller.f_globals.get("__name__", "") if caller is not None else ""
            )
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
    "AlpacaStrictOrderLookupMalformedError",
    "OrderFirewallToken",
    "OrderFirewallViolation",
    "TorghutAlpacaClient",
]
