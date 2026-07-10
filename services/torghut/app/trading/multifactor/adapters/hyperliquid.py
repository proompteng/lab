"""Hyperliquid adapter for the generic multifactor machine."""

from __future__ import annotations

from decimal import Decimal

from app.hyperliquid_execution.models import FeatureSnapshot

from ..contracts import AssetKey, FactorVector
from ..normalization import (
    bounded_score,
    negative_quality_score,
    positive_quality_score,
)


def asset_from_feature(feature: FeatureSnapshot) -> AssetKey:
    """Build a venue-neutral asset key from a Hyperliquid feature row."""

    return AssetKey(
        venue="hyperliquid",
        symbol=feature.coin,
        market_id=feature.market_id,
        asset_class="perp",
    )


def factor_vector_from_feature(
    *,
    run_id: str,
    feature: FeatureSnapshot,
    max_staleness_seconds: int,
) -> FactorVector:
    """Map Hyperliquid runtime features into generic raw and normalized factors."""

    raw = {
        "momentum_5m": feature.momentum_5m_bps,
        "book_imbalance": feature.book_imbalance,
        "liquidity_usd": feature.liquidity_usd,
        "spread_bps": feature.spread_bps,
        "volatility_bps": feature.volatility_bps,
        "source_lag_seconds": Decimal(feature.source_lag_seconds),
    }
    if feature.quote_lag_seconds is not None:
        raw["quote_lag_seconds"] = Decimal(feature.quote_lag_seconds)
    freshness_blocker = _freshness_blocker(feature, max_staleness_seconds)
    normalized = {
        "momentum_5m": bounded_score(feature.momentum_5m_bps, Decimal("2")),
        "book_imbalance": bounded_score(feature.book_imbalance, Decimal("0.5")),
        "liquidity_usd": positive_quality_score(
            feature.liquidity_usd, Decimal("1000"), Decimal("100000")
        ),
        "spread_bps": negative_quality_score(
            feature.spread_bps, Decimal("25"), Decimal("10")
        ),
        "volatility_bps": negative_quality_score(
            feature.volatility_bps, Decimal("350"), Decimal("100")
        ),
    }
    return FactorVector(
        run_id=run_id,
        asset=asset_from_feature(feature),
        observed_at=feature.event_ts,
        source_event_at=feature.event_ts,
        raw_factors=raw,
        normalized_factors=normalized,
        source_lag_seconds=feature.source_lag_seconds,
        quote_lag_seconds=feature.quote_lag_seconds,
        freshness_blocker=freshness_blocker,
    )


def _freshness_blocker(
    feature: FeatureSnapshot,
    max_staleness_seconds: int,
) -> str | None:
    if feature.source_lag_seconds > max_staleness_seconds:
        return "stale_features"
    if feature.quote_lag_seconds is None:
        return "missing_quote_timestamp"
    if feature.quote_lag_seconds > max_staleness_seconds:
        return "stale_quote"
    return None
