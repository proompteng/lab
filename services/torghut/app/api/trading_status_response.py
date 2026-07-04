"""Response projection for the Torghut trading status route."""

from __future__ import annotations

from typing import cast

from app.trading.legacy_reason_sanitizer import (
    sanitize_legacy_alpha_readiness_reasons,
)

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
    return cast(
        dict[str, object],
        sanitize_legacy_alpha_readiness_reasons(project_trading_status_response(build)),
    )


__all__ = [
    "TradingStatusResponseBuild",
    "TradingStatusResponseDependencies",
    "build_trading_status_response",
]
