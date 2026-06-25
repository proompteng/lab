"""Deterministic portfolio construction for the runtime restore path."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal

from .contracts import AlphaForecast, PortfolioTarget, RiskForecast
from .factor_registry import DEFAULT_RISK_BUFFER_BPS


@dataclass(frozen=True)
class PortfolioCostInput:
    """Cost and edge settings for target construction."""

    expected_cost_bps: Decimal
    min_edge_bps: Decimal
    risk_buffer_bps: Decimal = DEFAULT_RISK_BUFFER_BPS


@dataclass(frozen=True)
class PortfolioLimits:
    """Hard notional caps for one deterministic target."""

    min_order_notional_usd: Decimal
    max_order_notional_usd: Decimal
    max_gross_exposure_usd: Decimal
    max_symbol_exposure_usd: Decimal


def build_portfolio_target(
    *,
    forecast: AlphaForecast,
    risk: RiskForecast,
    costs: PortfolioCostInput,
    limits: PortfolioLimits,
) -> PortfolioTarget:
    """Create one clipped target notional for a forecast."""

    required_edge_bps = max(
        costs.min_edge_bps,
        costs.expected_cost_bps + costs.risk_buffer_bps,
    )
    clip_reason = _clip_reason(
        forecast=forecast,
        risk=risk,
        required_edge_bps=required_edge_bps,
        min_order_notional_usd=limits.min_order_notional_usd,
    )
    remaining_gross = limits.max_gross_exposure_usd - risk.gross_exposure_usd
    remaining_symbol = limits.max_symbol_exposure_usd - risk.symbol_exposure_usd
    target_notional = min(
        limits.max_order_notional_usd,
        risk.liquidity_capacity_usd,
        remaining_gross,
        remaining_symbol,
    )
    if target_notional < limits.min_order_notional_usd and clip_reason is None:
        clip_reason = "target_notional_below_min_order"
    if clip_reason is not None:
        target_notional = Decimal("0")
    return PortfolioTarget(
        run_id=forecast.run_id,
        asset=forecast.asset,
        direction=forecast.direction,
        current_notional_usd=risk.symbol_exposure_usd,
        target_notional_usd=target_notional,
        delta_notional_usd=target_notional,
        expected_return_bps=forecast.expected_return_bps,
        expected_cost_bps=costs.expected_cost_bps,
        active_risk_bps=risk.active_risk_bps,
        risk_buffer_bps=costs.risk_buffer_bps,
        clip_reason=clip_reason,
    )


def _clip_reason(
    *,
    forecast: AlphaForecast,
    risk: RiskForecast,
    required_edge_bps: Decimal,
    min_order_notional_usd: Decimal,
) -> str | None:
    if risk.blocker is not None:
        return risk.blocker
    if forecast.blocker is not None and forecast.direction == "hold":
        return forecast.blocker
    if abs(forecast.expected_return_bps) <= required_edge_bps:
        return "expected_edge_not_above_cost"
    if risk.liquidity_capacity_usd < min_order_notional_usd:
        return "liquidity_capacity_below_min_order"
    return None
