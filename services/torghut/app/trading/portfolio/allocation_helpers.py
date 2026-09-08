"""Shared portfolio allocation helper functions."""

from __future__ import annotations

from collections.abc import Callable, Iterable, Mapping
from decimal import Decimal
from typing import Any, Optional, cast

from ..fragility import FragilityState
from ..models import StrategyDecision
from ..regime_hmm import resolve_hmm_context


def should_block_new_position(
    max_positions: Optional[int],
    current_count: int,
    current_qty: Decimal,
) -> bool:
    if max_positions is None or max_positions <= 0:
        return False
    if current_qty != 0:
        return False
    return current_count >= max_positions


def count_positions(positions: Iterable[dict[str, Any]]) -> int:
    count = 0
    for position in positions:
        qty = optional_decimal(position.get("qty") or position.get("quantity"))
        if qty is None or qty == 0:
            continue
        count += 1
    return count


def portfolio_exposure(positions: Iterable[dict[str, Any]]) -> tuple[Decimal, Decimal]:
    gross = Decimal("0")
    net = Decimal("0")
    for position in positions:
        value = optional_decimal(position.get("market_value"))
        if value is None:
            continue
        gross += abs(value)
        net += value
    return gross, net


def position_summary(
    symbol: str, positions: Iterable[dict[str, Any]]
) -> tuple[Decimal, Decimal]:
    total_qty = Decimal("0")
    total_value = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = optional_decimal(position.get("qty") or position.get("quantity"))
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
        value = optional_decimal(position.get("market_value"))
        if value is not None:
            total_value += value
    return total_qty, total_value


def position_qty(symbol: str, positions: Iterable[dict[str, Any]]) -> Decimal:
    return position_summary(symbol, positions)[0]


def position_market_value(
    symbol: str,
    positions: Iterable[dict[str, Any]],
) -> Decimal | None:
    total_market_value = Decimal("0")
    has_market_value = False
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        market_value = optional_decimal(position.get("market_value"))
        if market_value is None:
            continue
        total_market_value += market_value
        has_market_value = True
    return total_market_value if has_market_value else None


def projected_position_market_value(
    current_market_value: Decimal | None,
    delta: Decimal,
    decision_price: Decimal | None,
) -> Decimal | None:
    if decision_price is None:
        return current_market_value
    return (current_market_value or Decimal("0")) + (delta * decision_price)


def apply_projected_position_decision(
    positions: list[dict[str, Any]],
    decision: StrategyDecision,
) -> None:
    qty = optional_decimal(decision.qty)
    if qty is None or qty <= 0 or decision.action not in {"buy", "sell"}:
        return
    current_qty = position_qty(decision.symbol, positions)
    current_market_value = position_market_value(decision.symbol, positions)
    delta = qty if decision.action == "buy" else -qty
    projected_qty = current_qty + delta
    projected_market_value = projected_position_market_value(
        current_market_value,
        delta,
        extract_decision_price(decision),
    )
    positions[:] = [
        position for position in positions if position.get("symbol") != decision.symbol
    ]
    if projected_qty == 0:
        return
    projected_position = {
        "symbol": decision.symbol,
        "qty": str(abs(projected_qty)),
        "side": "short" if projected_qty < 0 else "long",
    }
    if projected_market_value is not None:
        projected_position["market_value"] = str(projected_market_value)
    positions.append(projected_position)


def gross_cap_for_symbol(
    max_gross: Optional[Decimal],
    current_gross: Decimal,
    current_value: Decimal,
    action: str,
) -> Optional[Decimal]:
    if max_gross is None or max_gross <= 0:
        return None
    gross_cap_for_symbol = max_gross - (current_gross - abs(current_value))
    if gross_cap_for_symbol <= 0:
        return Decimal("0")
    if action == "buy":
        return gross_cap_for_symbol - current_value
    return gross_cap_for_symbol + current_value


def net_cap_for_trade(
    max_net: Optional[Decimal], current_net: Decimal, action: str
) -> Optional[Decimal]:
    if max_net is None or max_net <= 0:
        return None
    if action == "buy":
        return max_net - current_net
    return max_net + current_net


def apply_caps(
    notional: Decimal,
    caps: dict[str, Optional[Decimal]],
) -> tuple[Decimal, list[str]]:
    methods: list[str] = []
    capped = notional
    for key, value in caps.items():
        if value is None:
            continue
        if value <= 0:
            capped = Decimal("0")
            methods.append(f"cap_{key}_zero")
            continue
        if capped > value:
            capped = value
            methods.append(f"cap_{key}")
    return capped, methods


