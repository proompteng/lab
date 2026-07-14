"""Bounded order policies for Hyperliquid execution v2."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from decimal import Decimal, ROUND_DOWN, ROUND_UP

from .config import HyperliquidExecutionConfig
from .models import OrderIntent, RiskVerdict, Signal

_BPS_DENOMINATOR = Decimal("10000")
_PRICE_QUANTUM = Decimal("0.000001")


@dataclass(frozen=True, slots=True)
class _CloidIdentity:
    market_id: str
    side: str
    source_event_ts: datetime
    size: Decimal
    limit_price: Decimal
    tif: str
    reduce_only: bool


def build_order_intent(
    *,
    signal: Signal,
    verdict: RiskVerdict,
    config: HyperliquidExecutionConfig,
    signal_id: str,
    now: datetime | None = None,
) -> OrderIntent:
    """Create an order intent for the active execution policy."""

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
            _CloidIdentity(
                market_id=signal.market_id,
                side=side,
                source_event_ts=signal.feature.event_ts,
                size=size,
                limit_price=price,
                tif=config.effective_order_tif,
                reduce_only=False,
            )
        ),
        tif=config.effective_order_tif,
        reduce_only=False,
        signal_id=signal_id,
        expires_at=observed_at + timedelta(seconds=config.order_ttl_seconds),
    )


def deterministic_cloid(
    identity: _CloidIdentity,
) -> str:
    """Bind a 128-bit CLOID to immutable source and exact broker economics."""

    if identity.source_event_ts.tzinfo is None:
        raise ValueError("source_event_ts_timezone_required")
    source_identity = identity.source_event_ts.astimezone(timezone.utc).isoformat(
        timespec="microseconds"
    )

    digest = hashlib.sha256(
        "\0".join(
            (
                "torghut.hyperliquid-submit.v1",
                identity.market_id,
                identity.side,
                source_identity,
                _canonical_decimal(identity.size),
                _canonical_decimal(identity.limit_price),
                identity.tif,
                "true" if identity.reduce_only else "false",
            )
        ).encode("utf-8")
    ).hexdigest()
    return f"0x{digest[:32]}"


def _canonical_decimal(value: Decimal) -> str:
    if not value.is_finite():
        raise ValueError("order_identity_decimal_must_be_finite")
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


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
