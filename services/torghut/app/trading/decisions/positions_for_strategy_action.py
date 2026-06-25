"""Trading decision engine based on TA signals."""

from __future__ import annotations

from collections.abc import Mapping
from decimal import Decimal
from typing import Any, Literal, Optional

from ...config import settings
from ...models import Strategy
from ...strategies.catalog import extract_catalog_metadata
from ..features import (
    SignalFeatures,
    optional_decimal,
)
from ..models import SignalEnvelope
from ..strategy_runtime import (
    StrategyRuntime,
)


from .shared_context import (
    BUY_EXIT_ONLY_STRATEGY_TYPES,
    SELL_EXIT_ONLY_STRATEGY_TYPES,
)
from .resolve_qty_for_aggregated import (
    blocks_same_direction_reentry,
)


def positions_for_strategy_action(
    positions: Optional[list[dict[str, Any]]],
    *,
    strategy_id: str,
    action: str,
    runtime_exit_side: Literal["long", "short"] | None = None,
) -> Optional[list[dict[str, Any]]]:
    if not positions:
        return positions
    tagged_positions = [
        dict(position)
        for position in positions
        if str(position.get("strategy_id") or "").strip() == strategy_id
    ]
    if runtime_exit_side is not None or action.strip().lower() == "sell":
        return actual_positions_only(tagged_positions)
    if tagged_positions:
        return tagged_positions
    return []


def is_pending_entry_position(position: Mapping[str, Any]) -> bool:
    return bool(position.get("pending_entry"))


def actual_positions_only(
    positions: Optional[list[dict[str, Any]]],
) -> Optional[list[dict[str, Any]]]:
    if not positions:
        return positions
    return [
        dict(position)
        for position in positions
        if not is_pending_entry_position(position)
    ]


def treats_sell_as_exit_only(strategy: Strategy) -> bool:
    return strategy_exit_semantics_type(strategy) in SELL_EXIT_ONLY_STRATEGY_TYPES


def treats_buy_as_exit_only(strategy: Strategy) -> bool:
    return strategy_exit_semantics_type(strategy) in BUY_EXIT_ONLY_STRATEGY_TYPES


def strategy_exit_semantics_type(strategy: Strategy) -> str:
    runtime_type = strategy_catalog_runtime_type(strategy)
    if runtime_type in SELL_EXIT_ONLY_STRATEGY_TYPES | BUY_EXIT_ONLY_STRATEGY_TYPES:
        return runtime_type

    universe_type = str(strategy.universe_type or "").strip().lower()
    if universe_type in (SELL_EXIT_ONLY_STRATEGY_TYPES | BUY_EXIT_ONLY_STRATEGY_TYPES):
        return universe_type
    return runtime_type


def strategy_catalog_runtime_type(strategy: Strategy) -> str:
    metadata = extract_catalog_metadata(
        str(strategy.description) if strategy.description is not None else None
    )
    metadata_type = str(metadata.get("strategy_type") or "").strip().lower()
    if metadata_type:
        return metadata_type
    universe_type = str(strategy.universe_type or "").strip().lower()
    if universe_type in {"static", "legacy_macd_rsi"}:
        return "legacy_macd_rsi"
    if universe_type in {"intraday_tsmom", "intraday_tsmom_v1", "tsmom_intraday"}:
        return "intraday_tsmom_v1"
    return universe_type


def blocks_same_direction_reentry_any(strategies: list[Strategy]) -> bool:
    return any(blocks_same_direction_reentry(strategy) for strategy in strategies)


def treats_sell_as_exit_only_any(strategies: list[Strategy]) -> bool:
    return any(treats_sell_as_exit_only(strategy) for strategy in strategies)


def treats_buy_as_exit_only_any(strategies: list[Strategy]) -> bool:
    return any(treats_buy_as_exit_only(strategy) for strategy in strategies)


def is_entry_action_for_strategies(*, strategies: list[Strategy], action: str) -> bool:
    normalized_action = action.strip().lower()
    if normalized_action == "buy":
        return not treats_buy_as_exit_only_any(strategies)
    if normalized_action == "sell":
        return not treats_sell_as_exit_only_any(strategies)
    return False


def is_exit_action_for_strategies(*, strategies: list[Strategy], action: str) -> bool:
    normalized_action = action.strip().lower()
    if normalized_action == "buy":
        return treats_buy_as_exit_only_any(strategies)
    if normalized_action == "sell":
        return treats_sell_as_exit_only_any(strategies)
    return False


