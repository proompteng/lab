"""Strict risk gates for Hyperliquid execution v2."""

from __future__ import annotations

from decimal import Decimal

from .config import HyperliquidExecutionConfig
from .models import RiskState, RiskVerdict, Signal, symbol_key


def evaluate_signal_risk(
    signal: Signal,
    state: RiskState,
    config: HyperliquidExecutionConfig,
) -> RiskVerdict:
    """Block stale, duplicate, over-cap, disabled, and excluded orders."""

    reason = _blocked_reason(signal, state, config)
    if reason is not None:
        return RiskVerdict("blocked", reason, Decimal("0"))
    remaining_gross = config.max_gross_exposure_usd - state.gross_exposure_usd
    if remaining_gross < config.min_order_notional_usd:
        return RiskVerdict("blocked", "gross_exposure_cap", Decimal("0"))
    symbol_exposure = state.symbol_exposure_usd_by_coin.get(signal.coin, Decimal("0"))
    remaining_symbol = config.max_symbol_exposure_usd - symbol_exposure
    if remaining_symbol < config.min_order_notional_usd:
        return RiskVerdict("blocked", "symbol_exposure_cap", Decimal("0"))
    order_notional = min(
        config.max_order_notional_usd, remaining_gross, remaining_symbol
    )
    return RiskVerdict("allowed", "allowed", order_notional)


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
        (signal.action == "hold", f"hold:{signal.reason}"),
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
