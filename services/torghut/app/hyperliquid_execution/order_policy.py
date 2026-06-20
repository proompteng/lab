"""Maker TTL order policy for Hyperliquid execution v2."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_UP

from .config import HyperliquidExecutionConfig
from .models import OrderIntent, RiskVerdict, Signal


def build_maker_order_intent(
    *,
    signal: Signal,
    verdict: RiskVerdict,
    config: HyperliquidExecutionConfig,
    signal_id: str,
    now: datetime | None = None,
) -> OrderIntent:
    """Create a non-crossing maker order at bid for buy and ask for sell."""

    if not verdict.allowed:
        raise ValueError(f"risk_verdict_blocked:{verdict.reason}")
    observed_at = now or datetime.now(timezone.utc)
    side = "buy" if signal.action == "buy" else "sell"
    price = signal.feature.bid_price if side == "buy" else signal.feature.ask_price
    if price is None or price <= Decimal("0"):
        raise ValueError("missing_executable_quote")
    size = _order_size(verdict.order_notional_usd, price, config.min_order_size)
    notional = (price * size).quantize(Decimal("0.000001"))
    if notional < config.min_order_notional_usd:
        raise ValueError("order_notional_below_minimum")
    return OrderIntent(
        market_id=signal.market_id,
        coin=signal.coin,
        dex=signal.feature.dex,
        side=side,
        size=size,
        limit_price=price,
        notional_usd=notional,
        cloid=deterministic_cloid(
            signal_id=signal_id, market_id=signal.market_id, side=side
        ),
        tif=config.maker_tif,
        reduce_only=False,
        signal_id=signal_id,
        expires_at=observed_at + timedelta(seconds=config.maker_ttl_seconds),
    )


def deterministic_cloid(*, signal_id: str, market_id: str, side: str) -> str:
    """Return a 128-bit Hyperliquid client order id."""

    digest = hashlib.sha256(
        f"{signal_id}\0{market_id}\0{side}".encode("utf-8")
    ).hexdigest()
    return f"0x{digest[:32]}"


def _order_size(notional: Decimal, price: Decimal, min_order_size: Decimal) -> Decimal:
    if price <= Decimal("0"):
        raise ValueError("feature_price_must_be_positive")
    size = (notional / price).quantize(min_order_size, rounding=ROUND_UP)
    if size < min_order_size:
        raise ValueError("order_size_below_minimum")
    return size
