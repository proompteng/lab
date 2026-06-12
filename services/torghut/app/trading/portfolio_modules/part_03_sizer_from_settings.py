# pyright: reportMissingImports=false, reportUnknownVariableType=false, reportUnknownMemberType=false, reportUnknownArgumentType=false, reportUnknownParameterType=false, reportUnknownLambdaType=false, reportUnusedImport=false, reportUnusedClass=false, reportUnusedFunction=false, reportUnusedVariable=false, reportUndefinedVariable=false, reportUnsupportedDunderAll=false, reportAttributeAccessIssue=false, reportUntypedBaseClass=false, reportGeneralTypeIssues=false, reportInvalidTypeForm=false, reportReturnType=false, reportOptionalMemberAccess=false, reportArgumentType=false, reportCallIssue=false, reportPrivateUsage=false, reportUnnecessaryComparison=false, reportMissingTypeStubs=false, reportUnnecessaryCast=false
"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import Decimal
from collections.abc import Mapping
from typing import Any, Callable, Iterable, Optional, cast

from ...config import settings
from ...models import Strategy
from ..fragility import (
    FragilityAllocationAdjustment,
    FragilityMonitor,
    FragilityMonitorConfig,
    FragilityState,
)
from ..regime_hmm import resolve_hmm_context
from ..models import StrategyDecision
from ..quantity_rules import (
    min_qty_for_symbol,
    quantize_qty_for_symbol,
    resolve_quantity_resolution,
)

# ruff: noqa: F401,F403,F405,F811,F821

from .part_01_statements_26 import *
from .part_02_portfolioallocator import *


def sizer_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizer:
    return PortfolioSizer(_config_from_settings(strategy, equity))


def allocator_from_settings(equity: Optional[Decimal]) -> PortfolioAllocator:
    max_gross_exposure = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_gross_exposure),
        _pct_equity_cap(
            _optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity),
            equity,
        ),
    )
    correlation_group_caps = dict(settings.trading_allocator_correlation_group_caps)
    symbol_correlation_groups = dict(
        settings.trading_allocator_symbol_correlation_groups
    )
    return PortfolioAllocator(
        AllocationConfig(
            enabled=settings.trading_allocator_enabled,
            default_regime=_normalize_regime_label(
                settings.trading_allocator_default_regime,
                default="neutral",
            ),
            default_budget_multiplier=_optional_decimal(
                settings.trading_allocator_default_budget_multiplier
            )
            or Decimal("1"),
            default_capacity_multiplier=_optional_decimal(
                settings.trading_allocator_default_capacity_multiplier
            )
            or Decimal("1"),
            regime_low_confidence_threshold=_optional_decimal(
                settings.trading_allocator_regime_low_confidence_threshold
            )
            or Decimal("0.6"),
            regime_low_confidence_multiplier=_optional_decimal(
                settings.trading_allocator_regime_low_confidence_multiplier
            )
            or Decimal("0.7"),
            min_multiplier=_optional_decimal(settings.trading_allocator_min_multiplier)
            or Decimal("0"),
            max_multiplier=_optional_decimal(settings.trading_allocator_max_multiplier)
            or Decimal("2"),
            max_symbol_pct_equity=_min_decimal(
                _optional_decimal(settings.trading_allocator_max_symbol_pct_equity),
                _optional_decimal(settings.trading_max_position_pct_equity),
            ),
            max_symbol_notional=_min_decimal(
                _optional_decimal(settings.trading_allocator_max_symbol_notional),
                _optional_decimal(settings.trading_portfolio_max_notional_per_symbol),
            ),
            max_gross_exposure=max_gross_exposure,
            strategy_notional_caps=_decimal_map(
                settings.trading_allocator_strategy_notional_caps
            ),
            symbol_notional_caps=_decimal_map(
                settings.trading_allocator_symbol_notional_caps,
                normalize_key=lambda key: key.strip().upper(),
            ),
            correlation_group_caps=_decimal_map(
                correlation_group_caps,
                normalize_key=lambda key: key.strip().lower(),
            ),
            symbol_correlation_groups={
                str(key).strip().upper(): str(value).strip().lower()
                for key, value in symbol_correlation_groups.items()
                if str(key).strip() and str(value).strip()
            },
            regime_budget_multipliers=_decimal_map(
                settings.trading_allocator_regime_budget_multipliers
            ),
            regime_capacity_multipliers=_decimal_map(
                settings.trading_allocator_regime_capacity_multipliers
            ),
        )
    )


def fragility_monitor_from_settings() -> FragilityMonitor:
    return FragilityMonitor(
        FragilityMonitorConfig(
            mode=settings.trading_fragility_mode,
            unknown_state=settings.trading_fragility_unknown_state,
            elevated_threshold=_optional_decimal(
                settings.trading_fragility_elevated_threshold
            )
            or Decimal("0.35"),
            stress_threshold=_optional_decimal(
                settings.trading_fragility_stress_threshold
            )
            or Decimal("0.55"),
            crisis_threshold=_optional_decimal(
                settings.trading_fragility_crisis_threshold
            )
            or Decimal("0.80"),
            state_budget_multipliers={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_budget_multipliers
                ).items()
            },
            state_capacity_multipliers={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_capacity_multipliers
                ).items()
            },
            state_participation_clamps={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_participation_clamps
                ).items()
            },
            state_abstain_bias={
                key: _tighten_multiplier(value)
                for key, value in _fragility_decimal_map(
                    settings.trading_fragility_state_abstain_bias
                ).items()
            },
        )
    )