def exit_position_side_for_strategies(
    *, strategies: list[Strategy], action: str
) -> Literal["long", "short"] | None:
    normalized_action = action.strip().lower()
    if normalized_action == "sell" and treats_sell_as_exit_only_any(strategies):
        return "long"
    if normalized_action == "buy" and treats_buy_as_exit_only_any(strategies):
        return "short"
    return None


def same_direction_reentry_exists(
    *,
    action: str,
    position_qty: Optional[Decimal],
) -> bool:
    if position_qty is None:
        return False
    if action == "buy":
        return position_qty > 0
    if action == "sell":
        return position_qty < 0
    return False


def cap_requested_qty_by_symbol_cap(
    *,
    action: str,
    requested_qty: Decimal,
    price: Decimal,
    position_qty: Optional[Decimal],
    symbol_notional_cap: Optional[Decimal],
) -> Decimal | None:
    if requested_qty <= 0:
        return Decimal("0")
    if symbol_notional_cap is None or symbol_notional_cap <= 0:
        return None
    if price <= 0 or position_qty is None:
        return None

    cap_qty = symbol_notional_cap / price
    max_requested_qty = max_requested_qty_with_symbol_cap(
        action=action,
        position_qty=position_qty,
        cap_qty=cap_qty,
    )
    return min(requested_qty, max_requested_qty)


def cap_requested_qty_by_portfolio_gross_cap(
    *,
    action: str,
    requested_qty: Decimal,
    price: Decimal,
    positions: Optional[list[dict[str, Any]]],
    portfolio_gross_cap: Optional[Decimal],
) -> Decimal | None:
    if requested_qty <= 0:
        return Decimal("0")
    if action != "buy":
        return None
    if portfolio_gross_cap is None or portfolio_gross_cap <= 0 or price <= 0:
        return None
    current_gross = portfolio_gross_exposure(positions)
    available_notional = portfolio_gross_cap - current_gross
    if available_notional <= 0:
        return Decimal("0")
    cap_qty = available_notional / price
    return min(requested_qty, cap_qty)


def max_requested_qty_with_symbol_cap(
    *,
    action: str,
    position_qty: Decimal,
    cap_qty: Decimal,
) -> Decimal:
    if cap_qty <= 0:
        return Decimal("0")
    if action == "buy":
        if position_qty < 0:
            return abs(position_qty) + cap_qty
        return max(Decimal("0"), cap_qty - position_qty)
    if action == "sell":
        if position_qty > 0:
            return position_qty + cap_qty
        return max(Decimal("0"), cap_qty - abs(position_qty))
    return Decimal("0")


def position_qty_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    if positions is None:
        return None
    normalized_symbol = symbol.strip().upper()
    current_qty = Decimal("0")
    matched = False
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_qty = position.get("qty") or position.get("quantity")
        if raw_qty is None:
            continue
        try:
            qty = Decimal(str(raw_qty))
        except (ArithmeticError, ValueError):
            continue
        side = str(position.get("side") or "").strip().lower()
        if side == "short":
            qty = -abs(qty)
        matched = True
        current_qty += qty
    if not matched:
        return Decimal("0")
    return current_qty


def position_qty_from_payload(position: Mapping[str, Any]) -> Decimal | None:
    raw_qty = position.get("qty") or position.get("quantity")
    if raw_qty is None:
        return None
    try:
        qty = Decimal(str(raw_qty))
    except (ArithmeticError, ValueError):
        return None
    side = str(position.get("side") or "").strip().lower()
    if side == "short":
        qty = -abs(qty)
    return qty


def portfolio_gross_exposure(
    positions: Optional[list[dict[str, Any]]],
) -> Decimal:
    if not positions:
        return Decimal("0")
    gross = Decimal("0")
    for position in positions:
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            gross += abs(Decimal(str(raw_value)))
        except (ArithmeticError, ValueError):
            continue
    return gross


def position_value_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    if positions is None:
        return None
    normalized_symbol = symbol.strip().upper()
    current_value = Decimal("0")
    matched = False
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_value = (
            position.get("market_value")
            or position.get("current_value")
            or position.get("notional")
        )
        if raw_value is None:
            continue
        try:
            value = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        matched = True
        current_value += abs(value)
    if not matched:
        return None
    return current_value


def position_avg_entry_price_for_symbol(
    positions: Optional[list[dict[str, Any]]],
    symbol: str,
) -> Optional[Decimal]:
    if positions is None:
        return None
    normalized_symbol = symbol.strip().upper()
    for position in positions:
        if str(position.get("symbol") or "").strip().upper() != normalized_symbol:
            continue
        raw_value = position.get("avg_entry_price") or position.get(
            "average_entry_price"
        )
        if raw_value is None:
            continue
        try:
            return Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
    return None


