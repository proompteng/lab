"""Execution policy enforcing order placement safety and impact assumptions."""

from __future__ import annotations

from decimal import Decimal, ROUND_HALF_UP
from typing import Any, Iterable, Mapping, Optional, cast

from ..costs import CostModelConfig
from ..models import StrategyDecision
from ..prices import MarketSnapshot, resolve_execution_reference_price


from .policy_types import (
    ADAPTIVE_EXECUTION_SECONDS_MAX,
    ADAPTIVE_EXECUTION_SECONDS_MIN,
    AdaptiveExecutionApplication,
    DEFAULT_EXECUTION_SECONDS,
    HIGH_CONVICTION_BREAKOUT_CONTINUATION_RANK_MIN,
    HIGH_CONVICTION_BREAKOUT_MICROPRICE_BPS_MIN,
    HIGH_CONVICTION_MARKET_SPREAD_BPS_MAX,
    HIGH_CONVICTION_WASHOUT_MICROPRICE_BPS_MIN,
    HIGH_CONVICTION_WASHOUT_REVERSAL_RANK_MIN,
    MICROSTRUCTURE_EXECUTION_SCALE_EPSILON,
    MICROSTRUCTURE_EXECUTION_SCALE_MAX,
    SIZING_LIMITING_CONSTRAINT_REASONS,
)


def should_keep_market_order_for_high_conviction_entry(
    decision: StrategyDecision,
    *,
    price: Decimal | None,
    spread: Decimal | None,
) -> bool:
    entry_context = _high_conviction_entry_context(
        decision=decision,
        price=price,
        spread=spread,
    )
    if entry_context is None:
        return False
    strategy_types, execution_features = entry_context

    continuation_rank = optional_decimal(
        execution_features.get("cross_section_continuation_rank")
    )
    reversal_rank = optional_decimal(
        execution_features.get("cross_section_reversal_rank")
    )
    microprice_bias_bps = optional_decimal(
        execution_features.get("recent_microprice_bias_bps_avg")
    )
    if _is_high_conviction_breakout_entry(
        strategy_types=strategy_types,
        continuation_rank=continuation_rank,
        microprice_bias_bps=microprice_bias_bps,
    ):
        return True
    if _is_high_conviction_washout_entry(
        strategy_types=strategy_types,
        reversal_rank=reversal_rank,
        microprice_bias_bps=microprice_bias_bps,
    ):
        return True
    return _has_microbar_cross_sectional_entry(decision, strategy_types)


def _high_conviction_entry_context(
    *,
    decision: StrategyDecision,
    price: Decimal | None,
    spread: Decimal | None,
) -> tuple[set[str], Mapping[str, Any]] | None:
    if decision.order_type != "market":
        return None
    if decision.params.get("position_exit") is not None:
        return None
    strategy_types = _decision_strategy_runtime_types(decision)
    if not strategy_types:
        return None
    execution_features = _decision_execution_features(decision)
    spread_bps = _decision_spread_bps(
        price=price,
        spread=spread,
        execution_features=execution_features,
    )
    if spread_bps is None or spread_bps > HIGH_CONVICTION_MARKET_SPREAD_BPS_MAX:
        return None
    return strategy_types, execution_features


def _is_high_conviction_breakout_entry(
    *,
    strategy_types: set[str],
    continuation_rank: Decimal | None,
    microprice_bias_bps: Decimal | None,
) -> bool:
    return (
        "breakout_continuation_long_v1" in strategy_types
        and continuation_rank is not None
        and continuation_rank >= HIGH_CONVICTION_BREAKOUT_CONTINUATION_RANK_MIN
        and (
            microprice_bias_bps is None
            or microprice_bias_bps >= HIGH_CONVICTION_BREAKOUT_MICROPRICE_BPS_MIN
        )
    )


def _is_high_conviction_washout_entry(
    *,
    strategy_types: set[str],
    reversal_rank: Decimal | None,
    microprice_bias_bps: Decimal | None,
) -> bool:
    return (
        "washout_rebound_long_v1" in strategy_types
        and reversal_rank is not None
        and reversal_rank >= HIGH_CONVICTION_WASHOUT_REVERSAL_RANK_MIN
        and (
            microprice_bias_bps is None
            or microprice_bias_bps >= HIGH_CONVICTION_WASHOUT_MICROPRICE_BPS_MIN
        )
    )