def _config_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizingConfig:
    # Keep per-trade max-notional checks in RiskEngine; symbol caps should only
    # come from dedicated portfolio concentration settings.
    max_notional_per_symbol = _optional_decimal(
        settings.trading_portfolio_max_notional_per_symbol
    )
    max_pct_equity = _min_decimal(
        _optional_decimal(strategy.max_position_pct_equity),
        _optional_decimal(settings.trading_max_position_pct_equity),
    )
    gross_cap = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_gross_exposure),
        _pct_equity_cap(
            _optional_decimal(settings.trading_portfolio_max_gross_exposure_pct_equity),
            equity,
        ),
    )
    net_cap = _min_decimal(
        _optional_decimal(settings.trading_portfolio_max_net_exposure),
        _pct_equity_cap(
            _optional_decimal(settings.trading_portfolio_max_net_exposure_pct_equity),
            equity,
        ),
    )
    return PortfolioSizingConfig(
        notional_per_position=_optional_decimal(
            settings.trading_portfolio_notional_per_position
        ),
        volatility_target=_optional_decimal(
            settings.trading_portfolio_volatility_target
        ),
        volatility_floor=_optional_decimal(settings.trading_portfolio_volatility_floor)
        or Decimal("0"),
        max_positions=settings.trading_portfolio_max_positions,
        max_notional_per_symbol=max_notional_per_symbol,
        max_position_pct_equity=max_pct_equity,
        max_gross_exposure=gross_cap,
        max_net_exposure=net_cap,
    )


def _should_block_new_position(
    max_positions: Optional[int],
    current_count: int,
    current_qty: Decimal,
) -> bool:
    if max_positions is None or max_positions <= 0:
        return False
    if current_qty != 0:
        return False
    return current_count >= max_positions


def _count_positions(positions: Iterable[dict[str, Any]]) -> int:
    count = 0
    for position in positions:
        qty = _optional_decimal(position.get("qty") or position.get("quantity"))
        if qty is None or qty == 0:
            continue
        count += 1
    return count


def _portfolio_exposure(positions: Iterable[dict[str, Any]]) -> tuple[Decimal, Decimal]:
    gross = Decimal("0")
    net = Decimal("0")
    for position in positions:
        value = _optional_decimal(position.get("market_value"))
        if value is None:
            continue
        gross += abs(value)
        net += value
    return gross, net


def _position_summary(
    symbol: str, positions: Iterable[dict[str, Any]]
) -> tuple[Decimal, Decimal]:
    total_qty = Decimal("0")
    total_value = Decimal("0")
    for position in positions:
        if position.get("symbol") != symbol:
            continue
        qty = _optional_decimal(position.get("qty") or position.get("quantity"))
        side = str(position.get("side") or "").lower()
        if qty is not None and side == "short":
            qty = -abs(qty)
        if qty is not None:
            total_qty += qty
        value = _optional_decimal(position.get("market_value"))
        if value is not None:
            total_value += value
    return total_qty, total_value


