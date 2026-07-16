"""Thin wrappers around alpaca-py clients for torghut."""

from __future__ import annotations

import re
from collections.abc import Callable, Iterable, Mapping
from dataclasses import asdict, dataclass, is_dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from enum import Enum
from typing import Any, Dict, List, Optional, Protocol, cast
from urllib.parse import urlsplit
from uuid import UUID

from alpaca.common.exceptions import APIError
from alpaca.common.enums import Sort
from alpaca.data.historical import StockHistoricalDataClient
from alpaca.data.requests import StockBarsRequest
from alpaca.data.timeframe import TimeFrame, TimeFrameUnit
from alpaca.trading.client import TradingClient
from alpaca.trading.enums import OrderSide, QueryOrderStatus, TimeInForce
from alpaca.trading.requests import (
    ClosePositionRequest,
    GetOrdersRequest,
    LimitOrderRequest,
    MarketOrderRequest,
    StopLimitOrderRequest,
    StopOrderRequest,
    ReplaceOrderRequest,
)

from .config import settings


_ORDER_FIREWALL_TOKEN_SEAL = object()


class OrderFirewallToken:
    """Opaque process-local capability required for raw Alpaca mutations."""

    __slots__ = ()

    def __init__(self, seal: object) -> None:
        if seal is not _ORDER_FIREWALL_TOKEN_SEAL:
            raise OrderFirewallViolation("order_firewall_token_issuer_invalid")


class OrderFirewallViolation(PermissionError):
    """Raised when broker mutation methods are called outside OrderFirewall."""


def issue_order_firewall_token() -> OrderFirewallToken:
    """Mint the one narrow capability consumed by the Alpaca client boundary."""

    return OrderFirewallToken(_ORDER_FIREWALL_TOKEN_SEAL)


class AlpacaStrictOrderLookupMalformedError(RuntimeError):
    """Raised when an exact broker lookup returns no trustworthy order payload."""


@dataclass(frozen=True, slots=True)
class AlpacaRecoveryOrderHistoryPage:
    """One bounded order-history read used only to prove recovery completeness."""

    orders: tuple[dict[str, object], ...]
    complete: bool
    limit: int
    after: datetime
    until: datetime


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

AlpacaOrderRequest = (
    MarketOrderRequest | LimitOrderRequest | StopOrderRequest | StopLimitOrderRequest
)


@dataclass(frozen=True, slots=True)
class AlpacaSubmitRequest:
    symbol: object
    side: object
    qty: object
    order_type: object
    time_in_force: object
    limit_price: object = None
    stop_price: object = None
    extra_params: Mapping[str, object] | None = None


