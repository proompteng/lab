"""Response projection for the Torghut trading status route."""

from __future__ import annotations

from .trading_status_response_model import (
    TradingStatusResponseBuild,
    TradingStatusResponseDependencies,
)
from .trading_status_response_payloads import add_trading_status_payloads
from .trading_status_response_projection import project_trading_status_response


def build_trading_status_response(
    build: TradingStatusResponseBuild,
) -> dict[str, object]:
    add_trading_status_payloads(build)
    return project_trading_status_response(build)


__all__ = [
    "TradingStatusResponseBuild",
    "TradingStatusResponseDependencies",
    "build_trading_status_response",
]
