"""Deterministic portfolio sizing helpers."""

from __future__ import annotations

from dataclasses import dataclass
from decimal import ROUND_DOWN, Decimal
from collections.abc import Mapping
from typing import Any, Iterable, Optional, cast

from ..config import settings
from ..models import Strategy
from .models import StrategyDecision

ALLOCATOR_REJECT_NO_PRICE = "allocator_reject_no_price"
ALLOCATOR_REJECT_ZERO_QTY = "allocator_reject_zero_qty"
ALLOCATOR_REJECT_SYMBOL_CAPACITY = "allocator_reject_symbol_capacity"
ALLOCATOR_REJECT_GROSS_EXPOSURE = "allocator_reject_gross_exposure"
ALLOCATOR_REJECT_QTY_BELOW_MIN = "allocator_reject_qty_below_min"
ALLOCATOR_CLIP_SYMBOL_CAPACITY = "allocator_clip_symbol_capacity"
ALLOCATOR_CLIP_GROSS_EXPOSURE = "allocator_clip_gross_exposure"


@dataclass(frozen=True)
class AggregatedIntent:
    decision: StrategyDecision
    source_strategy_ids: tuple[str, ...]
    source_decision_count: int
    had_conflict: bool


@dataclass(frozen=True)
class AllocationConfig:
    enabled: bool
    default_regime: str
    default_budget_multiplier: Decimal
    default_capacity_multiplier: Decimal
    min_multiplier: Decimal
    max_multiplier: Decimal
    max_symbol_pct_equity: Optional[Decimal]
    max_symbol_notional: Optional[Decimal]
    max_gross_exposure: Optional[Decimal]
    regime_budget_multipliers: dict[str, Decimal]
    regime_capacity_multipliers: dict[str, Decimal]


@dataclass(frozen=True)
class AllocationResult:
    decision: StrategyDecision
    approved: bool
    clipped: bool
    reason_codes: tuple[str, ...]
    regime_label: str
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    requested_notional: Optional[Decimal]
    approved_notional: Optional[Decimal]


@dataclass(frozen=True)
class PortfolioSizingConfig:
    notional_per_position: Optional[Decimal]
    volatility_target: Optional[Decimal]
    volatility_floor: Decimal
    max_positions: Optional[int]
    max_notional_per_symbol: Optional[Decimal]
    max_position_pct_equity: Optional[Decimal]
    max_gross_exposure: Optional[Decimal]
    max_net_exposure: Optional[Decimal]


@dataclass(frozen=True)
class PortfolioSizingResult:
    decision: StrategyDecision
    approved: bool
    reasons: list[str]
    audit: dict[str, Any]