def build_alpaca_order_request(request: AlpacaSubmitRequest) -> AlpacaOrderRequest:
    """Validate and build the exact SDK request before broker I/O begins."""

    order_extra_params = dict(request.extra_params or {})
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
    payload: dict[str, Any] = {
        "symbol": str(request.symbol),
        "qty": float(str(request.qty)),
        "side": OrderSide(str(request.side).lower()),
        "time_in_force": TimeInForce(str(request.time_in_force).lower()),
    }
    payload.update(order_extra_params)

    order_type_lower = str(request.order_type).lower()
    if order_type_lower == "market":
        return MarketOrderRequest(**payload)
    if order_type_lower == "limit":
        if request.limit_price is None:
            raise ValueError("limit_price is required for limit orders")
        return LimitOrderRequest(limit_price=float(str(request.limit_price)), **payload)
    if order_type_lower == "stop":
        if request.stop_price is None:
            raise ValueError("stop_price is required for stop orders")
        return StopOrderRequest(stop_price=float(str(request.stop_price)), **payload)
    if order_type_lower == "stop_limit":
        if request.stop_price is None or request.limit_price is None:
            raise ValueError(
                "stop_limit orders require both stop_price and limit_price"
            )
        return StopLimitOrderRequest(
            stop_price=float(str(request.stop_price)),
            limit_price=float(str(request.limit_price)),
            **payload,
        )
    raise ValueError(f"Unsupported order_type: {request.order_type}")


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

    def replace_order_by_id(self, order_id: str, _order_data: Any, /) -> Any: ...

    def close_position(
        self,
        symbol_or_asset_id: str,
        _close_options: Any,
        /,
    ) -> Any: ...

    def close_all_positions(self, cancel_orders: bool = False) -> Any: ...


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
        request_timeout_seconds: float = 10.0,
    ) -> None:
        if (
            isinstance(request_timeout_seconds, bool)
            or request_timeout_seconds <= 0
            or request_timeout_seconds > 15
        ):
            raise ValueError("alpaca_request_timeout_seconds_outside_bounds")
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
        self._request_timeout_seconds = float(request_timeout_seconds)

    def _one_request(
        self,
        method: str,
        url: str,
        opts: dict[str, Any],
        retry: int,
    ) -> dict[str, Any]:
        bounded_opts = dict(opts)
        bounded_opts.setdefault("timeout", self._request_timeout_seconds)
        base_request = cast(
            Callable[[str, str, dict[str, Any], int], dict[str, Any]],
            getattr(super(), "_one_request"),
        )
        return base_request(method, url, bounded_opts, retry)


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
        recovery_trading_client: _ReadOnlyTradingClientLike | None = None,
        data_client: _StockDataClientLike | None = None,
        paper: Optional[bool] = None,
    ) -> None:
        key = api_key or settings.apca_api_key_id
        secret = secret_key or settings.apca_api_secret_key
        base = _normalize_alpaca_base_url(base_url or settings.apca_api_base_url)
        data_base = _normalize_alpaca_base_url(settings.apca_data_api_base_url)

        self.endpoint_url = base or (
            "https://paper-api.alpaca.markets"
            if (paper if paper is not None else settings.trading_mode != "live")
            else "https://api.alpaca.markets"
        )
        endpoint_class = classify_alpaca_trading_endpoint(self.endpoint_url)
        if paper is not None and endpoint_class != ("paper" if paper else "live"):
            raise ValueError("alpaca_endpoint_paper_mode_mismatch")
        self.endpoint_class = endpoint_class
        use_paper = endpoint_class == "paper"

        # Broker mutations use a dedicated single-attempt client so an ambiguous
        # response cannot cause a hidden resubmission. Ordinary reads retain the
        # SDK retry policy; strict submit-recovery reads use their own bounded,
        # single-attempt client so one worker lease has a deterministic I/O bound.
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
                request_timeout_seconds=(
                    settings.trading_broker_mutation_http_timeout_seconds
                ),
            )
            recovery_read_trading_client: _ReadOnlyTradingClientLike = (
                recovery_trading_client
                or _SingleAttemptTradingClient(
                    api_key=key,
                    secret_key=secret,
                    paper=use_paper,
                    url_override=base,
                    request_timeout_seconds=(
                        settings.trading_broker_mutation_http_timeout_seconds
                    ),
                )
            )
        else:
            read_trading_client = trading_client
            mutation_trading_client = trading_client
            recovery_read_trading_client = recovery_trading_client or trading_client

        self._trading = mutation_trading_client
        self.trading: _ReadOnlyTradingClient = _ReadOnlyTradingClient(
            read_trading_client
        )
        self._recovery_trading = _ReadOnlyTradingClient(recovery_read_trading_client)

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

    def list_orders(
        self,
        status: str = "all",
        *,
        limit: int | None = None,
    ) -> List[Dict[str, Any]]:
        status_value = QueryOrderStatus(status.lower())
        if limit is not None and (type(limit) is not int or not 1 <= limit <= 500):
            raise ValueError("alpaca_order_list_limit_outside_bounds")
        request = GetOrdersRequest(status=status_value, limit=limit)
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
            order = self._recovery_trading.get_order_by_client_id(client_order_id)
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

    def get_order_by_id_strict(self, order_id: str) -> dict[str, object] | None:
        """Read one broker order ID once; only an explicit 404 proves absence."""

        if not order_id.strip():
            raise ValueError("alpaca_order_id_required")
        try:
            order = self._recovery_trading.get_order_by_id(order_id)
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

    def list_orders_recovery_window(
        self,
        *,
        after: datetime,
        until: datetime,
        limit: int = 500,
    ) -> AlpacaRecoveryOrderHistoryPage:
        """Read a bounded all-status window; a full page is explicitly incomplete."""

        if after.tzinfo is None or until.tzinfo is None:
            raise ValueError("alpaca_recovery_window_timezone_required")
        normalized_after = after.astimezone(timezone.utc)
        normalized_until = until.astimezone(timezone.utc)
        if normalized_after >= normalized_until:
            raise ValueError("alpaca_recovery_window_invalid")
        if type(limit) is not int or not 1 <= limit <= 500:
            raise ValueError("alpaca_recovery_history_limit_outside_bounds")
        request = GetOrdersRequest(
            status=QueryOrderStatus.ALL,
            limit=limit,
            after=normalized_after,
            until=normalized_until,
            direction=Sort.ASC,
        )
        raw_orders = tuple(self._recovery_trading.get_orders(request))
        orders = tuple(
            cast(dict[str, object], self._model_to_dict(order)) for order in raw_orders
        )
        return AlpacaRecoveryOrderHistoryPage(
            orders=orders,
            complete=len(orders) < limit,
            limit=limit,
            after=normalized_after,
            until=normalized_until,
        )

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
        self._require_firewall_token(firewall_token)
        request = build_alpaca_order_request(
            AlpacaSubmitRequest(
                symbol=symbol,
                side=side,
                qty=qty,
                order_type=order_type,
                time_in_force=time_in_force,
                limit_price=limit_price,
                stop_price=stop_price,
                extra_params=extra_params,
            )
        )
        order = self._trading.submit_order(request)
        return self._model_to_dict(order)

    def cancel_order(
        self, alpaca_order_id: str, *, firewall_token: OrderFirewallToken
    ) -> bool:
        self._require_firewall_token(firewall_token)
        self._trading.cancel_order_by_id(alpaca_order_id)
        return True

    def cancel_all_orders(
        self, *, firewall_token: OrderFirewallToken
    ) -> List[Dict[str, Any]]:
        self._require_firewall_token(firewall_token)
        responses = self._trading.cancel_orders()
        return [self._model_to_dict(resp) for resp in responses]

    def replace_order(
        self,
        alpaca_order_id: str,
        *,
        limit_price: float,
        firewall_token: OrderFirewallToken,
    ) -> Dict[str, Any]:
        self._require_firewall_token(firewall_token)
        order = self._trading.replace_order_by_id(
            alpaca_order_id,
            ReplaceOrderRequest(limit_price=limit_price),
        )
        return self._model_to_dict(order)

    def close_position(
        self,
        symbol_or_asset_id: str,
        *,
        qty: Decimal,
        firewall_token: OrderFirewallToken,
    ) -> Dict[str, Any]:
        self._require_firewall_token(firewall_token)
        position_target = symbol_or_asset_id
        if "/" in position_target:
            asset = self.get_asset(position_target)
            asset_id = str((asset or {}).get("id") or "").strip()
            try:
                position_target = str(UUID(asset_id))
            except ValueError as exc:
                raise ValueError("alpaca_crypto_close_asset_id_invalid") from exc
        order = self._trading.close_position(
            position_target,
            ClosePositionRequest(qty=str(qty)),
        )
        return self._model_to_dict(order)

    def close_all_positions(
        self,
        *,
        firewall_token: OrderFirewallToken,
    ) -> List[Dict[str, Any]]:
        self._require_firewall_token(firewall_token)
        raw = self._trading.close_all_positions(cancel_orders=False)
        if isinstance(raw, Mapping):
            return [self._model_to_dict(raw)]
        return [self._model_to_dict(response) for response in raw]

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
            raise OrderFirewallViolation("order_firewall_token_required")


def _normalize_alpaca_base_url(base_url: Optional[str]) -> Optional[str]:
    if not base_url:
        return None
    trimmed = base_url.rstrip("/")
    if trimmed.endswith("/v2"):
        return trimmed[:-3]
    return trimmed


def classify_alpaca_trading_endpoint(endpoint_url: str) -> str:
    parsed = urlsplit(endpoint_url)
    host = (parsed.hostname or "").lower()
    if (
        parsed.scheme != "https"
        or parsed.username
        or parsed.password
        or parsed.port
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
    ):
        raise ValueError("alpaca_trading_endpoint_invalid")
    if host == "paper-api.alpaca.markets":
        return "paper"
    if host == "api.alpaca.markets":
        return "live"
    raise ValueError("alpaca_trading_endpoint_unrecognized")


__all__ = [
    "AlpacaRecoveryOrderHistoryPage",
    "AlpacaStrictOrderLookupMalformedError",
    "classify_alpaca_trading_endpoint",
    "OrderFirewallToken",
    "OrderFirewallViolation",
    "TorghutAlpacaClient",
    "issue_order_firewall_token",
]