def _has_microbar_cross_sectional_entry(
    decision: StrategyDecision, strategy_types: set[str]
) -> bool:
    return bool(
        {
            "microbar_cross_sectional_long_v1",
            "microbar_cross_sectional_short_v1",
            "microbar_cross_sectional_pairs_v1",
        }
        & strategy_types
        and {
            "microbar_cross_sectional_entry",
            "microbar_cross_sectional_pair_entry",
        }
        & _decision_rationale_tokens(decision)
    )


def should_keep_market_order_for_pair_runtime_exit(
    decision: StrategyDecision,
    *,
    price: Decimal | None,
    spread: Decimal | None,
) -> bool:
    if decision.order_type != "market":
        return False

    position_exit_raw = decision.params.get("position_exit")
    if not isinstance(position_exit_raw, Mapping):
        return False
    position_exit = cast(Mapping[str, Any], position_exit_raw)
    if str(position_exit.get("type") or "").strip().lower() != "runtime_signal_exit":
        return False

    strategy_types = _decision_strategy_runtime_types(decision)
    if "microbar_cross_sectional_pairs_v1" not in strategy_types:
        return False
    if "microbar_cross_sectional_pair_exit" not in _decision_rationale_tokens(decision):
        return False

    spread_bps = _decision_spread_bps(
        price=price,
        spread=spread,
        execution_features=_decision_execution_features(decision),
    )
    return (
        spread_bps is not None and spread_bps <= HIGH_CONVICTION_MARKET_SPREAD_BPS_MAX
    )


def _decision_strategy_runtime_types(decision: StrategyDecision) -> set[str]:
    runtime_payload_raw = decision.params.get("strategy_runtime")
    if not isinstance(runtime_payload_raw, Mapping):
        return set()
    runtime_payload = cast(Mapping[str, Any], runtime_payload_raw)
    raw_sources = runtime_payload.get("source_strategy_runtime")
    if not isinstance(raw_sources, list):
        return set()
    raw_sources_list = cast(list[Any], raw_sources)
    source_strategy_runtime: list[Mapping[str, Any]] = []
    for source_item in raw_sources_list:
        if isinstance(source_item, Mapping):
            source_strategy_runtime.append(cast(Mapping[str, Any], source_item))
    strategy_types = {
        str(source_runtime.get("strategy_type") or "").strip()
        for source_runtime in source_strategy_runtime
    }
    strategy_types.discard("")
    return strategy_types


def _decision_execution_features(
    decision: StrategyDecision,
) -> Mapping[str, Any]:
    execution_features_raw = decision.params.get("execution_features")
    if isinstance(execution_features_raw, Mapping):
        return cast(Mapping[str, Any], execution_features_raw)
    return {}


def _decision_spread_bps(
    *,
    price: Decimal | None,
    spread: Decimal | None,
    execution_features: Mapping[str, Any],
) -> Decimal | None:
    spread_bps = optional_decimal(execution_features.get("spread_bps"))
    if (
        spread_bps is None
        and spread is not None
        and spread > 0
        and price is not None
        and price > 0
    ):
        spread_bps = (spread / price) * Decimal("10000")
    return spread_bps


def _decision_rationale_tokens(decision: StrategyDecision) -> set[str]:
    return {
        token.strip().lower()
        for token in str(decision.rationale or "").split(",")
        if token.strip()
    }


def near_touch_limit_price(
    price: Decimal, spread: Optional[Decimal], action: str
) -> Decimal:
    if spread is None or spread <= 0:
        return normalize_price_for_trading(price)
    half_spread = spread / Decimal("2")
    if action == "buy":
        return normalize_price_for_trading(price + half_spread)
    return normalize_price_for_trading(price - half_spread)


def normalize_price_for_trading(price: Decimal) -> Decimal:
    """Align broker-facing prices to common US-equity tick sizes.

    This keeps order pricing deterministic and avoids sub-penny rejects from
    downstream execution adapters.
    """

    tick_size = _tick_size_for_price(price)
    return price.quantize(tick_size, rounding=ROUND_HALF_UP)


def _tick_size_for_price(price: Decimal) -> Decimal:
    if price.copy_abs() < Decimal("1"):
        return Decimal("0.0001")
    return Decimal("0.01")