def _gross_cap_for_symbol(
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


def _net_cap_for_trade(
    max_net: Optional[Decimal], current_net: Decimal, action: str
) -> Optional[Decimal]:
    if max_net is None or max_net <= 0:
        return None
    if action == "buy":
        return max_net - current_net
    return max_net + current_net


def _apply_caps(
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


def _capacity_reason_from_methods(
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


def _remaining_symbol_capacity(
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


def _extract_decision_price(decision: StrategyDecision) -> Optional[Decimal]:
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


def _config_payload(config: PortfolioSizingConfig) -> dict[str, Any]:
    return {
        "notional_per_position": _decimal_str(config.notional_per_position),
        "volatility_target": _decimal_str(config.volatility_target),
        "volatility_floor": _decimal_str(config.volatility_floor),
        "max_positions": config.max_positions,
        "max_notional_per_symbol": _decimal_str(config.max_notional_per_symbol),
        "max_position_pct_equity": _decimal_str(config.max_position_pct_equity),
        "max_gross_exposure": _decimal_str(config.max_gross_exposure),
        "max_net_exposure": _decimal_str(config.max_net_exposure),
    }


def _pct_equity_cap(
    max_pct: Optional[Decimal], equity: Optional[Decimal]
) -> Optional[Decimal]:
    if max_pct is None or equity is None:
        return None
    if max_pct <= 0 or equity <= 0:
        return None
    return equity * max_pct


def _min_decimal(*values: Optional[Decimal]) -> Optional[Decimal]:
    result: Optional[Decimal] = None
    for value in values:
        if value is None:
            continue
        if value <= 0:
            continue
        if result is None or value < result:
            result = value
    return result


def _optional_decimal(value: Optional[Decimal | str | float]) -> Optional[Decimal]:
    if value is None:
        return None
    if isinstance(value, Decimal):
        return value
    try:
        return Decimal(str(value))
    except (ArithmeticError, ValueError):
        return None


def _coerce_bool(value: Any, *, default: bool) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"true", "1", "yes", "y"}:
            return True
        if normalized in {"false", "0", "no", "n"}:
            return False
    return default


def _decimal_str(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


def _resolve_regime_confidence_multiplier(
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
        parsed = _optional_decimal(probability)
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


def _normalize_regime_label(value: str | None, *, default: str) -> str:
    if value is None:
        return default
    normalized = value.strip().lower()
    if not normalized:
        return default
    return normalized


def _mapping(value: Any) -> dict[str, Any]:
    if isinstance(value, Mapping):
        mapped = cast(Mapping[str, Any], value)
        return {str(key): item for key, item in mapped.items()}
    return {}


def _decimal_map(
    values: dict[str, float], normalize_key: Callable[[str], str] | None = None
) -> dict[str, Decimal]:
    result: dict[str, Decimal] = {}
    for key in sorted(values):
        value = values[key]
        decimal_value = _optional_decimal(value)
        if decimal_value is None:
            continue
        normalized_key = key.strip().lower()
        if normalize_key is not None:
            normalized_key = normalize_key(key)
        if not normalized_key:
            continue
        result[normalized_key] = decimal_value
    return result


def _fragility_decimal_map(
    values: Mapping[str, float],
) -> dict[FragilityState, Decimal]:
    result: dict[FragilityState, Decimal] = {}
    for key, value in values.items():
        normalized_key = key.strip().lower()
        if normalized_key not in {"normal", "elevated", "stress", "crisis"}:
            continue
        decimal_value = _optional_decimal(value)
        if decimal_value is None:
            continue
        result[cast(FragilityState, normalized_key)] = decimal_value
    return result


def _tighten_multiplier(value: Decimal) -> Decimal:
    if value < 0:
        return Decimal("0")
    if value > 1:
        return Decimal("1")
    return value


def _is_risk_increasing_trade(action: str, symbol_value: Decimal) -> bool:
    if action == "buy":
        return symbol_value >= 0
    return symbol_value <= 0


def _has_fragility_signal(decision: StrategyDecision) -> bool:
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


def _strategy_weights(
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


def _allocator_approved_notional(params: Mapping[str, Any]) -> Optional[Decimal]:
    allocator = params.get("allocator")
    if not isinstance(allocator, Mapping):
        return None
    payload = cast(Mapping[str, Any], allocator)
    value = payload.get("approved_notional")
    if value is None:
        return None
    return _optional_decimal(value)


def _apply_allocator_regime_multiplier(
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
    budget_multiplier = _optional_decimal(payload.get("budget_multiplier"))
    capacity_multiplier = _optional_decimal(payload.get("capacity_multiplier"))
    multiplier = Decimal("1")
    if budget_multiplier is not None and budget_multiplier > 0:
        multiplier *= budget_multiplier
    if capacity_multiplier is not None and capacity_multiplier > 0:
        multiplier *= capacity_multiplier
    if multiplier == Decimal("1"):
        return notional, None
    return notional * multiplier, "allocator_regime_multiplier"


def _cap_by_allocator_approved_notional(
    notional: Decimal, params: Mapping[str, Any]
) -> tuple[Decimal, Optional[str]]:
    approved_notional = _allocator_approved_notional(params)
    if approved_notional is None or approved_notional <= 0:
        return notional, None
    if notional > approved_notional:
        return approved_notional, "allocator_approved_notional_cap"
    return notional, None


__all__ = [
    "ALLOCATOR_CLIP_GROSS_EXPOSURE",
    "ALLOCATOR_CLIP_CORRELATION_CAPACITY",
    "ALLOCATOR_CLIP_SYMBOL_CAPACITY",
    "ALLOCATOR_CLIP_SYMBOL_BUDGET",
    "ALLOCATOR_CLIP_STRATEGY_BUDGET",
    "ALLOCATOR_REJECT_CORRELATION_CAPACITY",
    "ALLOCATOR_REJECT_GROSS_EXPOSURE",
    "ALLOCATOR_REJECT_NO_PRICE",
    "ALLOCATOR_REJECT_QTY_BELOW_MIN",
    "ALLOCATOR_REJECT_SYMBOL_CAPACITY",
    "ALLOCATOR_REJECT_SYMBOL_BUDGET",
    "ALLOCATOR_REJECT_STRATEGY_BUDGET",
    "ALLOCATOR_REJECT_ZERO_QTY",
    "ALLOCATOR_REGIME_LOW_CONFIDENCE",
    "ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL",
    "ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY",
    "ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY",
    "ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED",
    "AggregatedIntent",
    "AllocationConfig",
    "AllocationResult",
    "IntentAggregator",
    "PortfolioAllocator",
    "PortfolioSizingConfig",
    "PortfolioSizingResult",
    "PortfolioSizer",
    "allocator_from_settings",
    "fragility_monitor_from_settings",
    "sizer_from_settings",
]


__all__ = [name for name in globals() if not name.startswith("__")]
