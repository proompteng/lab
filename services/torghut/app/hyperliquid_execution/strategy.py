"""Deterministic direction signal for Hyperliquid execution v2."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from app.trading.multifactor.adapters.hyperliquid import factor_vector_from_feature
from app.trading.multifactor.alpha_model import build_alpha_forecast

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
    run_id: str = "runtime-pending",
) -> Signal:
    """Emit buy/sell for fresh directional forecasts.

    Expected edge and transaction-cost estimates are diagnostics in the
    multifactor rows. They are not submission gates for the testnet executor.
    """

    generated_at = now or datetime.now(timezone.utc)
    factor_vector = factor_vector_from_feature(
        run_id=run_id,
        feature=feature,
        max_staleness_seconds=config.signal_staleness_seconds,
    )
    alpha_forecast = build_alpha_forecast(
        factor_vector,
        residual_volatility_bps=max(
            feature.volatility_bps, abs(feature.momentum_5m_bps) * Decimal("3")
        ),
    )
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
            factor_vector,
            alpha_forecast,
        )
    edge_bps = alpha_forecast.expected_return_bps
    if alpha_forecast.direction == "hold":
        return Signal(
            feature.market_id,
            feature.coin,
            generated_at,
            "hold",
            edge_bps,
            alpha_forecast.blocker or "zero_expected_return",
            feature,
            factor_vector,
            alpha_forecast,
        )
    return Signal(
        feature.market_id,
        feature.coin,
        generated_at,
        alpha_forecast.direction,
        edge_bps,
        "alpha_direction",
        feature,
        factor_vector,
        alpha_forecast,
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
