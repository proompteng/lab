"""Typed single-attempt boundary around Hyperliquid's untyped SDK."""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, cast

from requests.exceptions import RequestException

from ..trading.broker_mutation_receipts import BrokerMutationBrokerIoError
from .models import OrderResult, OrderStatus


class HyperliquidMarketOpenClient(Protocol):
    def market_open(self, **kwargs: object) -> object: ...


@dataclass(frozen=True, slots=True)
class MarketOpenRequest:
    market_name: str
    is_buy: bool
    size: float
    limit_price: float
    cloid: object


_SDK_ERROR_MODULE = importlib.import_module("hyperliquid.utils.error")
_SDK_ERRORS = cast(
    tuple[type[Exception], ...],
    (
        getattr(_SDK_ERROR_MODULE, "ClientError"),
        getattr(_SDK_ERROR_MODULE, "ServerError"),
    ),
)
_MARKET_OPEN_ERRORS = _SDK_ERRORS + (
    RequestException,
    ArithmeticError,
    AttributeError,
    LookupError,
    OSError,
    RuntimeError,
    TypeError,
    ValueError,
)


def submit_market_open(
    client: HyperliquidMarketOpenClient,
    request: MarketOpenRequest,
) -> dict[str, object]:
    """Perform exactly one SDK mutation and normalize its response shape."""

    try:
        response = client.market_open(
            name=request.market_name,
            is_buy=request.is_buy,
            sz=request.size,
            px=request.limit_price,
            slippage=0.0,
            cloid=request.cloid,
        )
    except _MARKET_OPEN_ERRORS as exc:
        raise BrokerMutationBrokerIoError(
            f"hyperliquid_broker_io_failed:{type(exc).__name__}"
        ) from exc
    if not isinstance(response, Mapping):
        raise BrokerMutationBrokerIoError("hyperliquid_broker_response_invalid")
    normalized: dict[str, object] = {}
    for key, value in cast(Mapping[object, object], response).items():
        if not isinstance(key, str):
            raise BrokerMutationBrokerIoError("hyperliquid_broker_response_invalid")
        normalized[key] = value
    return normalized


def parse_order_result(response: dict[str, object]) -> OrderResult:
    status: OrderStatus = "submitted"
    exchange_order_id: str | None = None
    rejection_reason: str | None = None
    response_body = response.get("response")
    if isinstance(response_body, dict):
        response_map = cast(Mapping[str, object], response_body)
        data = response_map.get("data")
        if isinstance(data, dict):
            data_map = cast(Mapping[str, object], data)
            statuses = data_map.get("statuses")
            if isinstance(statuses, list) and statuses:
                first = cast(list[object], statuses)[0]
                if isinstance(first, dict):
                    status, exchange_order_id, rejection_reason = _parse_sdk_status(
                        cast(dict[str, object], first)
                    )
    return OrderResult(status, exchange_order_id, response, rejection_reason)


def _parse_sdk_status(
    status_payload: dict[str, object],
) -> tuple[OrderStatus, str | None, str | None]:
    if "error" in status_payload:
        return "rejected", None, str(status_payload["error"])
    for name, order_status in (("resting", "accepted"), ("filled", "filled")):
        value = status_payload.get(name)
        if not isinstance(value, dict):
            continue
        oid = cast(Mapping[str, object], value).get("oid")
        return (
            cast(OrderStatus, order_status),
            str(oid) if oid is not None else None,
            None,
        )
    return "submitted", None, None


def is_halted(result: OrderResult) -> bool:
    return (result.rejection_reason or "").strip() == "Trading is halted."


__all__ = [
    "MarketOpenRequest",
    "is_halted",
    "parse_order_result",
    "submit_market_open",
]