class PortfolioSizer:
    """Apply deterministic portfolio sizing rules."""

    def __init__(self, config: PortfolioSizingConfig) -> None:
        self.config = config

    def size(
        self,
        decision: StrategyDecision,
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
    ) -> PortfolioSizingResult:
        price = _extract_decision_price(decision)
        volatility = _optional_decimal(decision.params.get("volatility"))
        equity = _optional_decimal(account.get("equity"))

        current_positions = list(positions)
        current_count = _count_positions(current_positions)
        current_qty, current_value = _position_summary(
            decision.symbol, current_positions
        )
        gross_exposure, net_exposure = _portfolio_exposure(current_positions)

        audit: dict[str, Any] = {
            "inputs": {
                "symbol": decision.symbol,
                "action": decision.action,
                "base_qty": str(decision.qty),
                "price": _decimal_str(price),
                "volatility": _decimal_str(volatility),
                "equity": _decimal_str(equity),
                "current_positions": current_count,
                "current_symbol_qty": _decimal_str(current_qty),
                "current_symbol_value": _decimal_str(current_value),
                "gross_exposure": _decimal_str(gross_exposure),
                "net_exposure": _decimal_str(net_exposure),
            },
            "config": _config_payload(self.config),
            "output": {},
        }

        if price is None or price <= 0:
            audit["output"] = {"status": "skipped", "reason": "missing_price"}
            return PortfolioSizingResult(
                decision=decision, approved=True, reasons=[], audit=audit
            )

        base_notional = price * decision.qty
        notional = self._resolve_base_notional(base_notional)
        if notional is None or notional <= 0:
            audit["output"] = {"status": "skipped", "reason": "missing_notional"}
            return PortfolioSizingResult(
                decision=decision, approved=True, reasons=[], audit=audit
            )

        notional, vol_method = self._apply_volatility_scaling(notional, volatility)
        applied_methods = [method for method in (vol_method,) if method]

        reasons: list[str] = []
        if _should_block_new_position(
            self.config.max_positions, current_count, current_qty
        ):
            reasons.append("max_positions_exceeded")

        caps: dict[str, Optional[Decimal]] = {}
        symbol_cap = _min_decimal(
            self.config.max_notional_per_symbol,
            _pct_equity_cap(self.config.max_position_pct_equity, equity),
        )
        per_symbol_cap = _remaining_symbol_capacity(
            symbol_cap,
            current_value=current_value,
            action=decision.action,
            allow_shorts=settings.trading_allow_shorts,
        )
        if per_symbol_cap is not None:
            caps["per_symbol"] = per_symbol_cap

        if decision.action == "sell" and not settings.trading_allow_shorts:
            if current_qty <= 0:
                reasons.append("shorts_not_allowed")
            caps["sell_inventory"] = max(current_value, Decimal("0"))

        gross_cap = _gross_cap_for_symbol(
            self.config.max_gross_exposure,
            gross_exposure,
            current_value,
            decision.action,
        )
        if gross_cap is not None:
            caps["gross_exposure"] = gross_cap

        net_cap = _net_cap_for_trade(
            self.config.max_net_exposure, net_exposure, decision.action
        )
        if net_cap is not None:
            caps["net_exposure"] = net_cap

        if caps:
            notional, cap_methods = _apply_caps(notional, caps)
            applied_methods.extend(cap_methods)

        qty = (notional / price).quantize(Decimal("1"), rounding=ROUND_DOWN)
        if qty < 1:
            if "shorts_not_allowed" not in reasons:
                reasons.append("qty_below_min")

        approved = len(reasons) == 0
        if not approved:
            qty = Decimal("0")
            notional = Decimal("0")

        audit["output"] = {
            "status": "approved" if approved else "rejected",
            "final_qty": _decimal_str(qty),
            "final_notional": _decimal_str(notional),
            "methods": applied_methods,
            "caps": {key: _decimal_str(value) for key, value in caps.items()},
            "reasons": list(reasons),
        }

        updated_params = dict(decision.params)
        updated_params["portfolio_sizing"] = audit
        updated_decision = decision.model_copy(
            update={"qty": qty, "params": updated_params}
        )
        return PortfolioSizingResult(
            decision=updated_decision, approved=approved, reasons=reasons, audit=audit
        )

    def _resolve_base_notional(self, base_notional: Decimal) -> Optional[Decimal]:
        if (
            self.config.notional_per_position is not None
            and self.config.notional_per_position > 0
        ):
            return self.config.notional_per_position
        return base_notional

    def _apply_volatility_scaling(
        self,
        notional: Decimal,
        volatility: Optional[Decimal],
    ) -> tuple[Decimal, Optional[str]]:
        if self.config.volatility_target is None or self.config.volatility_target <= 0:
            return notional, None
        if volatility is None or volatility <= 0:
            return notional, "volatility_missing"
        effective_vol = max(volatility, self.config.volatility_floor)
        if effective_vol <= 0:
            return notional, "volatility_floor_zero"
        scaled = notional * (self.config.volatility_target / effective_vol)
        return scaled, "volatility_scaled"