def capacity_reason_from_methods(
    *,
    applied_methods: list[str],
    reasons: list[str],
) -> Optional[str]:
    for method in reversed(applied_methods):
        if method.startswith("cap_per_symbol"):
            return "symbol_capacity_exhausted"
        if method.startswith("cap_gross_exposure"):
            return "gross_exposure_capacity_exhausted"
        if method.startswith("cap_net_exposure"):
            return "net_exposure_capacity_exhausted"
        if method.startswith("cap_sell_inventory"):
            if "shorts_not_allowed" in reasons:
                return None
            return "sell_inventory_unavailable"
    return None


def remaining_symbol_capacity(
    absolute_cap: Optional[Decimal],
    *,
    current_value: Decimal,
    action: str,
    allow_shorts: bool,
) -> Optional[Decimal]:
    if absolute_cap is None:
        return None
    if action == "buy":
        if current_value >= 0:
            return max(Decimal("0"), absolute_cap - current_value)
        return max(Decimal("0"), absolute_cap + abs(current_value))
    if allow_shorts:
        if current_value <= 0:
            return max(Decimal("0"), absolute_cap - abs(current_value))
        return max(Decimal("0"), current_value + absolute_cap)
    return max(Decimal("0"), current_value)


def extract_decision_price(decision: StrategyDecision) -> Optional[Decimal]:
    for key in ("price", "limit_price", "stop_price"):
        value = decision.params.get(key)
        if value is None:
            value = getattr(decision, key, None)
        if value is not None:
            try:
                return Decimal(str(value))
            except (ArithmeticError, ValueError):
                continue
    return None


def config_payload(config: Any) -> dict[str, Any]:
    return {
        "notional_per_position": decimal_str(config.notional_per_position),
        "volatility_target": decimal_str(config.volatility_target),
        "volatility_floor": decimal_str(config.volatility_floor),
        "max_positions": config.max_positions,
        "max_notional_per_symbol": decimal_str(config.max_notional_per_symbol),
        "max_position_pct_equity": decimal_str(config.max_position_pct_equity),
        "max_gross_exposure": decimal_str(config.max_gross_exposure),
        "max_net_exposure": decimal_str(config.max_net_exposure),
    }


def pct_equity_cap(
    max_pct: Optional[Decimal], equity: Optional[Decimal]
) -> Optional[Decimal]:
    if max_pct is None or equity is None:
        return None
    if max_pct <= 0 or equity <= 0:
        return None
    return equity * max_pct


def min_decimal(*values: Optional[Decimal]) -> Optional[Decimal]:
    result: Optional[Decimal] = None
    for value in values:
        if value is None:
            continue
        if value <= 0:
            continue
        if result is None or value < result:
            result = value
    return result


def optional_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def coerce_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y"}:
            return True
        if normalized in {"false", "0", "no", "n"}:
            return False
    return default