def build_impact_inputs(
    decision: StrategyDecision,
    market_snapshot: Optional[MarketSnapshot],
    *,
    execution_seconds_scale: Decimal | None = None,
    default_execution_seconds: int = DEFAULT_EXECUTION_SECONDS,
) -> dict[str, Any]:
    resolved_price = resolve_price(decision, market_snapshot)
    price = resolved_price if resolved_price is not None else Decimal("0")
    spread = optional_decimal(decision.params.get("spread"))
    if spread is None and market_snapshot is not None:
        spread = market_snapshot.spread
    volatility = optional_decimal(decision.params.get("volatility"))
    adv = optional_decimal(
        decision.params.get("adv")
        or decision.params.get("avg_dollar_volume")
        or decision.params.get("avg_daily_dollar_volume")
        or decision.params.get("average_daily_volume")
    )
    execution_seconds = decision.params.get("execution_seconds")
    if execution_seconds is None:
        execution_seconds = default_execution_seconds
    try:
        execution_seconds = int(execution_seconds)
    except (TypeError, ValueError):
        execution_seconds = default_execution_seconds

    if execution_seconds_scale is not None and execution_seconds_scale > 0:
        scaled = int(round(float(execution_seconds) * float(execution_seconds_scale)))
        execution_seconds = min(
            ADAPTIVE_EXECUTION_SECONDS_MAX, max(ADAPTIVE_EXECUTION_SECONDS_MIN, scaled)
        )

    return {
        "price": price,
        "price_present": resolved_price is not None,
        "spread": spread,
        "volatility": volatility,
        "adv": adv,
        "execution_seconds": execution_seconds,
    }


def combined_execution_seconds_scale(
    *,
    adaptive_application: AdaptiveExecutionApplication | None,
    microstructure_execution_scale: Decimal,
) -> Decimal | None:
    execution_scale = Decimal("1")
    if adaptive_application is not None and adaptive_application.applied:
        execution_scale *= adaptive_application.decision.execution_seconds_scale
    execution_scale *= microstructure_execution_scale
    if execution_scale <= 0:
        execution_scale = MICROSTRUCTURE_EXECUTION_SCALE_EPSILON
    if execution_scale < MICROSTRUCTURE_EXECUTION_SCALE_EPSILON:
        execution_scale = MICROSTRUCTURE_EXECUTION_SCALE_EPSILON
    execution_scale = min(MICROSTRUCTURE_EXECUTION_SCALE_MAX, execution_scale)
    if execution_scale == 1:
        return None
    return execution_scale


def build_impact_assumptions(
    *,
    estimate: Any,
    config: CostModelConfig,
    max_participation: Decimal,
    execution_seconds: int,
    impact_inputs: dict[str, Any],
) -> dict[str, Any]:
    price = impact_inputs.get("price")
    price_present = impact_inputs.get("price_present")
    adv = impact_inputs.get("adv")
    spread = impact_inputs.get("spread")
    volatility = impact_inputs.get("volatility")
    return {
        "inputs": {
            "price": stringify_decimal(price) if price_present else None,
            "spread": stringify_decimal(spread),
            "volatility": stringify_decimal(volatility),
            "adv": stringify_decimal(adv),
            "execution_seconds": execution_seconds,
        },
        "model": {
            "commission_bps": str(config.commission_bps),
            "commission_per_share": str(config.commission_per_share),
            "min_commission": str(config.min_commission),
            "sec_fee_rate_on_sales": str(config.sec_fee_rate_on_sales),
            "taf_fee_per_share_on_sales": str(config.taf_fee_per_share_on_sales),
            "taf_fee_cap_per_trade": str(config.taf_fee_cap_per_trade),
            "cat_fee_per_share": str(config.cat_fee_per_share),
            "regulatory_fee_rounding_increment": str(
                config.regulatory_fee_rounding_increment
            ),
            "max_participation_rate": str(max_participation),
            "impact_bps_at_full_participation": str(
                config.impact_bps_at_full_participation
            ),
            "impact_participation_exponent": str(config.impact_participation_exponent),
        },
        "estimate": {
            "notional": str(estimate.notional),
            "spread_cost_bps": str(estimate.spread_cost_bps),
            "volatility_cost_bps": str(estimate.volatility_cost_bps),
            "impact_cost_bps": str(estimate.impact_cost_bps),
            "commission_cost_bps": str(estimate.commission_cost_bps),
            "sec_fee_cost": str(estimate.sec_fee_cost),
            "taf_fee_cost": str(estimate.taf_fee_cost),
            "cat_fee_cost": str(estimate.cat_fee_cost),
            "regulatory_fee_cost": str(estimate.regulatory_fee_cost),
            "regulatory_fee_cost_bps": str(estimate.regulatory_fee_cost_bps),
            "total_cost_bps": str(estimate.total_cost_bps),
            "participation_rate": stringify_decimal(estimate.participation_rate),
            "capacity_ok": estimate.capacity_ok,
            "warnings": list(estimate.warnings),
        },
    }