class IntentAggregator:
    """Merge per-signal strategy decisions into deterministic symbol-level intents."""

    def aggregate(
        self, decisions: Iterable[StrategyDecision]
    ) -> list[AggregatedIntent]:
        grouped: dict[tuple[str, str, str, str], list[StrategyDecision]] = {}
        for decision in decisions:
            key = (
                decision.symbol,
                decision.timeframe,
                decision.order_type,
                decision.time_in_force,
            )
            grouped.setdefault(key, []).append(decision)

        aggregated: list[AggregatedIntent] = []
        for key in sorted(grouped):
            bucket = sorted(
                grouped[key],
                key=lambda item: (
                    item.strategy_id,
                    item.event_ts.isoformat(),
                    item.action,
                    item.symbol,
                    str(item.qty),
                ),
            )
            if not bucket:
                continue

            buy_qty = sum(
                (item.qty for item in bucket if item.action == "buy"), Decimal("0")
            )
            sell_qty = sum(
                (item.qty for item in bucket if item.action == "sell"), Decimal("0")
            )
            had_conflict = buy_qty > 0 and sell_qty > 0

            if buy_qty == sell_qty:
                # Deterministic tie-break avoids dropping throughput when intents cancel exactly.
                chosen_action = bucket[0].action
                chosen_qty = buy_qty if chosen_action == "buy" else sell_qty
            elif buy_qty > sell_qty:
                chosen_action = "buy"
                chosen_qty = buy_qty - sell_qty
            else:
                chosen_action = "sell"
                chosen_qty = sell_qty - buy_qty

            chosen_qty = chosen_qty.quantize(Decimal("1"), rounding=ROUND_DOWN)
            primary = bucket[0]
            params = dict(primary.params)
            allocator_meta = dict(_mapping(params.get("allocator")))
            allocator_meta.update(
                {
                    "intent_aggregated": True,
                    "intent_conflict_resolved": had_conflict,
                    "source_strategy_ids": [item.strategy_id for item in bucket],
                    "source_decision_count": len(bucket),
                }
            )
            params["allocator"] = allocator_meta

            aggregated_decision = primary.model_copy(
                update={
                    "action": chosen_action,
                    "qty": chosen_qty,
                    "params": params,
                }
            )
            aggregated.append(
                AggregatedIntent(
                    decision=aggregated_decision,
                    source_strategy_ids=tuple(item.strategy_id for item in bucket),
                    source_decision_count=len(bucket),
                    had_conflict=had_conflict,
                )
            )

        return aggregated