def decimal_str(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def resolve_regime_confidence_multiplier(
    params: Mapping[str, Any],
    *,
    regime_label: str,
    threshold: Decimal,
    low_confidence_multiplier: Decimal,
) -> tuple[Decimal, Optional[Decimal], bool]:
    try:
        context = resolve_hmm_context(params)
    except Exception:
        return Decimal("1"), None, False

    posterior_probabilities: dict[str, Decimal] = {}
    for regime_id, probability in context.posterior.items():
        normalized_regime_id = regime_id.strip().lower()
        if not normalized_regime_id:
            continue
        parsed = optional_decimal(probability)
        if parsed is None:
            continue
        posterior_probabilities[normalized_regime_id] = parsed

    candidates: list[str] = []
    for candidate in (regime_label, context.regime_id):
        if candidate:
            candidates.append(candidate.strip().lower())
    confidence: Optional[Decimal] = None
    for candidate in candidates:
        confidence = posterior_probabilities.get(candidate)
        if confidence is not None:
            break

    if confidence is None:
        return Decimal("1"), None, False

    if confidence < Decimal("0") or confidence > Decimal("1"):
        return Decimal("1"), None, False

    apply_penalty = confidence < threshold and low_confidence_multiplier < Decimal("1")
    if apply_penalty:
        return low_confidence_multiplier, confidence, True
    return Decimal("1"), confidence, False


def normalize_regime_label(value: str | None, *, default: str) -> str:
    if value is None:
        return default
    normalized = value.strip().lower()
    if not normalized:
        return default
    return normalized


def mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        mapped = cast(Mapping[str, Any], value)
        return {str(key): item for key, item in mapped.items()}
    return {}


def decimal_map(
    values: dict[str, float], normalize_key: Callable[[str], str] | None = None
) -> dict[str, Decimal]:
    result: dict[str, Decimal] = {}
    for key in sorted(values):
        value = values[key]
        decimal_value = optional_decimal(value)
        if decimal_value is None:
            continue
        normalized_key = key.strip().lower()
        if normalize_key is not None:
            normalized_key = normalize_key(key)
        if not normalized_key:
            continue
        result[normalized_key] = decimal_value
    return result


def fragility_decimal_map(
    values: Mapping[str, float],
) -> dict[FragilityState, Decimal]:
    result: dict[FragilityState, Decimal] = {}
    for key, value in values.items():
        normalized_key = key.strip().lower()
        if normalized_key not in {"normal", "elevated", "stress", "crisis"}:
            continue
        decimal_value = optional_decimal(value)
        if decimal_value is None:
            continue
        result[cast(FragilityState, normalized_key)] = decimal_value
    return result


def tighten_multiplier(value: Decimal) -> Decimal:
    if value < 0:
        return Decimal("0")
    if value > 1:
        return Decimal("1")
    return value


def is_risk_increasing_trade(action: str, symbol_value: Decimal) -> bool:
    if action == "buy":
        return symbol_value >= 0
    return symbol_value <= 0


def has_fragility_signal(decision: StrategyDecision) -> bool:
    keys = (
        "fragility_state",
        "fragility_score",
        "spread_acceleration",
        "liquidity_compression",
        "crowding_proxy",
        "correlation_concentration",
    )
    params = decision.params

    snapshot_payload = params.get("fragility_snapshot")
    if isinstance(snapshot_payload, Mapping):
        snapshot = cast(Mapping[str, Any], snapshot_payload)
        if any(snapshot.get(key) is not None for key in keys):
            return True

    allocator_payload = params.get("allocator")
    if isinstance(allocator_payload, Mapping):
        allocator = cast(Mapping[str, Any], allocator_payload)
        if allocator.get("fragility_state") is not None:
            return True
        if allocator.get("fragility_score") is not None:
            return True

    return any(params.get(key) is not None for key in keys)


def strategy_weights(
    strategy_signed_qty: tuple[tuple[str, Decimal], ...], action: str
) -> tuple[tuple[str, Decimal], ...]:
    direction = Decimal("1") if action == "buy" else Decimal("-1")
    directional: list[tuple[str, Decimal]] = []
    total = Decimal("0")
    for strategy_id, signed_qty in strategy_signed_qty:
        directional_qty = signed_qty * direction
        if directional_qty <= 0:
            continue
        directional.append((strategy_id, directional_qty))
        total += directional_qty
    if total <= 0:
        return ()
    return tuple(
        (strategy_id, directional_qty / total)
        for strategy_id, directional_qty in directional
    )


def allocator_approved_notional(params: Mapping[str, Any]) -> Optional[Decimal]:
    allocator = params.get("allocator")
    if not isinstance(allocator, Mapping):
        return None
    payload = cast(Mapping[str, Any], allocator)
    value = payload.get("approved_notional")
    if value is None:
        return None
    return optional_decimal(value)


def apply_allocator_regime_multiplier(
    notional: Decimal, params: Mapping[str, Any]
) -> tuple[Decimal, Optional[str]]:
    allocator = params.get("allocator")
    if not isinstance(allocator, Mapping):
        return notional, None
    payload = cast(Mapping[str, Any], allocator)
    enabled = payload.get("enabled")
    if isinstance(enabled, bool) and not enabled:
        return notional, None
    status = payload.get("status")
    if (
        isinstance(status, str)
        and status.strip()
        and status.strip().lower() != "approved"
    ):
        return notional, None
    budget_multiplier = optional_decimal(payload.get("budget_multiplier"))
    capacity_multiplier = optional_decimal(payload.get("capacity_multiplier"))
    multiplier = Decimal("1")
    if budget_multiplier is not None and budget_multiplier > 0:
        multiplier *= budget_multiplier
    if capacity_multiplier is not None and capacity_multiplier > 0:
        multiplier *= capacity_multiplier
    if multiplier == Decimal("1"):
        return notional, None
    return notional * multiplier, "allocator_regime_multiplier"


def cap_by_allocator_approved_notional(
    notional: Decimal, params: Mapping[str, Any]
) -> tuple[Decimal, Optional[str]]:
    approved_notional = allocator_approved_notional(params)
    if approved_notional is None or approved_notional <= 0:
        return notional, None
    if notional > approved_notional:
        return approved_notional, "allocator_approved_notional_cap"
    return notional, None


__all__ = [
    "allocator_approved_notional",
    "apply_allocator_regime_multiplier",
    "apply_caps",
    "cap_by_allocator_approved_notional",
    "capacity_reason_from_methods",
    "coerce_bool",
    "config_payload",
    "count_positions",
    "decimal_map",
    "decimal_str",
    "extract_decision_price",
    "fragility_decimal_map",
    "gross_cap_for_symbol",
    "has_fragility_signal",
    "is_risk_increasing_trade",
    "mapping",
    "min_decimal",
    "net_cap_for_trade",
    "normalize_regime_label",
    "optional_decimal",
    "pct_equity_cap",
    "portfolio_exposure",
    "position_summary",
    "remaining_symbol_capacity",
    "resolve_regime_confidence_multiplier",
    "should_block_new_position",
    "strategy_weights",
    "tighten_multiplier",
]
