"""Simple deterministic edge gate for Hyperliquid execution v2."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from .config import HyperliquidExecutionConfig
from .models import FeatureSnapshot, Signal


_MAX_SPREAD_BPS = Decimal("25")
_MAX_VOLATILITY_BPS = Decimal("350")
_MIN_LIQUIDITY_USD = Decimal("1000")


def generate_signal(
    feature: FeatureSnapshot,
    config: HyperliquidExecutionConfig,
    *,
    now: datetime | None = None,
) -> Signal:
    """Emit buy/sell only when edge exceeds spread plus cost buffer."""

    generated_at = now or datetime.now(timezone.utc)
    hold_reason = _hold_reason(feature, config)
    if hold_reason is not None:
        return Signal(
            feature.market_id,
            feature.coin,
            generated_at,
            "hold",
            Decimal("0"),
            hold_reason,
            feature,
        )
    edge_bps = feature.momentum_5m_bps
    required_edge_bps = max(
        config.min_edge_bps, feature.spread_bps + config.cost_buffer_bps
    )
    if abs(edge_bps) <= required_edge_bps:
        return Signal(
            feature.market_id,
            feature.coin,
            generated_at,
            "hold",
            edge_bps,
            "no_edge",
            feature,
        )
    action = "buy" if edge_bps > Decimal("0") else "sell"
    return Signal(
        feature.market_id,
        feature.coin,
        generated_at,
        action,
        edge_bps,
        "edge_exceeds_cost",
        feature,
    )


def _hold_reason(
    feature: FeatureSnapshot, config: HyperliquidExecutionConfig
) -> str | None:
    checks = (
        (
            feature.source_lag_seconds > config.signal_staleness_seconds,
            "stale_features",
        ),
        (feature.quote_lag_seconds is None, "missing_quote_timestamp"),
        (
            feature.quote_lag_seconds is not None
            and feature.quote_lag_seconds > config.signal_staleness_seconds,
            "stale_quote",
        ),
        (feature.bid_price is None, "missing_bid"),
        (feature.ask_price is None, "missing_ask"),
        (
            feature.bid_price is not None and feature.bid_price <= Decimal("0"),
            "non_positive_bid",
        ),
        (
            feature.ask_price is not None and feature.ask_price <= Decimal("0"),
            "non_positive_ask",
        ),
        (
            feature.bid_price is not None
            and feature.ask_price is not None
            and feature.ask_price < feature.bid_price,
            "crossed_quote",
        ),
        (feature.liquidity_usd < _MIN_LIQUIDITY_USD, "liquidity_below_floor"),
        (feature.spread_bps > _MAX_SPREAD_BPS, "spread_above_cap"),
        (feature.volatility_bps > _MAX_VOLATILITY_BPS, "volatility_above_cap"),
    )
    return next((reason for blocked, reason in checks if blocked), None)