class PortfolioAllocator:
    """Apply deterministic concentration/capacity clipping before hard risk checks."""

    def __init__(
        self,
        config: AllocationConfig,
        *,
        intent_aggregator: IntentAggregator | None = None,
    ) -> None:
        self.config = config
        self.intent_aggregator = intent_aggregator or IntentAggregator()

    def allocate(
        self,
        decisions: Iterable[StrategyDecision],
        *,
        account: dict[str, str],
        positions: Iterable[dict[str, Any]],
        regime_label: str | None = None,
    ) -> list[AllocationResult]:
        intents = self.intent_aggregator.aggregate(decisions)
        if not intents:
            return []

        normalized_regime = _normalize_regime_label(
            regime_label, default=self.config.default_regime
        )
        budget_multiplier = self._resolve_multiplier(
            self.config.regime_budget_multipliers,
            normalized_regime,
            self.config.default_budget_multiplier,
        )
        capacity_multiplier = self._resolve_multiplier(
            self.config.regime_capacity_multipliers,
            normalized_regime,
            self.config.default_capacity_multiplier,
        )

        if not self.config.enabled:
            return [
                self._result_from_passthrough(
                    intent.decision,
                    regime_label=normalized_regime,
                    budget_multiplier=budget_multiplier,
                    capacity_multiplier=capacity_multiplier,
                )
                for intent in intents
            ]

        equity = _optional_decimal(account.get("equity"))
        current_positions = list(positions)
        current_gross_exposure, _ = _portfolio_exposure(current_positions)
        approved_gross_delta = Decimal("0")

        results: list[AllocationResult] = []
        for intent in intents:
            decision = intent.decision
            price = _extract_decision_price(decision)
            params = dict(decision.params)
            requested_notional = None if price is None else abs(price * decision.qty)
            reason_codes: list[str] = []
            approved = True
            clipped = False

            if price is None or price <= 0:
                approved = False
                reason_codes.append(ALLOCATOR_REJECT_NO_PRICE)
                approved_notional = Decimal("0")
                adjusted_decision = decision.model_copy(update={"qty": Decimal("0")})
            elif decision.qty <= 0:
                approved = False
                reason_codes.append(ALLOCATOR_REJECT_ZERO_QTY)
                approved_notional = Decimal("0")
                adjusted_decision = decision.model_copy(update={"qty": Decimal("0")})
            else:
                _, symbol_value = _position_summary(decision.symbol, current_positions)
                base_symbol_cap = self._symbol_cap(equity)
                effective_symbol_cap = None
                if base_symbol_cap is not None:
                    effective_symbol_cap = (
                        base_symbol_cap * budget_multiplier * capacity_multiplier
                    )

                gross_cap = self._gross_cap(
                    current_gross_exposure=current_gross_exposure,
                    approved_gross_delta=approved_gross_delta,
                    symbol_value=symbol_value,
                    budget_multiplier=budget_multiplier,
                )

                caps = {
                    ALLOCATOR_CLIP_SYMBOL_CAPACITY: effective_symbol_cap,
                    ALLOCATOR_CLIP_GROSS_EXPOSURE: gross_cap,
                }
                approved_notional = requested_notional or Decimal("0")
                for reason_code, cap in caps.items():
                    if cap is None:
                        continue
                    if cap <= 0:
                        approved_notional = Decimal("0")
                        reason_codes.append(reason_code.replace("_clip_", "_reject_"))
                    elif approved_notional > cap:
                        approved_notional = cap
                        reason_codes.append(reason_code)

                adjusted_qty = (approved_notional / price).quantize(
                    Decimal("1"), rounding=ROUND_DOWN
                )
                if adjusted_qty < 1:
                    approved = False
                    if approved_notional > 0:
                        reason_codes.append(ALLOCATOR_REJECT_QTY_BELOW_MIN)
                    elif (
                        ALLOCATOR_REJECT_SYMBOL_CAPACITY not in reason_codes
                        and ALLOCATOR_REJECT_GROSS_EXPOSURE not in reason_codes
                    ):
                        reason_codes.append(ALLOCATOR_REJECT_SYMBOL_CAPACITY)
                    adjusted_qty = Decimal("0")
                else:
                    if adjusted_qty != decision.qty:
                        clipped = True
                    approved_gross_delta += price * adjusted_qty

                adjusted_decision = decision.model_copy(update={"qty": adjusted_qty})

            allocator_payload = {
                "enabled": self.config.enabled,
                "regime_label": normalized_regime,
                "budget_multiplier": _decimal_str(budget_multiplier),
                "capacity_multiplier": _decimal_str(capacity_multiplier),
                "requested_qty": str(decision.qty),
                "approved_qty": str(adjusted_decision.qty),
                "requested_notional": _decimal_str(requested_notional),
                "approved_notional": _decimal_str(approved_notional),
                "status": "approved" if approved else "rejected",
                "clipped": clipped,
                "reason_codes": sorted(set(reason_codes)),
            }
            current_allocator = dict(_mapping(params.get("allocator")))
            current_allocator.update(allocator_payload)
            params["allocator"] = current_allocator
            adjusted_decision = adjusted_decision.model_copy(update={"params": params})

            results.append(
                AllocationResult(
                    decision=adjusted_decision,
                    approved=approved,
                    clipped=clipped,
                    reason_codes=tuple(sorted(set(reason_codes))),
                    regime_label=normalized_regime,
                    budget_multiplier=budget_multiplier,
                    capacity_multiplier=capacity_multiplier,
                    requested_notional=requested_notional,
                    approved_notional=approved_notional,
                )
            )

        return results

    def _resolve_multiplier(
        self,
        values: dict[str, Decimal],
        regime_label: str,
        default: Decimal,
    ) -> Decimal:
        raw = values.get(regime_label, values.get("default", default))
        return min(self.config.max_multiplier, max(self.config.min_multiplier, raw))

    def _symbol_cap(self, equity: Optional[Decimal]) -> Optional[Decimal]:
        symbol_pct_cap = _pct_equity_cap(self.config.max_symbol_pct_equity, equity)
        return _min_decimal(self.config.max_symbol_notional, symbol_pct_cap)

    def _gross_cap(
        self,
        *,
        current_gross_exposure: Decimal,
        approved_gross_delta: Decimal,
        symbol_value: Decimal,
        budget_multiplier: Decimal,
    ) -> Optional[Decimal]:
        if self.config.max_gross_exposure is None:
            return None
        budget_cap = self.config.max_gross_exposure * budget_multiplier
        available = budget_cap - (
            current_gross_exposure + approved_gross_delta - abs(symbol_value)
        )
        if available <= 0:
            return Decimal("0")
        return available

    @staticmethod
    def _result_from_passthrough(
        decision: StrategyDecision,
        *,
        regime_label: str,
        budget_multiplier: Decimal,
        capacity_multiplier: Decimal,
    ) -> AllocationResult:
        params = dict(decision.params)
        current_allocator = dict(_mapping(params.get("allocator")))
        current_allocator.update(
            {
                "enabled": False,
                "status": "approved",
                "clipped": False,
                "reason_codes": [],
                "regime_label": regime_label,
                "budget_multiplier": _decimal_str(budget_multiplier),
                "capacity_multiplier": _decimal_str(capacity_multiplier),
                "requested_qty": str(decision.qty),
                "approved_qty": str(decision.qty),
            }
        )
        params["allocator"] = current_allocator
        passthrough_decision = decision.model_copy(update={"params": params})
        price = _extract_decision_price(passthrough_decision)
        requested_notional = (
            None if price is None else abs(price * passthrough_decision.qty)
        )
        return AllocationResult(
            decision=passthrough_decision,
            approved=True,
            clipped=False,
            reason_codes=(),
            regime_label=regime_label,
            budget_multiplier=budget_multiplier,
            capacity_multiplier=capacity_multiplier,
            requested_notional=requested_notional,
            approved_notional=requested_notional,
        )


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
            regime_budget_multipliers=_decimal_map(
                settings.trading_allocator_regime_budget_multipliers
            ),
            regime_capacity_multipliers=_decimal_map(
                settings.trading_allocator_regime_capacity_multipliers
            ),
        )
    )