def resolve_min_positive_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
) -> Optional[Decimal]:
    values: list[Decimal] = []
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        raw_value = params.get(key)
        if raw_value is None:
            continue
        try:
            resolved = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        if resolved > 0:
            values.append(resolved)
    if not values:
        return None
    return min(values)


def resolve_max_nonnegative_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
) -> Optional[Decimal]:
    values: list[Decimal] = []
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        raw_value = params.get(key)
        if raw_value is None:
            continue
        try:
            resolved = Decimal(str(raw_value))
        except (ArithmeticError, ValueError):
            continue
        if resolved >= 0:
            values.append(resolved)
    if not values:
        return None
    return max(values)


def resolve_dynamic_exit_threshold_bps(
    *,
    strategies: list[Strategy],
    base_bps: Decimal | None,
    spread_bps: Decimal | None,
    spread_multiplier_key: str,
    volatility_bps: Decimal | None,
    volatility_multiplier_key: str,
) -> Decimal | None:
    if base_bps is None or base_bps <= 0:
        return None
    threshold_bps = base_bps
    spread_multiplier = resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key=spread_multiplier_key,
    )
    if (
        spread_bps is not None
        and spread_bps > 0
        and spread_multiplier is not None
        and spread_multiplier > 0
    ):
        threshold_bps += spread_bps * spread_multiplier
    volatility_multiplier = resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key=volatility_multiplier_key,
    )
    if (
        volatility_bps is not None
        and volatility_bps > 0
        and volatility_multiplier is not None
        and volatility_multiplier > 0
    ):
        threshold_bps += volatility_bps * volatility_multiplier
    return threshold_bps


def volatility_to_bps(volatility: Decimal | None) -> Decimal | None:
    if volatility is None or volatility <= 0:
        return None
    return volatility * Decimal("10000")


def signal_spread(signal: SignalEnvelope) -> Decimal | None:
    from .resolve_runtime_trade_policy import signal_spread as owned

    return owned(signal)


def near_touch_exit_price(
    price: Decimal,
    spread: Decimal | None,
    action: str,
) -> Decimal:
    from .resolve_runtime_trade_policy import near_touch_exit_price as owned

    return owned(price, spread, action)


def _bool_param(value: Any) -> bool | None:
    if value is None:
        return None
    normalized = str(value).strip().lower()
    if normalized in {"1", "true", "t", "yes", "y", "on"}:
        return True
    if normalized in {"0", "false", "f", "no", "n", "off"}:
        return False
    return None


def signal_spread_bps(
    *,
    signal: SignalEnvelope,
    price: Decimal,
) -> Decimal | None:
    spread = signal_spread(signal)
    if spread is None or spread <= 0 or price <= 0:
        return None
    return (spread / price) * Decimal("10000")


def reference_exit_price(
    *,
    price: Decimal,
    signal: SignalEnvelope,
    action: str,
) -> Decimal:
    if settings.trading_execution_prefer_limit:
        return near_touch_exit_price(
            price,
            signal_spread(signal),
            action,
        )
    return price


def realized_exit_bps(
    *,
    avg_entry_price: Decimal,
    exit_price: Decimal,
    position_side: Literal["long", "short"] = "long",
) -> Decimal:
    if position_side == "short":
        return ((avg_entry_price - exit_price) / avg_entry_price) * Decimal("10000")
    return ((exit_price - avg_entry_price) / avg_entry_price) * Decimal("10000")


def passes_exit_profit_policy(
    *,
    strategies: list[Strategy],
    realized_bps: Decimal,
) -> bool:
    if (
        resolve_bool_strategy_param(
            strategies=strategies,
            key="require_positive_price_for_signal_exit",
            default=True,
        )
        and realized_bps <= 0
    ):
        return False

    min_profit_bps = resolve_max_nonnegative_strategy_param(
        strategies=strategies,
        key="min_signal_exit_profit_bps",
    )
    if min_profit_bps is not None and realized_bps < min_profit_bps:
        return False
    return True


def resolve_bool_strategy_param(
    *,
    strategies: list[Strategy],
    key: str,
    default: bool,
) -> bool:
    resolved_any = False
    resolved = False
    for strategy in strategies:
        params = StrategyRuntime.definition_from_strategy(strategy).params
        value = _bool_param(params.get(key))
        if value is None:
            continue
        resolved_any = True
        resolved = resolved or value
    return resolved if resolved_any else default


