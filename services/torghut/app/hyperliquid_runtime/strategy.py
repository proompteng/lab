"""Deterministic V1 signal generation for Hyperliquid equity-like perps."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from .models import DecisionAction, FeatureSnapshot, Signal


_LONG_THRESHOLD_BPS = Decimal("8")
_SHORT_THRESHOLD_BPS = Decimal("-8")
_MAX_SPREAD_BPS = Decimal("20")
_MAX_VOLATILITY_BPS = Decimal("250")
_MIN_LIQUIDITY_USD = Decimal("25000")


def generate_signal(
    feature: FeatureSnapshot,
    *,
    parameter_version: str,
    now: datetime | None = None,
) -> Signal:
    """Generate a deterministic signal with no online mutation or LLM path."""

    observed_at = now or datetime.now(timezone.utc)
    action, reason = _action_and_reason(feature)
    strength = _strength(feature, action)
    return Signal(
        market_id=feature.market_id,
        coin=feature.coin,
        generated_at=observed_at,
        action=action,
        strength=strength,
        reason=reason,
        parameter_version=parameter_version,
        feature=feature,
    )


def _action_and_reason(feature: FeatureSnapshot) -> tuple[DecisionAction, str]:
    hold_reason = _hold_reason(feature)
    if hold_reason is not None:
        return "hold", hold_reason
    if _is_long_setup(feature):
        return "buy", "positive_momentum_liquid_book"
    if _is_short_setup(feature):
        return "sell", "negative_momentum_liquid_book"
    return "hold", "no_edge"


def _strength(
    feature: FeatureSnapshot,
    action: DecisionAction,
) -> Decimal:
    if action not in {"buy", "sell"}:
        return Decimal("0")
    momentum = abs(feature.momentum_5m_bps)
    liquidity_boost = min(feature.liquidity_usd / Decimal("1000000"), Decimal("1"))
    spread_penalty = max(
        Decimal("0"), Decimal("1") - (feature.spread_bps / _MAX_SPREAD_BPS)
    )
    return min(
        Decimal("1"),
        (momentum / Decimal("50")) * Decimal("0.75")
        + liquidity_boost * spread_penalty * Decimal("0.25"),
    )


def _hold_reason(feature: FeatureSnapshot) -> str | None:
    checks = (
        (feature.source_lag_seconds > 120, "stale_feature_snapshot"),
        (feature.liquidity_usd < _MIN_LIQUIDITY_USD, "liquidity_below_floor"),
        (feature.spread_bps > _MAX_SPREAD_BPS, "spread_above_cap"),
        (feature.volatility_bps > _MAX_VOLATILITY_BPS, "volatility_above_cap"),
    )
    return next((reason for blocked, reason in checks if blocked), None)


def _is_long_setup(feature: FeatureSnapshot) -> bool:
    return (
        feature.momentum_5m_bps >= _LONG_THRESHOLD_BPS
        and feature.book_imbalance >= Decimal("-0.25")
    )


def _is_short_setup(feature: FeatureSnapshot) -> bool:
    return (
        feature.momentum_5m_bps <= _SHORT_THRESHOLD_BPS
        and feature.book_imbalance <= Decimal("0.25")
    )