def resolve_price(
    decision: StrategyDecision, market_snapshot: Optional[MarketSnapshot]
) -> Optional[Decimal]:
    return resolve_execution_reference_price(
        params=decision.params,
        limit_price=decision.limit_price,
        stop_price=decision.stop_price,
        market_snapshot=market_snapshot,
    )


def position_summary(symbol: str, positions: Iterable[dict[str, Any]]) -> Decimal:
    normalized_symbol = symbol.strip().upper()
    total_qty = Decimal("0")
    for position in positions:
        position_symbol = str(position.get("symbol") or "").strip().upper()
        if position_symbol != normalized_symbol:
            continue
        qty = optional_decimal(position.get("qty")) or optional_decimal(
            position.get("quantity")
        )
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
    return total_qty


def is_short_increasing(
    decision: StrategyDecision, positions: Iterable[dict[str, Any]]
) -> bool:
    if decision.action == "buy":
        return False
    qty = optional_decimal(decision.qty)
    if qty is None:
        return False
    position_qty = position_summary(decision.symbol, positions)
    if position_qty <= 0:
        return True
    return qty > position_qty


def is_position_reducing(
    decision: StrategyDecision,
    position_qty: Decimal,
) -> bool:
    qty = optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return False
    if decision.action == "sell" and position_qty > 0:
        return qty <= position_qty
    if decision.action == "buy" and position_qty < 0:
        return qty <= abs(position_qty)
    return False


def prechecked_reducing_position_qty(decision: StrategyDecision) -> Decimal | None:
    if decision.action.strip().lower() != "sell":
        return None
    qty = optional_decimal(decision.qty)
    if qty is None or qty <= 0:
        return None
    for key in ("execution", "execution_precheck"):
        section = decision.params.get(key)
        if not isinstance(section, Mapping):
            continue
        section_map = cast(Mapping[str, Any], section)
        resolution = section_map.get("quantity_resolution")
        if not isinstance(resolution, Mapping):
            continue
        resolution_map = cast(Mapping[str, Any], resolution)
        if not _quantity_resolution_matches_decision(
            decision=decision,
            resolution=resolution_map,
        ):
            continue
        position_qty = optional_decimal(resolution_map.get("position_qty"))
        if position_qty is None or position_qty <= 0 or qty > position_qty:
            continue
        reason = str(resolution_map.get("reason") or "").strip().lower()
        short_increasing = _coerce_optional_bool(resolution_map.get("short_increasing"))
        if short_increasing is False and reason.startswith("sell_reducing_"):
            return position_qty
    return None


def _quantity_resolution_matches_decision(
    *,
    decision: StrategyDecision,
    resolution: Mapping[str, Any],
) -> bool:
    symbol = str(resolution.get("symbol") or "").strip().upper()
    if symbol and symbol != decision.symbol.strip().upper():
        return False
    action = str(resolution.get("action") or "").strip().lower()
    if action and action != decision.action.strip().lower():
        return False
    requested_qty = optional_decimal(resolution.get("requested_qty"))
    decision_qty = optional_decimal(decision.qty)
    if (
        requested_qty is not None
        and decision_qty is not None
        and requested_qty < decision_qty
    ):
        return False
    return True


def _coerce_optional_bool(value: Any) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "on"}:
            return True
        if normalized in {"false", "0", "no", "off"}:
            return False
    return None


def optional_decimal(value: Any) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError, TypeError):
        return None


def allocator_payload(decision: StrategyDecision) -> dict[str, object]:
    raw = decision.params.get("allocator")
    if not isinstance(raw, dict):
        return {}
    payload = cast(dict[object, object], raw)
    return {str(key): value for key, value in payload.items()}


def resolve_qty_below_min_reason(decision: StrategyDecision) -> str:
    portfolio_sizing = decision.params.get("portfolio_sizing")
    if not isinstance(portfolio_sizing, dict):
        return "qty_below_min"
    output = cast(dict[object, object], portfolio_sizing).get("output")
    if not isinstance(output, dict):
        return "qty_below_min"
    limiting_constraint = cast(dict[object, object], output).get("limiting_constraint")
    if not isinstance(limiting_constraint, str):
        return "qty_below_min"
    normalized = limiting_constraint.strip()
    if normalized in SIZING_LIMITING_CONSTRAINT_REASONS:
        return normalized
    return "qty_below_min"


def stringify_decimal(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


__all__ = [
    "near_touch_limit_price",
    "should_keep_market_order_for_high_conviction_entry",
]