def _config_from_settings(
    strategy: Strategy, equity: Optional[Decimal]
) -> PortfolioSizingConfig:
    max_notional = _min_decimal(
        _optional_decimal(strategy.max_notional_per_trade),
        _optional_decimal(settings.trading_max_notional_per_trade),
        _optional_decimal(settings.trading_portfolio_max_notional_per_symbol),
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
        max_notional_per_symbol=max_notional,
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


def _decimal_str(value: Optional[Decimal]) -> Optional[str]:
    if value is None:
        return None
    return str(value)


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


def _decimal_map(values: dict[str, float]) -> dict[str, Decimal]:
    result: dict[str, Decimal] = {}
    for key in sorted(values):
        value = values[key]
        decimal_value = _optional_decimal(value)
        if decimal_value is None:
            continue
        result[key.strip().lower()] = decimal_value
    return result


__all__ = [
    "ALLOCATOR_CLIP_GROSS_EXPOSURE",
    "ALLOCATOR_CLIP_SYMBOL_CAPACITY",
    "ALLOCATOR_REJECT_GROSS_EXPOSURE",
    "ALLOCATOR_REJECT_NO_PRICE",
    "ALLOCATOR_REJECT_QTY_BELOW_MIN",
    "ALLOCATOR_REJECT_SYMBOL_CAPACITY",
    "ALLOCATOR_REJECT_ZERO_QTY",
    "AggregatedIntent",
    "AllocationConfig",
    "AllocationResult",
    "IntentAggregator",
    "PortfolioAllocator",
    "PortfolioSizingConfig",
    "PortfolioSizingResult",
    "PortfolioSizer",
    "allocator_from_settings",
    "sizer_from_settings",
]
