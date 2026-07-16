from __future__ import annotations

import hashlib
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal

from app.trading.economic_ledger import EconomicActivity, LedgerScope


SCOPE = LedgerScope(
    provider="alpaca",
    environment="paper",
    account_label="paper-account",
    endpoint_fingerprint="a" * 64,
    quote_currency="USD",
)
BASE_TIME = datetime(2026, 7, 16, 9, 30, tzinfo=timezone.utc)


def activity(
    external_id: str,
    activity_type: str,
    *,
    subtype: str | None = None,
    correction_of: str | None = None,
    event_offset_seconds: int = 0,
    symbol: str | None = None,
    side: str | None = None,
    quantity: str | None = None,
    price: str | None = None,
    net_amount: str | None = None,
    currency: str | None = "USD",
    raw_payload_sha256: str | None = None,
) -> EconomicActivity:
    return EconomicActivity(
        scope=SCOPE,
        external_activity_id=external_id,
        raw_payload_sha256=(
            raw_payload_sha256
            or hashlib.sha256(external_id.encode("utf-8")).hexdigest()
        ),
        activity_type=activity_type,
        activity_subtype=subtype,
        correction_of_external_id=correction_of,
        event_at=BASE_TIME + timedelta(seconds=event_offset_seconds),
        settle_date=date(2026, 7, 16),
        first_observed_at=BASE_TIME + timedelta(minutes=1),
        symbol=symbol,
        side=side,
        quantity=Decimal(quantity) if quantity is not None else None,
        price=Decimal(price) if price is not None else None,
        net_amount=Decimal(net_amount) if net_amount is not None else None,
        currency=currency,
    )


def cash(projection, currency: str = "USD") -> Decimal:
    return {balance.commodity: balance.amount for balance in projection.cash}.get(
        currency,
        Decimal("0"),
    )


def position(projection, symbol: str):
    return {item.symbol: item for item in projection.positions}.get(symbol)
