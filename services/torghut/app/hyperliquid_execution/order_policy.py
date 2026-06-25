"""Bounded order policies for Hyperliquid execution v2."""

from __future__ import annotations

import hashlib
from dataclasses import dataclass
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

    return _build_order_intent(
        _OrderIntentContext(signal, verdict, config, signal_id, now),
        _OrderSubmissionPolicy(tif=config.maker_tif, crosses_spread=False),
    )


def build_order_intent(
    *,
    signal: Signal,
    verdict: RiskVerdict,
    config: HyperliquidExecutionConfig,
    signal_id: str,
    now: datetime | None = None,
) -> OrderIntent:
    """Create an order intent for the active restore policy."""

    return _build_order_intent(
        _OrderIntentContext(signal, verdict, config, signal_id, now),
        _policy_for_config(config),
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


@dataclass(frozen=True)
class _OrderIntentContext:
    signal: Signal
    verdict: RiskVerdict
    config: HyperliquidExecutionConfig
    signal_id: str
    now: datetime | None


@dataclass(frozen=True)
class _OrderSubmissionPolicy:
    tif: str
    crosses_spread: bool


def _policy_for_config(config: HyperliquidExecutionConfig) -> _OrderSubmissionPolicy:
    if config.order_policy == "marketable_ioc":
        return _OrderSubmissionPolicy(
            tif=config.effective_order_tif, crosses_spread=True
        )
    if config.order_policy == "maker_ttl":
        return _OrderSubmissionPolicy(tif=config.maker_tif, crosses_spread=False)
    raise ValueError("unsupported_order_policy")


def _build_order_intent(
    context: _OrderIntentContext,
    policy: _OrderSubmissionPolicy,
) -> OrderIntent:
    if not context.verdict.allowed:
        raise ValueError(f"risk_verdict_blocked:{context.verdict.reason}")
    observed_at = context.now or datetime.now(timezone.utc)
    side = "buy" if context.signal.action == "buy" else "sell"
    price = _limit_price(context.signal, side, policy.crosses_spread)
    size = _order_size(
        context.verdict.order_notional_usd,
        price,
        context.config.min_order_size,
    )
    notional = (price * size).quantize(Decimal("0.000001"))
    if notional < context.config.min_order_notional_usd:
        raise ValueError("order_notional_below_minimum")
    return OrderIntent(
        market_id=context.signal.market_id,
        coin=context.signal.coin,
        dex=context.signal.feature.dex,
        side=side,
        size=size,
        limit_price=price,
        notional_usd=notional,
        cloid=deterministic_cloid(
            signal_id=context.signal_id,
            market_id=context.signal.market_id,
            side=side,
        ),
        tif=policy.tif,
        reduce_only=False,
        signal_id=context.signal_id,
        expires_at=observed_at + timedelta(seconds=context.config.maker_ttl_seconds),
    )


def _limit_price(signal: Signal, side: str, crosses_spread: bool) -> Decimal:
    if crosses_spread:
        price = signal.feature.ask_price if side == "buy" else signal.feature.bid_price
    else:
        price = signal.feature.bid_price if side == "buy" else signal.feature.ask_price
    if price is None or price <= Decimal("0"):
        raise ValueError("missing_executable_quote")
    return price
