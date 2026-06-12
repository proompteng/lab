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


ALLOCATOR_REJECT_NO_PRICE = "allocator_reject_no_price"

ALLOCATOR_REJECT_ZERO_QTY = "allocator_reject_zero_qty"

ALLOCATOR_REJECT_SYMBOL_CAPACITY = "allocator_reject_symbol_capacity"

ALLOCATOR_REJECT_GROSS_EXPOSURE = "allocator_reject_gross_exposure"

ALLOCATOR_REJECT_QTY_BELOW_MIN = "allocator_reject_qty_below_min"

ALLOCATOR_REJECT_STRATEGY_BUDGET = "allocator_reject_strategy_budget"

ALLOCATOR_REJECT_SYMBOL_BUDGET = "allocator_reject_symbol_budget"

ALLOCATOR_REJECT_CORRELATION_CAPACITY = "allocator_reject_correlation_capacity"

ALLOCATOR_CLIP_SYMBOL_CAPACITY = "allocator_clip_symbol_capacity"

ALLOCATOR_CLIP_GROSS_EXPOSURE = "allocator_clip_gross_exposure"

ALLOCATOR_CLIP_STRATEGY_BUDGET = "allocator_clip_strategy_budget"

ALLOCATOR_CLIP_SYMBOL_BUDGET = "allocator_clip_symbol_budget"

ALLOCATOR_CLIP_CORRELATION_CAPACITY = "allocator_clip_correlation_capacity"

ALLOCATOR_REGIME_LOW_CONFIDENCE = "allocator_regime_low_confidence"

ALLOCATOR_STRATEGY_FACTORY_OBSERVE_ONLY = "allocator_strategy_factory_observe_only"

ALLOCATOR_STRATEGY_FACTORY_PAPER_ONLY = "allocator_strategy_factory_paper_only"

ALLOCATOR_STRATEGY_FACTORY_UNCALIBRATED = "allocator_strategy_factory_uncalibrated"

ALLOCATOR_STRATEGY_FACTORY_BASELINE_FAIL = "allocator_strategy_factory_baseline_fail"

_SIZING_CAP_ZERO_REASON_BY_METHOD: dict[str, str] = {
    "cap_per_symbol_zero": "symbol_capacity_exhausted",
    "cap_gross_exposure_zero": "gross_exposure_capacity_exhausted",
    "cap_net_exposure_zero": "net_exposure_capacity_exhausted",
    "cap_sell_inventory_zero": "sell_inventory_unavailable",
}


@dataclass(frozen=True)
class AggregatedIntent:
    decision: StrategyDecision
    source_strategy_ids: tuple[str, ...]
    source_decision_count: int
    had_conflict: bool
    strategy_signed_qty: tuple[tuple[str, Decimal], ...]


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
    strategy_notional_caps: dict[str, Decimal]
    symbol_notional_caps: dict[str, Decimal]
    correlation_group_caps: dict[str, Decimal]
    symbol_correlation_groups: dict[str, str]
    regime_budget_multipliers: dict[str, Decimal]
    regime_capacity_multipliers: dict[str, Decimal]
    regime_low_confidence_threshold: Decimal = Decimal("0.60")
    regime_low_confidence_multiplier: Decimal = Decimal("0.70")


@dataclass(frozen=True)
class AllocationResult:
    decision: StrategyDecision
    approved: bool
    clipped: bool
    reason_codes: tuple[str, ...]
    regime_label: str
    fragility_state: FragilityState
    fragility_score: Decimal
    stability_mode_active: bool
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    requested_notional: Optional[Decimal]
    approved_notional: Optional[Decimal]


@dataclass
class _AllocationRuntime:
    equity: Optional[Decimal]
    current_positions: list[dict[str, Any]]
    current_gross_exposure: Decimal
    approved_gross_delta: Decimal
    strategy_usage: dict[str, Decimal]
    symbol_usage: dict[str, Decimal]
    correlation_usage: dict[str, Decimal]


