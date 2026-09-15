"""Single configured broker-economic scope shared by status and execution gates."""

from __future__ import annotations

from app.alpaca_client import classify_alpaca_trading_endpoint
from app.config import Settings, settings
from app.trading.broker_mutation_receipts import fingerprint_broker_endpoint

from .types import LedgerScope


def configured_broker_endpoint(settings_obj: Settings = settings) -> str:
    endpoint = str(settings_obj.apca_api_base_url or "").strip().rstrip("/")
    if endpoint.endswith("/v2"):
        endpoint = endpoint[:-3]
    if endpoint:
        return endpoint
    return (
        "https://api.alpaca.markets"
        if settings_obj.trading_mode == "live"
        else "https://paper-api.alpaca.markets"
    )


def configured_broker_environment(settings_obj: Settings = settings) -> str:
    try:
        return classify_alpaca_trading_endpoint(
            configured_broker_endpoint(settings_obj)
        )
    except ValueError:
        return "unknown"


def configured_broker_economic_scope(
    *,
    account_label: str | None = None,
    settings_obj: Settings = settings,
) -> LedgerScope:
    endpoint = configured_broker_endpoint(settings_obj)
    return LedgerScope(
        provider="alpaca",
        environment=configured_broker_environment(settings_obj),
        account_label=account_label or settings_obj.trading_account_label,
        endpoint_fingerprint=fingerprint_broker_endpoint(endpoint),
    )


__all__ = (
    "configured_broker_economic_scope",
    "configured_broker_endpoint",
    "configured_broker_environment",
)