def resolve_symbol_notional_cap(
    *,
    strategy_pcts: list[Optional[Decimal]],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    if equity is None or equity <= 0:
        return None
    caps: list[Decimal] = []
    global_pct = optional_decimal(settings.trading_max_position_pct_equity)
    if global_pct is not None and global_pct > 0:
        caps.append(equity * global_pct)
    for pct in strategy_pcts:
        if pct is not None and pct > 0:
            caps.append(equity * pct)
    if not caps:
        return None
    return min(caps)


def resolve_portfolio_gross_cap(
    *,
    strategies: list[Strategy],
    equity: Optional[Decimal],
) -> Optional[Decimal]:
    caps: list[Decimal] = []
    absolute_cap = optional_decimal(settings.trading_portfolio_max_gross_exposure)
    if absolute_cap is not None and absolute_cap > 0:
        caps.append(absolute_cap)
    if equity is not None and equity > 0:
        global_pct = optional_decimal(
            settings.trading_portfolio_max_gross_exposure_pct_equity
        )
        if global_pct is not None and global_pct > 0:
            caps.append(equity * global_pct)
        strategy_pct = resolve_min_positive_strategy_param(
            strategies=strategies,
            key="max_gross_exposure_pct_equity",
        )
        if strategy_pct is not None and strategy_pct > 0:
            caps.append(equity * strategy_pct)
    strategy_absolute = resolve_min_positive_strategy_param(
        strategies=strategies,
        key="max_gross_exposure",
    )
    if strategy_absolute is not None and strategy_absolute > 0:
        caps.append(strategy_absolute)
    if not caps:
        return None
    return min(caps)


def has_legacy_indicator_inputs(features: SignalFeatures) -> bool:
    return (
        features.macd is not None
        and features.macd_signal is not None
        and features.rsi is not None
    )


def resolve_legacy_action(
    features: SignalFeatures,
) -> tuple[Literal["buy", "sell"], list[str]] | None:
    if features.macd is None or features.macd_signal is None or features.rsi is None:
        return None
    if features.macd > features.macd_signal and features.rsi < 35:
        return "buy", ["macd_cross_up", "rsi_oversold"]
    if features.macd < features.macd_signal and features.rsi > 65:
        return "sell", ["macd_cross_down", "rsi_overbought"]
    return None


def resolve_aggregated_notional_budget(
    strategies: list[Strategy],
    *,
    equity: Optional[Decimal],
    runtime_target_notional: Decimal | None = None,
) -> Decimal:
    if runtime_target_notional is not None and runtime_target_notional > 0:
        return runtime_target_notional
    total_budget = Decimal("0")
    for strategy in strategies:
        budget = optional_decimal(strategy.max_notional_per_trade)
        if budget is not None and budget > 0:
            total_budget += budget
    if total_budget > 0:
        return total_budget

    global_budget = optional_decimal(settings.trading_max_notional_per_trade)
    if global_budget is not None and global_budget > 0:
        return global_budget

    if equity is None:
        return Decimal("0")
    pct = optional_decimal(settings.trading_max_position_pct_equity)
    if pct is not None and pct > 0:
        return equity * pct
    return Decimal("0")


__all__ = (
    "actual_positions_only",
    "has_legacy_indicator_inputs",
    "position_avg_entry_price_for_symbol",
    "position_qty_for_symbol",
    "position_qty_from_payload",
    "positions_for_strategy_action",
    "resolve_legacy_action",
    "blocks_same_direction_reentry",
    "blocks_same_direction_reentry_any",
    "cap_requested_qty_by_portfolio_gross_cap",
    "cap_requested_qty_by_symbol_cap",
    "exit_position_side_for_strategies",
    "is_entry_action_for_strategies",
    "is_exit_action_for_strategies",
    "is_pending_entry_position",
    "max_requested_qty_with_symbol_cap",
    "passes_exit_profit_policy",
    "portfolio_gross_exposure",
    "position_value_for_symbol",
    "realized_exit_bps",
    "reference_exit_price",
    "resolve_aggregated_notional_budget",
    "resolve_bool_strategy_param",
    "resolve_dynamic_exit_threshold_bps",
    "resolve_max_nonnegative_strategy_param",
    "resolve_min_positive_strategy_param",
    "resolve_portfolio_gross_cap",
    "resolve_symbol_notional_cap",
    "same_direction_reentry_exists",
    "signal_spread_bps",
    "strategy_catalog_runtime_type",
    "strategy_exit_semantics_type",
    "treats_buy_as_exit_only",
    "treats_buy_as_exit_only_any",
    "treats_sell_as_exit_only",
    "treats_sell_as_exit_only_any",
    "volatility_to_bps",
)
