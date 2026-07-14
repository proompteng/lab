"""Typed single-attempt boundary around Hyperliquid's untyped SDK."""

from __future__ import annotations

import importlib
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, cast

from requests.exceptions import RequestException

from ..trading.broker_mutation_receipts import BrokerMutationBrokerIoError


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


__all__ = ["MarketOpenRequest", "submit_market_open"]
