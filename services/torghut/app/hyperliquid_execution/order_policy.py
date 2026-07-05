"""Bounded order policies for Hyperliquid execution v2."""

from __future__ import annotations

import hashlib
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP

from .config import HyperliquidExecutionConfig
from .models import OrderIntent, RiskVerdict, Signal

_BPS_DENOMINATOR = Decimal("10000")
_PRICE_QUANTUM = Decimal("0.000001")


def build_order_intent(
    *,
    signal: Signal,
    verdict: RiskVerdict,
    config: HyperliquidExecutionConfig,
    signal_id: str,
    now: datetime | None = None,
) -> OrderIntent:
    """Create an order intent for the active restore policy."""

    if not verdict.allowed:
        raise ValueError(f"risk_verdict_blocked:{verdict.reason}")
    observed_at = now or datetime.now(timezone.utc)
    side = "buy" if signal.action == "buy" else "sell"
    price = _limit_price(
        signal,
        side,
        config.marketable_ioc_slippage_bps,
    )
    size = _order_size(
        verdict.order_notional_usd,
        price,
        config.min_order_size,
    )
    notional = (price * size).quantize(_PRICE_QUANTUM)
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
            signal_id=signal_id,
            market_id=signal.market_id,
            side=side,
        ),
        tif=config.effective_order_tif,
        reduce_only=False,
        signal_id=signal_id,
        expires_at=observed_at + timedelta(seconds=config.order_ttl_seconds),
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


def _limit_price(
    signal: Signal,
    side: str,
    slippage_bps: Decimal,
) -> Decimal:
    price = signal.feature.ask_price if side == "buy" else signal.feature.bid_price
    if price is None or price <= Decimal("0"):
        raise ValueError("missing_executable_quote")
    if slippage_bps > Decimal("0"):
        slippage = slippage_bps / _BPS_DENOMINATOR
        if side == "buy":
            return (price * (Decimal("1") + slippage)).quantize(
                _PRICE_QUANTUM, rounding=ROUND_UP
            )
        return (price * (Decimal("1") - slippage)).quantize(
            _PRICE_QUANTUM, rounding=ROUND_DOWN
        )
    return price