@dataclass(frozen=True)
class _StrategyFactoryAllocationProfile:
    score: Decimal
    budget_multiplier: Decimal
    capacity_multiplier: Decimal
    reason_codes: tuple[str, ...]
    payload: dict[str, Any]


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

        audit = self._build_size_audit(
            decision=decision,
            price=price,
            volatility=volatility,
            equity=equity,
            current_count=current_count,
            current_qty=current_qty,
            current_value=current_value,
            gross_exposure=gross_exposure,
            net_exposure=net_exposure,
        )

        if price is None or price <= 0:
            return self._skipped_size_result(decision, audit, "missing_price")

        base_notional = price * decision.qty
        notional = self._resolve_base_notional(decision, base_notional)
        if notional is None or notional <= 0:
            return self._skipped_size_result(decision, audit, "missing_notional")

        notional, applied_methods = self._apply_sizing_methods(
            decision=decision,
            notional=notional,
            volatility=volatility,
        )
        caps, reasons = self._collect_size_caps(
            decision=decision,
            current_count=current_count,
            current_qty=current_qty,
            current_value=current_value,
            gross_exposure=gross_exposure,
            net_exposure=net_exposure,
            equity=equity,
        )

        if caps:
            notional, cap_methods = _apply_caps(notional, caps)
            applied_methods.extend(cap_methods)

        qty, notional, approved, reasons, diagnostics = self._finalize_sized_order(
            decision=decision,
            price=price,
            notional=notional,
            current_qty=current_qty,
            applied_methods=applied_methods,
            reasons=reasons,
        )

        audit["output"] = {
            "status": "approved" if approved else "rejected",
            "final_qty": _decimal_str(qty),
            "final_notional": _decimal_str(notional),
            "methods": applied_methods,
            "caps": {key: _decimal_str(value) for key, value in caps.items()},
            "reasons": list(reasons),
            **diagnostics,
        }

        updated_params = dict(decision.params)
        updated_params["portfolio_sizing"] = audit
        updated_decision = decision.model_copy(
            update={"qty": qty, "params": updated_params}
        )
        return PortfolioSizingResult(
            decision=updated_decision, approved=approved, reasons=reasons, audit=audit
        )

    def _build_size_audit(
        self,
        *,
        decision: StrategyDecision,
        price: Optional[Decimal],
        volatility: Optional[Decimal],
        equity: Optional[Decimal],
        current_count: int,
        current_qty: Decimal,
        current_value: Decimal,
        gross_exposure: Decimal,
        net_exposure: Decimal,
    ) -> dict[str, Any]:
        return {
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

    def _skipped_size_result(
        self,
        decision: StrategyDecision,
        audit: dict[str, Any],
        reason: str,
    ) -> PortfolioSizingResult:
        audit["output"] = {"status": "skipped", "reason": reason}
        return PortfolioSizingResult(
            decision=decision, approved=True, reasons=[], audit=audit
        )

    def _apply_sizing_methods(
        self,
        *,
        decision: StrategyDecision,
        notional: Decimal,
        volatility: Optional[Decimal],
    ) -> tuple[Decimal, list[str]]:
        notional, regime_method = _apply_allocator_regime_multiplier(
            notional, decision.params
        )
        notional, vol_method = self._apply_volatility_scaling(notional, volatility)
        notional, allocator_cap_method = _cap_by_allocator_approved_notional(
            notional, decision.params
        )
        methods = [
            method
            for method in (regime_method, vol_method, allocator_cap_method)
            if method
        ]
        return notional, methods

    def _collect_size_caps(
        self,
        *,
        decision: StrategyDecision,
        current_count: int,
        current_qty: Decimal,
        current_value: Decimal,
        gross_exposure: Decimal,
        net_exposure: Decimal,
        equity: Optional[Decimal],
    ) -> tuple[dict[str, Optional[Decimal]], list[str]]:
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
        return caps, reasons

    def _finalize_sized_order(
        self,
        *,
        decision: StrategyDecision,
        price: Decimal,
        notional: Decimal,
        current_qty: Decimal,
        applied_methods: list[str],
        reasons: list[str],
    ) -> tuple[Decimal, Decimal, bool, list[str], dict[str, Any]]:
        diagnostics: dict[str, Any] = {}
        for method in applied_methods:
            mapped_reason = _SIZING_CAP_ZERO_REASON_BY_METHOD.get(method)
            if mapped_reason is None:
                continue
            if (
                mapped_reason == "sell_inventory_unavailable"
                and "shorts_not_allowed" in reasons
            ):
                continue
            if mapped_reason not in reasons:
                reasons.append(mapped_reason)
        if reasons:
            diagnostics["limiting_constraint"] = reasons[0]
            return Decimal("0"), Decimal("0"), False, reasons, diagnostics

        target_qty = notional / price
        resolution = resolve_quantity_resolution(
            decision.symbol,
            action=decision.action,
            global_enabled=settings.trading_fractional_equities_enabled,
            allow_shorts=settings.trading_allow_shorts,
            position_qty=current_qty,
            requested_qty=target_qty,
        )
        qty = quantize_qty_for_symbol(
            decision.symbol,
            target_qty,
            fractional_equities_enabled=resolution.fractional_allowed,
        )
        min_qty = min_qty_for_symbol(
            decision.symbol, fractional_equities_enabled=resolution.fractional_allowed
        )
        diagnostics["fractional_allowed"] = resolution.fractional_allowed
        diagnostics["quantity_resolution"] = resolution.to_payload()
        diagnostics["min_executable_qty"] = _decimal_str(min_qty)
        diagnostics["min_executable_notional"] = _decimal_str(min_qty * price)
        diagnostics["remaining_room_notional"] = _decimal_str(notional)
        if qty < min_qty and "shorts_not_allowed" not in reasons:
            capacity_reason = _capacity_reason_from_methods(
                applied_methods=applied_methods, reasons=reasons
            )
            if capacity_reason is not None:
                reasons.append(capacity_reason)
            else:
                reasons.append("qty_below_min")

        approved = len(reasons) == 0
        if not approved:
            diagnostics["limiting_constraint"] = reasons[0]
            return Decimal("0"), Decimal("0"), False, reasons, diagnostics
        return qty, notional, True, reasons, diagnostics

    def _resolve_base_notional(
        self, decision: StrategyDecision, base_notional: Decimal
    ) -> Optional[Decimal]:
        if (
            self.config.notional_per_position is not None
            and self.config.notional_per_position > 0
        ):
            allocator_cap = _allocator_approved_notional(decision.params)
            if allocator_cap is not None and allocator_cap > 0:
                return min(self.config.notional_per_position, allocator_cap)
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
            strategy_signed_qty: dict[str, Decimal] = {}
            for item in bucket:
                signed_qty = item.qty if item.action == "buy" else -item.qty
                strategy_signed_qty[item.strategy_id] = (
                    strategy_signed_qty.get(item.strategy_id, Decimal("0")) + signed_qty
                )

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
                    strategy_signed_qty=tuple(
                        (strategy_id, qty)
                        for strategy_id, qty in sorted(strategy_signed_qty.items())
                    ),
                )
            )

        return aggregated


__all__ = [name for name in globals() if not name.startswith("__")]
