"""Runtime exit helper adapters for aggregated quantity resolution."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal
from typing import Any, Literal, Optional

from ...models import Strategy
from ..models import SignalEnvelope


def _position_qty_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_qty_for_symbol

    return position_qty_for_symbol(positions, symbol)


def _position_avg_entry_price_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import position_avg_entry_price_for_symbol

    return position_avg_entry_price_for_symbol(positions, symbol)


def _signal_spread_bps(*, signal: SignalEnvelope, price: Decimal) -> Decimal | None:
    from .positions_for_strategy_action import signal_spread_bps

    return signal_spread_bps(signal=signal, price=price)


def _volatility_to_bps(volatility: Decimal | None) -> Decimal | None:
    from .positions_for_strategy_action import volatility_to_bps

    return volatility_to_bps(volatility)


def _resolve_bool_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
    default: bool,
) -> bool:
    from .positions_for_strategy_action import resolve_bool_strategy_param

    return resolve_bool_strategy_param(strategies=strategies, key=key, default=default)


def _resolve_max_nonnegative_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import resolve_max_nonnegative_strategy_param

    return resolve_max_nonnegative_strategy_param(strategies=strategies, key=key)


def _resolve_min_positive_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
) -> Optional[Decimal]:
    from .positions_for_strategy_action import resolve_min_positive_strategy_param

    return resolve_min_positive_strategy_param(strategies=strategies, key=key)


def _resolve_dynamic_exit_threshold_bps(
    *,
    strategies: list[Strategy],
    base_bps: Decimal | None,
    spread_bps: Decimal | None,
    spread_multiplier_key: str,
    volatility_bps: Decimal | None,
    volatility_multiplier_key: str,
) -> Decimal | None:
    from .positions_for_strategy_action import resolve_dynamic_exit_threshold_bps

    return resolve_dynamic_exit_threshold_bps(
        strategies=strategies,
        base_bps=base_bps,
        spread_bps=spread_bps,
        spread_multiplier_key=spread_multiplier_key,
        volatility_bps=volatility_bps,
        volatility_multiplier_key=volatility_multiplier_key,
    )


def _reference_exit_price(
    *,
    price: Decimal,
    signal: SignalEnvelope,
    action: str,
) -> Decimal:
    from .positions_for_strategy_action import reference_exit_price

    return reference_exit_price(price=price, signal=signal, action=action)


def _realized_exit_bps(
    *,
    avg_entry_price: Decimal,
    exit_price: Decimal,
    position_side: Literal["long", "short"] = "long",
) -> Decimal:
    from .positions_for_strategy_action import realized_exit_bps

    return realized_exit_bps(
        avg_entry_price=avg_entry_price,
        exit_price=exit_price,
        position_side=position_side,
    )


def _passes_exit_profit_policy(
    *,
    strategies: list[Strategy],
    realized_bps: Decimal,
) -> bool:
    from .positions_for_strategy_action import passes_exit_profit_policy

    return passes_exit_profit_policy(strategies=strategies, realized_bps=realized_bps)


def _treats_sell_as_exit_only(strategy: Strategy) -> bool:
    from .positions_for_strategy_action import treats_sell_as_exit_only

    return treats_sell_as_exit_only(strategy)


def _treats_buy_as_exit_only(strategy: Strategy) -> bool:
    from .positions_for_strategy_action import treats_buy_as_exit_only

    return treats_buy_as_exit_only(strategy)


def _strategy_catalog_runtime_type(strategy: Strategy) -> str:
    from .positions_for_strategy_action import strategy_catalog_runtime_type

    return strategy_catalog_runtime_type(strategy)


def _default_trailing_stop_requires_structure_loss(
    strategies: list[Strategy],
) -> bool:
    from .resolve_runtime_trade_policy import (
        default_trailing_stop_requires_structure_loss,
    )

    return default_trailing_stop_requires_structure_loss(strategies)


def _trailing_stop_structure_loss_confirmed(
    *,
    signal: SignalEnvelope,
    price: Decimal,
    strategies: list[Strategy],
) -> bool:
    from .resolve_runtime_trade_policy import trailing_stop_structure_loss_confirmed

    return trailing_stop_structure_loss_confirmed(
        signal=signal,
        price=price,
        strategies=strategies,
    )


def _position_age_seconds_for_symbol(
    positions: list[dict[str, Any]],
    symbol: str,
    *,
    signal_ts: datetime,
) -> int | None:
    from .resolve_runtime_trade_policy import position_age_seconds_for_symbol

    return position_age_seconds_for_symbol(
        positions,
        symbol,
        signal_ts=signal_ts,
    )


default_trailing_stop_requires_structure_loss = (
    _default_trailing_stop_requires_structure_loss
)
passes_exit_profit_policy = _passes_exit_profit_policy
position_age_seconds_for_symbol = _position_age_seconds_for_symbol
position_avg_entry_price_for_symbol = _position_avg_entry_price_for_symbol
position_qty_for_symbol = _position_qty_for_symbol
realized_exit_bps = _realized_exit_bps
reference_exit_price = _reference_exit_price
resolve_bool_strategy_param = _resolve_bool_strategy_param
resolve_dynamic_exit_threshold_bps = _resolve_dynamic_exit_threshold_bps
resolve_max_nonnegative_strategy_param = _resolve_max_nonnegative_strategy_param
resolve_min_positive_strategy_param = _resolve_min_positive_strategy_param
signal_spread_bps = _signal_spread_bps
strategy_catalog_runtime_type = _strategy_catalog_runtime_type
trailing_stop_structure_loss_confirmed = _trailing_stop_structure_loss_confirmed
treats_buy_as_exit_only = _treats_buy_as_exit_only
treats_sell_as_exit_only = _treats_sell_as_exit_only
volatility_to_bps = _volatility_to_bps


__all__ = [
    "default_trailing_stop_requires_structure_loss",
    "passes_exit_profit_policy",
    "position_age_seconds_for_symbol",
    "position_avg_entry_price_for_symbol",
    "position_qty_for_symbol",
    "realized_exit_bps",
    "reference_exit_price",
    "resolve_bool_strategy_param",
    "resolve_dynamic_exit_threshold_bps",
    "resolve_max_nonnegative_strategy_param",
    "resolve_min_positive_strategy_param",
    "signal_spread_bps",
    "strategy_catalog_runtime_type",
    "trailing_stop_structure_loss_confirmed",
    "treats_buy_as_exit_only",
    "treats_sell_as_exit_only",
    "volatility_to_bps",
]
