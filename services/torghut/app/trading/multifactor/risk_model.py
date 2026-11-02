"""Generic deterministic risk forecast for the runtime multifactor path."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .contracts import AlphaForecast, FactorVector, RiskForecast
from .factor_registry import (
    DEFAULT_HORIZON_SECONDS,
    DEFAULT_LIQUIDITY_PARTICIPATION_RATE,
)
from .normalization import quantize_bps


@dataclass(frozen=True)
class RiskExposureState:
    """Current exposure state used by deterministic runtime risk checks."""

    gross_exposure_usd: Decimal
    symbol_exposure_usd: Decimal
    daily_realized_pnl_usd: Decimal


@dataclass(frozen=True)
class RiskLimits:
    """Hard risk caps for the restore-path multifactor engine."""

    max_gross_exposure_usd: Decimal
    max_symbol_exposure_usd: Decimal
    max_daily_loss_usd: Decimal
    participation_rate: Decimal = DEFAULT_LIQUIDITY_PARTICIPATION_RATE


def build_risk_forecast(
    *,
    vector: FactorVector,
    forecast: AlphaForecast,
    exposure: RiskExposureState,
    limits: RiskLimits,
) -> RiskForecast:
    """Estimate active risk and hard blockers before portfolio construction."""

    liquidity_usd = vector.raw_factors.get("liquidity_usd", Decimal("0"))
    volatility_bps = vector.raw_factors.get("volatility_bps", Decimal("0"))
    active_risk_bps = _active_risk_bps(volatility_bps, forecast.horizon_seconds)
    liquidity_capacity_usd = (liquidity_usd * limits.participation_rate).quantize(
        Decimal("0.000001")
    )
    concentration_bps = _concentration_bps(
        exposure.symbol_exposure_usd,
        limits.max_gross_exposure_usd,
    )
    blocker = _first_risk_blocker(
        vector=vector,
        forecast=forecast,
        exposure=exposure,
        limits=limits,
        liquidity_capacity_usd=liquidity_capacity_usd,
    )
    return RiskForecast(
        run_id=vector.run_id,
        asset=vector.asset,
        active_risk_bps=active_risk_bps,
        gross_exposure_usd=exposure.gross_exposure_usd,
        symbol_exposure_usd=exposure.symbol_exposure_usd,
        liquidity_capacity_usd=liquidity_capacity_usd,
        concentration_bps=concentration_bps,
        blocker=blocker,
    )


def _active_risk_bps(volatility_bps: Decimal, horizon_seconds: int) -> Decimal:
    horizon = Decimal(str(horizon_seconds or DEFAULT_HORIZON_SECONDS))
    return quantize_bps(volatility_bps * (horizon / Decimal("86400")))


def _concentration_bps(
    symbol_exposure_usd: Decimal,
    max_gross_exposure_usd: Decimal,
) -> Decimal:
    if max_gross_exposure_usd <= Decimal("0"):
        return Decimal("0")
    return quantize_bps(
        (symbol_exposure_usd / max_gross_exposure_usd) * Decimal("10000")
    )


def _first_risk_blocker(
    *,
    vector: FactorVector,
    forecast: AlphaForecast,
    exposure: RiskExposureState,
    limits: RiskLimits,
    liquidity_capacity_usd: Decimal,
) -> str | None:
    checks = (
        (not vector.fresh, vector.freshness_blocker or "stale_factors"),
        (forecast.direction == "hold", forecast.blocker or "forecast_hold"),
        (
            exposure.daily_realized_pnl_usd <= -limits.max_daily_loss_usd,
            "daily_loss_stop",
        ),
        (
            exposure.gross_exposure_usd >= limits.max_gross_exposure_usd,
            "gross_exposure_cap",
        ),
        (
            exposure.symbol_exposure_usd >= limits.max_symbol_exposure_usd,
            "symbol_exposure_cap",
        ),
        (liquidity_capacity_usd <= Decimal("0"), "liquidity_capacity_zero"),
    )
    return next((reason for blocked, reason in checks if blocked), None)
