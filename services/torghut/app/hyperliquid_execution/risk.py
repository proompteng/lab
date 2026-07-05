"""Strict risk gates for Hyperliquid execution v2."""

from __future__ import annotations

from dataclasses import replace
from decimal import Decimal

from app.trading.multifactor.contracts import PortfolioTarget, RiskForecast
from app.trading.multifactor.cost_model import estimate_transaction_cost
from app.trading.multifactor.portfolio_construction import (
    PortfolioCostInput,
    PortfolioLimits,
    build_portfolio_target,
)
from app.trading.multifactor.risk_model import (
    RiskExposureState,
    RiskLimits,
    build_risk_forecast,
)

from .config import HyperliquidExecutionConfig
from .margin import MarginBudget, resolve_margin_budget
from .models import RiskState, RiskVerdict, Signal, symbol_key


def evaluate_signal_risk(
    signal: Signal,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> RiskVerdict:
    """Block stale, duplicate, over-cap, disabled, and excluded orders."""

    multifactor = _multifactor_controls(signal, state, config)
    reason = _blocked_reason(signal, state, config)
    if reason is not None:
        return _blocked_verdict(reason, multifactor)
    margin_budget, margin_blocker = _allowed_margin_budget(signal, state, config)
    if margin_blocker is not None:
        return _blocked_verdict(margin_blocker, multifactor)
    assert margin_budget is not None
    if multifactor is not None:
        risk_forecast, portfolio_target = multifactor
        if not portfolio_target.executable:
            return RiskVerdict(
                "blocked",
                portfolio_target.clip_reason or "portfolio_target_blocked",
                Decimal("0"),
                risk_forecast,
                portfolio_target,
            )
        order_notional = min(
            portfolio_target.delta_notional_usd,
            margin_budget.order_notional_capacity_usd,
        )
        if order_notional < config.min_order_notional_usd:
            return RiskVerdict(
                "blocked",
                "target_notional_below_min_order",
                Decimal("0"),
                risk_forecast,
                portfolio_target,
            )
        return RiskVerdict(
            "allowed",
            "allowed",
            order_notional,
            risk_forecast,
            portfolio_target,
        )
    return RiskVerdict(
        "allowed",
        "allowed",
        margin_budget.order_notional_capacity_usd,
    )


def _allowed_margin_budget(
    signal: Signal,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> tuple[MarginBudget | None, str | None]:
    margin_budget, margin_blocker = resolve_margin_budget(
        coin=signal.coin,
        state=state,
        config=config,
    )
    if margin_blocker is not None:
        return None, margin_blocker
    if margin_budget is None:
        return None, "margin_budget_unavailable"
    return margin_budget, None


def _multifactor_controls(
    signal: Signal,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> tuple[RiskForecast, PortfolioTarget] | None:
    if signal.factor_vector is None or signal.alpha_forecast is None:
        return None
    symbol_exposure = state.symbol_exposure_usd_by_coin.get(signal.coin, Decimal("0"))
    margin_budget, margin_blocker = resolve_margin_budget(
        coin=signal.coin,
        state=state,
        config=config,
    )
    if margin_budget is None:
        return _blocked_multifactor(signal, state, config, margin_blocker)
    effective_max_gross_exposure = (
        state.gross_exposure_usd
        + margin_budget.remaining_gross_margin_usd * margin_budget.max_leverage
    )
    effective_max_symbol_exposure = (
        symbol_exposure
        + margin_budget.remaining_symbol_margin_usd * margin_budget.max_leverage
    )
    risk_forecast = build_risk_forecast(
        vector=signal.factor_vector,
        forecast=signal.alpha_forecast,
        exposure=RiskExposureState(
            gross_exposure_usd=state.gross_exposure_usd,
            symbol_exposure_usd=symbol_exposure,
            daily_realized_pnl_usd=state.daily_realized_pnl_usd,
        ),
        limits=RiskLimits(
            max_gross_exposure_usd=effective_max_gross_exposure,
            max_symbol_exposure_usd=effective_max_symbol_exposure,
            max_daily_loss_usd=config.max_daily_loss_usd,
        ),
    )
    expected_cost_bps = estimate_transaction_cost(
        signal.factor_vector,
        cost_buffer_bps=config.cost_buffer_bps,
        participation_rate=Decimal("0.001"),
    )
    portfolio_target = build_portfolio_target(
        forecast=signal.alpha_forecast,
        risk=risk_forecast,
        costs=PortfolioCostInput(
            expected_cost_bps=expected_cost_bps,
            min_edge_bps=config.min_edge_bps,
        ),
        limits=PortfolioLimits(
            min_order_notional_usd=config.min_order_notional_usd,
            max_order_notional_usd=margin_budget.order_notional_capacity_usd,
            max_gross_exposure_usd=effective_max_gross_exposure,
            max_symbol_exposure_usd=effective_max_symbol_exposure,
        ),
    )
    return risk_forecast, portfolio_target


def _blocked_multifactor(
    signal: Signal,
    state: RiskState,
    config: HyperliquidExecutionConfig,
    reason: str | None,
) -> tuple[RiskForecast, PortfolioTarget]:
    if signal.factor_vector is None or signal.alpha_forecast is None:
        raise ValueError("blocked_multifactor_requires_factor_signal")
    symbol_exposure = state.symbol_exposure_usd_by_coin.get(signal.coin, Decimal("0"))
    risk_forecast = build_risk_forecast(
        vector=signal.factor_vector,
        forecast=signal.alpha_forecast,
        exposure=RiskExposureState(
            gross_exposure_usd=state.gross_exposure_usd,
            symbol_exposure_usd=symbol_exposure,
            daily_realized_pnl_usd=state.daily_realized_pnl_usd,
        ),
        limits=RiskLimits(
            max_gross_exposure_usd=state.gross_exposure_usd,
            max_symbol_exposure_usd=symbol_exposure,
            max_daily_loss_usd=config.max_daily_loss_usd,
        ),
    )
    blocked_risk = replace(risk_forecast, blocker=reason or "margin_budget_unavailable")
    target = PortfolioTarget(
        run_id=signal.alpha_forecast.run_id,
        asset=signal.alpha_forecast.asset,
        direction=signal.alpha_forecast.direction,
        current_notional_usd=symbol_exposure,
        target_notional_usd=Decimal("0"),
        delta_notional_usd=Decimal("0"),
        expected_return_bps=signal.alpha_forecast.expected_return_bps,
        expected_cost_bps=Decimal("0"),
        active_risk_bps=blocked_risk.active_risk_bps,
        risk_buffer_bps=Decimal("0"),
        clip_reason=blocked_risk.blocker,
    )
    return blocked_risk, target


def _blocked_verdict(
    reason: str,
    multifactor: tuple[RiskForecast, PortfolioTarget] | None,
) -> RiskVerdict:
    if multifactor is None:
        return RiskVerdict("blocked", reason, Decimal("0"))
    risk_forecast, portfolio_target = multifactor
    blocked_target = portfolio_target
    if getattr(portfolio_target, "clip_reason", None) is None:
        blocked_target = replace(
            portfolio_target,
            target_notional_usd=Decimal("0"),
            delta_notional_usd=Decimal("0"),
            clip_reason=reason,
        )
    return RiskVerdict(
        "blocked",
        reason,
        Decimal("0"),
        risk_forecast,
        blocked_target,
    )


def _blocked_reason(
    signal: Signal,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> str | None:
    config_errors = config.validation_errors()
    dependency_blockers = sorted(
        dependency.name for dependency in state.dependencies if not dependency.ready
    )
    excluded_symbols = {symbol_key(coin) for coin in config.excluded_coins}
    checks = (
        (bool(config_errors), ",".join(config_errors)),
        (not state.trading_enabled, "trading_disabled"),
        (
            signal.action == "hold" and signal.alpha_forecast is None,
            f"hold:{signal.reason}",
        ),
        (
            signal.action == "sell" and not config.allow_short_entries,
            "short_entries_disabled",
        ),
        (
            signal.feature.source_lag_seconds > config.signal_staleness_seconds,
            "stale_features",
        ),
        (signal.feature.bid_price is None, "missing_bid"),
        (signal.feature.ask_price is None, "missing_ask"),
        (symbol_key(signal.coin) in excluded_symbols, "coin_excluded"),
        (
            bool(dependency_blockers),
            f"dependency_not_ready:{','.join(dependency_blockers)}",
        ),
        (signal.coin in state.open_order_coins, "open_order_exists_for_symbol"),
        (
            signal.coin in state.cooldown_reason_by_coin,
            state.cooldown_reason_by_coin.get(signal.coin, "symbol_cooldown"),
        ),
        (state.daily_realized_pnl_usd <= -config.max_daily_loss_usd, "daily_loss_stop"),
    )
    return next((reason for blocked, reason in checks if blocked), None)
